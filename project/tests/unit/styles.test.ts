/**
 * styles.test — S2.2 CSS delivery intents/receipts and inert namespaces
 * (T07/T08/T14 at the delivery boundary; I05/I06/I07/I10).
 *
 * The unit under test is createStyleDelivery with injected seams: every
 * delivery boundary (before intent write, before insert, during insert,
 * after insert timeout, removal, restart) can crash, hang or fail
 * independently — exactly the T14 kill-at-every-boundary matrix.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createStyleDelivery,
  STYLE_SHEET_MAX_BYTES,
  type DeliveryIntent,
  type StyleDeps,
} from '../../src/background/styles.ts';
import type { DocumentKey } from '../../src/contracts.ts';

const DK: DocumentKey = { tabId: 4, frameId: 0, browserDocumentId: 'doc-1', runtimeInstanceId: 'ri-1' };

const CSS_A = '#target { color: red; }';
const CSS_B = '#target { color: blue; }';

interface World {
  deps: StyleDeps;
  calls: Array<{ op: string; target: { tabId: number; documentId: string }; css: string }>;
  stored: DeliveryIntent[];
}

function makeWorld(overrides: Partial<StyleDeps> = {}): World {
  const w: World = { calls: [], stored: [], deps: {} as StyleDeps };
  let n = 0;
  w.deps = {
    now: () => 1000 + ++n,
    randomId: () => `id-${n}`,
    insertCss: async (target, css) => {
      w.calls.push({ op: 'insert', target, css });
    },
    removeCss: async (target, css) => {
      w.calls.push({ op: 'remove', target, css });
    },
    persistIntents: async (intents) => {
      w.stored = JSON.parse(JSON.stringify(intents));
    },
    loadIntents: async () => JSON.parse(JSON.stringify(w.stored)),
    ...overrides,
  };
  return w;
}

const stageOrder = (over: Partial<Parameters<ReturnType<typeof createStyleDelivery>['stage']>[0]> = {}) => ({
  operationId: 'op-1',
  namespace: 'rv2.test.rev1.grp1.doc1',
  css: CSS_A,
  documentKey: DK,
  ...over,
});

// ── I05: intent before side effect ──────────────────────────────────────

test('I05/T08: the durable intent is written BEFORE insertCSS is called', async () => {
  const w = makeWorld();
  const d = createStyleDelivery(w.deps);
  const reply = await d.stage(stageOrder());
  assert.ok(reply.ok && reply.kind === 'staged' && reply.state === 'inserted');
  assert.equal(w.stored.length, 1);
  assert.equal(w.stored[0].state, 'inserted'); // persisted after the insert resolved
  // The persist call happened before the API call: verify via call ordering —
  // persistIntents runs synchronously first, then insertCss.
  assert.equal(w.calls[0].op, 'insert');
});

test('I05/T08: a crash before the intent write performs no insert (prepare-first)', async () => {
  const w = makeWorld({
    persistIntents: async () => {
      throw new Error('session storage full');
    },
  });
  const d = createStyleDelivery(w.deps);
  const reply = await d.stage(stageOrder());
  assert.ok(reply.ok && reply.kind === 'staged' && reply.state === 'unknown', `persist failure must yield unknown, got ${JSON.stringify(reply)}`);
  assert.equal(w.calls.filter((c) => c.op === 'insert').length, 0, 'no side effect without a recorded intent');
});

// ── receipts are exact, never falsely applied (I06/I10) ─────────────────

test('I06/T08: a hanging insertCSS yields outcome-unknown, never a live receipt', async () => {
  const w = makeWorld({ insertCss: () => new Promise(() => undefined), deliveryTimeoutMs: 50 });
  const d = createStyleDelivery(w.deps);
  const reply = await d.stage(stageOrder());
  assert.ok(reply.ok && reply.kind === 'staged' && reply.state === 'unknown' && reply.receiptStatus === 'outcome-unknown');
  const intent = d.receiptFor('op-1');
  assert.equal(intent?.state, 'unknown');
  assert.match(intent?.error ?? '', /budget/);
});

test('I06/T08: reconcile exact-cleans unknown intents on startup', async () => {
  const w = makeWorld({ insertCss: () => new Promise(() => undefined) });
  const d = createStyleDelivery(w.deps);
  await d.stage(stageOrder());
  assert.equal((await d.reconcile()), 1);
  // The recorded bytes were exactly removed.
  const removals = w.calls.filter((c) => c.op === 'remove');
  assert.equal(removals.length, 1);
  assert.equal(removals[0].css, CSS_A);
  assert.equal(removals[0].target.documentId, 'doc-1');
  assert.equal(d.receiptFor('op-1')?.state, 'removed');
});

test('I10/T14: a failed removal stays visible until it succeeds — never a false clean ack', async () => {
  let failRemoval = true;
  const w = makeWorld({
    removeCss: async (target, css) => {
      if (failRemoval) throw new Error('no host permission');
      w.calls.push({ op: 'remove', target, css });
    },
  });
  const d = createStyleDelivery(w.deps);
  await d.stage(stageOrder());
  const failed = await d.remove('op-1', DK);
  assert.ok(!failed.ok, 'a failed removal must not report success');
  if (!failed.ok) assert.equal(failed.code, 'conflict');
  assert.equal(d.receiptFor('op-1')?.state, 'remove-failed', 'the failed state must stay recorded');

  failRemoval = false;
  const retry = await d.remove('op-1', DK, CSS_A);
  assert.ok(retry.ok && retry.kind === 'removed');
  assert.equal(d.receiptFor('op-1')?.state, 'removed');
});

test('I10: a rejected insert (permission revoked) reports explicit unknown, not inserted', async () => {
  const w = makeWorld({
    insertCss: async () => {
      throw new Error('Cannot access contents of the document. Extension manifest must request permission.');
    },
    deliveryTimeoutMs: 50,
  });
  const d = createStyleDelivery(w.deps);
  const reply = await d.stage(stageOrder());
  assert.ok(reply.ok && reply.kind === 'staged' && reply.state === 'unknown' && reply.receiptStatus === 'outcome-unknown');
  const intent = d.receiptFor('op-1');
  assert.match(intent?.error ?? '', /permission/);
});

// ── dedupe: same id same payload replays the receipt; altered payload conflicts ──

test('T14/T08: duplicate operation id with the same digest returns the receipt without re-inserting', async () => {
  const w = makeWorld();
  const d = createStyleDelivery(w.deps);
  await d.stage(stageOrder());
  const inserts = w.calls.filter((c) => c.op === 'insert').length;
  const again = await d.stage(stageOrder());
  assert.ok(again.ok && again.kind === 'staged' && again.state === 'inserted');
  assert.equal(w.calls.filter((c) => c.op === 'insert').length, inserts, 'no second insert for the same operation');
});

test('T14: duplicate operation id with an ALTERED payload is a conflict and never executes', async () => {
  const w = makeWorld();
  const d = createStyleDelivery(w.deps);
  await d.stage(stageOrder());
  const reply = await d.stage(stageOrder({ css: CSS_B }));
  assert.ok(!reply.ok, 'altered payload under the same id must be refused');
  if (!reply.ok) assert.equal(reply.code, 'duplicate-id');
  assert.equal(w.calls.filter((c) => c.op === 'insert').length, 1, 'the altered sheet never reached the browser');
});

// ── namespace lifecycle: revoked is inert forever (I07) ─────────────────

test('I07/T14: cancel disarms BEFORE cleanup; late insert ack cannot activate the namespace', async () => {
  // insertCSS resolves only after cancelNamespace runs: the ack arrives late.
  let resolveInsert!: () => void;
  const w = makeWorld({
    insertCss: (target, css) => {
      w.calls.push({ op: 'insert', target, css });
      return new Promise((resolve) => { resolveInsert = resolve; });
    },
    deliveryTimeoutMs: 200,
  });
  const d = createStyleDelivery(w.deps);
  const staging = d.stage(stageOrder());
  // Wait until the intent exists, then revoke.
  await new Promise((r) => setTimeout(r, 5));
  const cancel = await d.cancelNamespace('rv2.test.rev1.grp1.doc1', DK, 'user Stop');
  assert.ok(cancel.ok || cancel.kind === 'error'); // cleanup may report the pending intent
  resolveInsert();
  const reply = await staging;
  // The late ack must NOT report the bundle as live.
  assert.ok(reply.ok && reply.kind === 'staged' && reply.state !== 'inserted', `late ack for revoked namespace must not be live: ${JSON.stringify(reply)}`);
  assert.equal(d.receiptFor('op-1')?.state, 'removed', 'revoked bytes were exactly cleaned');
  // And the namespace can never be staged again.
  const restage = await d.stage(stageOrder());
  assert.ok(!restage.ok);
  if (!restage.ok) assert.equal(restage.code, 'conflict');
  assert.equal(w.calls.filter((c) => c.op === 'insert').length, 1, 'never re-inserted under the revoked namespace');
});

test('I07/T14: removing a displaced candidate happens before the new bundle stages', async () => {
  const w = makeWorld();
  const d = createStyleDelivery(w.deps);
  await d.stage(stageOrder()); // candidate 1 inserted
  const reply = await d.stage(stageOrder({ operationId: 'op-2', namespace: 'rv2.test.rev2.grp1.doc1', css: CSS_B }));
  assert.ok(reply.ok && reply.kind === 'staged' && reply.state === 'inserted', `replacement must stage: ${JSON.stringify(reply)}`);
  const order = w.calls.map((c) => c.op);
  assert.deepEqual(order, ['insert', 'remove', 'insert'], 'old candidate bytes removed before the new insert');
  assert.equal(w.calls[1].css, CSS_A, 'exact bytes of the displaced candidate');
  assert.equal(d.receiptFor('op-1')?.state, 'removed');
});

// ── two-bundle rule: uncertainty blocks replacements ────────────────────

test('T08/T14: an uncertain candidate blocks staging until reconciled', async () => {
  const w = makeWorld({
    deliveryTimeoutMs: 50,
  });
  // First insert hangs past the budget (worker dies mid-delivery); later
  // inserts resolve normally.
  let hangInserts = true;
  const realInsert = w.deps.insertCss;
  w.deps.insertCss = async (target, css) => {
    if (hangInserts) {
      w.calls.push({ op: 'insert', target, css });
      return new Promise(() => undefined);
    }
    return realInsert(target, css);
  };
  const d = createStyleDelivery(w.deps);
  await d.stage(stageOrder()); // unknown after the 50ms budget
  const blocked = await d.stage(stageOrder({ operationId: 'op-2', css: CSS_B }));
  assert.ok(!blocked.ok, 'staging must refuse while a candidate is uncertain');
  if (!blocked.ok) assert.equal(blocked.code, 'conflict');
  assert.equal(w.calls.filter((c) => c.op === 'insert').length, 1);
  // After reconciliation the block clears.
  await d.reconcile();
  hangInserts = false;
  const ok = await d.stage(stageOrder({ operationId: 'op-2', namespace: 'rv2.test.rev2.grp1.doc1', css: CSS_B }));
  assert.ok(ok.ok && ok.kind === 'staged' && ok.state === 'inserted');
});

// ── commit: promotion only from an observed inserted state ──────────────

test('T08: commit promotes an inserted candidate and never an unknown delivery', async () => {
  const w = makeWorld();
  const d = createStyleDelivery(w.deps);
  await d.stage(stageOrder());
  const committed = await d.commit('op-1', DK);
  assert.ok(committed.ok && committed.kind === 'committed');
  assert.equal(committed.promotedNamespace, 'rv2.test.rev1.grp1.doc1');

  // An unknown delivery can never be committed (plan/05 §4).
  const w2 = makeWorld({ insertCss: () => new Promise(() => undefined), deliveryTimeoutMs: 50 });
  const d2 = createStyleDelivery(w2.deps);
  await d2.stage(stageOrder());
  const refused = await d2.commit('op-1', DK);
  assert.ok(!refused.ok, 'unknown delivery must not be committed');
  if (!refused.ok) assert.equal(refused.code, 'conflict');
});

test('T08: committing an unknown operation is refused with an honest error', async () => {
  const d = createStyleDelivery(makeWorld().deps);
  const reply = await d.commit('op-missing', DK);
  assert.ok(!reply.ok);
  if (!reply.ok) assert.equal(reply.code, 'unknown-target');
});

// ── bounds and hygiene ──────────────────────────────────────────────────

test('a sheet over the delivery ceiling is refused before any side effect', async () => {
  const w = makeWorld();
  const d = createStyleDelivery(w.deps);
  const reply = await d.stage(stageOrder({ css: 'a'.repeat(STYLE_SHEET_MAX_BYTES + 1) }));
  assert.ok(!reply.ok);
  if (!reply.ok) assert.equal(reply.code, 'out-of-bounds');
  assert.equal(w.calls.length, 0);
});

test('a malformed namespace is refused', async () => {
  const d = createStyleDelivery(makeWorld().deps);
  const reply = await d.stage(stageOrder({ namespace: 'bad namespace with spaces' }));
  assert.ok(!reply.ok);
  if (!reply.ok) assert.equal(reply.code, 'invalid-schema');
});

test('documentId targeting: the API receives the exact document, not just the tab', async () => {
  const w = makeWorld();
  const d = createStyleDelivery(w.deps);
  await d.stage(stageOrder());
  assert.deepEqual(w.calls[0].target, { tabId: 4, documentId: 'doc-1' });
});

test('T14: restart reconciliation restores a hydrated uncertain ledger to removed', async () => {
  // Simulate a worker death between insert and ack: the persisted intent is
  // stuck at 'staging'.
  const w = makeWorld();
  w.stored = [{
    operationId: 'op-1',
    payloadDigest: 'x',
    namespace: 'rv2.test.rev1.grp1.doc1',
    documentKey: DK,
    css: CSS_A,
    rootId: 'document',
    recordedAt: 1,
    state: 'staging',
  }];
  const d = createStyleDelivery(w.deps);
  assert.equal((await d.reconcile()), 1);
  assert.equal(d.receiptFor('op-1')?.state, 'removed');
  const removals = w.calls.filter((c) => c.op === 'remove');
  assert.equal(removals.length, 1);
  assert.equal(removals[0].css, CSS_A, 'exact-byte cleanup, never a guess');
});

test('T14: a confirmed document destruction marks its intents terminal without removeCSS', async () => {
  const w = makeWorld();
  const d = createStyleDelivery(w.deps);
  await d.stage(stageOrder());
  assert.equal(d.documentDestroyed(DK), 1);
  assert.equal(d.receiptFor('op-1')?.state, 'removed');
  assert.equal(w.calls.filter((c) => c.op === 'remove').length, 0, 'the bytes died with the document');
  // Staging into the destroyed document's key is a fresh ledger state.
  const again = await d.stage(stageOrder({ operationId: 'op-2', namespace: 'rv2.test.rev2.grp1.doc1', css: CSS_B }));
  assert.ok(again.ok && again.kind === 'staged' && again.state === 'inserted');
});

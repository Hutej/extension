/**
 * broker.test — S2.1 document broker core (T08/T11/T21/T14 seeds).
 *
 * The unit under test is the pure broker core in src/background/broker.ts:
 * sender-role verification (contracts §9), envelope/command decoding, the
 * document registry with route-epoch fencing, one-run-owner per document,
 * bounded relay, and deterministic rejection of late messages. Platform
 * seams (clock, ids, tab delivery, registry persistence) are injected; the
 * chrome wiring is a thin adapter proven by the browser suite.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBrokerCore, type BrokerDeps, type BrokerReply } from '../../src/background/broker.ts';
import type { StoreCore } from '../../src/background/store.ts';
import type { DocumentKey, SenderLike } from '../../src/contracts.ts';
import type { DocumentRecord } from '../../src/background/broker.ts';
import type { StageOrder, StyleDelivery } from '../../src/background/styles.ts';

const OWN_ID = 'revueon-test-extension-id';

// ── fixtures ─────────────────────────────────────────────────────────────

function makeDeps(overrides: Partial<BrokerDeps> = {}): BrokerDeps {
  let n = 0;
  const recorded: StageOrder[] = [];
  const styles: StyleDelivery = {
    stage: async (order) => {
      recorded.push(order);
      return { ok: true, kind: 'staged', operationId: order.operationId, state: 'inserted', receiptStatus: 'applied-provisional' };
    },
    remove: async () => ({ ok: true, kind: 'removed', operationId: '', state: 'removed', receiptStatus: 'rolled-back' }),
    commit: async () => ({ ok: true, kind: 'committed', operationId: '', promotedNamespace: 'ns' }),
    cancelNamespace: async () => ({ ok: true, kind: 'removed', operationId: '', state: 'removed', receiptStatus: 'rolled-back' }),
    receiptFor: () => undefined,
    documentDestroyed: () => 0,
    reconcile: async () => 0,
    intents: () => [],
  };
  const store: StoreCore = {
    hydrate: async () => ({ loaded: 0, quarantined: [], pending: [], totalBytes: 0 }),
    save: async () => ({ ok: false, code: 'internal', message: 'no store in this test' }),
    setEnabled: async () => ({ ok: false, code: 'internal', message: 'no store in this test' }),
    removeCustomization: async () => ({ ok: false, code: 'internal', message: 'no store in this test' }),
    getRecord: async () => null,
    exportQuarantined: async () => undefined,
    quarantined: () => [],
    stats: () => ({ origins: 0, totalBytes: 0 }),
  };
  return {
    ownExtensionId: OWN_ID,
    now: () => 10_000,
    randomId: () => `id-${++n}`,
    sendToTab: async () => ({ ok: true, kind: 'relayed', receipt: {} }),
    persistRegistry: async () => {},
    loadRegistry: async () => [],
    styles,
    store,
    ...overrides,
  };
}

const workspaceSender: SenderLike = {
  id: OWN_ID,
  url: `chrome-extension://${OWN_ID}/popup.html`,
  origin: `chrome-extension://${OWN_ID}`,
};

const runtimeSender = (over: Partial<SenderLike> = {}): SenderLike => ({
  id: OWN_ID,
  url: 'https://site.test/page',
  origin: 'https://site.test',
  tab: { id: 4, url: 'https://site.test/page' },
  frameId: 0,
  documentId: 'doc-1',
  ...over,
});

const foreignSender: SenderLike = { id: 'other-extension-id', origin: 'chrome-extension://other-extension-id' };

const CSS_X = '#x { color: rebeccapurple; }';

const envelope = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  protocolVersion: 1,
  requestId: 'req-1',
  kind: 'control',
  deadlineAt: 20_000,
  payload: {},
  ...over,
});

function documentKeyOf(reply: BrokerReply | undefined): DocumentKey {
  assert.ok(reply && reply.ok && reply.kind === 'registered', `expected registered, got ${JSON.stringify(reply)}`);
  return (reply as { documentKey: DocumentKey }).documentKey;
}

const errCode = (reply: BrokerReply | undefined): string => {
  assert.ok(reply && !reply.ok, `expected error reply, got ${JSON.stringify(reply)}`);
  return (reply as { error: { code: string } }).error.code;
};

const errOf = (reply: BrokerReply | undefined): { code: string; retryClass: string; recoveryAction?: string } => {
  assert.ok(reply && !reply.ok, `expected error reply, got ${JSON.stringify(reply)}`);
  return (reply as { error: { code: string; retryClass: string; recoveryAction?: string } }).error;
};

// ── T21: sender-role verification (denied by default) ───────────────────

test('T21: a runtime sender may not start runs', async () => {
  const core = createBrokerCore(makeDeps());
  const reply = await core.handleMessage(runtimeSender(), envelope({
    kind: 'run-command',
    payload: { command: 'StartRun', goal: 'g' },
    documentKey: { tabId: 4, frameId: 0, browserDocumentId: 'doc-1', runtimeInstanceId: 'ri-1' },
    expectedRouteEpoch: 0,
  }));
  assert.equal(errCode(reply), 'denied');
});

test('T21: a foreign/unknown sender is denied every command', async () => {
  const core = createBrokerCore(makeDeps());
  const reply = await core.handleMessage(foreignSender, envelope({
    kind: 'run-command',
    payload: { command: 'StartRun', goal: 'g' },
  }));
  assert.equal(errCode(reply), 'denied');
});

test('T21: a broker-role sender may not start runs either', async () => {
  const core = createBrokerCore(makeDeps());
  const reply = await core.handleMessage({ id: OWN_ID }, envelope({
    kind: 'run-command',
    payload: { command: 'StartRun', goal: 'g' },
  }));
  assert.equal(errCode(reply), 'denied');
});

// ── registration: identity from the browser sender only ─────────────────

test('T21: registration derives the DocumentKey from browser sender metadata', async () => {
  const core = createBrokerCore(makeDeps());
  const reply = await core.handleMessage(runtimeSender(), envelope({
    payload: { command: 'RegisterDocument', runtimeInstanceId: 'ri-1' },
  }));
  const dk = documentKeyOf(reply);
  assert.deepEqual(dk, { tabId: 4, frameId: 0, browserDocumentId: 'doc-1', runtimeInstanceId: 'ri-1' });
});

test('registration payload cannot forge the tab/document identity', async () => {
  const core = createBrokerCore(makeDeps());
  const reply = await core.handleMessage(runtimeSender(), envelope({
    payload: { command: 'RegisterDocument', runtimeInstanceId: 'ri-1', tabId: 999, browserDocumentId: 'forged' },
  }));
  // Unknown payload fields are rejected (v1 strictness) — and even a decoded
  // field could never override the browser-derived identity.
  assert.equal(errCode(reply), 'invalid-schema');
});

test('registration without browser document identity is denied', async () => {
  const core = createBrokerCore(makeDeps());
  const reply = await core.handleMessage(
    runtimeSender({ documentId: undefined, tab: undefined, frameId: undefined }),
    envelope({ payload: { command: 'RegisterDocument', runtimeInstanceId: 'ri-1' } }),
  );
  assert.equal(errCode(reply), 'denied');
});

// ── T08/T11: document fencing — stale instance, unknown document, epoch ──

test('T08: a command from a replaced runtime instance is deterministically rejected', async () => {
  const deps = makeDeps();
  const core = createBrokerCore(deps);
  await core.handleMessage(runtimeSender(), envelope({ payload: { command: 'RegisterDocument', runtimeInstanceId: 'ri-1' } }));
  // Reinjection: same document, new runtime instance.
  await core.handleMessage(runtimeSender(), envelope({ payload: { command: 'RegisterDocument', runtimeInstanceId: 'ri-2' } }));
  // The old instance's late StartRun arrives.
  const reply = await core.handleMessage(workspaceSender, envelope({
    kind: 'run-command',
    payload: { command: 'StartRun', goal: 'g' },
    documentKey: { tabId: 4, frameId: 0, browserDocumentId: 'doc-1', runtimeInstanceId: 'ri-1' },
    expectedRouteEpoch: 0,
  }));
  assert.equal(errCode(reply), 'stale-document');
});

test('T21: a tab id alone does not authorize — the exact document must be registered', async () => {
  const core = createBrokerCore(makeDeps());
  const reply = await core.handleMessage(workspaceSender, envelope({
    kind: 'run-command',
    payload: { command: 'StartRun', goal: 'g' },
    documentKey: { tabId: 999, frameId: 0, browserDocumentId: 'doc-1', runtimeInstanceId: 'ri-1' },
    expectedRouteEpoch: 0,
  }));
  assert.equal(errCode(reply), 'unknown-target');
});

test('T11: a command carrying a stale route epoch is rejected', async () => {
  const core = createBrokerCore(makeDeps());
  await core.handleMessage(runtimeSender(), envelope({ payload: { command: 'RegisterDocument', runtimeInstanceId: 'ri-1' } }));
  await core.routeEvent(4, 0); // navigation → epoch 1
  const reply = await core.handleMessage(workspaceSender, envelope({
    kind: 'run-command',
    payload: { command: 'StartRun', goal: 'g' },
    documentKey: { tabId: 4, frameId: 0, browserDocumentId: 'doc-1', runtimeInstanceId: 'ri-1' },
    expectedRouteEpoch: 0,
  }));
  assert.equal(errCode(reply), 'stale-route');
});

test('T11: navigation advances the epoch, drops the run, and notifies the runtime', async () => {
  const sent: Array<{ tabId: number; message: Record<string, unknown> }> = [];
  const core = createBrokerCore(makeDeps({
    sendToTab: async (tabId, message) => {
      sent.push({ tabId, message: message as Record<string, unknown> });
      return {};
    },
  }));
  await core.handleMessage(runtimeSender(), envelope({ payload: { command: 'RegisterDocument', runtimeInstanceId: 'ri-1' } }));
  const notified = await core.routeEvent(4, 0);
  assert.equal(notified, 1);
  assert.equal(sent.length, 1);
  assert.equal((sent[0].message.payload as Record<string, unknown>).command, 'RouteChanged');
  assert.equal((sent[0].message.payload as Record<string, unknown>).routeEpoch, 1);
});

// ── one run owner per document ───────────────────────────────────────────

test('T14: a second StartRun while a run is active is refused with a recovery action', async () => {
  const core = createBrokerCore(makeDeps());
  await core.handleMessage(runtimeSender(), envelope({ payload: { command: 'RegisterDocument', runtimeInstanceId: 'ri-1' } }));
  const dk = { tabId: 4, frameId: 0, browserDocumentId: 'doc-1', runtimeInstanceId: 'ri-1' };
  const first = await core.handleMessage(workspaceSender, envelope({
    kind: 'run-command', payload: { command: 'StartRun', goal: 'g' }, documentKey: dk, expectedRouteEpoch: 0,
  }));
  assert.ok(first && first.ok && first.kind === 'run-started');
  const second = await core.handleMessage(workspaceSender, envelope({
    kind: 'run-command', payload: { command: 'StartRun', goal: 'g' }, documentKey: dk, expectedRouteEpoch: 0,
  }));
  assert.equal(errCode(second), 'conflict');
  assert.match(errOf(second).recoveryAction ?? '', /CancelRun/);
});

test('T14: CancelRun releases ownership and is idempotent', async () => {
  const core = createBrokerCore(makeDeps());
  await core.handleMessage(runtimeSender(), envelope({ payload: { command: 'RegisterDocument', runtimeInstanceId: 'ri-1' } }));
  const dk = { tabId: 4, frameId: 0, browserDocumentId: 'doc-1', runtimeInstanceId: 'ri-1' };
  const start = () => core.handleMessage(workspaceSender, envelope({
    kind: 'run-command', payload: { command: 'StartRun', goal: 'g' }, documentKey: dk, expectedRouteEpoch: 0,
  }));
  const started = await start();
  assert.ok(started && started.ok);
  const cancel = await core.handleMessage(workspaceSender, envelope({
    kind: 'run-command', payload: { command: 'CancelRun' }, documentKey: dk, expectedRouteEpoch: 0,
  }));
  assert.ok(cancel && cancel.ok && cancel.kind === 'run-cancelled' && cancel.cancelled === true);
  const cancelAgain = await core.handleMessage(workspaceSender, envelope({
    kind: 'run-command', payload: { command: 'CancelRun' }, documentKey: dk, expectedRouteEpoch: 0,
  }));
  assert.ok(cancelAgain && cancelAgain.ok && cancelAgain.kind === 'run-cancelled' && cancelAgain.cancelled === false);
  const restarted = await start();
  assert.ok(restarted && restarted.ok);
});

// ── GetOperation relay: bounded, I06-honest ──────────────────────────────

test('GetOperation relays the runtime reply to a workspace sender', async () => {
  const dk = { tabId: 4, frameId: 0, browserDocumentId: 'doc-1', runtimeInstanceId: 'ri-1' };
  const core = createBrokerCore(makeDeps({
    sendToTab: async () => ({ ok: false, kind: 'error', error: { code: 'unknown-target', phase: 'reconcile', retryClass: 'user-decision', message: 'no receipt' } }),
  }));
  await core.handleMessage(runtimeSender(), envelope({ payload: { command: 'RegisterDocument', runtimeInstanceId: 'ri-1' } }));
  const reply = await core.handleMessage(workspaceSender, envelope({
    payload: { command: 'GetOperation', operationId: 'op-1' },
    documentKey: dk,
    expectedRouteEpoch: 0,
  }));
  assert.ok(reply && reply.ok && reply.kind === 'relayed');
  const receipt = (reply as unknown as { receipt: { error: { code: string } } }).receipt;
  assert.equal(receipt.error.code, 'unknown-target');
});

test('T08/I06: a relay that never answers within its budget is timeout-unknown, never not-applied', async () => {
  const dk = { tabId: 4, frameId: 0, browserDocumentId: 'doc-1', runtimeInstanceId: 'ri-1' };
  const core = createBrokerCore(makeDeps({
    // Real timer: the relay budget is min(deadline-now, 5000) — use a tiny
    // deadline so the test stays fast.
    sendToTab: () => new Promise(() => undefined),
  }));
  await core.handleMessage(runtimeSender(), envelope({ payload: { command: 'RegisterDocument', runtimeInstanceId: 'ri-1' } }));
  const reply = await core.handleMessage(workspaceSender, envelope({
    payload: { command: 'GetOperation', operationId: 'op-1' },
    documentKey: dk,
    expectedRouteEpoch: 0,
    deadlineAt: 10_050, // 50ms budget on the injected clock (now = 10_000)
  }));
  const err = errOf(reply);
  assert.equal(err.code, 'timeout-unknown');
  assert.equal(err.retryClass, 'retryable-same-id');
});

test('T08/I06: an unreachable runtime (no receiver) reports stale-document with recovery', async () => {
  const dk = { tabId: 4, frameId: 0, browserDocumentId: 'doc-1', runtimeInstanceId: 'ri-1' };
  const core = createBrokerCore(makeDeps({
    sendToTab: async () => {
      throw new Error('Could not establish connection. Receiving end does not exist.');
    },
  }));
  await core.handleMessage(runtimeSender(), envelope({ payload: { command: 'RegisterDocument', runtimeInstanceId: 'ri-1' } }));
  const reply = await core.handleMessage(workspaceSender, envelope({
    payload: { command: 'GetOperation', operationId: 'op-1' },
    documentKey: dk,
    expectedRouteEpoch: 0,
  }));
  assert.equal(errCode(reply), 'stale-document');
});

// ── envelope hygiene: deadline, version, transport-kind mismatch ─────────

test('a request past its deadline is not processed', async () => {
  const core = createBrokerCore(makeDeps());
  const reply = await core.handleMessage(workspaceSender, envelope({ deadlineAt: 9_000 }));
  assert.equal(errCode(reply), 'denied');
});

test('an unknown protocol version fails schema validation', async () => {
  const core = createBrokerCore(makeDeps());
  const reply = await core.handleMessage(workspaceSender, envelope({ protocolVersion: 2 }));
  assert.equal(errCode(reply), 'invalid-schema');
});

test('a command outside its transport kind is rejected (no kind laundering)', async () => {
  const core = createBrokerCore(makeDeps());
  const reply = await core.handleMessage(runtimeSender(), envelope({
    kind: 'subscription', // RegisterDocument disguised as a projection
    payload: { command: 'RegisterDocument', runtimeInstanceId: 'ri-1' },
  }));
  assert.equal(errCode(reply), 'invalid-schema');
});

test('inbound RuntimeState/RunProgress projections are not routed (undefined)', async () => {
  const core = createBrokerCore(makeDeps());
  const reply = await core.handleMessage(runtimeSender(), envelope({
    kind: 'subscription',
    payload: { command: 'RunProgress', sequence: 1 },
  }));
  assert.equal(reply, undefined);
});

test('late registrations survive a simulated worker restart via the injected store', async () => {
  let stored: DocumentRecord[] = [];
  const deps = makeDeps({
    persistRegistry: async (records) => {
      stored = JSON.parse(JSON.stringify(records));
    },
    loadRegistry: async () => stored,
  });
  const core1 = createBrokerCore(deps);
  await core1.handleMessage(runtimeSender(), envelope({ payload: { command: 'RegisterDocument', runtimeInstanceId: 'ri-1' } }));
  await core1.handleMessage(workspaceSender, envelope({
    kind: 'run-command',
    payload: { command: 'StartRun', goal: 'g' },
    documentKey: { tabId: 4, frameId: 0, browserDocumentId: 'doc-1', runtimeInstanceId: 'ri-1' },
    expectedRouteEpoch: 0,
  }));

  // The worker restarts: a new core hydrates from the same session store.
  const core2 = createBrokerCore({ ...deps, loadRegistry: async () => stored });
  await core2.hydrated();
  assert.equal(core2.records().length, 1);
  const dk = { tabId: 4, frameId: 0, browserDocumentId: 'doc-1', runtimeInstanceId: 'ri-1' };
  const second = await core2.handleMessage(workspaceSender, envelope({
    kind: 'run-command', payload: { command: 'StartRun', goal: 'g' }, documentKey: dk, expectedRouteEpoch: 0,
  }));
  assert.equal(errCode(second), 'conflict'); // the run owner survived the restart
});

test('tab destruction releases registry entries', async () => {
  const core = createBrokerCore(makeDeps());
  await core.handleMessage(runtimeSender(), envelope({ payload: { command: 'RegisterDocument', runtimeInstanceId: 'ri-1' } }));
  assert.equal(await core.tabClosed(4), 1);
  assert.equal(core.records().length, 0);
  const reply = await core.handleMessage(workspaceSender, envelope({
    kind: 'run-command',
    payload: { command: 'StartRun', goal: 'g' },
    documentKey: { tabId: 4, frameId: 0, browserDocumentId: 'doc-1', runtimeInstanceId: 'ri-1' },
    expectedRouteEpoch: 0,
  }));
  assert.equal(errCode(reply), 'unknown-target');
});

// ── S2.2: style-delivery routing (runtime → broker, fenced) ─────────────

test('S2.2: StageStyle routes to the delivery module with the registry-resolved identity', async () => {
  const staged: StageOrder[] = [];
  const core = createBrokerCore(makeDeps({
    styles: {
      ...makeDeps().styles,
      stage: async (order) => {
        staged.push(order);
        return { ok: true, kind: 'staged', operationId: order.operationId, state: 'inserted', receiptStatus: 'applied-provisional' };
      },
    },
  }));
  await core.handleMessage(runtimeSender(), envelope({ payload: { command: 'RegisterDocument', runtimeInstanceId: 'ri-1' } }));
  const reply = await core.handleMessage(runtimeSender(), envelope({
    kind: 'style-delivery',
    payload: { command: 'StageStyle', operationId: 'op-1', namespace: 'rv2.t.r.g.d', css: '#a{color:red}' },
    documentKey: { tabId: 4, frameId: 0, browserDocumentId: 'doc-1', runtimeInstanceId: 'ri-1' },
    expectedRouteEpoch: 0,
  }));
  assert.ok(reply && reply.ok && reply.kind === 'relayed', `StageStyle must be delivered: ${JSON.stringify(reply)}`);
  assert.equal(staged.length, 1);
  assert.deepEqual(staged[0].documentKey, { tabId: 4, frameId: 0, browserDocumentId: 'doc-1', runtimeInstanceId: 'ri-1' });
});

test('S2.2/T21: a workspace sender may not stage styles (runtime-only authority)', async () => {
  const core = createBrokerCore(makeDeps());
  const reply = await core.handleMessage(workspaceSender, envelope({
    kind: 'style-delivery',
    payload: { command: 'StageStyle', operationId: 'op-1', namespace: 'rv2.t.r.g.d', css: '#a{color:red}' },
  }));
  assert.equal(errCode(reply), 'denied');
});

test('S2.2/T08: a stale-instance StageStyle never reaches the delivery module', async () => {
  const staged: StageOrder[] = [];
  const core = createBrokerCore(makeDeps({
    styles: {
      ...makeDeps().styles,
      stage: async (order) => {
        staged.push(order);
        return { ok: true, kind: 'staged', operationId: order.operationId, state: 'inserted', receiptStatus: 'applied-provisional' };
      },
    },
  }));
  await core.handleMessage(runtimeSender(), envelope({ payload: { command: 'RegisterDocument', runtimeInstanceId: 'ri-1' } }));
  await core.handleMessage(runtimeSender(), envelope({ payload: { command: 'RegisterDocument', runtimeInstanceId: 'ri-2' } }));
  const reply = await core.handleMessage(runtimeSender(), envelope({
    kind: 'style-delivery',
    payload: { command: 'StageStyle', operationId: 'op-1', namespace: 'rv2.t.r.g.d', css: '#a{color:red}' },
    documentKey: { tabId: 4, frameId: 0, browserDocumentId: 'doc-1', runtimeInstanceId: 'ri-1' },
    expectedRouteEpoch: 0,
  }));
  assert.equal(errCode(reply), 'stale-document');
  assert.equal(staged.length, 0, 'no delivery for a replaced runtime instance');
});

test('S2.2: RemoveStyle and CommitComposition route to the delivery module', async () => {
  const removed: Array<{ operationId: string; css?: string }> = [];
  const committed: string[] = [];
  const core = createBrokerCore(makeDeps({
    styles: {
      ...makeDeps().styles,
      remove: async (operationId, _dk, css) => {
        removed.push({ operationId, css });
        return { ok: true, kind: 'removed', operationId, state: 'removed', receiptStatus: 'rolled-back' };
      },
      commit: async (operationId) => {
        committed.push(operationId);
        return { ok: true, kind: 'committed', operationId, promotedNamespace: 'rv2.t.r.g.d' };
      },
    },
  }));
  await core.handleMessage(runtimeSender(), envelope({ payload: { command: 'RegisterDocument', runtimeInstanceId: 'ri-1' } }));
  const dk = { tabId: 4, frameId: 0, browserDocumentId: 'doc-1', runtimeInstanceId: 'ri-1' };
  const rm = await core.handleMessage(runtimeSender(), envelope({
    kind: 'style-delivery', payload: { command: 'RemoveStyle', operationId: 'op-9', css: CSS_X }, documentKey: dk, expectedRouteEpoch: 0,
  }));
  assert.ok(rm && rm.ok && rm.kind === 'relayed');
  assert.deepEqual(removed[0], { operationId: 'op-9', css: CSS_X });
  const cm = await core.handleMessage(runtimeSender(), envelope({
    kind: 'style-delivery', payload: { command: 'CommitComposition', operationId: 'op-1' }, documentKey: dk, expectedRouteEpoch: 0,
  }));
  assert.ok(cm && cm.ok && cm.kind === 'relayed');
  assert.deepEqual(committed, ['op-1']);
});

test('S2.2: GetOperation prefers the broker style ledger (lost-ack reconciliation)', async () => {
  const core = createBrokerCore(makeDeps({
    styles: {
      ...makeDeps().styles,
      receiptFor: (operationId) => operationId === 'op-style-1'
        ? { operationId, payloadDigest: 'd1', namespace: 'ns', documentKey: { tabId: 4, frameId: 0, browserDocumentId: 'doc-1', runtimeInstanceId: 'ri-1' }, css: 'x', rootId: 'document', recordedAt: 1, state: 'unknown' as const, error: 'insertCSS did not resolve within the delivery budget' }
        : undefined,
    },
  }));
  await core.handleMessage(runtimeSender(), envelope({ payload: { command: 'RegisterDocument', runtimeInstanceId: 'ri-1' } }));
  const dk = { tabId: 4, frameId: 0, browserDocumentId: 'doc-1', runtimeInstanceId: 'ri-1' };
  const reply = await core.handleMessage(workspaceSender, envelope({
    payload: { command: 'GetOperation', operationId: 'op-style-1' }, documentKey: dk, expectedRouteEpoch: 0,
  }));
  assert.ok(reply && reply.ok && reply.kind === 'relayed');
  const receipt = (reply as unknown as { receipt: { receipt: { status: string } } }).receipt.receipt;
  assert.equal(receipt.status, 'outcome-unknown', 'the ledger receipt answers without relaying to a possibly-dead runtime');
});


// ── S5.1: record-owner routing (T12/T26 broker slices) ──────────────────

function recordingStore(): { store: StoreCore; calls: string[] } {
  const calls: string[] = [];
  const store: StoreCore = {
    hydrate: async () => ({ loaded: 0, quarantined: [], pending: [], totalBytes: 0 }),
    save: async (req) => {
      calls.push(`save:${req.origin}:${req.customizationId}:${req.mutationId}`);
      return { ok: true, value: { recordRevision: 1, origin: req.origin, mutationId: req.mutationId } };
    },
    setEnabled: async (req) => {
      calls.push(`enable:${req.customizationId}:${String(req.enabled)}`);
      return { ok: true, value: { recordRevision: 2 } };
    },
    removeCustomization: async (req) => {
      calls.push(`remove:${req.customizationId}`);
      return { ok: false, code: 'conflict', message: 'no such customization', fieldPath: 'customizationId', recordRevision: 3 };
    },
    getRecord: async (origin) => {
      calls.push(`get:${origin}`);
      return {
        schemaVersion: 2,
        origin,
        recordRevision: 4,
        lastMutationId: 'm',
        customizations: [],
        updatedAt: 1,
      };
    },
    exportQuarantined: async (key) => {
      calls.push(`export:${key}`);
      return '{"legacy":true}';
    },
    quarantined: () => [{ key: 'rv_old', reason: 'legacy-v0', bytes: 10 }],
    stats: () => ({ origins: 0, totalBytes: 0 }),
  };
  return { store, calls };
}

const savePayload = {
  command: 'SaveRevision',
  origin: 'https://site.test',
  customizationId: 'cust-1',
  title: 'T',
  scope: { mode: 'exactPath', path: '/page' },
  contentSensitivity: 'page-only',
  grants: [],
  revision: {
    revisionId: 'rev-1',
    capabilityVersion: 1,
    targetDescriptors: [{
      descriptorVersion: 1,
      rootPath: [],
      selection: 'single',
      anchor: { tag: 'main' },
      relation: 'self',
      matchBounds: { min: 1, max: 1 },
      routeScopeRef: 'https://site.test',
      continuityPolicy: 'stable-single',
    }],
    operations: [{ kind: 'style', rules: [{ target: { targetRef: 'r1' }, declarations: [{ property: 'color', value: 'red', priority: 'important' }] }] }],
    savedAt: 1,
    source: 'user-planned',
  },
  expectedRecordRevision: 0,
  mutationId: 'm-1',
};

test('S5.1: SaveRevision from the workspace reaches the store; the reply is an explicit saved state', async () => {
  const { store, calls } = recordingStore();
  const core = createBrokerCore(makeDeps({ store }));
  const reply = await core.handleMessage(workspaceSender, envelope({ payload: savePayload }));
  assert.ok(reply && reply.ok && reply.kind === 'saved', JSON.stringify(reply));
  assert.equal((reply as { recordRevision: number }).recordRevision, 1);
  assert.deepEqual(calls, ['save:https://site.test:cust-1:m-1']);
});

test('S5.1: content runtimes can never write records — SaveRevision from runtime is denied (plan/04 §4)', async () => {
  const { store, calls } = recordingStore();
  const core = createBrokerCore(makeDeps({ store }));
  const reply = await core.handleMessage(runtimeSender(), envelope({ payload: savePayload }));
  assert.equal(errCode(reply), 'denied');
  assert.deepEqual(calls, [], 'the store was never touched by a runtime sender');
});

test('S5.1: GetOriginRecord serves the current record; conflicts carry the current summary', async () => {
  const { store, calls } = recordingStore();
  const core = createBrokerCore(makeDeps({ store }));
  const got = await core.handleMessage(workspaceSender, envelope({ payload: { command: 'GetOriginRecord', origin: 'https://site.test' } }));
  assert.ok(got && got.ok && got.kind === 'origin-record', JSON.stringify(got));
  assert.equal((got as unknown as { originRecord: { recordRevision: number } }).originRecord.recordRevision, 4);
  assert.deepEqual(calls, ['get:https://site.test']);

  const failing: StoreCore = { ...store, removeCustomization: async () => ({ ok: false, code: 'conflict', message: 'moved', recordRevision: 9, conflict: { recordRevision: 9, customizations: [] } }) };
  const core2 = createBrokerCore(makeDeps({ store: failing }));
  const bad = await core2.handleMessage(workspaceSender, envelope({ payload: { command: 'RemoveCustomization', origin: 'https://site.test', customizationId: 'x', expectedRecordRevision: 0, mutationId: 'm-9' } }));
  assert.ok(bad && !bad.ok);
  assert.equal((bad as { conflict?: { recordRevision: number } }).conflict?.recordRevision, 9, 'the conflict summary rides the error reply for the merge UI');
});

test('S5.1: quarantined payloads export to the workspace only — raw bytes, never decoded', async () => {
  const { store, calls } = recordingStore();
  const core = createBrokerCore(makeDeps({ store }));
  const reply = await core.handleMessage(workspaceSender, envelope({ payload: { command: 'ExportQuarantine', key: 'rv_https://site.test/wiki' } }));
  assert.ok(reply && reply.ok && reply.kind === 'quarantine', JSON.stringify(reply));
  assert.equal((reply as { raw?: string }).raw, '{"legacy":true}');
  assert.deepEqual(calls, ['export:rv_https://site.test/wiki']);
});

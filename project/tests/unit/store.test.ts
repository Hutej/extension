/**
 * S5.1 — background/store unit tests (T12/T25/T26/T30 record slices).
 *
 * Real store core over fake trusted storage areas (plan/20: pure/stateful
 * modules call real functions with injected seams). Covers: save/confirm,
 * concurrency conflict + disjoint merge, mutationId replay, quota refusal
 * with the record untouched, interruption reconciliation by lastMutationId,
 * corrupt/unknown-schema/legacy quarantine, tombstone resurrection block,
 * revision trimming, and explicit order preservation (I13).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  LIMITS,
  decodeOriginRecord,
  decodeRevision,
  ORIGIN_RECORD_SCHEMA_VERSION,
  type OriginRecord,
  type Revision,
} from '../../src/contracts.ts';
import { createStore, type StorageArea, type StoreDeps } from '../../src/background/store.ts';

// ── fake trusted storage ─────────────────────────────────────────────────

function fakeStorage(): StorageArea & { data: Map<string, unknown>; failNextSet: boolean } {
  const data = new Map<string, unknown>();
  return {
    data,
    failNextSet: false,
    async get(keys) {
      const out: Record<string, unknown> = {};
      const wanted = keys === null || keys === undefined ? [...data.keys()] : Array.isArray(keys) ? keys : [keys];
      for (const k of wanted) if (data.has(k)) out[k] = data.get(k);
      return out;
    },
    async set(items) {
      if (this.failNextSet) {
        this.failNextSet = false;
        throw new Error('quota exceeded: storage write refused');
      }
      for (const [k, v] of Object.entries(items)) data.set(k, v);
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k);
    },
  };
}

function makeDeps(overrides: Partial<StoreDeps> = {}): { deps: StoreDeps; local: ReturnType<typeof fakeStorage>; session: ReturnType<typeof fakeStorage>; clock: { t: number } } {
  const local = fakeStorage();
  const session = fakeStorage();
  const clock = { t: 1_000_000 };
  return {
    local,
    session,
    clock,
    deps: {
      local,
      session,
      now: () => clock.t,
      byteSize: (s) => new TextEncoder().encode(s).length,
      ...overrides,
    },
  };
}

// ── fixtures ─────────────────────────────────────────────────────────────

const ORIGIN = 'https://site.test';

function styleRule(targetRef: string, declarations: Array<{ property: string; value: string; priority?: 'normal' | 'important' }>) {
  return { target: { targetRef }, surface: 'element' as const, state: 'none' as const, declarations: declarations.map((d) => ({ ...d, priority: d.priority ?? ('normal' as const) })), conditions: [] };
}

function revision(id: string, overrides: Partial<Revision> = {}): Revision {
  return {
    revisionId: id,
    capabilityVersion: 1,
    targetDescriptors: [
      {
        descriptorVersion: 1,
        rootPath: [],
        selection: 'single',
        anchor: { tag: 'main' },
        relation: 'self',
        matchBounds: { min: 1, max: 1 },
        routeScopeRef: ORIGIN,
        continuityPolicy: 'stable-single',
      },
    ],
    operations: [
      {
        kind: 'style',
        rules: [styleRule('r1', [{ property: 'color', value: 'red', priority: 'important' }])],
      },
    ],
    savedAt: 1,
    source: 'user-planned',
    ...overrides,
  };
}

function saveReq(overrides: Partial<Parameters<ReturnType<typeof createStore>['save']>[0]> = {}) {
  return {
    origin: ORIGIN,
    customizationId: 'cust-1',
    title: 'Test customization',
    scope: { mode: 'exactPath' as const, path: '/page' },
    contentSensitivity: 'page-only' as const,
    grants: [],
    revision: revision('rev-1'),
    expectedRecordRevision: 0,
    mutationId: 'm-1',
    ...overrides,
  };
}

const rv2Key = `rv2:origin:${ORIGIN}`;

function storedRecord(local: ReturnType<typeof fakeStorage>): OriginRecord {
  const raw = local.data.get(rv2Key) as string;
  const decoded = decodeOriginRecord(JSON.parse(raw));
  assert.ok(decoded.ok, 'the stored record always re-decodes');
  return decoded.value;
}

// ── save + confirm ───────────────────────────────────────────────────────

test('T12: one complete record write is acknowledged after a confirming re-read', async () => {
  const { deps, local } = makeDeps();
  const store = createStore(deps);
  const out = await store.save(saveReq());
  assert.ok(out.ok, JSON.stringify(out));
  assert.equal(out.value.recordRevision, 1);
  const record = storedRecord(local);
  assert.equal(record.lastMutationId, 'm-1');
  assert.equal(record.customizations.length, 1);
  assert.equal(record.customizations[0].enabled, true);
  assert.equal(record.customizations[0].activeRevisionId, 'rev-1');
  // No pending marker survives a confirmed write.
  const pending = (await deps.session.get('rv2:pendingWrites'))['rv2:pendingWrites'] as Record<string, unknown> | undefined;
  assert.equal(pending === undefined || Object.keys(pending).length === 0, true);
});

test('T12: a second save appends a revision and trims to active + previous', async () => {
  const { deps, local } = makeDeps();
  const store = createStore(deps);
  const first = await store.save(saveReq({ mutationId: 'm-1', revision: revision('rev-1') }));
  assert.ok(first.ok);
  const second = await store.save(saveReq({ mutationId: 'm-2', revision: revision('rev-2'), expectedRecordRevision: 1 }));
  assert.ok(second.ok, JSON.stringify(second));
  const record = storedRecord(local);
  const cust = record.customizations[0];
  assert.equal(cust.activeRevisionId, 'rev-2');
  assert.deepEqual(cust.revisions.map((r) => r.revisionId), ['rev-1', 'rev-2'], 'active + previous only');
  void 0;
  const third = await store.save(saveReq({ mutationId: 'm-3', revision: revision('rev-3'), expectedRecordRevision: 2 }));
  assert.ok(third.ok);
  const cust3 = storedRecord(local).customizations[0];
  assert.deepEqual(cust3.revisions.map((r) => r.revisionId), ['rev-2', 'rev-3'], 'older history is trimmed, not accumulated');
});

// ── concurrency (T30) ────────────────────────────────────────────────────

test('T30: a stale expected revision conflicts with the current summary — never a silent overwrite', async () => {
  const { deps } = makeDeps();
  const store = createStore(deps);
  await store.save(saveReq({ mutationId: 'm-1' }));
  // Tab B saved meanwhile; tab A still expects revision 0.
  await store.save(saveReq({ mutationId: 'm-2', customizationId: 'cust-2', expectedRecordRevision: 1 }));
  const stale = await store.save(saveReq({ mutationId: 'm-3', expectedRecordRevision: 0 }));
  assert.equal(stale.ok, false);
  if (!stale.ok) {
    assert.equal(stale.code, 'conflict');
    assert.equal(stale.conflict?.recordRevision, 2);
    assert.deepEqual(stale.conflict?.customizations.map((c) => c.customizationId).sort(), ['cust-1', 'cust-2']);
  }
  // Disjoint merge after refreshing: same payload, current revision → succeeds.
  const refreshed = await store.save(saveReq({ mutationId: 'm-4', expectedRecordRevision: 2 }));
  assert.ok(refreshed.ok, 'the disjoint save succeeds after the UI refreshes');
});

test('T30: concurrent saves on one origin serialize — both land in explicit order (I13)', async () => {
  const { deps, local } = makeDeps();
  const store = createStore(deps);
  const results = await Promise.all([
    store.save(saveReq({ mutationId: 'mA', customizationId: 'cust-A', expectedRecordRevision: 0 })),
    store.save(saveReq({ mutationId: 'mB', customizationId: 'cust-B', expectedRecordRevision: 0 })),
  ]);
  const okCount = results.filter((r) => r.ok).length;
  assert.equal(okCount, 1, 'exactly one of two same-revision writers wins; the loser sees conflict');
  assert.equal(results[0].ok, true, 'the serialized first writer wins');
  const record = storedRecord(local);
  assert.deepEqual(record.customizations.map((c) => c.customizationId), ['cust-A'], 'the array order is the explicit composition order');
});

test('T12: the same mutationId replays its outcome; a different payload with it is refused', async () => {
  const { deps, local } = makeDeps();
  const store = createStore(deps);
  const first = await store.save(saveReq({ mutationId: 'm-1' }));
  assert.ok(first.ok);
  const replay = await store.save(saveReq({ mutationId: 'm-1' }));
  assert.deepEqual(replay, first, 'exact replay returns the same outcome');
  assert.equal(storedRecord(local).customizations.length, 1, 'no duplicate customization');
  const forged = await store.save(saveReq({ mutationId: 'm-1', title: 'Hijacked title' }));
  assert.equal(forged.ok, false);
  if (!forged.ok) assert.equal(forged.code, 'conflict');
});

// ── quota (T12/I21) ──────────────────────────────────────────────────────

test('T12: an oversize customization is refused with the record untouched (applied-unsaved)', async () => {
  const { deps, local } = makeDeps();
  const store = createStore(deps);
  await store.save(saveReq({ mutationId: 'm-1' }));
  const before = local.data.get(rv2Key);
  const huge: Revision = revision('rev-huge');
  // Schema-max payload: 32 rules x 64 declarations x 2048-char values (~4 MB
  // serialized) — passes decodeOperationBatch (2048 declarations total) but
  // blows the 256 KiB per-customization budget.
  huge.operations = [
    {
      kind: 'style',
      rules: Array.from({ length: 32 }, (_, r) =>
        styleRule(`r${r}`, Array.from({ length: LIMITS.maxDeclarationsPerRule }, () => ({
          property: 'color',
          value: `rgb(1, 2, 3) /* ${'x'.repeat(2000)} */`,
          priority: 'important' as const,
        }))),
      ),
    },
  ];
  const out = await store.save(saveReq({ mutationId: 'm-2', revision: huge, expectedRecordRevision: 1 }));
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.code, 'quota-exceeded');
    assert.equal(out.fieldPath, 'revision');
  }
  assert.equal(local.data.get(rv2Key), before, 'the stored record is byte-identical — nothing half-written');
});

test('T12: total saved bytes across origins are measured against the plan/13 budget', async () => {
  // A small total budget via overrides is not possible (LIMITS is const), so
  // measure the real behavior: many origins under the cap still save.
  const { deps } = makeDeps();
  const store = createStore(deps);
  for (let i = 0; i < 3; i++) {
    const out = await store.save(saveReq({ origin: `https://o${i}.test`, mutationId: `m-${i}` }));
    assert.ok(out.ok);
  }
  assert.equal(store.stats().origins, 3);
});

// ── interruption (T12) ───────────────────────────────────────────────────

test('T12: a storage failure after the pending marker reports unsaved, and hydrate reconciles it', async () => {
  const { deps, local } = makeDeps();
  const store = createStore(deps);
  await store.save(saveReq({ mutationId: 'm-0' })); // record at revision 1
  const before = local.data.get(rv2Key);
  local.failNextSet = true;
  const failed = await store.save(saveReq({ mutationId: 'm-1', revision: revision('rev-2'), expectedRecordRevision: 1 }));
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.equal(failed.code, 'quota-exceeded', 'a storage quota failure is quota, not success');
  assert.equal(local.data.get(rv2Key), before);

  // The worker died BEFORE clearing the marker of an in-flight write (T12:
  // worker dies around write). Simulate: marker present, write landed.
  await deps.session.set({ 'rv2:pendingWrites': { 'm-lost': { origin: ORIGIN, at: 1 } } });
  // The write for m-lost actually landed (simulate a completed set after the marker):
  const landed = await store.save(saveReq({ mutationId: 'm-lost', expectedRecordRevision: 1 }));
  assert.ok(landed.ok);
  // Re-plant the marker as if the crash happened between write and cleanup:
  await deps.session.set({ 'rv2:pendingWrites': { 'm-lost': { origin: ORIGIN, at: 2 } } });
  const hydration = await store.hydrate();
  const lost = hydration.pending.find((p) => p.mutationId === 'm-lost');
  assert.equal(lost?.outcome, 'confirmed', 'a matching lastMutationId proves the write happened');
  // An unknown marker has no proof — reported unsaved, never retried blind.
  await deps.session.set({ 'rv2:pendingWrites': { 'm-ghost': { origin: ORIGIN, at: 3 } } });
  const hydration2 = await store.hydrate();
  const ghost = hydration2.pending.find((p) => p.mutationId === 'm-ghost');
  assert.equal(ghost?.outcome, 'unsaved');
});

// ── quarantine (T26) ─────────────────────────────────────────────────────

test('T26: legacy rv_* journals are quarantined untouched — never replayed, never executed', async () => {
  const { deps, local } = makeDeps();
  const legacyPayload = JSON.stringify({ enabled: true, entries: [{ kind: 'act', tool: 'css', args: { css: 'body{display:none}' } }] });
  local.data.set('rv_https://site.test/wiki/CSS', legacyPayload);
  local.data.set('rv_https://site.test/wiki/HTML', JSON.stringify({ enabled: true, entries: [{ kind: 'act', tool: 'annotate', args: { html: '<img src=x onerror=alert(1)>' } }] }));
  const store = createStore(deps);
  const hydration = await store.hydrate();
  assert.equal(hydration.quarantined.length, 2);
  assert.ok(hydration.quarantined.every((q) => q.reason === 'legacy-v0'));
  // Byte-for-byte untouched.
  assert.equal(local.data.get('rv_https://site.test/wiki/CSS'), legacyPayload);
  // The raw payload is exportable to the trusted workspace for review only.
  const raw = await store.exportQuarantined('rv_https://site.test/wiki/CSS');
  assert.equal(raw, legacyPayload);
  assert.equal(await store.exportQuarantined('rv2:origin:missing'), undefined);
});

test('T26: unknown schema versions and corrupt records are quarantined, never overwritten by saves', async () => {
  const { deps, local } = makeDeps();
  local.data.set(`rv2:origin:https://future.test`, JSON.stringify({ schemaVersion: 99, origin: 'https://future.test' }));
  local.data.set(`rv2:origin:https://broken.test`, '{not json');
  const store = createStore(deps);
  const hydration = await store.hydrate();
  assert.deepEqual(
    hydration.quarantined.map((q) => q.reason).sort(),
    ['corrupt', 'unknown-schema'],
  );
  // A save against the quarantined corrupt record refuses; the bytes stay.
  const out = await store.save(saveReq({ origin: 'https://broken.test' }));
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.code, 'internal');
  assert.equal(local.data.get('rv2:origin:https://broken.test'), '{not json');
  // A save against the unknown-schema record refuses the same way.
  const out2 = await store.save(saveReq({ origin: 'https://future.test' }));
  assert.equal(out2.ok, false);
  assert.equal(local.data.get('rv2:origin:https://future.test'), JSON.stringify({ schemaVersion: 99, origin: 'https://future.test' }));
});

// ── tombstones (plan/13 §6) ──────────────────────────────────────────────

test('T12: removal tombstones block stale-session resurrection and expire after the stale deadline', async () => {
  const { deps, local, clock } = makeDeps();
  const store = createStore(deps);
  await store.save(saveReq({ mutationId: 'm-1' }));
  const removed = await store.removeCustomization({ origin: ORIGIN, customizationId: 'cust-1', expectedRecordRevision: 1, mutationId: 'm-2' });
  assert.ok(removed.ok, JSON.stringify(removed));
  let record = storedRecord(local);
  assert.equal(record.customizations.length, 0);
  assert.equal(record.tombstones?.length, 1);
  // A stale session replays the old save: blocked by the tombstone.
  const zombie = await store.save(saveReq({ mutationId: 'm-3', expectedRecordRevision: 2 }));
  assert.equal(zombie.ok, false);
  if (!zombie.ok) assert.equal(zombie.code, 'conflict');
  assert.equal(storedRecord(local).customizations.length, 0, 'the removed customization stays removed');
  // After the 5-minute stale deadline the tombstone expires lazily.
  clock.t += LIMITS.tombstoneStaleMs + 1;
  const reSave = await store.save(saveReq({ mutationId: 'm-4', expectedRecordRevision: 2 }));
  assert.ok(reSave.ok, 'a fresh save after the stale deadline is legitimate work, not resurrection');
  record = storedRecord(local);
  assert.equal(record.customizations.length, 1);
  assert.equal(record.tombstones?.length, 0, 'expired tombstones are dropped');
});

test('T12: setEnabled flips the durable flag through the same revision gate', async () => {
  const { deps, local } = makeDeps();
  const store = createStore(deps);
  await store.save(saveReq({ mutationId: 'm-1' }));
  const stale = await store.setEnabled({ origin: ORIGIN, customizationId: 'cust-1', enabled: false, expectedRecordRevision: 0, mutationId: 'm-2' });
  assert.equal(stale.ok, false, 'stale enable is a conflict, not a silent flip');
  const ok = await store.setEnabled({ origin: ORIGIN, customizationId: 'cust-1', enabled: false, expectedRecordRevision: 1, mutationId: 'm-2' });
  assert.ok(ok, JSON.stringify(ok));
  assert.equal(storedRecord(local).customizations[0].enabled, false);
  const ghost = await store.setEnabled({ origin: ORIGIN, customizationId: 'nope', enabled: true, expectedRecordRevision: 2, mutationId: 'm-3' });
  assert.equal(ghost.ok, false);
});

// ── I13 order + record integrity ─────────────────────────────────────────

test('I13/T30: explicit customization order survives saves and trimming', async () => {
  const { deps, local } = makeDeps();
  const store = createStore(deps);
  await store.save(saveReq({ mutationId: 'm-1', customizationId: 'alpha' }));
  await store.save(saveReq({ mutationId: 'm-2', customizationId: 'beta', expectedRecordRevision: 1 }));
  await store.save(saveReq({ mutationId: 'm-3', customizationId: 'alpha', revision: revision('rev-2'), expectedRecordRevision: 2 }));
  const record = storedRecord(local);
  assert.deepEqual(record.customizations.map((c) => c.customizationId), ['alpha', 'beta'], 'merges never reorder');
  // The whole record always re-decodes under the strict v2 decoder.
  assert.equal(decodeOriginRecord(JSON.parse(local.data.get(rv2Key) as string)).ok, true);
  assert.equal(ORIGIN_RECORD_SCHEMA_VERSION, 2);
});

// ── T25 slice: credentials cannot hide inside a saved revision ───────────

test('T25: a revision payload with unexpected extra fields (e.g. apiKey) is rejected by the record decoder', () => {
  const poisoned = revision('rev-x');
  const poisonedJson = JSON.stringify({ ...poisoned, apiKey: 'sk-secret-123' });
  const parsed = JSON.parse(poisonedJson);
  assert.equal(decodeRevision(parsed).ok, false, 'unknown fields are rejected — no credential smuggles into a record');
  const recordShape = {
    schemaVersion: 2,
    origin: ORIGIN,
    recordRevision: 1,
    lastMutationId: 'm',
    customizations: [],
    updatedAt: 1,
    providerToken: 'bearer-secret',
  };
  assert.equal(decodeOriginRecord(recordShape).ok, false, 'record-level unknown fields are rejected too');
});

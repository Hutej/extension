/**
 * S5.2 — runtime/replay unit tests (T10/T11/T23 record slices).
 *
 * The real replay core over a stub DOM and a scripted stub transaction
 * (plan/20: stateful modules call real functions with injected seams).
 * Covers: scope semantics (exactPath/pathPrefix slash boundary/origin,
 * query/hash discriminators), descriptor resolution (missing → waiting,
 * ambiguous → suspended), replay through the transaction path (I14),
 * route A→B→A release/restore (T11), disable/remove broadcasts, set
 * membership change → one desired-state re-apply, and the conflict pause
 * (plan/13 §5).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Customization, Revision, RouteScope } from '../../src/contracts.ts';
import { createTargetRegistry } from '../../src/runtime/targets.ts';
import { createReplay, scopeMatches, resolveDescriptor, type ReplayEntry } from '../../src/runtime/replay.ts';

// ── stub DOM ─────────────────────────────────────────────────────────────

interface StubNode {
  tagName: string;
  id: string;
  attrs: Map<string, string>;
  children: StubNode[];
  parentNode: StubNode | null;
  isConnected: boolean;
  textContent: string;
  getAttribute(name: string): string | null;
}

function el(tag: string, attrs: Record<string, string> = {}, children: StubNode[] = []): StubNode {
  const map = new Map(Object.entries(attrs));
  const node: StubNode = {
    tagName: tag.toUpperCase(),
    id: attrs.id ?? '',
    attrs: map,
    children,
    parentNode: null,
    isConnected: true,
    textContent: '',
    getAttribute(name: string) {
      return map.get(name) ?? null;
    },
  };
  Object.defineProperty(node, 'parentElement', {
    get: () => node.parentNode,
  });
  for (const c of children) c.parentNode = node;
  return node;
}

function find(all: StubNode[], pred: (n: StubNode) => boolean): StubNode[] {
  const out: StubNode[] = [];
  const walk = (n: StubNode): void => {
    if (pred(n)) out.push(n);
    for (const c of n.children) walk(c);
  };
  for (const root of all) walk(root);
  return out;
}

/** Minimal selector engine for the shapes resolveAnchors uses:
 *  `#id`, `[name="value"]`, tag, `*`. */
function select(all: StubNode[], selector: string): StubNode[] {
  if (selector === '*') return find(all, () => true);
  if (selector.startsWith('#')) return find(all, (n) => n.id === selector.slice(1));
  const attr = /^\[([^=\]]+)="([^"]*)"\]$/.exec(selector);
  if (attr) return find(all, (n) => n.attrs.get(attr[1]) === attr[2]);
  return find(all, (n) => n.tagName.toLowerCase() === selector.toLowerCase());
}

function matchesAnchorStub(n: StubNode, anchor: { tag?: string; stableId?: string; testAttribute?: { name: string; value: string }; role?: string; accessibleLabel?: string }): boolean {
  if (anchor.tag && n.tagName.toLowerCase() !== anchor.tag.toLowerCase()) return false;
  if (anchor.stableId !== undefined && n.id !== anchor.stableId) return false;
  if (anchor.testAttribute && n.attrs.get(anchor.testAttribute.name) !== anchor.testAttribute.value) return false;
  if (anchor.role !== undefined && n.attrs.get('role') !== anchor.role) return false;
  if (anchor.accessibleLabel !== undefined && (n.attrs.get('aria-label') ?? n.textContent.trim()) !== anchor.accessibleLabel) return false;
  return true;
}

function makeDoc(...roots: StubNode[]): { doc: unknown; all: StubNode[]; adopt(n: StubNode): void; detach(n: StubNode): void } {
  const all: StubNode[] = roots;
  const doc = {
    querySelector: (s: string) => select(all, s)[0] ?? null,
    querySelectorAll: (s: string) => select(all, s),
  };
  return {
    doc,
    all,
    adopt(n: StubNode) {
      if (!all.includes(n)) all.push(n);
      n.isConnected = true;
    },
    detach(n: StubNode) {
      n.isConnected = false;
    },
  };
}

// The production resolveDescriptor expects a real Document; the unit tests
// exercise the shared selector/predicate logic through the same code path by
// casting the stub. This keeps one resolver implementation (no test-only
// resolver drift).
const asDoc = (doc: unknown): Document => doc as unknown as Document;

// ── stub transaction ─────────────────────────────────────────────────────

type ApplyScript = (batch: { batchId: string; customizationId: string; revisionId: string; operations: unknown[] }) => { status: string; error?: { message: string } };

function stubTransaction(script: ApplyScript) {
  const applied: Array<{ batchId: string; customizationId: string; revisionId: string; operations: unknown[] }> = [];
  const released: string[] = [];
  return {
    applied,
    released,
    applyBatch: async (batch: { batchId: string; customizationId: string; revisionId: string; operations: unknown[] }) => {
      applied.push(batch);
      const out = script(batch);
      return { batchId: batch.batchId, payloadDigest: 'd', status: out.status as never, resourceIds: [], ...(out.error ? { error: out.error as never } : {}) };
    },
    releaseCustomization: async (customizationId: string) => {
      released.push(customizationId);
      return { batchId: `release:${customizationId}`, payloadDigest: '', status: 'accepted' as never, resourceIds: [] };
    },
    /** The transaction is the source of truth for live revisions (the
     *  disable/record-removal release condition checks it). */
    revisions: () => applied.map((a) => ({ customizationId: a.customizationId, revisionId: a.revisionId })),
    receiptFor: () => undefined,
  };
}

// ── fixtures ─────────────────────────────────────────────────────────────

const ORIGIN = 'https://site.test';

function revision(id: string, targetRef = 'd0'): Revision {
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
      { kind: 'style', rules: [{ target: { targetRef }, surface: 'element', state: 'none', declarations: [{ property: 'color', value: 'red', priority: 'important' }], conditions: [] }] },
    ],
    savedAt: 1,
    source: 'user-planned',
  };
}

function customization(overrides: Partial<Customization> = {}): Customization {
  return {
    customizationId: 'cust-1',
    title: 'Test',
    enabled: true,
    scope: { mode: 'exactPath', path: '/page' },
    activeRevisionId: 'rev-1',
    revisions: [revision('rev-1')],
    createdAt: 1,
    updatedAt: 1,
    contentSensitivity: 'page-only',
    grants: [],
    ...overrides,
  };
}

function makeWorld(href: string, txnScript?: ApplyScript) {
  const main = el('main');
  const w = makeDoc(main);
  const targets = createTargetRegistry();
  targets.registerRoot(w.doc as unknown as Document);
  const txn = stubTransaction(txnScript ?? (() => ({ status: 'accepted' })));
  const stateUpdates: ReplayEntry[][] = [];
  let clock = 1_000_000;
  const replay = createReplay({
    doc: asDoc(w.doc),
    targets,
    transaction: txn as unknown as Parameters<typeof createReplay>[0]['transaction'],
    href: () => href,
    now: () => (clock += 1000),
    randomId: () => `id-${clock}`,
    onStatesChanged: (entries) => stateUpdates.push(entries),
  });
  return { w, main, targets, txn, replay, stateUpdates, hrefBox: { get: () => href, set: (h: string) => { href = h; } } };
}

// ── scope semantics (plan/13 §2, T11) ────────────────────────────────────

test('S5.2/T11: scope modes match with slash boundaries; discriminators are exact alternatives', () => {
  assert.equal(scopeMatches({ mode: 'exactPath', path: '/wiki/CSS' }, 'https://x.test/wiki/CSS?lang=en#top'), true, 'query/hash do not affect exactPath');
  assert.equal(scopeMatches({ mode: 'exactPath', path: '/wiki/CSS' }, 'https://x.test/wiki/HTML'), false);
  assert.equal(scopeMatches({ mode: 'pathPrefix', path: '/wiki' }, 'https://x.test/wiki/CSS'), true);
  assert.equal(scopeMatches({ mode: 'pathPrefix', path: '/wiki' }, 'https://x.test/wikileaks'), false, 'slash boundary holds');
  assert.equal(scopeMatches({ mode: 'pathPrefix', path: '/' }, 'https://x.test/anything'), true);
  assert.equal(scopeMatches({ mode: 'origin' }, 'https://x.test/deep/path'), true);
  // Discriminators: any approved alternative admits the route; values exact.
  const disc: RouteScope = { mode: 'exactPath', path: '/watch', discriminators: [{ kind: 'query', key: 'v', value: 'abc' }, { kind: 'hash', value: 'comments' }] };
  assert.equal(scopeMatches(disc, 'https://x.test/watch?v=abc'), true);
  assert.equal(scopeMatches(disc, 'https://x.test/watch#comments'), true);
  assert.equal(scopeMatches(disc, 'https://x.test/watch?v=other'), false, 'no wildcard over other values');
  assert.equal(scopeMatches(disc, 'https://x.test/watch'), false, 'a discriminator-bearing scope requires one');
});

// ── descriptor resolution (I15) ──────────────────────────────────────────

test('S5.2/I15: descriptors resolve by predicates — missing waits, ambiguity suspends, a hash is never identity', () => {
  const first = makeDoc(el('main'));
  const doc = asDoc(first.doc);
  const d = { rootPath: [] as string[], selection: 'single' as const, anchor: { tag: 'main' }, relation: 'self' as const, matchBounds: { min: 1, max: 1 } };
  const ok = resolveDescriptor(doc, d);
  void ok;
  assert.ok(ok.ok && ok.elements.length === 1);
  const missing = resolveDescriptor(doc, { ...d, anchor: { tag: 'article' } });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.reason, 'missing');
  const twinDoc = makeDoc(el('main'), el('main')); // two mains in the document
  const ambiguous = resolveDescriptor(asDoc(twinDoc.doc), d);
  assert.equal(ambiguous.ok, false);
  if (!ambiguous.ok) assert.equal(ambiguous.reason, 'ambiguous');
});

test('S5.2/I15: stable-id and test-attribute anchors find the exact node; sibling relation stays inside the parent', () => {
  const btn = el('button', { id: 'save-btn' });
  const other = el('button', { 'data-testid': 'save' });
  const parent = el('div', {}, [btn, other]);
  const { doc } = makeDoc(parent);
  const realDoc = asDoc(doc);
  const asStub = (e: unknown): StubNode => e as StubNode;
  const byId = resolveDescriptor(realDoc, { rootPath: [], selection: 'single', anchor: { tag: 'button', stableId: 'save-btn' }, relation: 'self', matchBounds: { min: 1, max: 1 } });
  assert.ok(byId.ok && asStub(byId.elements[0]) === btn);
  const byAttr = resolveDescriptor(realDoc, { rootPath: [], selection: 'single', anchor: { tag: 'button', testAttribute: { name: 'data-testid', value: 'save' } }, relation: 'self', matchBounds: { min: 1, max: 1 } });
  assert.ok(byAttr.ok && asStub(byAttr.elements[0]) === other);
  const sib = resolveDescriptor(realDoc, { rootPath: [], selection: 'single', anchor: { tag: 'button', stableId: 'save-btn' }, relation: 'sibling', matchBounds: { min: 1, max: 1 } });
  assert.ok(sib.ok && asStub(sib.elements[0]) === other, 'the sibling of the anchor within the same parent');
});

// ── replay through the transaction path (I14, T10) ───────────────────────

test('S5.2/T10: replay resolves descriptors fresh and applies through the SAME transaction path', async () => {
  const world = makeWorld('https://site.test/page');
  await world.replay.setApplicable([customization()]);
  assert.equal(world.txn.applied.length, 1);
  const batch = world.txn.applied[0];
  assert.equal(batch.customizationId, 'cust-1');
  assert.equal(batch.revisionId, 'rev-1');
  assert.equal(batch.batchId, 'replay:cust-1:rev-1', 'the batch carries the stable replay batch id (deduped by the transaction)');
  // The saved op's d0 was rewritten to a fresh session ref.
  const op = batch.operations[0] as { rules: Array<{ target: { targetRef: string } }> };
  assert.match(op.rules[0].target.targetRef, /^t\d+$/, 'd0 became a fresh session ref');
  assert.deepEqual(world.replay.states(), [{ customizationId: 'cust-1', title: 'Test', revisionId: 'rev-1', state: 'applied' }]);
  // Re-registering the SAME intent never re-applies (no duplicate widgets).
  await world.replay.setApplicable([customization()]);
  assert.equal(world.txn.applied.length, 1);
});

test('S5.2/T10: a missing target waits; a rolled-back replay suspends with the public detail', async () => {
  const { doc } = makeDoc(el('main'));
  const targets = createTargetRegistry();
  targets.registerRoot(doc as unknown as Document);
  const failing = stubTransaction(() => ({ status: 'rolled-back', error: { message: 'verification fail: effect:style:0' } }));
  const r = createReplay({
    doc: asDoc(doc),
    targets,
    transaction: failing as unknown as Parameters<typeof createReplay>[0]['transaction'],
    href: () => 'https://site.test/page',
    now: () => 1_000_000,
    randomId: () => 'x',
    onStatesChanged: () => {},
  });
  await r.setApplicable([customization()]);
  assert.deepEqual(r.states().map((s) => s.state), ['suspended']);
  assert.match(r.states()[0].detail ?? '', /effect:style/);
  // Now the target disappears entirely → waiting (not suspended).
  const passing = stubTransaction(() => ({ status: 'accepted' }));
  const r2 = createReplay({
    doc: asDoc({ querySelector: () => null, querySelectorAll: () => [] }),
    targets: createTargetRegistry(),
    transaction: passing as unknown as Parameters<typeof createReplay>[0]['transaction'],
    href: () => 'https://site.test/page',
    now: () => 1_000_000,
    randomId: () => 'x',
    onStatesChanged: () => {},
  });
  await r2.setApplicable([customization()]);
  assert.deepEqual(r2.states().map((s) => s.state), ['waiting']);
  assert.equal(passing.applied.length, 0, 'a missing target applies nothing');
});

// ── route A→B→A (T11) ────────────────────────────────────────────────────

test('S5.2/T11: out-of-scope route releases owned resources; returning restores them once', async () => {
  const world = makeWorld('https://site.test/page');
  await world.replay.setApplicable([customization()]);
  assert.equal(world.txn.applied.length, 1);
  world.hrefBox.set('https://site.test/other');
  await world.replay.onRouteChanged();
  assert.deepEqual(world.txn.released, ['cust-1'], 'out-of-scope tokens revoked before new activation');
  assert.deepEqual(world.replay.states().map((s) => s.state), ['out-of-scope']);
  world.hrefBox.set('https://site.test/page');
  await world.replay.onRouteChanged();
  assert.equal(world.txn.applied.length, 2, 'the same intent re-applies on return — fresh resolution, no model');
  assert.deepEqual(world.replay.states().map((s) => s.state), ['applied']);
});

// ── disable/remove broadcasts (plan/13 §6) ───────────────────────────────

test('S5.2: disable releases locally and marks disabled; enable replays; remove forgets', async () => {
  const world = makeWorld('https://site.test/page');
  await world.replay.setApplicable([customization()]);
  await world.replay.setEnabled('cust-1', false);
  assert.deepEqual(world.txn.released, ['cust-1']);
  assert.deepEqual(world.replay.states().map((s) => s.state), ['disabled']);
  await world.replay.setEnabled('cust-1', true);
  assert.equal(world.txn.applied.length, 2);
  assert.deepEqual(world.replay.states().map((s) => s.state), ['applied']);
  await world.replay.removeCustomization('cust-1');
  assert.deepEqual(world.replay.states(), [], 'removed customizations leave the live map');
});

// ── conflict pause (plan/13 §5) ──────────────────────────────────────────

test('S5.2/T23: two rolled-back replays within the window pause the group — visible, not retried', async () => {
  let now = 1_000_000;
  const { w, replay, txn } = (() => {
    const main = el('main');
    const w = makeDoc(main);
    const targets = createTargetRegistry();
    targets.registerRoot(w.doc as unknown as Document);
    void main;
    const failing = stubTransaction(() => ({ status: 'rolled-back', error: { message: 'verification fail' } }));
    const r = createReplay({
      doc: asDoc(w.doc),
      targets,
      transaction: failing as unknown as Parameters<typeof createReplay>[0]['transaction'],
      href: () => 'https://site.test/page',
      now: () => (now += 1000),
      randomId: () => 'x',
      onStatesChanged: () => {},
    });
    return { w, replay: r, txn: failing };
  })();
  await replay.setApplicable([customization()]);
  assert.deepEqual(replay.states().map((s) => s.state), ['suspended']);
  // A user retry (setEnabled) within the window hits the second rollback → paused.
  await replay.setEnabled('cust-1', true);
  assert.deepEqual(replay.states().map((s) => s.state), ['paused']);
  const appliedCount = txn.applied.length;
  // Route churn does NOT clear a paused group (needs an explicit user action).
  await replay.onRouteChanged();
  assert.equal(txn.applied.length, appliedCount, 'paused groups are not auto-retried');
});

test('S8.3/T06: rootPath hops reach open shadow descendants; closed or absent roots stay explicitly unsupported', () => {
  const label = el('span', { id: 'inner-label' });
  const innerScope = makeDoc(label);
  const host = el('widget');
  (host as StubNode & { shadowRoot?: unknown }).shadowRoot = innerScope.doc; // the stub's open-root interface
  const { doc } = makeDoc(host);
  const realDoc = asDoc(doc);

  const hop = resolveDescriptor(realDoc, { rootPath: ['widget'], selection: 'single', anchor: { tag: 'span', stableId: 'inner-label' }, relation: 'self', matchBounds: { min: 1, max: 1 } });
  assert.ok(hop.ok, JSON.stringify(hop));
  if (hop.ok) assert.equal((hop.elements[0] as unknown as StubNode), label, 'the hop resolved inside the shadow root');

  // A closed or absent root is an explicit unsupported outcome — never a
  // best-effort light-DOM guess (I26).
  (host as StubNode & { shadowRoot?: unknown }).shadowRoot = null;
  const closed = resolveDescriptor(realDoc, { rootPath: ['widget'], selection: 'single', anchor: { tag: 'span' }, relation: 'self', matchBounds: { min: 1, max: 1 } });
  assert.equal(closed.ok, false);
  if (!closed.ok) assert.equal(closed.reason, 'unsupported');
  if (!closed.ok) assert.match(closed.detail, /closed or absent/);

  // A missing host segment is unsupported too — the path never broadens.
  (host as StubNode & { shadowRoot?: unknown }).shadowRoot = innerScope.doc;
  const missingHost = resolveDescriptor(realDoc, { rootPath: ['widget', 'panel'], selection: 'single', anchor: { tag: 'span' }, relation: 'self', matchBounds: { min: 1, max: 1 } });
  assert.equal(missingHost.ok, false);
  if (!missingHost.ok) assert.equal(missingHost.reason, 'unsupported');
});

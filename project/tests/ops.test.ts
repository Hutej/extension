/**
 * Pure unit check for the F3 reversal layer — the runnable proof that:
 *  (a) a TransactionLog undoAll restores the DOM after a setText/insert,
 *  (b) on→off→on→off leaves the structure byte-identical at both offs,
 *  (c) a multi-op partial transform → undoAll restores the original (RC3),
 *  (d) validateOps refuses forbidden/non-empty/no-reason structural ops.
 * No framework, no browser, no fixtures — a fake in-memory DomAdapter.
 * Run: node --experimental-strip-types tests/ops.test.ts
 */

import assert from 'node:assert/strict';
import { TransactionLog, type DomAdapter } from '../src/core/ops/txn.ts';
import { validateOps, REMOVE_EMPTINESS_FLOOR } from '../src/core/ops/index.ts';
import type { Perception, Cluster, ClusterLayout, ClusterStyle } from '../src/core/perceive/index.ts';

// ── fake DOM ────────────────────────────────────────────────────────
// A minimal in-memory tree with back-pointers, indexed by handle. Implements
// DomAdapter so the inverse logic in txn.ts is unit-testable with no page.

interface FakeNode {
  tag: string;
  handle?: string;            // [data-rv-c] handle (for resolve/handleOf)
  inserted?: boolean;         // marks a Revueon-inserted node (insert inverse)
  text?: string;             // text content (for setText)
  children: FakeNode[];
  parent: FakeNode | null;
}

function leaf(tag: string, text = '', handle?: string): FakeNode {
  return { tag, handle, text, children: [], parent: null };
}

function fakeDom(root: FakeNode): DomAdapter {
  // Live resolution: re-walk the tree on each call, so a node swapped in by
  // replaceWith is found on the next query (matches document.querySelector).
  const findByHandle = (handle: string): FakeNode | null => {
    const dfs = (n: FakeNode): FakeNode | null => {
      if (n.handle === handle) return n;
      for (const c of n.children) { const r = dfs(c); if (r) return r; }
      return null;
    };
    return dfs(root);
  };
  const findBySelector = (sel: string): FakeNode | null => {
    const m = sel.match(/data-rv-c="([^"]+)"/);
    if (m) return findByHandle(m[1]);
    const dfs = (n: FakeNode): FakeNode | null => {
      if (n.tag === sel) return n;
      for (const c of n.children) { const r = dfs(c); if (r) return r; }
      return null;
    };
    return dfs(root);
  };

  return {
    resolve(handle) { return (findByHandle(handle) as unknown as HTMLElement) ?? null; },
    querySelector(selector) { return (findBySelector(selector) as unknown as HTMLElement) ?? null; },
    parent(node) { return (node as unknown as FakeNode).parent; },
    nextSibling(node) {
      const n = node as unknown as FakeNode;
      if (!n.parent) return null;
      const i = n.parent.children.indexOf(n);
      return n.parent.children[i + 1] ?? null;
    },
    insertBefore(parent, node, ref) {
      const p = parent as unknown as FakeNode;
      const n = node as unknown as FakeNode;
      const idx = ref ? p.children.indexOf(ref as unknown as FakeNode) : p.children.length;
      p.children.splice(idx, 0, n);
      n.parent = p;
    },
    appendChild(parent, node) {
      const p = parent as unknown as FakeNode;
      const n = node as unknown as FakeNode;
      p.children.push(n); n.parent = p;
    },
    removeChild(parent, node) {
      const p = parent as unknown as FakeNode;
      const n = node as unknown as FakeNode;
      const i = p.children.indexOf(n);
      if (i >= 0) p.children.splice(i, 1);
      n.parent = null;
    },
    createElement(tag) { return leaf(tag) as unknown as Node; },
    resolveDestination(to) { return to ? (byHandle.get(to) as unknown as HTMLElement ?? null) : null; },
    handleOf(node) { return (node as unknown as FakeNode).handle ?? null; },
    // F1: a structural fingerprint for the setText undo-verify branch. Matches
    // the real identity.ts fingerprint's spirit (tag + attrs + childCount +
    // text), so a test can mutate structure and assert the undo REFUSES.
    fingerprintOf(node) {
      const n = node as unknown as FakeNode;
      // Structural: tag + childCount + normalized text. Enough to distinguish
      // the test's nodes; a mutation that changes tag/text/childCount changes it.
      const text = (n.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
      return `${n.tag}|c${n.children.length}|${text}`;
    },
    replaceWith(node, replacement) {
      const n = node as unknown as FakeNode;
      const r = replacement as unknown as FakeNode;
      if (!n.parent) return;
      const i = n.parent.children.indexOf(n);
      n.parent.children[i] = r;
      r.parent = n.parent;
      n.parent = null;
    },
    // helper for setText/insert test scaffolding (not in DomAdapter): resolve a CSS selector.
  };
}

/** Structural serialization: tag#handle[:text][child,child]. Captures tag, handle,
 *  inserted-mark, child order, nesting, text. (No arbitrary attrs — the fake
 *  has none beyond handle/inserted; the LIVE comparator in assert-dom-clean.ts
 *  does the full attribute comparison.) */
function struct(n: FakeNode): string {
  const h = n.handle ? `#${n.handle}` : (n.inserted ? '+ins' : '');
  const t = n.text ? `:${n.text}` : '';
  const kids = n.children.length ? `[${n.children.map(struct).join(',')}]` : '';
  return `${n.tag}${h}${t}${kids}`;
}

// ── helpers: apply a setText/insert op against the fake, recording inverses ──

/** Deep-clone a FakeNode subtree WITHOUT the circular `parent` back-pointer
 *  (cloneNode(true) semantics for the fake). Re-stitches child→clone.parent. */
function cloneSubtree(n: FakeNode): FakeNode {
  const c: FakeNode = { tag: n.tag, handle: n.handle, inserted: n.inserted, text: n.text, children: [], parent: null };
  c.children = n.children.map(cloneSubtree);
  c.children.forEach((ch) => (ch.parent = c));
  return c;
}

function applySetText(log: TransactionLog, dom: DomAdapter, selector: string, newText: string): void {
  const el = dom.querySelector(selector) as unknown as FakeNode;
  const clone = cloneSubtree(el); // captured BEFORE mutation
  el.text = newText;
  el.children = [];
  log.record({ kind: 'setText', target: selector, inverse: { kind: 'setText', clone: clone as unknown as Node, selector } });
}

function applyInsert(log: TransactionLog, dom: DomAdapter, parentSelector: string, node: FakeNode): void {
  const parent = dom.querySelector(parentSelector) as unknown as FakeNode;
  dom.appendChild(parent, node as unknown as Node);
  log.record({ kind: 'insert', target: parentSelector, inverse: { kind: 'insert', node: node as unknown as Node } });
}

// ── (1) single setText → undoAll restores ────────────────────────────

function testSetTextUndoRestores() {
  const log = new TransactionLog();
  const body: FakeNode = { tag: 'body', children: [
    { tag: 'p', handle: 'p1', text: 'original', children: [], parent: null } as FakeNode,
  ], parent: null } as FakeNode;
  body.children[0].parent = body;
  const dom = fakeDom(body);

  const before = struct(body);
  applySetText(log, dom, '[data-rv-c="p1"]', 'summarised text');
  assert.equal(struct(body), 'body[p#p1:summarised text]', 'setText mutated the node');

  const { undone, failed } = log.undoAll(dom);
  assert.equal(undone, 1);
  assert.equal(failed, 0);
  assert.equal(struct(body), before, 'undoAll restored the original structure + text');
  console.log('  ✓ setText → undoAll restores structure (not just text)');
}

// ── (2) on → off → on → off leaves structure byte-identical at both offs ──

function testOnOffOnOff() {
  const body: FakeNode = { tag: 'body', children: [
    { tag: 'p', handle: 'p1', text: 'original', children: [], parent: null } as FakeNode,
  ], parent: null } as FakeNode;
  body.children[0].parent = body;
  const dom = fakeDom(body);
  const baseline = struct(body);

  // on: apply setText + an insert, recording into a fresh log.
  let log = new TransactionLog();
  applySetText(log, dom, '[data-rv-c="p1"]', 'summarised');
  applyInsert(log, dom, '[data-rv-c="p1"]', leaf('div', '', undefined) as FakeNode);
  // (after setText p1 has no children; insert appends a child div)
  const onState = struct(body);
  assert.notEqual(onState, baseline, 'on changed the DOM');

  // off: undoAll
  let r = log.undoAll(dom);
  assert.equal(r.undone, 2);
  assert.equal(struct(body), baseline, 'off #1 restored baseline');

  // on again: reset + re-apply (re-record fresh inverses)
  log = new TransactionLog();
  applySetText(log, dom, '[data-rv-c="p1"]', 'summarised');
  applyInsert(log, dom, '[data-rv-c="p1"]', leaf('div', '', undefined) as FakeNode);
  assert.equal(struct(body), onState, 'on #2 reproduces on #1');

  // off again
  r = log.undoAll(dom);
  assert.equal(r.undone, 2);
  assert.equal(struct(body), baseline, 'off #2 restored baseline — on→off→on→off byte-identical at both offs');
  console.log('  ✓ on→off→on→off leaves the DOM byte-identical at both offs');
}

// ── (3) multi-op partial transform → failure → undoAll → original (RC3) ──

function testMultiOpFailureRollback() {
  const body: FakeNode = { tag: 'body', children: [
    { tag: 'aside', handle: 's1', text: '', children: [], parent: null } as FakeNode,
    { tag: 'p', handle: 'p1', text: 'original', children: [], parent: null } as FakeNode,
    { tag: 'p', handle: 'p2', text: 'second', children: [], parent: null } as FakeNode,
  ], parent: null } as FakeNode;
  body.children.forEach((c) => (c.parent = body));
  const dom = fakeDom(body);
  const baseline = struct(body);

  const log = new TransactionLog();
  // apply A (setText on p1), B (setText on p2), C (insert) — then "fail" and undoAll.
  applySetText(log, dom, '[data-rv-c="p1"]', 'A-mutated');
  applySetText(log, dom, '[data-rv-c="p2"]', 'B-mutated');
  applyInsert(log, dom, '[data-rv-c="p1"]', leaf('span', 'C-inserted', undefined) as FakeNode);

  const partial = struct(body);
  assert.notEqual(partial, baseline, 'partial transform changed the DOM');

  // force failure → undoAll (the RC3 path the loop must call on terminal failure)
  const r = log.undoAll(dom);
  assert.equal(r.undone, 3);
  assert.equal(r.failed, 0);
  assert.equal(struct(body), baseline, 'multi-op failure → undoAll restored the original (RC3 fixed)');
  console.log('  ✓ partial transform (A,B,C) → forced failure → undoAll restores original');
}

// ── (4) undoAll is idempotent (repeat call is a safe no-op) ──────────

function testUndoAllIdempotent() {
  const body: FakeNode = { tag: 'body', children: [
    { tag: 'p', handle: 'p1', text: 'orig', children: [], parent: null } as FakeNode,
  ], parent: null } as FakeNode;
  body.children[0].parent = body;
  const dom = fakeDom(body);
  const log = new TransactionLog();
  applySetText(log, dom, '[data-rv-c="p1"]', 'changed');
  const r1 = log.undoAll(dom);
  const r2 = log.undoAll(dom); // repeat — must not re-undo / corrupt
  assert.equal(r1.undone, 1);
  assert.equal(r2.undone, 0, 'repeat undoAll undoes nothing (entries marked consumed)');
  assert.equal(struct(body), 'body[p#p1:orig]');
  console.log('  ✓ undoAll is idempotent — a repeat call is a safe no-op');
}

// ── (4b) undoLast — the per-step exact undo (F5) ─────────────────────
// Phase 3 F5.2: the loop's forced-checkLayout auto-undo and the `undo` control
// tool route DOM inverses through undoLast (the EXACT cloned-node inverse), not
// undoAll. Proves: (a) undoLast reverses the SINGLE most-recent op exactly
// (byte-identical to pre-op), (b) a second undoLast undoes the NEXT op, (c)
// undoLast is idempotent on an empty/consumed log (no-op, no corruption), and
// (d) on→off→on→off through the per-step undoLast path leaves the DOM
// byte-identical to baseline at BOTH offs (Law 7, the same invariant undoAll
// carries but via one-at-a-time undos — the path F5 actually uses).

function testUndoLastPerStep() {
  const body: FakeNode = { tag: 'body', children: [
    { tag: 'p', handle: 'p1', text: 'orig1', children: [], parent: null } as FakeNode,
    { tag: 'p', handle: 'p2', text: 'orig2', children: [], parent: null } as FakeNode,
  ], parent: null } as FakeNode;
  body.children[0].parent = body;
  body.children[1].parent = body;
  const dom = fakeDom(body);
  const baseline = struct(body);
  const log = new TransactionLog();

  // Apply two ops: setText on p1, then setText on p2.
  applySetText(log, dom, '[data-rv-c="p1"]', 'changed1');
  applySetText(log, dom, '[data-rv-c="p2"]', 'changed2');
  assert.equal(struct(body), 'body[p#p1:changed1,p#p2:changed2]', 'both ops applied');

  // undoLast reverses ONLY the most-recent (p2) — p1 stays changed.
  const r1 = log.undoLast(dom);
  assert.equal(r1.undone, 1, 'undoLast undid exactly one op');
  assert.equal(r1.failed, 0);
  assert.equal(struct(body), 'body[p#p1:changed1,p#p2:orig2]', 'undoLast reversed only the last op');

  // A second undoLast undoes the next one (p1) — back to baseline.
  const r2 = log.undoLast(dom);
  assert.equal(r2.undone, 1);
  assert.equal(struct(body), baseline, 'two undoLasts restored the baseline');

  // Idempotent: undoLast on a fully-consumed log is a safe no-op.
  const r3 = log.undoLast(dom);
  assert.equal(r3.undone, 0, 'undoLast on consumed log undoes nothing');
  assert.equal(struct(body), baseline, 'no corruption from empty-log undoLast');

  console.log('  ✓ undoLast reverses the single most-recent op exactly, then the next; idempotent on empty');
}

function testUndoLastOnOffOnOff() {
  // on→off→on→off using undoLast (the F5 per-step path). Both offs must be
  // byte-identical to baseline (Law 7), same as the undoAll path in test (2).
  const body: FakeNode = { tag: 'body', children: [
    { tag: 'p', handle: 'p1', text: 'orig', children: [], parent: null } as FakeNode,
  ], parent: null } as FakeNode;
  body.children[0].parent = body;
  const dom = fakeDom(body);
  const baseline = struct(body);

  // on
  const log1 = new TransactionLog();
  applySetText(log1, dom, '[data-rv-c="p1"]', 'on1');
  const off1 = log1.undoLast(dom);
  assert.equal(off1.undone, 1);
  assert.equal(struct(body), baseline, 'first off (undoLast) == baseline');

  // on again (fresh log)
  const log2 = new TransactionLog();
  applySetText(log2, dom, '[data-rv-c="p1"]', 'on2');
  const off2 = log2.undoLast(dom);
  assert.equal(off2.undone, 1);
  assert.equal(struct(body), baseline, 'second off (undoLast) == baseline');

  console.log('  ✓ on→off→on→off via undoLast is byte-identical at both offs');
}

// ── (5) validateOps guard smoke test ─────────────────────────────────
// validateOps is the future structural-op guard (remove/move/wrap). Phase 2's
// act tools don't emit these yet, but the port must compile + refuse correctly.

function layout(over: Partial<ClusterLayout> = {}): ClusterLayout {
  return { display: 'block', flow: 'none', widthRatio: 0.5, isContainer: false, ownedByFlexGrid: false, constraintOwnerHandle: null, parentHandle: null, isPassiveWrapper: false, isOpaqueWrapper: false, depth: 1, position: 'static', flexWrap: false, alignment: 'start', widthSizing: 'auto', centered: false, ...over };
}
function style(over: Partial<ClusterStyle> = {}): ClusterStyle {
  return { background: 'rgb(255,255,255)', color: 'rgb(0,0,0)', border: 'none', borderRadius: '0px', boxShadow: 'none', fontFamily: 'sans-serif', fontSize: '16px', fontWeight: '400', padding: '0px', display: 'block', hasBgImage: false, ...over } as ClusterStyle;
}
function cluster(over: Partial<Cluster>): Cluster {
  return {
    handle: 'c0', selector: '[data-rv-c="c0"]', structuralSelector: null, count: 1, tag: 'div', role: null,
    isNativeControl: false, isCheckboxRadio: false, hasSolidBg: true,
    rect: { x: 0, y: 0, w: 100, h: 100, vx: 0, vy: 0, aboveFold: true },
    samples: [], prominence: 1, layout: layout(), widthFractionOfParent: 1,
    emptinessScore: 0, moveSafety: 'safe', sourceOrder: 0, designRole: 'ad-or-void' as any,
    designRoleConfidence: 0.9, dominanceRank: 0, group: null, governingHeading: null,
    componentType: 'unknown' as any, componentConfidence: 0,
    textProfile: { readingLength: 0, kind: 'none', dir: 'auto', longestToken: 0, truncated: false } as any,
    provenance: {}, style: style(), ...over,
  } as Cluster;
}
// A minimal Perception — only the fields validateOps reads (clusters, handles).
// Cast to satisfy the large interface without building every enrichment field.
function perception(clusters: Cluster[]): Perception {
  return { clusters, handles: new Set(clusters.map((c) => c.handle)) } as unknown as Perception;
}

function testGuardLaws() {
  // remove on primary content → refused
  const main = cluster({ handle: 'c1', role: 'main' });
  let r = validateOps([{ kind: 'remove', target: 'c1', reason: 'cross-layout-regions' }], perception([main]));
  assert.equal(r.ops.length, 0);
  assert.ok(r.refused.some((x) => x.includes('primary-content')), 'remove on main refused');

  // remove on a near-empty, safe, short, confident cluster → accepted
  const empty = cluster({ handle: 'c2', role: 'complementary', rect: { x: 0, y: 0, w: 300, h: 80, vx: 0, vy: 0, aboveFold: true }, emptinessScore: 0.9, designRoleConfidence: 0.9 });
  r = validateOps([{ kind: 'remove', target: 'c2', reason: 'cross-layout-regions' }], perception([empty]));
  assert.equal(r.ops.length, 1, 'remove on near-empty safe cluster accepted');
  assert.equal(r.refused.length, 0);

  // remove on a content-rich cluster (low emptiness) → refused (not-empty)
  const rich = cluster({ handle: 'c3', role: 'complementary', emptinessScore: 0.1, designRoleConfidence: 0.9 });
  r = validateOps([{ kind: 'remove', target: 'c3', reason: 'cross-layout-regions' }], perception([rich]));
  assert.ok(r.refused.some((x) => x.includes('not-empty')), 'remove on content-rich cluster refused (not-empty)');

  // remove WITHOUT a reason → refused (default is no DOM mutation)
  r = validateOps([{ kind: 'remove', target: 'c2' } as any], perception([empty]));
  assert.ok(r.refused.some((x) => x.includes('no-mutation-reason')), 'remove without a reason refused');

  // remove on a low-confidence role → refused
  const unsure = cluster({ handle: 'c4', role: 'complementary', emptinessScore: 0.9, designRoleConfidence: 0.3 });
  r = validateOps([{ kind: 'remove', target: 'c4', reason: 'cross-layout-regions' }], perception([unsure]));
  assert.ok(r.refused.some((x) => x.includes('low-confidence-role')), 'remove on low-confidence role refused');

  // move on a forbidden target → refused
  const forbid = cluster({ handle: 'c5', moveSafety: 'forbidden' });
  r = validateOps([{ kind: 'move', target: 'c5', to: 'floating', reason: 'escape-overflow-hidden' }], perception([forbid]));
  assert.ok(r.refused.some((x) => x.includes('forbidden')), 'move on forbidden target refused');

  // move on a risky target WITHOUT consent → refused
  const risky = cluster({ handle: 'c6', moveSafety: 'risky' });
  r = validateOps([{ kind: 'move', target: 'c6', to: 'floating', reason: 'escape-overflow-hidden' }], perception([risky]));
  assert.ok(r.refused.some((x) => x.includes('risky-no-consent')), 'risky move without consent refused');

  console.log('  ✓ validateOps refuses primary-content / not-empty / no-reason / low-confidence / forbidden / risky-no-consent');
  assert.ok(REMOVE_EMPTINESS_FLOOR > 0, 'emptiness floor is a positive constant');
}

// ── runner ───────────────────────────────────────────────────────────

function run(name: string, fn: () => void) {
  process.stdout.write(name + ' ...\n');
  fn();
}

let failures = 0;
function guard(fn: () => void) { try { fn(); } catch (e) { failures++; console.error('  ✖ ' + (e as Error).message); } }

console.log('\nF3 reversal — ops unit tests\n');
guard(testSetTextUndoRestores);
guard(testOnOffOnOff);
guard(testMultiOpFailureRollback);
guard(testUndoAllIdempotent);
guard(testUndoLastPerStep);
guard(testUndoLastOnOffOnOff);
guard(testGuardLaws);

if (failures > 0) { console.error(`\n${failures} test(s) FAILED\n`); process.exit(1); }
console.log('\nAll ops unit tests passed.\n');

/**
 * Pure unit check for the structural-op layer — the runnable proof that the
 * guard laws hold, the undo inverse restores the DOM, and re-derive is
 * idempotent. No framework, no fixtures. Run: node --experimental-strip-types tests/ops.test.ts
 */

import assert from 'node:assert/strict';
import { validateOps, REMOVE_EMPTINESS_FLOOR } from '../src/core/ops/index.ts';
import { TransactionLog, type DomAdapter } from '../src/core/ops/transaction.ts';
import { detectVoids, classifyInvisibleFailures, type PixelInput, type ClusterRect } from '../src/core/verify/pixel.ts';
import type { DesignOp } from '../src/core/spec/index.ts';
import type { Perception, Cluster, ClusterLayout } from '../src/core/perceive/index.ts';
import type { ClusterStyle } from '../src/core/perceive/index.ts';

function layout(over: Partial<ClusterLayout> = {}): ClusterLayout {
  return { display: 'block', flow: 'none', widthRatio: 0.5, isContainer: false, ownedByFlexGrid: false, constraintOwnerHandle: null, parentHandle: null, isPassiveWrapper: false, isOpaqueWrapper: false, depth: 1, position: 'static', flexWrap: false, alignment: 'start', widthSizing: 'auto', centered: false, ...over };
}
function style(over: Partial<ClusterStyle> = {}): ClusterStyle {
  return { background: 'rgb(255,255,255)', color: 'rgb(0,0,0)', border: 'none', borderRadius: '0px', boxShadow: 'none', fontFamily: 'sans-serif', fontSize: '16px', fontWeight: '400', padding: '0px', display: 'block', hasBgImage: false, ...over };
}
function cluster(over: Partial<Cluster>): Cluster {
  return {
    handle: 'c000000', selector: '[data-rv-c="c000000"]', count: 1, tag: 'div', role: null,
    isNativeControl: false, isCheckboxRadio: false, hasSolidBg: true, rect: { x: 0, y: 0, w: 100, h: 100, vx: 0, vy: 0, aboveFold: true },
    samples: [], prominence: 1, layout: layout(), widthFractionOfParent: 1,
    emptinessScore: 0, moveSafety: 'safe', sourceOrder: 0,
    designRole: 'ad-or-void', designRoleConfidence: 0.9, dominanceRank: 0, group: null,
    governingHeading: null, componentType: 'unknown', componentConfidence: 0,
    textProfile: { readingLength: 0, kind: 'none', dir: 'auto', longestToken: 0, truncated: false },
    provenance: {},
    style: style(),
    ...over,
  };
}
function perception(clusters: Cluster[]): Perception {
  return {
    builtInMs: 1, nodeCount: clusters.length, cssVars: [], cssVarMap: {},
    site: { host: 'example.com', title: 'T' },
    canvas: { bg: 'rgb(255,255,255)', color: 'rgb(0,0,0)', fontFamily: 'sans-serif', fontSize: '16px' },
    clusters, skeleton: { regions: [], contentMaxWidthPx: 800, columnCount: 2 },
    handles: new Set(clusters.map((c) => c.handle)), opaqueWrappers: new Set<string>(),
    scrollables: [], viewport: { w: 1280, h: 800 }, shadowRoots: [],
    reflowOpportunity: [],
    outline: [],
    colorModel: { palette: [], relationships: [], saturationRange: [0, 0], lightnessRange: [0, 0], geometry: { radii: [], borderWidths: [], hasShadow: false, shadowSpread: 0, spacingRhythm: 0 } },
    density: { rhythmBaseline: 0, alignmentEdges: [], whitespaceGini: 0, regions: [], pageDensityClass: 'comfortable', rhythmVariance: 0, rhythmConsistent: true, modalPadding: '0px', paddingOutliers: [] },
    composition: { dominant: [], columnCount: 2, hasTopNav: false, hasRightRail: false, hasLeftRail: false, groupCount: 0, summary: '' },
  };
}

// ── Guard laws: validateOps refuses forbidden + non-empty + risky-no-consent ──

function testGuardLaws() {
  // remove on a near-empty, safe, short cluster → accepted.
  const empty = cluster({ handle: 'c1', role: 'complementary', rect: { x: 0, y: 0, w: 300, h: 80, vx: 0, vy: 0, aboveFold: true }, emptinessScore: 0.9 });
  const main = cluster({ handle: 'c2', role: 'main', rect: { x: 0, y: 0, w: 800, h: 600, vx: 0, vy: 0, aboveFold: true }, emptinessScore: 0.1, moveSafety: 'forbidden' });
  const tall = cluster({ handle: 'c3', role: 'complementary', rect: { x: 0, y: 0, w: 300, h: 500, vx: 0, vy: 0, aboveFold: true }, emptinessScore: 0.9 });
  const form = cluster({ handle: 'c4', role: 'form', tag: 'form', rect: { x: 0, y: 0, w: 300, h: 80, vx: 0, vy: 0, aboveFold: true }, emptinessScore: 0.9, moveSafety: 'risky' });
  const p = perception([empty, main, tall, form]);

  const ops: DesignOp[] = [
    { kind: 'remove', target: 'c1' },          // near-empty → accepted
    { kind: 'remove', target: 'c2' },          // main → refused (primary)
    { kind: 'remove', target: 'c3' },          // tall → refused (tall-content)
    { kind: 'move', target: 'c2', to: 'c1' },  // forbidden → refused
    { kind: 'move', target: 'c4', to: 'c1' },  // risky, no consent → refused
    { kind: 'move', target: 'c4', to: 'c1', consent: true }, // risky + consent → accepted
    { kind: 'wrap', target: 'c9' },            // no such handle → refused
  ];
  const r = validateOps(ops, p);
  const acc = r.ops.map((o) => `${o.kind}:${o.target}`).sort();
  // Accepted: remove:c1 (near-empty), move:c4 (risky+consent). wrap:c9 refused (no handle).
  assert.deepEqual(acc, ['move:c4', 'remove:c1'].sort(), 'accepted ops');
  assert.ok(!r.ops.some((o) => o.kind === 'wrap' && o.target === 'c9'), 'no-such-handle wrap refused');
  assert.ok(r.refused.some((s) => s.startsWith('remove(c2:primary')), 'main remove refused');
  assert.ok(r.refused.some((s) => s.startsWith('remove(c3:tall')), 'tall remove refused');
  assert.ok(r.refused.some((s) => s.startsWith('move(c2:forbidden')), 'forbidden move refused');
  assert.ok(r.refused.some((s) => s.startsWith('move(c4:risky-no-consent')), 'risky no-consent refused');
  assert.ok(r.refused.some((s) => s.startsWith('wrap(c9:no-such-handle')), 'no-such-handle wrap refused');
  // The consent move IS accepted (risky + consent).
  assert.ok(r.ops.some((o) => o.kind === 'move' && o.target === 'c4' && o.consent === true), 'risky + consent accepted');

  // remove on a content-rich cluster → refused (not-empty), even if otherwise safe.
  const rich = cluster({ handle: 'c5', role: 'complementary', rect: { x: 0, y: 0, w: 300, h: 80, vx: 0, vy: 0, aboveFold: true }, emptinessScore: 0.2, samples: ['a long piece of real text content here'] });
  const r2 = validateOps([{ kind: 'remove', target: 'c5' }], perception([rich]));
  assert.ok(r2.refused.some((s) => s.includes('not-empty')), 'non-empty remove refused');
  assert.equal(r2.ops.length, 0, 'non-empty remove not accepted');

  console.log('guard-laws OK — remove/move/wrap refusals hold (primary, tall, forbidden, risky-no-consent, no-such-handle, not-empty)');
}

// ── Undo inverse: a fake DOM tree + replay restores the original structure ──

interface FakeNode { tag: string; handle?: string; children: FakeNode[]; parent: FakeNode | null; attrs: Record<string, string>; }
function fakeNode(tag: string, handle?: string): FakeNode { return { tag, handle, children: [], parent: null, attrs: {} }; }
function fakeDom(root: FakeNode): DomAdapter {
  const byHandle = new Map<string, FakeNode>();
  function index(n: FakeNode) { if (n.handle) byHandle.set(n.handle, n); n.children.forEach(index); }
  index(root);
  return {
    resolve: (h) => (byHandle.get(h) as unknown as HTMLElement) ?? null,
    parent: (n) => (n as unknown as FakeNode).parent as unknown as Node,
    nextSibling: (n) => { const fn = n as unknown as FakeNode; if (!fn.parent) return null; const i = fn.parent.children.indexOf(fn); const next = fn.parent.children[i + 1]; return (next ?? null) as unknown as Node | null; },
    insertBefore: (parent, node, ref) => { const fp = parent as unknown as FakeNode; const fn = node as unknown as FakeNode; const oldP = fn.parent; if (oldP) { const i = oldP.children.indexOf(fn); if (i >= 0) oldP.children.splice(i, 1); } fn.parent = fp; const idx = ref ? fp.children.indexOf(ref as unknown as FakeNode) : fp.children.length; fp.children.splice(idx, 0, fn); },
    appendChild: (parent, node) => { const fp = parent as unknown as FakeNode; const fn = node as unknown as FakeNode; if (fn.parent) { const i = fn.parent.children.indexOf(fn); if (i >= 0) fn.parent.children.splice(i, 1); } fn.parent = fp; fp.children.push(fn); },
    removeChild: (parent, node) => { const fp = parent as unknown as FakeNode; const fn = node as unknown as FakeNode; fn.parent = null; const i = fp.children.indexOf(fn); if (i >= 0) fp.children.splice(i, 1); },
    createElement: (tag) => fakeNode(tag) as unknown as Node,
    resolveDestination: (to) => (to ? (byHandle.get(to) as unknown as HTMLElement) ?? null : null),
    handleOf: (node) => (node as unknown as FakeNode | null)?.handle ?? null,
  };
}
/** Serialise the fake tree to a comparable structural string. */
function struct(n: FakeNode): string {
  const h = n.handle ? `#${n.handle}` : (n.attrs['data-rv-wrap'] ? '+wrap' : '');
  return n.children.length ? `${n.tag}${h}[${n.children.map(struct).join(',')}]` : `${n.tag}${h}`;
}

function testUndoInverse() {
  // Build: body > [main#c2, aside#c1(empty), footer#c3] — body gets a handle so
  // the handle-based undo (B2) can resolve it as the reattach parent.
  const body = fakeNode('body', 'body');
  const c1 = fakeNode('aside', 'c1'); const c2 = fakeNode('main', 'c2'); const c3 = fakeNode('footer', 'c3');
  body.children = [c2, c1, c3]; [c2, c1, c3].forEach((c) => c.parent = body);
  const before = struct(body);
  const dom = fakeDom(body);

  const log = new TransactionLog();
  // Op 1: remove c1 (empty aside). Op 2: reorder c3 to before c2 (wrap not used for clarity).
  // remove c1: parent=body, next=c3. B2: the inverse stores handles, not Node refs.
  log.record({ op: { kind: 'remove', target: 'c1' }, target: 'c1', inverse: { kind: 'reattach', node: c1 as unknown as Node, parentHandle: 'body', nextSiblingHandle: 'c3' } });
  // Actually remove c1 from the fake to simulate executeOps:
  dom.removeChild(body as unknown as Node, c1 as unknown as Node);
  assert.equal(struct(body), 'body#body[main#c2,footer#c3]', 'c1 removed');

  // undoAll replays backwards: reattach c1 before c3 (its original nextSibling).
  log.undoAll(dom);
  assert.equal(struct(body), before, 'undo restored original structure (remove)');
  console.log('undo-inverse OK — remove undone (reattach restores original slot)');

  // Idempotency: a remove of an already-gone node is a no-op (executeOps handles this
  // live; here we just assert validateOps on a perception without the handle refuses
  // as no-such-handle, and a second remove of a present handle is the same op).
  const p2 = perception([c2, c3].map((n) => cluster({ handle: n.handle!, role: n.tag === 'main' ? 'main' : 'contentinfo', rect: { x: 0, y: 0, w: 300, h: 80, vx: 0, vy: 0, aboveFold: true }, emptinessScore: 0.9 })));
  // c1 is gone from the perception → 'remove c1' is no-such-handle.
  const r = validateOps([{ kind: 'remove', target: 'c1' }], p2);
  assert.ok(r.refused.some((s) => s.includes('no-such-handle')), 're-derive remove of gone node = refused (no-op)');
  console.log('idempotency OK — re-derive of a removed handle is a no-op (refused as no-such-handle)');
}

// ── Emptiness floor boundary ──────────────────────────────────────────────

function testEmptinessFloor() {
  assert.equal(REMOVE_EMPTINESS_FLOOR, 0.6, 'floor is 0.6');
  // A cluster at exactly the floor is accepted; below refused (covered in guard-laws).
  const at = cluster({ handle: 'cx', role: 'complementary', rect: { x: 0, y: 0, w: 300, h: 80, vx: 0, vy: 0, aboveFold: true }, emptinessScore: REMOVE_EMPTINESS_FLOOR });
  const r = validateOps([{ kind: 'remove', target: 'cx' }], perception([at]));
  assert.equal(r.ops.length, 1, 'at-floor remove accepted');
  console.log('emptiness-floor OK — boundary accepted at 0.6');
}

// ── Passive-wrapper removal: the dead-margin reclamation case ──────────────

function testPassiveWrapperRemovable() {
  // A passive wrapper (isPassiveWrapper=true) that is near-empty IS removable —
  // collapsing it reclaims the dead-margin band (the remove op's whole purpose).
  // An opaque wrapper (canvas-hider) is still refused.
  const passiveEmpty = cluster({ handle: 'pw', role: null, rect: { x: 0, y: 0, w: 1200, h: 80, vx: 0, vy: 0, aboveFold: true }, emptinessScore: 0.9, layout: layout({ isPassiveWrapper: true }) });
  const opaqueEmpty = cluster({ handle: 'ow', role: null, rect: { x: 0, y: 0, w: 1200, h: 80, vx: 0, vy: 0, aboveFold: true }, emptinessScore: 0.9, layout: layout({ isOpaqueWrapper: true }) });
  const passiveContent = cluster({ handle: 'pc', role: null, rect: { x: 0, y: 0, w: 1200, h: 80, vx: 0, vy: 0, aboveFold: true }, emptinessScore: 0.2, samples: ['real content text here'], layout: layout({ isPassiveWrapper: true }) });
  const r = validateOps([
    { kind: 'remove', target: 'pw' },
    { kind: 'remove', target: 'ow' },
    { kind: 'remove', target: 'pc' },
  ], perception([passiveEmpty, opaqueEmpty, passiveContent]));
  assert.ok(r.ops.some((o) => o.target === 'pw'), 'passive near-empty wrapper IS removable (reclaims dead margins)');
  assert.ok(r.refused.some((s) => s.includes('remove(ow:opaque-wrapper')), 'opaque wrapper refused (canvas-hider)');
  assert.ok(r.refused.some((s) => s.includes('remove(pc:not-empty')), 'passive content-bearing wrapper refused (emptiness floor)');
  console.log('passive-wrapper OK — near-empty passive wrapper removable; opaque + content-bearing refused');
}

// ── Decorative-dead-zone void detector: the Wikipedia gradient case ─────
// The audit found detectVoids only flagged FLAT (variance<10) regions, so a
// colorful gradient dead-zone (high variance, no content) was invisible to it and
// the op-actually-used gate could never fire. The new detector adds a DECORATIVE
// case: large + text-less + image-less + gradient/texture (hasGradient) OR
// edge-sparse. This proves it fires on a Wikipedia-style gradient dead-zone.

/** Build a PixelInput with a smooth horizontal gradient over a rect — high pixel
 *  variance (colorful), near-zero edge density (smooth transitions, no content). */
function gradientCapture(w: number, h: number): PixelInput {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      // Smooth hue + lightness sweep across x — a vivid gradient (high variance),
      // smooth transitions (low edge density), no text/image.
      const t = x / w;
      data[i] = Math.round(255 * t);            // 0 -> 255 (red ramp)
      data[i + 1] = Math.round(180 * (1 - t));  // 180 -> 0 (green inverse)
      data[i + 2] = Math.round(220 * Math.sin(t * Math.PI)); // blue bump in the middle
      data[i + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

function testDecorativeGradientVoid() {
  const W = 1280, H = 800;
  const capture = gradientCapture(W, H);
  // A Wikipedia-style gradient dead-zone: a large cluster covering most of the
  // viewport, NO text, NO image, a gradient background. The OLD detector (variance
  // < 10) would NOT flag it — the gradient has variance ~735 (0..255 × 3 channels).
  // The NEW detector flags it via the hasGradient case (independent of flatness).
  const deadZone: ClusterRect = {
    handle: 'grad',
    rect: { x: 0, y: 0, w: 1200, h: 700 },   // ~94% of the 1280×800 viewport
    text: '', hasImage: false, hasGradient: true,
  };
  const voids = detectVoids(capture, [deadZone]);
  assert.ok(voids.includes('grad'), 'decorative gradient dead-zone IS detected as a void (hasGradient case)');
  // Sanity: a text-bearing cluster over the same gradient is NOT a void.
  const textCluster: ClusterRect = { ...deadZone, handle: 'txt', text: 'real article content here with many words' };
  const voidsWithText = detectVoids(capture, [textCluster]);
  assert.ok(!voidsWithText.includes('txt'), 'a text-bearing cluster is NOT a void');
  // A small gradient badge (under VOID_MIN_AREA or under the viewport fraction) is
  // NOT flagged — avoids false positives on legitimate hero/feature bands.
  const smallGrad: ClusterRect = { ...deadZone, handle: 'small', rect: { x: 0, y: 0, w: 300, h: 100 } };
  const voidsSmall = detectVoids(capture, [smallGrad]);
  assert.ok(!voidsSmall.includes('small'), 'a small gradient band is NOT a void (size floor)');
  console.log('decorative-gradient-void OK — the Wikipedia gradient dead-zone is detected (independent of color flatness); text-bearing + small bands not false-flagged');
}

testGuardLaws();
testUndoInverse();
testEmptinessFloor();
testPassiveWrapperRemovable();
testDecorativeGradientVoid();

// ── Phase-1 invisible-text failure classifier (the 4 classes) ─────────────
// The repair comment promises the bg+text pair "guarantees the pixel-invisible ones
// are readable regardless" — but the guarantee fails in 4 distinct ways. This pure
// check proves each surviving invisible cluster is classified into its ROOT CAUSE:
//   wrong-bg   : pair derived from a surface != the one the text sits on
//   cascade-loss: no pair won for the handle (site rule beat [data-rv-c], or the
//                handle dropped from the live perception — emit is empty)
//   multi-bg   : the cluster rect spans >1 distinct background
//   no-handle  : detected upstream (no [data-rv-c]); survivors here all have handles
function testInvisibleClassifier() {
  const inv = ['c1', 'c2', 'c3', 'c4'];
  // c1: emitted a light bg, but text sits on a dark panel → WRONG-BG.
  // c2: no pair emitted (handle vanished / cascade lost) → CASCADE-LOSS.
  // c3: rect spans two backgrounds → MULTI-BG.
  // c4: emitted bg == live bg, still invisible (residual) → UNKNOWN.
  const emittedBg = new Map<string, string>([['c1', 'rgb(245,245,245)'], ['c3', 'rgb(255,255,255)'], ['c4', 'rgb(20,20,20)']]);
  const liveEffBg = new Map<string, string>([['c1', 'rgb(20,20,20)'], ['c3', 'rgb(255,255,255)'], ['c4', 'rgb(20,20,20)']]);
  const multiBg = new Set<string>(['c3']);
  const { records, byClass } = classifyInvisibleFailures(inv, emittedBg, liveEffBg, multiBg);
  const byHandle = new Map(records.map((r) => [r.handle, r.cls]));
  assert.equal(byHandle.get('c1'), 'wrong-bg', 'c1: emitted light bg but sits on dark → wrong-bg');
  assert.equal(byHandle.get('c2'), 'cascade-loss', 'c2: no pair emitted → cascade-loss');
  assert.equal(byHandle.get('c3'), 'multi-bg', 'c3: spans >1 background → multi-bg (takes priority over wrong-bg)');
  assert.equal(byHandle.get('c4'), 'unknown', 'c4: matching pair still invisible → unknown residual');
  assert.equal(byClass['wrong-bg'], 1);
  assert.equal(byClass['cascade-loss'], 1);
  assert.equal(byClass['multi-bg'], 1);
  assert.equal(byClass['unknown'], 1);
  assert.equal(byClass['no-handle'], 0, 'survivors all have handles — no-handle is detected upstream');
  // Empty input → no records, all-zero byClass.
  const empty = classifyInvisibleFailures([], emittedBg, liveEffBg, multiBg);
  assert.equal(empty.records.length, 0);
  assert.equal(empty.byClass['wrong-bg'], 0);
  console.log('invisible-classifier OK — each survivor classed into its root cause (wrong-bg / cascade-loss / multi-bg / unknown); no-handle is upstream');
}

testInvisibleClassifier();
console.log('ops.test OK — guard laws + undo inverse + emptiness floor + passive-wrapper + decorative-gradient-void + invisible-classifier + idempotency hold');

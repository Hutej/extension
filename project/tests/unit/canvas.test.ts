/**
 * T32 unit layer — S8.4 owned Canvas 2D (plan/28 §3, matrix T32 U/C).
 *
 * The decode boundary (contracts) and the compile boundary are proven here
 * with plain data; the renderer is proven against a duck-typed DOM stub that
 * records every 2D-context write, so draw order, contain/center transforms,
 * backing caps, receipts, document budget accounting, context loss and exact
 * release are all observable without a browser.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeCanvasScene,
  decodeOperationBatch,
  LIMITS,
  type CanvasScene,
} from '../../src/contracts.ts';
import { compileInsertUi } from '../../src/runtime/compile.ts';
import { createContentCreator, type ContentCreator } from '../../src/runtime/content.ts';

const SCENE: CanvasScene = {
  sceneVersion: 1,
  viewBoxWidth: 200,
  viewBoxHeight: 100,
  draw: [
    { kind: 'rect', x: 10, y: 10, width: 80, height: 40, fill: 'crimson', stroke: 'black', lineWidth: 2 },
    { kind: 'circle', x: 150, y: 50, radius: 20, fill: 'rgb(0,0,255)' },
    { kind: 'polyline', points: [[10, 90], [60, 70], [110, 90]], closed: true, stroke: 'green', lineWidth: 2, fill: 'yellow' },
    { kind: 'text', x: 100, y: 20, text: 'Hello', fill: 'black', fontSize: 16, fontFamily: 'Arial', align: 'center' },
  ],
  accessibleDescription: 'A crimson test rectangle with a circle',
  fallbackText: 'crimson rectangle and blue circle',
};

// ── decode boundary ───────────────────────────────────────────────────────

test('T32: a complete scene with all four record kinds round-trips the decode', () => {
  const r = decodeCanvasScene(SCENE);
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
  assert.equal((r as { value: CanvasScene }).value.draw.length, 4);
  assert.deepEqual((r as { value: CanvasScene }).value.draw[3], SCENE.draw[3]);
});

test('T32: the scene decode refuses unsafe/unbounded scene data (I18)', () => {
  const refusals: Array<[string, unknown]> = [
    ['gradient fill', { ...SCENE, draw: [{ kind: 'rect', x: 0, y: 0, width: 1, height: 1, fill: 'linear-gradient(red, blue)' }] }],
    ['function fill', { ...SCENE, draw: [{ kind: 'rect', x: 0, y: 0, width: 1, height: 1, fill: 'var(--x)' }] }],
    ['url fill', { ...SCENE, draw: [{ kind: 'rect', x: 0, y: 0, width: 1, height: 1, fill: 'url(https://x.test/a.png)' }] }],
    ['viewBox over extent', { ...SCENE, viewBoxWidth: LIMITS.maxViewBoxExtent + 1 }],
    ['viewBox zero', { ...SCENE, viewBoxHeight: 0 }],
    ['non-finite coord', { ...SCENE, draw: [{ kind: 'rect', x: Number.NaN, y: 0, width: 1, height: 1 }] }],
    ['negative width', { ...SCENE, draw: [{ kind: 'rect', x: 0, y: 0, width: -1, height: 1 }] }],
    ['script font family', { ...SCENE, draw: [{ kind: 'text', x: 0, y: 0, text: 'a', fill: 'black', fontSize: 16, fontFamily: 'Arial; alert(1)', align: 'center' }] }],
    ['bad align', { ...SCENE, draw: [{ kind: 'text', x: 0, y: 0, text: 'a', fill: 'black', fontSize: 16, fontFamily: 'Arial', align: 'justify' }] }],
    ['over draw cap', { ...SCENE, draw: Array(LIMITS.maxCanvasDrawRecords + 1).fill({ kind: 'rect', x: 0, y: 0, width: 1, height: 1 }) }],
    ['over point cap', { ...SCENE, draw: [{ kind: 'polyline', points: Array(LIMITS.maxCanvasPolylinePoints + 1).fill([1, 2]), closed: true, stroke: 'green' }] }],
    ['over text cap', { ...SCENE, draw: [{ kind: 'text', x: 0, y: 0, text: 'a'.repeat(LIMITS.maxCanvasTextBytes + 1), fill: 'black', fontSize: 16, fontFamily: 'Arial', align: 'center' }] }],
    ['over description cap', { ...SCENE, accessibleDescription: 'a'.repeat(LIMITS.maxCanvasDescriptionChars + 1) }],
    ['sceneVersion 2', { ...SCENE, sceneVersion: 2 }],
  ];
  for (const [name, bad] of refusals) {
    const r = decodeCanvasScene(bad);
    assert.equal(r.ok, false, `${name} must refuse`);
  }
});

test('T32: the scene record rides only the scene node, and a scene node always carries one', () => {
  const base = { kind: 'insertUI', target: { targetRef: 'd0' }, position: 'after' as const };
  const withScene = decodeOperationBatch([{
    ...base,
    nodes: [{ localId: 'sc1', tag: 'scene', scene: SCENE }],
  }]);
  assert.equal(withScene.ok, true, JSON.stringify(withScene).slice(0, 300));

  const orphan = decodeOperationBatch([{ ...base, nodes: [{ localId: 'sc1', tag: 'scene' }] }]);
  assert.equal(orphan.ok, false, 'scene node without a record refuses');

  const misplaced = decodeOperationBatch([{ ...base, nodes: [{ localId: 'd1', tag: 'div', scene: SCENE }] }]);
  assert.equal(misplaced.ok, false, 'a scene record on a div refuses');
});

// ── compile boundary ──────────────────────────────────────────────────────

test('T32: compile passes the validated scene through; scene text/children are policy refusals', () => {
  const ok = compileInsertUi({ kind: 'insertUI', target: { targetRef: 'd0' }, position: 'last-child', nodes: [{ localId: 'sc1', tag: 'scene', scene: SCENE }] });
  assert.equal(ok.ok, true, JSON.stringify(ok).slice(0, 300));
  if (ok.ok) {
    const tree = ok.plan.trees[0];
    assert.deepEqual(tree.scene, SCENE, 'the complete scene rides the plan');
    assert.equal(tree.localId, 'sc1');
  }

  const texted = compileInsertUi({ kind: 'insertUI', target: { targetRef: 'd0' }, position: 'last-child', nodes: [{ localId: 'sc1', tag: 'scene', scene: SCENE, text: 'injected' }] });
  assert.equal(texted.ok, false, 'scene text refuses (the renderer owns the interior)');

  const childed = compileInsertUi({ kind: 'insertUI', target: { targetRef: 'd0' }, position: 'last-child', nodes: [{ localId: 'sc1', tag: 'scene', scene: SCENE, children: [{ tag: 'p' }] }] });
  assert.equal(childed.ok, false, 'scene children refuse');
});

// ── renderer (duck-typed DOM stub) ───────────────────────────────────────

type CtxLog = Array<{ op: string; args: unknown[] }>;

const makeCtx = (log: CtxLog) => {
  const self: Record<string, unknown> = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: '',
    setTransform: (...a: unknown[]) => log.push({ op: 'setTransform', args: a }),
    clearRect: (...a: unknown[]) => log.push({ op: 'clearRect', args: a }),
    fillRect: (...a: unknown[]) => log.push({ op: 'fillRect', args: a }),
    strokeRect: (...a: unknown[]) => log.push({ op: 'strokeRect', args: a }),
    beginPath: () => log.push({ op: 'beginPath', args: [] }),
    arc: (...a: unknown[]) => log.push({ op: 'arc', args: a }),
    fill: () => log.push({ op: 'fill', args: [] }),
    stroke: () => log.push({ op: 'stroke', args: [] }),
    moveTo: (...a: unknown[]) => log.push({ op: 'moveTo', args: a }),
    lineTo: (...a: unknown[]) => log.push({ op: 'lineTo', args: a }),
    closePath: () => log.push({ op: 'closePath', args: [] }),
    fillText: (...a: unknown[]) => log.push({ op: 'fillText', args: a }),
  };
  return self;
};

interface FakeElement {
  tag: string;
  attributes: Map<string, string>;
  children: FakeElement[];
  textContent: string;
  hidden: boolean;
  clientWidth: number;
  clientHeight: number;
  width: number;
  height: number;
  style: Record<string, string>;
  events: Map<string, Array<() => void>>;
  ctx: Record<string, unknown> | null;
  removed: boolean;
  appendChild(child: FakeElement): FakeElement;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  removeAttribute(k: string): void;
  hasAttribute(k: string): boolean;
  addEventListener(k: string, fn: () => void): void;
  remove(): void;
}

const fakeElement = (tag: string): FakeElement => {
  const el: FakeElement = {
    tag,
    attributes: new Map(),
    children: [],
    textContent: '',
    hidden: false,
    clientWidth: 0,
    clientHeight: 0,
    width: 0,
    height: 0,
    style: {},
    events: new Map(),
    ctx: null,
    removed: false,
    appendChild(child) {
      el.children.push(child);
      return child;
    },
    setAttribute(k, v) {
      el.attributes.set(k, v);
    },
    getAttribute(k) {
      return el.attributes.get(k) ?? null;
    },
    removeAttribute(k) {
      el.attributes.delete(k);
    },
    hasAttribute(k) {
      return el.attributes.has(k);
    },
    addEventListener(k, fn) {
      const list = el.events.get(k) ?? [];
      list.push(fn);
      el.events.set(k, list);
    },
    remove() {
      el.removed = true;
    },
  };
  return el;
};

interface Harness {
  creator: ContentCreator;
  ctxLogs: CtxLog[]; // one per canvas, creation order
  canvases: FakeElement[];
  hosts: FakeElement[];
  roCallbacks: Array<() => void>;
  flush(): Promise<void>;
  doc: {
    createElement(tag: string): FakeElement;
    createTextNode(t: string): FakeElement;
    defaultView: { devicePixelRatio: number };
  };
}

const makeHarness = (dpr = 1, contextAvailable = true): Harness => {
  const ctxLogs: CtxLog[] = [];
  const canvases: FakeElement[] = [];
  const hosts: FakeElement[] = [];
  const roCallbacks: Array<() => void> = [];
  const doc = {
    createElement(tag: string): FakeElement {
      const el = fakeElement(tag);
      if (tag === 'canvas') {
        const log: CtxLog = [];
        ctxLogs.push(log);
        const ctx = contextAvailable ? makeCtx(log) : null;
        el.ctx = ctx;
        (el as unknown as { getContext: (kind: string) => unknown }).getContext = (kind: string) => (kind === '2d' ? ctx : null);
        canvases.push(el);
      }
      if (tag === 'scene') hosts.push(el);
      return el;
    },
    createTextNode(t: string): FakeElement {
      const el = fakeElement('#text');
      el.textContent = t;
      return el;
    },
    defaultView: { devicePixelRatio: dpr },
  };
  const roCallbacksOuter = roCallbacks;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    constructor(cb: () => void) {
      roCallbacksOuter.push(cb);
    }
    observe(): void {}
    disconnect(): void {}
  };
  const creator = createContentCreator(doc as unknown as Document);
  return {
    creator,
    ctxLogs,
    canvases,
    hosts,
    roCallbacks,
    flush: async () => {
      await new Promise<void>((r) => setTimeout(r, 0));
      await new Promise<void>((r) => setTimeout(r, 0));
    },
    doc,
  };
};

const sceneOp = (scene: CanvasScene, localId = 'sc1') =>
  compileInsertUi({ kind: 'insertUI', target: { targetRef: 'd0' }, position: 'last-child', nodes: [{ localId, tag: 'scene', scene }] });

const buildScene = (h: Harness, scene: CanvasScene = SCENE): FakeElement => {
  const plan = sceneOp(scene);
  assert.ok(plan.ok, JSON.stringify(plan).slice(0, 200));
  const built = h.creator.build((plan as { ok: true; plan: Parameters<ContentCreator['build']>[0] }).plan);
  assert.ok(built.ok, JSON.stringify(built).slice(0, 300));
  return built.roots[0] as unknown as FakeElement;
};

const flush = async (): Promise<void> => {
  await new Promise<void>((r) => setTimeout(r, 0));
  await new Promise<void>((r) => setTimeout(r, 0));
};

test('T32: the renderer creates an owned canvas + accessible fallback, never a borrowed page canvas', async () => {
  const h = makeHarness(1, true);
  const host = buildScene(h);
  assert.equal(host.tag, 'scene');
  assert.equal(host.style.display, 'block', 'the creator owns a measurable block layout');
  const canvas = host.children[0];
  const fallback = host.children[1];
  assert.equal(canvas.tag, 'canvas', 'the renderer creates its OWN canvas');
  assert.equal(canvas.getAttribute('data-rv2-canvas'), 'owned');
  assert.equal(canvas.getAttribute('role'), 'img');
  assert.equal(canvas.getAttribute('aria-label'), SCENE.accessibleDescription, 'the scene description is the canvas a11y name');
  assert.equal(fallback.getAttribute('data-rv2-canvas-fallback'), '');
  assert.equal(fallback.hidden, true, 'the fallback is hidden while the canvas owns the paint');
  await flush();
  assert.equal(host.getAttribute('data-rv2-canvas-state'), 'canvas-owned');
  void h;
});

test('T32: known draw output — records paint in order on the own context with contain+center transform', async () => {
  const h = makeHarness(1, true);
  const host = buildScene(h);
  host.clientWidth = 400;
  host.clientHeight = 200;
  await h.roCallbacks[0](); // the observer callback = the scheduled redraw
  await flush();
  const canvas = host.children[0];
  assert.equal(canvas.width, 400, 'backing = box × backingScale(1 at dpr 1)');
  assert.equal(canvas.height, 200);
  assert.equal(host.getAttribute('data-rv2-canvas-scale'), '1.000');
  assert.equal(host.getAttribute('data-rv2-canvas-lowered'), null, 'full requested resolution is not lowered');
  const log = h.ctxLogs[0];
  assert.deepEqual(log[0], { op: 'setTransform', args: [1, 0, 0, 1, 0, 0] }, 'transform reset before paint');
  assert.deepEqual(log[1], { op: 'clearRect', args: [0, 0, 400, 200] });
  const firstFill = log.find((l) => l.op === 'fillRect');
  assert.ok(firstFill, 'the rect record painted');
  assert.equal(firstFill!.args[0], 10, 'logical coordinates, not page measurements');
  // contain+center: viewBox 200×100 in 400×200 → contain 2, offsets 0; the
  // rect's logical (10,10) is device (20,20) — the uniform scale rides the
  // second setTransform.
  const transform = log[2];
  assert.deepEqual(transform.args, [2, 0, 0, 2, 0, 0], 'uniform scale 2, centered');
  const fills = log.filter((l) => l.op === 'fillRect' || l.op === 'fill' || l.op === 'fillText');
  assert.equal(fills.length, 4, 'rect + circle + closed-polyline fill + text painted');
  const fillText = log.find((l) => l.op === 'fillText');
  assert.deepEqual(fillText!.args, ['Hello', 100, 20]);
  void host;
});

test('T32: the backing cap lowers resolution with an explicit receipt, never silently', async () => {
  const h = makeHarness(2, true); // requested 2 at dpr 2
  const host = buildScene(h);
  host.clientWidth = 1000;
  host.clientHeight = 1000; // 1e6 box pixels × 2 = 2e6 backing > 1e6 cap
  await h.roCallbacks[0]();
  await flush();
  const canvas = host.children[0];
  assert.equal(host.getAttribute('data-rv2-canvas-lowered'), '1', 'the lowering is receipted');
  assert.equal(host.getAttribute('data-rv2-canvas-scale'), '1.000', 'scale lowered to fit the 1M-pixel cap');
  assert.equal(canvas.width, 1000, 'backing = 1000×1000×1 = exactly the cap');
  void host;
});

test('T32: the per-document pixel budget is exact — release frees, refusal shows fallback (I21/I26)', async () => {
  const h = makeHarness(1, true);
  const box = (): { clientWidth: number; clientHeight: number } => ({ clientWidth: 1000, clientHeight: 1000 });
  const host1 = buildScene(h);
  Object.assign(host1, box());
  const host2 = buildScene(h);
  Object.assign(host2, box());
  await h.flush();
  await flush();
  // Two 1000×1000 canvases = exactly the 2M-pixel document budget.
  assert.equal(host2.getAttribute('data-rv2-canvas-state'), 'canvas-owned');
  const host3 = buildScene(h);
  Object.assign(host3, box());
  await h.flush();
  await flush();
  assert.equal(host3.getAttribute('data-rv2-canvas-state'), 'canvas-unavailable', 'the third canvas is refused with the honest fallback');
  assert.equal(host3.children[0].width, 0, 'nothing was allocated for the refused canvas');
  assert.equal(host3.children[1].hidden, false, 'the fallback shows');

  // Exact release: removing host1 frees exactly 1M pixels.
  h.creator.remove([host1 as unknown as Element]);
  const host4 = buildScene(h);
  Object.assign(host4, box());
  await h.flush();
  await flush();
  assert.equal(host4.getAttribute('data-rv2-canvas-state'), 'canvas-owned', 'the freed budget is reusable');
});

test('T32: zero-size/hidden boxes wait — no zero-size allocation, no redraw loop', async () => {
  const h = makeHarness(1, true);
  const host = buildScene(h);
  await flush();
  assert.equal(host.children[0].width, 0, 'nothing allocated while unmeasured');
  // Still zero after more observer callbacks.
  await h.roCallbacks[0]();
  await flush();
  assert.equal(host.children[0].width, 0);
  // The box appears → the next observer callback paints once.
  host.clientWidth = 400;
  host.clientHeight = 200;
  await h.roCallbacks[0]();
  await flush();
  assert.equal(host.children[0].width, 400);
  void host;
});

test('T32: context loss pauses; restoration redraws saved data once', async () => {
  const h = makeHarness(1, true);
  const host = buildScene(h);
  host.clientWidth = 400;
  host.clientHeight = 200;
  await h.flush();
  const canvas = host.children[0];
  assert.equal(canvas.width, 400);
  const lost = canvas.events.get('contextlost') ?? [];
  const restored = canvas.events.get('contextrestored') ?? [];
  assert.ok(lost.length === 1 && restored.length === 1, 'the canvas listens for context loss');
  lost[0]();
  await flush();
  assert.equal(host.getAttribute('data-rv2-canvas-state'), 'canvas-unavailable', 'context loss pauses with the fallback');
  assert.equal(host.getAttribute('data-rv2-canvas-scale'), null, 'the resolution receipt is gone while lost');
  restored[0]();
  await flush();
  assert.equal(host.getAttribute('data-rv2-canvas-state'), 'canvas-owned', 'restoration redraws saved scene data');
  assert.ok(host.getAttribute('data-rv2-canvas-scale') !== null, 'the receipt returns with the redraw');
  void host;
});

test('T32: no context is possible → fallback with canvas-unavailable, never canvas success (I26)', async () => {
  const h = makeHarness(1, false);
  const host = buildScene(h);
  await flush();
  assert.equal(host.getAttribute('data-rv2-canvas-state'), 'canvas-unavailable');
  assert.equal(host.children[0].width, 0, 'the own canvas stays unallocated');
  assert.equal(host.children[1].hidden, false, 'the accessible fallback is the visible content');
  void host;
});

test('T32: release disconnects the observer and frees the exact budget', async () => {
  const h = makeHarness(1, true);
  const host = buildScene(h);
  host.clientWidth = 400;
  host.clientHeight = 200;
  await h.flush();
  const canvas = host.children[0];
  assert.equal(canvas.width, 400);
  h.creator.remove([host as unknown as Element]);
  assert.equal(host.removed, true, 'the owned host is removed exactly');
  // A post-release observer callback is a no-op (disconnected): no backing
  // write, no budget change.
  const widthBefore = canvas.width;
  await h.roCallbacks[0]();
  await flush();
  assert.equal(canvas.width, widthBefore, 'the disconnected observer never paints again');
  void host;
});

test('T32: unrelated native canvases are never touched by the renderer', async () => {
  const h = makeHarness(1, true);
  const host = buildScene(h);
  host.clientWidth = 400;
  host.clientHeight = 200;
  await h.flush();
  // The page's own canvas is an element the creator never built: removing an
  // unrelated node changes no canvas state or budget.
  const native = fakeElement('canvas');
  native.width = 64;
  native.height = 32;
  h.creator.remove([native as unknown as Element]);
  assert.equal(host.getAttribute('data-rv2-canvas-state'), 'canvas-owned');
  assert.equal(native.removed, true, 'removal removes exactly what it is given — the release path is the caller\'s owned set');
  void host;
});

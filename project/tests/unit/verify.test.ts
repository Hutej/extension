/**
 * verify.test — S4.3 mandatory structured verification with the REAL
 * createVerifier over a stub DOM + fake computed-style store (T13/T22/T30
 * at the unit boundary: missing/throwing verification never passes,
 * already-satisfied effects, authorized hides vs ancestor loss, contrast,
 * overflow, combined revision samples).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseColor } from '../../src/shared/color.ts';
import { createVerifier, type VerifyPlan, type VerifierDeps } from '../../src/runtime/verify.ts';

// ── DOM stub (same minimal seam as transaction.test) ─────────────────────

interface StubNode {
  contains(other: StubNode): boolean;
  nodeType: number;
  tagName?: string;
  nodeValue?: string;
  parentNode: StubNode | null;
  childNodes: StubNode[];
  children: StubNode[];
  attrs: Map<string, string>;
  disabled?: boolean;
  paused?: boolean;
  rect: { width: number; height: number } | null;
  scroll?: { scrollWidth: number; clientWidth: number };
  documentElement?: StubNode;
  getRootNode(): StubNode;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  get isConnected(): boolean;
  appendChild(child: StubNode): StubNode;
  remove(): void;
  removeChild(child: StubNode): StubNode;
  matches(selector: string): boolean;
  querySelectorAll(selector: string): StubNode[];
  querySelector(selector: string): StubNode | null;
  readonly textContent: string;
}

const FOCUS_TAGS = new Set(['button', 'input', 'select', 'textarea']);

function makeNode(nodeType: number, tagOrValue: string): StubNode {
  const node: StubNode = {
    nodeType,
    ...(nodeType === 1 ? { tagName: tagOrValue.toUpperCase() } : { nodeValue: tagOrValue }),
    parentNode: null,
    childNodes: [],
    children: [],
    attrs: new Map<string, string>(),
    rect: { width: 100, height: 20 },
    getRootNode(): StubNode {
      let p: StubNode = node;
      while (p.parentNode) p = p.parentNode;
      return p;
    },
    getAttribute(name) {
      return node.attrs.get(name) ?? null;
    },
    setAttribute(name, value) {
      node.attrs.set(name, value);
    },
    removeAttribute(name) {
      node.attrs.delete(name);
    },
    get isConnected(): boolean {
      let p: StubNode = node;
      while (p.parentNode) p = p.parentNode;
      return p.nodeType === 9;
    },
    appendChild(child) {
      child.parentNode = node;
      node.childNodes.push(child);
      if (child.nodeType === 1) node.children.push(child);
      return child;
    },
    remove() {
      const parent = node.parentNode;
      if (!parent) return;
      const i = parent.childNodes.indexOf(node);
      if (i !== -1) parent.childNodes.splice(i, 1);
      const j = parent.children.indexOf(node);
      if (j !== -1) parent.children.splice(j, 1);
      node.parentNode = null;
    },
    removeChild(child) {
      const i = node.childNodes.indexOf(child);
      if (i !== -1) node.childNodes.splice(i, 1);
      const j = node.children.indexOf(child);
      if (j !== -1) node.children.splice(j, 1);
      child.parentNode = null;
      return child;
    },
    contains(other: StubNode): boolean {
      let p: StubNode | null = other;
      while (p) {
        if (p === node) return true;
        p = p.parentNode;
      }
      return false;
    },
    get textContent(): string {
      return node.childNodes.filter((c) => c.nodeType === 3).map((c) => c.nodeValue ?? '').join('');
    },
    querySelectorAll(selector: string): StubNode[] {
      const m = selector.match(/^\[([a-z0-9-]+)\]$/);
      if (!m) return [];
      const out: StubNode[] = [];
      const walk = (n: StubNode): void => {
        for (const c of n.children) {
          if (c.attrs.has(m![1])) out.push(c);
          walk(c);
        }
      };
      walk(node);
      return out;
    },
    querySelector(selector: string): StubNode | null {
      return node.querySelectorAll(selector)[0] ?? null;
    },
    matches(selector: string): boolean {
      // Minimal matcher over the focusable selector's alternatives.
      for (const alt of selector.split(',')) {
        const s = alt.trim();
        if (s === '[tabindex]') { if (node.attrs.has('tabindex')) return true; continue; }
        if (s === 'a[href]') { if (node.tagName === 'A' && node.attrs.has('href')) return true; continue; }
        if (FOCUS_TAGS.has(s)) { if (node.tagName?.toLowerCase() === s) return true; continue; }
      }
      return false;
    },
  };
  return node;
}

const el = (tag: string): StubNode => makeNode(1, tag);
const text = (v: string): StubNode => makeNode(3, v);

// ── fake computed-style store ────────────────────────────────────────────

class FakeStyles {
  private map = new Map<StubNode, Map<string, string>>();
  /** When set, the next getComputedStyle for this element returns null once. */
  private failOnce = new Set<StubNode>();
  private failArmed = new Set<StubNode>();

  set(target: StubNode, prop: string, value: string): void {
    const m = this.map.get(target) ?? new Map<string, string>();
    m.set(prop, value);
    this.map.set(target, m);
  }
  failNextComputedOnce(target: StubNode): void {
    this.failArmed.add(target);
  }
  computedOf = (target: StubNode): { getPropertyValue(p: string): string } | null => {
    if (this.failArmed.has(target)) {
      this.failArmed.delete(target);
      this.failOnce.add(target);
      return null;
    }
    if (this.failOnce.has(target)) {
      this.failOnce.delete(target);
    }
    const m = this.map.get(target);
    return {
      getPropertyValue: (p: string) => {
        const v = m?.get(p);
        if (v !== undefined) return v;
        switch (p) {
          case 'display': return 'block';
          case 'visibility': return 'visible';
          case 'color': return 'rgb(0, 0, 0)';
          case 'background-color': return 'rgba(0, 0, 0, 0)';
          case 'background-image': return 'none';
          case 'font-size': return '16px';
          case 'font-weight': return '400';
          default: return '';
        }
      },
    };
  };
}

function makeWorld() {
  const doc = makeNode(9, '#document');
  const docEl = el('html');
  docEl.scroll = { scrollWidth: 1000, clientWidth: 1000 };
  (doc as unknown as { documentElement: StubNode }).documentElement = docEl;
  doc.appendChild(docEl);
  const styles = new FakeStyles();
  let rechecks = 0;
  const deps: VerifierDeps = {
    doc: doc as unknown as Document,
    now: () => Date.now(),
    computedOf: styles.computedOf as unknown as VerifierDeps['computedOf'],
    canonicalAllOf: (declared: string, shorthand: string, longhands: string[]) => {
      // Test canonicalizer: mini border-shorthand resolution mirroring the
      // browser (width/keyword/color tokens → their longhands).
      const parts = declared.trim().split(/\s+/);
      const NAMED: Record<string, string> = { red: 'rgb(255, 0, 0)', blue: 'rgb(0, 0, 255)', green: 'rgb(0, 128, 0)' };
      const colorPart = parts.find((p) => parseColor(p) !== null || NAMED[p.toLowerCase()] !== undefined);
      const widthPart = parts.find((p) => /^[0-9.]/.test(p));
      const stylePart = parts.find((p) => ['solid', 'dashed', 'dotted', 'double', 'none', 'hidden'].includes(p));
      return longhands.map((lh) => {
        if (lh.endsWith('-width')) return widthPart ?? '';
        if (lh.endsWith('-style')) return stylePart ?? '';
        if (lh.endsWith('-color')) {
          const named = colorPart !== undefined ? NAMED[colorPart.toLowerCase()] : undefined;
          if (named !== undefined) return named;
          const c = parseColor(colorPart ?? '');
          return c ? `rgb(${c[0]}, ${c[1]}, ${c[2]})` : (colorPart ?? '');
        }
        return declared.trim();
      });
    },
    canonicalOf: (declared: string) => {
      const NAMED: Record<string, string> = {
        red: 'rgb(255, 0, 0)', blue: 'rgb(0, 0, 255)', black: 'rgb(0, 0, 0)',
        white: 'rgb(255, 255, 255)', green: 'rgb(0, 128, 0)',
      };
      const c = parseColor(declared);
      if (c) return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
      return NAMED[declared.trim().toLowerCase()] ?? declared.trim();
    },
    rectOf: (target: Element) => (target as unknown as StubNode).rect,
    recheckWait: async () => {
      rechecks += 1;
    },
    isBound: () => true,
    hasRule: () => true,
  };
  const verifier = createVerifier(deps);
  return { doc, docEl, styles, verifier, deps, recheckCount: () => rechecks };
}

const basePlan = (overrides: Partial<VerifyPlan> = {}): VerifyPlan => ({
  batchId: 'b1',
  revisionId: 'r1',
  entryEpoch: 0,
  staged: false,
  styles: [],
  hides: [],
  localSheets: [],
  projections: [],
  bindings: [],
  collapses: [],
  rules: [],
  texts: [],
  inserts: [],
  protectedEls: [],
  sentinels: [],
  combined: [],
  ownedText: [],
  tokenChecks: [],
  unmeasuredDecls: 0,
  ...overrides,
});

// ── T13: effect truth ────────────────────────────────────────────────────

test('T13: an already-satisfied style effect passes — no change alone is never failure', async () => {
  const w = makeWorld();
  const h = el('h1');
  w.doc.appendChild(h);
  w.styles.set(h, 'color', 'rgb(255, 0, 0)'); // already red
  const captured = w.verifier.captureBaseline(basePlan({ protectedEls: [{ key: 'h', el: h as unknown as Element }] }));
  assert.ok(captured.ok);
  const report = await w.verifier.verify(basePlan({
    styles: [{ key: 'effect:style:op0:decl:color', el: h as unknown as Element, property: 'color', value: 'red' }],
    protectedEls: [{ key: 'h', el: h as unknown as Element }],
  }), captured.baseline);
  assert.equal(report.status, 'pass', JSON.stringify(report.issues));
  assert.equal(report.counts.pass >= 1, true);
});

test('T13: a newly bad state after a clean baseline fails with a structured key', async () => {
  const w = makeWorld();
  const h = el('h1');
  w.doc.appendChild(h);
  w.styles.set(h, 'color', 'rgb(0, 0, 255)'); // declared red, computed blue
  const captured = w.verifier.captureBaseline(basePlan());
  assert.ok(captured.ok);
  const report = await w.verifier.verify(basePlan({
    styles: [{ key: 'effect:style:op0:decl:color', el: h as unknown as Element, property: 'color', value: 'red' }],
  }), captured.baseline);
  assert.equal(report.status, 'fail');
  assert.equal(report.issues[0].key, 'effect:style:op0:decl:color');
  assert.match(report.issues[0].detail!, /does not hold/);
});

test('T13: an unknown measurement gets ONE bounded recheck, then passes or rolls the provisional back', async () => {
  const w = makeWorld();
  const h = el('h1');
  w.doc.appendChild(h);
  w.styles.set(h, 'color', 'rgb(255, 0, 0)');
  w.styles.failNextComputedOnce(h); // first measurement unknown
  const captured = w.verifier.captureBaseline(basePlan());
  assert.ok(captured.ok);
  const report = await w.verifier.verify(basePlan({
    styles: [{ key: 'effect:style:op0:decl:color', el: h as unknown as Element, property: 'color', value: 'red' }],
  }), captured.baseline);
  assert.equal(report.status, 'pass', JSON.stringify(report.issues));
  assert.equal(report.coverage.rechecked, true, 'the one recheck ran');
  assert.equal(w.recheckCount(), 1, 'exactly one recheck — never an endless loop');
});

test('T13: an authorized hide satisfies its visibility check and leaves sentinels alone', async () => {
  const w = makeWorld();
  const parent = el('div');
  const target = el('p');
  const sibling = el('span');
  parent.appendChild(target);
  parent.appendChild(sibling);
  w.doc.appendChild(parent);
  const captured = w.verifier.captureBaseline(basePlan({
    protectedEls: [{ key: 't', el: target as unknown as Element }],
    sentinels: [{ key: 'sentinel:t:sibling-prev', el: sibling as unknown as Element }],
  }));
  assert.ok(captured.ok);
  w.styles.set(target, 'display', 'none'); // our hide took effect
  const report = await w.verifier.verify(basePlan({
    styles: [{ key: 'effect:style:op0:decl:display', el: target as unknown as Element, property: 'display', value: 'none' }],
    hides: [target as unknown as Element],
    protectedEls: [{ key: 't', el: target as unknown as Element }],
    sentinels: [{ key: 'sentinel:t:sibling-prev', el: sibling as unknown as Element }],
  }), captured.baseline);
  assert.equal(report.status, 'pass', JSON.stringify(report.issues));
  assert.equal(report.counts.satisfied >= 1, true, 'the hide target is exempt from visibility failure (satisfied, disclosed in counts)');
});

test('T13: an unauthorized hidden sibling/ancestor fails — hides must not leak', async () => {
  const w = makeWorld();
  const parent = el('div');
  const target = el('p');
  const sibling = el('span');
  parent.appendChild(target);
  parent.appendChild(sibling);
  w.doc.appendChild(parent);
  const captured = w.verifier.captureBaseline(basePlan({
    protectedEls: [{ key: 't', el: target as unknown as Element }],
    sentinels: [{ key: 'sentinel:t:sibling-prev', el: sibling as unknown as Element }],
  }));
  assert.ok(captured.ok);
  w.styles.set(sibling, 'display', 'none'); // collateral damage
  const report = await w.verifier.verify(basePlan({
    styles: [{ key: 'effect:style:op0:decl:display', el: target as unknown as Element, property: 'display', value: 'none' }],
    hides: [target as unknown as Element],
    protectedEls: [{ key: 't', el: target as unknown as Element }],
    sentinels: [{ key: 'sentinel:t:sibling-prev', el: sibling as unknown as Element }],
  }), captured.baseline);
  assert.equal(report.status, 'fail');
  assert.ok(report.issues.some((i) => i.key === 'integrity:sentinel:t:sibling-prev:visible' && i.status === 'fail'));
});

test('T22: keyboard reachability loss fails; loss inside an authorized hide is exempt', async () => {
  const make = () => {
    const w = makeWorld();
    const btn = el('button');
    w.doc.appendChild(btn);
    return { w, btn };
  };
  // Baseline focusable, now hidden (not authorized) → fail.
  {
    const { w, btn } = make();
    const captured = w.verifier.captureBaseline(basePlan({ sentinels: [{ key: 's', el: btn as unknown as Element }] }));
    assert.ok(captured.ok);
    w.styles.set(btn, 'display', 'none');
    const report = await w.verifier.verify(basePlan({
      sentinels: [{ key: 's', el: btn as unknown as Element }],
    }), captured.baseline);
    assert.equal(report.status, 'fail');
    assert.ok(report.issues.some((i) => i.key === 'integrity:s:focusable' && i.status === 'fail'));
  }
  // Same loss but inside an authorized hide scope → exempt.
  {
    const { w, btn } = make();
    const captured = w.verifier.captureBaseline(basePlan({ sentinels: [{ key: 's', el: btn as unknown as Element }] }));
    assert.ok(captured.ok);
    w.styles.set(btn, 'display', 'none');
    const report = await w.verifier.verify(basePlan({
      hides: [btn as unknown as Element],
      sentinels: [{ key: 's', el: btn as unknown as Element }],
    }), captured.baseline);
    assert.equal(report.status, 'pass', JSON.stringify(report.issues));
  }
});

// ── T22: contrast and overflow ───────────────────────────────────────────

test('T22: owned text contrast — measurable pass, measurable fail, alpha unknown (never an invented ratio)', async () => {
  const make = (color: string) => {
    const w = makeWorld();
    const host = el('div');
    const p = el('p');
    p.appendChild(text('Owned words'));
    host.appendChild(p);
    w.doc.appendChild(host);
    w.styles.set(host, 'background-color', 'rgb(255, 255, 255)');
    w.styles.set(p, 'color', color);
    return { w, p };
  };
  {
    const { w, p } = make('rgb(0, 0, 0)');
    const report = await w.verifier.verify(basePlan({ ownedText: [{ el: p as unknown as Element, sample: 'Owned words' }] }), { viewportOverflowX: 0, els: new Map() });
    assert.equal(report.status, 'pass', JSON.stringify(report.issues));
  }
  {
    const { w, p } = make('rgb(238, 238, 238)'); // ~1.07:1 on white
    const report = await w.verifier.verify(basePlan({ ownedText: [{ el: p as unknown as Element, sample: 'Owned words' }] }), { viewportOverflowX: 0, els: new Map() });
    assert.equal(report.status, 'fail');
    assert.ok(report.issues.some((i) => i.key.startsWith('contrast:owned') && i.status === 'fail'));
  }
  {
    const { w, p } = make('rgba(0, 0, 0, 0.5)'); // alpha compositing → unknown
    const report = await w.verifier.verify(basePlan({ ownedText: [{ el: p as unknown as Element, sample: 'Owned words' }] }), { viewportOverflowX: 0, els: new Map() });
    assert.equal(report.status, 'unknown');
    assert.ok(report.issues.some((i) => i.key.startsWith('contrast:owned') && i.status === 'unknown'));
  }
});

test('T22: new viewport horizontal overflow beyond the 2px tolerance fails; within tolerance passes', async () => {
  const w = makeWorld();
  const h = el('h1');
  w.doc.appendChild(h);
  const captured = w.verifier.captureBaseline(basePlan({ protectedEls: [{ key: 'h', el: h as unknown as Element }] }));
  assert.ok(captured.ok);
  (w.docEl as unknown as { scrollWidth: number; clientWidth: number }).scrollWidth = 1004;
  (w.docEl as unknown as { scrollWidth: number; clientWidth: number }).clientWidth = 1000; // +4px
  const report = await w.verifier.verify(basePlan({ protectedEls: [{ key: 'h', el: h as unknown as Element }] }), captured.baseline);
  assert.equal(report.status, 'fail');
  assert.ok(report.issues.some((i) => i.key === 'integrity:overflow:viewport' && i.status === 'fail'));

  const w2 = makeWorld();
  const h2 = el('h1');
  w2.doc.appendChild(h2);
  const captured2 = w2.verifier.captureBaseline(basePlan({ protectedEls: [{ key: 'h', el: h2 as unknown as Element }] }));
  assert.ok(captured2.ok);
  (w2.docEl as unknown as { scrollWidth: number; clientWidth: number }).scrollWidth = 1001;
  (w2.docEl as unknown as { scrollWidth: number; clientWidth: number }).clientWidth = 1000; // +1px — noise
  const report2 = await w2.verifier.verify(basePlan({ protectedEls: [{ key: 'h', el: h2 as unknown as Element }] }), captured2.baseline);
  assert.equal(report2.status, 'pass', JSON.stringify(report2.issues));
});

// ── T30: combined revision verification ──────────────────────────────────

test('T30: combined samples verify the whole composition — held effects must keep holding; pre-existing breakage is exempt and disclosed', async () => {
  const other = el('h2');
  const make = () => {
    const w = makeWorld();
    w.doc.appendChild(other);
    return w;
  };
  // Held at baseline and still holds → pass.
  {
    const w = make();
    w.styles.set(other, 'color', 'rgb(255, 0, 0)');
    const captured = w.verifier.captureBaseline(basePlan({
      combined: [{ customizationId: 'c1', revisionId: 'r0', checks: [{ key: 'combined:c1:0:color', el: other as unknown as Element, property: 'color', value: 'red' }], texts: [], nodes: [] }],
    }));
    assert.ok(captured.ok);
    const report = await w.verifier.verify(basePlan({
      combined: [{ customizationId: 'c1', revisionId: 'r0', checks: [{ key: 'combined:c1:0:color', el: other as unknown as Element, property: 'color', value: 'red' }], texts: [], nodes: [] }],
    }), captured.baseline);
    assert.equal(report.status, 'pass', JSON.stringify(report.issues));
  }
  // Held at baseline, broken by the candidate window → fail.
  {
    const w = make();
    w.styles.set(other, 'color', 'rgb(255, 0, 0)');
    const captured = w.verifier.captureBaseline(basePlan({
      combined: [{ customizationId: 'c1', revisionId: 'r0', checks: [{ key: 'combined:c1:0:color', el: other as unknown as Element, property: 'color', value: 'red' }], texts: [], nodes: [] }],
    }));
    assert.ok(captured.ok);
    w.styles.set(other, 'color', 'rgb(0, 0, 255)');
    const report = await w.verifier.verify(basePlan({
      combined: [{ customizationId: 'c1', revisionId: 'r0', checks: [{ key: 'combined:c1:0:color', el: other as unknown as Element, property: 'color', value: 'red' }], texts: [], nodes: [] }],
    }), captured.baseline);
    assert.equal(report.status, 'fail');
    assert.ok(report.issues.some((i) => i.key === 'combined:c1:0:color' && i.status === 'fail'));
  }
  // Already broken before the candidate → exempt, disclosed, never a fail.
  {
    const w = make();
    w.styles.set(other, 'color', 'rgb(0, 0, 255)'); // broken at baseline
    const captured = w.verifier.captureBaseline(basePlan({
      combined: [{ customizationId: 'c1', revisionId: 'r0', checks: [{ key: 'combined:c1:0:color', el: other as unknown as Element, property: 'color', value: 'red' }], texts: [], nodes: [] }],
    }));
    assert.ok(captured.ok);
    const report = await w.verifier.verify(basePlan({
      combined: [{ customizationId: 'c1', revisionId: 'r0', checks: [{ key: 'combined:c1:0:color', el: other as unknown as Element, property: 'color', value: 'red' }], texts: [], nodes: [] }],
    }), captured.baseline);
    assert.equal(report.status, 'pass', JSON.stringify(report.issues));
    assert.equal(report.coverage.preExistingBroken, 1, 'the exemption is disclosed in coverage');
  }
});

test('S4.3: baseline capture failure refuses before activation; skipped declarations are disclosed', async () => {
  const w = makeWorld();
  const broken = el('p');
  Object.defineProperty(broken, 'isConnected', {
    get() {
      throw new Error('the site broke measurement');
    },
  });
  w.doc.appendChild(broken);
  const captured = w.verifier.captureBaseline(basePlan({ protectedEls: [{ key: 'broken', el: broken as unknown as Element }] }));
  assert.equal(captured.ok, false, 'a mandatory baseline that cannot be measured stops the batch');

  const healthy = el('p');
  w.doc.appendChild(healthy);
  const report = await w.verifier.verify(basePlan({ unmeasuredDecls: 3, tokenChecks: [{ key: 'delivery:token:0', el: healthy as unknown as Element, ns: 'ns' }] }), { viewportOverflowX: 0, els: new Map() });
  assert.equal(report.coverage.unmeasuredDecls, 3, 'skipped declarations are disclosed in coverage');
});

// ── S8.1: linked projection views ─────────────────────────────────────────

test('S8.1: the projection view must sit connected at its anchor with the expected items and coverage', async () => {
  const w = makeWorld();
  const anchor = el('div');
  const list = el('ul');
  w.doc.appendChild(anchor);
  w.doc.appendChild(list);

  const view = el('section');
  view.setAttribute('data-rv2p-view', '1');
  for (let i = 0; i < 3; i++) view.appendChild(el('article')).setAttribute('data-rv2p-card', '1');
  const cov = el('span');
  cov.setAttribute('data-rv2p-coverage', '1');
  cov.appendChild(text('Showing 3 of 3 items'));
  view.appendChild(cov);
  anchor.appendChild(view); // connected under the anchor

  const captured = w.verifier.captureBaseline(basePlan());
  assert.ok(captured.ok);

  const good = await w.verifier.verify(basePlan({
    projections: [{ key: 'effect:projection:0', root: view as unknown as Element, expectedParent: anchor as unknown as Element, expectedItems: 3, container: list as unknown as Element }],
  }), captured.baseline);
  assert.equal(good.status, 'pass', JSON.stringify(good.issues));

  // A missing card or a detached view fails honestly.
  const badItems = await w.verifier.verify(basePlan({
    projections: [{ key: 'effect:projection:0', root: view as unknown as Element, expectedParent: anchor as unknown as Element, expectedItems: 5, container: list as unknown as Element }],
  }), captured.baseline);
  assert.equal(badItems.status, 'fail');
  assert.match(badItems.issues[0].detail!, /renders 3 item\(s\), expected 5/);

  view.remove();
  const detached = await w.verifier.verify(basePlan({
    projections: [{ key: 'effect:projection:0', root: view as unknown as Element, expectedParent: anchor as unknown as Element, expectedItems: 3, container: list as unknown as Element }],
  }), captured.baseline);
  assert.equal(detached.status, 'fail');
  assert.match(detached.issues[0].detail!, /not connected at its validated anchor/);
});

// ── owner-directed shorthand verification (2026-09-13) ───────────────────

test('T13/owner: a shorthand declaration verifies through its longhands — computed shorthands have no single form', async () => {
  const w = makeWorld();
  const h = el('h1');
  w.doc.appendChild(h);
  // The batch declared `border: 2px solid red`; the browser resolved the
  // per-side longhands. Computed border (the shorthand) has no single form.
  for (const side of ['top', 'right', 'bottom', 'left']) {
    w.styles.set(h, `border-${side}-width`, '2px');
    w.styles.set(h, `border-${side}-style`, 'solid');
    w.styles.set(h, `border-${side}-color`, 'rgb(255, 0, 0)');
  }
  const captured = w.verifier.captureBaseline(basePlan({ protectedEls: [{ key: 'h', el: h as unknown as Element }] }));
  assert.ok(captured.ok);
  const report = await w.verifier.verify(basePlan({
    styles: [{ key: 'effect:style:op0:rule0:decl1:border', el: h as unknown as Element, property: 'border', value: '2px solid red' }],
    protectedEls: [{ key: 'h', el: h as unknown as Element }],
  }), captured.baseline);
  assert.equal(report.status, 'pass', JSON.stringify(report.issues));

  // One longhand failing to hold → the shorthand effect fails honestly.
  w.styles.set(h, 'border-top-color', 'rgb(0, 0, 255)');
  const report2 = await w.verifier.verify(basePlan({
    styles: [{ key: 'effect:style:op0:rule0:decl1:border', el: h as unknown as Element, property: 'border', value: '2px solid red' }],
  }), captured.baseline);
  assert.equal(report2.status, 'fail', 'a single failed longhand is a failed shorthand effect');
  assert.match(report2.issues[0].detail!, /longhands/);
});

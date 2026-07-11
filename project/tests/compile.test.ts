/**
 * Pure unit check for the compiler + structure + spec — the runnable proof that
 * the safety laws hold. No framework, no fixtures. Run: npm run test
 */

import assert from 'node:assert';
import { compileSpec } from '../src/core/compile/index.ts';
import { validateSpec } from '../src/core/spec/index.ts';
import type { Perception, Cluster, ClusterLayout } from '../src/core/perceive/index.ts';
import type { DesignSpec } from '../src/core/spec/index.ts';

function layout(over: Partial<ClusterLayout> = {}): ClusterLayout {
  return {
    display: 'block', flow: 'none', widthRatio: 0.5, isContainer: false,
    ownedByFlexGrid: false, constraintOwnerHandle: null, parentHandle: null,
    isPassiveWrapper: false, depth: 1, ...over,
  };
}

function cluster(over: Partial<Cluster>): Cluster {
  return {
    handle: 'c000000', selector: '[data-wm-c="c000000"]', count: 1, tag: 'div', role: null,
    isNativeControl: false, isCheckboxRadio: false, hasSolidBg: true, rect: { w: 100, h: 100 },
    samples: [], prominence: 1, layout: layout(),
    style: {
      background: 'rgb(255,255,255)', color: 'rgb(0,0,0)', border: 'none', borderRadius: '0px',
      boxShadow: 'none', fontFamily: 'sans-serif', fontSize: '16px', fontWeight: '400', padding: '0px', display: 'block',
    },
    ...over,
  };
}

function perception(clusters: Cluster[]): Perception {
  return {
    builtInMs: 1, nodeCount: clusters.length, cssVars: [],
    canvas: { bg: 'rgb(255,255,255)', color: 'rgb(0,0,0)', fontFamily: 'sans-serif', fontSize: '16px' },
    clusters, skeleton: { regions: [], contentMaxWidthPx: 800, columnCount: 2 },
    handles: new Set(clusters.map((c) => c.handle)),
  };
}

// ─────────────────────────────── paint (existing guarantees) ───────────────────────────────
{
  const p = perception([
    cluster({ handle: 'ccard1', selector: '[data-wm-c="ccard1"]', role: 'article' }),
    cluster({ handle: 'cbtn01', selector: '[data-wm-c="cbtn01"]', tag: 'button', role: 'button', isNativeControl: true }),
  ]);
  const spec: DesignSpec = {
    reasoning: 'test',
    canvas: { background: '#ffffff', color: '#111111' },
    rules: [
      { target: 'ccard1', styles: { background: '#00ff88', border: '3px solid #000', boxShadow: '6px 6px 0 #000', width: '9999px', margin: '40px', position: 'absolute' }, hover: { transform: 'scale(1.02)' } },
      { target: 'cbtn01', styles: { background: '#ff0055' } },
      { target: 'nonexistent', styles: { background: '#123456' } },
    ],
  };
  const { css, ops, invalidTargets } = compileSpec(spec, p);
  assert.ok(css.includes('!important'), 'paint: !important');
  assert.ok(css.includes('background:') && !/background-color\s*:/.test(css), 'paint: background shorthand only');
  assert.ok(css.includes('color: #111111'), 'paint: contrast lock adds readable text');
  assert.ok(!/(^|[\s{;])width\s*:/.test(css), 'paint: forbidden width dropped (styles)');
  assert.ok(!/(^|[\s{;])margin\s*:/.test(css), 'paint: forbidden margin dropped (styles)');
  assert.ok(!/position\s*:/.test(css), 'paint: forbidden position dropped');
  assert.ok(css.includes('box-sizing: border-box'), 'paint: box-sizing on border');
  assert.ok(css.includes('appearance: none'), 'paint: appearance:none on native control');
  assert.deepStrictEqual(invalidTargets, ['nonexistent'], 'paint: bogus target reported');
  assert.ok(css.includes(':hover') && css.includes('transform:') && css.includes('transition:'), 'paint: hover + transition');
  assert.deepStrictEqual(ops, [], 'paint-only spec plans no moves');
}

// ─────────────────────────────── layout (new guarantees) ───────────────────────────────
{
  const p = perception([cluster({ handle: 'cmain0', selector: '[data-wm-c="cmain0"]', role: 'main', layout: layout({ isContainer: true }) })]);

  // allowlist: mapped props kept, unknown dropped
  let r = compileSpec({ reasoning: '', rules: [{ target: 'cmain0', layout: { maxWidth: '760px', display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: '20px', marginInline: 'auto', bogusKey: 'x' } }] }, p);
  assert.ok(r.css.includes('max-width: 760px'), 'layout: maxWidth emitted');
  assert.ok(r.css.includes('display: grid'), 'layout: display emitted');
  assert.ok(r.css.includes('grid-template-columns: repeat(2,1fr)'), 'layout: grid template emitted');
  assert.ok(r.css.includes('gap: 20px'), 'layout: gap emitted');
  assert.ok(r.css.includes('margin-inline: auto'), 'layout: marginInline emitted');
  assert.ok(!r.css.includes('bogusKey') && !r.css.includes('bogus-key'), 'layout: unknown key dropped');

  // never display:none
  r = compileSpec({ reasoning: '', rules: [{ target: 'cmain0', layout: { display: 'none' } }] }, p);
  assert.ok(!/display\s*:\s*none/.test(r.css), 'layout: display:none never emitted');

  // overflow guard
  r = compileSpec({ reasoning: '', rules: [{ target: 'cmain0', layout: { width: '3000px' } }] }, p);
  assert.ok(r.css.includes('max-width: 100%'), 'layout: wide absolute width paired with max-width:100%');

  // box-sizing coupling on width
  r = compileSpec({ reasoning: '', rules: [{ target: 'cmain0', layout: { width: '50%' } }] }, p);
  assert.ok(r.css.includes('box-sizing: border-box'), 'layout: box-sizing coupled to width');
}

// ─────────────────────────────── moves planning ───────────────────────────────
{
  const shared = cluster({ handle: 'cA', selector: '[data-wm-c="cA"]', layout: layout({ constraintOwnerHandle: 'own1' }) });
  const shared2 = cluster({ handle: 'cB', selector: '[data-wm-c="cB"]', layout: layout({ constraintOwnerHandle: 'own1' }) });
  const x = cluster({ handle: 'cX', selector: '[data-wm-c="cX"]', layout: layout({ constraintOwnerHandle: 'ownX' }) });
  const y = cluster({ handle: 'cY', selector: '[data-wm-c="cY"]', layout: layout({ constraintOwnerHandle: 'ownY' }) });
  const p = perception([shared, shared2, x, y]);

  const r = compileSpec({
    reasoning: '', rules: [],
    moves: [
      { target: 'cA', into: 'cB', reason: 'same owner -> CSS order preferred' },   // dropped
      { target: 'cX', into: 'cY', reason: 'cross-owner relocation' },              // survives
      { target: 'cA', into: 'ghost', reason: 'bad dest' },                         // dropped (unknown handle)
    ],
  }, p);
  assert.deepStrictEqual(r.ops, [{ target: 'cX', into: 'cY', position: 'append' }], 'moves: same-owner + invalid dropped, cross-owner planned');
}

// ─────────────────────────────── validateSpec robustness ───────────────────────────────
for (const junk of [null, undefined, 42, 'x', [], { rules: 'nope' }, { rules: [{}, { target: 5 }, { target: 'ok' }] }, { rules: [], moves: [{ target: 'a' }] }]) {
  const res = validateSpec(junk);
  assert.ok(typeof res.ok === 'boolean', 'validateSpec never throws, returns ok flag');
}
assert.strictEqual(validateSpec({ rules: [{}, { target: 't', styles: { color: 'red' } }] }).ok, true, 'validateSpec keeps a usable rule');
assert.strictEqual(validateSpec({ rules: [] }).ok, false, 'validateSpec rejects empty');
{
  const v = validateSpec({ reasoning: 'x', rules: [{ target: 'c1', layout: { maxWidth: '700px' }, styles: { color: '#111' } }], moves: [{ target: 'c1', into: 'c2' }] });
  assert.ok(v.ok && v.spec, 'validateSpec accepts layout + moves');
  assert.strictEqual(v.spec!.moves![0].position, 'append', 'move position defaults to append');
}

// ─────────────────────────────── repair: forceContrast ───────────────────────────────
{
  const p = perception([cluster({ handle: 'ccard1', selector: '[data-wm-c="ccard1"]' })]);
  const dark = compileSpec({ reasoning: '', rules: [{ target: 'ccard1', styles: { background: '#111111', color: '#000000' } }] }, p, { forceContrast: true });
  assert.ok(dark.css.includes('color: #f5f5f5'), 'repair: forceContrast lifts text on dark bg');
}

console.log('compile.test OK — paint + layout + moves + validation guarantees hold');

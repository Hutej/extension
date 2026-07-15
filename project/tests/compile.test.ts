/**
 * Pure unit check for the compiler + structure + spec — the runnable proof that
 * the safety laws hold. No framework, no fixtures. Run: npm run test
 */

import assert from 'node:assert';
import { compileSpec } from '../src/core/compile/index.ts';
import { validateSpec, checkCompleteness } from '../src/core/spec/index.ts';
import { regionAddressed } from '../src/core/verify/index.ts';
import { clampColumnCount, normalizeGridTemplate } from '../src/core/laws/index.ts';
import type { Perception, Cluster, ClusterLayout } from '../src/core/perceive/index.ts';
import type { DesignSpec } from '../src/core/spec/index.ts';

function layout(over: Partial<ClusterLayout> = {}): ClusterLayout {
  return {
    display: 'block', flow: 'none', widthRatio: 0.5, isContainer: false,
    ownedByFlexGrid: false, constraintOwnerHandle: null, parentHandle: null,
    isPassiveWrapper: false, isOpaqueWrapper: false, depth: 1, ...over,
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

function perception(clusters: Cluster[], canvasBg = 'rgb(255,255,255)', regions: Perception['skeleton']['regions'] = []): Perception {
  return {
    builtInMs: 1, nodeCount: clusters.length, cssVars: [],
    canvas: { bg: canvasBg, color: 'rgb(0,0,0)', fontFamily: 'sans-serif', fontSize: '16px' },
    clusters, skeleton: { regions, contentMaxWidthPx: 800, columnCount: 2 },
    handles: new Set(clusters.map((c) => c.handle)),
    opaqueWrappers: new Set<string>(),
    viewport: { w: 1280, h: 900 },
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
  assert.ok(r.css.includes('max-width: min(760px, 100%)'), 'layout: maxWidth emitted (viewport-safe min())');
  assert.ok(r.css.includes('display: grid'), 'layout: display emitted');
  assert.ok(r.css.includes('grid-template-columns: repeat(2, minmax(0, 1fr))'), 'layout: grid template emitted (normalized to minmax(0, 1fr))');
  assert.ok(r.css.includes('gap: 20px'), 'layout: gap emitted');
  assert.ok(r.css.includes('margin-inline: auto'), 'layout: marginInline emitted');
  assert.ok(!r.css.includes('bogusKey') && !r.css.includes('bogus-key'), 'layout: unknown key dropped');

  // never display:none
  r = compileSpec({ reasoning: '', rules: [{ target: 'cmain0', layout: { display: 'none' } }] }, p);
  assert.ok(!/display\s*:\s*none/.test(r.css), 'layout: display:none never emitted');

  // overflow guard: any fixed px width becomes min(X,100%) by construction
  r = compileSpec({ reasoning: '', rules: [{ target: 'cmain0', layout: { width: '3000px' } }] }, p);
  assert.ok(r.css.includes('width: min(3000px, 100%)'), 'layout: fixed px width clamped to min(X,100%)');

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

// ─────────────────────────────── opaque-wrapper neutralization ───────────────────────────────
{
  const wrapper = cluster({ handle: 'cwrap0', selector: '[data-wm-c="cwrap0"]', hasSolidBg: true, layout: layout({ isOpaqueWrapper: true }) });
  const p = perception([wrapper]);
  p.opaqueWrappers = new Set(['cwrap0']);
  const r = compileSpec({ reasoning: '', canvas: { background: 'linear-gradient(135deg,#3a1c71,#d76d77)', color: '#fff' }, rules: [] }, p);
  assert.ok(r.css.includes('background: transparent'), 'opaque wrapper neutralized when canvas is set');
  const r2 = compileSpec({ reasoning: '', rules: [] }, p);
  assert.ok(!r2.css.includes('transparent'), 'opaque wrapper NOT neutralized when no canvas is set');
}

// ─────────────────────────────── hide channel ───────────────────────────────────────────────

// validateSpec: hide:true is accepted; hide:false / missing is not stored
{
  // A spec with ONLY hide rules (no styles/layout) is valid — hide alone is enough
  const vHideOnly = validateSpec({ rules: [{ target: 'csidebar', hide: true }] });
  assert.ok(vHideOnly.ok && vHideOnly.spec, 'validateSpec: hide-only rule is accepted');
  assert.strictEqual(vHideOnly.spec!.rules[0].hide, true, 'validateSpec: hide:true stored on rule');

  // hide:false is not stored (treated as absent)
  const vHideFalse = validateSpec({ rules: [{ target: 'csidebar', hide: false as unknown as boolean, styles: { color: 'red' } }] });
  assert.ok(vHideFalse.ok && vHideFalse.spec, 'validateSpec: rule with hide:false kept (has styles)');
  assert.strictEqual(vHideFalse.spec!.rules[0].hide, undefined, 'validateSpec: hide:false not stored');

  // A rule with neither styles/layout nor hide is dropped
  const vEmpty = validateSpec({ rules: [{ target: 'cempty' }] });
  assert.ok(!vEmpty.ok, 'validateSpec: rule with no styles/layout/hide is dropped -> no usable rules');

  // Combined: one hide rule + one style rule both survive
  const v2 = validateSpec({ rules: [{ target: 'csidebar', hide: true }, { target: 'ckeep', styles: { color: 'red' } }] });
  assert.ok(v2.ok && v2.spec, 'validateSpec: accepts spec with a hide rule + a style rule');
  const hiddenRule = v2.spec!.rules.find((r) => r.target === 'csidebar');
  assert.strictEqual(hiddenRule?.hide, true, 'validateSpec: hide:true preserved on rule');
  const noHideRule = v2.spec!.rules.find((r) => r.target === 'ckeep');
  assert.strictEqual(noHideRule?.hide, undefined, 'validateSpec: hide not set when not in input');
}

// Compiler: a safe hide emits display:none on the correct selector
{
  const sidebar = cluster({
    handle: 'cside0', selector: '[data-wm-c="cside0"]',
    tag: 'aside', role: 'complementary',
    rect: { w: 200, h: 300 },                // small — not page-scale
    layout: layout({ widthRatio: 0.15, isPassiveWrapper: false, isOpaqueWrapper: false }),
  });
  const p = perception([sidebar]);
  const r = compileSpec({ reasoning: '', rules: [{ target: 'cside0', hide: true }] }, p);
  assert.ok(r.css.includes('display: none'), 'hide: safe cluster emits display:none');
  assert.ok(r.css.includes('[data-wm-c="cside0"]'), 'hide: correct selector used');
  assert.ok(!r.css.includes('display: none !important;\n}\n\n[data-wm-c="cside0"] {'), 'hide: not duplicated in style block');
}

// Compiler: refuses hide on a main/article (primary content)
{
  const main = cluster({ handle: 'cmain1', selector: '[data-wm-c="cmain1"]', role: 'main', rect: { w: 800, h: 600 }, layout: layout({ widthRatio: 0.65 }) });
  const p = perception([main]);
  const r = compileSpec({ reasoning: '', rules: [{ target: 'cmain1', hide: true }] }, p);
  assert.ok(!/display\s*:\s*none/.test(r.css), 'hide: primary content (main) refused');
  assert.ok(r.droppedProps.some((d) => d.includes('primary-content')), 'hide: refusal logged in droppedProps');
}

// Compiler: refuses hide on a page-scale container (wide + tall)
{
  const bigWrapper = cluster({
    handle: 'cwide1', selector: '[data-wm-c="cwide1"]',
    rect: { w: 1200, h: 600 },               // tall + very wide
    layout: layout({ widthRatio: 0.93, isPassiveWrapper: false }),
  });
  const p = perception([bigWrapper]);
  const r = compileSpec({ reasoning: '', rules: [{ target: 'cwide1', hide: true }] }, p);
  assert.ok(!/display\s*:\s*none/.test(r.css), 'hide: page-scale container refused');
  assert.ok(r.droppedProps.some((d) => d.includes('page-scale')), 'hide: page-scale refusal logged');
}

// Compiler: refuses hide on a huge repeated cluster (>40 members — likely content)
{
  const manyLinks = cluster({ handle: 'clinks', selector: '[data-wm-c="clinks"]', count: 50, tag: 'a', role: 'link', layout: layout({ widthRatio: 0.1 }) });
  const p = perception([manyLinks]);
  const r = compileSpec({ reasoning: '', rules: [{ target: 'clinks', hide: true }] }, p);
  assert.ok(!/display\s*:\s*none/.test(r.css), 'hide: large repeated cluster refused');
  assert.ok(r.droppedProps.some((d) => d.includes('repeated-content')), 'hide: repeated-content refusal logged');
}

// Compiler: dropHides option strips all hide rules (used by repair when content blanked)
{
  const sidebar = cluster({ handle: 'csd2', selector: '[data-wm-c="csd2"]', role: 'complementary', rect: { w: 200, h: 300 }, layout: layout({ widthRatio: 0.15 }) });
  const p = perception([sidebar]);
  const r = compileSpec({ reasoning: '', rules: [{ target: 'csd2', hide: true }] }, p, { dropHides: true });
  assert.ok(!/display\s*:\s*none/.test(r.css), 'dropHides: suppresses all hide rules');
}

// Compiler: hide and style/layout rules are mutually exclusive on the same target
// (the hide path skips paint/layout — "hidden — paint/layout on this rule is moot")
{
  const sidebar = cluster({ handle: 'csd3', selector: '[data-wm-c="csd3"]', role: 'complementary', rect: { w: 200, h: 300 }, layout: layout({ widthRatio: 0.15 }) });
  const p = perception([sidebar]);
  const r = compileSpec({ reasoning: '', rules: [{ target: 'csd3', hide: true, styles: { background: '#ff0000' } }] }, p);
  // background should NOT appear — hide is accepted, style block is skipped
  assert.ok(r.css.includes('display: none'), 'hide+styles: hide wins, display:none emitted');
  assert.ok(!r.css.includes('#ff0000'), 'hide+styles: style block not emitted for hidden cluster');
}

// ─────────────────────────────── forceContrast body floor (uncovered text) ───────────────────────────────
// Root cause of the old no-op: forceContrast only touched rules that set a
// background, so text NOT covered by any rule (inheriting from body) stayed
// dark-on-dark. Fix: a canvas/body-level readable-color floor against the backdrop.
{
  // Canvas sets a text color but NO background; the real page backdrop is dark.
  // Without forceContrast the authored (dark) color ships; with it, the emitted
  // CSS must differ and enforce a readable color for inheriting text.
  const p = perception([cluster({ handle: 'cbody0', selector: '[data-wm-c="cbody0"]' })], 'rgb(17,17,17)');
  const specDarkText: DesignSpec = { reasoning: '', canvas: { color: '#222222' }, rules: [] };
  const plain = compileSpec(specDarkText, p);
  const forced = compileSpec(specDarkText, p, { forceContrast: true });
  assert.notStrictEqual(plain.css, forced.css, 'forceContrast: emitted CSS must differ from the plain compile');
  assert.ok(/html, body \{[^}]*color: #f5f5f5/.test(forced.css), 'forceContrast: body floor enforces readable light text on the dark canvas');
  assert.ok(!/color: #f5f5f5/.test(plain.css), 'without forceContrast: no floor applied (authored dark color ships)');

  // A rule that sets a text color but NO background gets its color made readable too.
  const specRuleText: DesignSpec = { reasoning: '', canvas: { background: '#111111' }, rules: [{ target: 'cbody0', styles: { color: '#333333' } }] };
  const forcedRule = compileSpec(specRuleText, p, { forceContrast: true });
  assert.ok(forcedRule.css.includes('[data-wm-c="cbody0"]') && /\[data-wm-c="cbody0"\] \{[^}]*color: #f5f5f5/.test(forcedRule.css), 'forceContrast: bg-less rule text color made readable against canvas');
}

// ─────────────────────────────── accent-trim (over-accent repair) ───────────────────────────────
// gpt-5 painted an accent bg on every row of a repeated cluster -> accent≈1.0.
// trimAccent must strip accent bg from the repeated/low-prominence clusters while
// keeping it on the few prominent single-instance blocks — deterministically,
// before spending a paid reReason.
{
  // A prominent single hero band (deliberate accent) + a huge repeated list whose
  // rows each paint the same red (the failure). Areas: hero 1200x120; rows 900x40 x 30.
  const hero = cluster({ handle: 'chero', selector: '[data-wm-c="chero"]', count: 1, rect: { w: 1200, h: 120 }, prominence: 5, layout: layout({ widthRatio: 0.94 }) });
  const rows = cluster({ handle: 'crows', selector: '[data-wm-c="crows"]', count: 30, rect: { w: 900, h: 40 }, prominence: 3, layout: layout({ widthRatio: 0.7 }) });
  const p = perception([hero, rows]);
  const spec: DesignSpec = {
    reasoning: '',
    rules: [
      { target: 'chero', styles: { background: '#e10000', color: '#ffffff', fontSize: '3rem' } },
      { target: 'crows', styles: { background: '#e10000', color: '#ffffff' } },
    ],
  };
  const plain = compileSpec(spec, p);
  assert.ok(plain.css.includes('[data-wm-c="crows"]') && /\[data-wm-c="crows"\] \{[^}]*background/.test(plain.css), 'without trim: repeated rows keep their accent bg');

  const trimmed = compileSpec(spec, p, { trimAccent: true });
  // Rows (repeated, huge total area) lose the accent bg + coupled color…
  assert.ok(!/\[data-wm-c="crows"\] \{[^}]*background/.test(trimmed.css), 'trimAccent: repeated rows stripped of accent bg');
  assert.ok(trimmed.droppedProps.some((d) => d === 'trimAccent(crows)'), 'trimAccent: strip logged for repeated cluster');
  // …while the prominent single hero band keeps its accent.
  assert.ok(/\[data-wm-c="chero"\] \{[^}]*background: #e10000/.test(trimmed.css), 'trimAccent: prominent single hero band keeps its accent');
  assert.ok(!trimmed.droppedProps.includes('trimAccent(chero)'), 'trimAccent: hero not stripped');
}

// ─────────────────────────────── viewport-safe by construction (Task 2) ───────────────────────────────
// Overflow that never happens beats overflow repaired: fixed widths become
// min(X,100%), display type scales down via clamp(). Pure math, applied to all.
{
  const p = perception([cluster({ handle: 'cvp0', selector: '[data-wm-c="cvp0"]', layout: layout({ isContainer: true }) })]);

  let r = compileSpec({ reasoning: '', rules: [{ target: 'cvp0', layout: { width: '2000px' } }] }, p);
  assert.ok(r.css.includes('width: min(2000px, 100%)'), 'viewport-safe: fixed px width -> min(X,100%)');
  assert.ok(r.css.includes('box-sizing: border-box'), 'viewport-safe: width still couples box-sizing');

  r = compileSpec({ reasoning: '', rules: [{ target: 'cvp0', layout: { maxWidth: '1400px' } }] }, p);
  assert.ok(r.css.includes('max-width: min(1400px, 100%)'), 'viewport-safe: fixed px max-width -> min(X,100%)');

  r = compileSpec({ reasoning: '', rules: [{ target: 'cvp0', layout: { width: '50%', maxWidth: 'min(700px, 90vw)' } }] }, p);
  assert.ok(/width: 50% !important/.test(r.css), 'viewport-safe: percentage width left untouched');
  assert.ok(r.css.includes('max-width: min(700px, 90vw)'), 'viewport-safe: already-fluid max-width left untouched');

}

// ─────────────────────────────── Fix 1: container-aware fontSize clamp ───────────────────────────────
// The clamp keys off the cluster's OWN block width (not the viewport), and runs
// in BOTH the layout and styles bags — so oversized type can't bleed out of a
// narrow card, however the model set it.
{
  const narrow = cluster({ handle: 'cnar', selector: '[data-wm-c="cnar"]', rect: { w: 200, h: 80 } });
  const wide = cluster({ handle: 'cwid', selector: '[data-wm-c="cwid"]', rect: { w: 1000, h: 80 } });
  const p = perception([narrow, wide]);

  // 4rem (64px) on a 200px block -> clamped to fit its container (ceil 200*0.15=30px).
  let r = compileSpec({ reasoning: '', rules: [{ target: 'cnar', layout: { fontSize: '4rem' } }] }, p);
  assert.ok(r.css.includes('font-size: clamp(1rem, 4rem, 30px)'), 'Fix1: oversized type on a narrow block clamped to its container');

  // 4rem on a 1000px block fits (ceil 150px) -> left unclamped.
  r = compileSpec({ reasoning: '', rules: [{ target: 'cwid', layout: { fontSize: '4rem' } }] }, p);
  assert.ok(r.css.includes('font-size: 4rem !important') && !r.css.includes('clamp('), 'Fix1: type that fits its wide block stays unclamped');

  // Same clamp applies via the STYLES bag, not just layout.
  r = compileSpec({ reasoning: '', rules: [{ target: 'cnar', styles: { fontSize: '4rem' } }] }, p);
  assert.ok(r.css.includes('font-size: clamp(1rem, 4rem, 30px)'), 'Fix1: styles-bag oversized type clamped too');

  // Body text passes through untouched.
  r = compileSpec({ reasoning: '', rules: [{ target: 'cnar', layout: { fontSize: '18px' } }] }, p);
  assert.ok(r.css.includes('font-size: 18px !important') && !r.css.includes('clamp('), 'Fix1: body-size type untouched');
}

// ─────────────────────────────── Fix 2: targeted forceContrast on flagged handles ───────────────────────────────
{
  // Brief's case: a rule paints a dark bg with dark text; forceContrast + the
  // flagged handle must emit readable (light) text on that handle.
  const dark = cluster({ handle: 'cdark', selector: '[data-wm-c="cdark"]' });
  const r = compileSpec(
    { reasoning: '', rules: [{ target: 'cdark', styles: { background: '#111111', color: '#000000' } }] },
    perception([dark]),
    { forceContrast: true, contrastTargets: ['cdark'] },
  );
  assert.ok(/\[data-wm-c="cdark"\] \{\s*color: #f5f5f5 !important;\s*\}/.test(r.css), 'Fix2: targeted block forces light text on a flagged dark-bg handle');
  assert.ok(!r.css.includes('color: #000000'), 'Fix2: the dark authored text color is overridden');

  // Stronger case that ONLY the targeted path can fix: the handle has a dark
  // ORIGINAL bg (no rule bg) and a rule setting dark text. The canvas-based
  // rule-level floor (white canvas -> dark text) would leave it dark-on-dark;
  // the targeted path reads the handle's OWN painted bg and forces light text.
  const origDark = cluster({
    handle: 'corig', selector: '[data-wm-c="corig"]',
    style: { background: 'rgb(17,17,17)', color: 'rgb(0,0,0)', border: 'none', borderRadius: '0px', boxShadow: 'none', fontFamily: 'sans-serif', fontSize: '16px', fontWeight: '400', padding: '0px', display: 'block' },
  });
  const r2 = compileSpec(
    { reasoning: '', rules: [{ target: 'corig', styles: { color: '#000000' } }] },
    perception([origDark]), // canvas bg defaults to white
    { forceContrast: true, contrastTargets: ['corig'] },
  );
  assert.ok(/\[data-wm-c="corig"\] \{\s*color: #f5f5f5 !important;\s*\}/.test(r2.css), 'Fix2: targeted contrast uses the handle ORIGINAL dark bg to pick light text');
}

// ─────────────────────────────── targeted overflow repair (Task 3) ───────────────────────────────
// clampTargets strips growth-sizing on ONLY the offending clusters; every other
// cluster's layout survives intact (vs the blanket dropLayout recolor collapse).
{
  const offender = cluster({ handle: 'cbad', selector: '[data-wm-c="cbad"]', layout: layout({ isContainer: true }) });
  const innocent = cluster({ handle: 'cgood', selector: '[data-wm-c="cgood"]', layout: layout({ isContainer: true }) });
  const p = perception([offender, innocent]);
  const spec: DesignSpec = {
    reasoning: '',
    rules: [
      { target: 'cbad', layout: { gridTemplateColumns: 'repeat(3, 500px)', gap: '16px' } },
      { target: 'cgood', layout: { maxWidth: '700px', gap: '20px', display: 'grid' } },
    ],
  };
  const r = compileSpec(spec, p, { clampTargets: ['cbad'] });
  // Offender: growth-sizing (grid-template-columns) stripped; its non-growth gap survives.
  const badBlock = r.css.slice(r.css.indexOf('[data-wm-c="cbad"]'), r.css.indexOf('[data-wm-c="cbad"]') + 200);
  assert.ok(!badBlock.includes('grid-template-columns'), 'targeted: offender grid-template-columns stripped');
  assert.ok(r.droppedProps.some((d) => d === 'gridTemplateColumns(dropSizing)'), 'targeted: offender strip logged');
  // Innocent cluster: full layout intact.
  assert.ok(/\[data-wm-c="cgood"\] \{[^}]*max-width: min\(700px, 100%\)/.test(r.css), 'targeted: innocent cluster max-width intact');
  assert.ok(/\[data-wm-c="cgood"\] \{[^}]*gap: 20px/.test(r.css), 'targeted: innocent cluster gap intact');
  assert.ok(/\[data-wm-c="cgood"\] \{[^}]*display: grid/.test(r.css), 'targeted: innocent cluster display intact');
}

// ─────────────────────────────── Mech 1: completeness contract ───────────────────────────────
// Every retained cluster must be accounted for: restyled, hidden, or explicitly kept.
{
  const handles = new Set(['c1', 'c2', 'c3']);

  // All three accounted (styles + hide + keep) -> ok
  const complete = checkCompleteness(
    { reasoning: '', rules: [
      { target: 'c1', styles: { color: 'red' } },
      { target: 'c2', hide: true },
      { target: 'c3', keep: true },
    ] },
    handles,
  );
  assert.ok(complete.ok, 'completeness: styles + hide + keep all accounted');
  assert.strictEqual(complete.unaccounted.length, 0, 'completeness: no unaccounted handles');

  // c2 and c3 unaccounted -> not ok, names them
  const incomplete = checkCompleteness(
    { reasoning: '', rules: [{ target: 'c1', styles: { color: 'red' } }] },
    handles,
  );
  assert.ok(!incomplete.ok, 'completeness: c2+c3 unaccounted -> not ok');
  assert.ok(incomplete.unaccounted.includes('c2') && incomplete.unaccounted.includes('c3'), 'completeness: unaccounted handles named');

  // validateSpec parses keep:true
  const v = validateSpec({ rules: [{ target: 'cx', keep: true }] });
  assert.ok(v.ok && v.spec, 'completeness: keep-only rule accepted by validateSpec');
  assert.strictEqual(v.spec!.rules[0].keep, true, 'completeness: keep:true stored on rule');

  // validateSpec parses paletteMode
  const v2 = validateSpec({ reasoning: 'x', paletteMode: 'vivid', rules: [{ target: 'cx', styles: { color: 'red' } }] });
  assert.ok(v2.ok && v2.spec, 'completeness: paletteMode accepted by validateSpec');
  assert.strictEqual(v2.spec!.paletteMode, 'vivid', 'completeness: paletteMode stored');
}

// ─────────────────────────────── Mech 2: luminance-aware coverage ───────────────────────────────
// A text-color-only delta on a background that clashes with the canvas does NOT
// count as addressed (the white-strip false pass). Pure math on measured luminance.
{
  const white = 'rgb(255,255,255)';
  const nearBlack = 'rgb(10,10,10)';
  const cream = 'rgb(250,245,235)';

  // white-bg region + near-black canvas + text-only delta -> NOT addressed (clash)
  assert.ok(!regionAddressed(false, 0, 30, white, nearBlack), 'lum: text-only delta on clashing bg NOT addressed');
  // cream region + cream canvas + text-only delta -> addressed (compatible)
  assert.ok(regionAddressed(false, 0, 30, cream, cream), 'lum: text-only delta on compatible bg addressed');
  // bg repainted -> always addressed (regardless of clash)
  assert.ok(regionAddressed(false, 30, 0, white, nearBlack), 'lum: bg repainted always addressed');
  // moved -> always addressed
  assert.ok(regionAddressed(true, 0, 0, white, nearBlack), 'lum: moved always addressed');
  // no delta at all -> not addressed
  assert.ok(!regionAddressed(false, 0, 0, white, nearBlack), 'lum: no delta not addressed');
  // text-only delta + same-luminance dark-on-dark (e.g. dark region on dark canvas) -> compatible
  assert.ok(regionAddressed(false, 0, 30, nearBlack, 'rgb(20,20,20)'), 'lum: same-luminance dark compatible');
}

// ─────────────────────────────── Mech 3: word-break bleed law ───────────────────────────────
// (a) Prevention: narrowing a text-bearing container emits overflow-wrap.
// (b) Targeted repair: wordBreakTargets emits overflow-wrap on the bleeding cluster.
{
  // Prevention: text-bearing cluster narrowed -> overflow-wrap emitted
  const textCluster = cluster({ handle: 'ctxt', selector: '[data-wm-c="ctxt"]', samples: ['some text content'] });
  const pText = perception([textCluster]);
  const rNarrow = compileSpec({ reasoning: '', rules: [{ target: 'ctxt', layout: { maxWidth: '300px' } }] }, pText);
  assert.ok(rNarrow.css.includes('overflow-wrap: break-word'), 'word-break: narrowing a text container emits overflow-wrap (prevention)');

  // Non-text cluster narrowed -> overflow-wrap STILL emitted (harmless, inherited by text descendants)
  const imgCluster = cluster({ handle: 'cimg', selector: '[data-wm-c="cimg"]', samples: [], tag: 'img', role: 'img' });
  const pImg = perception([imgCluster]);
  const rImg = compileSpec({ reasoning: '', rules: [{ target: 'cimg', layout: { maxWidth: '300px' } }] }, pImg);
  assert.ok(rImg.css.includes('overflow-wrap: break-word'), 'word-break: non-text container also gets overflow-wrap (inherited by descendants)');

  // Non-narrowing layout (gap only) on a text cluster -> no overflow-wrap
  const rGap = compileSpec({ reasoning: '', rules: [{ target: 'ctxt', layout: { gap: '20px' } }] }, pText);
  assert.ok(!rGap.css.includes('overflow-wrap'), 'word-break: gap-only layout (no narrowing) gets no overflow-wrap');

  // Targeted repair: wordBreakTargets emits overflow-wrap:anywhere on exactly the bleeding cluster
  const rRepair = compileSpec({ reasoning: '', rules: [{ target: 'ctxt', styles: { background: '#111' } }] }, pText, { wordBreakTargets: ['ctxt'] });
  assert.ok(/overflow-wrap: anywhere !important/.test(rRepair.css), 'word-break: targeted repair emits overflow-wrap:anywhere on bleeding cluster');
}

// ─────────────────────────────── Mech 4: intent-declared palette ───────────────────────────────
// Vivid lifts the accent area cap but the repeated-accent law stays absolute.
// trimAccent in vivid mode strips repeated accents (absolute law) but keeps all
// non-repeated accents (no area budget). Restrained mode keeps the area budget.
{
  const hero = cluster({ handle: 'chero', selector: '[data-wm-c="chero"]', count: 1, rect: { w: 1200, h: 120 }, prominence: 5, layout: layout({ widthRatio: 0.94 }) });
  const rows = cluster({ handle: 'crows', selector: '[data-wm-c="crows"]', count: 30, rect: { w: 900, h: 40 }, prominence: 3, layout: layout({ widthRatio: 0.7 }) });
  const p = perception([hero, rows]);
  const spec: DesignSpec = {
    reasoning: '', paletteMode: 'vivid',
    rules: [
      { target: 'chero', styles: { background: '#e10000', color: '#ffffff' } },
      { target: 'crows', styles: { background: '#e10000', color: '#ffffff' } },
    ],
  };

  // Vivid + trimAccent: repeated rows stripped (absolute law), hero kept (no area budget)
  const trimmed = compileSpec(spec, p, { trimAccent: true, paletteMode: 'vivid' });
  assert.ok(!/\[data-wm-c="crows"\] \{[^}]*background/.test(trimmed.css), 'vivid: repeated accent stripped (absolute law)');
  assert.ok(trimmed.droppedProps.some((d) => d === 'trimAccent(crows)'), 'vivid: repeated strip logged');
  assert.ok(/\[data-wm-c="chero"\] \{[^}]*background: #e10000/.test(trimmed.css), 'vivid: single hero accent kept (no area budget)');

  // Restrained (default) + trimAccent: repeated stripped + area budget enforced
  const specRestraint: DesignSpec = { reasoning: '', rules: [
    { target: 'chero', styles: { background: '#e10000', color: '#fff' } },
    { target: 'crows', styles: { background: '#e10000', color: '#fff' } },
  ] };
  const trimmedR = compileSpec(specRestraint, p, { trimAccent: true });
  assert.ok(!/\[data-wm-c="crows"\] \{[^}]*background/.test(trimmedR.css), 'restrained: repeated accent stripped (absolute law)');
  assert.ok(/\[data-wm-c="chero"\] \{[^}]*background: #e10000/.test(trimmedR.css), 'restrained: hero kept (under area budget)');
}

// ─────────────────────────────── Fix 3: columnCount clamp (pure) ───────────────────────────────
{
  // columnCount:2 in a 150px container → clamped to 1 (150/120 = 1)
  assert.strictEqual(clampColumnCount(2, 150), 1, 'columnCount: 2 in 150px → 1');
  // columnCount:2 in a 300px container → 2 (300/120 = 2, fits)
  assert.strictEqual(clampColumnCount(2, 300), 2, 'columnCount: 2 in 300px → 2');
  // columnCount:5 in a 500px container → 4 (500/120 = 4)
  assert.strictEqual(clampColumnCount(5, 500), 4, 'columnCount: 5 in 500px → 4');
  // columnCount:1 → always 1 (no clamp needed)
  assert.strictEqual(clampColumnCount(1, 100), 1, 'columnCount: 1 → 1');
  // No container width → pass through (can't clamp without geometry)
  assert.strictEqual(clampColumnCount(3, undefined), 3, 'columnCount: no geometry → passthrough');
}

// ─────────────────────────────── Fix 3: grid normalization (pure) ───────────────────────────────
{
  // bare fr → minmax(0, Xfr) — the key BBC blow-out fix
  assert.ok(normalizeGridTemplate('1fr 2fr').includes('minmax(0, 1fr)'), 'grid: bare 1fr → minmax(0, 1fr)');
  assert.ok(normalizeGridTemplate('1fr 2fr').includes('minmax(0, 2fr)'), 'grid: bare 2fr → minmax(0, 2fr)');
  // repeat(N, 1fr) → repeat(N, minmax(0, 1fr))
  assert.ok(normalizeGridTemplate('repeat(3, 1fr)').includes('minmax(0, 1fr)'), 'grid: repeat(3, 1fr) → minmax(0, 1fr)');
  // fixed px wider than container → min(Xpx, 100%)
  const norm = normalizeGridTemplate('500px 1fr', 300);
  assert.ok(norm.includes('min(500px, 100%)'), 'grid: 500px track in 300px container → min(500px, 100%)');
  // minmax(Xpx, 1fr) → minmax(0, 1fr) — relax min to prevent overflow
  assert.ok(normalizeGridTemplate('minmax(200px, 1fr) 1fr').includes('minmax(0, 1fr)'), 'grid: minmax(200px, 1fr) → minmax(0, 1fr)');
  // already safe values pass through
  assert.strictEqual(normalizeGridTemplate('auto 200px', 1000), 'auto 200px', 'grid: auto + in-bounds px passthrough');
}

// ─────────────────────────────── Fix 3: columnCount clamp in compiler ───────────────────────────────
{
  const narrow = cluster({ handle: 'cnar', selector: '[data-wm-c="cnar"]', rect: { w: 150, h: 80 } });
  const p = perception([narrow]);
  const r = compileSpec({ reasoning: '', rules: [{ target: 'cnar', layout: { columnCount: '2' } }] }, p);
  // 150px / 120 = 1 → clamped to 1
  assert.ok(r.css.includes('column-count: 1'), 'compile: columnCount:2 in 150px → clamped to 1');
  assert.ok(r.droppedProps.some((d) => d.includes('columnCount(clamped:2->1)')), 'compile: columnCount clamp logged');
}

// ─────────────────────────────── Fix 3: grid normalization in compiler ───────────────────────────────
{
  const grid = cluster({ handle: 'cgrd', selector: '[data-wm-c="cgrd"]', rect: { w: 600, h: 400 }, layout: layout({ isContainer: true }) });
  const p = perception([grid]);
  const r = compileSpec({ reasoning: '', rules: [{ target: 'cgrd', layout: { gridTemplateColumns: '1fr 2fr' } }] }, p);
  assert.ok(r.css.includes('minmax(0, 1fr)'), 'compile: grid 1fr → minmax(0, 1fr)');
  assert.ok(r.css.includes('minmax(0, 2fr)'), 'compile: grid 2fr → minmax(0, 2fr)');
  assert.ok(r.css.includes('max-width: 100%'), 'compile: grid container gets max-width:100%');
}

// ─────────────────────────────── Fix 1+2: composition rules ───────────────────────────────
{
  const main = cluster({ handle: 'cmain', selector: '[data-wm-c="cmain"]', role: 'main', rect: { w: 620, h: 2400 }, layout: layout({ isContainer: true, widthRatio: 0.48 }) });
  const sidebar = cluster({ handle: 'cside', selector: '[data-wm-c="cside"]', role: 'complementary', rect: { w: 300, h: 2400 }, layout: layout({ widthRatio: 0.23 }) });
  const p = perception([main, sidebar]);

  // validateSpec parses composition
  const v = validateSpec({
    reasoning: 'test',
    composition: [{ target: 'cmain', layout: { maxWidth: '800px', marginInline: 'auto' } }],
    rules: [{ target: 'cmain', styles: { color: 'red' } }],
  });
  assert.ok(v.ok && v.spec, 'composition: validateSpec accepts composition');
  assert.strictEqual(v.spec!.composition?.length, 1, 'composition: one composition rule stored');
  assert.strictEqual(v.spec!.composition![0].target, 'cmain', 'composition: target stored');

  // compile emits composition rules
  const r = compileSpec({
    reasoning: '',
    composition: [{ target: 'cmain', layout: { maxWidth: '800px', marginInline: 'auto' } }],
    rules: [{ target: 'cmain', styles: { color: 'red' } }],
  }, p);
  assert.ok(r.css.includes('max-width: min(800px, 100%)'), 'composition: layout emitted');
  assert.ok(r.css.includes('color: red'), 'composition: component rule also emitted');

  // checkCompleteness counts composition rules as accounting
  const comp = checkCompleteness(
    { reasoning: '', composition: [{ target: 'cmain', layout: { maxWidth: '800px' } }], rules: [{ target: 'cside', hide: true }] },
    new Set(['cmain', 'cside']),
  );
  assert.ok(comp.ok, 'composition: completeness counts composition rules');
}

// ─────────────────────────────── Fix 4: base-coat harmonizer ───────────────────────────────
{
  // A white-bg region NOT addressed by any rule, on a dark canvas → base-coated
  const header = cluster({
    handle: 'chdr', selector: '[data-wm-c="chdr"]', role: 'banner',
    rect: { w: 1280, h: 64 }, layout: layout({ widthRatio: 1.0 }),
    style: { background: 'rgb(255,255,255)', color: 'rgb(0,0,0)', border: 'none', borderRadius: '0px', boxShadow: 'none', fontFamily: 'sans-serif', fontSize: '16px', fontWeight: '400', padding: '0px', display: 'block' },
  });
  const main = cluster({ handle: 'cmain', selector: '[data-wm-c="cmain"]', role: 'main', rect: { w: 800, h: 600 }, layout: layout({ widthRatio: 0.62 }) });
  const p = perception([header, main], 'rgb(255,255,255)', [
    { role: 'banner', handle: 'chdr', widthRatio: 1.0, order: 0, rect: { w: 1280, h: 64 } },
    { role: 'main', handle: 'cmain', widthRatio: 0.62, order: 1, rect: { w: 800, h: 600 } },
  ]);

  // Dark canvas, header NOT addressed by any rule, white bg clashes → base-coated
  const spec: DesignSpec = {
    reasoning: '',
    canvas: { background: '#0a0a0a', color: '#f5f5f5' },
    rules: [{ target: 'cmain', styles: { background: '#111', color: '#f5f5f5' } }], // header NOT addressed
  };
  const r = compileSpec(spec, p);
  assert.ok(r.baseCoatCount >= 1, 'baseCoat: white header on dark canvas base-coated');
  // The base coat block should paint the header with a dark tone
  const hdrBlock = r.css.slice(r.css.indexOf('[data-wm-c="chdr"]'), r.css.indexOf('[data-wm-c="chdr"]') + 200);
  assert.ok(hdrBlock.includes('background:'), 'baseCoat: header gets a background');
  assert.ok(!hdrBlock.includes('rgb(255,255,255)'), 'baseCoat: header NOT left white');

  // Luminance-compatible region → NOT base-coated (cream region on cream canvas)
  const creamHeader = cluster({
    handle: 'chdr2', selector: '[data-wm-c="chdr2"]', role: 'banner',
    rect: { w: 1280, h: 64 }, layout: layout({ widthRatio: 1.0 }),
    style: { background: 'rgb(250,245,235)', color: 'rgb(0,0,0)', border: 'none', borderRadius: '0px', boxShadow: 'none', fontFamily: 'sans-serif', fontSize: '16px', fontWeight: '400', padding: '0px', display: 'block' },
  });
  const p2 = perception([creamHeader, main], 'rgb(250,245,235)', [
    { role: 'banner', handle: 'chdr2', widthRatio: 1.0, order: 0, rect: { w: 1280, h: 64 } },
    { role: 'main', handle: 'cmain', widthRatio: 0.62, order: 1, rect: { w: 800, h: 600 } },
  ]);
  const spec2: DesignSpec = {
    reasoning: '',
    canvas: { background: 'rgb(250,245,235)', color: '#111' },
    rules: [{ target: 'cmain', styles: { background: '#fff', color: '#111' } }],
  };
  const r2 = compileSpec(spec2, p2);
  assert.strictEqual(r2.baseCoatCount, 0, 'baseCoat: cream header on cream canvas NOT base-coated (compatible)');

  // Region addressed by a rule → NOT base-coated (even if it clashes)
  const spec3: DesignSpec = {
    reasoning: '',
    canvas: { background: '#0a0a0a', color: '#f5f5f5' },
    rules: [
      { target: 'cmain', styles: { background: '#111', color: '#f5f5f5' } },
      { target: 'chdr', styles: { background: '#222', color: '#fff' } }, // header addressed
    ],
  };
  const r3 = compileSpec(spec3, p);
  assert.strictEqual(r3.baseCoatCount, 0, 'baseCoat: addressed header NOT base-coated (model handled it)');
}

console.log('compile.test OK — all guarantees hold: paint + layout + moves + validation + opaque-wrapper + hide-channel + forceContrast-floor + accent-trim + viewport-safe + targeted-clamp + container-font + targeted-contrast + completeness + luminance-coverage + word-break + palette-mode + columnCount-clamp + grid-normalization + composition + base-coat');

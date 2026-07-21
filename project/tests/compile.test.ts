/**
 * Pure unit check for the compiler + structure + spec — the runnable proof that
 * the safety laws hold. No framework, no fixtures. Run: npm run test
 */

import assert from 'node:assert';
import { compileSpec } from '../src/core/compile/index.ts';
import { validateSpec, checkCompleteness } from '../src/core/spec/index.ts';
import { regionAddressed } from '../src/core/verify/index.ts';
import { accentFractionWithCanvas } from '../src/core/verify/index.ts';
import { clampColumnCount, normalizeGridTemplate } from '../src/core/laws/index.ts';
import { assertNoRawPxSizing } from '../src/core/laws/index.ts';
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
      hasBgImage: false,
    },
    ...over,
  };
}

function perception(clusters: Cluster[], canvasBg = 'rgb(255,255,255)', regions: Perception['skeleton']['regions'] = []): Perception {
  return {
    builtInMs: 1, nodeCount: clusters.length, cssVars: [], cssVarMap: {},
    site: { host: 'example.com', title: 'Test' },
    canvas: { bg: canvasBg, color: 'rgb(0,0,0)', fontFamily: 'sans-serif', fontSize: '16px' },
    clusters, skeleton: { regions, contentMaxWidthPx: 800, columnCount: 2 },
    handles: new Set(clusters.map((c) => c.handle)),
    opaqueWrappers: new Set<string>(),
    scrollables: [],
    viewport: { w: 1280, h: 900 },
    shadowRoots: [],
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
  const { css, invalidTargets } = compileSpec(spec, p);
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

// ─────────────────────────────── validateSpec robustness ───────────────────────────────
for (const junk of [null, undefined, 42, 'x', [], { rules: 'nope' }, { rules: [{}, { target: 5 }, { target: 'ok' }] }, { rules: [] }]) {
  const res = validateSpec(junk);
  assert.ok(typeof res.ok === 'boolean', 'validateSpec never throws, returns ok flag');
}
assert.strictEqual(validateSpec({ rules: [{}, { target: 't', styles: { color: 'red' } }] }).ok, true, 'validateSpec keeps a usable rule');
assert.strictEqual(validateSpec({ rules: [] }).ok, false, 'validateSpec rejects empty');
{
  const v = validateSpec({ reasoning: 'x', rules: [{ target: 'c1', layout: { maxWidth: '700px' }, styles: { color: '#111' } }] });
  assert.ok(v.ok && v.spec, 'validateSpec accepts layout + styles');
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
    style: { background: 'rgb(17,17,17)', color: 'rgb(0,0,0)', border: 'none', borderRadius: '0px', boxShadow: 'none', fontFamily: 'sans-serif', fontSize: '16px', fontWeight: '400', padding: '0px', display: 'block', hasBgImage: false },
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
// Gate: canvas + composition + ≥15% rules. Base-coat covers unaccounted clusters.
{
  const handles = new Set(['c1', 'c2', 'c3']);

  // No canvas → fail
  const noCanvas = checkCompleteness({ reasoning: '', rules: [{ target: 'c1', styles: { color: 'red' } }] }, handles);
  assert.ok(!noCanvas.ok, 'completeness: no canvas → fail');

  // Has canvas + composition + enough rules → pass (c3 unaccounted is OK — base-coat)
  const complete = checkCompleteness(
    { reasoning: '', canvas: { background: '#111', color: '#fff' }, composition: [{ target: 'c1', layout: { maxWidth: '760px' } }],
      rules: [{ target: 'c1', styles: { color: 'red' } }, { target: 'c2', hide: true }] },
    handles,
  );
  assert.ok(complete.ok, 'completeness: canvas + composition + ≥15% rules → pass');
  assert.ok(complete.unaccounted.includes('c3'), 'completeness: c3 listed as unaccounted (for base-coat)');

  // Not enough rules → fail
  const tooFew = checkCompleteness(
    { reasoning: '', canvas: { background: '#111' }, composition: [{ target: 'c1', layout: { maxWidth: '760px' } }],
      rules: [{ target: 'c1', styles: { color: 'red' } }] },
    new Set(Array.from({ length: 20 }, (_, i) => `c${i}`)),
  );
  assert.ok(!tooFew.ok, 'completeness: 1 rule for 20 clusters → fail (need ≥3)');

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
// (a) NO preventive overflow-wrap: narrowing a container must NOT emit overflow-wrap.
//     `anywhere` collapsed min-content to 1 char and squeezed columns to a few
//     characters, breaking every word ("PROTES TS IN UKRAIN E's"). Bleeds are
//     repaired targeted, post-verify, with break-word (last-resort only).
// (b) Targeted repair: wordBreakTargets emits overflow-wrap:break-word on the bleeding cluster.
{
  // Prevention REMOVED: text-bearing cluster narrowed -> NO overflow-wrap emitted
  const textCluster = cluster({ handle: 'ctxt', selector: '[data-wm-c="ctxt"]', samples: ['some text content'] });
  const pText = perception([textCluster]);
  const rNarrow = compileSpec({ reasoning: '', rules: [{ target: 'ctxt', layout: { maxWidth: '300px' } }] }, pText);
  assert.ok(!rNarrow.css.includes('overflow-wrap'), 'word-break: narrowing a text container does NOT emit overflow-wrap (prevention removed — it was destroying prose)');

  // Non-text cluster narrowed -> also NO overflow-wrap
  const imgCluster = cluster({ handle: 'cimg', selector: '[data-wm-c="cimg"]', samples: [], tag: 'img', role: 'img' });
  const pImg = perception([imgCluster]);
  const rImg = compileSpec({ reasoning: '', rules: [{ target: 'cimg', layout: { maxWidth: '300px' } }] }, pImg);
  assert.ok(!rImg.css.includes('overflow-wrap'), 'word-break: non-text container also gets no preventive overflow-wrap');

  // Non-narrowing layout (gap only) on a text cluster -> no overflow-wrap
  const rGap = compileSpec({ reasoning: '', rules: [{ target: 'ctxt', layout: { gap: '20px' } }] }, pText);
  assert.ok(!rGap.css.includes('overflow-wrap'), 'word-break: gap-only layout (no narrowing) gets no overflow-wrap');

  // Targeted repair: wordBreakTargets emits overflow-wrap:break-word (NOT anywhere)
  // on exactly the bleeding cluster. break-word breaks only as last resort and
  // preserves min-content = longest word (no column squeeze).
  const rRepair = compileSpec({ reasoning: '', rules: [{ target: 'ctxt', styles: { background: '#111' } }] }, pText, { wordBreakTargets: ['ctxt'] });
  assert.ok(/overflow-wrap: break-word !important/.test(rRepair.css), 'word-break: targeted repair emits overflow-wrap:break-word (not anywhere) on bleeding cluster');
  assert.ok(!rRepair.css.includes('overflow-wrap: anywhere'), 'word-break: targeted repair must NOT use anywhere (destroys prose)');
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

  // checkCompleteness counts composition rules + requires canvas
  const comp = checkCompleteness(
    { reasoning: '', canvas: { background: '#111', color: '#fff' }, composition: [{ target: 'cmain', layout: { maxWidth: '800px' } }], rules: [{ target: 'cside', hide: true }] },
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
    style: { background: 'rgb(255,255,255)', color: 'rgb(0,0,0)', border: 'none', borderRadius: '0px', boxShadow: 'none', fontFamily: 'sans-serif', fontSize: '16px', fontWeight: '400', padding: '0px', display: 'block', hasBgImage: false },
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
    style: { background: 'rgb(250,245,235)', color: 'rgb(0,0,0)', border: 'none', borderRadius: '0px', boxShadow: 'none', fontFamily: 'sans-serif', fontSize: '16px', fontWeight: '400', padding: '0px', display: 'block', hasBgImage: false },
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

// ─────────────────────────────── Content image protection ───────────────────────────────
// A cluster whose own background is a url() image (a thumbnail) must never receive
// a solid `background` (the shorthand resets background-image → paints over it),
// nor a replacement `backgroundImage`. The model shapes images via filter/border/
// radius/shadow/aspect/objectFit instead. base-coat also skips image clusters.
{
  // Image cluster: model sets background + backgroundImage → BOTH dropped
  const thumb = cluster({
    handle: 'cthumb', selector: '[data-wm-c="cthumb"]',
    style: { background: 'rgb(20,20,20)', color: 'rgb(255,255,255)', border: 'none', borderRadius: '0px', boxShadow: 'none', fontFamily: 'sans-serif', fontSize: '14px', fontWeight: '400', padding: '0px', display: 'block', hasBgImage: true },
  });
  const pImg = perception([thumb]);
  const rImg = compileSpec(
    { reasoning: '', canvas: { background: '#0a0a0a', color: '#f5f5f5' },
      rules: [{ target: 'cthumb', styles: { background: '#ff0000', backgroundImage: 'url("x.png")', filter: 'sepia(0.4)', borderRadius: '8px' } }] },
    pImg,
  );
  const thumbBlock = rImg.css.slice(rImg.css.indexOf('[data-wm-c="cthumb"]'), rImg.css.indexOf('[data-wm-c="cthumb"]') + 300);
  assert.ok(!/background:\s*#ff0000/.test(thumbBlock), 'image: solid background NOT emitted over a content image');
  assert.ok(!/background-image:\s*url/.test(thumbBlock), 'image: replacement backgroundImage NOT emitted over a content image');
  assert.ok(thumbBlock.includes('filter:'), 'image: non-background treatment (filter) still allowed');
  assert.ok(thumbBlock.includes('border-radius:'), 'image: non-background treatment (radius) still allowed');
  assert.ok(rImg.droppedProps.some((d) => d.includes('imageBg')), 'image: background drop is logged');

  // Non-image cluster: background IS emitted (shorthand, nukes gradients — correct)
  const plain = cluster({ handle: 'cplain', selector: '[data-wm-c="cplain"]' });
  const rPlain = compileSpec(
    { reasoning: '', canvas: { background: '#0a0a0a', color: '#f5f5f5' },
      rules: [{ target: 'cplain', styles: { background: '#ff0000' } }] },
    perception([plain]),
  );
  assert.ok(/background:\s*#ff0000/.test(rPlain.css), 'image: non-image cluster keeps its solid background');

  // base-coat skips image clusters (a thumbnail is not a "clashing strip" to repaint)
  const thumb2 = cluster({
    handle: 'cthumb2', selector: '[data-wm-c="cthumb2"]', rect: { w: 320, h: 180 }, layout: layout({ widthRatio: 0.25 }),
    style: { background: 'rgb(255,255,255)', color: 'rgb(0,0,0)', border: 'none', borderRadius: '0px', boxShadow: 'none', fontFamily: 'sans-serif', fontSize: '14px', fontWeight: '400', padding: '0px', display: 'block', hasBgImage: true },
  });
  const main = cluster({ handle: 'cmain2', selector: '[data-wm-c="cmain2"]', role: 'main', rect: { w: 800, h: 600 }, layout: layout({ widthRatio: 0.62 }) });
  const pBase = perception([thumb2, main], 'rgb(255,255,255)');
  const rBase = compileSpec(
    { reasoning: '', canvas: { background: '#0a0a0a', color: '#f5f5f5' },
      rules: [{ target: 'cmain2', styles: { background: '#111', color: '#f5f5f5' } }] }, // thumb2 NOT addressed
    pBase,
  );
  const thumb2Block = rBase.css.slice(rBase.css.indexOf('[data-wm-c="cthumb2"]'), rBase.css.indexOf('[data-wm-c="cthumb2"]') + 200);
  assert.ok(!/background:\s*#/.test(thumb2Block), 'image: base-coat does NOT paint over a content-image cluster');
}

console.log('compile.test OK — all guarantees hold: paint + layout + validation + opaque-wrapper + hide-channel + forceContrast-floor + accent-trim + viewport-safe + targeted-clamp + container-font + targeted-contrast + completeness + luminance-coverage + word-break + palette-mode + columnCount-clamp + grid-normalization + composition + base-coat');

// ─────────────────────────────── WS1: pure pixel detectors ───────────────────────────────
// Rendered-pixel verification — the only thing the user judges. Pure (no DOM) so
// unit-testable. The content script supplies real captures via captureVisibleTab;
// the harness via page.screenshot. These four detectors feed the repair router with
// pixel-grounded critiques so a by-eye-killer is mechanically impossible to report PASS.
import { detectVoids, detectInvisibleText, detectSqueeze, detectRecolor, type PixelInput, type ClusterRect } from '../src/core/verify/pixel.ts';

function img(solid: [number, number, number], w: number, h: number): PixelInput {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i*4]=solid[0]; data[i*4+1]=solid[1]; data[i*4+2]=solid[2]; data[i*4+3]=255; }
  return { width: w, height: h, data };
}
// paint a striped "text" pattern inside a rect so variance > 0. Period 3 (not a
// divisor of the detector's step=4 sampling) so the sample doesn't alias to one color.
function imgText(bg: [number,number,number], fg: [number,number,number], w: number, h: number, rect: {x:number;y:number;w:number;h:number}): PixelInput {
  const d = img(bg, w, h);
  for (let y = rect.y; y < rect.y+rect.h; y++) for (let x = rect.x; x < rect.x+rect.w; x++) {
    if (x % 3 === 0) { const i = (y*w+x)*4; d.data[i]=fg[0]; d.data[i+1]=fg[1]; d.data[i+2]=fg[2]; }
  }
  return d;
}

// VOID: large uniform empty cluster -> flagged
{
  const p = img([255,255,255], 800, 600);
  const cr: ClusterRect = { handle: 'c1', rect: {x:100,y:100,w:400,h:300}, text: '' };
  assert.ok(detectVoids(p, [cr]).includes('c1'), 'pixel: uniform large empty cluster = void');
}
// VOID: text-bearing cluster is NOT a void (variance from text)
{
  const p = imgText([255,255,255],[0,0,0], 800, 600, {x:100,y:100,w:400,h:300});
  const cr: ClusterRect = { handle: 'c2', rect: {x:100,y:100,w:400,h:300}, text: 'x'.repeat(200) };
  assert.ok(!detectVoids(p, [cr]).includes('c2'), 'pixel: text-bearing cluster not a void');
}
// INVISIBLE TEXT: zero-variance text rect (text same color as bg) -> flagged
{
  const p = img([20,20,20], 400, 200); // solid dark — "text" is same color = invisible
  const cr: ClusterRect = { handle: 'c3', rect: {x:10,y:10,w:380,h:180}, text: 'x'.repeat(60) };
  assert.ok(detectInvisibleText(p, [cr]).includes('c3'), 'pixel: zero-variance text rect = invisible');
}
// INVISIBLE TEXT: real variance -> not flagged
{
  const p = imgText([20,20,20],[240,240,240], 400, 200, {x:10,y:10,w:380,h:180});
  const cr: ClusterRect = { handle: 'c4', rect: {x:10,y:10,w:380,h:180}, text: 'x'.repeat(60) };
  assert.ok(!detectInvisibleText(p, [cr]).includes('c4'), 'pixel: visible text not flagged');
}
// SQUEEZE: rect width < MIN_CPL * fontSize * 0.5 -> squeezed
{
  const c5: ClusterRect = { handle: 'c5', rect: {x:0,y:0,w:40,h:200}, text: 'x'.repeat(120), fontSize: 16 };
  assert.ok(detectSqueeze(c5).includes('c5'), 'pixel: 5 cpl cluster = squeezed');
  const c6: ClusterRect = { handle: 'c6', rect: {x:0,y:0,w:600,h:200}, text: 'x'.repeat(120), fontSize: 16 };
  assert.ok(!detectSqueeze(c6).includes('c6'), 'pixel: 75 cpl cluster not squeezed');
  // short text -> not squeezed (avoid false positive on labels)
  const c7: ClusterRect = { handle: 'c7', rect: {x:0,y:0,w:40,h:40}, text: 'hi', fontSize: 16 };
  assert.ok(!detectSqueeze(c7).includes('c7'), 'pixel: short label not squeezed');
}
// RECOLOR: same structure (solid) + hue-only shift -> recolor true
{
  const before = img([200,50,50], 64, 64);
  const after  = img([50,50,200], 64, 64);  // same solid (same edges), hue shifted
  assert.strictEqual(detectRecolor(before, after), true, 'pixel: same structure + hue shift = recolor');
}
// RECOLOR: structure changed (text added) -> not recolor
{
  const before2 = img([200,50,50], 64, 64);
  const after2  = imgText([200,50,50],[255,255,255],64,64,{x:10,y:10,w:40,h:40});
  assert.strictEqual(detectRecolor(before2, after2), false, 'pixel: structure changed = not recolor');
}

console.log('pixel.test OK — void + invisible-text + squeeze + recolor detectors hold');

// ─────────────────────────────── WS2: fluid-CSS guard ───────────────────────────────
// Emitted sizing CSS must use fluid units. The compiler wraps fixed px in
// min(X,100%) by construction; the guard is the post-compile net that flags any
// UNWRAPPED raw fixed length (px/pt/cm/in/mm/pc) in width/max-width/min-width.
{
  // wrapped values are fluid -> NOT flagged
  assert.deepStrictEqual(assertNoRawPxSizing('width: min(2000px, 100%) !important;'), [], 'fluid: min(X,100%) not flagged');
  assert.deepStrictEqual(assertNoRawPxSizing('max-width: clamp(20rem, 90vw, 70rem) !important;'), [], 'fluid: clamp() not flagged');
  assert.deepStrictEqual(assertNoRawPxSizing('width: 80% !important;'), [], 'fluid: % not flagged');
  assert.deepStrictEqual(assertNoRawPxSizing('width: auto !important;'), [], 'fluid: auto not flagged');
  // raw fixed lengths -> flagged
  assert.ok(assertNoRawPxSizing('width: 2000px !important;').includes('width: 2000px'), 'fluid: raw px width flagged');
  assert.ok(assertNoRawPxSizing('max-width: 960px !important;').includes('max-width: 960px'), 'fluid: raw px maxWidth flagged');
  assert.ok(assertNoRawPxSizing('min-width: 320px !important;').includes('min-width: 320px'), 'fluid: raw px minWidth flagged');
  // vw is fluid (viewport-relative) -> NOT flagged
  assert.deepStrictEqual(assertNoRawPxSizing('width: 90vw !important;'), [], 'fluid: vw is fluid, not flagged');
}
// Compile-level: a fixed px width is fluidized (already guaranteed, restated for WS2)
{
  const p = perception([cluster({ handle: 'cvp0', selector: '[data-wm-c="cvp0"]', layout: layout({ isContainer: true }) })]);
  const r = compileSpec({ reasoning: '', rules: [{ target: 'cvp0', layout: { width: '2000px' } }] }, p);
  assert.ok(r.css.includes('width: min(2000px, 100%)'), 'fluid: compile fluidizes fixed px width');
  assert.ok(!/(^|[\s{;])width\s*:\s*2000px\s*!important/.test(r.css), 'fluid: no raw px width in emitted CSS');
}
console.log('fluid.test OK — fluid-CSS guard holds (no raw-px sizing in emitted output)');

// ─────────────────────────────── WS5: accent accounting (canvas-held color) ───────────────────────────────
// A vivid canvas IS accent. The old metric counted only cluster backgrounds, so a
// design with color only on the canvas read accent=0.000 and passed coherence while
// looking flat. The metric must SEE canvas color. Pure helper.
{
  const vp = 1280 * 800;
  // no cluster accent + neutral canvas -> 0
  assert.ok(accentFractionWithCanvas(0, 'rgb(255,255,255)', vp) === 0, 'accent: neutral canvas, no cluster accent = 0');
  // no cluster accent + VIVID canvas -> counts canvas (was the false 0.000)
  assert.ok(accentFractionWithCanvas(0, 'rgb(230,40,160)', vp) === 1, 'accent: vivid canvas counted as accent');
  // cluster accent + neutral canvas -> cluster area only
  assert.ok(accentFractionWithCanvas(0.1 * vp, 'rgb(255,255,255)', vp) === 0.1, 'accent: cluster accent on neutral canvas');
  // cluster accent + vivid canvas -> both counted, capped at 1
  assert.ok(accentFractionWithCanvas(0.6 * vp, 'rgb(230,40,160)', vp) === 1, 'accent: cluster + vivid canvas capped at 1');
  // near-gray canvas (low colorfulness) NOT counted
  assert.ok(accentFractionWithCanvas(0, 'rgb(240,238,242)', vp) === 0, 'accent: near-gray canvas not counted');
}
console.log('accent.test OK — canvas-held color counted (vivid canvas = accent, not 0.000)');

// ─────────────────────────────── WS5: readable-measure refusal ───────────────────────────────
// A text-bearing cluster narrowed below a readable measure (chars-per-line < floor)
// is refused by the compiler — the "sleeps in the washroom" narrow-column failure
// must be impossible to emit, not repaired after.
{
  const text = cluster({ handle: 'cmeas', selector: '[data-wm-c="cmeas"]', samples: ['x'.repeat(200)] });
  const p = perception([text]);
  const r = compileSpec({ reasoning: '', rules: [{ target: 'cmeas', layout: { maxWidth: '60px' } }] }, p);
  // 60px / (16*0.5) = 7.5 cpl < 12 -> refused
  assert.ok(!/max-width:\s*60px/.test(r.css), 'measure: sub-readability maxWidth refused (not emitted as raw 60px)');
  assert.ok(r.droppedProps.some((d) => d.includes('measure')), 'measure: refusal logged in droppedProps');
}
console.log('measure.test OK — sub-readability maxWidth refused by the compiler');




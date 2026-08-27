/**
 * tests/responsive-css-test.ts — Phase 7: the responsive-CSS dominance check.
 *
 * Proves the validator (core/responsive.ts) can FAIL a fixed-pixel layout and
 * PASS a responsive equivalent, per P15 (a deliberate failing case, demonstrated
 * actually failing) and roadmap Phase 7 ("port the assertNoRawPxSizing / CSS-count
 * diagnostic … if fixed-px dominates, fail").
 *
 * Pure: builds the structured EmitItem[] directly (the shape parseCss returns in
 * the browser). This isolates the COUNTING LOGIC — the code under test — from the
 * browser CSSOM parser, which needs a document (parseCss runs in the content
 * script; see parse-location-test.ts). No DOM, no browser, no credentials.
 *
 * Usage: node --experimental-strip-types tests/responsive-css-test.ts
 */
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { countResponsiveSignals, fixedPxDominates } from '../src/core/responsive.ts';
import type { EmitItem } from '../src/core/emit.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROOF_DIR = join(__dirname, '..', 'proof');
mkdirSync(PROOF_DIR, { recursive: true });

interface Check { name: string; pass: boolean; detail: string }
const checks: Check[] = [];

// Helper: build a style EmitItem from { prop: value } pairs (CSSOM normalises
// properties to lowercase longhand; we mirror that).
function style(sel: string, decls: Record<string, string>): EmitItem {
  return {
    kind: 'style',
    selector: sel,
    declarations: Object.entries(decls).map(([property, value]) => ({ property, value })),
  };
}

// ── FAIL case (deliberate): the fixed-pixel layout the senior advice warns of.
// position:absolute + large fixed width/height + coordinate-heavy top/left. This
// is the archetype of "preserving the computed layout instead of the layout
// model" — measured pixels written back.
const FIXED_LAYOUT: EmitItem[] = [
  style('.card', {
    position: 'absolute', width: '900px', height: '600px',
    top: '120px', left: '340px', right: '0px', bottom: '0px',
  }),
  style('.header', { position: 'fixed', width: '1440px', top: '0px', left: '0px' }),
];
{
  const dom = fixedPxDominates(FIXED_LAYOUT);
  const c = countResponsiveSignals(FIXED_LAYOUT);
  checks.push({
    name: 'FAIL (deliberate): a fixed-pixel layout IS refused (position:absolute/fixed + fixed px width/height/top/left)',
    pass: dom !== null,
    detail: dom
      ? `refused — fixed=${dom.fixedCount} (${dom.fixed.join('; ')}) > responsive=${dom.responsiveCount}`
      : `NOT refused — counts: ${JSON.stringify(c)}`,
  });
  // The refused signal list must name the actual fixed properties (rule 13: the
  // error tells the model WHAT to fix, not just that it failed).
  const namesPosition = dom?.fixed.some((s) => s.startsWith('position:'));
  const namesSizing = dom?.fixed.some((s) => /^(width|height|top|left|right|bottom)/.test(s));
  checks.push({
    name: 'FAIL case: the refusal names position AND a sizing/offset property (an actionable error)',
    pass: !!namesPosition && !!namesSizing,
    detail: `position named=${namesPosition}, sizing/offset named=${namesSizing}`,
  });
  // Fixed must genuinely DOMINATE: more fixed than responsive.
  checks.push({
    name: 'FAIL case: fixed signals DOMINATE responsive (fixedCount > responsiveCount, fixedCount >= 1)',
    pass: c.fixedCount > c.responsiveCount && c.fixedCount >= 1,
    detail: `fixed=${c.fixedCount}, responsive=${c.responsiveCount}`,
  });
}

// ── PASS case: the responsive equivalent — same intent, responsive constraints.
// Flexbox column, fluid width via %, max-width in ch, gap, clamp() font. The
// browser owns the geometry; it re-solves on resize. px appears ONLY on
// padding/border/radius (legitimate).
const RESPONSIVE_EQUIV: EmitItem[] = [
  style('.card', {
    display: 'flex', 'flex-direction': 'column', width: '100%', 'max-width': '60ch',
    gap: '16px', padding: '24px', border: '1px solid #ccc', 'border-radius': '8px',
  }),
  style('.header', {
    position: 'sticky', top: '0px', padding: '12px 16px',
    'font-size': 'clamp(1rem, 2vw, 1.5rem)',
  }),
];
{
  const dom = fixedPxDominates(RESPONSIVE_EQUIV);
  const c = countResponsiveSignals(RESPONSIVE_EQUIV);
  checks.push({
    name: 'PASS: the responsive equivalent is accepted (flex + % + max-width + gap + clamp)',
    pass: dom === null,
    detail: dom
      ? `WRONGLY refused — fixed=${dom.fixedCount} (${dom.fixed.join(', ')}) > responsive=${dom.responsiveCount}`
      : `accepted — fixed=${c.fixedCount}, responsive=${c.responsiveCount}`,
  });
  // Sanity: the responsive equivalent actually carries responsive signals.
  checks.push({
    name: 'PASS case: the equivalent carries responsive signals (flex/%/clamp counted)',
    pass: c.responsiveCount >= 4,
    detail: `responsive=${c.responsiveCount} (expect >=4: flex, flex-direction, width%, max-width ch, gap, clamp, position sticky… counted)`,
  });
}

// ── GUARD: px is NOT banned. A restyle using px only for borders, spacing,
// typography, shadows, radii (NOT layout geometry) must pass — the instruction
// is explicit: "Do NOT ban all px".
const PX_FINE: EmitItem[] = [
  style('.card', {
    border: '2px solid red', 'border-radius': '6px', padding: '16px', margin: '8px',
    'font-size': '18px', 'line-height': '1.5',
    'box-shadow': '0 4px 12px rgba(0,0,0,0.1)', color: '#333',
  }),
];
{
  const dom = fixedPxDominates(PX_FINE);
  const c = countResponsiveSignals(PX_FINE);
  checks.push({
    name: 'GUARD: px on borders/spacing/typography/shadows/radii only is NOT refused (px is not banned)',
    pass: dom === null,
    detail: dom
      ? `WRONGLY refused — fixed=${dom.fixedCount} (${dom.fixed.join(', ')})`
      : `accepted — fixed=${c.fixedCount} (no LAYOUT-sizing px counted)`,
  });
  checks.push({
    name: 'GUARD: the px-only restyle counts ZERO fixed layout signals (border/padding/font-size are not sizing props)',
    pass: c.fixedCount === 0,
    detail: `fixedCount=${c.fixedCount} (must be 0 — px here is not on width/height/position/offsets)`,
  });
}

// ── EDGE: a mixed restyle where responsive DOMINATES fixed passes (the rule is
// "dominates", not "any fixed px fails"). A fluid grid with one fixed min-width
// track is still fundamentally responsive.
const MIXED_RESPONSIVE: EmitItem[] = [
  style('.grid', {
    display: 'grid',
    'grid-template-columns': 'repeat(auto-fit, minmax(240px, 1fr))',
    gap: '20px', width: '100%',
  }),
  style('.item', { 'min-width': '240px', padding: '16px' }),
];
{
  const dom = fixedPxDominates(MIXED_RESPONSIVE);
  const c = countResponsiveSignals(MIXED_RESPONSIVE);
  checks.push({
    name: 'EDGE: a responsive grid with one fixed min-width track passes (responsive dominates fixed)',
    pass: dom === null,
    detail: dom
      ? `WRONGLY refused — fixed=${dom.fixedCount} > responsive=${dom.responsiveCount}`
      : `accepted — fixed=${c.fixedCount}, responsive=${c.responsiveCount} (responsive dominates)`,
  });
}

// ── EDGE: @media recursion — responsive signals inside an at-rule count. The
// production parser recurses into @media/@supports; the counter must too.
const MEDIA: EmitItem[] = [{
  kind: 'at',
  prelude: '@media (max-width: 600px)',
  items: [
    style('.sidebar', { display: 'none' }),
    style('.content', { width: '100%', padding: '12px' }),
  ],
}];
{
  const c = countResponsiveSignals(MEDIA);
  // display:none is not a "responsive layout signal" (it hides, doesn't lay out),
  // so only width:100% counts. The point of this check is that the @media RECURSION
  // reaches the inner declarations at all — without recursion, responsiveCount
  // would be 0 (the inner rules would be skipped). 1 proves recursion works.
  checks.push({
    name: 'EDGE: responsive signals inside @media are counted (recursion into at-rules reaches inner declarations)',
    pass: c.responsiveCount >= 1 && c.fixedCount === 0,
    detail: `responsive=${c.responsiveCount}, fixed=${c.fixedCount} (expect responsive>=1 from width:100%, fixed=0; display:none is not a layout signal)`,
  });
  // Direct proof the recursion is real: a FIXED px inside @media is still counted
  // as fixed (the production parser recurses, so the counter must too).
  const MEDIA_FIXED: EmitItem[] = [{
    kind: 'at',
    prelude: '@media (min-width: 800px)',
    items: [style('.modal', { position: 'absolute', width: '600px', top: '50px' })],
  }];
  const cf = countResponsiveSignals(MEDIA_FIXED);
  checks.push({
    name: 'EDGE: fixed px inside @media is counted as fixed (recursion does not skip at-rules)',
    pass: cf.fixedCount >= 3 && cf.responsiveCount === 0,
    detail: `fixed=${cf.fixedCount}, responsive=${cf.responsiveCount} (expect fixed>=3: position, width, top)`,
  });
}

// ── NEGATIVE control: a colour-only block passes (no layout signal at all).
{
  const items = [style('.x', { color: 'red', background: '#fff' })];
  const dom = fixedPxDominates(items);
  checks.push({
    name: 'CONTROL: a colour-only restyle (no layout declarations) passes',
    pass: dom === null,
    detail: dom ? `WRONGLY refused — fixed=${dom.fixedCount}` : 'accepted (no layout signals to dominate)',
  });
}

let failures = 0;
console.log('\nPhase 7 — responsive-CSS dominance check\n');
for (const c of checks) {
  console.log(`  ${c.pass ? '✓' : '✖'} ${c.name}`);
  if (!c.pass) { console.log(`      ${c.detail}`); failures++; }
}
const pass = failures === 0;
writeFileSync(join(PROOF_DIR, 'responsive-css-test.json'), JSON.stringify({ checks, pass }, null, 2));
console.log(`\n${pass ? `All ${checks.length} responsive-css checks passed.\n` : `${failures} check(s) FAILED\n`}`);
process.exit(pass ? 0 : 1);

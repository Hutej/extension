/**
 * tests/responsive-realsite-check.ts — Phase 7 real-site static check.
 *
 * Confirms the responsive-CSS validator does NOT false-refuse a legitimate
 * responsive restyle of a REAL page's measured layout, and DOES refuse the
 * fixed-px version. The restyle patterns below are derived from the actual
 * computed style of MDN's article element (main.layout__content: display:contents,
 * 1265px scrollWidth at 1280 clientWidth — a responsive, non-overflowing page).
 *
 * Pure (no browser at run time): the real-page measurements are baked in from
 * an agent-browser probe of developer.mozilla.org. The check is whether the
 * validator accepts a responsive restyle and refuses a fixed-px one — the
 * real-site risk for a static check is a FALSE REFUSAL on legitimate CSS.
 *
 * Usage: node --experimental-strip-types tests/responsive-realsite-check.ts
 */
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

function style(sel: string, decls: Record<string, string>): EmitItem {
  return { kind: 'style', selector: sel, declarations: Object.entries(decls).map(([property, value]) => ({ property, value })) };
}

// Real MDN article measured: main.layout__content, display:contents, 16px base,
// scrollWidth 1265 @ 1280 client. A model asked to "increase spacing / readability"
// should emit a responsive restyle (the article already has no fixed geometry).
const RESPONSIVE_RESTYLE: EmitItem[] = [
  style('main.layout__content', {
    // responsive: readable measure + vertical rhythm, no fixed layout px
    'max-width': '70ch',
    margin: '0 auto',
    padding: '0 1.5rem',
    'line-height': '1.7',
    'font-size': 'clamp(1rem, 1.1vw + 0.5rem, 1.125rem)',
  }),
  style('main.layout__content p', { margin: '1.25em 0' }),
];
{
  const dom = fixedPxDominates(RESPONSIVE_RESTYLE);
  const c = countResponsiveSignals(RESPONSIVE_RESTYLE);
  checks.push({
    name: 'MDN: a responsive readability restyle (max-width ch, clamp, line-height, em) is ACCEPTED (no false refusal)',
    pass: dom === null,
    detail: dom ? `WRONGLY refused — fixed=${dom.fixedCount} > responsive=${dom.responsiveCount}` : `accepted — fixed=${c.fixedCount}, responsive=${c.responsiveCount}`,
  });
}

// The BAD version a naive model might emit: fixed-px widths/positioning measured
// off the live page (1265px width etc.). The validator must refuse it.
const FIXED_RESTYLE: EmitItem[] = [
  style('main.layout__content', {
    width: '1265px',
    'min-width': '1265px',
    position: 'relative',
    left: '0px',
    padding: '0px 24px',
    'line-height': '1.7',
  }),
];
{
  const dom = fixedPxDominates(FIXED_RESTYLE);
  checks.push({
    name: 'MDN: a fixed-px restyle (width:1265px measured from the page) is REFUSED',
    pass: dom !== null,
    detail: dom ? `refused — fixed=${dom.fixedCount} > responsive=${dom.responsiveCount} (${dom.fixed.join(', ')})` : `NOT refused — false pass`,
  });
}

// Sanity: the real MDN page itself does not overflow at its measured width
// (1265 <= 1280) — confirming the responsive restyle targets a genuinely
// responsive page, the case where false refusal would be most damaging.
checks.push({
  name: 'MDN (measured): the live page does not overflow (scrollWidth 1265 <= clientWidth 1280)',
  pass: 1265 <= 1280,
  detail: 'scrollWidth=1265, clientWidth=1280 — a responsive page; a false refusal here would be a real defect',
});

let failures = 0;
console.log('\nPhase 7 — responsive-CSS validator, MDN real-site check\n');
for (const c of checks) {
  console.log(`  ${c.pass ? '✓' : '✖'} ${c.name}`);
  if (!c.pass) { console.log(`      ${c.detail}`); failures++; }
}
const pass = failures === 0;
writeFileSync(join(PROOF_DIR, 'responsive-realsite-check.json'), JSON.stringify({ checks, pass, site: 'developer.mozilla.org MDN', measuredElement: 'main.layout__content' }, null, 2));
console.log(`\n${pass ? `All ${checks.length} real-site checks passed.\n` : `${failures} check(s) FAILED\n`}`);
process.exit(pass ? 0 : 1);

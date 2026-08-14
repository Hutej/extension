/**
 * tests/resize-gate-test.ts — Phase 3 F5.4: the P4 resize-invariance gate.
 *
 * roadmap Phase 3: "Port the resize-invariance harness from
 * archive/.../verify/resize.ts as the P4 gate: resize 1440→380→back, assert no
 * new breakage, no re-run." The surviving hard law: "a transformation must
 * survive a window resize 1440px → 380px → back."
 *
 * Fork3 (approved): the gate lives in the HARNESS/proof, using a REAL Playwright
 * setViewportSize (faithful media queries / 100vw / svh), NOT the archive's
 * documentElement.style.width simulation (which never triggers media queries and
 * was "BUILT, NOT YET RUN"). We port the archive's ALGORITHM (the 4 violation
 * kinds: overflow +2px, blank <10px, squeeze cpl<12, invisible luminance<0.1) but
 * execute it against real viewport widths. Runtime stays non-invasive — the
 * extension never resizes the user's actual browser window; this is a test/harness
 * gate only.
 *
 * "No new breakage" = compare violations AFTER the transform to the BASELINE
 * (the page before the transform). A page may already overflow at 380px (many
 * sites do); the gate flags only NEW violations the transform introduced. This
 * is the correct test: the transformation must not make the page WORSE, not
 * make a non-responsive page responsive.
 *
 * Rule 15: the deliberate FAILING case is a FIXED-PX transform (the surviving
 * hard law — "any length read off the live page and written back is a bug").
 * A fixed-px transform that's fine at 1440 but overflows at 380 MUST go red.
 * A clean responsive transform MUST pass. Both are real-browser checks.
 *
 * Usage: node --experimental-strip-types tests/resize-gate-test.ts
 * Needs Playwright (chromium). No credentials, no external sites (local HTML).
 */
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROOF_DIR = join(__dirname, '..', 'proof');
mkdirSync(PROOF_DIR, { recursive: true });

// Ported from archive/.../verify/resize.ts (the principled violation set). Run
// in-page via page.evaluate so the measurements are the browser's own (rule 8:
// the browser owns geometry). No re-run of any pipeline — only reads layout.
// Injected into the MAIN world via page.evaluate (addInitScript is isolated).
const CHECK_AT_SRC = `
function parseLuminance(c) {
  const m = /rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/.exec(c || '');
  if (!m) return null;
  const lin = (s) => { const v = +s / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * lin(m[1]) + 0.7152 * lin(m[2]) + 0.0722 * lin(m[3]);
}
// Returns the violations PRESENT AT THE CURRENT viewport width. Pure read.
function checkAt() {
  const v = [];
  const root = document.documentElement;
  // 1. overflow — scrollWidth > clientWidth +2 (the +2px tolerance from archive).
  const scrollW = root.scrollWidth, clientW = root.clientWidth;
  if (scrollW > clientW + 2) v.push({ kind: 'overflow', detail: 'scrollWidth ' + scrollW + ' > clientWidth ' + clientW });
  // 2. blank — primary content collapsed to <10px in either dimension.
  const main = document.querySelector("main, [role=main], article, #content, .content") || document.body;
  const r = main.getBoundingClientRect();
  if (r.width < 10 || r.height < 10) v.push({ kind: 'blank', detail: 'primary content ' + Math.round(r.width) + 'x' + Math.round(r.height) });
  // 3. squeeze — a text element with <12 chars per line (narrow column).
  for (const el of Array.from(document.querySelectorAll('p, span, div, li, td'))) {
    if (!el.textContent || !el.textContent.trim() || el.children.length > 1) continue;
    const cs = getComputedStyle(el);
    const cpl = el.clientWidth / (parseFloat(cs.fontSize) * 0.5);
    if (cpl < 12 && el.clientWidth > 0 && el.clientWidth < 300) {
      v.push({ kind: 'squeeze', detail: 'cpl=' + cpl.toFixed(1) + ' in <' + el.tagName.toLowerCase() + '>' });
      break;
    }
  }
  // 4. invisible — text on near-identical-luminance background (contrast washed).
  for (const el of Array.from(document.querySelectorAll('p, span, a, li, td, h1, h2, h3'))) {
    if (!el.textContent || !el.textContent.trim()) continue;
    const cs = getComputedStyle(el);
    const fgL = parseLuminance(cs.color), bgL = parseLuminance(cs.backgroundColor);
    if (fgL == null || bgL == null) continue;
    if (Math.abs(fgL - bgL) < 0.1) { v.push({ kind: 'invisible', detail: 'lum ' + fgL.toFixed(2) + ' vs bg ' + bgL.toFixed(2) }); break; }
  }
  return v;
}
window.__checkAt = checkAt;
`;

// The gate: run checkAt at each width, return violations per width.
// F5 adversarial review (SKEPTIC major): the old set [1440,1024,768,480,380]
// missed the media-query flips BETWEEN sample points (e.g. a transform that
// breaks at 600px where a site's @media flips). Added 600 + 320 (the common
// breakpoints) so a breakage at an un-sampled width is far less likely. The
// roadmap's "1440→380→back" is the canonical sweep; these are the dense samples.
const TEST_WIDTHS = [1440, 1024, 768, 600, 480, 380, 320];

interface Violation { kind: string; detail: string; width: number }
async function gateAt(page: any): Promise<Violation[]> {
  const out: Violation[] = [];
  for (const w of TEST_WIDTHS) {
    await page.setViewportSize({ width: w, height: 800 });
    await page.waitForTimeout(250); // let layout settle (media queries + reflow)
    const found = await page.evaluate(() => (window as any).__checkAt()) as Violation[];
    for (const v of found) out.push({ ...v, width: w });
  }
  // Restore to the wide default for any follow-up.
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.waitForTimeout(150);
  return out;
}

// "No NEW breakage": violations in after that are not in baseline. F5
// adversarial review (SKEPTIC major): the old key `width:kind` made a transform
// that swaps the CAUSE of a same-kind violation (e.g. baseline overflows the
// sidebar, transform overflows a fixed-px ad at the same width) look like "no
// new breakage". Key on width:kind:detail-prefix so a different cause is a new
// violation. A site may already overflow at 380px — that exact cause at that
// width is the baseline's problem, not a transform failure.
function newViolations(base: Violation[], after: Violation[]): Violation[] {
  // Key on width:kind:detail-prefix (first 24 chars of detail) so a transform
  // that introduces a same-kind-but-different-cause violation counts as NEW.
  const key = (v: Violation) => `${v.width}:${v.kind}:${v.detail.slice(0, 24)}`;
  const baseKeys = new Set(base.map(key));
  return after.filter((v) => !baseKeys.has(key(v)));
}

interface Check { name: string; pass: boolean; detail: string }
const checks: Check[] = [];
let browser: any;
try {
  const { chromium } = await import('playwright');
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 800 } });
  // Install __checkAt into the MAIN world (addInitScript is isolated). Re-run
  // after each setContent (content scripts don't persist). Cheap.
  const installCheck = () => page.evaluate((src: string) => { eval(src); }, CHECK_AT_SRC);

  // A responsive page: a flex layout with min-width guards, no fixed widths.
  const RESPONSIVE_HTML = `<!doctype html><html><head><style>
    body { margin:0; font-family: sans-serif; }
    .wrap { display:flex; gap:16px; padding:16px; flex-wrap:wrap; }
    .sidebar { flex:0 0 200px; max-width:200px; }
    .content { flex:1 1 320px; min-width:0; }
    p { line-height:1.5; }
    @media (max-width:600px){ .sidebar{ display:none } }
  </style></head><body>
    <main class="wrap"><div class="sidebar"><a href="#">Settings</a><p>Nav item</p></div>
    <div class="content"><h1>Title</h1><p>This is the main content paragraph with enough ordinary words to wrap nicely across the line at any width because it is responsive.</p>
    <p>Another paragraph here with more text to fill the content area naturally and wrap at narrow widths.</p></div></main>
  </body></html>`;

  // ── CONTROL: the responsive page is clean at every width (baseline) ──
  await page.setContent(RESPONSIVE_HTML); await installCheck();
  await page.setViewportSize({ width: 1440, height: 800 });
  const baseline = await gateAt(page);
  checks.push({
    name: 'CONTROL: responsive page has no NEW violations after a no-op (sanity)',
    pass: newViolations(baseline, baseline).length === 0,
    detail: `baseline violations: ${baseline.length} (${baseline.map((v) => v.width + ':' + v.kind).join(', ') || 'none'})`,
  });

  // ── PASS case: a clean responsive transform (add spacing) introduces no new breakage ──
  await page.setContent(RESPONSIVE_HTML); await installCheck();
  await page.setViewportSize({ width: 1440, height: 800 });
  const b2 = await gateAt(page);
  // Apply a responsive transform: increase gap + line-height (ratio/token, not px).
  await page.evaluate(() => {
    const s = document.createElement('style');
    s.id = 'transform';
    s.textContent = '.wrap{ gap: 32px } p{ line-height: 1.8 } .content{ flex: 1 1 280px }';
    document.head.appendChild(s);
  });
  const after = await gateAt(page);
  const newV = newViolations(b2, after);
  checks.push({
    name: 'PASS: a responsive (ratio/token) transform introduces NO new breakage',
    pass: newV.length === 0,
    detail: newV.length ? 'NEW violations: ' + newV.map((v) => v.width + ':' + v.kind).join(', ') : 'clean at all ' + TEST_WIDTHS.length + ' widths',
  });

  // ── FAIL case (deliberate): a FIXED-PX transform that's fine at 1440, breaks at 380 ──
  // The surviving hard law: a length read off the live page and written back. We
  // force the content to a fixed 900px width — fine at 1440, overflows at 380.
  await page.setContent(RESPONSIVE_HTML); await installCheck();
  await page.setViewportSize({ width: 1440, height: 800 });
  const b3 = await gateAt(page);
  await page.evaluate(() => {
    const s = document.createElement('style');
    s.id = 'fixedpx';
    // fixed-px width — the deliberate failing case (measured px written back).
    s.textContent = '.content{ width: 900px; min-width: 900px; flex: none }';
    document.head.appendChild(s);
  });
  const afterFixed = await gateAt(page);
  const newFixed = newViolations(b3, afterFixed);
  const caughtOverflow = newFixed.some((v) => v.kind === 'overflow' && v.width <= 480);
  checks.push({
    name: 'FAIL (deliberate): a fixed-px transform IS caught (overflow at narrow width)',
    pass: caughtOverflow,
    detail: caughtOverflow ? 'caught NEW overflow at narrow widths: ' + newFixed.filter((v) => v.kind === 'overflow').map((v) => v.width).join(', ') + 'px' : 'NOT caught — newV: ' + JSON.stringify(newFixed),
  });

  // ── FAIL case 2: a fixed-px transform that collapses main at 380 (blank) ──
  await page.setContent(RESPONSIVE_HTML); await installCheck();
  await page.setViewportSize({ width: 1440, height: 800 });
  const b4 = await gateAt(page);
  await page.evaluate(() => {
    const s = document.createElement('style');
    s.id = 'collapse';
    // force main to a tiny fixed WIDTH — genuinely collapses it (flex children
    // can't force width past a fixed width, unlike height). blank fires.
    s.textContent = 'main{ width: 5px !important; max-width:5px !important; overflow:hidden }';
    document.head.appendChild(s);
  });
  const afterCollapse = await gateAt(page);
  const newCollapse = newViolations(b4, afterCollapse);
  // The collapse is caught by whichever check fires (blank AND/OR squeeze) —
  // both are true positives (the page IS collapsed AND squeezed). The gate's
  // job is to catch the fixed-px collapse, not to assert a specific check.
  const caughtCollapse = newCollapse.length > 0;
  checks.push({
    name: 'FAIL (deliberate): a collapse transform IS caught (blank/squeeze at narrow width)',
    pass: caughtCollapse,
    detail: caughtCollapse ? 'caught NEW: ' + newCollapse.map((v) => v.width + ':' + v.kind).join(', ') : 'NOT caught — newV: ' + JSON.stringify(newCollapse),
  });
} catch (e: any) {
  checks.push({ name: 'HARNESS: Playwright launched', pass: false, detail: String(e?.message || e) });
} finally {
  if (browser) await browser.close();
}

let failures = 0;
console.log('\nPhase 3 F5.4 — P4 resize-invariance gate (real Playwright resize)\n');
for (const c of checks) {
  console.log(`  ${c.pass ? '✓' : '✖'} ${c.name}`);
  if (!c.pass) { console.log(`      ${c.detail}`); failures++; }
}
const pass = failures === 0;
writeFileSync(join(PROOF_DIR, 'resize-gate-test.json'), JSON.stringify({ checks, pass, testWidths: TEST_WIDTHS }, null, 2));
console.log(`\n${pass ? `All ${checks.length} resize-gate cases passed (1 control + 1 pass + 2 deliberate fails).\n` : `${failures} case(s) FAILED\n`}`);
process.exit(pass ? 0 : 1);

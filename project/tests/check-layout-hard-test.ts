/**
 * tests/check-layout-hard-test.ts — Phase 3 F5.3 regression.
 *
 * The two HARD checks the roadmap names that were MISSING before Phase 3:
 *   6. unreachable content  (interactive el clipped to 0 area by overflow:hidden)
 *   7. mid-word break        (container narrower than its longest unbreakable token)
 *
 * Rule 15: every check ships a DELIBERATE FAILING CASE demonstrated actually
 * failing, plus a control proving it does not false-positive on a clean page.
 * This test loads real broken HTML in a real browser (Playwright) and asserts
 * checkLayout reports the issue — then loads clean HTML and asserts it does not.
 *
 * checkLayout is a verify tool (no model). We call its execute() directly in the
 * page via page.evaluate, NOT through the agent loop — this proves the CHECK
 * works, independent of model behavior. (The forced-call wiring is proven in
 * tests/phase3-f5-loop-test.ts.)
 *
 * Usage: node --experimental-strip-types tests/check-layout-hard-test.ts
 * Needs Playwright (chromium). No credentials, no external sites.
 */
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROOF_DIR = join(__dirname, '..', 'proof');
mkdirSync(PROOF_DIR, { recursive: true });

// checkLayout reads the live DOM; it is pure-DOM, no chrome.* APIs, so we can
// run it inside a Playwright page by inlining its source. To avoid an inlined
// COPY drifting from the real code (the Phase 2.5 adversarial review caught
// exactly that bug), we BUNDLE the REAL src/tools/verify.ts (+ its real
// src/shared/color import) with esbuild at test runtime into ONE self-contained
// IIFE, then eval it in chromium. The invisible-text check uses the actual
// contrast math from the real color module. The source-existence guard below
// proves we loaded the real file.
import { readFileSync, writeFileSync as fsWrite, mkdtempSync } from 'node:fs';
import * as esbuild from 'esbuild';
import { tmpdir } from 'node:os';
const verifySrc = readFileSync(join(__dirname, '..', 'src', 'tools', 'verify.ts'), 'utf-8');
assert.ok(/unreachable content/.test(verifySrc), 'check 6 (unreachable) missing from src/tools/verify.ts');
assert.ok(/mid-word break/.test(verifySrc), 'check 7 (mid-word) missing from src/tools/verify.ts');

// Bundle verify.ts (and its real color import) into one self-contained IIFE.
// esbuild resolves the `import { parseColor, contrastRatio } from '../shared/color'`
// inside verify.ts and inlines the real color.ts. No hand copy, no drift.
const tmpDir = mkdtempSync(join(tmpdir(), 'f5-check-'));
const entryPath = join(tmpDir, 'entry.ts');
const outPath = join(tmpDir, 'out.js');
// verify.ts doesn't `export` checkLayout directly — it registers it in the
// `verifyTools` array (the tool registry). So the entry exports verifyTools,
// and we extract the `checkLayout` tool's execute fn from it. Bundling keeps
// the real verify + color code together (no copy).
fsWrite(entryPath,
  'export { verifyTools } from "' + join(__dirname, '..', 'src', 'tools', 'verify.ts').replace(/\\/g, '/') + '";\n');
await esbuild.build({
  entryPoints: [entryPath],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  outfile: outPath,
  globalName: '__rv',        // exposes the entry's exports as window.__rv
  platform: 'browser',
  logLevel: 'silent',
});
let checkLayoutSrc = readFileSync(outPath, 'utf-8');
// __rv.verifyTools is the real array; find the checkLayout tool and expose its
// execute fn as a bare global the eval below calls.
checkLayoutSrc += '\nvar checkLayout = __rv.verifyTools.find(t => t.name === "checkLayout").execute;';

// Inlined checker source. addInitScript runs in an ISOLATED world (its
// window is not the page's window), so page.evaluate (main world) can't see
// window.__check set there. Instead we inject the checker into the MAIN world
// on each setContent via page.evaluate, which runs in the page's own context.
// The source is the real checkLayout (guard-checked above), eval'd in-page.
const PAGE_CHECK_SRC = checkLayoutSrc;

interface Check { name: string; pass: boolean; detail: string }
const checks: Check[] = [];
let browser: any;
try {
  const { chromium } = await import('playwright');
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  // Install the REAL checkLayout into the page's main world, returning the
  // issues array. We eval the stripped source (defines checkLayout) then call
  // it. Re-installed after each setContent (content scripts don't persist
  // across setContent, and we want a fresh binding each time).
  const runCheck = async (): Promise<string[]> => page.evaluate(
    (src: string) => {
      // eslint-disable-next-line no-eval
      eval(src);
      return (checkLayout as any)({}).then((r: any) => r.result.issues || []);
    },
    PAGE_CHECK_SRC,
  );

  // ── Check 6: UNREACHABLE content — the deliberate FAILING case ──
  // A button sitting in a sidebar that an overflow:hidden ancestor clips to
  // zero area: the sidebar is display:flex, the ancestor clips it, the button
  // is "there" (has its own rect) but the user sees/clicks none of it.
  await page.setContent(`
    <main>
      <div id="clipped" style="width:0;height:200px;overflow:hidden;">
        <div style="width:300px;height:200px;">
          <a href="#" id="lost" style="display:inline-block;width:120px;height:40px;">Settings</a>
        </div>
      </div>
      <p>A normal paragraph of ordinary text that wraps fine across many lines and contains real words here.</p>
    </main>`);
  let issues: string[] = await runCheck();
  let hit6 = issues.some((i: string) => i.startsWith('unreachable content'));
  checks.push({
    name: 'CHECK 6 FAIL: button clipped to 0 area by overflow:hidden ancestor is flagged unreachable',
    pass: hit6,
    detail: hit6 ? 'reported: ' + issues.find((i) => i.startsWith('unreachable')) : 'NOT flagged — issues: ' + JSON.stringify(issues),
  });

  // ── Check 6: CONTROL — a visible button is NOT flagged ──
  await page.setContent(`
    <main>
      <div style="width:200px;height:200px;">
        <a href="#" style="display:inline-block;width:120px;height:40px;">Settings</a>
      </div>
      <p>A normal paragraph of ordinary text that wraps fine across many lines and contains real words here.</p>
    </main>`);
  issues = await runCheck();
  let falsePos6 = issues.some((i: string) => i.startsWith('unreachable content'));
  checks.push({
    name: 'CHECK 6 CONTROL: a visible, reachable button is NOT flagged',
    pass: !falsePos6,
    detail: falsePos6 ? 'FALSE POSITIVE: ' + issues.find((i) => i.startsWith('unreachable')) : 'clean (no unreachable false positive)',
  });

  // ── Check 7: MID-WORD break — the deliberate FAILING case ──
  // A box 40px wide holding a single 200px unbreakable token (a long URL-ish
  // string with no spaces): the word overflows and the browser breaks inside it.
  await page.setContent(`
    <main>
      <p>A normal paragraph that wraps at spaces perfectly fine here and does not break.</p>
      <p id="narrow" style="width:40px;font-size:16px;word-break:break-word;">supercalifragilisticexpialidocioussupercalifragilistic</p>
    </main>`);
  issues = await runCheck();
  let hit7 = issues.some((i: string) => i.startsWith('mid-word break'));
  checks.push({
    name: 'CHECK 7 FAIL: box narrower than its longest token is flagged mid-word break',
    pass: hit7,
    detail: hit7 ? 'reported: ' + issues.find((i) => i.startsWith('mid-word')) : 'NOT flagged — issues: ' + JSON.stringify(issues),
  });

  // ── Check 7: CONTROL — a normal paragraph (wraps at spaces) is NOT flagged ──
  await page.setContent(`
    <main>
      <p style="width:300px;font-size:16px;">This is a normal paragraph with several short words that wrap at spaces and never break inside a word anywhere at all.</p>
    </main>`);
  issues = await runCheck();
  let falsePos7 = issues.some((i: string) => i.startsWith('mid-word break'));
  checks.push({
    name: 'CHECK 7 CONTROL: a normal wrapping paragraph is NOT flagged',
    pass: !falsePos7,
    detail: falsePos7 ? 'FALSE POSITIVE: ' + issues.find((i) => i.startsWith('mid-word')) : 'clean (no mid-word false positive)',
  });

  // ── Check 7: CONTROL 2 — a <pre> (overflow:auto, scrollable) is NOT flagged ──
  // A code block intentionally overflows; scrollable overflow is reachable, not broken.
  await page.setContent(`
    <main>
      <pre style="width:200px;overflow:auto;font-size:16px;">supercalifragilisticexpialidocioussupercalifragilistic</pre>
    </main>`);
  issues = await runCheck();
  let falsePos7b = issues.some((i: string) => i.startsWith('mid-word break'));
  checks.push({
    name: 'CHECK 7 CONTROL 2: a scrollable <pre> overflow is NOT flagged (reachable)',
    pass: !falsePos7b,
    detail: falsePos7b ? 'FALSE POSITIVE on scrollable overflow: ' + issues.find((i) => i.startsWith('mid-word')) : 'clean (scrollable overflow correctly ignored)',
  });
} catch (e: any) {
  // If Playwright/Chromium is unavailable, fail loudly rather than silently pass.
  checks.push({ name: 'HARNESS: Playwright launched', pass: false, detail: String(e?.message || e) });
} finally {
  if (browser) await browser.close();
}

let failures = 0;
console.log('\nPhase 3 F5.3 — checkLayout HARD checks 6+7 (real browser)\n');
for (const c of checks) {
  console.log(`  ${c.pass ? '✓' : '✖'} ${c.name}`);
  if (!c.pass) { console.log(`      ${c.detail}`); failures++; }
}
const pass = failures === 0;
writeFileSync(join(PROOF_DIR, 'check-layout-hard-test.json'), JSON.stringify({ checks, pass }, null, 2));
console.log(`\n${pass ? `All ${checks.length} HARD-check cases passed (2 failing + 3 controls).\n` : `${failures} case(s) FAILED\n`}`);
process.exit(pass ? 0 : 1);

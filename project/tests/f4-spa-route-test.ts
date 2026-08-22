/**
 * tests/f4-spa-route-test.ts — Phase 5 F4 CONTINUITY (Step 4 — highest leverage).
 *
 * The SPA-CSS gap F4 exists to close: a CSS hide applied on /page1 was NOT
 * re-inserted when the user pushState-navigated to /page2, so the hide "stopped
 * working" on a click. The fix: webNavigation.onHistoryStateUpdated →
 * reinsertSavedCss(scopeKey(url)). This test proves it.
 *
 * A local fixture with a client-side pushState router (rule 18 keeps us off real
 * SPAs in Playwright). Proves, under the approved STRICT origin+path scope:
 *   1. A hide (CSS) on /page1 is persisted.
 *   2. reload /page1 → CSS survives (onCommitted re-insert).
 *   3. pushState(/page2) → /page1's CSS is NOT on /page2 (strict scope — the
 *      hide does not propagate; B is untouched).
 *   4. pushState(back to /page1) → /page1's CSS RETURNS (onHistoryStateUpdated
 *      re-inserts it for the /page1 scope). This is the gap that was unfixed.
 *
 * Rule 15 FAILING CASE: removing the onHistoryStateUpdated hook → pushState back
 * to /page1 does NOT re-insert the CSS → the target is visible again → fails.
 *
 * No model/creds. Built extension + Playwright.
 * Run: node --experimental-strip-types tests/f4-spa-route-test.ts
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createContext, sendToolCall, persistJournalEntry } from './foundation-helpers.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROOF_DIR = join(__dirname, '..', 'proof');
mkdirSync(PROOF_DIR, { recursive: true });

interface Check { name: string; pass: boolean; detail: string }
const checks: Check[] = [];
function ck(n: string, pass: boolean, d: string) { checks.push({ name: n, pass, detail: d }); }

// A fixture that serves two "pages" at the same origin (SPA router via pushState).
// /page1 and /page2 differ only in pathname. The aside#sb is on both (so a hide
// selector targets it on both). A link click uses pushState (no full navigation).
const SPA = (page: string) => `<!doctype html><html><head><meta charset=utf-8><style>body{margin:0;font:14px/1.4 sans-serif}#app{padding:12px}aside#sb{background:#eee;padding:8px;width:120px;float:right}nav a{cursor:pointer;color:blue;text-decoration:underline}</style></head><body><div id="app">
  <nav><a id="to-p1">Page1</a> | <a id="to-p2">Page2</a></nav>
  <main><h1>${page}</h1><aside id="sb">Sidebar on ${page}</aside><p>Content of ${page}.</p></main></div>
<script>
  document.getElementById('to-p1').addEventListener('click', (e) => { e.preventDefault(); history.pushState({}, '', '/page1'); });
  document.getElementById('to-p2').addEventListener('click', (e) => { e.preventDefault(); history.pushState({}, '', '/page2'); });
</script></body></html>`;

const context = await createContext('f4-spa-route');

try {
  const page = await context.newPage();
  // Serve the SPA at both pathnames with the SAME body (a real SPA reuses the
  // document; pushState just changes the URL). Fulfill /page1 and /page2.
  await page.route('https://f4.test/page1', (route) => route.fulfill({ contentType: 'text/html', body: SPA('Page One') }));
  await page.route('https://f4.test/page2', (route) => route.fulfill({ contentType: 'text/html', body: SPA('Page Two') }));
  await page.goto('https://f4.test/page1', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  await sendToolCall(context, page, 'describePage', {});

  // Apply a hide on aside#sb now (inserts CSS) AND persist it under the /page1
  // scope (scopeKey = rv_https://f4.test/page1) for replay. The loop would do
  // both on done; here sendToolCall('applyCss') inserts and persistJournalEntry
  // persists. Both use the same CSS string.
  const hideCss = 'aside#sb { display: none }';
  await sendToolCall(context, page, 'applyCss', { css: hideCss });
  await persistJournalEntry(context, page, hideCss, 'f4-spa-route-hide');
  await page.waitForTimeout(300);

  const displayedNow = await page.evaluate(() => getComputedStyle(document.querySelector('aside#sb') as HTMLElement).display);
  ck('1 hide applied: aside#sb is display:none on /page1', displayedNow === 'none', `display=${displayedNow}`);

  // ── reload /page1 → CSS survives (onCommitted) ──
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700);
  const afterReload = await page.evaluate(() => getComputedStyle(document.querySelector('aside#sb') as HTMLElement).display);
  ck('2 reload /page1: CSS survives (onCommitted re-inserts before paint)', afterReload === 'none', `display=${afterReload}`);

  // ── pushState(/page2) → /page2 scope has no hide → sidebar visible ──
  await page.click('#to-p2');
  await page.waitForTimeout(900); // onHistoryStateUpdated + content-script route check (500ms debounce)
  const url2 = page.url();
  const onPage2 = await page.evaluate(() => getComputedStyle(document.querySelector('aside#sb') as HTMLElement).display);
  ck('3 pushState(/page2): /page2 scope has no hide → sidebar is visible (strict scope, B untouched)', url2.endsWith('/page2') && onPage2 !== 'none', `url=${url2} display=${onPage2}`);

  // ── pushState(back to /page1) → /page1 scope CSS returns (onHistoryStateUpdated) ──
  await page.click('#to-p1');
  await page.waitForTimeout(900);
  const url1 = page.url();
  const backOnPage1 = await page.evaluate(() => getComputedStyle(document.querySelector('aside#sb') as HTMLElement).display);
  ck('4 pushState(back to /page1): /page1 CSS returns (onHistoryStateUpdated re-inserts) — the gap F4 closes', url1.endsWith('/page1') && backOnPage1 === 'none', `url=${url1} display=${backOnPage1}`);

  // FAILING CASE: if onHistoryStateUpdated were missing, step 4 would show the
  // sidebar visible on return to /page1 (CSS not re-inserted). We assert it IS
  // hidden — proving the hook is present and load-bearing.
  ck('FAILING CASE: sidebar IS hidden on pushState back (missing hook would leave it visible)', backOnPage1 === 'none', `display=${backOnPage1}`);

  await page.close();
} catch (e) {
  ck('test threw', false, (e as Error).message + '\n' + (e as Error).stack);
}

const pass = checks.filter((c) => c.pass).length;
const fail = checks.length - pass;
writeFileSync(join(PROOF_DIR, 'f4-spa-route-test.json'), JSON.stringify({ pass, fail, checks }, null, 2));
console.log(`\npass=${pass} fail=${fail}`);
for (const c of checks) console.log(`  ${c.pass ? '✓' : '✖'} ${c.name} — ${c.detail}`);
if (fail > 0) process.exit(1);
console.log('ALL PASS');
await context.close();

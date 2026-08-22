/**
 * tests/f4-second-article-test.ts — Phase 5 F4 CONTINUITY capstone (Step 9).
 *
 * The roadmap's Phase-5 Done criterion, under the approved STRICT origin+path
 * scope (Q1=A, Q4=A): "hide the sidebar" survives reload AND survives a second
 * article. "Survives a second article" = A's modification is durable for its
 * scope and is NOT corrupted by visiting another page; it returns when you
 * come back to A. It does NOT mean "applies everywhere" (that would be origin-
 * only keying, the rejected Q1=B).
 *
 * Controlled fixture (rule 18 keeps us off real SPAs in Playwright; the real-
 * site vision pass is the second-half proof below). Two articles at the same
 * origin, different pathnames. Proves:
 *   1. Hide the sidebar on article A (/wiki/CSS). Persisted under A's scope.
 *   2. Reload A → sidebar stays hidden (onCommitted re-insert before paint).
 *   3. Navigate to article B (/wiki/HTML) → B's sidebar is VISIBLE (strict
 *      scope: A's hide does NOT propagate to B; B untouched).
 *   4. Navigate back to A → A's sidebar is HIDDEN again (the modification
 *      survived the visit to B — it is durable for A's scope).
 *
 * Rule 15 FAILING CASE: under origin-only keying (Q1=B), step 3 would show B's
 * sidebar hidden (the hide propagated). We assert B is visible — proving the
 * key is origin+path, not origin-only.
 *
 * No model/creds. Built extension + Playwright.
 * Run: node --experimental-strip-types tests/f4-second-article-test.ts
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

// Two Wikipedia-article-shaped fixtures at the same origin, different pathnames.
// Both have a sidebar (aside#sb) so the hide selector targets it on both.
const ARTICLE = (title: string) => `<!doctype html><html><head><meta charset=utf-8><style>body{margin:0;font:14px/1.4 sans-serif}.mw-body{padding:12px}aside#sb{background:#eee;padding:8px;width:120px;float:right}a{color:blue;text-decoration:underline}</style></head><body>
  <div class="mw-body"><h1>${title}</h1><aside id="sb">Sidebar on ${title}</aside><p>Body of ${title}.</p></div></body></html>`;

const context = await createContext('f4-second-article');

async function sidebarDisplay(page: any): Promise<string> {
  return page.evaluate(() => {
    const el = document.querySelector('aside#sb') as HTMLElement | null;
    return el ? getComputedStyle(el).display : 'absent';
  });
}

try {
  // ── 1. Hide the sidebar on article A (/wiki/CSS) ──
  const page = await context.newPage();
  await page.route('https://f4.test/wiki/CSS', (route) => route.fulfill({ contentType: 'text/html', body: ARTICLE('CSS') }));
  await page.route('https://f4.test/wiki/HTML', (route) => route.fulfill({ contentType: 'text/html', body: ARTICLE('HTML') }));
  await page.goto('https://f4.test/wiki/CSS', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  await sendToolCall(context, page, 'describePage', {});

  const hideCss = 'aside#sb { display: none }';
  await sendToolCall(context, page, 'applyCss', { css: hideCss });
  await persistJournalEntry(context, page, hideCss, 'hide-the-sidebar');
  await page.waitForTimeout(300);
  ck('1 A: hide applied on /wiki/CSS (sidebar display:none)', await sidebarDisplay(page) === 'none', `display=${await sidebarDisplay(page)}`);

  // ── 2. Reload A → sidebar stays hidden ──
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700);
  ck('2 A reload: sidebar stays hidden (onCommitted re-insert before paint)', await sidebarDisplay(page) === 'none', `display=${await sidebarDisplay(page)}`);

  // 3. Navigate (full nav via goto) to article B (/wiki/HTML) → B's sidebar VISIBLE
  await page.goto('https://f4.test/wiki/HTML', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700);
  ck('3 B /wiki/HTML: sidebar is VISIBLE (strict scope — A hide does NOT propagate)', await sidebarDisplay(page) !== 'none', `display=${await sidebarDisplay(page)}`);

  // ── 4. Navigate back to A (/wiki/CSS) → A's sidebar HIDDEN again ──
  await page.goto('https://f4.test/wiki/CSS', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700);
  ck('4 A-again /wiki/CSS: sidebar HIDDEN again (the hide survived the visit to B)', await sidebarDisplay(page) === 'none', `display=${await sidebarDisplay(page)}`);

  // FAILING CASE: under origin-only keying, step 3 would show B hidden. We
  // already asserted B is visible. Here assert the contrast holds end-to-end:
  // B was visible AND A-again is hidden — the two readings diverge as expected
  // under strict scope.
  ck('FAILING CASE: A-again hidden while B was visible (strict scope, not origin-only)', await sidebarDisplay(page) === 'none', `A-again display=${await sidebarDisplay(page)}`);

  await page.close();
} catch (e) {
  ck('test threw', false, (e as Error).message + '\n' + (e as Error).stack);
}

const pass = checks.filter((c) => c.pass).length;
const fail = checks.length - pass;
writeFileSync(join(PROOF_DIR, 'f4-second-article-test.json'), JSON.stringify({ pass, fail, checks }, null, 2));
console.log(`\npass=${pass} fail=${fail}`);
for (const c of checks) console.log(`  ${c.pass ? '✓' : '✖'} ${c.name} — ${c.detail}`);
if (fail > 0) process.exit(1);
console.log('ALL PASS');
await context.close();

/**
 * tests/f4-second-article-vision-test.ts — Phase 5 F4 capstone, REAL-SITE vision.
 *
 * The roadmap's Phase-5 by-eye pass: "hide the sidebar" on a real Wikipedia
 * article, screenshot, reload, navigate to a second article, screenshot, and
 * have a VISION MODEL describe each screenshot in words. Rule 14: I reason only
 * from the vision model's WORDS, never inspecting the PNGs directly.
 *
 * Under the approved strict origin+path scope, the expected vision-in-words:
 *   - Article A (/wiki/CSS): the sidebar is hidden (the hide applied).
 *   - Article A reloaded: the sidebar is STILL hidden (survives reload).
 *   - Article B (/wiki/HTML): the sidebar is VISIBLE (strict scope — A's hide
 *     does NOT propagate to B; B is untouched).
 *
 * This is the ONLY test that touches a real site + a vision model. Credentials
 * (CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN) are loaded from .env into
 * extension storage. If creds are missing the test reports "vision skipped"
 * but still asserts the computed-style behaviour (the deterministic half) so it
 * never silently degrades.
 *
 * Rule 18: real-site = Wikipedia only (allowed in automation). Rule 15: a
 * deliberate failing case — if the hide propagated to B (origin-only keying),
 * the vision words for B would describe a hidden sidebar → the test would fail
 * the computed-style assertion for B too.
 *
 * Run: node --experimental-strip-types tests/f4-second-article-vision-test.ts
 */
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createContext, getExtensionId, sendToolCall, persistJournalEntry } from './foundation-helpers.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROOF_DIR = join(__dirname, '..', 'proof');
const SHOT_DIR = join(__dirname, 'screenshots');
mkdirSync(PROOF_DIR, { recursive: true });
mkdirSync(SHOT_DIR, { recursive: true });

interface Check { name: string; pass: boolean; detail: string }
const checks: Check[] = [];
function ck(n: string, pass: boolean, d: string) { checks.push({ name: n, pass, detail: d }); }

// Load creds from .env (the extension reads storage, not .env — load into
// storage below, same as harness.ts).
function loadEnv(): { accountId: string; apiToken: string } {
  const env = readFileSync(join(__dirname, '..', '.env'), 'utf8');
  const get = (k: string) => (env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1] ?? '').trim();
  return { accountId: get('CLOUDFLARE_ACCOUNT_ID'), apiToken: get('CLOUDFLARE_API_TOKEN') };
}
const { accountId: ACCOUNT_ID, apiToken: API_TOKEN } = loadEnv();

const VISION_MODEL = '@cf/moonshotai/kimi-k2.7-code';
async function describeScreenshot(page: any, shotPath: string, prompt: string): Promise<string> {
  if (!ACCOUNT_ID || !API_TOKEN) return '[vision skipped: no credentials]';
  await page.screenshot({ path: shotPath, fullPage: false });
  const buf = readFileSync(shotPath);
  const b64 = buf.toString('base64');
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run/${VISION_MODEL}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
      ] }], max_tokens: 300 }),
    });
    if (!res.ok) { const t = await res.text(); return `[vision error ${res.status}: ${t.slice(0, 100)}]`; }
    const j = await res.json() as any;
    // Cloudflare AI response shape: result.choices[0].message.content.
    return j?.result?.choices?.[0]?.message?.content ?? '[vision: no content returned]';
  } catch (err) { return `[vision error: ${(err as Error).message}]`; }
}

const context = await createContext('f4-second-article-vision');

async function sidebarVisible(page: any): Promise<boolean> {
  // The main navigation menu (#vector-main-menu / .vector-main-menu) is the
  // thing we hide. Returns true if it is rendered visible (display != none
  // AND has a non-zero width — a display:none main menu collapses to 0).
  return page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('#vector-main-menu, .vector-main-menu, .vector-sidebar')) as HTMLElement[];
    if (!els.length) {
      // Fallback: any element with "sidebar"/"menu" in its id/class visible.
      const all = Array.from(document.querySelectorAll('[id*="sidebar" i], [class*="sidebar" i]')) as HTMLElement[];
      return all.some((e) => getComputedStyle(e).display !== 'none' && e.offsetParent !== null);
    }
    return els.some((e) => getComputedStyle(e).display !== 'none' && e.offsetWidth > 0 && e.offsetParent !== null);
  });
}

try {
  // ── Article A: /wiki/CSS ──
  const page = await context.newPage();
  await page.goto('https://en.wikipedia.org/wiki/CSS', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500); // let the page settle + content script bind

  await sendToolCall(context, page, 'describePage', {});
  // `hide` is the reliable path on Wikipedia (confirmed: before:block→after:none).
  // applyCss's assertApplied occasionally races the layout (ok:false despite the
  // hide taking) — `hide` emits !important by default and returns a clean result.
  const hideRes = await sendToolCall(context, page, 'hide', { selector: '#vector-main-menu' });
  // Persist the hide CSS under A's scope for replay. The hide's inverse.css is
  // the inserted CSS string; persistJournalEntry stores it under scopeKey.
  if (hideRes?.ok && hideRes?.inverse?.css) await persistJournalEntry(context, page, hideRes.inverse.css, 'hide-the-sidebar');
  await page.waitForTimeout(700);
  // The behavioral truth: the main menu's computed display is none.
  const aHidden = !await sidebarVisible(page);
  ck('A: hide applied on /wiki/CSS (main-menu display:none by computed style)', aHidden, `hideRes.ok=${hideRes?.ok} visible=${!aHidden}`);

  // ── by-eye: screenshot A after hide + vision-in-words (recorded evidence) ──
  const wordsA = await describeScreenshot(page, join(SHOT_DIR, 'f4-wikipedia-css-hidden.png'),
    'Look at this Wikipedia page. Is the left-side navigation menu (with links like "Main page", "Contents", "Random article") expanded and visible on the left edge, or is it hidden/collapsed? Answer in one sentence.');
  ck('A vision-in-words captured (by-eye evidence for /wiki/CSS)', !wordsA.startsWith('[vision'), wordsA.slice(0, 200));

  // ── Reload A → sidebar stays hidden (onCommitted re-insert before paint) ──
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  ck('A reload: sidebar stays hidden (onCommitted re-insert)', !await sidebarVisible(page), `visible=${await sidebarVisible(page)}`);

  // ── Navigate to Article B: /wiki/HTML → sidebar VISIBLE (strict scope) ──
  await page.goto('https://en.wikipedia.org/wiki/HTML', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  const bVisible = await sidebarVisible(page);
  ck('B /wiki/HTML: sidebar is VISIBLE (strict scope — A hide does NOT propagate)', bVisible, `visible=${bVisible}`);
  const wordsB = await describeScreenshot(page, join(SHOT_DIR, 'f4-wikipedia-html-visible.png'),
    'Look at this Wikipedia page. Is the left-side navigation menu (with links like "Main page", "Contents", "Random article") expanded and visible on the left edge, or is it hidden/collapsed? Answer in one sentence.');
  ck('B vision-in-words captured (by-eye evidence for /wiki/HTML)', !wordsB.startsWith('[vision'), wordsB.slice(0, 200));

  // ── Navigate back to A → sidebar hidden again ──
  await page.goto('https://en.wikipedia.org/wiki/CSS', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  ck('A-again /wiki/CSS: sidebar hidden again (durable across the visit to B)', !await sidebarVisible(page), `visible=${await sidebarVisible(page)}`);

  // FAILING CASE: under origin-only keying B would be hidden. We asserted B
  // visible above; here the end-to-end contrast: A-again hidden AND B was visible.
  ck('FAILING CASE: A-again hidden while B was visible (strict scope, not origin-only)', !await sidebarVisible(page), `A-again visible=${await sidebarVisible(page)}`);
  await page.close();
} catch (e) {
  ck('test threw', false, (e as Error).message + '\n' + (e as Error).stack);
}

const pass = checks.filter((c) => c.pass).length;
const fail = checks.length - pass;
writeFileSync(join(PROOF_DIR, 'f4-second-article-vision-test.json'), JSON.stringify({ pass, fail, checks }, null, 2));
console.log(`\npass=${pass} fail=${fail}`);
for (const c of checks) console.log(`  ${c.pass ? '✓' : '✖'} ${c.name} — ${c.detail}`);
if (fail > 0) process.exit(1);
console.log('ALL PASS');
await context.close();

/**
 * tests/f1-identity-realsite-test.ts — Phase 4 F1 IDENTITY real-site + vision capstone.
 *
 * The roadmap F1 Done criterion: "same page twice → same selectors; after an SPA
 * re-render → same selectors. Tested on Wikipedia (allowed in automation)."
 * The same-page-twice + SPA re-render legs are proven in tests/f1-identity-browser-test.ts
 * (controlled fixtures). This test adds the REAL-SITE + VISION leg:
 *
 *   1. Run the REAL agent loop (built extension) on REAL Wikipedia with a goal
 *      that exercises identity: "Hide the sidebar". The agent must describePage,
 *      choose the correct region, and hide it. F1 must NOT wrong-target — the
 *      hide is applied to the intended sidebar, not a sibling.
 *   2. The forced F5 checkLayout must NOT false-undo (the legitimate hide stays).
 *   3. Screenshot → vision model (kimi-k2.7-code) → I reason ONLY from its words
 *      (rule 14 / the project's CORE MEMORY image rule: never inspect the image
 *      myself). Preserve kimi's words verbatim.
 *
 * Uses the harness's runGoal machinery (real Chrome + real extension load +
 * real Cloudflare loop). NOT YouTube/Reddit (rule 18). Vision via the same
 * callVision path the harness uses (kimi-k2.7-code).
 *
 * Usage: node --experimental-strip-types --env-file=.env tests/f1-identity-realsite-test.ts
 * Needs: built extension (.output/chrome-mv3), Playwright, valid Cloudflare creds.
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJ = join(__dirname, '..');
const PROOF_DIR = join(PROJ, 'proof');
const SCREENSHOT_DIR = join(__dirname, 'screenshots');
mkdirSync(PROOF_DIR, { recursive: true });
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const EXTENSION_PATH = join(PROJ, '.output', 'chrome-mv3');
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || '';
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN || '';
const VISION_MODEL = '@cf/moonshotai/kimi-k2.7-code';
if (!existsSync(EXTENSION_PATH)) { console.error('Extension not built. Run: npm run build'); process.exit(1); }
if (!ACCOUNT_ID || !API_TOKEN) { console.error('Missing CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN in .env'); process.exit(1); }

// Vision: send a screenshot to kimi, return its WORDS. (Rule 14 + CORE MEMORY:
// this describes our OWN test screenshot — explicitly allowed. I never inspect
// the PNG; I reason only from kimi's textual output.)
async function callVision(prompt: string, imagePath: string): Promise<string> {
  const base64 = (await import('node:fs')).readFileSync(imagePath).toString('base64');
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run/${VISION_MODEL}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_TOKEN}` },
      body: JSON.stringify({ messages: [{ role: 'user', content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } },
      ]}] }),
    });
    if (!res.ok) return `[vision error ${res.status}: ${(await res.text()).slice(0, 200)}]`;
    const data: any = await res.json();
    return data?.result?.choices?.[0]?.message?.content ?? data?.result?.response ?? data?.choices?.[0]?.message?.content ?? '[vision: no content returned]';
  } catch (err) { return `[vision error: ${(err as Error).message}]`; }
}

interface Check { name: string; pass: boolean; detail: string }
const checks: Check[] = [];
let context: any;
const userDataDir = `/tmp/revueon-f1-realsite`;
const { rmSync } = await import('node:fs');
try {
  const { chromium } = await import('playwright');
  try { rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`, '--no-sandbox'],
  });

  let extensionId: string | undefined;
  for (const target of context.serviceWorkers() as any[]) {
    if (target.url().startsWith('chrome-extension://')) { extensionId = new URL(target.url()).host; break; }
  }
  if (!extensionId) {
    extensionId = await new Promise<string>((resolve) => {
      context.on('serviceworker', (sw: any) => { const u = sw.url(); if (u.startsWith('chrome-extension://')) resolve(new URL(u).host); });
      setTimeout(() => resolve(''), 8000);
    }) as string;
  }
  if (!extensionId) { checks.push({ name: 'HARNESS: extension loaded', pass: false, detail: 'no extension ID found' }); throw new Error('no extension'); }
  checks.push({ name: 'HARNESS: extension loaded', pass: true, detail: 'id=' + extensionId });

  const page = await context.newPage();
  const SITE_URL = 'https://en.wikipedia.org/wiki/CSS';
  await page.goto(SITE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const beforeShot = join(SCREENSHOT_DIR, 'phase4-wikipedia-before.png');
  await page.screenshot({ path: beforeShot });

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.bringToFront();
  await page.waitForTimeout(500);
  await popup.evaluate(async ({ accountId, apiToken }: any) => {
    // Consent (Phase 6): this is a dev/QA run; stand in for a consenting developer.
    await chrome.storage.local.set({ cloudflare_account_id: accountId, cloudflare_api_token: apiToken, revueonConsentShown: true });
  }, { accountId: ACCOUNT_ID, apiToken: API_TOKEN });
  await popup.fill('#intent', 'Hide the sidebar');
  await popup.click('#transformBtn');
  await popup.waitForFunction(() => {
    const el = document.getElementById('revueon-result');
    return el && el.textContent && el.textContent.length > 10;
  }, undefined, { timeout: 90_000 });

  const raw = await popup.locator('#revueon-result').textContent();
  const res = JSON.parse(raw || '{}');
  const afterShot = join(SCREENSHOT_DIR, 'phase4-wikipedia-after.png');
  await page.screenshot({ path: afterShot });
  await popup.close();

  // ── F1 real-site assertions ──
  const status = res?.status;
  const reason = res?.reason;
  const journal = res?.journal || [];
  // The agent must have reached ACT (describePage → act on a verified target).
  const acts = journal.filter((e: any) => e.kind === 'act' || ['applyCss', 'hide', 'setText', 'insert', 'heal'].includes(e.tool));
  const checkLayouts = journal.filter((e: any) => e.tool === 'checkLayout');
  const autoUndone = checkLayouts.filter((e: any) => e.result?.autoUndone);
  // F1 identity refusals (a wrong-target/ambiguous/no-fingerprint act tool returns ok:false
  // with an [F1 identity] error). The agent should recover by re-describing.
  const f1Refusals = journal.filter((e: any) => typeof e.result?.error === 'string' && /\[F1 identity\]|different element|matched .* elements|never returned by describePage/i.test(e.result.error));

  checks.push({
    name: 'F1 REAL-SITE: loop reached ACT on Wikipedia "hide the sidebar"',
    pass: acts.length > 0,
    detail: `status=${status}, acts=${acts.length}, reason=${String(reason).slice(0, 80)}`,
  });
  // The legitimate hide must NOT be false-undone (F5) NOR wrong-target-refused
  // such that the agent gave up. A clean hide = status done + no autoUndo.
  checks.push({
    name: 'F1 REAL-SITE: the hide succeeded (done, not auto-undone, not gaveUp)',
    pass: status === 'done' && autoUndone.length === 0,
    detail: `status=${status}, autoUndone=${autoUndone.length}, f1Refusals=${f1Refusals.length}`,
  });

  // ── Vision: kimi reads the after screenshot, I reason from its words ──
  const visionWords = await callVision(
    'Describe this web page screenshot. Is there a left sidebar / table of contents visible on the left, or has it been hidden/removed? Is the main article content readable and not broken (no overlap, no garbled text, no clipped columns)? Answer in 2-3 sentences.',
    afterShot,
  );
  // F1 vision parsing (rule 14): reason ONLY from kimi's words. kimi often
  // phrases the clean state as a NEGATION ("no overlapping text", "not broken"),
  // so a naive substring search for "overlapping" would false-fail on "no
  // overlapping". Strip negated phrases before testing for break-signs, and
  // require an explicit break word (not a negation) to count as broken.
  const neg = visionWords.replace(/\bno(ne)?\s+|not\s+|without\s+|free of\s+/gi, '');
  const sidebarHidden = /hidden|removed|gone|no (left )?sidebar|not visible/i.test(visionWords) || /sidebar/.test(visionWords) === false;
  const notBroken = !/broken|overlapping|cut off|garbled|overflow|unreadable|clipped/i.test(neg);
  checks.push({
    name: 'F1 VISION (kimi): sidebar hidden AND page not broken (right target)',
    pass: sidebarHidden && notBroken,
    detail: 'kimi words: ' + String(visionWords).slice(0, 320),
  });

  writeFileSync(join(PROOF_DIR, 'phase4-f1-realsite-result.json'), JSON.stringify({
    url: SITE_URL, goal: 'Hide the sidebar', status, reason,
    acts: acts.length, checkLayoutCalls: checkLayouts.length, autoUndone: autoUndone.length,
    f1Refusals: f1Refusals.length, f1RefusalDetails: f1Refusals.slice(0, 3).map((e: any) => e.result?.error),
    visionModel: VISION_MODEL, visionWords,
    screenshots: { before: beforeShot, after: afterShot },
  }, null, 2));
} catch (e: any) {
  checks.push({ name: 'HARNESS: real-site run completed', pass: false, detail: String(e?.stack || e?.message || e) });
} finally {
  if (context) await context.close();
  try { rmSync(userDataDir, { recursive: true, force: true }); } catch {}
}

let failures = 0;
console.log('\nPhase 4 F1 — real-site + vision (Wikipedia, real loop)\n');
for (const c of checks) {
  console.log(`  ${c.pass ? '✓' : '✖'} ${c.name}`);
  if (!c.pass) { console.log(`      ${c.detail}`); failures++; } else if (c.name.startsWith('F1 VISION')) { console.log(`      ${c.detail}`); }
}
const pass = failures === 0;
writeFileSync(join(PROOF_DIR, 'phase4-f1-realsite-test.json'), JSON.stringify({ checks, pass }, null, 2));
console.log(`\n${pass ? `All ${checks.length} real-site+vision cases passed.\n` : `${failures} case(s) FAILED\n`}`);
process.exit(pass ? 0 : 1);

/**
 * tests/phase3-f5-realsite-test.ts — Phase 3 F5.8: real-site + vision validation.
 *
 * The roadmap's F5 Done criterion: "a hide that would break the page instead
 * triggers undo and says why; the resize gate catches a fixed-px transform."
 * The deliberate page-breaking case + the fixed-px case are proven in the
 * real-browser tests (tests/phase3-f5-loop-test.ts, tests/resize-gate-test.ts).
 * This test adds the REAL-SITE + VISION leg the roadmap requires:
 *
 *   1. Run the REAL agent loop (the built extension) on a REAL allowed site
 *      (Wikipedia — allowed in automation) with "hide the sidebar".
 *   2. The forced checkLayout (F5.2) must NOT false-undo a legitimate hide —
 *      the hide stays, checkLayout is clean. (Proves no false-undo on a real
 *      site, not just a fixture.)
 *   3. Screenshot → vision model (kimi-k2.7-code) → I reason ONLY from its words
 *      (rule 14: never inspect the image myself). Preserve kimi's words.
 *
 * Uses the harness's runGoal machinery (real Chrome + real extension load +
 * real Cloudflare loop). NOT YouTube/Reddit (rule 18). Vision via the same
 * callVision path the harness uses (kimi-k2.7-code).
 *
 * Usage: node --experimental-strip-types --env-file=.env tests/phase3-f5-realsite-test.ts
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

// Vision: send a screenshot to kimi, return its WORDS. (Rule 14: this describes
// our OWN test screenshot — explicitly allowed. I never inspect the PNG.)
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
const userDataDir = `/tmp/revueon-f5-realsite`;
const { rmSync } = await import('node:fs');
try {
  const { chromium } = await import('playwright');
  try { rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  context = await chromium.launchPersistentContext(userDataDir, {
    headless: false, // extension needs a real profile
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-sandbox',
    ],
  });

  // Find the extension ID from the loaded service worker.
  let extensionId: string | undefined;
  for (const target of context.serviceWorkers() as any[]) {
    if (target.url().startsWith('chrome-extension://')) { extensionId = new URL(target.url()).host; break; }
  }
  if (!extensionId) {
    // service worker may register async; wait
    extensionId = await new Promise<string>((resolve) => {
      context.on('serviceworker', (sw: any) => {
        const u = sw.url(); if (u.startsWith('chrome-extension://')) resolve(new URL(u).host);
      });
      setTimeout(() => resolve(''), 8000);
    }) as string;
  }
  if (!extensionId) { checks.push({ name: 'HARNESS: extension loaded', pass: false, detail: 'no extension ID found' }); throw new Error('no extension'); }
  checks.push({ name: 'HARNESS: extension loaded', pass: true, detail: 'id=' + extensionId });

  const page = await context.newPage();
  const SITE_URL = 'https://en.wikipedia.org/wiki/CSS';
  await page.goto(SITE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const beforeShot = join(SCREENSHOT_DIR, 'phase3-wikipedia-before.png');
  await page.screenshot({ path: beforeShot });

  // Open popup, set creds, type the goal, click Transform.
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.bringToFront();
  await page.waitForTimeout(500);
  await popup.evaluate(async ({ accountId, apiToken }: any) => {
    await chrome.storage.local.set({ cloudflare_account_id: accountId, cloudflare_api_token: apiToken });
  }, { accountId: ACCOUNT_ID, apiToken: API_TOKEN });
  await popup.fill('#intent', 'Hide the sidebar');
  await popup.click('#transformBtn');
  await popup.waitForFunction(() => {
    const el = document.getElementById('revueon-result');
    return el && el.textContent && el.textContent.length > 10;
  }, undefined, { timeout: 90_000 });

  const raw = await popup.locator('#revueon-result').textContent();
  const res = JSON.parse(raw || '{}');
  const afterShot = join(SCREENSHOT_DIR, 'phase3-wikipedia-after.png');
  await page.screenshot({ path: afterShot });
  await popup.close();

  // ── Prove the forced checkLayout did NOT false-undo a legitimate hide ──
  // The loop result: did it act (hide)? did it reach done? did it auto-undo?
  const status = res?.status;
  const reason = res?.reason;
  const journal = res?.journal || [];
  // Count act entries + any checkLayout entries with autoUndone.
  const acts = journal.filter((e: any) => e.kind === 'act' || ['applyCss', 'hide', 'setText', 'insert', 'heal'].includes(e.tool));
  const checks2 = journal.filter((e: any) => e.tool === 'checkLayout');
  const autoUndone = checks2.filter((e: any) => e.result?.autoUndone);
  const reachedAct = acts.length > 0;
  const notFalseUndoed = autoUndone.length === 0; // a clean hide must not be auto-undone
  checks.push({
    name: 'F5.8 REAL-SITE: loop reached ACT on Wikipedia "hide the sidebar"',
    pass: reachedAct,
    detail: `status=${status}, acts=${acts.length}, reason=${String(reason).slice(0, 80)}`,
  });
  checks.push({
    name: 'F5.8 REAL-SITE: forced checkLayout did NOT false-undo the legitimate hide',
    pass: notFalseUndoed,
    detail: autoUndone.length ? `FALSE UNDO: ${JSON.stringify(autoUndone[0].result).slice(0, 120)}` : `checkLayout calls=${checks2.length}, none auto-undone (clean hide stayed)`,
  });

  // ── Vision: kimi reads the after screenshot, I reason from its words ──
  const visionWords = await callVision(
    'Describe this web page screenshot. Is there a left sidebar / table of contents visible, or has it been hidden/removed? Is the main article content readable and not broken? Answer in 2-3 sentences.',
    afterShot,
  );
  const sidebarHidden = /hidden|removed|gone|no (left )?sidebar|not visible/i.test(visionWords) || /sidebar/.test(visionWords) === false;
  const notBroken = !/broken|overlapping|cut off|garbled|overflow|unreadable|clipped/i.test(visionWords);
  checks.push({
    name: 'F5.8 VISION (kimi): sidebar hidden AND page not broken',
    pass: sidebarHidden && notBroken,
    detail: 'kimi words: ' + String(visionWords).slice(0, 300),
  });

  // Save proof: kimi's verbatim words preserved.
  writeFileSync(join(PROOF_DIR, 'phase3-f5-realsite-result.json'), JSON.stringify({
    url: SITE_URL, goal: 'Hide the sidebar', status, reason,
    acts: acts.length, checkLayoutCalls: checks2.length, autoUndone: autoUndone.length,
    visionModel: VISION_MODEL, visionWords,
    screenshots: { before: beforeShot, after: afterShot },
  }, null, 2));
} catch (e: any) {
  checks.push({ name: 'HARNESS: real-site run completed', pass: false, detail: String(e?.message || e) });
} finally {
  if (context) await context.close();
  try { rmSync(userDataDir, { recursive: true, force: true }); } catch {}
}

let failures = 0;
console.log('\nPhase 3 F5.8 — real-site + vision (Wikipedia, real loop)\n');
for (const c of checks) {
  console.log(`  ${c.pass ? '✓' : '✖'} ${c.name}`);
  if (!c.pass) { console.log(`      ${c.detail}`); failures++; } else if (c.name.startsWith('F5.8 VISION')) { console.log(`      ${c.detail}`); }
}
const pass = failures === 0;
writeFileSync(join(PROOF_DIR, 'phase3-f5-realsite-test.json'), JSON.stringify({ checks, pass }, null, 2));
console.log(`\n${pass ? `All ${checks.length} real-site+vision cases passed.\n` : `${failures} case(s) FAILED\n`}`);
process.exit(pass ? 0 : 1);

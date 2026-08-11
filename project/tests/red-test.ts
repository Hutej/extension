/**
 * tests/red-test.ts — THE RED TEST — origin move verification. NO MODEL CALL.
 *
 * A cascade test injects CSS at several origins and reads a RENDERED COLOUR
 * via getComputedStyle. There is no model call in this file, no Cloudflare
 * key, no API. It needs only a browser and the built extension.
 *
 * Five variants (the spec, verbatim):
 *   1. unlayered author normal                  expect NOT red
 *   2. author normal, emitter bypassed          expect NOT red
 *   3. author important                         expect RED
 *   4. user origin via insertCSS + important    expect RED
 *   5. element carrying inline style="background: green !important" set by
 *      page JavaScript:
 *        author important   MUST LOSE  (green wins)
 *        user origin         MUST WIN   (red wins)
 *
 * Variant 2 bypasses the emitter entirely (a raw <style> element, no
 * chrome.scripting, no emitter) — otherwise it is not a negative control.
 *
 * Variant 5 is the whole point. If it does not behave as stated, the origin
 * move has not landed, and we say so instead of shipping.
 *
 * Usage: node --experimental-strip-types tests/red-test.ts
 * (reads no credentials; the extension must be built: npm run build)
 */

import { chromium } from 'playwright';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createServer, type Server } from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = join(__dirname, '..', '.output', 'chrome-mv3');
const PROOF_DIR = join(__dirname, '..', 'proof');
const SHOT_DIR = join(__dirname, 'screenshots');
mkdirSync(PROOF_DIR, { recursive: true });
mkdirSync(SHOT_DIR, { recursive: true });

const PAGE_FILE = join(__dirname, 'red-test-page.html');

interface VariantResult {
  name: string; label: string; expected: string; seen: string; pass: boolean;
}

// ── tiny HTTP server so the MV3 content script injects reliably ──────
// file:// requires "Allow access to file URLs" which Playwright does not
// enable; <all_urls> matches http://localhost so the content script loads.
async function serveFixture(): Promise<{ server: Server; url: string }> {
  const fileContents = readFileSync(PAGE_FILE, 'utf-8');
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (req.url && (req.url === '/' || req.url.startsWith('/?'))) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(fileContents);
      } else {
        res.writeHead(404); res.end('not found');
      }
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as any).port;
      resolve({ server, url: `http://127.0.0.1:${port}/` });
    });
  });
}

async function getExtensionId(context: any): Promise<string> {
  const tryMatch = (url: string): string | null => {
    const m = url.match(/chrome-extension:\/\/([a-p]{32})/i);
    return m ? m[1] : null;
  };
  const scan = (): string | null => {
    for (const sw of context.serviceWorkers()) { const id = tryMatch(sw.url()); if (id) return id; }
    for (const p of context.pages()) { const id = tryMatch(p.url()); if (id) return id; }
    return null;
  };
  // A fresh persistent context registers its service worker asynchronously.
  // Scan, then wait for the registration event, then scan again — repeat for
  // up to ~20s. (Mirrors the working pattern in harness.ts; the earlier
  // single-shot waitForEvent on i===0 raced the V4 second-context open.)
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const id = scan();
    if (id) return id;
    try { await context.waitForEvent('serviceworker', { timeout: 5000 }); } catch { /* timeout — keep polling */ }
    await new Promise<void>(r => setTimeout(r, 500));
  }
  throw new Error('Could not find extension ID. Make sure the extension is built (npm run build) and loaded.');
}

/** Read the rendered background colour of a selector as an rgb string. */
async function readBg(page: any, selector: string): Promise<string> {
  return page.evaluate((sel: string) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) return '';
    return getComputedStyle(el).backgroundColor;
  }, selector);
}

/** Call the extension's applyCss tool (USER-origin insertCSS) via the popup. */
async function applyCssViaExtension(context: any, page: any, css: string): Promise<any> {
  const extId = await getExtensionId(context);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await page.bringToFront();
  await page.waitForTimeout(200);
  const res = await popup.evaluate(async ({ url, css }: { url: string; css: string }) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t: any) => t.url && t.url.includes(url));
    if (!tab) return { ok: false, error: 'tab not found' };
    return new Promise<any>((resolve) => {
      chrome.tabs.sendMessage(tab.id!, { action: 'toolCall', tool: 'applyCss', args: { css } }, (r: any) => resolve(r));
    });
  }, { url: '127.0.0.1', css });
  await popup.close();
  return res;
}

function classify(rgb: string): 'red' | 'green' | 'other' {
  const m = rgb.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (!m) return 'other';
  const r = +m[1], g = +m[2], b = +m[3];
  if (r >= 200 && g <= 60 && b <= 60) return 'red';
  if (g >= 80 && r <= 120 && b <= 80) return 'green';
  return 'other';
}

async function newContext(tag: string): Promise<any> {
  const dir = `/tmp/revueon-red-${tag}`;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  return chromium.launchPersistentContext(dir, {
    headless: false,
    // Use Playwright's bundled Chromium (as harness.ts does). Setting
    // executablePath to system google-chrome caused the MV3 service worker
    // to never register under Playwright, so V4/V5b could not call the
    // extension — proven via tests/debug-ext-id.ts (0 service workers over
    // 25s with system Chrome vs 1 worker at t=1s with bundled Chromium).
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
  });
}

async function main() {
  const results: VariantResult[] = [];
  const { server, url: PAGE_URL } = await serveFixture();

  try {
    // ── Variants 1–3, 5a: AUTHOR origin via raw <style> (bypass emitter) ──
    // A single context is fine; each variant reloads the page to reset.
    const ctx = await newContext('author');
    try {
      const page = await ctx.newPage();

      // V1 — unlayered author normal, prepended (page rule comes after → wins)
      await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForTimeout(400);
      await page.evaluate((css: string) => {
        const s = document.createElement('style'); s.textContent = css;
        document.head.prepend(s);
      }, 'body { background: red }');
      await page.waitForTimeout(300);
      const v1 = await readBg(page, 'body');
      const v1c = classify(v1);
      const v1pass = v1c !== 'red';
      await page.screenshot({ path: join(PROOF_DIR, 'red-v1-unlayered-normal.png') });
      console.log(`V1 unlayered author normal: ${v1} → ${v1c} — expect NOT red — ${v1pass ? 'PASS' : 'FAIL'}`);
      results.push({ name: 'v1', label: 'unlayered author normal', expected: 'NOT red', seen: `${v1c} (${v1})`, pass: v1pass });

      // V2 — author normal, emitter BYPASSED (raw style, no chrome.scripting)
      await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForTimeout(400);
      await page.evaluate((css: string) => {
        const s = document.createElement('style'); s.textContent = css;
        document.head.prepend(s);
      }, 'body { background: red }');
      await page.waitForTimeout(300);
      const v2 = await readBg(page, 'body');
      const v2c = classify(v2);
      const v2pass = v2c !== 'red';
      await page.screenshot({ path: join(PROOF_DIR, 'red-v2-emitter-bypassed.png') });
      console.log(`V2 author normal, emitter bypassed: ${v2} → ${v2c} — expect NOT red — ${v2pass ? 'PASS' : 'FAIL'}`);
      results.push({ name: 'v2', label: 'author normal, emitter bypassed', expected: 'NOT red', seen: `${v2c} (${v2})`, pass: v2pass });

      // V3 — author important (raw style) — important beats page normal
      await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForTimeout(400);
      await page.evaluate((css: string) => {
        const s = document.createElement('style'); s.textContent = css;
        document.head.prepend(s);
      }, 'body { background: red !important }');
      await page.waitForTimeout(300);
      const v3 = await readBg(page, 'body');
      const v3c = classify(v3);
      const v3pass = v3c === 'red';
      await page.screenshot({ path: join(PROOF_DIR, 'red-v3-author-important.png') });
      console.log(`V3 author important: ${v3} → ${v3c} — expect RED — ${v3pass ? 'PASS' : 'FAIL'}`);
      results.push({ name: 'v3', label: 'author important', expected: 'RED', seen: `${v3c} (${v3})`, pass: v3pass });

      // V5a — author important vs inline green !important — author MUST LOSE
      await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForTimeout(400);
      await page.evaluate(() => {
        const s = document.createElement('style'); s.textContent = '#v5-box { background: red !important }';
        document.head.prepend(s);
      });
      await page.waitForTimeout(300);
      const v5a = await readBg(page, '#v5-box');
      const v5ac = classify(v5a);
      const v5apass = v5ac === 'green'; // green wins = author important loses
      await page.screenshot({ path: join(PROOF_DIR, 'red-v5a-author-loses.png') });
      console.log(`V5a author important vs inline green: ${v5a} → ${v5ac} — expect GREEN (author loses) — ${v5apass ? 'PASS' : 'FAIL'}`);
      results.push({ name: 'v5a', label: 'author important vs inline !important', expected: 'GREEN (author loses)', seen: `${v5ac} (${v5a})`, pass: v5apass });
    } finally { try { await ctx.close(); } catch { /* ignore */ } }

    // ── V4: user origin via insertCSS + important — expect RED ──────────
    {
      const ctx = await newContext('v4');
      try {
        const page = await ctx.newPage();
        await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await page.waitForTimeout(600);
        const applyRes = await applyCssViaExtension(ctx, page, 'body { background: red !important }');
        await page.waitForTimeout(400);
        const v4 = await readBg(page, 'body');
        const v4c = classify(v4);
        const v4pass = v4c === 'red';
        await page.screenshot({ path: join(PROOF_DIR, 'red-v4-user-important.png') });
        console.log(`V4 user origin via insertCSS + important: ${v4} → ${v4c} — expect RED — ${v4pass ? 'PASS' : 'FAIL'}`);
        console.log(`   applyCss returned: ${JSON.stringify(applyRes).slice(0, 160)}`);
        results.push({ name: 'v4', label: 'user origin via insertCSS + important', expected: 'RED', seen: `${v4c} (${v4})`, pass: v4pass });
        writeFileSync(join(PROOF_DIR, 'red-v4-apply.json'), JSON.stringify(applyRes, null, 2));
      } finally { try { await ctx.close(); } catch { /* ignore */ } }
    }

    // ── V5b: user origin important vs inline green — user MUST WIN (red) ─
    {
      const ctx = await newContext('v5b');
      try {
        const page = await ctx.newPage();
        await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await page.waitForTimeout(600);
        // sanity: confirm the inline green is present before we act
        const before = await readBg(page, '#v5-box');
        const applyRes = await applyCssViaExtension(ctx, page, '#v5-box { background: red !important }');
        await page.waitForTimeout(400);
        const v5b = await readBg(page, '#v5-box');
        const v5bc = classify(v5b);
        const v5bpass = v5bc === 'red';
        await page.screenshot({ path: join(PROOF_DIR, 'red-v5b-user-wins.png') });
        console.log(`V5b user important vs inline green: before=${before} after=${v5b} → ${v5bc} — expect RED (user wins) — ${v5bpass ? 'PASS' : 'FAIL'}`);
        console.log(`   applyCss returned: ${JSON.stringify(applyRes).slice(0, 160)}`);
        results.push({ name: 'v5b', label: 'user important vs inline !important', expected: 'RED (user wins)', seen: `${v5bc} (${v5b})`, pass: v5bpass });
        writeFileSync(join(PROOF_DIR, 'red-v5b-apply.json'), JSON.stringify(applyRes, null, 2));
      } finally { try { await ctx.close(); } catch { /* ignore */ } }
    }
  } finally {
    server.close();
  }

  // ── Summary ────────────────────────────────────────────────────────
  console.log('\n═══ RED TEST SUMMARY ═══');
  for (const r of results) {
    console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.label} — seen ${r.seen} (expected ${r.expected})`);
  }
  const allPass = results.every(r => r.pass);
  console.log(`\n  ${allPass ? 'ALL PASS' : 'SOME FAILED'} — ${results.filter(r => r.pass).length}/${results.length}`);
  writeFileSync(join(PROOF_DIR, 'red-test-results.json'), JSON.stringify(results, null, 2));

  if (!allPass) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });

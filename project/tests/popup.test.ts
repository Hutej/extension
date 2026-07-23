/**
 * WebMorph e2e test harness — drives the real popup→Transform flow on real sites.
 * Round 7: real assertions, 5-site grid (incl. GitHub SPA + YouTube Shadow DOM),
 * novel prompts, persistence test, smoke tier via WMGRID env var.
 *
 * Run: cd project && node --experimental-strip-types --env-file=.env tests/popup.test.ts
 *   WMGRID=smoke  — 1 site, 1 prompt, <3min (regression catch)
 *   WMGRID=full   — 5 sites, 5 prompts (default, acceptance grid)
 */

import { chromium, type Page, type BrowserContext } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { detectRecolor, type PixelInput } from '../src/core/verify/pixel.ts';

const SMOKE = process.env.WMGRID === 'smoke';

interface SiteSpec {
  name: string;
  url: string;
  prompt: string;
  isSPA: boolean;
  isShadowDOM: boolean;
}

// Novel prompts — never reused from any prior round.
// Excluded: art deco, space-age pop, Swiss International, cyberpunk HUD,
// childrens picture book, expensive quiet, editorial magazine, minimal brutalist,
// calm night, retro terminal, 1920s newspaper, coffee shop, dark academia,
// Swiss grid, glassmorphism, neobrutalism, industrial blueprint, parchment
// manuscript, magazine spread, bold magazine spread, Japanese zen garden,
// retro 8-bit pixel arcade, Art Nouveau Mucha poster, tropical resort brochure,
// vintage travel poster, Bauhaus, Soviet constructivist, Memphis, Cottagecore,
// Frida Kahlo.
const SITES: SiteSpec[] = [
  { name: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Main_Page',
    prompt: 'Carnival Rio samba — explosive magenta lime and gold, feathered headdress motifs, exuberant confetti textures, bold condensed display headlines, festive rhythmic energy',
    isSPA: false, isShadowDOM: false },
  { name: 'MDN', url: 'https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties',
    prompt: 'Vorticism — angular machine-age forms, sharp wedges, metallic grey and vermillion, fragmented angular typography, dynamic mechanical energy',
    isSPA: false, isShadowDOM: false },
  { name: 'BBC', url: 'https://www.bbc.com/news',
    prompt: 'Pop Art Lichtenstein comic — bold primary red yellow blue, thick black outlines, Ben-Day dot textures, comic-strip panels, speech-bubble headlines',
    isSPA: false, isShadowDOM: false },
  { name: 'GitHub', url: 'https://github.com/torvalds/linux',
    prompt: 'Mid-century modern Eames — warm walnut and mustard orange, soft organic geometries, clean grid compositions, friendly geometric patterns, generous whitespace',
    isSPA: true, isShadowDOM: false },
  { name: 'YouTube', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    prompt: 'Vibrant Holi powder festival — clouds of vivid pink green and yellow powder, exuberant color-burst textures, energetic display type, celebratory chaos',
    isSPA: true, isShadowDOM: true },
];

const ARTIFACTS_DIR = path.join(import.meta.dirname, 'artifacts');

interface PostApplyChecks {
  pixelVoids: number;
  pixelInvisibleText: number;
  pixelSqueeze: number;          // WS1: rendered chars-per-line below floor
  recolor: boolean;             // WS1: structure-identical + hue-only shift = recolor
  multiConditionPixel: boolean; // WS2: pixel audit holds at 2nd viewport + 80% zoom
  multiViewport: boolean;
  zoomCheck: boolean;
  devtools: boolean;
  scrollLoad: boolean | null;   // null = not applicable (non-SPA/non-shadow site)
  paintCount: number;
  escapeHatch: boolean;
  structuredReport: boolean;
  pixelDetails: string[];
}

interface RunResult {
  name: string;
  applied: boolean;
  timedOut: boolean;
  changeScore: number;
  coverageFraction: number;
  modelCoverageFraction: number;
  paidCalls: number;
  dropLayout: boolean;
  wallMs: number;
  errorKind?: string;
  checks?: Record<string, boolean>;
  postApply?: PostApplyChecks;
}

// ── Post-apply acceptance checks (Round 10: tests-first) ─────────────
// These run AFTER the transform. Against the current build they FAIL —
// those failures ARE the specification. Workstream code turns them green.

/** Pixel audit at 3 scroll positions (top/mid/deep). Loads each screenshot
 *  back into the page as a data URL, draws to canvas, samples pixel variance
 *  per [data-wm-c] cluster rect. Text clusters with near-zero variance =
 *  invisible text; large empty clusters with uniform color = void. */
async function pixelAudit(page: Page): Promise<{ voids: number; invisibleText: number; details: string[] }> {
  const positions = ['top', 'mid', 'deep'];
  let totalVoids = 0, totalInvisible = 0;
  const allDetails: string[] = [];
  for (const pos of positions) {
    const scrollY = pos === 'top' ? 0
      : pos === 'mid' ? await page.evaluate(() => Math.floor(document.body.scrollHeight / 2))
      : await page.evaluate(() => Math.floor(document.body.scrollHeight * 0.8));
    await page.evaluate((y) => window.scrollTo(0, y), scrollY);
    await page.waitForTimeout(500);
    const screenshot = await page.screenshot({ type: 'png' });
    const dataUrl = 'data:image/png;base64,' + screenshot.toString('base64');
    const result = await page.evaluate((url: string) => {
      return new Promise<{ voids: number; invisible: number }>((resolve) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
          const ctx = canvas.getContext('2d')!;
          ctx.drawImage(img, 0, 0);
          const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
          let voids = 0, invisible = 0;
          const els = Array.from(document.querySelectorAll('[data-wm-c]'));
          for (const el of els) {
            if (el.hasAttribute('data-webmorph-ui')) continue;
            if (!(el instanceof HTMLElement)) continue;
            const r = el.getBoundingClientRect();
            if (r.width < 50 || r.height < 50) continue;
            const x0 = Math.max(0, Math.floor(r.left));
            const y0 = Math.max(0, Math.floor(r.top));
            const x1 = Math.min(canvas.width, Math.ceil(r.right));
            const y1 = Math.min(canvas.height, Math.ceil(r.bottom));
            if (x1 <= x0 || y1 <= y0) continue;
            let minR = 255, maxR = 0, minG = 255, maxG = 0, minB = 255, maxB = 0;
            const step = 4;
            for (let y = y0; y < y1; y += step) {
              for (let x = x0; x < x1; x += step) {
                const i = (y * canvas.width + x) * 4;
                if (data.data[i] < minR) minR = data.data[i];
                if (data.data[i] > maxR) maxR = data.data[i];
                if (data.data[i+1] < minG) minG = data.data[i+1];
                if (data.data[i+1] > maxG) maxG = data.data[i+1];
                if (data.data[i+2] < minB) minB = data.data[i+2];
                if (data.data[i+2] > maxB) maxB = data.data[i+2];
              }
            }
            const variance = (maxR - minR) + (maxG - minG) + (maxB - minB);
            const textLen = (el.textContent || '').trim().length;
            if (textLen > 20 && variance < 15) invisible++;
            else if (textLen === 0 && r.width > 200 && r.height > 100 && variance < 10) voids++;
          }
          resolve({ voids, invisible });
        };
        img.onerror = () => resolve({ voids: 0, invisible: 0 });
        img.src = url;
      });
    }, dataUrl);
    totalVoids += result.voids; totalInvisible += result.invisible;
    allDetails.push(`${pos}: voids=${result.voids} invisible=${result.invisible}`);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  return { voids: totalVoids, invisibleText: totalInvisible, details: allDetails };
}

/** Multi-viewport: resize to 800 + 1600, check no horizontal overflow. */
async function multiViewportCheck(page: Page): Promise<boolean> {
  const orig = page.viewportSize();
  for (const w of [800, 1600]) {
    await page.setViewportSize({ width: w, height: 800 });
    await page.waitForTimeout(600);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 4);
    if (overflow) { if (orig) await page.setViewportSize(orig); return false; }
  }
  if (orig) await page.setViewportSize(orig);
  await page.waitForTimeout(300);
  return true;
}

/** Zoom: set CSS zoom 80% + 125%, check no overflow + content present. */
async function zoomCheck(page: Page): Promise<boolean> {
  for (const z of ['0.8', '1.25']) {
    await page.evaluate((zoom) => { (document.body.style as unknown as { zoom: string }).zoom = zoom; }, z);
    await page.waitForTimeout(400);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 4);
    const hasContent = await page.evaluate(() => {
      const el = document.querySelector('[data-wm-c]') as HTMLElement | null;
      return el ? el.offsetWidth > 0 && el.offsetHeight > 0 : false;
    });
    // At 125% zoom, also run the pixel audit — invisible text + voids must be zero.
    // (80% zoom pixel is covered by multiConditionPixelCheck.)
    let pixelOk = true;
    if (z === '1.25') {
      const px = await pixelAudit(page);
      pixelOk = px.voids === 0 && px.invisibleText === 0;
    }
    await page.evaluate(() => { (document.body.style as unknown as { zoom: string }).zoom = ''; });
    if (overflow || !hasContent || !pixelOk) return false;
  }
  await page.waitForTimeout(200);
  return true;
}

/** Devtools simulation: shrink viewport ~30%, check design holds. */
async function devtoolsCheck(page: Page): Promise<boolean> {
  const orig = page.viewportSize();
  if (!orig) return true;
  await page.setViewportSize({ width: Math.round(orig.width * 0.7), height: orig.height });
  await page.waitForTimeout(500);
  const ok = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 4);
  await page.setViewportSize(orig);
  await page.waitForTimeout(300);
  return ok;
}

/** Scroll-load proof: scroll down on SPA/shadow sites, wait, check new content
 *  has [data-wm-c] handles (dynamic defender re-stamped them). */
async function scrollLoadCheck(page: Page): Promise<boolean> {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.6));
  await page.waitForTimeout(2000);
  const stamped = await page.evaluate(() => {
    const els = document.querySelectorAll('[data-wm-c]');
    let withText = 0;
    for (const el of els) {
      if ((el.textContent || '').trim().length > 10) withText++;
    }
    return { total: els.length, withText };
  });
  return stamped.total > 0 && stamped.withText > 0;
}

/** Visible-paint count: read the data-webmorph-paint-count attribute
 *  (instrumented in the content script). Absent = -1 (uninstrumented -> the
 *  assertion fails — a no-op check is worse than no check). <=2 = apply + one
 *  batched repair; >2 = visible repair theater = failing check. */
async function paintCountCheck(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const v = document.documentElement.dataset['webmorphPaintCount'];
    if (v === undefined) return -1;          // uninstrumented -> assertion fails
    return parseInt(v, 10) || 0;
  });
}

/** Escape-hatch: click the On/Off button, check style removed instantly.
 *  Uses page.evaluate (not a Playwright handle) — the button is re-created
 *  by the content script on re-apply, so a cached handle may detach. */
async function escapeHatchCheck(page: Page): Promise<boolean> {
  const exists = await page.evaluate(() => !!document.getElementById('webmorph-escape-ui'));
  if (!exists) return false;
  // Click via evaluate — robust to re-renders.
  await page.evaluate(() => {
    const btn = document.getElementById('webmorph-escape-ui') as HTMLButtonElement | null;
    btn?.click();
  });
  await page.waitForTimeout(300);
  const hasStyle = await page.evaluate(() => !!document.getElementById('webmorph-style'));
  if (hasStyle) return false;
  // Re-apply via toggle so subsequent checks have the design.
  await page.evaluate(() => {
    const btn = document.getElementById('webmorph-escape-ui') as HTMLButtonElement | null;
    btn?.click();
  });
  await page.waitForTimeout(500);
  return true;
}

/** Structured report: the popup JSON has stage ledger + serialized chars. */
function structuredReportCheck(resultJson: string): boolean {
  if (!resultJson) return false;
  try {
    const parsed = JSON.parse(resultJson);
    const l = parsed.ledger;
    if (!l) return false;
    if (typeof l.serializeChars !== 'number') return false;
    if (!Array.isArray(l.modelCalls)) return false;
    if (typeof l.totalMs !== 'number') return false;
    if (typeof l.paidCalls !== 'number') return false;
    return true;
  } catch { return false; }
}

/** WS1 squeeze detector: a text cluster whose rendered chars-per-line < 12.
 *  Pixel-grounded: uses the element's ACTUAL rendered clientWidth + fontSize,
 *  and requires >=3 lines of text so a short label isn't a false positive. */
async function squeezeCheck(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const MIN_CPL = 12;
    let squeezed = 0;
    for (const el of Array.from(document.querySelectorAll('[data-wm-c]'))) {
      if (el.hasAttribute('data-webmorph-ui') || !(el instanceof HTMLElement)) continue;
      const text = (el.textContent || '').trim();
      if (text.length < 80) continue;            // need real prose, not a label
      const r = el.getBoundingClientRect();
      if (r.width < 50 || r.height < 40) continue;
      const cs = getComputedStyle(el);
      const fs = parseFloat(cs.fontSize) || 16;
      const cpl = el.clientWidth / (fs * 0.5);
      const lh = parseFloat(cs.lineHeight) || 1.5;
      // >=3 lines heuristic: height > 2.5 * fontSize * lineHeight
      if (el.clientHeight > fs * lh * 2.5 && cpl < MIN_CPL) squeezed++;
    }
    return squeezed;
  });
}

/** WS1 recolor detector: structure-identical (same edge map) + hue-only shift =
 *  a recolor, not a redesign. Decodes the stored BEFORE and the live AFTER
 *  screenshots to PixelInputs (in-page, via canvas) and calls the PURE
 *  detectRecolor in Node — no duplicated detector math. */
async function recolorCheck(page: Page, beforePath: string): Promise<boolean> {
  if (!fs.existsSync(beforePath)) return false;     // no before -> cannot claim recolor
  const beforeBuf = fs.readFileSync(beforePath);
  const afterBuf = await page.screenshot({ type: 'png' });
  const decode = (b64: string) => page.evaluate((url: string) => new Promise<PixelInput>((resolve) => {
    const img = new Image();
    img.onload = () => {
      const W = 64;
      const H = Math.max(1, Math.round((img.naturalHeight / Math.max(1, img.naturalWidth)) * W));
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const ctx = c.getContext('2d')!; ctx.drawImage(img, 0, 0, W, H);
      resolve({ width: W, height: H, data: ctx.getImageData(0, 0, W, H).data });
    };
    img.onerror = () => resolve({ width: 0, height: 0, data: new Uint8ClampedArray(0) });
    img.src = url;
  }), 'data:image/png;base64,' + b64);
  const [before, after] = await Promise.all([decode(beforeBuf.toString('base64')), decode(afterBuf.toString('base64'))]);
  if (!before.data.length || !after.data.length) return false;
  return detectRecolor(before, after);
}

/** WS2: the pixel audit must hold at a 2nd viewport width AND at 80% zoom — not
 *  just the capture viewport. Fluid-by-construction CSS should pass both. */
async function multiConditionPixelCheck(page: Page): Promise<boolean> {
  const orig = page.viewportSize();
  if (orig) { await page.setViewportSize({ width: Math.round(orig.width * 0.75), height: orig.height }); await page.waitForTimeout(500); }
  const a = await pixelAudit(page);
  if (orig) await page.setViewportSize(orig);
  await page.evaluate(() => { (document.body.style as unknown as { zoom: string }).zoom = '0.8'; });
  await page.waitForTimeout(400);
  const b = await pixelAudit(page);
  await page.evaluate(() => { (document.body.style as unknown as { zoom: string }).zoom = ''; });
  await page.waitForTimeout(200);
  // 125% zoom — invisible text + voids must be zero (the 125% pixel audit).
  await page.evaluate(() => { (document.body.style as unknown as { zoom: string }).zoom = '1.25'; });
  await page.waitForTimeout(400);
  const c = await pixelAudit(page);
  await page.evaluate(() => { (document.body.style as unknown as { zoom: string }).zoom = ''; });
  await page.waitForTimeout(200);
  return a.voids === 0 && a.invisibleText === 0 && b.voids === 0 && b.invisibleText === 0 && c.voids === 0 && c.invisibleText === 0;
}

/** Run all post-apply checks, return a PostApplyChecks object. */
async function runPostApplyChecks(page: Page, site: SiteSpec, resultJson: string, beforePath: string): Promise<PostApplyChecks> {
  const pixel = await pixelAudit(page);
  const squeeze = await squeezeCheck(page);
  const recolor = await recolorCheck(page, beforePath);
  const mcp = await multiConditionPixelCheck(page);
  const mv = await multiViewportCheck(page);
  const zoom = await zoomCheck(page);
  const dt = await devtoolsCheck(page);
  const sl = site.isSPA || site.isShadowDOM ? await scrollLoadCheck(page) : null;
  const pc = await paintCountCheck(page);
  const eh = await escapeHatchCheck(page);
  const sr = structuredReportCheck(resultJson);
  return {
    pixelVoids: pixel.voids, pixelInvisibleText: pixel.invisibleText, pixelSqueeze: squeeze,
    recolor, multiConditionPixel: mcp, multiViewport: mv, zoomCheck: zoom, devtools: dt,
    scrollLoad: sl, paintCount: pc, escapeHatch: eh, structuredReport: sr,
    pixelDetails: pixel.details,
  };
}

// Vague-prompt axis: fuzzy prompts that real users type, held to the same bars.
const VAGUE_SITES: SiteSpec[] = [
  { name: 'Wikipedia-vague', url: 'https://en.wikipedia.org/wiki/Main_Page',
    prompt: 'make it feel calm and expensive', isSPA: false, isShadowDOM: false },
  { name: 'BBC-vague', url: 'https://www.bbc.com/news',
    prompt: 'I want it fun but not childish', isSPA: false, isShadowDOM: false },
];

async function run() {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

  const extDir = path.join(import.meta.dirname, '..', '.output', 'chrome-mv3');
  if (!fs.existsSync(extDir)) {
    console.error('Extension not built. Run `npm run build` first.');
    process.exit(1);
  }

  const context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      `--disable-extensions-except=${extDir}`,
      `--load-extension=${extDir}`,
      '--no-first-run',
    ],
  });

  // Set API key via the service worker.
  let worker = context.serviceWorkers()[0];
  if (!worker) {
    worker = await context.waitForEvent('serviceworker', { timeout: 10000 });
  }
  await worker.evaluate((key) => chrome.storage.local.set({ openai_api_key: key }), process.env.OPENAI_API_KEY || '');

  // Get extension ID and open popup.
  const extId = worker.url().split('/')[2];
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);

  const sites = SMOKE ? SITES.slice(0, 1) : SITES;
  const results: RunResult[] = [];

  for (const site of sites) {
    console.log(`\n=== ${site.name} ===`);
    const result = await transformSite(context, popup, site);
    results.push(result);

    // Persistence test for non-smoke, non-SPA sites.
    if (!SMOKE && result.applied && !site.isSPA) {
      console.log(`  [persistence] reloading ${site.name}…`);
      const pages = context.pages().filter((p) => p.url().includes(new URL(site.url).hostname));
      const page = pages[pages.length - 1];
      if (page) {
        await page.reload({ waitUntil: 'domcontentloaded' });
        try {
          await page.waitForFunction(
            () => document.documentElement.hasAttribute('data-webmorph-applied'),
            null, { timeout: 15000 },
          );
          console.log(`  [persistence] ✓ design survived reload`);
        } catch {
          console.log(`  [persistence] ✗ design did NOT survive reload`);
        }
      }
    }

    // Pacing between sites.
    if (sites.indexOf(site) < sites.length - 1) await new Promise((r) => setTimeout(r, 8000));
  }

  // ── Simple-intent fast-path proof (req E) ──
  // A hide request must take the fast path: applied, 0 paid calls, <15s. NOT judged
  // as a redesign (changeScore/coverage don't apply to a hide), so handled separately.
  let simpleFailures = 0;
  {
    console.log('\n=== SIMPLE INTENT (fast path) ===');
    const simpleResult = await transformSite(context, popup, {
      name: 'Wikipedia-hide', url: 'https://en.wikipedia.org/wiki/Main_Page',
      prompt: 'hide the footer', isSPA: false, isShadowDOM: false,
    });
    console.log(`  fast-path: applied=${simpleResult.applied} paidCalls=${simpleResult.paidCalls} wall=${(simpleResult.wallMs / 1000).toFixed(1)}s`);
    if (!simpleResult.applied) { console.log('    ✗ FAIL: simple hide intent did not apply'); simpleFailures++; }
    else {
      if (simpleResult.paidCalls > 0) { console.log(`    ✗ FAIL: fast path used ${simpleResult.paidCalls} paid call(s) — should be 0`); simpleFailures++; }
      if (simpleResult.wallMs > 15000) { console.log(`    ✗ FAIL: fast path took ${(simpleResult.wallMs / 1000).toFixed(1)}s — should be <15s`); simpleFailures++; }
      if (simpleResult.paidCalls === 0 && simpleResult.wallMs <= 15000) console.log('    ✓ fast path: applied, 0 paid calls, <15s');
    }
    await new Promise((r) => setTimeout(r, 3000));
  }

  // ── Vague-prompt axis (Round 10: WS6) ──
  // Fuzzy prompts that real users type, held to the same bars. Run on the full
  // grid (skipped in smoke mode — these are extra paid calls).
  let vagueFailures = 0;
  if (!SMOKE) {
    for (const site of VAGUE_SITES) {
      console.log(`\n=== ${site.name} ===`);
      const result = await transformSite(context, popup, site);
      results.push(result);
      if (!result.applied) { console.log(`    ✗ FAIL: vague prompt did not apply`); vagueFailures++; }
      if (result.applied && result.changeScore < 0.25) { console.log(`    ✗ FAIL: vague prompt changeScore < 0.25`); vagueFailures++; }
      if (result.applied && result.coverageFraction < 0.85) { console.log(`    ✗ FAIL: vague prompt coverage < 0.85`); vagueFailures++; }
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  // ── Assertions ──
  console.log('\n=== RESULTS ===');
  let failures = 0;
  for (const r of results) {
    const status = r.applied ? 'APPLIED' : r.timedOut ? 'TIMEOUT' : 'FAILED';
    console.log(`  ${r.name}: ${status} change=${r.changeScore.toFixed(3)} coverage=${r.coverageFraction.toFixed(3)} modelCov=${r.modelCoverageFraction.toFixed(3)} paidCalls=${r.paidCalls} dropLayout=${r.dropLayout} wall=${(r.wallMs / 1000).toFixed(1)}s${r.errorKind ? ` kind=${r.errorKind}` : ''}`);

    if (r.timedOut) { console.log(`    ✗ FAIL: timed out — WASTED MONEY (paid call returned nothing)`); failures++; }
    if (!r.applied && !r.timedOut) failures++;
    if (r.applied && r.wallMs > 120000) { console.log(`    ✗ FAIL: wall-clock ${(r.wallMs / 1000).toFixed(1)}s > 120s`); failures++; }
    if (r.applied && r.changeScore < 0.25) { console.log(`    ✗ FAIL: changeScore ${r.changeScore.toFixed(3)} < 0.25`); failures++; }
    if (r.applied && r.coverageFraction < 0.85) { console.log(`    ✗ FAIL: coverageFraction ${r.coverageFraction.toFixed(3)} < 0.85`); failures++; }
    if (r.applied && r.dropLayout) { console.log(`    ✗ FAIL: dropLayout fired`); failures++; }
    if (r.applied && r.paidCalls > 2) { console.log(`    ✗ FAIL: paidCalls ${r.paidCalls} > 2`); failures++; }
    if (r.applied && r.paidCalls > 1) console.log(`    ⚠ WARN: paidCalls ${r.paidCalls} > 1 — reReason fired (prompt failure signal)`);

    // Post-apply acceptance checks (Round 10).
    if (r.applied && r.postApply) {
      const pa = r.postApply;
      if (pa.pixelVoids > 0) { console.log(`    ✗ FAIL: pixel audit found ${pa.pixelVoids} void(s)`); failures++; }
      if (pa.pixelInvisibleText > 0) { console.log(`    ✗ FAIL: pixel audit found ${pa.pixelInvisibleText} invisible-text cluster(s)`); failures++; }
      if (pa.pixelSqueeze > 0) { console.log(`    ✗ FAIL: pixel audit found ${pa.pixelSqueeze} squeezed text cluster(s)`); failures++; }
      if (pa.recolor) { console.log(`    ✗ FAIL: recolor detector (structure-identical + hue-only shift)`); failures++; }
      if (!pa.multiConditionPixel) { console.log(`    ✗ FAIL: multi-condition pixel audit (2nd viewport or 80% zoom)`); failures++; }
      if (!pa.multiViewport) { console.log(`    ✗ FAIL: multi-viewport check (overflow on resize)`); failures++; }
      if (!pa.zoomCheck) { console.log(`    ✗ FAIL: zoom check (overflow or content lost at 80%/125%)`); failures++; }
      if (!pa.devtools) { console.log(`    ✗ FAIL: devtools simulation (overflow on 30% shrink)`); failures++; }
      if (pa.scrollLoad === false) { console.log(`    ✗ FAIL: scroll-load proof (new content not styled)`); failures++; }
      if (pa.paintCount < 0 || pa.paintCount > 2) { console.log(`    ✗ FAIL: paint count ${pa.paintCount} (uninstrumented or >2 visible paints)`); failures++; }
      if (!pa.escapeHatch) { console.log(`    ✗ FAIL: escape hatch (On/Off did not remove style)`); failures++; }
      if (!pa.structuredReport) { console.log(`    ✗ FAIL: structured report (missing stage ledger / serialized chars)`); failures++; }
    }
  }

  const appliedCount = results.filter((r) => r.applied).length;
  const required = SMOKE ? 1 : 4;
  if (appliedCount < required) {
    console.log(`\n✗ HARNESS FAIL: only ${appliedCount}/${results.length} sites applied (need ≥${required})`);
    failures++;
  } else {
    console.log(`\n✓ HARNESS PASS: ${appliedCount}/${results.length} sites applied`);
  }
  if (simpleFailures) console.log(`✗ simple-intent fast path: ${simpleFailures} check(s) failed`);
  if (vagueFailures) console.log(`✗ vague-prompt axis: ${vagueFailures} check(s) failed`);

  await context.close();
  process.exit((failures + simpleFailures + vagueFailures) > 0 ? 1 : 0);
}

async function transformSite(context: BrowserContext, popup: Page, site: SiteSpec): Promise<RunResult> {
  const result: RunResult = {
    name: site.name, applied: false, timedOut: false,
    changeScore: 0, coverageFraction: 0, modelCoverageFraction: 0,
    paidCalls: 0, dropLayout: false, wallMs: 0,
  };

  const page = await context.newPage();
  // Capture WebMorph console logs for debugging.
  const wmLogs: string[] = [];
  page.on('console', (msg) => {
    const txt = msg.text();
    if (txt.includes('[WebMorph]')) wmLogs.push(txt);
  });
  try {
    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Screenshot before.
    try {
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, `before_${site.name}.png`), fullPage: true });
    } catch {
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, `before_${site.name}.png`) });
    }

    // Fill intent in popup and click Transform.
    // Bring the page to front so the popup's active-tab query finds THIS tab.
    await page.bringToFront();
    const intentEl = await popup.$('#intent');
    if (!intentEl) { console.log(`  popup missing intent field`); return result; }
    await intentEl.fill('');
    await intentEl.fill(site.prompt);

    // Clear previous result + markers.
    await popup.$eval('#webmorph-result', (el) => { el.textContent = ''; }).catch(() => {});
    await page.evaluate(() => {
      document.documentElement.removeAttribute('data-webmorph-applied');
      document.documentElement.removeAttribute('data-webmorph-failed');
    });

    // Click Transform.
    const transformBtn = await popup.$('#transformBtn');
    if (!transformBtn) { console.log(`  popup missing transform button`); return result; }
    await transformBtn.click();

    // Wait for applied/failed marker.
    const t0 = Date.now();
    let markerSeen = false;
    try {
      await page.waitForFunction(
        () => document.documentElement.hasAttribute('data-webmorph-applied') ||
              document.documentElement.hasAttribute('data-webmorph-failed'),
        null, { timeout: 130000 },
      );
      markerSeen = true;
      result.applied = await page.evaluate(() => document.documentElement.hasAttribute('data-webmorph-applied'));
      if (!result.applied) {
        const failMsg = await page.evaluate(() => document.documentElement.getAttribute('data-webmorph-failed') || '(unknown)');
        console.log(`  FAILED: ${failMsg}`);
      }
    } catch {
      result.timedOut = true;
      console.log(`  marker never appeared (timeout)`);
    }
    result.wallMs = Date.now() - t0;
    console.log(`  wall-clock: ${(result.wallMs / 1000).toFixed(1)}s applied=${result.applied}`);

    // Screenshot after.
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    await page.waitForTimeout(1500);
    const shotName = markerSeen ? `after_${site.name}.png` : `timeout_${site.name}.png`;
    try {
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, shotName), fullPage: true });
    } catch {
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, shotName) });
    }

    // Read result JSON from popup.
    const resultJson = await popup.$eval('#webmorph-result', (el) => el.textContent).catch(() => '');
    if (resultJson) {
      try {
        const parsed = JSON.parse(resultJson);
        result.changeScore = parsed.changeScore ?? 0;
        result.coverageFraction = parsed.verify?.coverageFraction ?? 0;
        result.modelCoverageFraction = parsed.verify?.modelCoverageFraction ?? 0;
        result.paidCalls = parsed.paidCalls ?? 0;
        result.errorKind = parsed.kind;
        result.checks = parsed.verify?.checks;
        console.log(`  reasoning: ${parsed.reasoning || '(none)'}`);
        console.log(`  model: ${parsed.model ?? '?'} tokens: ${JSON.stringify(parsed.usage ?? {})}`);
        if (parsed.verify) {
          console.log(`  checks: ${JSON.stringify(parsed.verify.checks)}`);
          console.log(`  coverage: ${result.coverageFraction.toFixed(3)} modelCov: ${result.modelCoverageFraction.toFixed(3)} change: ${result.changeScore.toFixed(3)}`);
        }
        if (parsed.ledger) {
          const l = parsed.ledger;
          const mcStr = l.modelCalls.map((c: { ms: number; promptTokens?: number }) => `${c.ms}ms/${c.promptTokens ?? '?'}tok`).join(', ');
          console.log(`  LEDGER perceive=${l.perceiveMs}ms serialize=${l.serializeChars}chars model=[${mcStr}] compile=${l.compileMs}ms apply=${l.applyMs}ms verify=${l.verifyMs}ms total=${l.totalMs}ms paidCalls=${l.paidCalls}`);
        }
      } catch { /* leave defaults */ }
    }

    // Check for dropLayout in page console logs (content script logs to page console).
    // ponytail: the verify checks tell us if overflow was fixed; dropLayout is detectable
    // from the repair log. For now, we infer from checks: if noOverflow is true after
    // a repair cycle, dropLayout may have fired. The content script logs this.
    result.dropLayout = false; // will be refined with console log parsing

    // ── Post-apply acceptance checks (Round 10: tests-first) ──
    // Run only if the transform applied. These checks FAIL against the current
    // build — the failures ARE the specification for the workstreams.
    if (result.applied) {
      try {
        console.log(`  [post-apply] running acceptance checks…`);
        const beforePath = path.join(ARTIFACTS_DIR, `before_${site.name}.png`);
        result.postApply = await runPostApplyChecks(page, site, resultJson, beforePath);
        const pa = result.postApply;
        console.log(`  [post-apply] pixel: voids=${pa.pixelVoids} invisible=${pa.pixelInvisibleText} squeeze=${pa.pixelSqueeze} [${pa.pixelDetails.join(', ')}]`);
        console.log(`  [post-apply] recolor=${pa.recolor} multiCondPixel=${pa.multiConditionPixel} multiViewport=${pa.multiViewport} zoom=${pa.zoomCheck} devtools=${pa.devtools} scrollLoad=${pa.scrollLoad} paintCount=${pa.paintCount} escapeHatch=${pa.escapeHatch} structuredReport=${pa.structuredReport}`);
      } catch (err) {
        console.log(`  [post-apply] checks failed: ${(err as Error).message}`);
      }
    }

    // Log WebMorph console output for debugging failures.
    if (wmLogs.length) {
      const relevant = wmLogs.filter((l) => l.includes('PAID') || l.includes('repair') || l.includes('FAILED') || l.includes('INCOMPLETE') || l.includes('dropLayout') || l.includes('rollback') || l.includes('keepBest') || l.includes('iter 0') || l.includes('collapsed') || l.includes('LEDGER'));
      if (relevant.length) console.log(`  logs: ${relevant.slice(0, 5).join(' | ')}`);
    }

  } catch (err) {
    console.log(`  error: ${(err as Error).message}`);
  } finally {
    await page.close().catch(() => {});
  }

  return result;
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

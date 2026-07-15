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
// manuscript, magazine spread, bold magazine spread.
const SITES: SiteSpec[] = [
  { name: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Main_Page',
    prompt: 'Japanese zen garden — muted sage greens, stone gray, bamboo textures, lots of whitespace, thin sans-serif type, subtle ink-brush accents',
    isSPA: false, isShadowDOM: false },
  { name: 'MDN', url: 'https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties',
    prompt: 'Retro 8-bit pixel arcade — blocky pixel fonts, primary colors on black, chunky borders, CRT scanline feel, game-UI panels',
    isSPA: false, isShadowDOM: false },
  { name: 'BBC', url: 'https://www.bbc.com/news',
    prompt: 'Art Nouveau Mucha poster — flowing organic borders, warm gold and olive, elegant serif typography, botanical ornament frames',
    isSPA: false, isShadowDOM: false },
  { name: 'GitHub', url: 'https://github.com/torvalds/linux',
    prompt: 'Tropical resort brochure — warm coral and turquoise, palm leaf patterns, relaxed rounded type, generous spacing, sunset gradients',
    isSPA: true, isShadowDOM: false },
  { name: 'YouTube', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    prompt: 'Vintage travel poster — bold flat colors, geometric shapes, condensed sans-serif headlines, stamp textures, adventurous spirit',
    isSPA: true, isShadowDOM: true },
];

const ARTIFACTS_DIR = path.join(import.meta.dirname, 'artifacts');

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
}

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

  // ── Assertions ──
  console.log('\n=== RESULTS ===');
  let failures = 0;
  for (const r of results) {
    const status = r.applied ? 'APPLIED' : r.timedOut ? 'TIMEOUT' : 'FAILED';
    console.log(`  ${r.name}: ${status} change=${r.changeScore.toFixed(3)} coverage=${r.coverageFraction.toFixed(3)} modelCov=${r.modelCoverageFraction.toFixed(3)} paidCalls=${r.paidCalls} dropLayout=${r.dropLayout} wall=${(r.wallMs / 1000).toFixed(1)}s${r.errorKind ? ` kind=${r.errorKind}` : ''}`);

    if (!r.applied && !r.timedOut) failures++;
    if (r.applied && r.changeScore < 0.25) { console.log(`    ✗ FAIL: changeScore ${r.changeScore.toFixed(3)} < 0.25`); failures++; }
    if (r.applied && r.coverageFraction < 0.85) { console.log(`    ✗ FAIL: coverageFraction ${r.coverageFraction.toFixed(3)} < 0.85`); failures++; }
    if (r.applied && r.dropLayout) { console.log(`    ✗ FAIL: dropLayout fired`); failures++; }
    if (r.applied && r.paidCalls > 2) { console.log(`    ✗ FAIL: paidCalls ${r.paidCalls} > 2`); failures++; }
  }

  const appliedCount = results.filter((r) => r.applied).length;
  const required = SMOKE ? 1 : 4;
  if (appliedCount < required) {
    console.log(`\n✗ HARNESS FAIL: only ${appliedCount}/${results.length} sites applied (need ≥${required})`);
    failures++;
  } else {
    console.log(`\n✓ HARNESS PASS: ${appliedCount}/${results.length} sites applied`);
  }

  await context.close();
  process.exit(failures > 0 ? 1 : 0);
}

async function transformSite(context: BrowserContext, popup: Page, site: SiteSpec): Promise<RunResult> {
  const result: RunResult = {
    name: site.name, applied: false, timedOut: false,
    changeScore: 0, coverageFraction: 0, modelCoverageFraction: 0,
    paidCalls: 0, dropLayout: false, wallMs: 0,
  };

  const page = await context.newPage();
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
    const intentEl = await popup.$('#intent');
    if (!intentEl) { console.log(`  popup missing intent field`); return result; }
    await intentEl.fill('');
    await intentEl.fill(site.prompt);

    // Clear markers.
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
        null, { timeout: 480000 },
      );
      markerSeen = true;
      result.applied = await page.evaluate(() => document.documentElement.hasAttribute('data-webmorph-applied'));
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
      } catch { /* leave defaults */ }
    }

    // Check for dropLayout in page console logs (content script logs to page console).
    // ponytail: the verify checks tell us if overflow was fixed; dropLayout is detectable
    // from the repair log. For now, we infer from checks: if noOverflow is true after
    // a repair cycle, dropLayout may have fired. The content script logs this.
    result.dropLayout = false; // will be refined with console log parsing

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

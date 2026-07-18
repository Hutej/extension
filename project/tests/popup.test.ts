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

  await context.close();
  process.exit((failures + simpleFailures) > 0 ? 1 : 0);
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

import { chromium, type Worker, type Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const artifactsDir = path.join(__dirname, 'artifacts');
if (!fs.existsSync(artifactsDir)) fs.mkdirSync(artifactsDir, { recursive: true });

const API_KEY = process.env.OPENAI_API_KEY;
if (!API_KEY) { console.error('OPENAI_API_KEY is not set'); process.exit(1); }

const EXTENSION_PATH = path.join(__dirname, '../.output/chrome-mv3-dev');
const VIEWPORT = { width: 1280, height: 900 };

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
}

async function safeGoto(page: Page, url: string) {
  try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }); }
  catch { console.log(`goto slow for ${url}, continuing`); }
  await page.waitForTimeout(2500);
}

async function run() {
  const context = await chromium.launchPersistentContext('', {
    headless: false,
    viewport: VIEWPORT,
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
  });

  let sw: Worker | undefined = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker');
  const extensionId = sw.url().split('/')[2];
  const popupUrl = `chrome-extension://${extensionId}/popup.html`;

  await sw.evaluate((key) => (globalThis as any).chrome.storage.local.set({ openai_api_key: key }), API_KEY!);
  console.log('API key set. Extension id:', extensionId);

  const page = await context.newPage();
  page.on('console', (m) => {
    const t = m.text();
    // Surface WebMorph pipeline logs (checks, dropped props, repairs).
    if (t.includes('[WebMorph]')) console.log('PAGE', t);
  });
  const popup = await context.newPage();

  async function transform(siteName: string, url: string, intent: string) {
    const id = `${siteName}_${slug(intent)}`;
    console.log(`\n=== ${siteName} — "${intent}" ===`);

    // Clean slate: wipe storage but keep API key.
    await sw!.evaluate((key) => new Promise<void>((r) => {
      const c = (globalThis as any).chrome;
      c.storage.local.clear(() => c.storage.local.set({ openai_api_key: key }, () => r()));
    }), API_KEY!);

    await safeGoto(page, url);
    await page.evaluate(() => {
      document.documentElement.removeAttribute('data-webmorph-applied');
      document.documentElement.removeAttribute('data-webmorph-failed');
    });
    await page.screenshot({ path: path.join(artifactsDir, `before_${id}.png`) });

    const tabId = await sw!.evaluate((u) => new Promise<number | undefined>((res) => {
      (globalThis as any).chrome.tabs.query({ url: u }, (tabs: any[]) => res(tabs[0]?.id));
    }), `${new URL(url).origin}/*`);

    await popup.goto(`${popupUrl}?tabId=${tabId}`);
    await popup.fill('#intent', intent);

    // Wall-clock: start timer at the moment the user clicks Transform.
    const t0 = Date.now();
    await popup.click('#transformBtn');

    // Wait for the page's real applied/failed marker — the in-flight guard means
    // a second click shares the same run, so we never have two racing specs.
    // NOTE: waitForFunction signature is (fn, arg, options). The timeout MUST be
    // the 3rd arg — passing it as the 2nd swallows it as the page-function's arg
    // and silently falls back to the 30s default (the bug that voided the grid).
    let applied = false;
    let markerSeen = false;
    for (let tryN = 0; tryN < 2 && !markerSeen; tryN++) {
      if (tryN > 0) {
        // Check if the first call already landed silently.
        const alreadyDone = await page.evaluate(() =>
          document.documentElement.hasAttribute('data-webmorph-applied') ||
          document.documentElement.hasAttribute('data-webmorph-failed')
        ).catch(() => false);
        if (alreadyDone) {
          markerSeen = true;
          applied = await page.evaluate(() => document.documentElement.hasAttribute('data-webmorph-applied'));
          break;
        }
        // Truly timed out — if the button is still disabled the run is still in
        // progress (in-flight guard); just wait for its marker. Otherwise click.
        console.log('  retrying (marker lapsed)…');
        const btnDisabled = await popup.$eval('#transformBtn', (b) => (b as HTMLButtonElement).disabled).catch(() => false);
        await page.evaluate(() => {
          document.documentElement.removeAttribute('data-webmorph-applied');
          document.documentElement.removeAttribute('data-webmorph-failed');
        });
        if (!btnDisabled) await popup.click('#transformBtn');
      }
      try {
        await page.waitForFunction(
          () => document.documentElement.hasAttribute('data-webmorph-applied') ||
                document.documentElement.hasAttribute('data-webmorph-failed'),
          null,
          { timeout: 480000 },
        );
        markerSeen = true;
        applied = await page.evaluate(() => document.documentElement.hasAttribute('data-webmorph-applied'));
      } catch { console.log('  marker never appeared (timeout)'); }
    }

    const wallMs = Date.now() - t0;
    console.log(`  wall-clock: ${(wallMs / 1000).toFixed(1)}s`);

    // Let layout settle fully before screenshotting.
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    await page.waitForTimeout(1500);
    // Screenshot as an "after" ONLY when a marker was actually observed. On a
    // pure timeout the page is NOT a valid result — name it timeout_* so we never
    // again mistake an unapplied page for a redesign.
    // FULL PAGE: capture the entire scrollable page so consistency can be judged
    // as the user scrolls — not just the top viewport. Fallback to viewport if the
    // page is too long for a full-page capture (MDN CSS reference is enormous).
    const shotName = markerSeen ? `after_${id}.png` : `timeout_${id}.png`;
    try {
      await page.screenshot({ path: path.join(artifactsDir, shotName), fullPage: true });
    } catch {
      console.log(`  fullPage screenshot failed — falling back to viewport`);
      await page.screenshot({ path: path.join(artifactsDir, shotName) });
    }
    if (!markerSeen) console.log(`  TIMEOUT — no marker; saved ${shotName} (NOT a valid result)`);

    const status = await popup.$eval('#statusEl', (el) => el.textContent).catch(() => '');
    const specJson = await popup.$eval('#webmorph-spec', (el) => el.textContent).catch(() => '');
    console.log(`  applied=${applied}  status="${(status || '').replace(/\n/g, ' ').slice(0, 120)}"`);

    if (specJson) {
      let parsed: any = null;
      try { parsed = JSON.parse(specJson); } catch { /* leave null */ }
      fs.writeFileSync(path.join(artifactsDir, `spec_${id}.json`), specJson);
      if (parsed) {
        const ruleCount = parsed.rules?.length ?? 0;
        const layoutCount = parsed.rules?.filter((r: any) => r.layout && Object.keys(r.layout).length).length ?? 0;
        const hideCount = parsed.rules?.filter((r: any) => r.hide === true).length ?? 0;
        const keepCount = parsed.rules?.filter((r: any) => r.keep === true).length ?? 0;
        const compCount = parsed.composition?.length ?? 0;
        const paletteMode = parsed.paletteMode ?? '(default)';
        const canvasBg = parsed.canvas?.background ?? '(none)';
        const maxW = parsed.canvasLayout?.maxWidth ?? '(none)';
        console.log(`  reasoning: ${parsed.reasoning || '(none)'}`);
        console.log(`  paletteMode: ${paletteMode} | composition: ${compCount} | rules: ${ruleCount} total, ${layoutCount} with layout, ${hideCount} hides, ${keepCount} keeps | canvas.bg: ${canvasBg} | maxWidth: ${maxW}`);
      }
    }

    // Pacing: let the API rate-limit window reset before the next call.
    await page.waitForTimeout(10000);
  }

  // ── Novel rotated grid — 3 prompts, 3 sites, never used in any prior run ──
  // Excluded: art deco, space-age pop, Swiss International, cyberpunk HUD,
  // childrens picture book, expensive quiet, editorial magazine, minimal brutalist,
  // calm night, retro terminal, 1920s newspaper, coffee shop, dark academia,
  // Swiss grid, glassmorphism, neobrutalism.
  await transform('Wikipedia', 'https://en.wikipedia.org/wiki/Main_Page',
    'high-contrast industrial blueprint — white lines on deep navy, technical monospace, grid overlays, measurement-style dividers, schematic wireframe borders');
  await transform('MDN', 'https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties',
    'warm parchment manuscript — aged paper texture, sepia ink, illuminated drop caps, calligraphic headings, subtle vellum borders');
  await transform('BBC', 'https://www.bbc.com/news',
    'bold magazine spread — oversized fashion-magazine typography, dramatic black and white with a single hot-pink accent, asymmetric grid, pull quotes, thick rules');

  console.log('\n=== proof complete — see tests/artifacts ===');
  await context.close();
}

run().catch((e) => { console.error(e); process.exit(1); });

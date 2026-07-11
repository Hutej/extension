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
  page.on('console', (m) => { const t = m.text(); if (t.includes('[WebMorph]')) console.log('PAGE', t); });
  const popup = await context.newPage();

  async function transform(name: string, url: string, style: string) {
    console.log(`\n=== ${name} — ${style} ===`);
    // Guarantee a clean original page (no re-applied stored transform) — but keep the API key.
    await sw!.evaluate((key) => new Promise<void>((r) => {
      const c = (globalThis as any).chrome;
      c.storage.local.clear(() => c.storage.local.set({ openai_api_key: key }, () => r()));
    }), API_KEY!);
    await safeGoto(page, url);
    await page.evaluate(() => { document.documentElement.removeAttribute('data-webmorph-applied'); document.documentElement.removeAttribute('data-webmorph-failed'); });
    await page.screenshot({ path: path.join(artifactsDir, `before_${name}_${style}.png`) });

    const tabId = await sw!.evaluate((u) => new Promise<number | undefined>((res) => {
      (globalThis as any).chrome.tabs.query({ url: u }, (tabs: any[]) => res(tabs[0]?.id));
    }), `${new URL(url).origin}/*`);

    await popup.goto(`${popupUrl}?tabId=${tabId}`);
    await popup.fill('#intent', style);
    await popup.click('#transformBtn');

    // Wait on the REAL applied/failed marker on the page — not popup text.
    // One retry: a lapsed window is usually transient rate-limiting on back-to-back calls.
    let applied = false;
    for (let tryN = 0; tryN < 2 && !applied; tryN++) {
      if (tryN > 0) { console.log('  retrying transform (marker lapsed)…'); await popup.click('#transformBtn'); }
      try {
        await page.waitForFunction(
          () => document.documentElement.hasAttribute('data-webmorph-applied') || document.documentElement.hasAttribute('data-webmorph-failed'),
          { timeout: 120000 },
        );
        applied = await page.evaluate(() => document.documentElement.hasAttribute('data-webmorph-applied'));
      } catch { console.log('  marker never appeared (timeout)'); }
    }

    // Let layout settle before the screenshot.
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(artifactsDir, `after_${name}_${style}.png`) });

    const status = await popup.$eval('#statusEl', (el) => el.textContent).catch(() => '');
    const specJson = await popup.$eval('#webmorph-spec', (el) => el.textContent).catch(() => '');
    console.log(`  applied=${applied} status="${(status || '').replace(/\n/g, ' ')}"`);
    if (specJson) {
      fs.writeFileSync(path.join(artifactsDir, `spec_${name}_${style}.json`), specJson);
      console.log(`  --- DesignSpec (${name} ${style}) ---\n${specJson}`);
    }
    // Pacing: reset any rate-limit window before the next back-to-back model call (root fix, not a wider timeout).
    await page.waitForTimeout(6000);
  }

  await transform('Wikipedia', 'https://en.wikipedia.org/wiki/Main_Page', 'Transform it to neobrutalism');
  await transform('Wikipedia', 'https://en.wikipedia.org/wiki/Main_Page', 'Transform it to glassmorphism');
  await transform('MDN', 'https://developer.mozilla.org/en-US/', 'Transform it to neobrutalism');
  await transform('MDN', 'https://developer.mozilla.org/en-US/', 'Transform it to glassmorphism');
  await transform('BBC', 'https://www.bbc.com/news', 'Transform it to neobrutalism');
  await transform('BBC', 'https://www.bbc.com/news', 'Transform it to glassmorphism');

  console.log('\n=== proof complete — see tests/artifacts ===');
  await context.close();
}

run().catch((e) => { console.error(e); process.exit(1); });

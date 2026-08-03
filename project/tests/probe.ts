/**
 * Probe — measure the content/body ratio at each zoom × window width on the
 * Carnival Wikipedia design, to understand the proportionStable drift. Throwaway.
 */
import { chromium } from 'playwright';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const extDir = path.join(ROOT, '.output', 'chrome-mv3');

async function main() {
  const context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--no-first-run'],
  });
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 10000 });
  await worker.evaluate((key) => chrome.storage.local.set({ openai_api_key: key }), process.env.OPENAI_API_KEY || '');
  const extId = worker.url().split('/')[2];
  const page = await context.newPage();
  await page.goto('https://en.wikipedia.org/wiki/Main_Page', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.$eval('#intent', (el, v) => { (el as HTMLTextAreaElement).value = v; }, 'Carnival Rio samba — explosive magenta lime and gold, feathered headdress motifs, exuberant confetti textures, bold condensed display headlines, festive rhythmic energy');
  await page.bringToFront();
  await popup.$eval('#revueon-result', (el) => { (el as HTMLElement).textContent = ''; }).catch(() => {});
  await (await popup.$('#transformBtn'))?.click();
  try { await page.waitForFunction(() => document.documentElement.hasAttribute('data-revueon-applied') || document.documentElement.hasAttribute('data-revueon-failed'), null, { timeout: 120000 }); } catch { console.log('no marker'); }
  console.log('design applied; measuring ratios...');

  // Pin the main content handle at 100% zoom.
  const contentHandle = await page.evaluate(() => {
    const main = document.querySelector('main, [role="main"], article');
    if (main && (main as HTMLElement).getAttribute('data-rv-c')) return (main as HTMLElement).getAttribute('data-rv-c');
    const bodyW = document.body.getBoundingClientRect().width || 1;
    let best = 0, bestH = '';
    for (const el of Array.from(document.querySelectorAll('[data-rv-c]'))) {
      if (el.hasAttribute('data-revueon-ui') || !(el instanceof HTMLElement)) continue;
      const r = el.getBoundingClientRect();
      const frac = r.width / bodyW;
      if (frac >= 0.9 || frac < 0.15) continue;
      if ((el.textContent || '').trim().length > 80 && r.width > best) { best = r.width; bestH = el.getAttribute('data-rv-c') || ''; }
    }
    return bestH;
  });
  console.log(`pinned content handle: ${contentHandle}`);
  // Dump all max-width/width declarations in the revueon style element.
  const cssDump = await page.evaluate(() => {
    const el = document.getElementById('revueon-style');
    const css = el?.textContent || '';
    const lines = css.split('}').map((l) => l.trim()).filter((l) => l.includes('max-width:') || l.includes(' width:'));
    return lines.slice(0, 40);
  });
  console.log('CSS width/max-width declarations:');
  for (const l of cssDump) console.log(`  ${l.slice(0, 120)}`);

  for (const w of [1024, 1440, 1920]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(500);
    // Use a STABLE selector: main/article by tag (survives handle re-stamping).
    const info = await page.evaluate(() => {
      const innerW = window.innerWidth || 1;
      const el = document.querySelector('main, [role="main"], article') as HTMLElement | null;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { innerW, contentW: r.width, ratio: r.width / innerW };
    });
    console.log(`window ${w} (main/article): ${JSON.stringify(info)}`);
  }
  await context.close();
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });

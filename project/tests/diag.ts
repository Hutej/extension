/**
 * Diagnostic — load the extension, open a page, send a transform, capture ALL
 * console + page errors to find why the content script times out. Throwaway.
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
  page.on('console', (msg) => console.log(`[page ${msg.type()}] ${msg.text()}`));
  page.on('pageerror', (err) => console.log(`[pageerror] ${err.message}`));

  await page.goto('https://en.wikipedia.org/wiki/Main_Page', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);
  // Check the content script loaded + has the message listener.
  const hasListener = await page.evaluate(() => typeof browser !== 'undefined');
  console.log(`browser global present: ${hasListener}`);

  // Send a transform via the popup path (the harness does this). Open the popup.
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.$eval('#intent', (el, v) => { (el as HTMLTextAreaElement).value = v; }, 'Carnival Rio samba — explosive magenta lime and gold');
  await popup.$eval('#webmorph-result', (el) => { (el as HTMLElement).textContent = ''; }).catch(() => {});
  await page.bringToFront();
  const btn = await popup.$('#transformBtn');
  await btn?.click();
  console.log('clicked transform; waiting 90s for marker...');
  try {
    await page.waitForFunction(
      () => document.documentElement.hasAttribute('data-webmorph-applied') || document.documentElement.hasAttribute('data-webmorph-failed'),
      null, { timeout: 90000 },
    );
    console.log('MARKER appeared');
  } catch {
    console.log('no marker after 90s');
  }
  console.log(`applied attr: ${await page.evaluate(() => document.documentElement.hasAttribute('data-webmorph-applied'))}`);
  console.log(`failed attr: ${await page.evaluate(() => document.documentElement.getAttribute('data-webmorph-failed'))}`);
  await context.close();
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });

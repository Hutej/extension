/**
 * Diagnostic 2 — find the invisible cluster(s) at top scroll + 80%/125% zoom on the
 * Carnival Wikipedia design, using the harness's pixel-variance approach. Throwaway.
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
  console.log('design applied; scanning invisible...');

  for (const z of ['1', '0.8', '1.25']) {
    await page.evaluate((zoom) => { (document.body.style as unknown as { zoom: string }).zoom = zoom; }, z);
    await page.waitForTimeout(400);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
    const shot = await page.screenshot({ type: 'png' });
    const dataUrl = 'data:image/png;base64,' + shot.toString('base64');
    const invisible = await page.evaluate((url) => new Promise<string[]>((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(img, 0, 0);
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const out: string[] = [];
        for (const el of Array.from(document.querySelectorAll('[data-rv-c]'))) {
          if (el.hasAttribute('data-revueon-ui') || !(el instanceof HTMLElement)) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 50 || r.height < 50) continue;
          const x0 = Math.max(0, Math.floor(r.left)), y0 = Math.max(0, Math.floor(r.top));
          const x1 = Math.min(canvas.width, Math.ceil(r.right)), y1 = Math.min(canvas.height, Math.ceil(r.bottom));
          if (x1 <= x0 || y1 <= y0) continue;
          let minR = 255, maxR = 0, minG = 255, maxG = 0, minB = 255, maxB = 0;
          for (let y = y0; y < y1; y += 4) for (let x = x0; x < x1; x += 4) {
            const i = (y * canvas.width + x) * 4;
            if (data.data[i] < minR) minR = data.data[i]; if (data.data[i] > maxR) maxR = data.data[i];
            if (data.data[i+1] < minG) minG = data.data[i+1]; if (data.data[i+1] > maxG) maxG = data.data[i+1];
            if (data.data[i+2] < minB) minB = data.data[i+2]; if (data.data[i+2] > maxB) maxB = data.data[i+2];
          }
          const variance = (maxR - minR) + (maxG - minG) + (maxB - minB);
          const textLen = (el.textContent || '').trim().length;
          if (textLen > 20 && variance < 15) {
            out.push(`${el.getAttribute('data-rv-c')} var=${variance} text="${(el.textContent||'').trim().slice(0,30)}" bg=${getComputedStyle(el).backgroundColor.slice(0,20)} color=${getComputedStyle(el).color} bgImg=${/url\(/.test(getComputedStyle(el).backgroundImage)}`);
          }
        }
        resolve(out);
      };
      img.onerror = () => resolve([]);
      img.src = url;
    }), dataUrl);
    console.log(`\n--- zoom ${z}: ${invisible.length} invisible ---`);
    console.log(invisible.slice(0, 15).join('\n') || '(none)');
    await page.evaluate(() => { (document.body.style as unknown as { zoom: string }).zoom = ''; });
  }
  await context.close();
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
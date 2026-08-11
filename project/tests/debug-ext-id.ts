/**
 * tests/debug-ext-id.ts — diagnostic: why does red-test V4's getExtensionId fail?
 * Opens a fresh persistent context exactly like newContext('v4'), navigates to
 * the red-test fixture, and reports what serviceWorkers()/pages() contain over
 * 25s. Throwaway — delete after the diagnosis lands.
 */
import { chromium } from 'playwright';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = join(__dirname, '..', '.output', 'chrome-mv3');
const PAGE_FILE = join(__dirname, 'red-test-page.html');
const fileContents = readFileSync(PAGE_FILE, 'utf-8');

const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(fileContents);
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as any).port;
const PAGE_URL = `http://127.0.0.1:${port}/`;

const dir = '/tmp/revueon-red-v4';
try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }

// Hypothesis: red-test sets executablePath=system Chrome; harness uses bundled Chromium.
// Test BOTH in one run to isolate whether the binary is why the SW never registers.
const USE_SYSTEM_CHROME = process.argv.includes('--system-chrome');
console.log('USE_SYSTEM_CHROME =', USE_SYSTEM_CHROME);
const ctx = await chromium.launchPersistentContext(dir, {
  headless: false,
  ...(USE_SYSTEM_CHROME ? { executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome' } : {}),
  args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
});

const tryMatch = (u: string) => { const m = u?.match(/chrome-extension:\/\/([a-p]{32})/i); return m ? m[1] : null; };

console.log('context opened. serviceWorkers at t0:', ctx.serviceWorkers().length, '| pages:', ctx.pages().length);

// Listen for the serviceworker event in the background.
let swEventFired = false;
ctx.on('serviceworker', (sw) => { swEventFired = true; console.log('  >> serviceworker EVENT fired:', sw.url()); });

const page = await ctx.newPage();
await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
console.log('after goto localhost. serviceWorkers:', ctx.serviceWorkers().length, 'pages:', ctx.pages().length);
for (const sw of ctx.serviceWorkers()) console.log('  SW url:', sw.url());
for (const p of ctx.pages()) console.log('  PAGE url:', p.url());

for (let i = 1; i <= 25; i++) {
  await new Promise<void>(r => setTimeout(r, 1000));
  const sws = ctx.serviceWorkers();
  const swIds = sws.map((sw: any) => tryMatch(sw.url())).filter(Boolean);
  if (swIds.length) {
    console.log(`t=${i}s: FOUND ext id ${swIds[0]} (serviceWorkers=${sws.length})`);
    break;
  }
  if (i % 5 === 0) console.log(`t=${i}s: still no extension SW. swEventFired=${swEventFired} serviceWorkers=${sws.length} pages=${ctx.pages().length}`);
}

// Last resort: try opening the popup to force the SW to spawn.
const pages = ctx.pages();
const extPage = pages.find((p: any) => p.url().startsWith('chrome-extension://'));
if (extPage) {
  console.log('found an extension page already open:', extPage.url());
} else {
  console.log('no extension page open. serviceWorkers:', ctx.serviceWorkers().length);
}

console.log('FINAL: serviceWorkers=', ctx.serviceWorkers().length, 'swEventFired=', swEventFired);
await ctx.close();
server.close();
process.exit(0);

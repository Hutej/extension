/**
 * Real-site regression test — Phase 1: Theme re-skin.
 * Tests on en.wikipedia.org + developer.mozilla.org.
 * Uses real gpt-5.2 calls via the loaded extension.
 */

import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(__dirname, '..', '.output', 'chrome-mv3-dev');
const artifactsDir = path.resolve(__dirname, 'artifacts');
const API_KEY = process.env.OPENAI_API_KEY;

if (!API_KEY) {
  throw new Error('ERROR: OPENAI_API_KEY not set in .env');
}

if (!fs.existsSync(artifactsDir)) {
  fs.mkdirSync(artifactsDir, { recursive: true });
}

const THEME_TIMEOUT = 300_000;
const PAGE_LOAD_WAIT = 3000;

// Helper: safely navigate and wait
async function safeGoto(page: any, url: string) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(PAGE_LOAD_WAIT);
}

// Helper: send a theme request and wait for result
async function requestTheme(page: any, intent: string) {
  return page.evaluate(({ intent, timeoutMs }: { intent: string; timeoutMs: number }) => {
    return new Promise<any>((resolve) => {
      const timeout = setTimeout(() => resolve({ error: 'TIMEOUT' }), timeoutMs);
      window.addEventListener('message', function handler(e: MessageEvent) {
        if (e.data && e.data.type === 'WEBMORPH_TEST_THEME_RESULT') {
          clearTimeout(timeout);
          window.removeEventListener('message', handler);
          resolve(e.data);
        }
      });
      window.postMessage({ type: 'WEBMORPH_TEST_THEME', intent }, '*');
    });
  }, { intent, timeoutMs: THEME_TIMEOUT });
}

// Helper: reset all state
async function resetAll(page: any) {
  await page.evaluate(() => {
    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => resolve(), 5000);
      window.addEventListener('message', function handler(e: MessageEvent) {
        if (e.data && e.data.type === 'WEBMORPH_TEST_REMOVE_ALL_DONE') {
          clearTimeout(timeout);
          window.removeEventListener('message', handler);
          resolve();
        }
      });
      window.postMessage({ type: 'WEBMORPH_TEST_REMOVE_ALL' }, '*');
    });
  });
}

async function main() {
  console.log('=== WebMorph Phase 1 Regression Test ===');
  console.log(`Extension path: ${extensionPath}`);
  console.log(`API Key: ${API_KEY!.substring(0, 12)}...`);

  const context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-first-run',
      '--disable-default-apps',
    ],
  });

  let serviceWorker;
  const swTarget = context.serviceWorkers();
  if (swTarget.length > 0) {
    serviceWorker = swTarget[0];
  } else {
    serviceWorker = await context.waitForEvent('serviceworker');
  }
  console.log('Service worker found:', serviceWorker.url());
  serviceWorker.on('console', msg => console.log('SW:', msg.text()));

  await serviceWorker.evaluate((key) => {
    (globalThis as any).chrome.storage.local.set({ openai_api_key: key });
  }, API_KEY!);
  console.log('API key set.\n');

  const page = await context.newPage();
  page.on('console', msg => console.log('BROWSER:', msg.text()));

  // ═══════════════════════════════════════════════════════════════════
  // WIKIPEDIA
  // ═══════════════════════════════════════════════════════════════════

  // ── Test 1: Hide intent (Phase 0 regression) ─────────────────────
  console.log('--- TEST 1: Hide Intent (Wikipedia) ---');
  await safeGoto(page, 'https://en.wikipedia.org/wiki/Main_Page');
  await page.screenshot({ path: path.join(artifactsDir, 'wiki_before_hide.png') });

  const hideResult = await page.evaluate(() => {
    return new Promise<any>((resolve) => {
      const timeout = setTimeout(() => resolve({ error: 'TIMEOUT after 120s' }), 120_000);
      window.addEventListener('message', function handler(e: MessageEvent) {
        if (e.data && e.data.type === 'WEBMORPH_TEST_RESULT') {
          clearTimeout(timeout);
          window.removeEventListener('message', handler);
          resolve(e.data);
        }
      });
      window.postMessage({ type: 'WEBMORPH_TEST_RUN', intent: 'hide the left sidebar navigation' }, '*');
    });
  });

  if (hideResult.error) {
    console.log('  ERROR:', hideResult.error);
  } else {
    console.log('  PLAN:', JSON.stringify(hideResult.plan, null, 2));
    console.log('  RESULT:', JSON.stringify({ count: hideResult.result?.count, dropped: hideResult.result?.dropped }));
    await page.screenshot({ path: path.join(artifactsDir, 'wiki_after_hide.png') });
    console.log('  Screenshots committed.');
  }

  // ── Test 2: Design context capture ────────────────────────────────
  console.log('\n--- TEST 2: Design Context (Wikipedia) ---');
  // Navigate fresh to avoid stale state
  await safeGoto(page, 'https://en.wikipedia.org/wiki/Main_Page');

  const designCtx = await page.evaluate(() => {
    return new Promise<any>((resolve) => {
      const timeout = setTimeout(() => resolve({ serialized: 'TIMEOUT' }), 10000);
      window.addEventListener('message', function handler(e: MessageEvent) {
        if (e.data && e.data.type === 'WEBMORPH_TEST_DESIGN_CONTEXT') {
          clearTimeout(timeout);
          window.removeEventListener('message', handler);
          resolve(e.data);
        }
      });
      window.postMessage({ type: 'WEBMORPH_TEST_GET_DESIGN_CONTEXT' }, '*');
    });
  });
  console.log('  DESIGN CONTEXT:\n' + designCtx.serialized);

  // ── Test 3: Neobrutalism on Wikipedia ─────────────────────────────
  console.log('\n--- TEST 3: Neobrutalism Theme (Wikipedia) ---');
  await safeGoto(page, 'https://en.wikipedia.org/wiki/Main_Page');
  await page.screenshot({ path: path.join(artifactsDir, 'wiki_before_neobrutalism.png') });

  const neoResult = await requestTheme(page, 'Transform this site to neobrutalism');

  if (neoResult.error) {
    console.log('  ERROR:', neoResult.error);
  } else {
    const r = neoResult.result;
    console.log('  OK:', r?.ok);
    console.log('  Reasoning:', r?.reasoning?.substring(0, 200));
    console.log('  CSS length:', r?.sanitizedCss?.length, 'chars');
    console.log('  Strip report:', JSON.stringify(r?.stripReport));
    console.log('  Verify:', JSON.stringify(r?.verify));
    console.log('  Usage:', JSON.stringify(r?.usage));
    // Print first 500 chars of the raw CSS
    if (r?.sanitizedCss) {
      console.log('  CSS preview:', r.sanitizedCss.substring(0, 500));
    }
    if (r?.ok) {
      await page.screenshot({ path: path.join(artifactsDir, 'wiki_after_neobrutalism.png') });
      console.log('  Screenshots committed.');
    }
  }

  await resetAll(page);

  // ── Test 4: Glassmorphism on Wikipedia ────────────────────────────
  console.log('\n--- TEST 4: Glassmorphism Theme (Wikipedia) ---');
  await safeGoto(page, 'https://en.wikipedia.org/wiki/Main_Page');
  await page.screenshot({ path: path.join(artifactsDir, 'wiki_before_glassmorphism.png') });

  const glassResult = await requestTheme(page, 'Transform this site to glassmorphism');

  if (glassResult.error) {
    console.log('  ERROR:', glassResult.error);
  } else {
    const r = glassResult.result;
    console.log('  OK:', r?.ok);
    console.log('  CSS length:', r?.sanitizedCss?.length, 'chars');
    console.log('  Strip report:', JSON.stringify(r?.stripReport));
    console.log('  Verify:', JSON.stringify(r?.verify));
    if (r?.ok) {
      await page.screenshot({ path: path.join(artifactsDir, 'wiki_after_glassmorphism.png') });
      console.log('  Screenshots committed.');
    }
  }

  await resetAll(page);

  // ═══════════════════════════════════════════════════════════════════
  // MDN
  // ═══════════════════════════════════════════════════════════════════

  // ── Test 5: Neobrutalism on MDN ──────────────────────────────────
  console.log('\n--- TEST 5: Neobrutalism Theme (MDN) ---');
  await safeGoto(page, 'https://developer.mozilla.org/en-US/docs/Web/JavaScript');
  await page.screenshot({ path: path.join(artifactsDir, 'mdn_before_neobrutalism.png') });

  const mdnNeoResult = await requestTheme(page, 'Transform this site to neobrutalism');

  if (mdnNeoResult.error) {
    console.log('  ERROR:', mdnNeoResult.error);
  } else {
    const r = mdnNeoResult.result;
    console.log('  OK:', r?.ok);
    console.log('  CSS length:', r?.sanitizedCss?.length, 'chars');
    console.log('  Strip report:', JSON.stringify(r?.stripReport));
    console.log('  Verify:', JSON.stringify(r?.verify));
    if (r?.ok) {
      await page.screenshot({ path: path.join(artifactsDir, 'mdn_after_neobrutalism.png') });
      console.log('  Screenshots committed.');
    }
  }

  await resetAll(page);

  // ── Test 6: Glassmorphism on MDN ─────────────────────────────────
  console.log('\n--- TEST 6: Glassmorphism Theme (MDN) ---');
  await safeGoto(page, 'https://developer.mozilla.org/en-US/docs/Web/JavaScript');
  await page.screenshot({ path: path.join(artifactsDir, 'mdn_before_glassmorphism.png') });

  const mdnGlassResult = await requestTheme(page, 'Transform this site to glassmorphism');

  if (mdnGlassResult.error) {
    console.log('  ERROR:', mdnGlassResult.error);
  } else {
    const r = mdnGlassResult.result;
    console.log('  OK:', r?.ok);
    console.log('  CSS length:', r?.sanitizedCss?.length, 'chars');
    console.log('  Strip report:', JSON.stringify(r?.stripReport));
    console.log('  Verify:', JSON.stringify(r?.verify));
    if (r?.ok) {
      await page.screenshot({ path: path.join(artifactsDir, 'mdn_after_glassmorphism.png') });
      console.log('  Screenshots committed.');
    }
  }

  await resetAll(page);

  console.log('\n=== All Regression Tests Complete ===');
  await context.close();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

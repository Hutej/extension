/**
 * Real-site regression test — Phase 1.2: Intent Routing + Live Popup
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

const PAGE_LOAD_WAIT = 3000;

async function safeGoto(page: any, url: string) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(PAGE_LOAD_WAIT);
}

async function main() {
  console.log('=== WebMorph Phase 1.2 Popup & Routing Test ===');

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
  const swUrl = serviceWorker.url();
  const extensionId = swUrl.split('/')[2];
  const popupUrl = `chrome-extension://${extensionId}/popup.html`;

  await serviceWorker.evaluate((key) => {
    (globalThis as any).chrome.storage.local.set({ openai_api_key: key });
  }, API_KEY!);
  console.log('API key set.');

  const page = await context.newPage();
  page.on('console', msg => console.log('PAGE:', msg.text()));
  
  // ── TEST 1: Wikipedia Neobrutalism (Theme routing) ──
  console.log('\\n--- TEST 1: Wikipedia Theme ---');
  await safeGoto(page, 'https://en.wikipedia.org/wiki/Main_Page');
  await page.screenshot({ path: path.join(artifactsDir, 'popup_wiki_before_neo.png') });

  // Get tab ID of the Wikipedia page
  const wikiTabId = await serviceWorker.evaluate(() => {
    return new Promise(resolve => {
       chrome.tabs.query({ url: "*://*.wikipedia.org/*" }, tabs => {
         resolve(tabs[0]?.id);
       });
    });
  });
  console.log('wikiTabId:', wikiTabId);

  const popup = await context.newPage();
  popup.on('console', msg => console.log('POPUP:', msg.text()));
  await popup.goto(`${popupUrl}?tabId=${wikiTabId}`);
  
  await popup.fill('#intent', 'transform this site to neobrutalism');
  await popup.click('#transformBtn');
  
  console.log('Waiting for AI to classify and generate theme...');
  await popup.waitForFunction(() => {
    const text = document.getElementById('statusEl')?.textContent || '';
    return text.includes('Theme applied') || text.includes('Error') || text.includes('Nothing to change');
  }, undefined, { timeout: 120000 });
  
  let statusText = await popup.evaluate(() => document.getElementById('statusEl')?.textContent);
  console.log('Popup Status:', statusText);
  let savedStatus = await popup.evaluate(() => document.getElementById('statusText')?.textContent);
  console.log('Saved Status:', savedStatus);
  
  await page.screenshot({ path: path.join(artifactsDir, 'popup_wiki_after_neo.png') });
  console.log('Screenshot saved.');

  // Verify reload persistence
  console.log('Reloading page to verify persistence...');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(artifactsDir, 'popup_wiki_reloaded_neo.png') });

  // Reset
  await popup.click('#removeBtn');
  await page.waitForTimeout(1000);

  // ── TEST 2: YouTube Neobrutalism (Honest Scope) ──
  console.log('\\n--- TEST 2: YouTube Theme (Honest Scope) ---');
  await safeGoto(page, 'https://www.youtube.com/');
  await page.screenshot({ path: path.join(artifactsDir, 'popup_yt_before_neo.png') });

  // Accept cookies if present (EU)
  try {
    await page.click('button[aria-label="Accept all"]', { timeout: 2000 });
  } catch(e) {}
  
  // Get tab ID of the YouTube page
  const ytTabId = await serviceWorker.evaluate(() => {
    return new Promise(resolve => {
       chrome.tabs.query({ url: "*://*.youtube.com/*" }, tabs => {
         resolve(tabs[0]?.id);
       });
    });
  });

  await popup.bringToFront();
  await popup.goto(`${popupUrl}?tabId=${ytTabId}`);
  await popup.fill('#intent', 'neobrutalism theme with yellow and black');
  await popup.click('#transformBtn');

  console.log('Waiting for AI on YouTube...');
  await popup.waitForFunction(() => {
    const text = document.getElementById('statusEl')?.textContent || '';
    return text.includes('Theme applied') || text.includes('Error') || text.includes('Nothing to change');
  }, undefined, { timeout: 120000 });

  statusText = await popup.evaluate(() => document.getElementById('statusEl')?.textContent);
  console.log('Popup Status:', statusText);
  savedStatus = await popup.evaluate(() => document.getElementById('statusText')?.textContent);
  console.log('Saved Status:', savedStatus);

  await page.screenshot({ path: path.join(artifactsDir, 'popup_yt_after_neo.png') });
  console.log('Screenshot saved.');

  // Reset
  await popup.click('#removeBtn');
  await page.waitForTimeout(1000);

  // ── TEST 3: Wikipedia Hide (Plan routing) ──
  console.log('\\n--- TEST 3: Wikipedia Hide (Plan routing) ---');
  await page.bringToFront();
  await safeGoto(page, 'https://en.wikipedia.org/wiki/Main_Page');
  
  const wikiTabId2 = await serviceWorker.evaluate(() => {
    return new Promise(resolve => {
       chrome.tabs.query({ url: "*://*.wikipedia.org/*" }, tabs => {
         resolve(tabs[0]?.id);
       });
    });
  });

  await popup.bringToFront();
  await popup.goto(`${popupUrl}?tabId=${wikiTabId2}`);
  await popup.fill('#intent', 'hide the sidebar');
  await popup.click('#transformBtn');

  console.log('Waiting for AI to classify and hide...');
  await popup.waitForFunction(() => {
    const text = document.getElementById('statusEl')?.textContent || '';
    return text.includes('Applied') || text.includes('Error') || text.includes('Nothing to change');
  }, undefined, { timeout: 120000 });

  statusText = await popup.evaluate(() => document.getElementById('statusEl')?.textContent);
  console.log('Popup Status:', statusText);
  savedStatus = await popup.evaluate(() => document.getElementById('statusText')?.textContent);
  console.log('Saved Status:', savedStatus);

  await page.screenshot({ path: path.join(artifactsDir, 'popup_wiki_after_hide_plan.png') });
  console.log('Screenshot saved.');

  console.log('\\n=== All Popup Tests Complete ===');
  await context.close();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

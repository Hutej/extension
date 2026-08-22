/**
 * tests/foundation-helpers — shared helpers for the F1/F3/F4 foundation tests.
 *
 * Loaded extension, fresh browser context, tool-call dispatch via the popup's
 * chrome.tabs.sendMessage. No model calls — these tests exercise the storage
 * and DOM paths directly.
 *
 * Usage: import from a test script, or run standalone to verify the extension
 * loads and a tool call round-trips.
 */

import { chromium } from 'playwright';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = join(__dirname, '..', '.output', 'chrome-mv3');

/** djb2-like string hash → compact hex, for reporting (assertions compare full strings). */
export function hashStr(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

/** Extract the extension ID from service-worker / page context URLs. */
export async function getExtensionId(context: any): Promise<string> {
  const tryMatch = (url: string): string | null => {
    const m = url.match(/chrome-extension:\/\/([a-p]{32})/i);
    return m ? m[1] : null;
  };
  for (const sw of context.serviceWorkers()) {
    const id = tryMatch(sw.url());
    if (id) return id;
  }
  for (const p of context.pages()) {
    const id = tryMatch(p.url());
    if (id) return id;
  }
  try {
    const sw = await context.waitForEvent('serviceworker', { timeout: 10000 });
    const id = tryMatch(sw.url());
    if (id) return id;
  } catch { /* timeout — fall through */ }
  await new Promise<void>((r) => setTimeout(r, 2000));
  for (const sw of context.serviceWorkers()) {
    const id = tryMatch(sw.url());
    if (id) return id;
  }
  throw new Error('Could not find extension ID. Make sure the extension is built (npm run build).');
}

/** Fresh persistent browser context with the extension loaded. Deletes old user-data dir. */
export async function createContext(runName: string): Promise<any> {
  const userDataDir = `${process.env.TEMP || '/tmp'}/revueon-foundation-${runName}`;
  try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  return chromium.launchPersistentContext(userDataDir, {
    headless: false, // extensions don't work headless
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
    ],
  });
}

/**
 * Send a toolCall to the content script on `page` via a throwaway popup.
 * Matches the tab by exact URL. Returns the tool's result object.
 */
export async function sendToolCall(
  context: any, page: any, tool: string, args: Record<string, unknown>,
): Promise<any> {
  const extensionId = await getExtensionId(context);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.bringToFront();
  const targetUrl = page.url();
  const result = await popup.evaluate(async ({ url, tool, args }: { url: string; tool: string; args: any }) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === url);
    if (!tab) return { ok: false, error: `tab not found for ${url}. Tabs: ${tabs.map((t) => t.url).join(', ')}` };
    return new Promise<any>((resolve) => {
      const t = setTimeout(() => resolve({ ok: false, error: 'tool call timed out (30s)' }), 30000);
      chrome.tabs.sendMessage(tab.id!, { action: 'toolCall', tool, args }, (res: any) => {
        clearTimeout(t);
        resolve(res);
      });
    });
  }, { url: targetUrl, tool, args });
  await popup.close();
  return result;
}

/** Send a toggle message. Returns the new `on` state from the content script. */
export async function sendToggle(context: any, page: any): Promise<boolean | undefined> {
  const extensionId = await getExtensionId(context);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.bringToFront();
  const targetUrl = page.url();
  const result = await popup.evaluate(async (url: string) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === url);
    if (!tab) return undefined;
    return new Promise<any>((resolve) => {
      const t = setTimeout(() => resolve(undefined), 10000);
      chrome.tabs.sendMessage(tab.id!, { action: 'toggle' }, (res: any) => { clearTimeout(t); resolve(res); });
    });
  }, targetUrl);
  await popup.close();
  return result?.on;
}

/**
 * Write a journal entry to chrome.storage.local, keyed by SCOPE (origin +
 * pathname) — the same key format the agent loop + replay path use after F4
 * (rv_<origin><pathname>, i.e. scopeKey). This simulates what the loop does on
 * `done`: persist the applyCss entry so reapplyPersisted()/reinsertSavedCss()
 * replays it on the next page load.
 *
 * F4: includes `path` on the state and `identityDigest` on the entry (SHA-256
 * of the primary target's fingerprint) so replay re-verifies the target. The
 * digest is computed in the page via the real digestOfElement over the live
 * target. A CSS act with no resolvable target passes identityDigest undefined
 * (replay then takes the unverified path — still zero/many/twin guarded by F1).
 *
 * We persist manually because a raw toolCall (bypassing the loop) does NOT
 * trigger persistence — the loop owns persistence, not the content script.
 */
export async function persistJournalEntry(
  context: any, page: any, css: string, goal = 'foundation-test',
): Promise<void> {
  const extensionId = await getExtensionId(context);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.bringToFront();
  const u = new URL(page.url());
  const origin = u.origin;
  const path = u.pathname;
  await popup.evaluate(async ({ origin, path, css, goal }: { origin: string; path: string; css: string; goal: string }) => {
    const key = 'rv_' + origin + path; // F4 scopeKey (origin + pathname)
    // identityDigest left undefined: the live act path computes it via the real
    // fingerprint; this helper persists a CSS cycle entry, and CSS replay
    // (reinsertSavedCss) re-inserts without a digest check, while the mismatch
    // check skips no-digest entries. So undefined is the honest value here.
    const state = {
      enabled: true,
      origin,
      path,
      goal,
      entries: [{
        tool: 'applyCss',
        kind: 'act',
        args: { css },
        result: { applied: css.length, chars: css.length },
        identityDigest: undefined,
        inverse: { kind: 'removeCss', css },
        costMs: 0,
        timestamp: Date.now(),
      }],
      createdAt: Date.now(),
    };
    await chrome.storage.local.set({ [key]: state });
  }, { origin, path, css, goal });
  await popup.close();
}


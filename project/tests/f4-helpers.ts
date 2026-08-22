/**
 * tests/f4-helpers — shared helpers for the F4 browser tests (Phase 5).
 *
 * The F4 tests need to persist a journal entry EXACTLY as the loop does (under
 * the scope key, with `path` + a REAL `identityDigest`) so replay re-verifies
 * it. A raw sendToolCall does NOT persist (the loop owns persistence), so the
 * tests run the real act tool to capture its real digest, then write the entry
 * under scopeKey — mirroring loop.ts persistJournal.
 */
import { createContext, getExtensionId, sendToolCall } from './foundation-helpers.ts';

export { createContext, getExtensionId, sendToolCall };

/** Route a controlled HTML fixture at a fake https URL so the content script
 *  (<all_urls>) loads. Returns the page. */
export async function openFixture(context: any, url: string, html: string): Promise<any> {
  const page = await context.newPage();
  await page.route(url, (route) => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500); // let the content script bind + first reapply
  return page;
}

/** Persist a single act journal entry under the scope key with the given args +
 *  a REAL identityDigest captured by running the act tool first. Returns the
 *  act's full result (so the test knows the digest / applied state).
 *  `tool` is 'setText' | 'insert' | 'hide' | 'applyCss' | 'heal'.
 *  `args` is the act's args; `inverse` is the serializable inverse to persist. */
export async function persistActEntry(
  context: any, page: any,
  opts: { tool: string; args: Record<string, unknown>; inverse: Record<string, unknown>; goal: string; prevHtml?: string },
): Promise<any> {
  const { tool, args, inverse, goal, prevHtml } = opts;
  // Run the real act to capture its real identityDigest + result.
  const res = await sendToolCall(context, page, tool, args);
  const u = new URL(page.url());
  const extensionId = await getExtensionId(context);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.bringToFront();
  await popup.evaluate(async ({ key, origin, path, goal, tool, args, inverse, identityDigest, prevHtml }: any) => {
    const state = {
      enabled: true, origin, path, goal,
      entries: [{
        tool, kind: 'act' as const, args,
        result: { applied: true, matched: 1, unverified: false },
        identityDigest,
        inverse: { ...inverse, ...(prevHtml != null ? { prevHtml } : {}) },
        costMs: 0, timestamp: Date.now(),
      }],
      createdAt: Date.now(),
    };
    await chrome.storage.local.set({ [key]: state });
  }, {
    key: 'rv_' + u.origin + u.pathname, origin: u.origin, path: u.pathname, goal,
    tool, args, inverse, identityDigest: res?.identityDigest, prevHtml,
  });
  await popup.close();
  return res;
}

/** Read the persisted replay report (revueonReplayReport) from storage. */
export async function readReplayReport(context: any): Promise<any[]> {
  const extensionId = await getExtensionId(context);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  const report = await popup.evaluate(async () => {
    const r = await chrome.storage.local.get(['revueonReplayReport']);
    return r.revueonReplayReport ?? [];
  });
  await popup.close();
  return report;
}

/** Send an undoAll to the tab matching page.url(). Returns {undone, failed, size}. */
export async function sendUndoAll(context: any, page: any): Promise<any> {
  const extensionId = await getExtensionId(context);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.bringToFront();
  const r = await popup.evaluate(async (url: string) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === url);
    if (!tab) return { ok: false };
    return new Promise<any>((resolve) => {
      chrome.tabs.sendMessage(tab.id!, { action: 'undoAll' }, (res: any) => resolve(res));
    });
  }, page.url());
  await popup.close();
  return r;
}

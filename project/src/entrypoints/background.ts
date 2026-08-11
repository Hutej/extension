/**
 * entrypoints/background — the brain. Hosts the agent loop and the CSS
 * origin layer. CSS is inserted at the USER origin via chrome.scripting;
 * the content script never touches a style node.
 */

import { runLoop, type LoopResult } from '@/agent/loop';
import { loadJournalState, saveJournalState, originKey } from '@/core/persist';

export default defineBackground(() => {
  // MV3 keepalive — the loop's tool dispatchs keep this SW alive.
  chrome.runtime.onConnect.addListener(() => {});

  // ── A: CSS origin layer — insertCSS / removeCSS at USER origin ────
  // The content script sends CSS; we insert it at the user origin.
  // chrome.scripting cannot be called from a content script.

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Insert CSS at USER origin.
    if (message.action === 'insertCSS') {
      const tabId = sender.tab?.id;
      if (tabId == null) { sendResponse({ ok: false, error: 'no tab id' }); return; }
      chrome.scripting.insertCSS(
        { target: { tabId }, css: message.css, origin: 'USER' },
        () => sendResponse({ ok: !chrome.runtime.lastError, error: chrome.runtime.lastError?.message }),
      );
      return true;
    }

    // Remove CSS at USER origin (exact string match).
    if (message.action === 'removeCSS') {
      const tabId = sender.tab?.id;
      if (tabId == null) { sendResponse({ ok: false, error: 'no tab id' }); return; }
      chrome.scripting.removeCSS(
        { target: { tabId }, css: message.css, origin: 'USER' },
        () => sendResponse({ ok: !chrome.runtime.lastError, error: chrome.runtime.lastError?.message }),
      );
      return true;
    }

    // Toggle CSS off/on — called by the content script's toggle handler.
    if (message.action === 'toggleCss') {
      void handleToggleCss(sender.tab?.id, message.on, sendResponse);
      return true;
    }

    // Run the agent loop.
    if (message.action === 'runLoop') {
      const tabId = message.tabId as number;
      const goal = message.goal as string;

      chrome.storage.local.get(['cloudflare_account_id', 'cloudflare_api_token'], async (result) => {
        const accountId = result.cloudflare_account_id as string | undefined;
        const apiToken = result.cloudflare_api_token as string | undefined;
        if (!accountId || !apiToken) {
          sendResponse({ ok: false, error: 'No Cloudflare credentials set. Set them in Revueon settings.' });
          return;
        }

        try {
          const result: LoopResult = await runLoop(goal, tabId, { accountId, apiToken });
          sendResponse({
            ok: result.status !== 'error',
            status: result.status,
            summary: result.summary,
            reason: result.reason,
            paidCalls: result.paidCalls,
            wallMs: result.wallMs,
            steps: result.budget.stepsUsed,
            toolsCalled: result.journal.entries.map((e) => e.tool),
            journal: result.journal.entries,
          });
        } catch (err) {
          sendResponse({ ok: false, error: (err as Error).message });
        }
      });
      return true; // async response
    }

    return false;
  });

  // ── D: Continuity — re-insert saved CSS on navigation ────────────
  // No MutationObserver, no replay. The background subscribes to
  // webNavigation.onCommitted and re-inserts the saved CSS look.
  chrome.webNavigation?.onCommitted.addListener((details) => {
    if (details.frameId !== 0) return; // main frame only
    void reinsertSavedCss(details.tabId, details.url);
  });
});

/** D: Re-insert saved CSS from the journal for this origin. */
async function reinsertSavedCss(tabId: number, url: string): Promise<void> {
  try {
    const origin = (() => { try { return new URL(url).origin; } catch { return ''; } })();
    if (!origin) return;
    const key = originKey(origin);
    const state = await loadJournalState(key);
    if (!state.enabled || !state.entries?.length) return;
    // Collect CSS strings from act entries with removeCss inverses.
    for (const entry of state.entries) {
      if (entry.kind !== 'act') continue;
      const inv = entry.inverse as any;
      if (inv?.kind === 'removeCss' && inv.css) {
        try {
          await chrome.scripting.insertCSS({ target: { tabId }, css: inv.css, origin: 'USER' });
        } catch { /* ignore — tab may be gone */ }
      }
    }
  } catch { /* ignore */ }
}

/** Toggle CSS off/on for a tab. Loads the saved journal and
 *  removes/re-inserts all CSS entries. */
async function handleToggleCss(tabId: number | undefined, on: boolean, sendResponse: (r: any) => void): Promise<void> {
  if (tabId == null) { sendResponse({ ok: false, error: 'no tab id' }); return; }
  try {
    const tab = await chrome.tabs.get(tabId);
    const origin = (() => { try { return new URL(tab.url || '').origin; } catch { return ''; } })();
    if (!origin) { sendResponse({ ok: false, error: 'no origin' }); return; }
    const key = originKey(origin);
    const state = await loadJournalState(key);
    if (!state.entries?.length) { sendResponse({ ok: true, on }); return; }

    const cssEntries = state.entries.filter((e) =>
      e.kind === 'act' && (e.inverse as any)?.kind === 'removeCss' && (e.inverse as any)?.css,
    );

    for (const entry of cssEntries) {
      const css = (entry.inverse as any).css as string;
      try {
        if (on) {
          await chrome.scripting.insertCSS({ target: { tabId }, css, origin: 'USER' });
        } else {
          await chrome.scripting.removeCSS({ target: { tabId }, css, origin: 'USER' });
        }
      } catch { /* ignore individual failures */ }
    }

    // Persist the enabled flag.
    state.enabled = on;
    await saveJournalState(key, state);
    sendResponse({ ok: true, on });
  } catch (err) {
    sendResponse({ ok: false, error: (err as Error).message });
  }
}

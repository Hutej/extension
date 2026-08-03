/**
 * background — thin AI transport. Holds the API key, forwards the perception to
 * core/reason (role-dispatched), returns a validated StyleSpec. No page logic.
 *
 * The `role` field selects the prompt + model: 'architect' / 'painter' / 'critic'
 * for the split design path, 'design' for the single-call restyle-only path.
 */

import { requestStyleSpec, requestArchitectSpec, requestPainterSpec, requestCriticCorrection, type Role } from '@/core/reason';

async function dispatchRole(role: Role, intent: string, perception: string, accountId: string, apiToken: string, critique?: string, timeoutMs?: number) {
  const req = { intent, perception, accountId, apiKey: apiToken, critique, timeoutMs };
  switch (role) {
    case 'architect': return requestArchitectSpec(req);
    case 'painter': return requestPainterSpec(req);
    case 'critic': return requestCriticCorrection(req);
    default: return requestStyleSpec(req);
  }
}

export default defineBackground(() => {
  // MV3 keepalive: a content script opens a long-lived port during a run; the
  // port's existence keeps this service worker alive so it isn't killed mid-fetch
  // (which would hang the content script's sendMessage silently — the ~30s idle
  // kill terminates the SW during a 70-90s model fetch). The content script
  // disconnects on run completion.
  chrome.runtime.onConnect.addListener(() => {});

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === 'styleSpec') {
      // Unified on Cloudflare Workers AI credentials (cloudflare_account_id +
      // cloudflare_api_token). The orphaned openai_api_key path is deleted.
      chrome.storage.local.get(['cloudflare_account_id', 'cloudflare_api_token'], async (result: Record<string, unknown>) => {
        const accountId = result.cloudflare_account_id as string | undefined;
        const apiToken = result.cloudflare_api_token as string | undefined;
        if (!accountId || !apiToken) {
          sendResponse({ ok: false, kind: 'invalid_key', message: 'No Cloudflare Workers AI credentials set. Set CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN.' });
          return;
        }
        try {
          const res = await dispatchRole(message.role as Role, message.intent, message.perception, accountId, apiToken, message.critique, message.timeoutMs);
          sendResponse(res);
        } catch (err) {
          sendResponse({ ok: false, kind: 'unknown', message: (err as Error).message || 'Design engine error.' });
        }
      });
      return true; // async response
    }
    // captureVisibleTab relay — only the service worker can capture a tab.
    // The content script asks for a screenshot of its own tab; we capture the
    // active tab of the SENDER's window (the harness brings the tab to front first).
    if (message.action === 'captureVisibleTab') {
      const windowId = _sender?.tab?.windowId as number | undefined;
      try {
        const capture = (wId?: number) => chrome.tabs.captureVisibleTab(wId as number, { format: 'png' }, (dataUrl: string | undefined) => {
          if (chrome.runtime.lastError || !dataUrl) { sendResponse({ ok: false, message: chrome.runtime.lastError?.message || 'capture failed' }); return; }
          sendResponse({ ok: true, dataUrl });
        });
        capture(windowId);
      } catch (err) {
        sendResponse({ ok: false, message: (err as Error).message });
      }
      return true; // async response
    }
    return false;
  });
});

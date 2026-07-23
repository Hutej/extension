/**
 * background — thin AI transport. Holds the API key, forwards the perception to
 * core/reason, returns a validated StyleSpec. No page logic lives here.
 */

import { requestStyleSpec } from '@/core/reason';

export default defineBackground(() => {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === 'styleSpec') {
      chrome.storage.local.get(['openai_api_key'], async (result: Record<string, unknown>) => {
        const apiKey = result.openai_api_key as string | undefined;
        if (!apiKey) {
          sendResponse({ ok: false, kind: 'invalid_key', message: 'No API key set. Open Settings in the WebMorph popup.' });
          return;
        }
        try {
          const res = await requestStyleSpec({ intent: message.intent, perception: message.perception, apiKey, critique: message.critique, timeoutMs: message.timeoutMs });
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

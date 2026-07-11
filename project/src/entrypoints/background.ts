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
          const res = await requestStyleSpec({ intent: message.intent, perception: message.perception, apiKey, critique: message.critique });
          sendResponse(res);
        } catch (err) {
          sendResponse({ ok: false, kind: 'unknown', message: (err as Error).message || 'Design engine error.' });
        }
      });
      return true; // async response
    }
    return false;
  });
});

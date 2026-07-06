import { requestPlan, setTestInjectedError } from '@/core/reason';

export default defineBackground(() => {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === 'INJECT_ERROR') {
      setTestInjectedError(message.errors);
      sendResponse({ ok: true });
      return false; // synchronous
    }
    if (message.action === 'transform') {
      chrome.storage.local.get(['openai_api_key'], async (result) => {
        const apiKey = result.openai_api_key || 'test_key';
        
        try {
          const planResult = await requestPlan({
            intent: message.intent,
            outline: message.outline,
            apiKey,
          });
          sendResponse(planResult);
        } catch (err: any) {
          console.error(err);
          sendResponse({ ok: false, kind: 'unknown', message: err.message || 'Unknown error during planning' });
        }
      });
      return true; // Keep the message channel open for the async response
    }
  });
});

import { requestPlan } from '@/core/reason';

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === 'transform') {
      browser.storage.local.get(['openai_api_key']).then(async (result) => {
        const apiKey = result.openai_api_key;
        if (!apiKey) {
          sendResponse({ error: 'OpenAI API key not set in Settings.' });
          return;
        }
        
        try {
          const plan = await requestPlan({
            intent: message.intent,
            outline: message.outline,
            apiKey,
          });
          sendResponse({ plan });
        } catch (err: any) {
          console.error(err);
          sendResponse({ error: err.message || 'Unknown error during planning' });
        }
      });
      return true; // Keep the message channel open for the async response
    }
  });
});

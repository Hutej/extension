import { loadSiteState, saveSiteState, clearSiteState } from '@/core/persist';

const transformBtn = document.getElementById('transformBtn') as HTMLButtonElement;
const resetBtn = document.getElementById('resetBtn') as HTMLButtonElement;
const statusEl = document.getElementById('statusEl') as HTMLDivElement;
const intentEl = document.getElementById('intent') as HTMLTextAreaElement;
const settingsToggle = document.getElementById('settingsToggle') as HTMLSpanElement;
const settingsArea = document.getElementById('settingsArea') as HTMLDivElement;
const apiKeyEl = document.getElementById('apiKey') as HTMLInputElement;
const saveKeyBtn = document.getElementById('saveKeyBtn') as HTMLButtonElement;
const statusText = document.getElementById('statusText') as HTMLDivElement;
const toggleBtn = document.getElementById('toggleBtn') as HTMLButtonElement;
const removeBtn = document.getElementById('removeBtn') as HTMLButtonElement;

// Load API key
browser.storage.local.get(['openai_api_key']).then((res: any) => {
  if (res.openai_api_key) apiKeyEl.value = res.openai_api_key as string;
});

settingsToggle.addEventListener('click', () => {
  settingsArea.classList.toggle('open');
});

saveKeyBtn.addEventListener('click', () => {
  browser.storage.local.set({ openai_api_key: apiKeyEl.value.trim() }).then(() => {
    settingsArea.classList.remove('open');
    statusEl.textContent = 'API Key saved.';
  });
});

async function getCurrentTabId(): Promise<number | undefined> {
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.has('tabId')) {
    return parseInt(urlParams.get('tabId')!, 10);
  }
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id;
}

transformBtn.addEventListener('click', async () => {
  const intent = intentEl.value.trim();
  if (!intent) {
    statusEl.textContent = 'Please enter an intent.';
    return;
  }
  
  const tabId = await getCurrentTabId();
  if (!tabId) {
    statusEl.textContent = 'Error: Cannot determine active tab.';
    return;
  }

  statusEl.textContent = 'Thinking...';
  transformBtn.disabled = true;

  try {
    chrome.tabs.sendMessage(tabId, { action: 'transform', intent }, (res) => {
      if (chrome.runtime.lastError || !res) {
        statusEl.textContent = 'Error communicating with page. Please refresh the page.';
        transformBtn.disabled = false;
        return;
      }
      
      if (res.error) {
        statusEl.textContent = 'Error: ' + res.error;
      } else if (res.ok === false) {
        const msgMap: Record<string, string> = {
          'invalid_key': 'Invalid API key',
          'rate_limited': 'Rate limited, try again',
          'network': 'Network error',
          'timeout': 'Request timed out',
          'bad_output': "Couldn't produce a valid change"
        };
        statusEl.textContent = msgMap[res.kind] || res.message || 'Unknown error';
      } else {
        if (res.kind === 'theme') {
          statusEl.textContent = `Theme applied!\nReasoning: ${res.result?.reasoning || ''}`;
          updateSiteStatus();
        } else {
          const plan = res.plan;
          if (!plan || !plan.operations || plan.operations.length === 0) {
            statusEl.textContent = 'Nothing to change for that request.';
          } else {
            statusEl.textContent = `Applied ${plan.operations.length} actions.\nReasoning: ${plan.reasoning}`;
            updateSiteStatus();
          }
        }
      }
      transformBtn.disabled = false;
    });
  } catch (err: any) {
    statusEl.textContent = 'Error communicating with page. Please refresh the page.';
    transformBtn.disabled = false;
  }
});

resetBtn.addEventListener('click', async () => {
  const tabId = await getCurrentTabId();
  if (!tabId) return;
  
  try {
    chrome.tabs.sendMessage(tabId, { action: 'reset' }, () => {
      if (chrome.runtime.lastError) {
        statusEl.textContent = 'Reset failed: Please refresh the page.';
      } else {
        statusEl.textContent = 'Reset complete.';
      }
    });
  } catch (err: any) {
    statusEl.textContent = 'Reset failed: Please refresh the page.';
  }
});

async function updateSiteStatus() {
  const tabId = await getCurrentTabId();
  if (!tabId) {
    statusText.textContent = 'Not a valid site.';
    return;
  }
  const tab = await browser.tabs.get(tabId);
  
  if (!tab || !tab.url || !tab.url.startsWith('http')) {
    statusText.textContent = 'Not a valid site.';
    return;
  }
  const url = new URL(tab.url);
  const origin = url.origin;
  const state = await loadSiteState(origin);
  
  const hasSaved = state.transforms.length > 0 || state.behaviors.length > 0 || !!state.theme;
  
  if (!hasSaved) {
    statusText.textContent = `No saved transforms.`;
    toggleBtn.disabled = true;
    removeBtn.disabled = true;
  } else {
    let count = state.transforms.length + state.behaviors.length;
    let label = count > 0 ? `${count} transform(s) saved.` : '';
    if (state.theme) label += (label ? ' ' : '') + 'Theme saved.';
    statusText.textContent = `${label}\nStatus: ${state.enabled ? 'ON' : 'OFF'}`;
    toggleBtn.disabled = false;
    toggleBtn.textContent = state.enabled ? 'Turn Off' : 'Turn On';
    removeBtn.disabled = false;
  }
}

toggleBtn.addEventListener('click', async () => {
  const tabId = await getCurrentTabId();
  if (!tabId) return;
  const tab = await browser.tabs.get(tabId);
  if (!tab || !tab.url || !tab.id) return;
  const origin = new URL(tab.url).origin;
  const state = await loadSiteState(origin);
  state.enabled = !state.enabled;
  await saveSiteState(origin, state);
  updateSiteStatus();
  // Tell content script to toggle
  chrome.tabs.sendMessage(tab.id, { action: 'toggle' });
});

removeBtn.addEventListener('click', async () => {
  const tabId = await getCurrentTabId();
  if (!tabId) return;
  const tab = await browser.tabs.get(tabId);
  if (!tab || !tab.url || !tab.id) return;
  const origin = new URL(tab.url).origin;
  await clearSiteState(origin);
  updateSiteStatus();
  // Tell content script to remove
  chrome.tabs.sendMessage(tab.id, { action: 'remove_all' });
});

updateSiteStatus();

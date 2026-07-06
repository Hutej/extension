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
browser.storage.local.get(['openai_api_key']).then(res => {
  if (res.openai_api_key) apiKeyEl.value = res.openai_api_key;
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
  if (!tabId) return;

  statusEl.textContent = 'Thinking...';
  transformBtn.disabled = true;

  try {
    const res = await browser.tabs.sendMessage(tabId, { action: 'transform', intent });
    if (res.error) {
      statusEl.textContent = 'Error: ' + res.error;
    } else {
      const plan = res.plan;
      statusEl.textContent = `Hidden: ${res.count} elements.\nReasoning: ${plan.reasoning}`;
    }
  } catch (err: any) {
    statusEl.textContent = 'Error communicating with page. Please refresh the page.';
  } finally {
    transformBtn.disabled = false;
  }
});

resetBtn.addEventListener('click', async () => {
  const tabId = await getCurrentTabId();
  if (!tabId) return;
  
  try {
    await browser.tabs.sendMessage(tabId, { action: 'reset' });
    statusEl.textContent = 'Reset complete.';
  } catch (err: any) {
    statusEl.textContent = 'Reset failed: Please refresh the page.';
  }
});

async function updateSiteStatus() {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab || !tab.url || !tab.url.startsWith('http')) {
    statusText.textContent = 'Not a valid site.';
    return;
  }
  const url = new URL(tab.url);
  const origin = url.origin;
  const state = await loadSiteState(origin);
  
  if (state.transforms.length === 0) {
    statusText.textContent = `No saved transforms.`;
    toggleBtn.disabled = true;
    removeBtn.disabled = true;
  } else {
    statusText.textContent = `${state.transforms.length} transform(s) saved.\nStatus: ${state.enabled ? 'ON' : 'OFF'}`;
    toggleBtn.disabled = false;
    toggleBtn.textContent = state.enabled ? 'Turn Off' : 'Turn On';
    removeBtn.disabled = false;
  }
}

toggleBtn.addEventListener('click', async () => {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab || !tab.url || !tab.id) return;
  const origin = new URL(tab.url).origin;
  const state = await loadSiteState(origin);
  state.enabled = !state.enabled;
  await saveSiteState(origin, state);
  updateSiteStatus();
  // Tell content script to toggle
  browser.tabs.sendMessage(tab.id, { action: 'toggle' });
});

removeBtn.addEventListener('click', async () => {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab || !tab.url || !tab.id) return;
  const origin = new URL(tab.url).origin;
  await clearSiteState(origin);
  updateSiteStatus();
  // Tell content script to remove
  browser.tabs.sendMessage(tab.id, { action: 'remove_all' });
});

updateSiteStatus();

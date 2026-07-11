import { loadSiteState } from '@/core/persist';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const transformBtn = $<HTMLButtonElement>('transformBtn');
const toggleBtn = $<HTMLButtonElement>('toggleBtn');
const removeBtn = $<HTMLButtonElement>('removeBtn');
const intentEl = $<HTMLTextAreaElement>('intent');
const statusEl = $<HTMLDivElement>('statusEl');
const siteStatus = $<HTMLDivElement>('siteStatus');
const specEl = $<HTMLPreElement>('webmorph-spec');
const settingsToggle = $<HTMLSpanElement>('settingsToggle');
const settingsArea = $<HTMLDivElement>('settingsArea');
const apiKeyEl = $<HTMLInputElement>('apiKey');
const saveKeyBtn = $<HTMLButtonElement>('saveKeyBtn');

browser.storage.local.get(['openai_api_key']).then((res: Record<string, unknown>) => {
  if (res.openai_api_key) apiKeyEl.value = res.openai_api_key as string;
});

settingsToggle.addEventListener('click', () => settingsArea.classList.toggle('open'));
saveKeyBtn.addEventListener('click', () => {
  browser.storage.local.set({ openai_api_key: apiKeyEl.value.trim() }).then(() => {
    settingsArea.classList.remove('open');
    statusEl.textContent = 'API key saved.';
  });
});

async function getTabId(): Promise<number | undefined> {
  const params = new URLSearchParams(window.location.search);
  if (params.has('tabId')) return parseInt(params.get('tabId')!, 10);
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id;
}

transformBtn.addEventListener('click', async () => {
  const intent = intentEl.value.trim();
  if (!intent) { statusEl.textContent = 'Enter a request first.'; return; }
  const tabId = await getTabId();
  if (!tabId) { statusEl.textContent = 'Cannot find the active tab.'; return; }

  statusEl.textContent = 'Designing…';
  specEl.textContent = '';
  transformBtn.disabled = true;

  chrome.tabs.sendMessage(tabId, { action: 'transform', intent }, (res) => {
    transformBtn.disabled = false;
    if (chrome.runtime.lastError || !res) {
      statusEl.textContent = 'Error: page not reachable — refresh the tab and retry.';
      return;
    }
    if (res.ok) {
      statusEl.textContent = `Applied.\n${res.reasoning || ''}`;
      if (res.spec) specEl.textContent = JSON.stringify(res.spec, null, 2);
      updateSiteStatus();
    } else {
      statusEl.textContent = 'Error: ' + (res.message || 'transform failed');
      if (res.spec) specEl.textContent = JSON.stringify(res.spec, null, 2);
    }
  });
});

toggleBtn.addEventListener('click', async () => {
  const tabId = await getTabId();
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, { action: 'toggle' }, () => updateSiteStatus());
});

removeBtn.addEventListener('click', async () => {
  const tabId = await getTabId();
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, { action: 'remove_all' }, () => updateSiteStatus());
});

async function updateSiteStatus(): Promise<void> {
  const tabId = await getTabId();
  if (!tabId) return;
  const tab = await browser.tabs.get(tabId);
  if (!tab?.url || !tab.url.startsWith('http')) { siteStatus.textContent = ''; return; }
  const state = await loadSiteState(new URL(tab.url).origin);
  if (!state.style) {
    siteStatus.textContent = 'No saved transform for this site.';
    toggleBtn.disabled = true;
    removeBtn.disabled = true;
  } else {
    siteStatus.textContent = `Saved transform: "${state.style.intent}" — ${state.enabled ? 'ON' : 'OFF'}`;
    toggleBtn.disabled = false;
    toggleBtn.textContent = state.enabled ? 'Turn off' : 'Turn on';
    removeBtn.disabled = false;
  }
}

updateSiteStatus();

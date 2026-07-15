/**
 * popup/main — WebMorph popup UI. Drives the transform via the content script.
 * Round 7: product-quality — error taxonomy, elapsed timer, metrics, getSiteInfo
 * (no tabs permission needed).
 */

import { loadSiteState, storageKey } from '@/core/persist';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const transformBtn = $<HTMLButtonElement>('transformBtn');
const toggleBtn = $<HTMLButtonElement>('toggleBtn');
const removeBtn = $<HTMLButtonElement>('removeBtn');
const intentEl = $<HTMLTextAreaElement>('intent');
const statusEl = $<HTMLDivElement>('statusEl');
const elapsedEl = $<HTMLDivElement>('elapsedEl');
const metricsEl = $<HTMLDivElement>('metricsEl');
const siteStatus = $<HTMLDivElement>('siteStatus');
const settingsToggle = $<HTMLSpanElement>('settingsToggle');
const settingsArea = $<HTMLDivElement>('settingsArea');
const apiKeyEl = $<HTMLInputElement>('apiKey');
const saveKeyBtn = $<HTMLButtonElement>('saveKeyBtn');

// ── API key ──
browser.storage.local.get(['openai_api_key']).then((res: Record<string, unknown>) => {
  if (res.openai_api_key) apiKeyEl.value = res.openai_api_key as string;
});
settingsToggle.addEventListener('click', () => settingsArea.classList.toggle('open'));
saveKeyBtn.addEventListener('click', () => {
  browser.storage.local.set({ openai_api_key: apiKeyEl.value.trim() }).then(() => {
    settingsArea.classList.remove('open');
    showStatus('API key saved.', 'ok');
  });
});

// ── Helpers ──
async function getTabId(): Promise<number | undefined> {
  const params = new URLSearchParams(window.location.search);
  if (params.has('tabId')) return parseInt(params.get('tabId')!, 10);
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id;
}

function showStatus(msg: string, kind: 'ok' | 'err' | 'info'): void {
  statusEl.textContent = msg;
  statusEl.className = `status show ${kind}`;
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtUsage(u: unknown): string {
  const usage = u as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } } | undefined;
  if (!usage) return '?';
  const r = usage.completion_tokens_details?.reasoning_tokens;
  return `${usage.total_tokens ?? '?'}${r ? ` (r:${r})` : ''}`;
}

// ── Error taxonomy ──
const ERROR_MESSAGES: Record<string, string> = {
  invalid_key: 'Invalid API key. Click ⚙ Settings to update your key.',
  timeout: 'The design engine timed out. The page might be very large — try again or try a simpler page.',
  context_limit: 'This page is too large for the model. Try a smaller or simpler page.',
  network: 'Network error. Check your connection and try again.',
  rate_limited: 'Rate limited by the API. Wait a moment and try again.',
  bad_output: 'The model returned an invalid response. Try again with a different prompt.',
  invalid_request: 'The API rejected the request. Check your key and try again.',
};

// ── Transform ──
let elapsedTimer: ReturnType<typeof setInterval> | null = null;

transformBtn.addEventListener('click', async () => {
  const intent = intentEl.value.trim();
  if (!intent) { showStatus('Enter a request first.', 'err'); return; }
  const tabId = await getTabId();
  if (!tabId) { showStatus('Cannot find the active tab.', 'err'); return; }

  // Loading state.
  showStatus('<span class="spinner"></span>Designing…', 'info');
  metricsEl.className = 'metrics';
  elapsedEl.className = 'elapsed show';
  transformBtn.disabled = true;
  const t0 = Date.now();
  elapsedTimer = setInterval(() => {
    elapsedEl.textContent = `Elapsed: ${fmtMs(Date.now() - t0)}…`;
  }, 500);

  chrome.tabs.sendMessage(tabId, { action: 'transform', intent }, (res) => {
    if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
    elapsedEl.className = 'elapsed';
    transformBtn.disabled = false;

    if (chrome.runtime.lastError || !res) {
      showStatus('Cannot reach the page. Refresh the tab and retry.', 'err');
      return;
    }
    if (res.ok) {
      const checks = res.verify?.checks;
      const verdict = checks ? `${checks.covered ? '✓' : '✗'}coverage ${checks.changed ? '✓' : '✗'}change ${checks.coherent ? '✓' : '✗'}coherent ${checks.contrastOk ? '✓' : '✗'}contrast ${checks.noOverflow ? '✓' : '✗'}no-overflow` : '';
      showStatus(`✓ Applied: ${res.reasoning || 'Design applied.'}${verdict ? '\n' + verdict : ''}`, 'ok');
      // Metrics.
      metricsEl.innerHTML = [
        `<span>⏱ ${fmtMs(res.wallMs ?? 0)}</span>`,
        `<span>🤖 ${res.model ?? '?'}</span>`,
        `<span>🎫 ${fmtUsage(res.usage)}</span>`,
        `<span>💰 ${res.paidCalls ?? 1} call(s)</span>`,
        `<span>📊 ${res.clusters ?? '?'} clusters</span>`,
      ].join('');
      metricsEl.className = 'metrics show';
      updateSiteStatus();
    } else {
      const kind = res.kind as string | undefined;
      const msg = (kind && ERROR_MESSAGES[kind]) ? ERROR_MESSAGES[kind] : (res.message || 'Transform failed.');
      showStatus(`✗ ${msg}`, 'err');
    }
  });
});

// ── Toggle / Remove ──
toggleBtn.addEventListener('click', async () => {
  const tabId = await getTabId();
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, { action: 'toggle' }, () => updateSiteStatus());
});

removeBtn.addEventListener('click', async () => {
  const tabId = await getTabId();
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, { action: 'remove_all' }, () => {
    showStatus('Transform removed.', 'info');
    updateSiteStatus();
  });
});

// ── Site status (via getSiteInfo — no tabs permission needed) ──
async function updateSiteStatus(): Promise<void> {
  const tabId = await getTabId();
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, { action: 'getSiteInfo' }, async (info) => {
    if (chrome.runtime.lastError || !info?.url) { siteStatus.textContent = ''; return; }
    try {
      const key = storageKey(info.url);
      const state = await loadSiteState(key);
      if (!state.style) {
        // Try origin-level fallback.
        const originState = await loadSiteState(new URL(info.url).origin);
        if (!originState.style) {
          siteStatus.textContent = 'No saved transform for this site.';
          toggleBtn.disabled = true;
          removeBtn.disabled = true;
          return;
        }
        state.style = originState.style;
        state.enabled = originState.enabled;
      }
      siteStatus.textContent = `"${state.style.intent}" — ${state.enabled ? 'ON' : 'OFF'}`;
      toggleBtn.disabled = false;
      toggleBtn.textContent = state.enabled ? 'Turn off' : 'Turn on';
      removeBtn.disabled = false;
    } catch { siteStatus.textContent = ''; }
  });
}

updateSiteStatus();

/**
 * popup/main — WebMorph popup UI. Drives the transform via the content script.
 * Product-quality — error taxonomy, elapsed timer, metrics, getSiteInfo
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
const accountIdEl = $<HTMLInputElement>('accountId');
const apiTokenEl = $<HTMLInputElement>('apiToken');
const saveKeyBtn = $<HTMLButtonElement>('saveKeyBtn');
const credStatusEl = $<HTMLDivElement>('credStatus');
const optOutEl = $<HTMLInputElement>('optOutModel');
const disclosureEl = $<HTMLDivElement>('disclosure');
const disclosureOkBtn = $<HTMLButtonElement>('disclosureOk');

// ── Cloudflare credentials (unified on cloudflare_account_id + cloudflare_api_token) ──
void browser.storage.local.get(['cloudflare_account_id', 'cloudflare_api_token', 'webmorphConsentShown', 'webmorphOptOutModel']).then((res: Record<string, unknown>) => {
  if (res.cloudflare_account_id) accountIdEl.value = res.cloudflare_account_id as string;
  if (res.cloudflare_api_token) apiTokenEl.value = res.cloudflare_api_token as string;
  // show disclosure before the first transform.
  if (!res.webmorphConsentShown) disclosureEl.style.display = 'block';
  if (res.webmorphOptOutModel) optOutEl.checked = true;
});
settingsToggle.addEventListener('click', () => settingsArea.classList.toggle('open'));
// opt-out toggle
optOutEl.addEventListener('change', () => {
  void browser.storage.local.set({ webmorphOptOutModel: optOutEl.checked });
});
// disclosure acknowledgement
disclosureOkBtn.addEventListener('click', () => {
  void browser.storage.local.set({ webmorphConsentShown: true });
  disclosureEl.style.display = 'none';
});
saveKeyBtn.addEventListener('click', async () => {
  const accountId = accountIdEl.value.trim();
  const apiToken = apiTokenEl.value.trim();
  credStatusEl.textContent = '';
  if (!accountId || !apiToken) {
    credStatusEl.textContent = 'Both Account ID and API Token are required.';
    credStatusEl.style.color = 'var(--err)';
    return;
  }
  saveKeyBtn.disabled = true;
  credStatusEl.textContent = 'Validating credentials…';
  credStatusEl.style.color = 'var(--muted)';
  try {
    // Validate credentials with a minimal model call (1 token max) to the
    // Cloudflare Workers AI endpoint. A 200 = both account ID and token are valid.
    // A 401/403 = invalid token or wrong account. This catches bad credentials at
    // save time, not silently at transform time.
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiToken}` },
      body: JSON.stringify({ model: '@cf/zai-org/glm-5.2', max_completion_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
    });
    if (res.ok) {
      await browser.storage.local.set({ cloudflare_account_id: accountId, cloudflare_api_token: apiToken });
      settingsArea.classList.remove('open');
      showStatus('Cloudflare credentials saved and validated.', 'ok');
      credStatusEl.textContent = '';
    } else if (res.status === 401 || res.status === 403) {
      credStatusEl.textContent = 'Invalid credentials — check your Account ID and API Token.';
      credStatusEl.style.color = 'var(--err)';
    } else {
      const body = await res.text().catch(() => '');
      credStatusEl.textContent = `Validation failed (HTTP ${res.status}): ${body.slice(0, 120)}`;
      credStatusEl.style.color = 'var(--err)';
    }
  } catch (err) {
    credStatusEl.textContent = `Network error: ${(err as Error).message}`;
    credStatusEl.style.color = 'var(--err)';
  }
  saveKeyBtn.disabled = false;
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
  // gate on consent disclosure.
  const consent = await browser.storage.local.get(['webmorphConsentShown', 'webmorphOptOutModel']);
  if (!consent.webmorphConsentShown) {
    disclosureEl.style.display = 'block';
    showStatus('Please review and acknowledge the disclosure below first.', 'info');
    return;
  }
  // gate on opt-out — if the user opted out of model calls, only fast paths work.
  if (consent.webmorphOptOutModel) {
    const kind = /^(hide|remove|delete|get rid of|move|shift|relocate|push|send)\b/i.test(intent);
    if (!kind) {
      showStatus('Model calls are disabled (opt-out). Only hide/move commands work without AI.', 'err');
      return;
    }
  }

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
      // Hidden JSON for test harness.
      $('webmorph-result').textContent = JSON.stringify(res);
      // Metrics.
      metricsEl.innerHTML = [
        `<span>⏱ ${fmtMs(res.wallMs ?? 0)}</span>`,
        `<span>🤖 ${res.model ?? '?'}</span>`,
        `<span>🎫 ${fmtUsage(res.usage)}</span>`,
        `<span>💰 ${res.paidCalls ?? 1} request(s)</span>`,
        `<span>📊 ${res.clusters ?? '?'} clusters</span>`,
      ].join('');
      metricsEl.className = 'metrics show';
      // surface perception truncation if it happened.
      if (res.perceptionTruncated && (res.perceptionTruncated.walk || res.perceptionTruncated.serialize)) {
        const parts: string[] = [];
        if (res.perceptionTruncated.walk) parts.push('page was too large to fully perceive');
        if (res.perceptionTruncated.serialize) parts.push('perception was trimmed to fit the model');
        showStatus(`⚠ Incomplete perception: ${parts.join('; ')}. The redesign may be partial.`, 'info');
      }
      void updateSiteStatus();
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
    void updateSiteStatus();
  });
});

// ── Site status (via getSiteInfo — no tabs permission needed) ──
async function updateSiteStatus(): Promise<void> {
  const tabId = await getTabId();
  if (!tabId) return;
  // Stale-run warning: if a run is in-flight (the content script set the flag on
  // run start), warn the user. The flag is cleared on completion; a stale timestamp
  // (>120s) means the run aborted without clearing it (SW killed, tab crashed).
  chrome.storage.local.get(['webmorphRunInFlight'], (res) => {
    const ts = res.webmorphRunInFlight as number | undefined;
    if (ts && Date.now() - ts > 2000) showStatus('⚠ A transform is in progress on this tab…', 'info');
  });
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

// void the floating promise at module load.
void updateSiteStatus();

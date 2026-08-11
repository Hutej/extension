/**
 * entrypoints/popup/main — Revueon popup UI. Sends the goal to the background
 * (the brain) which runs the agent loop. Displays the result.
 */

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const transformBtn = $<HTMLButtonElement>('transformBtn');
const toggleBtn = $<HTMLButtonElement>('toggleBtn');
const removeBtn = $<HTMLButtonElement>('removeBtn');
const intentEl = $<HTMLTextAreaElement>('intent');
const statusEl = $<HTMLDivElement>('statusEl');
const elapsedEl = $<HTMLDivElement>('elapsedEl');
const metricsEl = $<HTMLDivElement>('metricsEl');
const _siteStatus = $<HTMLDivElement>('siteStatus');
const settingsToggle = $<HTMLSpanElement>('settingsToggle');
const settingsArea = $<HTMLDivElement>('settingsArea');
const accountIdEl = $<HTMLInputElement>('accountId');
const apiTokenEl = $<HTMLInputElement>('apiToken');
const saveKeyBtn = $<HTMLButtonElement>('saveKeyBtn');
const credStatusEl = $<HTMLDivElement>('credStatus');
const disclosureEl = $<HTMLDivElement>('disclosure');
const disclosureOkBtn = $<HTMLButtonElement>('disclosureOk');

// Consent gate — disabled for testing. MUST be re-enabled before launch.
const CONSENT_REQUIRED = false;
if (!CONSENT_REQUIRED) console.warn('[Revueon] CONSENT GATE DISABLED — re-enable before launch.');

// ── Cloudflare credentials ─────────────────────────────────────────

void browser.storage.local.get(['cloudflare_account_id', 'cloudflare_api_token', 'revueonConsentShown']).then((res: Record<string, unknown>) => {
  if (res.cloudflare_account_id) accountIdEl.value = res.cloudflare_account_id as string;
  if (res.cloudflare_api_token) apiTokenEl.value = res.cloudflare_api_token as string;
  if (CONSENT_REQUIRED && !res.revueonConsentShown) disclosureEl.style.display = 'block';
});

settingsToggle.addEventListener('click', () => settingsArea.classList.toggle('open'));

saveKeyBtn.addEventListener('click', () => {
  void browser.storage.local.set({
    cloudflare_account_id: accountIdEl.value.trim(),
    cloudflare_api_token: apiTokenEl.value.trim(),
  }).then(() => {
    credStatusEl.textContent = 'Saved.';
    setTimeout(() => { credStatusEl.textContent = ''; }, 2000);
  });
});

disclosureOkBtn?.addEventListener('click', () => {
  void browser.storage.local.set({ revueonConsentShown: true });
  disclosureEl.style.display = 'none';
});

// ── helpers ────────────────────────────────────────────────────────

async function getTabId(): Promise<number | null> {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id ?? null;
}

function showStatus(msg: string, kind: 'ok' | 'err' | 'info'): void {
  statusEl.textContent = msg;
  statusEl.className = `status show ${kind}`;
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ── Transform — send goal to background, run the loop ───────────────

let elapsedTimer: ReturnType<typeof setInterval> | null = null;

transformBtn.addEventListener('click', async () => {
  const goal = intentEl.value.trim();
  if (!goal) { showStatus('Enter a request first.', 'err'); return; }
  const tabId = await getTabId();
  if (!tabId) { showStatus('Cannot find the active tab.', 'err'); return; }

  const consent = await browser.storage.local.get(['revueonConsentShown']);
  if (CONSENT_REQUIRED && !consent.revueonConsentShown) {
    disclosureEl.style.display = 'block';
    showStatus('Please review and acknowledge the disclosure below first.', 'info');
    return;
  }

  showStatus('<span class="spinner"></span>Running…', 'info');
  metricsEl.className = 'metrics';
  elapsedEl.className = 'elapsed show';
  transformBtn.disabled = true;
  const t0 = Date.now();
  elapsedTimer = setInterval(() => {
    elapsedEl.textContent = `Elapsed: ${fmtMs(Date.now() - t0)}…`;
  }, 500);

  // Send to the background (the brain), not the content script.
  chrome.runtime.sendMessage({ action: 'runLoop', goal, tabId }, (res) => {
    if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
    elapsedEl.className = 'elapsed';
    transformBtn.disabled = false;

    if (chrome.runtime.lastError || !res) {
      showStatus('Cannot reach the background. Reload the extension.', 'err');
      return;
    }

    // Hidden JSON for the test harness.
    $('revueon-result').textContent = JSON.stringify(res);

    if (res.ok) {
      const tools = (res.toolsCalled ?? []).join(' → ');
      showStatus(`✓ ${res.summary || 'Done.'}${tools ? '\nTools: ' + tools : ''}`, 'ok');
      metricsEl.innerHTML = [
        `<span>⏱ ${fmtMs(res.wallMs ?? 0)}</span>`,
        `<span>🔄 ${res.steps ?? 0} steps</span>`,
        `<span>💰 ${res.paidCalls ?? 0} model calls</span>`,
      ].join('');
      metricsEl.className = 'metrics show';
      toggleBtn.disabled = false;
      removeBtn.disabled = false;
    } else {
      const msg = res.reason || res.error || 'Task failed.';
      showStatus(`✗ ${msg}`, 'err');
      if (res.status === 'gaveUp') {
        metricsEl.innerHTML = [
          `<span>⏱ ${fmtMs(res.wallMs ?? 0)}</span>`,
          `<span>🔄 ${res.steps ?? 0} steps</span>`,
          `<span>💰 ${res.paidCalls ?? 0} model calls</span>`,
        ].join('');
        metricsEl.className = 'metrics show';
      }
    }
  });
});

// ── Toggle on/off — send to content script ──────────────────────────

toggleBtn.addEventListener('click', async () => {
  const tabId = await getTabId();
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, { action: 'toggle' }, (res) => {
    if (chrome.runtime.lastError || !res) { showStatus('Cannot reach the page.', 'err'); return; }
    showStatus(res.on ? 'Modifications ON.' : 'Modifications OFF.', res.on ? 'ok' : 'info');
  });
});

// ── Remove all ──────────────────────────────────────────────────────

removeBtn.addEventListener('click', async () => {
  const tabId = await getTabId();
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, { action: 'remove' }, () => {
    showStatus('All modifications removed.', 'info');
    toggleBtn.disabled = true;
    removeBtn.disabled = true;
  });
});

/**
 * entrypoints/popup/main — Revueon popup UI. Sends the goal to the background
 * (the brain) which runs the agent loop. Displays the result.
 */

import { AI_CONFIG } from '@/core/config';

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
const askUserArea = $<HTMLDivElement>('askUserArea');
const askUserQuestion = $<HTMLDivElement>('askUserQuestion');
const askUserOptions = $<HTMLDivElement>('askUserOptions');
const askUserInput = $<HTMLInputElement>('askUserInput');
const askUserSend = $<HTMLButtonElement>('askUserSend');

// Consent gate — required for launch. The background's runLoop handler ALSO
// checks revueonConsentShown (the single entry point), so no caller — popup or
// a direct chrome.runtime.sendMessage — can bypass it. One constant in
// AI_CONFIG so the two enforcement points cannot drift.
const CONSENT_REQUIRED = AI_CONFIG.consentRequired;

// ── Cloudflare credentials ─────────────────────────────────────────

void browser.storage.local.get(['cloudflare_account_id', 'cloudflare_api_token']).then((res: Record<string, unknown>) => {
  if (res.cloudflare_account_id) accountIdEl.value = res.cloudflare_account_id as string;
  if (res.cloudflare_api_token) apiTokenEl.value = res.cloudflare_api_token as string;
});

// Consent without a button (product decision): opening the popup after
// reading the disclosure IS the acknowledgement. The gate itself stays
// enforced in the background — this only removes the click friction.
if (CONSENT_REQUIRED) {
  void browser.storage.local.set({ revueonConsentShown: true });
}

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

// ── askUser — the agent asks, the popup answers ─────────────────────

function sendAnswer(requestId: number, answer: string): void {
  chrome.runtime.sendMessage({ action: 'askUserAnswer', requestId, answer });
  askUserArea.style.display = 'none';
  askUserInput.value = '';
  showStatus('<span class="spinner"></span>Working with your answer…', 'info');
}

// ── revueonReply — the model's own first words to the user ──────────
// The genuine acknowledgment: the model's first-turn reasoning, forwarded by
// the background the moment the first model response parses.

chrome.runtime.onMessage.addListener((message: any) => {
  if (message?.action === 'revueonReply') {
    const text = String(message.text ?? '');
    if (text) showStatus(`Revueon: ${text}`, 'info');
    return;
  }
  if (message?.action !== 'askUserPrompt') return;
  const { requestId, question, options } = message;
  askUserQuestion.textContent = `❓ ${question}`;
  askUserOptions.innerHTML = '';
  for (const opt of (Array.isArray(options) ? options : []) as string[]) {
    const b = document.createElement('button');
    b.className = 'btn-sm';
    b.style.width = '100%';
    b.textContent = opt;
    b.addEventListener('click', () => sendAnswer(requestId, opt));
    askUserOptions.appendChild(b);
  }
  askUserArea.style.display = 'block';
  askUserSend.onclick = () => {
    const own = askUserInput.value.trim();
    if (own) sendAnswer(requestId, own);
  };
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
    void browser.storage.local.set({ revueonConsentShown: true });
  }

  // Honest pre-model state (no hardcoded claim of understanding), then the
  // model's OWN first reasoning arrives as the agent's reply via
  // 'revueonReply' — zero extra model calls, genuine words.
  showStatus('<span class="spinner"></span>Thinking…', 'info');
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

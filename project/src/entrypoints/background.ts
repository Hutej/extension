/**
 * entrypoints/background — the brain. Hosts the agent loop and the CSS
 * origin layer. CSS is inserted at the USER origin via chrome.scripting;
 * the content script never touches a style node.
 */

import { runLoop, type LoopResult } from '@/agent/loop';
import { AI_CONFIG } from '@/core/config';
import { loadJournalState, saveJournalState, scopeKey } from '@/core/persist';
import { installBroker } from '../background/broker.ts';

/** Phase 6 consent gate — same constant the popup enforces, one source. */
const CONSENT_REQUIRED = AI_CONFIG.consentRequired;

export default defineBackground(() => {
  // MV3 keepalive — the loop's tool dispatchs keep this SW alive.
  chrome.runtime.onConnect.addListener(() => {});

  // S2.1: the v2 document broker — synchronous listener + hydration barrier,
  // document registry with route-epoch fencing, one run owner per document.
  // It owns only envelope-shaped v2 messages (protocolVersion=1); the legacy
  // `action` dispatcher below is untouched until the plan/19 cutover.
  installBroker();

  // ── askUser: pending question→answer promises ─────────────────────
  // The loop's askUser callback broadcasts a question to the extension's
  // UI pages (the popup). The popup answers (an option or free text);
  // the answer resolves the pending promise. 120s timeout → the model
  // is told the user did not answer and proceeds with its best judgment.
  const askUserPending = new Map<number, (answer: string) => void>();
  let askUserSeq = 0;

  const askUserViaPopup = (question: string, options: string[]): Promise<string> =>
    new Promise((resolve) => {
      const requestId = ++askUserSeq;
      let settled = false;
      const finish = (answer: string) => {
        if (settled) return;
        settled = true;
        askUserPending.delete(requestId);
        resolve(answer);
      };
      askUserPending.set(requestId, finish);
      chrome.runtime.sendMessage({ action: 'askUserPrompt', requestId, question, options }, () => {
        // No receiver (popup closed) — the user cannot answer.
        void chrome.runtime.lastError;
      });
      setTimeout(() => finish('(no answer — the user did not respond in time; proceed with your best judgment, or giveUp if the request cannot be safely interpreted)'), 120_000);
    });

  // ── A: CSS origin layer — insertCSS / removeCSS at USER origin ────
  // The content script sends CSS; we insert it at the user origin.
  // chrome.scripting cannot be called from a content script.

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Insert CSS at USER origin.
    if (message.action === 'insertCSS') {
      const tabId = sender.tab?.id;
      if (tabId == null) { sendResponse({ ok: false, error: 'no tab id' }); return; }
      chrome.scripting.insertCSS(
        { target: { tabId }, css: message.css, origin: 'USER' },
        () => {
          // F4: track inserted CSS per tab so reinsertSavedCss's strict-scope
          // leak-fix can remove it when the scope changes (a /page1 hide must
          // not stay on /page2). Session-persisted so a SW restart keeps it.
          if (!chrome.runtime.lastError) {
            const s = insertedCssByTab.get(tabId) ?? new Set<string>();
            s.add(message.css as string); insertedCssByTab.set(tabId, s);
            void persistTabTracker();
          }
          sendResponse({ ok: !chrome.runtime.lastError, error: chrome.runtime.lastError?.message });
        },
      );
      return true;
    }

    // Remove CSS at USER origin (exact string match).
    if (message.action === 'removeCSS') {
      const tabId = sender.tab?.id;
      if (tabId == null) { sendResponse({ ok: false, error: 'no tab id' }); return; }
      chrome.scripting.removeCSS(
        { target: { tabId }, css: message.css, origin: 'USER' },
        () => {
          if (!chrome.runtime.lastError) {
            const s = insertedCssByTab.get(tabId); if (s) { s.delete(message.css as string); void persistTabTracker(); }
          }
          sendResponse({ ok: !chrome.runtime.lastError, error: chrome.runtime.lastError?.message });
        },
      );
      return true;
    }

    // Cascade introspection: inspect(cascade) needs the exact USER-origin CSS
    // strings this tab currently carries. USER sheets are invisible to
    // document.styleSheets — this tracker is the only place they exist, so
    // inspect can attribute a winning declaration to Revueon instead of
    // reporting "unknown" for every rule we inserted.
    if (message.action === 'getInsertedCss') {
      const tabId = sender.tab?.id;
      if (tabId == null) { sendResponse({ ok: false, error: 'no tab id' }); return; }
      sendResponse({ ok: true, css: [...(insertedCssByTab.get(tabId) ?? [])] });
      return;
    }

    // Toggle CSS off/on — called by the content script's toggle handler.
    if (message.action === 'toggleCss') {
      void handleToggleCss(sender.tab?.id, message.on, sendResponse);
      return true;
    }

    // Run the agent loop.
    if (message.action === 'runLoop') {
      const tabId = message.tabId as number;
      const goal = message.goal as string;

      chrome.storage.local.get(['cloudflare_account_id', 'cloudflare_api_token', 'revueonConsentShown', 'revueon_model_override', 'revueon_reasoning_effort', 'revueon_max_tokens'], async (result) => {
        const accountId = result.cloudflare_account_id as string | undefined;
        const apiToken = result.cloudflare_api_token as string | undefined;
        // Consent gate (Phase 6 launch requirement). Checked FIRST — the single
        // entry point every run goes through, so no caller (popup or a direct
        // runtime.sendMessage) can bypass it. Before credentials: an unconsented
        // caller should not even learn whether credentials are set. Rule 13:
        // name the recovery action.
        if (CONSENT_REQUIRED && !result.revueonConsentShown) {
          sendResponse({ ok: false, error: 'Consent not acknowledged. Review the disclosure in the Revueon popup first, then run again.' });
          return;
        }
        if (!accountId || !apiToken) {
          sendResponse({ ok: false, error: 'No Cloudflare credentials set. Set them in Revueon settings.' });
          return;
        }

        try {
          // R0 benchmark overrides — empty in production → AI_CONFIG defaults.
          const effort = result.revueon_reasoning_effort as 'low' | 'medium' | 'high' | undefined;
          // Work overlay: tell the page the agent has started (the content
          // script shows the translucent layer + blocks clicks), forward each
          // step, and always remove the layer when the run ends.
          const notifyTab = (msg: unknown): void => {
            chrome.tabs.sendMessage(tabId, msg, () => void chrome.runtime.lastError);
          };
          notifyTab({ action: 'revueonWorkStart', goal });
          const loopResult: LoopResult = await runLoop(goal, tabId, {
            accountId,
            apiToken,
            modelOverride: (result.revueon_model_override as string | undefined) || undefined,
            reasoningEffort: effort === 'medium' || effort === 'high' ? effort : undefined,
            maxTokens: typeof result.revueon_max_tokens === 'number' ? result.revueon_max_tokens : undefined,
          }, (entry) => {
            // The model's own first reasoning = the agent's reply to the user.
            // Broadcast to the popup (no hardcoded acknowledgment anywhere).
            if (entry?.kind === 'reply' && entry?.reasoning) {
              chrome.runtime.sendMessage({ action: 'revueonReply', text: String(entry.reasoning).slice(0, 400) }, () => void chrome.runtime.lastError);
            }
            notifyTab({ action: 'revueonWorkStep', entry: { tool: entry?.tool, kind: entry?.kind, reasoning: entry?.kind === 'reply' ? String(entry?.reasoning ?? '').slice(0, 120) : undefined } });
          }, askUserViaPopup);
          notifyTab({ action: 'revueonWorkEnd' });
          sendResponse({
            ok: loopResult.status !== 'error',
            status: loopResult.status,
            summary: loopResult.summary,
            reason: loopResult.reason,
            paidCalls: loopResult.paidCalls,
            wallMs: loopResult.wallMs,
            steps: loopResult.budget.stepsUsed,
            toolsCalled: loopResult.journal.entries.map((e) => e.tool),
            journal: loopResult.journal.entries,
            parseFailures: loopResult.parseFailures ?? [],
          });
        } catch (err) {
          chrome.tabs.sendMessage(tabId, { action: 'revueonWorkEnd' }, () => void chrome.runtime.lastError);
          sendResponse({ ok: false, error: (err as Error).message });
        }
      });
      return true; // async response
    }

    // askUser answer from the popup — resolves the pending loop question.
    if (message.action === 'askUserAnswer') {
      const finish = askUserPending.get(message.requestId as number);
      if (finish) finish(String(message.answer ?? ''));
      sendResponse({ ok: !!finish });
      return;
    }

    return false;
  });

  // ── D/F4: Continuity — re-insert saved CSS on navigation ──────────
  // webNavigation.onCommitted fires for FULL navigations (link/reload/typed)
  // BEFORE first paint → CSS re-applied before paint (no FOUC). It does NOT
  // fire for history.pushState/replaceState — those fire onHistoryStateUpdated.
  // F4 Step4: add onHistoryStateUpdated so a CSS hide survives an SPA
  // pushState route change (the "hide stops working when you click a link"
  // gap). Both are keyed by scopeKey(details.url) — origin + pathname — so a
  // hide on /page1 is re-inserted on return to /page1 but NOT on /page2.
  chrome.webNavigation?.onCommitted.addListener((details) => {
    if (details.frameId !== 0) return; // main frame only
    void reinsertSavedCss(details.tabId, details.url);
  });

  // F4 Step4: SPA pushState/replaceState CSS replay. onHistoryStateUpdated
  // fires for same-document navigations (pushState/replaceState) the content
  // script's history-patch does NOT reach the background for. This is the
  // single highest-leverage F4 fix. frameId==0 = top frame only.
  chrome.webNavigation?.onHistoryStateUpdated.addListener((details) => {
    if (details.frameId !== 0) return; // main frame only
    void reinsertSavedCss(details.tabId, details.url);
  });

  // F4: drop the per-tab tracker when a tab closes (bounded growth + the
  // session-storage copy drops the dead tabId).
  chrome.tabs?.onRemoved.addListener((tabId) => {
    if (insertedCssByTab.delete(tabId)) void persistTabTracker();
  });
});

/** D/F4: Re-insert saved CSS from the journal for this SCOPE (origin + path).
 *  Called before first paint on full navigation (onCommitted) and on SPA
 *  pushState/replaceState (onHistoryStateUpdated). Keyed by scopeKey(url) —
 *  origin + pathname, never query/fragment. A CSS hide on /wiki/CSS does NOT
 *  re-insert on /wiki/HTML (different scope); it returns on /wiki/CSS.
 *
 *  F4 strict-scope enforcement (the leak the spa-route test caught): USER-origin
 *  CSS inserted via chrome.scripting persists on the TAB across pushState — it
 *  does NOT auto-remove when the URL changes. So a hide on /page1 would leak onto
 *  /page2 unless we explicitly REMOVE it. On each reinsert we remove every CSS
 *  string the background previously inserted for this tab that is NOT in the new
 *  scope's set, then insert the new scope's set. (Inserting an already-present
 *  USER-origin sheet is a deduped no-op in Chrome, so re-inserting the same scope
 *  on reload is harmless.) Tracked per-tab so a tab's CSS never leaks to another.
 *
 *  MV3 durability: the tracker survives a service-worker restart by living in
 *  chrome.storage.session (in-memory, cleared on browser close — appropriate for
 *  per-tab live CSS state). An in-memory Map would be wiped on SW restart, and
 *  the leak-fix would stop removing stale CSS — so the tracker is session-backed. */
const RV_TABS = 'rv_insertedCssByTab'; // storage.session key: { [tabId]: string[] }
const insertedCssByTab = new Map<number, Set<string>>();

/** Rehydrate the per-tab tracker from session storage on SW start. Best-effort. */
async function rehydrateTabTracker(): Promise<void> {
  try {
    const r = await chrome.storage.session.get(RV_TABS);
    const obj = r[RV_TABS] as Record<string, string[]> | undefined;
    if (obj) for (const [id, arr] of Object.entries(obj)) insertedCssByTab.set(Number(id), new Set(arr));
  } catch { /* ignore */ }
}
void rehydrateTabTracker();

async function persistTabTracker(): Promise<void> {
  try {
    const obj: Record<string, string[]> = {};
    for (const [id, set] of insertedCssByTab) obj[String(id)] = [...set];
    await chrome.storage.session.set({ [RV_TABS]: obj });
  } catch { /* ignore */ }
}

async function reinsertSavedCss(tabId: number, url: string): Promise<void> {
  try {
    const key = scopeKey(url);
    if (!key || key === 'null' || key.startsWith('null')) return; // bad url
    const state = await loadJournalState(key);
    // Collect the CSS strings this scope wants active.
    const want = new Set<string>();
    if (state.enabled && state.entries?.length) {
      for (const entry of state.entries) {
        if (entry.kind !== 'act') continue;
        const inv = entry.inverse as any;
        if (inv?.kind === 'removeCss' && inv.css) want.add(inv.css as string);
      }
    }
    // Remove CSS the background previously inserted for this tab that is NOT in
    // the new scope's want-set (the leak source: a /page1 hide staying on /page2).
    const have = insertedCssByTab.get(tabId) ?? new Set<string>();
    for (const css of have) {
      if (!want.has(css)) {
        try { await chrome.scripting.removeCSS({ target: { tabId }, css, origin: 'USER' }); }
        catch { /* ignore — tab may be gone */ }
      }
    }
    // Insert the new scope's CSS.
    for (const css of want) {
      try { await chrome.scripting.insertCSS({ target: { tabId }, css, origin: 'USER' }); }
      catch { /* ignore — tab may be gone */ }
    }
    insertedCssByTab.set(tabId, want);
    void persistTabTracker();
  } catch { /* ignore */ }
}

/** Toggle CSS off/on for a tab. Loads the saved journal and
 *  removes/re-inserts all CSS entries. */
async function handleToggleCss(tabId: number | undefined, on: boolean, sendResponse: (r: any) => void): Promise<void> {
  if (tabId == null) { sendResponse({ ok: false, error: 'no tab id' }); return; }
  try {
    const tab = await chrome.tabs.get(tabId);
    const key = scopeKey(tab.url || '');
    if (!key || key.startsWith('null')) { sendResponse({ ok: false, error: 'no origin' }); return; }
    const state = await loadJournalState(key);
    if (!state.entries?.length) { sendResponse({ ok: true, on }); return; }

    const cssEntries = state.entries.filter((e) =>
      e.kind === 'act' && (e.inverse as any)?.kind === 'removeCss' && (e.inverse as any)?.css,
    );

    for (const entry of cssEntries) {
      const css = (entry.inverse as any).css as string;
      try {
        if (on) {
          await chrome.scripting.insertCSS({ target: { tabId }, css, origin: 'USER' });
        } else {
          await chrome.scripting.removeCSS({ target: { tabId }, css, origin: 'USER' });
        }
      } catch { /* ignore individual failures */ }
    }

    // F4: keep the per-tab inserted-CSS tracker in sync so reinsertSavedCss's
    // leak-fix knows what is currently on the tab (toggle off clears it). Session-
    // persisted so a SW restart keeps it.
    insertedCssByTab.set(tabId, on ? new Set(cssEntries.map((e) => (e.inverse as any).css as string)) : new Set<string>());
    void persistTabTracker();

    // Persist the enabled flag.
    state.enabled = on;
    await saveJournalState(key, state);
    sendResponse({ ok: true, on });
  } catch (err) {
    sendResponse({ ok: false, error: (err as Error).message });
  }
}

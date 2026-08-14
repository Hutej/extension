/**
 * entrypoints/content — the hands. A thin dispatcher.
 *
 * A: CSS is never inserted from the content script. It sends a message;
 * the background worker inserts at the USER origin. No style node.
 *
 * Receives tool calls from the background (the brain), executes them against
 * the live DOM, returns results. Never implements pipeline logic.
 */

import { getTool } from '@/tools/index';
import { loadJournalState, originKey, saveJournalState } from '@/core/persist';
import { undoAllStructural, undoLastStructural, resetTxnLog, txnSize } from '@/core/ops/recorder';
import { resetIdentityStore } from '@/core/identity-store';

export default defineContentScript({
  matches: ['<all_urls>'],
  main() {
    // Re-apply persisted DOM mutations on page load.
    // CSS is re-inserted by the background's webNavigation handler.
    void reapplyPersistedDom();

    // F4: detect SPA route change and re-verify targets.
    let lastPath = window.location.pathname;
    const checkRouteChange = () => {
      if (window.location.pathname !== lastPath) {
        lastPath = window.location.pathname;
        void reapplyPersistedDom();
      }
    };
    window.addEventListener('popstate', () => setTimeout(checkRouteChange, 500));
    const origPush = history.pushState;
    const origReplace = history.replaceState;
    history.pushState = function (data: any, unused: string, url?: string | URL | null) {
      origPush.call(history, data, unused, url); setTimeout(checkRouteChange, 500);
    };
    history.replaceState = function (data: any, unused: string, url?: string | URL | null) {
      origReplace.call(history, data, unused, url); setTimeout(checkRouteChange, 500);
    };

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      // Tool call from the background loop.
      if (message.action === 'toolCall') {
        const tool = getTool(message.tool);
        if (!tool) { sendResponse({ ok: false, error: `unknown tool: ${message.tool}` }); return; }
        void tool.execute(message.args).then((result) => sendResponse(result));
        return true; // async response
      }

      // Toggle on/off — background handles CSS; content script handles DOM.
      if (message.action === 'toggle') {
        void toggleModifications().then((on) => sendResponse({ ok: true, on }));
        return true;
      }

      // Remove all modifications.
      if (message.action === 'remove') {
        void removeAllModifications().then(() => sendResponse({ ok: true }));
        return true;
      }

      // F3: undoAll — the failure-path / toggle-off structural rollback. Replays
      // the content-script TransactionLog backwards (cloned-node exact undo for
      // setText/insert). CSS rollback is the background's job (removeCss). This
      // is the in-session exact path; the serializable journal inverses are the
      // post-reload fallback only. Idempotent: a repeat call is a safe no-op.
      if (message.action === 'undoAll') {
        const { undone, failed } = undoAllStructural();
        sendResponse({ ok: true, undone, failed, size: txnSize() });
        return;
      }

      // F5: undoLast — the per-step exact undo. Reverses the single most-recent
      // structural op via the cloned-node inverse (NOT innerHTML re-parse). Sent
      // by the loop for the checkLayout auto-undo and the `undo` control tool
      // when the dispatched inverse is a DOM kind (setText/insert). CSS acts
      // (removeCss) never reach here — the background undoes CSS directly.
      // Idempotent (marks the entry consumed); a repeat call undoes the next.
      if (message.action === 'undoLast') {
        const { undone, failed, reason } = undoLastStructural();
        // F1: surface the stale/wrong-target reason so the loop/model can recover
        // (rule 13) — was a silent {undone:0, failed:1} before.
        sendResponse({ ok: true, undone, failed, reason, size: txnSize() });
        return;
      }

      // F3: reset the structural log (called on each "on" / re-apply so a fresh
      // cycle re-records clones, and after removeAllModifications). F1: also
      // reset the identity store so a fresh cycle re-registers fingerprints
      // (a refreshed DOM gives a refreshed identity, not a stale one).
      if (message.action === 'resetTxn') {
        resetTxnLog();
        resetIdentityStore();
        sendResponse({ ok: true });
        return;
      }

      return false;
    });
  },
});

// ── on/off toggle ──────────────────────────────────────────────────

let toggleState = true; // on by default after re-apply

async function toggleModifications(): Promise<boolean> {
  toggleState = !toggleState;
  if (toggleState) {
    // Turn on — background re-inserts CSS, content script re-applies DOM.
    // reset the structural log first so a fresh cycle re-records clones
    // (the re-applied act tools record into the TransactionLog on execute).
    // F1: reset the identity store too — re-apply re-perceives, so the next
    // describePage re-registers fresh fingerprints against the refreshed DOM.
    resetTxnLog();
    resetIdentityStore();
    await sendToggleCss(true);
    await reapplyPersistedDom();
  } else {
    // Turn off — background removes CSS, content script undoes DOM.
    // F3: use the in-session TransactionLog (cloned-node exact undo), not the
    // storage-based undoPersistedDom. If the log is empty (e.g. a page that
    // never ran an act tool this session), undoAllStructural is a no-op and
    // we fall back to the serializable path for DOM mutations persisted from
    // a prior load that were never re-applied.
    await sendToggleCss(false);
    const { undone } = undoAllStructural();
    if (undone === 0) {
      await undoPersistedDom();
    }
  }
  return toggleState;
}

async function removeAllModifications(): Promise<void> {
  await sendToggleCss(false);
  // F3: undo the in-session structural mutations (cloned-node exact), THEN drop
  // the log + wipe storage. Previously this only wiped storage + dropped CSS,
  // leaving inserted elements and setText mutations on the page until reload.
  undoAllStructural();
  resetTxnLog();
  try {
    const key = originKey();
    await saveJournalState(key, { enabled: false, origin: '', goal: '', entries: [], createdAt: Date.now() });
  } catch { /* ignore */ }
  toggleState = false;
}

/** Ask the background to toggle CSS on/off for this tab. */
function sendToggleCss(on: boolean): Promise<void> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'toggleCss', on }, () => resolve());
  });
}

// ── re-apply persisted DOM mutations ───────────────────────────────
// CSS is handled by the background's webNavigation handler. Here we only
// re-apply DOM mutations (insert, setText) — entries whose inverse is
// restoreHtml or restoreText.

async function reapplyPersistedDom(): Promise<void> {
  try {
    const key = originKey();
    const state = await loadJournalState(key);
    if (!state.enabled || !state.entries?.length) return;

    // A: no style node to remove — CSS is at user origin.
    // Remove old inserted elements to avoid duplication on SPA navigation.
    document.querySelectorAll('[data-revueon-inserted]').forEach((el) => el.remove());

    // Re-apply DOM mutation entries only (insert, setText).
    // CSS entries (applyCss, hide, heal) are handled by the background.
    const missing: string[] = [];
    for (const entry of state.entries) {
      if (entry.kind !== 'act') continue;
      const inv = entry.inverse as any;
      if (inv?.kind === 'removeCss') continue; // CSS — background handles
      const tool = getTool(entry.tool);
      if (tool) await tool.execute(entry.args);
      const sel = (entry.args as any)?.selector as string | undefined;
      if (sel) {
        try { if (document.querySelectorAll(sel).length === 0) missing.push(sel); } catch { /* invalid selector */ }
      }
    }
    if (missing.length > 0) {
      console.warn('[Revueon] F4: targets not found after replay:', missing.join(', '));
    }
  } catch { /* ignore — page may not be ready */ }
}

// ── undo persisted DOM mutations (walk backwards) ───────────────────

async function undoPersistedDom(): Promise<void> {
  try {
    const key = originKey();
    const state = await loadJournalState(key);
    if (!state.entries?.length) return;
    for (let i = state.entries.length - 1; i >= 0; i--) {
      const entry = state.entries[i] as any;
      if (entry.kind !== 'act' || !entry.inverse) continue;
      const inv = entry.inverse as any;
      if (inv.kind === 'restoreText') {
        restoreHtmlLocal(inv.selector, inv.prevHtml, true);
      } else if (inv.kind === 'restoreHtml') {
        restoreHtmlLocal(inv.selector, inv.prevHtml, inv.isInside);
      }
      // removeCss is handled by the background.
    }
  } catch { /* ignore */ }
}

/** Restore an element's (or its parent's) innerHTML — used by undo and toggle off. */
function restoreHtmlLocal(selector: string, prevHtml: string, isInside: boolean): void {
  const el = document.querySelector(selector);
  if (!el) return;
  if (isInside) {
    el.innerHTML = prevHtml;
  } else if (el.parentElement) {
    el.parentElement.innerHTML = prevHtml;
  }
}

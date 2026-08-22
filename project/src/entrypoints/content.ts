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
import { loadJournalState, scopeKey, saveJournalState } from '@/core/persist';
import { digestOfElement } from '@/core/persist/digest.ts';
import { resolveTarget } from '@/core/identity';
import { liveIdentityDom } from '@/core/identity-dom';
import { registerIdentity } from '@/core/identity-store';
import { undoAllStructural, undoLastStructural, resetTxnLog, txnSize } from '@/core/ops/recorder';
import { resetIdentityStore } from '@/core/identity-store';

export default defineContentScript({
  matches: ['<all_urls>'],
  main() {
    // Re-apply persisted DOM mutations on page load.
    // CSS is re-inserted by the background's webNavigation handler.
    void reapplyPersistedDom();

    // F4: detect SPA route change and re-verify targets. A route change is a
    // change in SCOPE (origin + pathname) — a hashchange or a query-only change
    // is NOT a scope change (hash/query are never persisted, approved Q1), so
    // it does NOT trigger re-replay. CSS re-insert on pushState is handled by
    // the background's webNavigation.onHistoryStateUpdated (Step4); here we only
    // re-verify+re-apply DOM acts for the new scope.
    let lastScope = scopeKey();
    const checkRouteChange = () => {
      if (scopeKey() !== lastScope) {
        lastScope = scopeKey();
        void reapplyPersistedDom();
      }
    };
    window.addEventListener('popstate', () => setTimeout(checkRouteChange, 500));
    window.addEventListener('hashchange', () => setTimeout(checkRouteChange, 500));
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
    const key = scopeKey();
    await saveJournalState(key, { enabled: false, origin: '', path: '', goal: '', entries: [], createdAt: Date.now() });
  } catch { /* ignore */ }
  toggleState = false;
}

/** Ask the background to toggle CSS on/off for this tab. */
function sendToggleCss(on: boolean): Promise<void> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'toggleCss', on }, () => resolve());
  });
}

// ── F4: re-apply persisted DOM mutations with identity re-verification ───
// CSS is handled by the background's webNavigation handler (onCommitted +
// onHistoryStateUpdated). Here we re-apply DOM mutations (insert, setText)
// AFTER re-verifying each target's identity against the persisted digest.
//
// Replay is the sole re-application path for DOM acts (the loop no longer
// replays — approved Q2). It reuses F1's resolveTarget (the ONE identity
// resolver) for zero/many/twin, then F4's digest compare for wrong-target:
//   persisted act (args + identityDigest)
//     → resolveTarget(selector, null)   [F1: zero/many/twin refusal — unchanged]
//     → digestOfElement(el) == identityDigest?  [F4: wrong-target detection]
//     → registerIdentity(selector, el)  [so the tool's guardTarget sees verified]
//     → already-applied? (setText: text == args.text)  [idempotency, Step5]
//     → tool.execute(args)              [reuses the act tool; records into txnLog]
//
// Outcomes (requirement 5/10): replayed | already-applied | missing-target |
// ambiguous-target | identity-mismatch | failed. Refusals are NEVER swallowed
// — they are surfaced to storage as `replayReport` for the popup (Step7) and
// console.warn. Missing/ambiguous/mismatch/failed are NOT successful replay.
//
// CSS acts (removeCss inverse) are skipped here — the background re-inserts
// them, but a CSS act whose target mismatched on a prior load is also re-
// verified+removed here at document_idle (two-phase CSS replay: background
// inserts before paint to avoid FOUC; content verifies after and removes on
// mismatch). See removeMismatchedCss below.

interface ReplayOutcome { selector: string; status: 'replayed' | 'already-applied' | 'missing-target' | 'ambiguous-target' | 'identity-mismatch' | 'failed'; error?: string }

async function reapplyPersistedDom(): Promise<void> {
  const outcomes: ReplayOutcome[] = [];
  try {
    const key = scopeKey();
    const state = await loadJournalState(key);
    if (!state.enabled || !state.entries?.length) return;

    // A: no style node to remove — CSS is at user origin.
    // Remove old inserted elements to avoid duplication on SPA navigation.
    // (insert is idempotent by this removal — a fresh insert is the replay.)
    document.querySelectorAll('[data-revueon-inserted]').forEach((el) => el.remove());

    // Re-apply DOM mutation entries only (insert, setText). CSS entries are
    // handled by the background; mismatched CSS is cleaned up afterward.
    for (const entry of state.entries) {
      if (entry.kind !== 'act') continue;
      const inv = entry.inverse as any;
      if (inv?.kind === 'removeCss') continue; // CSS — background handles
      const sel = (entry.args as any)?.selector as string | undefined;
      if (!sel) {
        // No selector (shouldn't happen for setText/insert) — replay as-is.
        const tool = getTool(entry.tool);
        if (tool) { const res = await tool.execute(entry.args); if (!res?.ok) outcomes.push({ selector: '?', status: 'failed', error: res?.error }); }
        continue;
      }

      // F1: re-resolve the selector against the LIVE DOM (the ONE resolver,
      // unchanged). expectedFp=null → the 'unverified' branch, which still runs
      // the zero/many/indistinguishable-twin guards. This catches missing and
      // ambiguous targets on replay; twin protection stays in F1.
      const r = resolveTarget(liveIdentityDom, sel, null);
      if (!r.ok || !r.el) {
        outcomes.push({ selector: sel, status: mapResolveReason(r.reason), error: r.error });
        continue;
      }
      const el = r.el;

      // F4: wrong-target detection via the persisted digest. The cleartext
      // fingerprint is computed in memory and immediately SHA-256-hashed; only
      // the hash was persisted. A mismatch = the selector now points to a
      // DIFFERENT element (the page re-rendered) → do NOT replay; report.
      const persistedDigest = entry.identityDigest;
      if (persistedDigest) {
        const liveDigest = await digestOfElement(el, liveIdentityDom);
        if (liveDigest !== persistedDigest) {
          outcomes.push({ selector: sel, status: 'identity-mismatch', error: `target at "${sel}" changed since the modification was made (re-render?) — not replayed` });
          continue;
        }
      }
      // (No persistedDigest: a legacy/observe-time-unresolved act. The F1
      // resolve above still caught zero/many/twin; wrong-target is not checked.
      // Flagged unverified via the identity store below so a later act knows.)

      // Pre-register the verified identity so the tool's own guardTarget
      // (which calls getIdentity(selector)) sees a matching fingerprint instead
      // of taking the unverified branch — replay is then VERIFIED, not flagged.
      registerIdentity(sel, el, liveIdentityDom);

      // F4 idempotency (Step5): for setText, if the element already holds the
      // desired text, do NOT re-mutate (reload→replay→reload would re-mutate /
      // double-record otherwise). Only treat as already-applied when the
      // identity check above also passed (not a text-equality identity substitute).
      if (entry.tool === 'setText') {
        const desired = (entry.args as any)?.text as string | undefined;
        if (desired != null && (el.textContent ?? '') === desired) {
          // Re-execute to repopulate the session txnLog (so undoAll works after
          // reload) — the page is unchanged because the text already matches.
          // Report already-applied only if the re-execute SUCCEEDED (a failed
          // re-execute reports failed, not both — adversarial review fix).
          const tool = getTool(entry.tool);
          if (tool) {
            const res = await tool.execute(entry.args);
            outcomes.push({ selector: sel, status: res?.ok ? 'already-applied' : 'failed', error: res?.ok ? undefined : res?.error });
          } else {
            outcomes.push({ selector: sel, status: 'already-applied' });
          }
          continue;
        }
      }

      // Replay the act tool. It re-records into the live txnLog (cloned-node
      // inverse) so in-session undo works post-reload. No new persisted journal
      // entry is written (replay reads persisted state, does not append to it).
      const tool = getTool(entry.tool);
      if (tool) {
        const res = await tool.execute(entry.args);
        if (!res?.ok) outcomes.push({ selector: sel, status: 'failed', error: res?.error });
        else outcomes.push({ selector: sel, status: 'replayed' });
      } else {
        outcomes.push({ selector: sel, status: 'failed', error: `unknown tool: ${entry.tool}` });
      }
    }

    // CSS two-phase: the background inserted persisted CSS before paint. Now
    // (document_idle) verify each persisted CSS act's target and remove CSS
    // whose target mismatched (the page re-rendered → the hide would be on the
    // wrong element). This is the identity-mismatch path for CSS acts.
    await removeMismatchedCss(state, outcomes);

    // F4 requirement 5/10: surface outcomes, never silently skip.
    reportReplayOutcomes(outcomes);
  } catch (e) {
    // A failure to load/parse persisted state is reported, not swallowed.
    console.warn('[Revueon] F4: replay error:', (e as Error).message);
    try {
      await chrome.storage.local.set({ revueonReplayReport: [{ selector: '?', status: 'failed', error: (e as Error).message }] });
    } catch { /* ignore */ }
  }
}

/** Map F1 resolveTarget refusal reasons to F4 replay outcomes. */
function mapResolveReason(reason: string | undefined): ReplayOutcome['status'] {
  if (reason === 'zero') return 'missing-target';
  if (reason === 'ambiguous' || reason === 'indistinguishable-twin') return 'ambiguous-target';
  // wrong-target is unreachable here (expectedFp=null → unverified, never wrong-
  // target); F4's digest compare handles wrong-target above. Default to failed.
  return 'failed';
}

/** F4 two-phase CSS replay: at document_idle, verify each persisted CSS act's
 *  target against its digest; if the target changed (re-render), remove the CSS
 *  the background inserted before paint so a wrong element is not hidden.
 *  Uses F1's resolveTarget (the SOLE resolver) — NOT document.querySelector —
 *  so a CSS selector matching many/twins is caught, not silently applied to the
 *  first match. F4 invariant #1: no second resolver. */
async function removeMismatchedCss(state: { entries: any[] }, outcomes: ReplayOutcome[]): Promise<void> {
  for (const entry of state.entries) {
    if (entry.kind !== 'act') continue;
    const inv = entry.inverse as any;
    if (inv?.kind !== 'removeCss' || !inv.css) continue;
    const sel = primarySelectorOf(inv.css) ?? (entry.args as any)?.selector;
    const digest = entry.identityDigest;
    if (!sel || !digest) continue;
    // F1: re-resolve via resolveTarget (zero/many/twin guarded), expectedFp=null.
    const r = resolveTarget(liveIdentityDom, sel, null);
    if (!r.ok || !r.el) { outcomes.push({ selector: sel, status: mapResolveReason(r.reason), error: `CSS target ${r.error ?? sel} — CSS left in place; remove via toggle off if stale` }); continue; }
    const liveDigest = await digestOfElement(r.el, liveIdentityDom);
    if (liveDigest !== digest) {
      // Wrong element — remove the CSS the background inserted before paint.
      try {
        await new Promise<void>((resolve) =>
          chrome.runtime.sendMessage({ action: 'removeCSS', css: inv.css }, () => resolve()));
      } catch { /* ignore */ }
      outcomes.push({ selector: sel, status: 'identity-mismatch', error: `CSS target "${sel}" changed since the hide — CSS removed to avoid hiding the wrong element` });
    }
  }
}

/** Pull the first selector out of a CSS string for the mismatch check. Best
 *  effort — the primary target is also in entry.args.selector for hide/heal. */
function primarySelectorOf(css: string): string | null {
  const m = css.match(/^([^{]+)\{/);
  return m ? m[1].trim().split(',')[0].trim() : null;
}

/** F4 Step7: surface replay outcomes to storage (popup reads revueonReplayReport
 *  on open) + console.warn. Never silent. */
function reportReplayOutcomes(outcomes: ReplayOutcome[]): void {
  if (!outcomes.length) return;
  const refusals = outcomes.filter((o) => o.status !== 'replayed' && o.status !== 'already-applied');
  if (refusals.length) {
    console.warn('[Revueon] F4: replay outcomes:', outcomes.map((o) => `${o.selector}:${o.status}`).join(', '));
  }
  // Persist the report transiently for the popup. Capped to the last 50 outcomes
  // so storage does not grow unbounded across reloads.
  try {
    void chrome.storage.local.set({ revueonReplayReport: outcomes.slice(-50) });
  } catch { /* ignore */ }
}

// ── undo persisted DOM mutations (walk backwards) ───────────────────

async function undoPersistedDom(): Promise<void> {
  try {
    const key = scopeKey();
    const state = await loadJournalState(key);
    if (!state.entries?.length) return;
    for (let i = state.entries.length - 1; i >= 0; i--) {
      const entry = state.entries[i] as any;
      if (entry.kind !== 'act' || !entry.inverse) continue;
      const inv = entry.inverse as any;
      // F4 PRIVACY (user decision 19 Aug 2026): persisted DOM inverses no longer
      // carry `prevHtml` (cleartext innerHTML). The post-reload DOM-undo fallback
      // (innerHTML re-parse) is removed — it was a documented degradation below
      // the in-session cloned-node TransactionLog, which is the authoritative
      // undo path. So post-reload DOM undo is a NO-OP for setText/insert; only
      // removeCss (handled by the background) undoes. Accepted: a post-reload
      // undoAll clears storage + removes CSS; the DOM falls back to reload state.
      if (inv.kind === 'restoreText' || inv.kind === 'restoreHtml') {
        if (!inv.prevHtml) continue; // stripped from persisted state — no-op
        restoreHtmlLocal(inv.selector, inv.prevHtml, inv.kind === 'restoreText' || inv.isInside);
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

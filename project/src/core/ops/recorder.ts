/**
 * core/ops/recorder — the content-script-singleton TransactionLog + liveDom.
 *
 * Tools run in the content script (DOM access). The cloned-node inverses a
 * setText/insert tool captures cannot survive the chrome.tabs.sendMessage
 * crossing to the background — so the TransactionLog lives HERE, in the content
 * script, alongside the DOM. act.ts records structural inverses through
 * `recordStructural`; content.ts calls `txnLog.undoAll(liveDom)` on the
 * `{action:'undoAll'}` message (in-session exact undo) and on toggle-off.
 */

import { TransactionLog, type TxnEntry } from './txn';
import { liveDom } from './liveDom';

/** The one content-script transaction log. Session-only (not persisted). */
export const txnLog = new TransactionLog();

/** Re-exported so content.ts has a single import for the adapter + the log. */
export { liveDom };

/** Record a structural inverse (setText/insert, future remove/move/wrap).
 *  Called by act.ts at the instant the inverse is known — BEFORE the mutation
 *  is committed, so the clone/live-ref reflects the pre-mutation state. */
export function recordStructural(entry: TxnEntry): void {
  txnLog.record(entry);
}

/** Undo every recorded structural op (backwards, per-op try/catch). Used by
 *  content.ts on {action:'undoAll'} and on toggle-off. Idempotent: a repeat
 *  call is a no-op (entries are marked consumed; reset() clears on next on). */
export function undoAllStructural(): { undone: number; failed: number } {
  return txnLog.undoAll(liveDom);
}

/** Undo only the single most-recent structural op (the per-step mirror of
 *  undoAllStructural). Used by content.ts on {action:'undoLast'} — which the
 *  loop sends for the checkLayout auto-undo and the `undo` control tool — so
 *  a DOM act (setText/insert) is reversed by the EXACT cloned-node inverse,
 *  not the lossy innerHTML re-parse of the serializable fallback (Law 7).
 *  Idempotent: marks the entry consumed; a repeat call undoes the next one. */
export function undoLastStructural(): { undone: number; failed: number; reason?: string } {
  return txnLog.undoLast(liveDom);
}

/** Clear the log — called on each "on" (re-apply) so a fresh cycle re-records. */
export function resetTxnLog(): void {
  txnLog.reset();
}

/** Read-only size — useful for tests/diagnostics. */
export function txnSize(): number {
  return txnLog.size;
}

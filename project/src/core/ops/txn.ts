/**
 * core/ops/txn — the reversible structural-mutation log. Session-only.
 *
 * Ported (slimmed) from archive/project/src/core/ops/transaction.ts — the
 * post-RC6-fix version: inverses resolve by HANDLE (survives SPA re-render),
 * each undo is wrapped in try/catch so one failure cannot abandon the rest.
 *
 * Phase 2 (F3 REVERSAL) changes from the archive:
 *  - Added setText/insert inverses holding a CLONED NODE / live ref, because
 *    the live act tools (act.ts) mutate via textContent/insertAdjacentHTML and
 *    the roadmap mandates "store a cloned node" — no inverse may restore via
 *    textContent. The clone lives in the content script (where the DOM is);
 *    it cannot cross the chrome.tabs.sendMessage structured-clone boundary.
 *  - undoAll does NOT call clear() (the archive assumed one undo per session).
 *    on→off→on→off needs to undo twice; reset() is called explicitly on each
 *    re-apply ("on"). undoAll marks entries consumed so a repeat call is a
 *    safe no-op rather than re-undoing already-restored nodes.
 *
 * This file is DOM-agnostic: it goes through an injected DomAdapter so the
 * inverse logic is unit-testable with a fake in-memory tree (tests/ops.test.ts).
 * content.ts supplies the real adapter (core/ops/liveDom.ts).
 */

/** Structural op kinds. remove/move/reorder/wrap are future (guarded by
 *  validateOps in index.ts); setText/insert are the live act tools. */
export type OpKind = 'remove' | 'move' | 'reorder' | 'wrap' | 'setText' | 'insert';

/** The inverse of one op — exactly enough to undo it. Parent/nextSibling are
 *  resolved by HANDLE at undo time, not by stored Node reference (which goes
 *  stale on framework re-render — the old RC6 bug). Removed nodes (reattach)
 *  and inserted wrappers keep the live Node ref — they are not in the DOM at
 *  undo time, so there is no handle to re-resolve. */
export type OpInverse =
  | { kind: 'reattach'; node: Node; parentHandle: string | null; nextSiblingHandle: string | null } // undo remove
  | { kind: 'reparent'; handle: string; parentHandle: string | null; nextSiblingHandle: string | null; prevCss?: string } // undo move/reorder
  | { kind: 'unwrap'; handle: string; wrapper: Node; parentHandle: string | null; nextSiblingHandle: string | null } // undo wrap
  | { kind: 'setText'; clone: Node; selector: string; fingerprint?: string } // undo setText — restore the cloned subtree; F1: verify the current node is still the one we mutated
  | { kind: 'insert'; node: Node }; // undo insert — remove the inserted node

/** One recorded transaction: the op kind + its inverse + the handle it targeted. */
export interface TxnEntry {
  kind: OpKind;
  inverse: OpInverse;
  /** The handle/selector the op targeted (for logging). */
  target: string;
  /** Consumed by an undoAll — a repeat undoAll skips it (idempotent over the
   *  log; supports on→off→on→off without clear()). */
  undone?: boolean;
}

/** The DOM surface executeOps/undoAll use. Injected so the inverse logic is
 *  pure-testable with a fake. The real adapter is core/ops/liveDom.ts. */
export interface DomAdapter {
  /** Resolve a stamped [data-rv-c] handle to a live node (structural ops). */
  resolve(handle: string): HTMLElement | null;
  /** Resolve a CSS selector to a live node (setText/insert target by selector). */
  querySelector(selector: string): HTMLElement | null;
  parent(node: Node): Node | null;
  nextSibling(node: Node): Node | null;
  insertBefore(parent: Node, node: Node, ref: Node | null): void;
  appendChild(parent: Node, node: Node): void;
  removeChild(parent: Node, node: Node): void;
  createElement(tag: string): Node;
  /** Resolve a move destination handle to a live node, or null for 'floating'. */
  resolveDestination(to: string | undefined): HTMLElement | null;
  /** Extract the handle from a live DOM node (the [data-rv-c] attribute). */
  handleOf(node: Node | null): string | null;
  /** F1 IDENTITY: capture the structural fingerprint of a live node, for the
   *  setText undo verify (the RC6-class fix — the undo must confirm the element
   *  is STILL the one we mutated before replaceWith(clone)). */
  fingerprintOf(node: Node): string;
  /** setText/insert undo: replace one node with another (clone restore). */
  replaceWith(node: Node, replacement: Node): void;
}

/** A recorded, ordered list of ops + inverses. Session-only (not persisted). */
export class TransactionLog {
  private entries: TxnEntry[] = [];

  record(entry: TxnEntry): void { this.entries.push(entry); }

  /** Clear the log. Called on each "on" (re-apply) so a fresh cycle re-records. */
  reset(): void { this.entries = []; }

  get size(): number { return this.entries.length; }

  /** The handles targeted by an accepted remove op (for verify's collapse exemption). */
  removedHandles(): Set<string> {
    const s = new Set<string>();
    for (const e of this.entries) if (e.kind === 'remove' && !e.undone) s.add(e.target);
    return s;
  }

  /** The handles targeted by an accepted move/reorder op (verify's moved-alive check). */
  movedHandles(): Set<string> {
    const s = new Set<string>();
    for (const e of this.entries) if ((e.kind === 'move' || e.kind === 'reorder') && !e.undone) s.add(e.target);
    return s;
  }

  /** Snapshot for the ledger (ops executed, by kind). */
  summary(): { executed: number; byKind: Partial<Record<OpKind, number>> } {
    const byKind: Partial<Record<OpKind, number>> = {};
    for (const e of this.entries) if (!e.undone) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
    return { executed: this.entries.filter((e) => !e.undone).length, byKind };
  }

  /** Undo the single most-recent not-yet-undone entry (the per-step mirror of
   *  undoAll). Used by the loop's checkLayout auto-undo and the `undo` control
   *  tool so a DOM act (setText/insert) is reversed by the EXACT cloned-node
   *  inverse — not the lossy innerHTML re-parse the serializable fallback uses
   *  (Law 7: textContent/innerHTML is never a valid in-session inverse; the
   *  clone is available here). Returns {undone, failed, reason?}; idempotent on
   *  SUCCESS (marks the entry undone). On FAILURE it does NOT mark the entry —
   *  a failed undo must remain retryable so the terminal undoAll can still
   *  attempt it (marking it consumed here would make undoAll skip it, leaving
   *  the page mutated while the loop reports a clean rollback).
   *  No-op if the log is empty / all consumed.
   *
   *  Sync invariant: the journal appends act entries in the same order act
   *  tools call recordStructural (record happens inside execute, before the
   *  tool returns; journal.append is after). So the last DOM act in the
   *  journal == the last entry here. The loop only calls this when the
   *  dispatched inverse is a DOM kind, so the entry popped is the right one. */
  undoLast(dom: DomAdapter): { undone: number; failed: number; reason?: string } {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e.undone) continue;
      try {
        applyInverse(e.inverse, dom);
        e.undone = true;
        return { undone: 1, failed: 0 };
      } catch (err) {
        // F1: surface the reason (stale/wrong-target) instead of swallowing it.
        // Do NOT mark `undone` on failure: a failed restore must stay retryable
        // so the terminal undoAll can attempt it (marking it consumed here would
        // make undoAll skip it via `if (e.undone) continue`, leaving the page
        // mutated while the loop reports a clean rollback).
        return { undone: 0, failed: 1, reason: err instanceof Error ? err.message : String(err) };
      }
    }
    return { undone: 0, failed: 0 };
  }

  /** Replay the log BACKWARDS, applying each inverse. Restores the original DOM.
   *  Each undo is wrapped in try/catch so one failure cannot abandon the
   *  remainder. Inverses resolve by handle at undo time, not by stored Node
   *  reference. Marks each entry undone — a repeat undoAll is a safe no-op
   *  (does NOT clear; reset() is called explicitly on the next "on"). */
  undoAll(dom: DomAdapter): { undone: number; failed: number } {
    let undone = 0;
    let failed = 0;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e.undone) continue; // already restored — skip (idempotent)
      try {
        applyInverse(e.inverse, dom);
        e.undone = true;
        undone++;
      } catch {
        // one failed undo must not abandon the remainder.
        failed++;
      }
    }
    return { undone, failed };
  }
}

/** Apply one inverse against the live DOM. Shared by undoLast and undoAll so
 *  the per-step and all-or-nothing paths can never drift. */
function applyInverse(inv: OpInverse, dom: DomAdapter): void {
  if (inv.kind === 'setText') {
    // F1 RC6-class fix: re-resolve + VERIFY before replaceWith(clone). The old
    // undo keyed by a raw selector and blindly replaced whatever it found —
    // if a re-render/reorder made the selector resolve to a DIFFERENT node, the
    // undo would corrupt the wrong element. Verify the current node's structural
    // fingerprint matches the act-time fingerprint; if not found → throw (the
    // undoAll/undoLast caller reports it, not silently skips); if the wrong
    // element → throw (refuse to corrupt it). The clone restore stays exact.
    const current = dom.querySelector(inv.selector);
    if (!current) throw new Error(`setText undo: target ${inv.selector} no longer exists (removed/re-rendered) — cannot restore`);
    if (inv.fingerprint && dom.fingerprintOf(current) !== inv.fingerprint) {
      throw new Error(`setText undo: ${inv.selector} now resolves to a different element than the one mutated — refusing to restore the clone onto the wrong node`);
    }
    dom.replaceWith(current, inv.clone);
  } else if (inv.kind === 'insert') {
    // F1 RC6-class fix: the inserted node is still in the DOM (in-session);
    // remove it. If the page removed/re-rendered it away first, the old code
    // was a SILENT no-op — the undo reported success while doing nothing. Now
    // throw so the caller reports the stale node instead of swallowing it.
    const parent = dom.parent(inv.node);
    if (!parent) throw new Error('insert undo: the inserted node is no longer in the DOM (re-rendered/removed) — nothing to remove');
    dom.removeChild(parent, inv.node);
  } else if (inv.kind === 'unwrap') {
    const node = dom.resolve(inv.handle);
    if (!node) throw new Error(`handle ${inv.handle} not found`);
    const parent = inv.parentHandle ? dom.resolve(inv.parentHandle) : null;
    if (!parent) throw new Error(`parent handle ${inv.parentHandle} not found`);
    dom.insertBefore(parent, node, inv.nextSiblingHandle ? dom.resolve(inv.nextSiblingHandle) : null);
    const wParent = dom.parent(inv.wrapper);
    if (wParent) dom.removeChild(wParent, inv.wrapper);
  } else if (inv.kind === 'reattach') {
    // Removed node: must use the stored Node (it's not in the DOM).
    const parent = inv.parentHandle ? dom.resolve(inv.parentHandle) : null;
    if (!parent) throw new Error(`parent handle ${inv.parentHandle} not found`);
    dom.insertBefore(parent, inv.node, inv.nextSiblingHandle ? dom.resolve(inv.nextSiblingHandle) : null);
  } else {
    // reparent (move/reorder): resolve by handle.
    const node = dom.resolve(inv.handle);
    if (!node) throw new Error(`handle ${inv.handle} not found`);
    const parent = inv.parentHandle ? dom.resolve(inv.parentHandle) : null;
    if (!parent) throw new Error(`parent handle ${inv.parentHandle} not found`);
    dom.insertBefore(parent, node, inv.nextSiblingHandle ? dom.resolve(inv.nextSiblingHandle) : null);
    if (inv.prevCss !== undefined && node instanceof HTMLElement) {
      (node as HTMLElement).style.cssText = inv.prevCss;
    }
  }
}

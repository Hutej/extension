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
  | { kind: 'setText'; clone: Node; selector: string } // undo setText — restore the cloned subtree
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
        const inv = e.inverse;
        if (inv.kind === 'setText') {
          // Restore the cloned subtree: replace the (possibly mutated) node
          // with the clone captured before the textContent mutation.
          const current = dom.querySelector(inv.selector);
          if (!current) throw new Error(`setText target ${inv.selector} not found`);
          dom.replaceWith(current, inv.clone);
        } else if (inv.kind === 'insert') {
          // The inserted node is still in the DOM (in-session); remove it.
          // If the page removed it first, this is a harmless no-op.
          const parent = dom.parent(inv.node);
          if (parent) dom.removeChild(parent, inv.node);
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

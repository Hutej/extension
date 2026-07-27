/**
 * core/ops — reversible DOM operations. The transaction log records each
 * structural mutation (remove/move/reorder/wrap) with its EXACT inverse; the
 * escape hatch replays the log backwards to restore the original DOM. Pure data
 * + replay over an injected DOM adapter so the inverse logic is unit-testable
 * without a live page. content.ts supplies the real adapter; the unit test
 * supplies a fake.
 *
 * Identity model: an op targets a cluster HANDLE (e.g. "c1a2b3"). At apply time
 * the handle is stamped on a live DOM node (`[data-wm-c="c1a2b3"]`); executeOps
 * resolves it, mutates, and records the inverse referencing the live node +
 * its original location — NOT the handle. The handle is signature-based and
 * may change after a move (resolved color shifts across an inheritance
 * boundary); the live node ref is stable for the session. On reload,
 * reapplyStored re-derives ops from the spec against a fresh perception
 * (handle re-resolution) — the log itself is session-only.
 */

import type { DesignOp, OpKind } from '../spec';

/** The inverse of one op — exactly enough to undo it. */
export type OpInverse =
  | { kind: 'reattach'; node: Node; parent: Node; nextSibling: Node | null } // undo remove
  | { kind: 'reparent'; node: Node; parent: Node; nextSibling: Node | null } // undo move/reorder
  | { kind: 'unwrap'; node: Node; wrapper: Node; parent: Node; nextSibling: Node | null }; // undo wrap

/** One recorded transaction: the op + its inverse + the live target. */
export interface TxnEntry {
  op: DesignOp;
  inverse: OpInverse;
  /** The handle the op targeted (for logging/refusal reporting). */
  target: string;
}

/**
 * The DOM surface executeOps/undoAll use. Injected so the inverse logic is
 * pure-testable with a fake. The real adapter (content.ts) hits the live DOM;
 * the unit test's fake is an in-memory tree.
 */
export interface DomAdapter {
  resolve(handle: string): HTMLElement | null;
  parent(node: Node): Node | null;
  nextSibling(node: Node): Node | null;
  insertBefore(parent: Node, node: Node, ref: Node | null): void;
  appendChild(parent: Node, node: Node): void;
  removeChild(parent: Node, node: Node): void;
  createElement(tag: string): Node;
  /** move 'to' a destination handle: resolve to a live node, or null for 'floating'. */
  resolveDestination(to: string | undefined): HTMLElement | null;
}

/** A recorded, ordered list of ops + inverses. Session-only. */
export class TransactionLog {
  private entries: TxnEntry[] = [];

  record(entry: TxnEntry): void { this.entries.push(entry); }
  clear(): void { this.entries = []; }
  get size(): number { return this.entries.length; }
  /** The handles targeted by an accepted remove op (for verify's collapse exemption). */
  removedHandles(): Set<string> {
    const s = new Set<string>();
    for (const e of this.entries) if (e.op.kind === 'remove') s.add(e.target);
    return s;
  }
  /** The handles targeted by an accepted move/reorder op (for verify's moved-alive
   *  check — a moved node must remain present, visible, sized, and keep its role
   *  after relocation; a move that orphaned or hid the node is a silent break). */
  movedHandles(): Set<string> {
    const s = new Set<string>();
    for (const e of this.entries) if (e.op.kind === 'move' || e.op.kind === 'reorder') s.add(e.target);
    return s;
  }
  /** Snapshot for the ledger (ops executed, by kind). */
  summary(): { executed: number; byKind: Record<OpKind, number> } {
    const byKind: Record<OpKind, number> = { remove: 0, move: 0, reorder: 0, wrap: 0 };
    for (const e of this.entries) byKind[e.op.kind]++;
    return { executed: this.entries.length, byKind };
  }

  /** Replay the log BACKWARDS, applying each inverse. Restores the original DOM. */
  undoAll(dom: DomAdapter): void {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      const inv = e.inverse;
      if (inv.kind === 'unwrap') {
        // Move the wrapped node back to its original parent/slot, then drop the wrapper.
        dom.insertBefore(inv.parent, inv.node, inv.nextSibling);
        const wParent = dom.parent(inv.wrapper);
        if (wParent) dom.removeChild(wParent, inv.wrapper);
      } else {
        // reattach (remove) and reparent (move/reorder) both restore node → original parent + slot.
        dom.insertBefore(inv.parent, inv.node, inv.nextSibling);
        // For a 'floating' move, restore the original inline cssText (undo position:fixed).
        const html = inv.node as HTMLElement;
        if (html?.dataset && html.dataset['wmPrevCss'] !== undefined) {
          html.style.cssText = html.dataset['wmPrevCss'];
          delete html.dataset['wmPrevCss'];
        }
      }
    }
    this.clear();
  }
}

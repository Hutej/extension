/**
 * core/ops — reversible DOM operations. The transaction log records each
 * structural mutation (remove/move/reorder/wrap) with its EXACT inverse; the
 * escape hatch replays the log backwards to restore the original DOM. Pure data
 * + replay over an injected DOM adapter so the inverse logic is unit-testable
 * without a live page. content.ts supplies the real adapter; the unit test
 * supplies a fake.
 *
 * inverses resolve by stable HANDLE, not by live Node reference. Stored
 * Node references go stale the instant a framework re-renders, which means undo
 * silently does nothing on exactly the pages where it matters most. The handle
 * is signature-based and re-resolvable at undo time. For removed nodes (no
 * longer in the DOM), the Node reference is kept — there is no alternative.
 */

import type { DesignOp, OpKind } from '../spec';

/** The inverse of one op — exactly enough to undo it. parent + nextSibling
 *  are resolved by handle at undo time, not by stored Node reference. */
export type OpInverse =
  | { kind: 'reattach'; node: Node; parentHandle: string | null; nextSiblingHandle: string | null } // undo remove
  | { kind: 'reparent'; handle: string; parentHandle: string | null; nextSiblingHandle: string | null; prevCss?: string } // undo move/reorder
  | { kind: 'unwrap'; handle: string; wrapper: Node; parentHandle: string | null; nextSiblingHandle: string | null }; // undo wrap

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
  /** extract the handle from a live DOM node (the [data-rv-c] attribute), or null. */
  handleOf(node: Node | null): string | null;
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

  /** Replay the log BACKWARDS, applying each inverse. Restores the original DOM.
   *  each undo is wrapped in try/catch so one failure cannot abandon the
   *  remainder. Inverses resolve by handle at undo time, not by stored Node
   *  reference (which goes stale on framework re-render). Returns the number of
   *  undos that succeeded (for the structural assertion). */
  undoAll(dom: DomAdapter): { undone: number; failed: number } {
    let undone = 0;
    let failed = 0;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      try {
        const inv = e.inverse;
        if (inv.kind === 'unwrap') {
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
          // For a 'floating' move, restore the original inline cssText.
          if (inv.prevCss !== undefined) {
            const html = node as HTMLElement;
            html.style.cssText = inv.prevCss;
          }
        }
        undone++;
      } catch {
        // one failed undo must not abandon the remainder.
        failed++;
      }
    }
    this.clear();
    return { undone, failed };
  }
}

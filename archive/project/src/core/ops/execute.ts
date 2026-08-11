/**
 * core/ops/execute — the live DOM adapter + op execution against the live DOM.
 *
 * The live DOM adapter for the op transaction layer. executeOps + txnLog.undoAll
 * go through this so the inverse logic in transaction.ts is DOM-agnostic.
 *
 * Extracted from content.ts (pure move, no behaviour change). The only change:
 * `txnLog` was a closure variable in content.ts; it is now passed as a parameter
 * to executeOps so the function is self-contained.
 */

import type { DomAdapter, TransactionLog } from './transaction.ts';
import type { ValidatedOp } from './index.ts';

/** The live DOM adapter for the op transaction layer. executeOps + txnLog.undoAll
 *  go through this so the inverse logic in transaction.ts is DOM-agnostic. */
export const liveDom: DomAdapter = {
  resolve(handle) { return document.querySelector<HTMLElement>(`[data-rv-c="${handle}"]`); },
  parent(node) { return node.parentNode; },
  nextSibling(node) { return node.nextSibling; },
  insertBefore(parent, node, ref) { parent.insertBefore(node, ref); },
  appendChild(parent, node) { parent.appendChild(node); },
  removeChild(parent, node) { parent.removeChild(node); },
  createElement(tag) { return document.createElement(tag); },
  resolveDestination(to) { return to ? document.querySelector<HTMLElement>(`[data-rv-c="${to}"]`) : null; },
  // extract the handle from a live DOM node for handle-based inverse resolution.
  handleOf(node) { return node instanceof HTMLElement ? node.getAttribute('data-rv-c') : null; },
};

/** Execute a validated op set against the live DOM. Idempotent: each op checks
 *  the live state and skips if already satisfied (re-derive on reload + dynamic
 *  defense re-exec both call this). Records an exact inverse per op (session
 *  undo). Refused/no-op ops are counted, not recorded. Returns {executed,refused}.
 *  `record` = true on the primary apply (records inverses); false on re-derive
 *  (no log — the log is session-only, the spec re-derives on reload).
 *  `txnLog` is the caller's TransactionLog instance (session-only undo log). */
export function executeOps(ops: ValidatedOp[], record: boolean, txnLog: TransactionLog): { executed: number; refused: number; refusedReasons: string[] } {
  let executed = 0; const refusedReasons: string[] = [];
  for (const op of ops) {
    const el = liveDom.resolve(op.target);
    if (!el) { refusedReasons.push(`${op.kind}(${op.target}:not-found)`); continue; }
    const parent = liveDom.parent(el);
    if (!parent) { refusedReasons.push(`${op.kind}(${op.target}:no-parent)`); continue; }

    if (op.kind === 'remove') {
      const next = liveDom.nextSibling(el);
      liveDom.removeChild(parent, el);
      if (record) txnLog.record({ op: { kind: 'remove', target: op.target }, target: op.target, inverse: { kind: 'reattach', node: el, parentHandle: liveDom.handleOf(parent), nextSiblingHandle: liveDom.handleOf(next) } });
      executed++; continue;
    }

    if (op.kind === 'wrap') {
      // Idempotent: if the cluster is already the sole child of a wrapper we
      // created, skip (re-derive on reload). Detect a wrapper with a data-rv-wrap
      // attr around the cluster.
      const existingWrap = el.parentElement?.getAttribute('data-rv-wrap') === 'true' ? el.parentElement : null;
      if (existingWrap) { executed++; continue; }
      const wrap = liveDom.createElement('div') as HTMLElement;
      wrap.setAttribute('data-rv-wrap', 'true');
      if (op.hint) (wrap as HTMLElement).style.display = op.hint;
      const next = liveDom.nextSibling(el);
      liveDom.insertBefore(parent, wrap, next);
      liveDom.appendChild(wrap, el);
      if (record) txnLog.record({ op: { kind: 'wrap', target: op.target }, target: op.target, inverse: { kind: 'unwrap', handle: op.target, wrapper: wrap, parentHandle: liveDom.handleOf(parent), nextSiblingHandle: liveDom.handleOf(next) } });
      executed++; continue;
    }

    if (op.kind === 'reorder') {
      const parentEl = parent;
      // Idempotent: if `before` is given and the target is already immediately before it, skip.
      if (op.before) {
        const beforeEl = liveDom.resolve(op.before);
        if (beforeEl && liveDom.nextSibling(el) === beforeEl) { executed++; continue; }
        if (beforeEl) {
          const next = liveDom.nextSibling(el);
          liveDom.insertBefore(parentEl, el, beforeEl);
          if (record) txnLog.record({ op: { kind: 'reorder', target: op.target, before: op.before }, target: op.target, inverse: { kind: 'reparent', handle: op.target, parentHandle: liveDom.handleOf(parentEl), nextSiblingHandle: liveDom.handleOf(next) } });
          executed++; continue;
        }
      }
      // No/missing before → move to end. Idempotent if already last.
      if (liveDom.nextSibling(el) === null) { executed++; continue; }
      const next = liveDom.nextSibling(el);
      liveDom.appendChild(parentEl, el);
      if (record) txnLog.record({ op: { kind: 'reorder', target: op.target }, target: op.target, inverse: { kind: 'reparent', handle: op.target, parentHandle: liveDom.handleOf(parentEl), nextSiblingHandle: liveDom.handleOf(next) } });
      executed++; continue;
    }

    if (op.kind === 'move') {
      // 'floating' = position:fixed lever (a mini-player). Idempotent if already fixed.
      if (op.hint === 'floating') {
        if (getComputedStyle(el).position === 'fixed') { executed++; continue; }
        const prevInlines = (el as HTMLElement).style.cssText;
        const next = liveDom.nextSibling(el);
        (el as HTMLElement).style.position = 'fixed';
        if (record) txnLog.record({ op: { kind: 'move', target: op.target, to: 'floating', consent: true }, target: op.target, inverse: { kind: 'reparent', handle: op.target, parentHandle: liveDom.handleOf(parent), nextSiblingHandle: liveDom.handleOf(next), prevCss: prevInlines } });
        executed++; continue;
      }
      const dest = liveDom.resolveDestination(op.to);
      if (!dest) { refusedReasons.push(`move(${op.target}:bad-dest)`); continue; }
      // Idempotent: already a child of the destination.
      if (liveDom.parent(el) === dest) { executed++; continue; }
      const next = liveDom.nextSibling(el);
      liveDom.appendChild(dest, el);
      if (record) txnLog.record({ op: { kind: 'move', target: op.target, to: op.to }, target: op.target, inverse: { kind: 'reparent', handle: op.target, parentHandle: liveDom.handleOf(parent), nextSiblingHandle: liveDom.handleOf(next) } });
      executed++; continue;
    }
  }
  return { executed, refused: refusedReasons.length, refusedReasons };
}
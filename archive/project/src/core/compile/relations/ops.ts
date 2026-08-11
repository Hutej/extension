/**
 * compile/relations/ops — structural op relations: hide, reorderBefore, moveTo.
 *
 * Extracted from transform.ts (pure move, no behaviour change). DESTRUCTIVE_
 * CONFIDENCE_FLOOR is imported from core/ops (same value 0.5 as transform.ts's
 * export) to avoid a circular import back into transform.ts.
 */

import type { RelationHandlerMap, RelOf } from './context.ts';
import { DESTRUCTIVE_CONFIDENCE_FLOOR } from '../../ops/index.ts';

export const opsHandlers: RelationHandlerMap = {
  hide(rel, c, ctx) {
    const { ruleFor, notes } = ctx;
    const r = rel as RelOf<'hide'>;
    if (c.designRoleConfidence < DESTRUCTIVE_CONFIDENCE_FLOOR) {
      notes.push(`hide ${r.subject} (${c.handle}): REFUSED — role ${c.designRole}@${c.designRoleConfidence.toFixed(2)} < ${DESTRUCTIVE_CONFIDENCE_FLOOR} (hard-safety rule)`);
      return;
    }
    // Safety gates (same as the old hideRefusal).
    if (c.role === 'main' || c.role === 'article') { notes.push(`hide ${c.handle}: REFUSED — primary-content`); return; }
    if (c.layout.isPassiveWrapper || c.layout.isOpaqueWrapper) { notes.push(`hide ${c.handle}: REFUSED — wrapper`); return; }
    if (c.rect.h > 300) { notes.push(`hide ${c.handle}: REFUSED — tall-content`); return; }
    ruleFor(c.handle).hide = true;
  },
  reorderBefore(rel, c, ctx) {
    const { resolveReference, deriveMutationReason, byHandle, ops, notes } = ctx;
    const r = rel as RelOf<'reorderBefore'>;
    const refs = resolveReference(r.reference, c);
    if (!refs.length) { notes.push(`reorderBefore ${r.subject}: reference not found`); return; }
    if (c.moveSafety !== 'safe') { notes.push(`reorderBefore ${c.handle}: REFUSED — moveSafety=${c.moveSafety}`); return; }
    // F6: derive a real MutationReason from the actual situation.
    const reason = deriveMutationReason(c, refs[0], byHandle);
    if (!reason) {
      notes.push(`reorderBefore ${c.handle}: REFUSED — no MutationReason applies (CSS can express this without DOM mutation)`);
      return;
    }
    ops.push({ kind: 'reorder', target: c.handle, before: refs[0].handle, reason });
  },
  moveTo(rel, c, ctx) {
    const { resolveReference, deriveMutationReason, byHandle, ops, notes } = ctx;
    const r = rel as RelOf<'moveTo'>;
    const refs = resolveReference(r.reference, c);
    if (!refs.length) { notes.push(`moveTo ${r.subject}: reference not found`); return; }
    if (c.moveSafety === 'forbidden') { notes.push(`moveTo ${c.handle}: REFUSED — forbidden`); return; }
    // F6: derive a real MutationReason from the actual situation.
    const reason = deriveMutationReason(c, refs[0], byHandle);
    if (!reason) {
      notes.push(`moveTo ${c.handle}: REFUSED — no MutationReason applies (CSS can express this without DOM mutation)`);
      return;
    }
    ops.push({ kind: 'move', target: c.handle, to: refs[0].handle, reason });
  },
};
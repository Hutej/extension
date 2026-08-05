/**
 * core/layout/assign — deterministic slot assignment.
 *
 * Assigns each Layout IR node to exactly one slot in a layout language. Invariants
 * enforced by assertions that THROW (a violation is a compiler error, same class
 * as matched-targets = 0):
 *   - every node lands in exactly one slot
 *   - unmatched/unknown -> the language's overflow slot
 *   - sum of slot memberships == node count
 *   - no node appears twice
 *
 * Language-aware: the caller passes the chosen LayoutLanguage. When the model
 * emits no language choice, the caller passes the documentation fallback.
 */

import type { LayoutIRNode } from './ir.ts';
import type { LayoutLanguage } from './languages/types.ts';
import { slotForRole, overflowSlot } from './languages/types.ts';

export interface SlotAssignment {
  /** handle -> slot id */
  handleToSlot: Map<string, string>;
  /** slot id -> handles (in source order) */
  slotToHandles: Map<string, string[]>;
  /** total nodes assigned */
  total: number;
}

/** Assign every node to exactly one slot of the given language. Throws on
 *  invariant violation. The overflow slot id is the language's last slot. */
export function assignSlots(nodes: LayoutIRNode[], lang: LayoutLanguage): SlotAssignment {
  const overflowId = overflowSlot(lang).id;
  const handleToSlot = new Map<string, string>();
  const slotToHandles = new Map<string, string[]>();
  for (const slot of lang.slots) slotToHandles.set(slot.id, []);
  if (!slotToHandles.has(overflowId)) slotToHandles.set(overflowId, []);

  for (const node of nodes) {
    // Excluded nodes still land in a slot (overflow) — they're skipped by the
    // solver, not by the assigner. The assigner's invariant is: every node
    // lands somewhere. Exclusion is a solver concern, not an assignment concern.
    const slot = slotForRole(lang, node.semantic.role) || overflowId;
    // Invariant: no node appears twice.
    if (handleToSlot.has(node.handle)) {
      throw new Error(`assignSlots: node ${node.handle} assigned twice (slot ${slot})`);
    }
    handleToSlot.set(node.handle, slot);
    const arr = slotToHandles.get(slot);
    if (arr) arr.push(node.handle); else slotToHandles.set(slot, [node.handle]);
  }

  // Invariant: sum of slot memberships == node count.
  let total = 0;
  for (const handles of slotToHandles.values()) total += handles.length;
  if (total !== nodes.length) {
    throw new Error(`assignSlots: slot memberships (${total}) != node count (${nodes.length})`);
  }

  return { handleToSlot, slotToHandles, total };
}

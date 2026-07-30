/**
 * core/layout/assign — deterministic slot assignment. Phase 2.5, Step 1.5D (D2).
 *
 * Assigns each Layout IR node to exactly one slot in a layout language. Invariants
 * enforced by assertions that THROW (a violation is a compiler error, same class
 * as matched-targets = 0):
 *   - every node lands in exactly one slot
 *   - unmatched/unknown → overflow
 *   - sum of slot memberships == node count
 *   - no node appears twice
 */

import type { LayoutIRNode } from './ir.ts';
import { DOCUMENTATION_SLOTS, slotForRole, type SlotId } from './languages/documentation.ts';

export interface SlotAssignment {
  /** handle → slot id */
  handleToSlot: Map<string, SlotId>;
  /** slot id → handles (in source order) */
  slotToHandles: Map<SlotId, string[]>;
  /** total nodes assigned */
  total: number;
}

/** Assign every node to exactly one slot. Throws on invariant violation. */
export function assignSlots(nodes: LayoutIRNode[], excluded: Set<string> = new Set()): SlotAssignment {
  const handleToSlot = new Map<string, SlotId>();
  const slotToHandles = new Map<SlotId, string[]>();
  for (const slot of DOCUMENTATION_SLOTS) slotToHandles.set(slot.id, []);

  for (const node of nodes) {
    // Excluded nodes still land in a slot (overflow) — they're skipped by the
    // solver, not by the assigner. The assigner's invariant is: every node
    // lands somewhere. Exclusion is a solver concern, not an assignment concern.
    const slot = slotForRole(node.semantic.role) ?? 'overflow';
    // Invariant: no node appears twice.
    if (handleToSlot.has(node.handle)) {
      throw new Error(`assignSlots: node ${node.handle} assigned twice (slot ${slot})`);
    }
    handleToSlot.set(node.handle, slot);
    slotToHandles.get(slot)!.push(node.handle);
  }

  // Invariant: sum of slot memberships == node count.
  let total = 0;
  for (const handles of slotToHandles.values()) total += handles.length;
  if (total !== nodes.length) {
    throw new Error(`assignSlots: slot memberships (${total}) != node count (${nodes.length})`);
  }

  // Invariant: every node landed in exactly one slot (checked by the double-assignment
  // guard + the sum check; together they guarantee the partition).
  return { handleToSlot, slotToHandles, total };
}

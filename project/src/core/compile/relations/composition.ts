/**
 * compile/relations/composition — composition relation resolver.
 *
 * Resolves model-declared composition relations (archetype, assignSlot,
 * trackAllocation, adjacentTo, spansTracks, readBefore, stackDirection,
 * wrapBehavior, prominentFirst) into the Target Layout IR.
 *
 * No magnitude is a pixel — track allocations are fr ratios, floors are
 * minmax() bounds from pack tokens. Unsatisfiable constraints are
 * reported, never silently dropped.
 *
 * ACCESSIBILITY CONSTRAINT (not Law 0). Ordering is one of the nine IR
 * constraint kinds, and grid placement IS browser-solved ordering. The
 * real constraint on reordering is accessibility: visual order diverging
 * from DOM order breaks screen readers and tab sequence. So:
 *  - Prefer placement (grid-column, which preserves DOM order via
 *    auto-row-placement) over CSS `order` (which breaks it). The solver
 *    never emits `order` — grid-column assigns the column; rows
 *    auto-place in DOM order.
 *  - Where DOM order must change (subject follows reference in DOM
 *    order, or the subject is not first for prominentFirst), the relation
 *    reports THAT case and points to the DOM op path (reorderBefore with
 *    a real MutationReason). It does not report the whole relation.
 *  - adjacentTo, readBefore, prominentFirst are all satisfied through
 *    placement — adjusting slotAssignment, which the solver emits as
 *    grid-column. The adjacency/readingOrder arrays record the declared
 *    constraints for conformance verification; the solver does not read
 *    them. The emission path IS the slotAssignment.
 */

import type { RelationStatement } from '../../design/vocabulary.ts';
import { ARCHETYPES, ARCHETYPE_IDS, type TargetLayoutIR, type TargetSlotBehaviour, type UnsatisfiableConstraint } from '../../layout/ir.ts';

/** The composition relation names. */
export const COMPOSITION_RELATIONS = new Set([
  'archetype', 'assignSlot', 'trackAllocation', 'adjacentTo',
  'spansTracks', 'readBefore', 'stackDirection', 'wrapBehavior', 'prominentFirst',
]);

/** Resolve composition relations from the spec into a Target Layout IR.
 *  Falls back to the deterministic fallback when no composition relations are present.
 *  Reports unsatisfiable constraints rather than silently dropping them.
 *
 *  `domOrder` maps handle → sourceOrder index (DOM order) — needed for
 *  readBefore and prominentFirst to check whether the subject's DOM order
 *  allows the relation to be satisfied through placement alone.
 *  `focalHandle` is the perception's computed visual focal point — consumed
 *  by prominentFirst for conformance reporting (the subject is promoted to
 *  the focal position; the natural focal point is noted). */
export function resolveComposition(
  relations: RelationStatement[] | undefined,
  fallback: TargetLayoutIR,
  domOrder?: Map<string, number>,
  focalHandle?: string | null,
): TargetLayoutIR {
  if (!relations?.length) return fallback;
  const compRels = relations.filter((r) => COMPOSITION_RELATIONS.has(r.relation));
  if (!compRels.length) return fallback;

  let archetype = fallback.archetype;
  let tracks = [...fallback.tracks];
  const slotAssignment = new Map(fallback.slotAssignment);
  const spans = [...fallback.spans];
  const adjacency: [string, string][] = [...fallback.adjacency];
  const readingOrder = [...fallback.readingOrder];
  const slotBehaviour = new Map<number, TargetSlotBehaviour>(fallback.slotBehaviour);
  const unsatisfiable: UnsatisfiableConstraint[] = [...fallback.unsatisfiable];
  // Handles the model explicitly assigned via assignSlot. These resist
  // adjustment by adjacentTo/readBefore/prominentFirst — only unassigned
  // (fallback) handles move to satisfy ordering constraints.
  const explicitSlots = new Set<string>();

  // Pass 1: archetype + trackAllocation + assignSlot + spansTracks (set up tracks + assignments)
  for (const rel of compRels) {
    switch (rel.relation) {
      case 'archetype': {
        if (!ARCHETYPE_IDS.has(rel.archetype)) {
          unsatisfiable.push({ handle: rel.subject, constraint: 'archetype', reason: `unknown archetype '${rel.archetype}'` });
        } else {
          archetype = rel.archetype;
          tracks = [...ARCHETYPES[rel.archetype].tracks];
        }
        break;
      }
      case 'trackAllocation': {
        if (rel.ratios.length !== tracks.length) {
          unsatisfiable.push({ handle: rel.subject, constraint: 'trackAllocation', reason: `ratios length (${rel.ratios.length}) != track count (${tracks.length})` });
        } else {
          tracks = tracks.map((t, i) =>
            t.max.includes('fr') ? { ...t, max: `${rel.ratios[i]}fr` } : t,
          );
        }
        break;
      }
      case 'assignSlot': {
        if (rel.track < 0 || rel.track >= tracks.length) {
          unsatisfiable.push({ handle: rel.subject, constraint: 'assignSlot', reason: `track ${rel.track} out of range (0..${tracks.length - 1})` });
        } else {
          slotAssignment.set(rel.subject, rel.track);
          explicitSlots.add(rel.subject);
        }
        break;
      }
      case 'spansTracks': {
        spans.push(rel.subject);
        slotAssignment.delete(rel.subject);
        break;
      }
    }
  }

  // Pass 2: adjacency + reading order + behaviour + prominence (depend on assignments).
  // adjacentTo, readBefore, prominentFirst are satisfied through PLACEMENT —
  // adjusting slotAssignment, which the solver emits as grid-column. They also
  // record their declared constraints in adjacency/readingOrder for conformance
  // verification (H6). Genuine unsatisfiable cases are reported individually.
  const spanSet = new Set(spans);
  for (const rel of compRels) {
    switch (rel.relation) {
      case 'adjacentTo': {
        // Record the declared adjacency for conformance verification.
        adjacency.push([rel.subject, rel.reference]);
        // Satisfy through placement: two regions in neighbouring tracks are
        // adjacent. A span (full-width) is adjacent to everything — trivially
        // satisfied.
        if (spanSet.has(rel.subject) || spanSet.has(rel.reference)) break;
        const sTrack = slotAssignment.get(rel.subject);
        const rTrack = slotAssignment.get(rel.reference);
        if (sTrack != null && rTrack != null) {
          if (Math.abs(sTrack - rTrack) === 1) break; // already adjacent
          // Not adjacent — move the non-explicitly-assigned one.
          if (!explicitSlots.has(rel.subject)) {
            const newTrack = rTrack > 0 ? rTrack - 1 : rTrack + 1;
            if (newTrack >= 0 && newTrack < tracks.length) { slotAssignment.set(rel.subject, newTrack); break; }
          }
          if (!explicitSlots.has(rel.reference)) {
            const newTrack = sTrack > 0 ? sTrack - 1 : sTrack + 1;
            if (newTrack >= 0 && newTrack < tracks.length) { slotAssignment.set(rel.reference, newTrack); break; }
          }
          unsatisfiable.push({ handle: rel.subject, constraint: 'adjacentTo', reason: `tracks ${sTrack} and ${rTrack} are not adjacent, and neither can be moved (both explicit or no adjacent track)` });
        } else if (sTrack != null && rTrack == null) {
          // Reference unassigned — place it adjacent to the subject.
          const newTrack = sTrack > 0 ? sTrack - 1 : (sTrack + 1 < tracks.length ? sTrack + 1 : -1);
          if (newTrack >= 0 && newTrack < tracks.length) slotAssignment.set(rel.reference, newTrack);
          else unsatisfiable.push({ handle: rel.reference, constraint: 'adjacentTo', reason: `no track adjacent to ${sTrack} available` });
        } else if (sTrack == null && rTrack != null) {
          const newTrack = rTrack > 0 ? rTrack - 1 : (rTrack + 1 < tracks.length ? rTrack + 1 : -1);
          if (newTrack >= 0 && newTrack < tracks.length) slotAssignment.set(rel.subject, newTrack);
          else unsatisfiable.push({ handle: rel.subject, constraint: 'adjacentTo', reason: `no track adjacent to ${rTrack} available` });
        } else {
          // Neither assigned — place both in the first two adjacent tracks.
          if (tracks.length >= 2) { slotAssignment.set(rel.subject, 0); slotAssignment.set(rel.reference, 1); }
          else unsatisfiable.push({ handle: rel.subject, constraint: 'adjacentTo', reason: 'archetype has fewer than 2 tracks' });
        }
        break;
      }
      case 'readBefore': {
        // Record the declared reading order for conformance verification.
        const sIdx = readingOrder.indexOf(rel.subject);
        const rIdx = readingOrder.indexOf(rel.reference);
        if (sIdx === -1 && rIdx === -1) readingOrder.push(rel.subject, rel.reference);
        else if (rIdx === -1) readingOrder.splice(sIdx + 1, 0, rel.reference);
        else if (sIdx === -1) readingOrder.splice(rIdx, 0, rel.subject);
        else if (sIdx > rIdx) {
          readingOrder.splice(sIdx, 1);
          readingOrder.splice(readingOrder.indexOf(rel.reference), 0, rel.subject);
        }
        // Satisfy through placement: row + track assignment. In grid
        // auto-placement, rows follow DOM order; within a row, visual order
        // follows track index (left to right). So subject is read before
        // reference when: subject precedes reference in DOM order AND subject
        // is in the same or an earlier track.
        const sOrder = domOrder?.get(rel.subject);
        const rOrder = domOrder?.get(rel.reference);
        if (sOrder != null && rOrder != null && sOrder > rOrder) {
          // Subject follows reference in DOM order — it renders in a later
          // row. Visual order follows DOM order (accessibility); CSS `order`
          // is refused (breaks screen readers). The DOM op path (reorderBefore
          // with a real MutationReason) is the only way to change this.
          unsatisfiable.push({ handle: rel.subject, constraint: 'readBefore', reason: 'subject follows reference in DOM order — visual order follows DOM order (accessibility); use reorderBefore to change DOM order' });
          break;
        }
        // DOM order is correct (or unknown). Ensure subject is in the same or
        // an earlier track so it renders left of the reference.
        const sTrack = spanSet.has(rel.subject) ? 0 : slotAssignment.get(rel.subject);
        const rTrack = spanSet.has(rel.reference) ? 0 : slotAssignment.get(rel.reference);
        if (sTrack != null && rTrack != null && sTrack > rTrack) {
          if (!explicitSlots.has(rel.subject)) {
            const newTrack = rTrack > 0 ? rTrack - 1 : 0;
            if (newTrack < tracks.length) { slotAssignment.set(rel.subject, newTrack); break; }
          } else if (!explicitSlots.has(rel.reference)) {
            const newTrack = sTrack + 1 < tracks.length ? sTrack + 1 : sTrack;
            slotAssignment.set(rel.reference, newTrack); break;
          }
          unsatisfiable.push({ handle: rel.subject, constraint: 'readBefore', reason: `subject in track ${sTrack} renders after reference in track ${rTrack}, and both have explicit assignments` });
        }
        // Satisfied: subject before reference in DOM order and in same or earlier track.
        break;
      }
      case 'stackDirection': {
        const trackIdx = slotAssignment.get(rel.subject);
        if (trackIdx != null) {
          const existing = slotBehaviour.get(trackIdx) ?? { direction: 'column' as const, wrap: false, alignment: 'stretch' as const };
          slotBehaviour.set(trackIdx, { ...existing, direction: rel.direction === 'vertical' ? 'column' : 'row' });
        } else {
          unsatisfiable.push({ handle: rel.subject, constraint: 'stackDirection', reason: 'subject not assigned to a track' });
        }
        break;
      }
      case 'wrapBehavior': {
        const trackIdx = slotAssignment.get(rel.subject);
        if (trackIdx != null) {
          const existing = slotBehaviour.get(trackIdx) ?? { direction: 'column' as const, wrap: false, alignment: 'stretch' as const };
          slotBehaviour.set(trackIdx, { ...existing, wrap: rel.wrap });
        } else {
          unsatisfiable.push({ handle: rel.subject, constraint: 'wrapBehavior', reason: 'subject not assigned to a track' });
        }
        break;
      }
      case 'prominentFirst': {
        // Record the declared prominence for conformance verification.
        const idx = readingOrder.indexOf(rel.subject);
        if (idx > 0) { readingOrder.splice(idx, 1); readingOrder.unshift(rel.subject); }
        else if (idx === -1) readingOrder.unshift(rel.subject);
        // Consume the focal point perception: note whether the subject
        // matches the page's natural focal point (the perception's
        // focalPoint.handle). This is the first consumer of focalPoint —
        // it was computed but never read.
        if (focalHandle && focalHandle !== rel.subject) {
          unsatisfiable.push({ handle: rel.subject, constraint: 'prominentFirst', reason: `subject promoted to focal position; natural focal point is ${focalHandle}` });
        }
        // Satisfy through placement: the subject should be the first thing
        // seen = track 0 (leftmost), first row (first in DOM order).
        if (spanSet.has(rel.subject)) break; // a span is full-width — already prominent
        const sTrack = slotAssignment.get(rel.subject);
        if (sTrack != null && sTrack > 0) {
          if (!explicitSlots.has(rel.subject)) {
            slotAssignment.set(rel.subject, 0);
          } else {
            unsatisfiable.push({ handle: rel.subject, constraint: 'prominentFirst', reason: `subject explicitly assigned to track ${sTrack}, cannot move to track 0` });
            break;
          }
        } else if (sTrack == null) {
          slotAssignment.set(rel.subject, 0);
        }
        // Check DOM order: if the subject is not the first among placed
        // items in track 0, it renders in a later row — not "first thing
        // seen". Visual order follows DOM order (accessibility); the DOM
        // op path (reorderBefore) is the only fix.
        const sOrder = domOrder?.get(rel.subject);
        if (sOrder != null && sOrder > 0) {
          // Check if any other track-0 item has a lower sourceOrder.
          let firstInTrack0 = true;
          for (const [h, t] of slotAssignment) {
            if (t === 0 && h !== rel.subject) {
              const otherOrder = domOrder?.get(h);
              if (otherOrder != null && otherOrder < sOrder) { firstInTrack0 = false; break; }
            }
          }
          if (!firstInTrack0) {
            unsatisfiable.push({ handle: rel.subject, constraint: 'prominentFirst', reason: 'subject is not first in DOM order among track-0 items — it renders in a later row; use reorderBefore to make it the first thing seen' });
          }
        }
        break;
      }
    }
  }

  return { archetype, tracks, slotAssignment, spans, adjacency, readingOrder, slotBehaviour, unsatisfiable };
}

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
 *  Reports unsatisfiable constraints rather than silently dropping them. */
export function resolveComposition(
  relations: RelationStatement[] | undefined,
  fallback: TargetLayoutIR,
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

  // Pass 2: adjacency + reading order + behaviour + prominence (depend on assignments)
  for (const rel of compRels) {
    switch (rel.relation) {
      case 'adjacentTo':
        adjacency.push([rel.subject, rel.reference]);
        break;
      case 'readBefore': {
        const sIdx = readingOrder.indexOf(rel.subject);
        const rIdx = readingOrder.indexOf(rel.reference);
        if (sIdx === -1 && rIdx === -1) readingOrder.push(rel.subject, rel.reference);
        else if (rIdx === -1) readingOrder.splice(sIdx + 1, 0, rel.reference);
        else if (sIdx === -1) readingOrder.splice(rIdx, 0, rel.subject);
        else if (sIdx > rIdx) {
          readingOrder.splice(sIdx, 1);
          readingOrder.splice(readingOrder.indexOf(rel.reference), 0, rel.subject);
        }
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
        const idx = readingOrder.indexOf(rel.subject);
        if (idx > 0) { readingOrder.splice(idx, 1); readingOrder.unshift(rel.subject); }
        else if (idx === -1) readingOrder.unshift(rel.subject);
        break;
      }
    }
  }

  // Pass 3: Validate constraints the solver enforces by checking, not emitting.
  // The solver emits CSS for tracks/slotAssignment/spans/slotBehaviour. For
  // adjacency/readingOrder/prominence, it can only verify — if the constraint
  // can't be met by the grid placement, report unsatisfiable (never silently drop).
  const spanSet = new Set(spans);
  for (const rel of compRels) {
    if (rel.relation === 'adjacentTo') {
      const sTrack = slotAssignment.get(rel.subject);
      const rTrack = slotAssignment.get(rel.reference);
      if (sTrack == null && !spanSet.has(rel.subject)) {
        unsatisfiable.push({ handle: rel.subject, constraint: 'adjacentTo', reason: 'subject not assigned to a track' });
      } else if (rTrack == null && !spanSet.has(rel.reference)) {
        unsatisfiable.push({ handle: rel.reference, constraint: 'adjacentTo', reason: 'reference not assigned to a track' });
      } else if (sTrack != null && rTrack != null && Math.abs(sTrack - rTrack) !== 1) {
        unsatisfiable.push({ handle: rel.subject, constraint: 'adjacentTo', reason: `tracks ${sTrack} and ${rTrack} are not adjacent` });
      }
    }
    if (rel.relation === 'readBefore') {
      const sTrack = spanSet.has(rel.subject) ? 0 : slotAssignment.get(rel.subject);
      const rTrack = spanSet.has(rel.reference) ? 0 : slotAssignment.get(rel.reference);
      if (sTrack != null && rTrack != null && sTrack > rTrack) {
        unsatisfiable.push({ handle: rel.subject, constraint: 'readBefore', reason: `subject in track ${sTrack} is after reference in track ${rTrack} — solver cannot emit order CSS` });
      }
    }
    if (rel.relation === 'prominentFirst') {
      const sTrack = spanSet.has(rel.subject) ? 0 : slotAssignment.get(rel.subject);
      if (sTrack != null && sTrack > 0) {
        unsatisfiable.push({ handle: rel.subject, constraint: 'prominentFirst', reason: `subject in track ${sTrack} is not in the first track — solver cannot emit order CSS` });
      }
    }
  }

  return { archetype, tracks, slotAssignment, spans, adjacency, readingOrder, slotBehaviour, unsatisfiable };
}

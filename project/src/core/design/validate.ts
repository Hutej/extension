/**
 * core/design/validate — boundary validation for relational statements.
 *
 * Every relational statement the model returns is validated against a real
 * schema BEFORE it reaches the engine: known relation type, resolvable
 * handles, magnitude within permitted range, no contradiction with another
 * statement. Invalid statements are rejected INDIVIDUALLY with a reason,
 * never cast through, and never allowed to poison the whole response.
 *
 * Pure: takes raw model output as data, returns validated relations + a
 * rejection report. No DOM access, no model calls.
 */

import { RELATION_NAMES, relationSpec, type RelationStatement } from './vocabulary';

export interface ValidationReport {
  /** The validated relations that passed all checks. */
  accepted: RelationStatement[];
  /** The rejected statements, each with a reason. */
  rejected: { statement: unknown; reason: string }[];
  /** True if every statement was accepted. */
  ok: boolean;
}

const ACCENT_ROLES = new Set<string>(['primary', 'secondary', 'muted']);
const ACCENT_TARGETS = new Set<string>(['text', 'border', 'background']);
const SIDES = new Set<string>(['top', 'right', 'bottom', 'left', 'all']);
const CORNERS = new Set<string>(['tl', 'tr', 'br', 'bl', 'all']);
const EDGES = new Set<string>(['start', 'center', 'end', 'stretch']);
const TRANSFORMS = new Set<string>(['uppercase', 'lowercase', 'capitalize', 'none']);
const EASING_CHARS = new Set<string>(['smooth', 'sharp', 'spring', 'linear']);

/**
 * Validate an array of raw relation statements from the model. Each is checked
 * individually: known relation type, required fields present, magnitude
 * within range, no contradictions. Invalid ones are rejected with a reason;
 * valid ones pass through.
 */
export function validateRelations(raw: unknown[]): ValidationReport {
  const accepted: RelationStatement[] = [];
  const rejected: { statement: unknown; reason: string }[] = [];

  // Track subjects for contradiction detection.
  const subjectsSeen = new Map<string, Set<string>>();

  for (const item of raw) {
    const r = validateOne(item, subjectsSeen);
    if (r.ok) accepted.push(r.statement);
    else rejected.push({ statement: item, reason: r.reason });
  }

  return { accepted, rejected, ok: rejected.length === 0 };
}

function validateOne(
  item: unknown,
  subjectsSeen: Map<string, Set<string>>,
): { ok: true; statement: RelationStatement } | { ok: false; reason: string } {
  if (!item || typeof item !== 'object') return { ok: false, reason: 'not an object' };
  const r = item as Record<string, unknown>;

  if (typeof r.relation !== 'string' || !r.relation) return { ok: false, reason: 'missing relation type' };
  if (!RELATION_NAMES.has(r.relation)) return { ok: false, reason: `unknown relation "${r.relation}"` };
  if (typeof r.subject !== 'string' || !r.subject) return { ok: false, reason: 'missing subject' };

  const spec = relationSpec(r.relation);
  if (!spec) return { ok: false, reason: `no spec for relation "${r.relation}"` };

  // Check reference field if required.
  if (spec.hasReference) {
    if (typeof r.reference !== 'string' || !r.reference) return { ok: false, reason: `${r.relation} requires a reference` };
  }

  // Check magnitude field if required.
  if (spec.magnitudeField && spec.magnitudeKind) {
    const val = r[spec.magnitudeField];
    if (val == null) return { ok: false, reason: `${r.relation} requires ${spec.magnitudeField}` };
    if (typeof val !== 'number' || !isFinite(val)) return { ok: false, reason: `${r.relation}.${spec.magnitudeField} must be a number` };
    // Range checks per kind.
    if (spec.magnitudeKind === 'ratio' && val <= 0) return { ok: false, reason: `${r.relation}.ratio must be positive` };
    if (spec.magnitudeKind === 'fraction' && (val < 0 || val > 1)) return { ok: false, reason: `${r.relation}.fraction must be 0-1` };
    if (spec.magnitudeKind === 'step' && (val < 0 || val > 20 || !Number.isInteger(val))) return { ok: false, reason: `${r.relation}.step must be a non-negative integer` };
    if (spec.magnitudeKind === 'rank' && (val < 0 || val > 10 || !Number.isInteger(val))) return { ok: false, reason: `${r.relation}.rank must be a non-negative integer` };
    if (spec.magnitudeKind === 'count' && (val < 0 || !Number.isInteger(val))) return { ok: false, reason: `${r.relation}.${spec.magnitudeField} must be a non-negative integer` };
  }

  // Relation-specific field validation.
  const rel = r.relation as string;
  if (rel === 'accentRole' || rel === 'accentOn') {
    if (!ACCENT_ROLES.has(r.role as string)) return { ok: false, reason: `${rel}.role must be primary|secondary|muted` };
  }
  if (rel === 'accentOn') {
    if (!ACCENT_TARGETS.has(r.target as string)) return { ok: false, reason: 'accentOn.target must be text|border|background' };
  }
  if (rel === 'paddingSide' && !SIDES.has(r.side as string)) return { ok: false, reason: 'paddingSide.side must be top|right|bottom|left|all' };
  if (rel === 'radiusCorner' && !CORNERS.has(r.corner as string)) return { ok: false, reason: 'radiusCorner.corner must be tl|tr|br|bl|all' };
  if (rel === 'alignsWith' && !EDGES.has(r.edge as string)) return { ok: false, reason: 'alignsWith.edge must be start|center|end|stretch' };
  if (rel === 'textTransform' && !TRANSFORMS.has(r.transform as string)) return { ok: false, reason: 'textTransform.transform must be uppercase|lowercase|capitalize|none' };
  if (rel === 'fontWeightRank') {
    const rank = r.rank as number;
    if (rank < 1 || rank > 5 || !Number.isInteger(rank)) return { ok: false, reason: 'fontWeightRank.rank must be 1-5' };
  }
  // F4 — motion relation validation
  if (rel === 'transitionEasing' && !EASING_CHARS.has(r.easing as string)) return { ok: false, reason: 'transitionEasing.easing must be smooth|sharp|spring|linear' };
  if (rel === 'focusRing' && !ACCENT_ROLES.has(r.role as string)) return { ok: false, reason: 'focusRing.role must be primary|secondary|muted' };

  // Contradiction check: two relations on the same subject with the same relation
  // type but different magnitudes is a contradiction (e.g. two emphasisRank with
  // different ranks on the same subject).
  const contradictionKey = `${r.relation}:${r.subject}`;
  const sig = JSON.stringify({ ...r, subject: undefined });
  const seen = subjectsSeen.get(contradictionKey);
  if (seen) {
    if (seen.has(sig)) {
      // Exact duplicate — skip silently (not a contradiction, just redundant).
    } else {
      // Same relation+subject, different fields — could be a contradiction or a
      // complement. For relations with a single magnitude, it IS a contradiction.
      // For multi-field relations (like paddingSide with different sides), it's OK.
      if (spec.magnitudeField && spec.magnitudeKind !== 'named') {
        return { ok: false, reason: `contradiction: ${r.relation} on "${r.subject}" already has a different ${spec.magnitudeField}` };
      }
    }
  } else {
    subjectsSeen.set(contradictionKey, new Set([sig]));
  }

  return { ok: true, statement: r as unknown as RelationStatement };
}

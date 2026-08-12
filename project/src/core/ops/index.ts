/**
 * core/ops — the structural-op vocabulary + guard-law validation. Pure: takes
 * the ops + the perception (clusters by handle) as data, returns a validated
 * plan + refusals. Ported from archive/project/src/core/ops/index.ts. Guard
 * logic is here so it's unit-testable without a DOM.
 *
 * Phase 2 status: the live act tools are setText/insert/CSS-based. The model
 * does NOT emit remove/move/reorder/wrap yet (those are future structural ops).
 * validateOps is ported now so the structural-op foundation is correct the day
 * the model starts emitting them — it is the perception-time guard that makes
 * a future remove safe. It is NOT yet called by any act tool (no orphans: this
 * module is imported by tests/ops.test.ts and wired-in when structural ops land).
 *
 * Safety rules (unified with the hide channel):
 *  - `remove` is at LEAST as strict as hide: never primary content (main/article),
 *    never landmarks, never opaque wrappers, never tall or huge-repeated clusters.
 *    Physical removal reclaims dead space, so it also requires the cluster to be
 *    near-EMPTY (emptinessScore above a floor) — removing content is almost always wrong.
 *  - `move`/`reorder`/`wrap` refuse `forbidden` targets; `risky` targets need consent.
 *  - Default is NO DOM mutation: every op must carry a reason from the closed
 *    MutationReason list, or it is refused.
 */

import type { Cluster, Perception } from '../perceive';

export type OpKind = 'remove' | 'move' | 'reorder' | 'wrap';

/** A structural op the model emits. (setText/insert are act tools, not ops.) */
export interface DesignOp {
  kind: OpKind;
  /** Cluster handle the op targets. */
  target: string;
  /** move: destination handle or 'floating' (position:fixed lever). wrap: display. */
  to?: string;
  /** reorder: insert before this handle (omitted = end). */
  before?: string;
  /** Risky-target consent. */
  consent?: boolean;
  /** The mutation reason from the closed list — required to execute. */
  reason?: string;
}

export interface ValidatedOp {
  kind: OpKind;
  target: string;
  to?: string;
  before?: string;
  consent?: boolean;
  hint?: string;
  reason?: string;
}

export interface OpValidationResult {
  ops: ValidatedOp[];
  refused: string[];
}

/** Near-empty floor: a remove reclaims dead space; below this it would delete
 *  real content. The empty-capsule / dead-band failures score ~0.9+. */
export const REMOVE_EMPTINESS_FLOOR = 0.6;

/** A destructive op (remove) is FORBIDDEN on any role below this confidence —
 *  the classifier is < 0.5 sure what this is, so collapsing it risks removing
 *  content it misread. */
export const DESTRUCTIVE_CONFIDENCE_FLOOR = 0.5;

/** The closed list of reasons a DOM mutation is permitted. Default: do not
 *  move DOM nodes. Restructuring is permitted ONLY when the transformation is
 *  genuinely inexpressible in CSS. */
export type MutationReason =
  | 'escape-overflow-hidden'
  | 'escape-stacking-context'
  | 'cross-layout-regions'
  | 'impossible-ancestry';

export const MUTATION_REASONS: ReadonlySet<string> = new Set<string>([
  'escape-overflow-hidden',
  'escape-stacking-context',
  'cross-layout-regions',
  'impossible-ancestry',
]);

/** Validate the op set against guard laws. Pure (no DOM). */
export function validateOps(ops: DesignOp[] | undefined, perception: Perception): OpValidationResult {
  const out: ValidatedOp[] = [];
  const refused: string[] = [];
  if (!ops?.length) return { ops: out, refused };

  const byHandle = new Map<string, Cluster>();
  for (const c of perception.clusters) byHandle.set(c.handle, c);

  for (const op of ops) {
    const cl = byHandle.get(op.target);
    if (!cl) { refused.push(`${op.kind}(${op.target}:no-such-handle)`); continue; }

    // Default is no mutation: every op must carry a reason from the closed list.
    if (!op.reason || !MUTATION_REASONS.has(op.reason)) {
      refused.push(`${op.kind}(${op.target}:no-mutation-reason — Law 0 default is no DOM mutation)`);
      continue;
    }

    if (op.kind === 'remove') {
      const r = refuseRemove(cl);
      if (r) { refused.push(`remove(${op.target}:${r})`); continue; }
      out.push({ kind: 'remove', target: op.target, reason: op.reason });
      continue;
    }

    // move/reorder/wrap: forbidden targets never move; risky needs consent.
    if (cl.moveSafety === 'forbidden') { refused.push(`${op.kind}(${op.target}:forbidden)`); continue; }
    if (cl.moveSafety === 'risky' && !op.consent) { refused.push(`${op.kind}(${op.target}:risky-no-consent)`); continue; }

    if (op.kind === 'move') {
      if (op.to && op.to !== 'floating') {
        const dest = byHandle.get(op.to);
        if (!dest) { refused.push(`move(${op.target}:bad-dest-${op.to})`); continue; }
        if (isAncestorHandle(op.target, op.to, byHandle)) { refused.push(`move(${op.target}:into-descendant)`); continue; }
      }
      out.push({ kind: 'move', target: op.target, to: op.to, consent: op.consent, hint: op.to === 'floating' ? 'floating' : undefined, reason: op.reason });
      continue;
    }

    if (op.kind === 'reorder') {
      if (op.before) {
        const before = byHandle.get(op.before);
        if (!before) { refused.push(`reorder(${op.target}:bad-before-${op.before})`); continue; }
      }
      out.push({ kind: 'reorder', target: op.target, before: op.before, reason: op.reason });
      continue;
    }

    if (op.kind === 'wrap') {
      out.push({ kind: 'wrap', target: op.target, to: op.to, hint: op.to, reason: op.reason });
      continue;
    }
  }

  return { ops: out, refused };
}

/** Why a remove must be refused, or null if safe. A remove COLLAPSES the node
 *  and reclaims — so a PASSIVE (empty/structural) wrapper with high emptiness
 *  IS the canonical remove target. Only OPAQUE wrappers (canvas-hiders) are
 *  refused on the wrapper axis. Primary content, landmarks, tall,
 *  huge-repeated, and non-empty clusters are still refused. */
function refuseRemove(c: Cluster): string | null {
  if (c.role === 'main' || c.role === 'article') return 'primary-content';
  if (c.role === 'navigation' || c.role === 'banner') return 'landmark';
  if (c.layout.isOpaqueWrapper) return 'opaque-wrapper';
  if (c.rect.h > 300) return 'tall-content';
  if (c.count > 40) return 'repeated-content';
  if (c.designRoleConfidence < DESTRUCTIVE_CONFIDENCE_FLOOR) return 'low-confidence-role';
  if ((c.emptinessScore ?? 0) < REMOVE_EMPTINESS_FLOOR) return 'not-empty';
  return null;
}

/** True if `ancestor` handle's cluster contains the `descendant` handle's cluster. */
function isAncestorHandle(ancestor: string, descendant: string, byHandle: Map<string, Cluster>): boolean {
  let cur: Cluster | undefined = byHandle.get(descendant);
  while (cur) {
    const ph = cur.layout.parentHandle;
    if (!ph) return false;
    if (ph === ancestor) return true;
    cur = byHandle.get(ph);
  }
  return false;
}

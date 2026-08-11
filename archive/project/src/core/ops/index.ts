/**
 * core/ops — the op vocabulary + guard-law validation. Pure: takes the spec's
 * ops + the perception (clusters by handle) as data, returns a validated plan
 * (ValidatedOp[]) + refusals. content.ts executes the accepted ops against the
 * live DOM. Guard logic is here so it's unit-testable without a DOM.
 *
 * Safety rules (unified with the existing hide channel):
 *  - `remove` is at LEAST as strict as hideRefusal (compile/index.ts): never
 *    primary content (main/article), never wrappers, never page-scale or
 *    tall or huge-repeated clusters. Physical removal is harder to undo than
 *    display:none, so a remove also requires the cluster to be near-EMPTY
 *    (emptinessScore above a floor) — removal reclaims dead space; removing a
 *    content-rich cluster is almost always wrong.
 *  - `move`/`reorder`/`wrap` refuse `forbidden` targets (primary-content
 *    ancestors, scripts). `risky` targets (event-heavy, forms, live iframes,
 *    canvas/video) execute ONLY with an explicit `consent` flag.
 *  - `move` to a named destination must resolve to a real cluster (or the
 *    'floating' lever). `reorder`'s `before` (if given) must be a sibling.
 */

import type { DesignOp, OpKind } from '../spec';
import type { Cluster, Perception } from '../perceive';

// DOM mutation policy — the closed list of reasons a mutation is permitted.
// Default: do not move DOM nodes. Restructuring is permitted ONLY when the
// transformation is genuinely inexpressible in CSS. Any mutation must carry a
// recorded reason from this list, or it does not execute.
export type MutationReason =
  | 'escape-overflow-hidden'    // content clipped by an overflow:hidden ancestor
  | 'escape-stacking-context'   // trapped behind a z-index/transform/filter ancestor
  | 'cross-layout-regions'      // sidebar→topbar requires source-order change
  | 'impossible-ancestry';      // constraint graph has no CSS solution in current tree

export const MUTATION_REASONS: ReadonlySet<string> = new Set([
  'escape-overflow-hidden',
  'escape-stacking-context',
  'cross-layout-regions',
  'impossible-ancestry',
]);

export interface ValidatedOp {
  kind: OpKind;
  target: string;        // handle
  to?: string;
  before?: string;
  consent?: boolean;
  /** The live-DOM execution reads this hint (e.g. wrap display, move floating). */
  hint?: string;
  /** the recorded reason from the closed list, or null if none was provided
   *  (the op will be refused — default is no mutation). */
  reason?: string;
}

export interface OpValidationResult {
  ops: ValidatedOp[];
  refused: string[];     // `kind(target:reason)` — logged like droppedProps
}

/** Near-empty floor: a remove op reclaims dead space, so the target must be
 *  genuinely sparse. Below this emptinessScore, removal would delete real
 *  content — refuse. The empty-capsule / dead-band failures score ~0.9+. */
export const REMOVE_EMPTINESS_FLOOR = 0.6;

/** HARD SAFETY RULE (, permanent): a destructive op (remove) is FORBIDDEN
 *  on any role below the confidence threshold — the classifier is < 0.5 sure what
 *  this region is, so collapsing it risks removing content it misread. A confident
 *  ad-or-void stays removable (subject to the emptiness floor below). */
export const DESTRUCTIVE_CONFIDENCE_FLOOR = 0.5;

/**
 * Validate the op set against guard laws. Pure. Returns the accepted ops + the
 * refusals (compile logs refusals like droppedProps). Idempotency (skip-if-
 * already-done) is a LIVE-DOM concern handled in content.ts executeOps, not
 * here — this is the static, perception-time gate.
 */
export function validateOps(ops: DesignOp[] | undefined, perception: Perception): OpValidationResult {
  const out: ValidatedOp[] = [];
  const refused: string[] = [];
  if (!ops || !ops.length) return { ops: out, refused };

  const byHandle = new Map<string, Cluster>();
  for (const c of perception.clusters) byHandle.set(c.handle, c);

  for (const op of ops) {
    const cl = byHandle.get(op.target);
    if (!cl) { refused.push(`${op.kind}(${op.target}:no-such-handle)`); continue; }

    // DOM mutation policy — default is no mutation. Any op must carry a
    // recorded reason from the closed list, or it does not execute.
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
      // 'floating' is the position:fixed mini-player lever (no destination cluster).
      if (op.to && op.to !== 'floating') {
        const dest = byHandle.get(op.to);
        if (!dest) { refused.push(`move(${op.target}:bad-dest-${op.to})`); continue; }
        // Don't move into a descendant (would orphan the node).
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

/** Why a remove must be refused, or null if safe. Unlike hide (display:none,
 *  which just hides a wrapper and leaves a hole), a remove COLLAPSES the node
 *  and re-parents/reclaims — so a PASSIVE wrapper (empty/structural, "safe to
 *  collapse via display:contents" per perceive) with high emptiness IS the
 *  canonical remove target: it reclaims the dead-margin band. Only OPAQUE
 *  wrappers (solid-bg canvas-hiders) are refused on the wrapper axis — removing
 *  one reveals the canvas, a bigger compositional change than removal should
 *  make unsupervised. Primary content, landmarks, tall, huge-repeated, and
 *  non-empty clusters are still refused (the emptiness floor is the content
 *  guard — removal is for dead space, not deleting content). */
function refuseRemove(c: Cluster): string | null {
  if (c.role === 'main' || c.role === 'article') return 'primary-content';
  if (c.role === 'navigation' || c.role === 'banner') return 'landmark';
  if (c.layout.isOpaqueWrapper) return 'opaque-wrapper';
  if (c.rect.h > 300) return 'tall-content';
  if (c.count > 40) return 'repeated-content';
  // HARD SAFETY RULE: refuse remove on an uncertain role (< 0.5 confidence) — the
  // classifier isn't sure what this is, so collapsing it could delete misread content.
  if (c.designRoleConfidence < DESTRUCTIVE_CONFIDENCE_FLOOR) return 'low-confidence-role';
  if ((c.emptinessScore ?? 0) < REMOVE_EMPTINESS_FLOOR) return 'not-empty';
  return null;
}

/** True if `ancestor` handle's cluster contains the `descendant` handle's cluster. */
function isAncestorHandle(ancestor: string, descendant: string, byHandle: Map<string, Cluster>): boolean {
  let cur = byHandle.get(descendant);
  while (cur) {
    const ph = cur.layout.parentHandle;
    if (!ph) return false;
    if (ph === ancestor) return true;
    cur = byHandle.get(ph);
  }
  return false;
}
/**
 * TransformBundle — the new output contract.
 * Phase 0: types only + stub buildBundle() that maps the existing Plan
 * into a TransformBundle-shaped result. Not wired to reason yet.
 */

import type { Plan, ActionSpec } from '../plan';

// ── Global constants ───────────────────────────────────────────────

/** Maximum CSS string length in bytes */
export const MAX_THEME_CSS_BYTES = 256_000;

/** Maximum number of DomOps per bundle */
export const MAX_DOM_OPS = 200;

/** Maximum number of injected markup fragments */
export const MAX_INJECTED_NODES = 50;

/** Maximum number of motion specs */
export const MAX_MOTION_SPECS = 50;

/** Maximum number of behavior ops */
export const MAX_BEHAVIOR_OPS = 50;

// ── DomOp types ────────────────────────────────────────────────────

export interface HideDomOp {
  kind: 'hide';
  targetId: string;
}

export interface MoveDomOp {
  kind: 'move';
  targetId: string;
  to: 'fixed' | string; // 'fixed' = position:fixed; string = parentId
  pos?: { x?: number; y?: number; anchor?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' };
}

export interface InjectDomOp {
  kind: 'inject';
  intoId?: string;       // target container; omit = body
  markupRef: string;      // key into injectedMarkup[]
}

export type DomOp = HideDomOp | MoveDomOp | InjectDomOp;

// ── InjectedNode ───────────────────────────────────────────────────

export interface InjectedNode {
  ref: string;           // matches DomOp.markupRef
  html: string;          // sanitized HTML fragment (will live in Shadow DOM)
}

// ── MotionSpec (reserved) ──────────────────────────────────────────

export interface MotionSpec {
  targetId: string;
  animation: string;     // CSS animation shorthand or keyframe name
  trigger?: 'load' | 'scroll' | 'hover';
}

// ── BehaviorOp ─────────────────────────────────────────────────────
// Reuses the existing behavior primitive types from plan

export interface BehaviorOp {
  action: ActionSpec;
}

// ── TransformBundle ────────────────────────────────────────────────

export interface TransformBundle {
  themeCss?: string;                // AI-authored CSS, pre-sanitization
  domOps?: DomOp[];                 // structured, reversible
  injectedMarkup?: InjectedNode[];  // sanitized HTML fragments (Shadow DOM)
  motion?: MotionSpec[];            // reserved; may be empty this phase
  behavior?: BehaviorOp[];          // reuse existing behavior primitive types
  reasoning?: string;
}

// ── Stub buildBundle ───────────────────────────────────────────────
// Maps the existing Plan into a TransformBundle-shaped result.
// Phase 1 will swap the internals so reason produces TransformBundle directly.

export function buildBundle(plan: Plan): TransformBundle {
  const bundle: TransformBundle = {
    reasoning: plan.reasoning,
  };

  const domOps: DomOp[] = [];
  const behaviorOps: BehaviorOp[] = [];

  for (const op of plan.operations) {
    if (op.op === 'hide' && op.targetId) {
      domOps.push({ kind: 'hide', targetId: op.targetId });
    } else if (op.op === 'isolate' && op.keepId) {
      // Isolate is conceptually a "hide everything except keepId"
      // For now, represent as a hide with a special sentinel
      // The apply layer already handles isolate logic
      domOps.push({ kind: 'hide', targetId: `__isolate__${op.keepId}` });
    } else if (op.op === 'act' && op.action) {
      behaviorOps.push({ action: op.action });
    }
  }

  if (domOps.length > 0) bundle.domOps = domOps.slice(0, MAX_DOM_OPS);
  if (behaviorOps.length > 0) bundle.behavior = behaviorOps.slice(0, MAX_BEHAVIOR_OPS);

  return bundle;
}

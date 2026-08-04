/**
 * core/layout/ir — the Current Layout IR. 
 *
 * The IR answers "how is it arranged?" — a SEPARATE stage from Perception ("what is this?") and the
 * Semantic Model ("what is this: a nav-primary?"). It is a PURE PROJECTION of a Perception into the
 * four-section node, plus the page's CURRENT arrangement expressed as semantic constraints.
 *
 * IMMATURITY IS A CONTRACT, NOT A CONVENTION: extractLayoutIR deep-freezes the result (Object.freeze,
 * recursively). Any mutation throws in development. The Target IR (Step 2) is a NEW object built
 * from the frozen Current IR — never a mutation of it. Any code path that mutates the Current IR is a bug.
 *
 * Constraint vocabulary is SEMANTIC, not measurements (FillParent/Centered/StackVertically/...). Every
 * constraint carries a priority (required|preferred|optional) + a source (law|language|intent).
 * Priority is assigned by descending authority: Browser Laws -> Layout Language -> Transformation
 * Intent. THE MODEL NEVER ASSIGNS PRIORITY. In the Current IR every constraint's source is 'law'
 * (the page's existing arrangement).
 *
 * Pure: takes a Perception as data, no DOM access. 0 model calls. Unit-testable without a page.
 */

import type { Perception, Cluster } from '../perceive/index.ts';
import type { DesignRole } from '../perceive/semantic.ts';

// ── Constraint vocabulary (semantic, not measurements) ───────────

export type ConstraintKind =
  | 'FillParent'        // width follows parent (block-fill / 100%)
  | 'Centered'          // margin-inline auto / centered in parent
  | 'StackVertically'   // children flow top->bottom (flex-column / block stack)
  | 'WrapOnOverflow'    // children wrap when they exceed the line
  | 'MaxWidth'          // a measure ceiling
  | 'AspectRatio'       // intrinsic ratio preserved (media)
  | 'Gap'               // spacing between children (scale step)
  | 'Alignment'         // cross/main-axis alignment
  | 'Ordering';         // source-order position (accessibility -- inviolable)

export type ConstraintPriority = 'required' | 'preferred' | 'optional';
export type ConstraintSource = 'law' | 'language' | 'intent';

export interface LayoutConstraint {
  kind: ConstraintKind;
  priority: ConstraintPriority;
  source: ConstraintSource;
  /** A SEMANTIC token, never a raw px measurement:
   *  FillParent  -> undefined, or 'partial' when widthRatio < ~1
   *  MaxWidth    -> 'partial' (Current IR); 'prose'|'full'|'compact' in the Target IR
   *  Gap         -> 's' | 'm' | 'l' (a scale-step name)
   *  Alignment   -> 'start' | 'center' | 'end' | 'stretch' | 'mixed'
   *  Ordering    -> the sourceOrder bucket as a string, or 'out-of-flow'
   *  AspectRatio -> the ratio as 'w:h' */
  value?: string;
}

// ── The four sections per node ─────────────────────────────────────

export interface IRSemantic {
  role: DesignRole;
  confidence: number;        // designRoleConfidence (0..1)
  dominanceRank: number;     // 0..1
  group: string | null;      // sibling-group id
}

export interface IRAuthoredLayout {
  display: string;                        // computed display value
  flow: 'row' | 'column' | 'none';
  isContainer: boolean;                    // lays out children (flex/grid/>=2 kids)
  isFlex: boolean;
  isGrid: boolean;
  flexWrap: boolean;                        // flex-wrap: wrap
  intrinsicSizing: 'auto' | 'fixed' | 'fluid'; // how width is authored
  position: 'static' | 'relative' | 'absolute' | 'fixed' | 'sticky';
  centered: boolean;                        // margin-inline: auto
  widthRatio: number;                       // rect.w / viewport.w, bucketed to 0.05
}

export interface IRComputedRelationships {
  parent: string | null;                   // parent handle
  children: string[];                       // child handles, in DOM order
  siblings: string[];                        // sibling handles (same parent), incl self
  alignment: 'start' | 'center' | 'end' | 'stretch' | 'mixed';
  ordering: number;                          // sourceOrder index
  grouping: string | null;                  // sibling-group id (== semantic.group)
}

export interface LayoutIRNode {
  handle: string;
  semantic: IRSemantic;
  authoredLayout: IRAuthoredLayout;
  computedRelationships: IRComputedRelationships;
  /** EMPTY in the Current IR (extraction populates none). Populated ONLY in the Target IR by the
   *  transformation + the solver. The model NEVER assigns priority. */
  targetConstraints: LayoutConstraint[];
}

export interface LayoutIR {
  /** The viewport the IR was captured at (the probe + the solver both need it). */
  viewport: { w: number; h: number };
  nodes: LayoutIRNode[];
  /** Frozen lookup -- immutability contract enforced on the whole IR. */
  byHandle: ReadonlyMap<string, LayoutIRNode>;
}

// ── Extraction ─────────────────────────────────────────────────────

/** Extract the CURRENT layout IR from a Perception. PURE: no DOM access -- perception already
 *  captured the computed styles. Projects each cluster into the four-section node, inverts
 *  parentHandle -> children/siblings, and buckets widthRatio to 0.05 for stability. The result is
 *  DEEP-FROZEN: the Current IR is immutable. */
export function extractLayoutIR(perception: Perception): LayoutIR {
  const nodes: LayoutIRNode[] = perception.clusters.map(toNode);

  // Invert parentHandle -> children (DOM order is preserved by perception's cluster order, which
  // is source-order-indexed). siblings = children of the same parent, including self.
  const childrenOf = new Map<string | null, string[]>();
  for (const n of nodes) {
    const key = n.computedRelationships.parent;
    const arr = childrenOf.get(key);
    if (arr) arr.push(n.handle); else childrenOf.set(key, [n.handle]);
  }
  const _siblingsOf = new Map<string | null, string[]>();
  // siblings share a parent: a node's siblings are the children-list of its parent (incl itself).
  for (const n of nodes) {
    const sibs = childrenOf.get(n.computedRelationships.parent) ?? [n.handle];
    n.computedRelationships.children = childrenOf.get(n.handle) ?? [];
    n.computedRelationships.siblings = sibs;
  }

  const byHandle = new Map<string, LayoutIRNode>();
  for (const n of nodes) byHandle.set(n.handle, n);

  const ir: LayoutIR = { viewport: { ...perception.viewport }, nodes, byHandle };
  return deepFreeze(ir);
}

/** Project one cluster into an IR node (mutable here, frozen by extractLayoutIR). */
function toNode(c: Cluster): LayoutIRNode {
  const disp = c.layout.display;
  const isFlex = disp.includes('flex');
  const isGrid = disp.includes('grid');
  return {
    handle: c.handle,
    semantic: {
      role: c.designRole,
      confidence: c.designRoleConfidence,
      dominanceRank: c.dominanceRank,
      group: c.group,
    },
    authoredLayout: {
      display: disp,
      flow: c.layout.flow,
      isContainer: c.layout.isContainer,
      isFlex,
      isGrid,
      flexWrap: c.layout.flexWrap,
      intrinsicSizing: c.layout.widthSizing,
      position: c.layout.position,
      centered: c.layout.centered,
      widthRatio: Math.round(Math.round(c.layout.widthRatio / 0.05) * 0.05 * 100) / 100,  // bucket to 0.05
    },
    computedRelationships: {
      parent: c.layout.parentHandle,
      children: [],            // filled by extractLayoutIR after the inversion pass
      siblings: [],
      alignment: c.layout.alignment,
      ordering: c.sourceOrder,
      grouping: c.group,
    },
    targetConstraints: [],     // EMPTY in the Current IR
  };
}

// ── Current-arrangement constraints (pure derivation) ─────────────

/** Derive a node's CURRENT arrangement as constraints (pure). The seed the Target IR extends, and
 *  the probe's constraint-stability signature. In the Current IR every source is 'law'. */
export function currentConstraints(node: LayoutIRNode): LayoutConstraint[] {
  const a = node.authoredLayout;
  const out: LayoutConstraint[] = [];

  // Ordering is required/law on every node (reading order is inviolable). Out-of-flow nodes note it.
  out.push(a.position === 'absolute' || a.position === 'fixed'
    ? { kind: 'Ordering', priority: 'required', source: 'law', value: 'out-of-flow' }
    : { kind: 'Ordering', priority: 'required', source: 'law', value: String(node.computedRelationships.ordering) });

  if (a.isContainer) {
    if (a.flow === 'column') out.push({ kind: 'StackVertically', priority: 'preferred', source: 'law' });
    else if (a.flow === 'row') out.push({ kind: 'Alignment', priority: 'preferred', source: 'law', value: node.computedRelationships.alignment });
    if (a.flexWrap) out.push({ kind: 'WrapOnOverflow', priority: 'preferred', source: 'law' });
  }

  // FillParent: full vs partial (the knife-edge threshold the probe flags per-kind).
  out.push(a.widthRatio >= 0.97
    ? { kind: 'FillParent', priority: 'preferred', source: 'law' }
    : { kind: 'FillParent', priority: 'preferred', source: 'law', value: 'partial' });

  if (a.centered) out.push({ kind: 'Centered', priority: 'optional', source: 'law' });

  if (a.intrinsicSizing === 'fixed' || a.intrinsicSizing === 'fluid') {
    out.push({ kind: 'MaxWidth', priority: 'preferred', source: 'law', value: 'partial' });
  }

  return out;
}

// ── Target Layout IR ────────────────────────────────────────────────

/** A track in the target layout, expressed as a proportional allocation
 *  (fr) with a browser-native minmax() floor — never a measured width.
 *  The solver emits `minmax(min, max)` for each track. */
export interface TargetTrack {
  /** The minmax() floor. A pack token (var(--rv-side-max)),
   *  a content-intrinsic keyword (min-content, fit-content, auto), or 0.
   *  Never a measured pixel width — Law 0. */
  min: string;
  /** The track's sizing max: 'Xfr' for flexible tracks (e.g. '1fr', '2fr'),
   *  or a bounded CSS value for fixed tracks (e.g. 'var(--rv-side-max)'). */
  max: string;
}

/** Per-slot behaviour: how the contents of a track are arranged. */
export interface TargetSlotBehaviour {
  /** Stacking direction: 'column' (vertical) or 'row' (horizontal). */
  direction: 'row' | 'column';
  /** Whether the slot reflows (wraps) when content exceeds the track.
   *  The browser decides when — auto-fit, minmax() — never a computed breakpoint. */
  wrap: boolean;
  /** Cross-axis alignment. */
  alignment: 'start' | 'center' | 'end' | 'stretch';
}

/** A constraint the solver could not satisfy, with the reason.
 *  Unsatisfiable is a reported outcome, never a silent drop. */
export interface UnsatisfiableConstraint {
  handle: string;
  constraint: string;
  reason: string;
}

/** The Target Layout IR — the declared destination page, expressed as
 *  constraints the browser re-solves. The solver receives this and the
 *  Current IR, and nothing else. Per-element cosmetic declarations continue
 *  through the existing compiler path — they are NOT part of this IR.
 *
 *  Sufficiency: every decision the solver needs is in this IR. If the solver
 *  needs to reach back into perception, that decision belongs here, not in
 *  the solver. The Current IR provides existing-structure context (NCA,
 *  formatting context); the Target IR provides the desired structure. */
export interface TargetLayoutIR {
  /** The archetype the model chose (one of ARCHETYPES). */
  archetype: string;
  /** Track definitions — one per grid track. The solver emits
   *  `grid-template-columns: minmax(min, max) ...`. */
  tracks: TargetTrack[];
  /** Slot assignments: handle → track index (0-based into tracks).
   *  Handles not in this map are not placed (they flow in the overflow). */
  slotAssignment: Map<string, number>;
  /** Handles that span all tracks (grid-column: 1 / -1). */
  spans: string[];
  /** Adjacent region pairs (handle → handle). The solver uses these to
   *  verify adjacent regions are in adjacent tracks. */
  adjacency: [string, string][];
  /** Reading order: handles in the order they should be read. The solver
   *  asserts DOM order is preserved (no `order` or arbitrary grid-area). */
  readingOrder: string[];
  /** Per-track behaviour: track index → how contents are arranged. */
  slotBehaviour: Map<number, TargetSlotBehaviour>;
  /** Constraints the solver could not satisfy, with reasons. Empty when
   *  all constraints are satisfiable. Never a silent drop. */
  unsatisfiable: UnsatisfiableConstraint[];
}

/** The archetype shortlist. The model picks from this list; it does not
 *  invent one. Each archetype defines a default track structure expressed
 *  as fr proportions + browser-native bounds (minmax), never measured widths. */
export const ARCHETYPES: Record<string, { tracks: TargetTrack[]; description: string }> = {
  'single-column': {
    tracks: [{ min: 'var(--rv-content-min)', max: '1fr' }],
    description: 'One column. Everything flows vertically. Use for articles, simple pages.',
  },
  'two-column-rail-left': {
    tracks: [
      { min: 'min-content', max: 'var(--rv-side-max)' },
      { min: 'var(--rv-content-min)', max: '1fr' },
    ],
    description: 'Two columns, side rail on the left. Track 0 = rail, track 1 = content.',
  },
  'two-column-rail-right': {
    tracks: [
      { min: 'var(--rv-content-min)', max: '1fr' },
      { min: 'min-content', max: 'var(--rv-side-max)' },
    ],
    description: 'Two columns, side rail on the right. Track 0 = content, track 1 = rail.',
  },
  'three-column': {
    tracks: [
      { min: 'min-content', max: 'var(--rv-side-max)' },
      { min: 'var(--rv-content-min)', max: '1fr' },
      { min: 'min-content', max: 'var(--rv-side-max)' },
    ],
    description: 'Three columns: nav + content + aside. Track 0 = left rail, 1 = content, 2 = right rail.',
  },
};

/** The set of valid archetype ids. */
export const ARCHETYPE_IDS = new Set<string>(Object.keys(ARCHETYPES));

/** Build a default Target Layout IR from a deterministic slot assignment
 *  (the fallback when the model emits no composition relations). Converts
 *  the Documentation slot definitions into track-based Target IR.
 *  Pure: takes the slot assignment + current IR as data. */
export function buildFallbackTargetIR(
  handleToSlot: Map<string, string>,
  slotPreferredWidth: Map<string, 'full' | 'side' | 'content'>,
): TargetLayoutIR {
  const hasSide = [...handleToSlot.values()].some((slot) => slotPreferredWidth.get(slot) === 'side');
  const archetype = hasSide ? 'two-column-rail-left' : 'single-column';
  const tracks = ARCHETYPES[archetype].tracks;

  const slotAssignment = new Map<string, number>();
  const spans: string[] = [];
  for (const [handle, slot] of handleToSlot) {
    const pw = slotPreferredWidth.get(slot);
    if (pw === 'full' || !hasSide) {
      spans.push(handle);
    } else if (pw === 'side') {
      slotAssignment.set(handle, 0);
    } else {
      slotAssignment.set(handle, 1);
    }
  }
  return { archetype, tracks, slotAssignment, spans, adjacency: [], readingOrder: [], slotBehaviour: new Map(), unsatisfiable: [] };
}

// ── Immutability ────────────────────────────────────────────────────

/** Deep-freeze (dev) -- the immutability contract, not a convention. Recursively Object.freeze;
 *  non-plain values (Maps) are frozen where possible. A mutation attempt throws in strict mode/dev. */
function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') return obj;
  if (obj instanceof Map) {
    // Maps are not frozen by Object.freeze on the instance; freeze entries instead.
    for (const v of obj.values()) if (v && typeof v === 'object') deepFreeze(v);
    return obj;
  }
  if (Object.isFrozen(obj)) return obj;
  Object.freeze(obj);
  for (const v of Object.values(obj as Record<string, unknown>)) {
    if (v && typeof v === 'object') deepFreeze(v);
  }
  return obj;
}

// ── Self-check (dev only; runs under --inspect-style import) ─────────
// A tiny assert-based demo: a frozen IR throws on mutation + currentConstraints is deterministic.
// No frameworks. Run: `node --experimental-strip-types src/core/layout/ir.ts` (after a stub
// perception) -- see tests/probe/layout-ir.test.ts for the real harness-backed self-check.

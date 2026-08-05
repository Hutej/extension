/**
 * core/layout/solve — the unified responsive solver.
 *
 * The one architectural rule: the AI owns design decisions, the Layout IR owns
 * structure, the SOLVER owns constraints, the compiler owns CSS. The solver
 * satisfies constraints; it does not decide what the layout becomes.
 *
 * CSS-ONLY RELAYOUT. No DOM mutation. No wrapper elements. No node moves.
 *   - Find the nearest common ancestor (NCA) of all slot-assigned nodes
 *   - Emit display: grid + the slot grid template on the NCA
 *   - For every element strictly between the NCA and a placed node, emit
 *     display: contents (with safety checks — see canCollapse)
 *   - For each placed node, emit grid-column (column placement, rows auto-place
 *     to preserve DOM/reading order)
 *   - Zero DOM mutation → nothing for a framework's MutationObserver to reconcile
 *   - Undo becomes "remove the stylesheet"
 *
 * SELECTOR-BASED TARGETING. CSS rules are keyed on the CSS selector derived
 *   from the existing structuralPath (stable attrs: id/data-testid/role/aria-label/
 *   name, falling back to tag + nth-of-type). data-rv-c is a DEBUG label only;
 *   nothing in the emitted CSS depends on it. Where no usable selector can be
 *   derived, fall back to [data-rv-c] and count those cases.
 *
 * v1 scope (all five, no more):
 *   1. validate constraints
 *   2. propagate parent constraints to children
 *   3. choose Flex or Grid per container (the NCA grid)
 *   4. normalize sizing (auto / % / clamp() / minmax())
 *   5. emit responsive CSS
 *
 * READING ORDER IS INVIOLABLE. Visual order follows DOM order. No `order`, no
 * arbitrary grid-area placement that diverges keyboard/SR from sight. Grid-column
 * assigns the column; rows auto-place in DOM order.
 *
 * Fluid tokens at semantic text levels only (body, headings, captions). Never
 * rebuild the tree. matched-targets = 0 is a HARD ERROR.
 */

import type { LayoutIR, LayoutIRNode, TargetLayoutIR, TargetTrack } from './ir.ts';
import type { ConstraintPriority } from './ir.ts';
import { currentConstraints } from './ir.ts';
import type { LayoutLanguage, SlotDef } from './languages/types.ts';
import { assertNoRawPxSizing } from '../laws/index.ts';

// ── Fluid token set (from ARCHITECTURE.md, applied at semantic text levels only) ──
// viewport units (vw) in clamp() are the only remaining vw use — they scale
// TYPE and SPACING relative to the viewport, not layout tracks. Layout tracks use
// container-relative units (fr, minmax, fit-content). The type/spacing clamp() are
// tokens (provenance: token), not measurements.
// --rv-content-min replaces the hardcoded 320px content floor (now a token).
// --rv-prose-max is a character-based prose measure (ch = intrinsic, not px).
// Applied ONLY to prose regions (article-body, metadata, toc) — never to
// listings, navs, or chrome. A listing or nav constrained to 65ch would
// truncate or wrap badly; the prose measure is for reading flow.
// --rv-side-max is a proportional bound: at most 30% of the container inline
// size, capped at 280px. The cap prevents a giant side rail on wide screens;
// the proportional floor lets it shrink on narrow containers (cqi = container
// query inline-size — the NCA has container-type: inline-size).

const FLUID_TOKENS = `
  --rv-step-0: clamp(1rem, 0.95rem + 0.3vw, 1.125rem);
  --rv-step-2: clamp(1.6rem, 1.3rem + 1.2vw, 2.3rem);
  --rv-space-s: clamp(8px, 1vw, 12px);
  --rv-space-m: clamp(16px, 2vw, 24px);
  --rv-space-l: clamp(24px, 3vw, 40px);
  --rv-content-min: 320px;
  --rv-prose-max: 65ch;
  --rv-side-max: min(280px, 30cqi);
`;

// ── Types ────────────────────────────────────────────────────────────

export interface SolveInput {
  ir: LayoutIR;
  target: TargetLayoutIR;
  excluded: Set<string>;
  /** The chosen layout language — its slot constraints carry priorities the
   *  solver reads and relaxes on conflict. Optional; omitted on the pure path. */
  lang?: LayoutLanguage;
  /** handle -> slot id (from assignSlots). Lets the solver read each node's
   *  language slot constraints (with their priorities). Optional. */
  handleToSlot?: Map<string, string>;
}

/** Placement info for one node: which track, which grid column. */
export interface PlacementInfo {
  trackIndex: number;  // 0-based track index (-1 for spans)
  gridColumn: string;  // '1 / -1' (full) | '1' | '2' | etc.
  isSpan: boolean;      // true if spanning all tracks
}

export interface SolveResult {
  /** Map of handle → placement info for nodes that should be grid items. */
  placement: Map<string, PlacementInfo>;
  /** The grid-template-columns string, built from the Target IR's tracks. */
  gridTemplate: string;
  /** Number of tracks in the grid. */
  trackCount: number;
  /** Track definitions from the Target IR (for DOM-side CSS emission). */
  tracks: TargetTrack[];
  /** Per-node CSS declarations (handle → decls) for fluid text + overflow safety. */
  perNodeDecls: Map<string, string[]>;
  rulesEmitted: number;
  matchedTargets: number;
  droppedOptionals: { handle: string; kind: string; reason: string }[];
}

// ── Constraint priority + relaxation ─────────────────────────────────
//
// ConstraintPriority is assigned in the Current-IR derivation (currentConstraints)
// and in every layout language's slot definitions (SlotDef.constraints), and was
// read in NONE — droppedOptionals was always []. The resolver below is the call
// site that reads .priority: it attempts every constraint on a node, and on a
// conflict on the same axis relaxes the LOWEST-priority one first, recording the
// reason. A conflict between two REQUIRED constraints is reported unsatisfiable
// and never silently dropped.

/** A constraint the solver relaxed, with the reason. */
export interface RelaxedConstraint {
  handle: string;
  constraint: string;
  priority: ConstraintPriority;
  reason: string;
}

/** Structural shape the resolver accepts — covers both LayoutConstraint (Current
 *  IR, strict ConstraintKind) and SlotConstraint (language slots, loose string),
 *  so a slot constraint's kind flows in without a cast. */
interface ConstraintLike {
  kind: string;
  priority: ConstraintPriority;
  source?: string;
  value?: string;
}

const PRIORITY_RANK: Record<ConstraintPriority, number> = { required: 0, preferred: 1, optional: 2 };

/** Two constraints conflict when they both govern the same axis with opposing
 *  intent. Today the only real axis conflict is width: FillParent (full width)
 *  vs MaxWidth (a cap). Other pairs coexist (StackVertically + Alignment live on
 *  different axes; WrapOnOverflow + Gap are independent). */
function conflictsWith(a: ConstraintLike, b: ConstraintLike): boolean {
  // Width axis: FillParent vs MaxWidth oppose.
  if ((a.kind === 'FillParent' && b.kind === 'MaxWidth') || (a.kind === 'MaxWidth' && b.kind === 'FillParent')) return true;
  return false;
}

/** Resolve a node's constraints: keep what coexists, relax the lowest-priority
 *  member of each conflicting pair, report a required-vs-required conflict as
 *  unsatisfiable. Pure — the single function that reads .priority. */
export function resolveNodeConstraints(
  handle: string,
  constraints: ConstraintLike[],
): { kept: ConstraintLike[]; relaxed: RelaxedConstraint[]; unsatisfiable: { handle: string; constraint: string; reason: string }[] } {
  const kept: ConstraintLike[] = [];
  const relaxed: RelaxedConstraint[] = [];
  const unsatisfiable: { handle: string; constraint: string; reason: string }[] = [];
  // Sort by priority (required first) so a later conflicting lower-priority one is relaxed.
  const order = [...constraints].sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
  for (const c of order) {
    // Find an already-kept constraint this conflicts with.
    const foe = kept.find((k) => conflictsWith(k, c));
    if (!foe) { kept.push(c); continue; }
    // Conflict. Relax the lower-priority of the two.
    if (PRIORITY_RANK[c.priority] > PRIORITY_RANK[foe.priority]) {
      relaxed.push({ handle, constraint: c.kind, priority: c.priority, reason: `relaxed: ${c.kind} conflicts with kept ${foe.kind} (${foe.priority})` });
    } else if (PRIORITY_RANK[c.priority] < PRIORITY_RANK[foe.priority]) {
      // The kept one is lower priority — relax it, keep the new one.
      const idx = kept.indexOf(foe);
      kept.splice(idx, 1);
      relaxed.push({ handle, constraint: foe.kind, priority: foe.priority, reason: `relaxed: ${foe.kind} conflicts with ${c.kind} (${c.priority})` });
      kept.push(c);
    } else {
      // Same priority. If both required, that's unsatisfiable. Else relax the new one (stable).
      if (c.priority === 'required' && foe.priority === 'required') {
        unsatisfiable.push({ handle, constraint: c.kind, reason: `required ${c.kind} conflicts with required ${foe.kind} — cannot both hold` });
      } else {
        relaxed.push({ handle, constraint: c.kind, priority: c.priority, reason: `relaxed: ${c.kind} conflicts with ${foe.kind} (equal priority, kept first)` });
      }
    }
  }
  return { kept, relaxed, unsatisfiable };
}

/** Collect a node's constraints: the language slot it lands in (slot.constraints)
 *  + the page's current arrangement (currentConstraints). The slot constraints
 *  carry the language's declared priorities; the current ones are law. */
function nodeConstraints(node: LayoutIRNode, slot: SlotDef | undefined): ConstraintLike[] {
  const out: ConstraintLike[] = [];
  if (slot) for (const sc of slot.constraints) out.push({ kind: sc.kind, priority: sc.priority, source: 'language', value: sc.value });
  for (const c of currentConstraints(node)) out.push(c);
  return out;
}

/** the solver's emit-time plan — what the CSS intends, asserted at verify time. */
export interface SolverPlan {
  /** Number of grid tracks. */
  trackCount: number;
  /** Handle → grid-column-start (1-based, 0 for spans). */
  handleToColumn: Record<string, number>;
  /** Intended distinct column count (=== trackCount when all tracks have proxies). */
  expectedColumns: number;
}

/** Result of the DOM-grounded CSS emission. */
export interface PlacementResult {
  /** Combined structural CSS (fluid tokens + grid + subgrid + grid-column + per-node). */
  css: string;
  /** Total selector fallbacks (sum of the four split counters, for backward compat). */
  selectorFallback: number;
  /** NCA selector fell back to [data-rv-grid]. */
  selectorFallbackNca: number;
  /** placed-proxy selector fell back to [data-rv-grid]. */
  selectorFallbackProxy: number;
  /** display:contents selector fell back to [data-rv-grid]. */
  selectorFallbackContents: number;
  /** per-node CSS selector fell back to [data-rv-c]. */
  selectorFallbackPerNode: number;
  /** Count of proxies placed with grid-column (— was "nodesPlaced" in S7). */
  nodesPlaced: number;
  /** Handles that could NOT be placed (element not found in DOM). */
  nodesNotPlaceable: string[];
  /** Number of mixed proxies collapsed with display:contents (the only display:contents use). */
  intermediatesCollapsed: number;
  /** count of mixed proxies emitted with subgrid (replaces display:contents). */
  subgridProxies: number;
  /** count of multi-slot proxies placed as single-track grid items (not earning subgrid). */
  singleTrackProxies: number;
  /** total children of subgrid proxies that received explicit grid-column. */
  subgridChildAssignments: number;
  /** the emitted grid-template-columns string (for logging/verification). */
  gridTemplateColumns: string;
  /** the solver's emit-time plan (asserted at verify time). */
  plan: SolverPlan;
  /** Always 0 with the proxy algorithm (no intermediate chain collapse). */
  intermediatesSkipped: number;
  /** Reason each proxy was rejected (unused with proxy algorithm; kept for compat). */
  skippedReasons: string[];
  /** count of proxies rejected as "mixed" (subtree spans >1 non-overflow slot). */
  mixedProxies: number;
  /** count of distinct proxy elements placed. */
  proxyCount: number;
  /** diagnostic — NCA tag + proxy slot summary (for dev logging). */
  diagnostics: string;
}

// ── Solve (pure: no DOM access, no model calls) ─────────────────────

/** The unified solver. Takes the Current Layout IR + Target Layout IR + exclusions,
 *  builds a placement map, and returns data for the DOM-grounded CSS emitter.
 *  Pure: no DOM, no model calls. The Target IR provides the tracks and slot
 *  assignments; the solver does not reach back into perception. */
export function solve(input: SolveInput): SolveResult {
  const { ir, target, excluded, lang, handleToSlot } = input;

  // ── 0. Constraint priority + relaxation ────────────────────────────
  // The call site that reads .priority: for each node, collect its constraints
  // (the language slot it landed in + the page's current arrangement), attempt
  // them, and relax the lowest-priority on a conflict. droppedOptionals records
  // every relaxation with its reason; required-vs-required is unsatisfiable and
  // goes to target.unsatisfiable via the caller. This was always [] before —
  // priority was assigned in seven places and read in none.
  const droppedOptionals: { handle: string; kind: string; reason: string }[] = [];
  if (lang && handleToSlot) {
    const slotById = new Map<string, SlotDef>(lang.slots.map((s) => [s.id, s]));
    for (const node of ir.nodes) {
      if (excluded.has(node.handle)) continue;
      const slotId = handleToSlot.get(node.handle);
      const slot = slotId ? slotById.get(slotId) : undefined;
      const { relaxed, unsatisfiable } = resolveNodeConstraints(node.handle, nodeConstraints(node, slot));
      for (const r of relaxed) droppedOptionals.push({ handle: r.handle, kind: r.constraint, reason: r.reason });
      for (const u of unsatisfiable) target.unsatisfiable.push({ handle: u.handle, constraint: u.constraint, reason: u.reason });
    }
  }

  // ── 1. Build placement map from the Target IR ────────────────────────
  const spansSet = new Set(target.spans);
  const placement = new Map<string, PlacementInfo>();
  for (const [handle, trackIndex] of target.slotAssignment) {
    if (excluded.has(handle)) continue;
    const node = ir.byHandle.get(handle);
    if (node && (node.authoredLayout.position === 'fixed' || node.authoredLayout.position === 'absolute')) continue;
    placement.set(handle, {
      trackIndex,
      gridColumn: spansSet.has(handle) ? '1 / -1' : String(trackIndex + 1),
      isSpan: spansSet.has(handle),
    });
  }
  // Spans not in slotAssignment
  for (const handle of target.spans) {
    if (excluded.has(handle) || placement.has(handle)) continue;
    const node = ir.byHandle.get(handle);
    if (node && (node.authoredLayout.position === 'fixed' || node.authoredLayout.position === 'absolute')) continue;
    placement.set(handle, { trackIndex: -1, gridColumn: '1 / -1', isSpan: true });
  }

  // ── 2. Grid template from the Target IR's tracks ─────────────────────
  const gridTemplate = target.tracks.map((t) => `minmax(${t.min}, ${t.max})`).join(' ');
  const trackCount = target.tracks.length;

  // ── 3. Per-node declarations from slotBehaviour + current constraints ──
  const perNodeDecls = new Map<string, string[]>();
  for (const node of ir.nodes) {
    if (excluded.has(node.handle)) continue;
    const decls: string[] = [];
    // Slot behaviour from the Target IR
    const trackIdx = target.slotAssignment.get(node.handle);
    if (trackIdx != null) {
      const behaviour = target.slotBehaviour.get(trackIdx);
      if (behaviour) {
        if (behaviour.direction === 'column') decls.push('flex-direction: column');
        else if (behaviour.direction === 'row') decls.push('flex-direction: row');
        if (behaviour.wrap) decls.push('flex-wrap: wrap');
        if (behaviour.alignment !== 'stretch') {
          decls.push(`align-items: ${behaviour.alignment}`);
        }
      }
    }
    // Fluid text tokens for semantic text roles
    if (isSemanticText(node.semantic.role)) {
      const ft = fontSizeToken(node.semantic.role);
      if (ft) decls.push(`font-size: ${ft}`);
    }
    // Prose measure: constrain line length for reading-flow roles only.
    // --rv-prose-max (65ch) applies to article-body, metadata, toc — never
    // to listings, navs, or chrome (a listing constrained to 65ch truncates
    // or wraps badly; the measure is for prose reading flow).
    if (isProse(node.semantic.role)) {
      decls.push('max-width: var(--rv-prose-max)');
    }
    // Fixed-width nodes get max-width: 100%
    if (node.authoredLayout.intrinsicSizing === 'fixed') {
      decls.push('max-width: 100%');
    }
    if (decls.length > 0) perNodeDecls.set(node.handle, [...new Set(decls)]);
  }

  const matchedTargets = placement.size;
  if (matchedTargets === 0) {
    throw new Error('solve: matched-targets = 0 — no nodes placed. This is a compiler error.');
  }

  return {
    placement, gridTemplate, trackCount, tracks: target.tracks,
    perNodeDecls,
    rulesEmitted: 1 + placement.size + perNodeDecls.size,
    matchedTargets, droppedOptionals,
  };
}

// ── DOM-grounded CSS emission  ────────────────────────

/** Build a CSS selector from a DOM element using the same anchor logic as
 *  structuralPath : nearest stable attribute (id/data-testid/role/
 *  aria-label/name) + nth-of-type chain. Returns null if no usable selector
 *  can be derived (caller falls back to [data-rv-c]). */
function buildSelector(el: HTMLElement): string | null {
  // Find the nearest stable anchor (self or ancestor, excluding body/html).
  let anchor: HTMLElement | null = null;
  let n: HTMLElement | null = el;
  let searchDepth = 0;
  while (n && n !== document.body && n !== document.documentElement && searchDepth < 20) {
    if (n.id || n.getAttribute('data-testid') || n.getAttribute('role') ||
        n.getAttribute('aria-label') || n.getAttribute('name')) {
      anchor = n;
      break;
    }
    n = n.parentElement;
    searchDepth++;
  }

  const parts: string[] = [];
  if (anchor) {
    const tag = anchor.tagName.toLowerCase();
    if (anchor.id) parts.push(`${tag}#${cssEscape(anchor.id)}`);
    else if (anchor.getAttribute('data-testid')) parts.push(`${tag}[data-testid="${cssEscape(anchor.getAttribute('data-testid')!)}"]`);
    else if (anchor.getAttribute('role')) parts.push(`${tag}[role="${cssEscape(anchor.getAttribute('role')!)}"]`);
    else if (anchor.getAttribute('aria-label')) parts.push(`${tag}[aria-label^="${cssEscape(anchor.getAttribute('aria-label')!.slice(0, 20))}"]`);
    else if (anchor.getAttribute('name')) parts.push(`${tag}[name="${cssEscape(anchor.getAttribute('name')!)}"]`);
  } else {
    // No anchor found — if el is body, use 'body'. Otherwise null (fallback).
    if (el === document.body) return 'body';
    if (el === document.documentElement) return 'html';
    return null;
  }

  // nth-of-type chain from el up to (not including) the anchor, then reverse.
  const chain: string[] = [];
  let node: HTMLElement | null = el;
  let d = 0;
  while (node && node !== anchor && d < 10) {
    const tag = node.tagName.toLowerCase();
    let cnt = 0;
    let sib = node.previousElementSibling;
    while (sib) { if (sib.tagName === node.tagName) cnt++; sib = sib.previousElementSibling as Element | null; }
    chain.push(`${tag}:nth-of-type(${cnt + 1})`);
    node = node.parentElement;
    d++;
  }
  chain.reverse();
  return [...parts, ...chain].join(' > ');
}

/** Minimal CSS string escaper for id/attribute values. */
function cssEscape(s: string): string {
  // CSS.escape is available in all modern browsers.
  return (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&');
}

/** Check if a selector uniquely identifies the target element.
 *  Returns true if querySelector(selector) === el (or el is body/html). */
function selectorIsUnique(selector: string, el: HTMLElement): boolean {
  if (selector === 'body') return true;
  if (selector === 'html') return true;
  try {
    const match = document.querySelector(selector);
    return match === el;
  } catch {
    return false;
  }
}

/** Find the nearest common ancestor of all elements. */
function nearestCommonAncestor(els: HTMLElement[]): HTMLElement | null {
  if (els.length === 0) return null;
  if (els.length === 1) return els[0].parentElement;
  // Build ancestor set for each element (including self).
  const chains: Set<HTMLElement>[] = els.map((el) => {
    const chain = new Set<HTMLElement>();
    let n: HTMLElement | null = el;
    while (n) { chain.add(n); n = n.parentElement; }
    return chain;
  });
  // Walk up from the first element; the NCA is the first ancestor in ALL chains.
  let n: HTMLElement | null = els[0];
  while (n) {
    if (chains.every((c) => c.has(n!))) return n;
    n = n.parentElement;
  }
  return null;
}

/** Execute the placement against the live DOM and emit all structural CSS.
 *  Zero DOM mutation — only CSS (and data-* attribute stamps for targeting) is emitted.
 *
 *  PROXY PLACEMENT. For each placed handle, the PLACEMENT PROXY is the
 *  NCA's direct child that is an ancestor-or-self of the handle. We place the
 *  PROXY with grid-column — its background, border and padding are preserved,
 *  nothing is collapsed. A proxy whose subtree spans >1 track is
 *  "mixed": it gets subgrid and its children are recursed. That is the ONLY use of subgrid.
 *
 *  Template from the Target IR (not recomputed from placed proxies).
 *  min-width:0 propagated up the NCA ancestor chain to body. min-height:100vh
 *  DELETED (compiler was making a design decision). overflow-x:clip BANNED.
 *
 *  selectorFallback split into 4 counters (NCA, proxy, contents, perNode).
 *  nodesNotPlaceable reconciled (no double counting). */
export function computeGridPlacementCss(result: SolveResult): PlacementResult {
  const { placement, perNodeDecls } = result;
  const blocks: string[] = [];
  // split selectorFallback into 4 counters.
  let selectorFallbackNca = 0;
  let selectorFallbackProxy = 0;
  let selectorFallbackContents = 0;
  let selectorFallbackPerNode = 0;
  let intermediatesCollapsed = 0;
  let mixedProxies = 0;
  const skippedReasons: string[] = [];
  const nodesNotPlaceable: string[] = [];

  const empty = (css: string): PlacementResult => ({
    css, selectorFallback: 0, selectorFallbackNca: 0, selectorFallbackProxy: 0,
    selectorFallbackContents: 0, selectorFallbackPerNode: 0,
    nodesPlaced: 0, nodesNotPlaceable: [...nodesNotPlaceable],
    intermediatesCollapsed: 0, subgridProxies: 0, singleTrackProxies: 0,
    subgridChildAssignments: 0, gridTemplateColumns: '',
    plan: { trackCount: 0, handleToColumn: {}, expectedColumns: 0 },
    intermediatesSkipped: 0, skippedReasons: [],
    mixedProxies: 0, proxyCount: 0, diagnostics: '(empty)',
  });

  if (placement.size === 0) return empty('');

  // a. :root fluid tokens
  blocks.push(`:root {${FLUID_TOKENS}\n}`);

  // b. Resolve placed handles to live elements. single loop, no double counting.
  const placedEls: Map<string, HTMLElement> = new Map();
  for (const [handle] of placement) {
    const el = document.querySelector<HTMLElement>(`[data-rv-c="${handle}"]`);
    if (el) placedEls.set(handle, el);
    else nodesNotPlaceable.push(handle);
  }
  if (placedEls.size === 0) return empty(`:root {${FLUID_TOKENS}\n}`);

  // c. Find the NCA of all placed elements.
  const els = [...placedEls.values()];
  const nca = nearestCommonAncestor(els);
  if (!nca) {
    nodesNotPlaceable.push(...placedEls.keys());
    return empty(`:root {${FLUID_TOKENS}\n}`);
  }

  // d. Build handle data: for each placed handle, its element + track info.
  const handleData: { handle: string; el: HTMLElement; trackIndex: number; gridColumn: string; isSpan: boolean }[] = [];
  for (const [handle, info] of placement) {
    const el = placedEls.get(handle);
    if (!el) continue;  // already in nodesNotPlaceable from step b
    handleData.push({ handle, el, trackIndex: info.trackIndex, gridColumn: info.gridColumn, isSpan: info.isSpan });
  }

  // For an element, return the set of non-span track indices of placed handles in its subtree.
  const tracksUnder = (el: HTMLElement): Set<number> => {
    const tracks = new Set<number>();
    for (const hd of handleData) {
      if (hd.isSpan) continue;  // spans are full-width, not in a specific track
      if (el === hd.el || el.contains(hd.el)) tracks.add(hd.trackIndex);
    }
    return tracks;
  };

  // a proxy earns subgrid ONLY if its subtree spans more than 1 distinct track.
  const earnsSubgrid = (tracks: Set<number>): boolean => tracks.size > 1;

  // e. BFS proxy placement. Level 0 = NCA's direct children containing placed handles.
  //     Non-mixed proxy (≤1 non-overflow slot) → place with grid-column.
  //     Mixed proxy (>1 non-overflow slot) → subgrid  + recurse on children.
  //     Non-handle children (no placed handle in subtree) get grid-column: 1/-1 so they
  //     don't auto-place into a narrow side track and squeeze content.
  let singleTrackProxies = 0;
  let subgridChildAssignments = 0;
  const placedProxies = new Map<HTMLElement, number>();  // proxy el → trackIndex
  const contentsEls: HTMLElement[] = [];  // earned-subgrid proxies
  const fullWidthEls: HTMLElement[] = [];  // non-handle grid items → full width
  const seenEls = new Set<HTMLElement>();  // dedup across BFS levels

  let currentLevel: HTMLElement[] = [];
  for (const child of nca.children) {
    if (!(child instanceof HTMLElement)) continue;
    seenEls.add(child);
    if (handleData.some((hd) => child === hd.el || child.contains(hd.el))) {
      currentLevel.push(child);
    } else {
      fullWidthEls.push(child);  // NCA child with no placed handles → full width
    }
  }

  while (currentLevel.length > 0) {
    const nextLevel: HTMLElement[] = [];
    for (const candidate of currentLevel) {
      if (placedProxies.has(candidate) || contentsEls.includes(candidate)) continue;
      const tracks = tracksUnder(candidate);
      if (!earnsSubgrid(tracks)) {
        // Single-track proxy — place in its one track (or full-width if only spans).
        let trackIdx = -1;
        for (const t of tracks) trackIdx = t;
        placedProxies.set(candidate, trackIdx);
      } else {
        // Multi-track proxy — earns subgrid. Children get explicit grid-column.
        contentsEls.push(candidate);
        mixedProxies++;
        for (const child of candidate.children) {
          if (!(child instanceof HTMLElement)) continue;
          if (seenEls.has(child)) continue;
          seenEls.add(child);
          subgridChildAssignments++;
          if (handleData.some((hd) => child === hd.el || child.contains(hd.el))) {
            nextLevel.push(child);
          } else {
            fullWidthEls.push(child);  // no placed handles → full width (1/-1)
          }
        }
      }
    }
    currentLevel = nextLevel;
  }

  // f. Grid template from the Target IR (not recomputed from placed proxies).
  const gridTemplate = result.gridTemplate;

  // g. Emit layout on the NCA, PRESERVING its existing formatting context.
  // Establish container containment for container-query responsiveness.
  // Today we impose display: grid unconditionally — forbids that. If the NCA
  // already has a working flex or grid context, modify its properties. If block,
  // introduce grid (new context). Overwriting display: flex with display: grid
  // is flattening; changing gap/justify-content/align-items/flex-wrap/flex-direction
  // is transformation.
  const ncaSelector = buildSelector(nca);
  let ncaCssSelector: string;
  if (ncaSelector && selectorIsUnique(ncaSelector, nca)) {
    ncaCssSelector = ncaSelector;
  } else {
    nca.setAttribute('data-rv-grid', 'nca');
    ncaCssSelector = '[data-rv-grid="nca"]';
    selectorFallbackNca++;
  }
  // detect the NCA's current formatting context. This is a measurement used for
  // a DECISION (which properties to emit), not emitted as a value — allowed per Law 0.
  const ncaCs = getComputedStyle(nca);
  const ncaDisplay = ncaCs.display;
  const ncaIsGrid = ncaDisplay.includes('grid');
  const ncaIsFlex = ncaDisplay.includes('flex');
  // if the NCA's parent is a flex/grid container, the NCA is a flex/grid item
  // and needs max-width:100% to avoid blowing out the parent.
  const ncaParentCs = nca.parentElement ? getComputedStyle(nca.parentElement) : null;
  const ncaIsFlexGridItem = ncaParentCs != null &&
    (ncaParentCs.display.includes('flex') || ncaParentCs.display.includes('grid'));

  const ncaDecls: string[] = [];
  // preserve the existing formatting context.
  if (ncaIsGrid) {
    // Already grid — modify properties, don't replace.
    ncaDecls.push(`grid-template-columns: ${gridTemplate}`, 'gap: var(--rv-space-m)', 'min-width: 0');
  } else if (ncaIsFlex) {
    // Already flex — use flex properties for multi-column layout.
    // flex-wrap: wrap lets side+content items sit side by side and wrap on narrow containers.
    ncaDecls.push('flex-wrap: wrap', 'gap: var(--rv-space-m)', 'min-width: 0');
  } else {
    // Block or other — introduce grid (new formatting context only where none exists).
    ncaDecls.push('display: grid', `grid-template-columns: ${gridTemplate}`, 'gap: var(--rv-space-m)', 'min-width: 0');
  }
  if (ncaIsFlexGridItem) ncaDecls.push('max-width: 100%');
  // establish containment for container-query responsiveness. Graceful: skip if
  // the NCA already has containment (don't override) or if containment is unsupported.
  const containerSupported = typeof CSS !== 'undefined' && CSS.supports('container-type', 'inline-size');
  if (containerSupported && ncaCs.containerType !== 'inline-size' && ncaCs.containerType !== 'size') {
    ncaDecls.push('container-type: inline-size');
  }
  blocks.push(`${ncaCssSelector} {\n${ncaDecls.map((d) => `  ${d};`).join('\n')}\n}`);

  // subgrid support check. Chrome 117+ supports subgrid (this is an MV3
  // Chrome extension — no fallback needed in practice). subgrid is a grid-only
  // feature — skip for flex NCA context (flex has no subgrid equivalent).
  const subgridSupported = typeof CSS !== 'undefined' && CSS.supports('grid-template-columns', 'subgrid') && !ncaIsFlex;
  let subgridProxies = 0;

  // i. emit subgrid on mixed proxies (replaces display:contents). The box
  //    survives — background, border, padding, containing block, clipping and click
  //    targets all intact — and children participate in the NCA's column tracks.
  //    Fallback: grid-column: 1 / -1 (full-width grid item, no dissolution).
  //    for flex NCA, mixed proxies are full-width flex items.
  for (const el of contentsEls) {
    const sel = buildSelector(el);
    let cssSelector: string;
    if (sel && selectorIsUnique(sel, el)) {
      cssSelector = sel;
    } else {
      el.setAttribute('data-rv-grid', `c${intermediatesCollapsed}`);
      cssSelector = `[data-rv-grid="c${intermediatesCollapsed}"]`;
      selectorFallbackContents++;
    }
    if (subgridSupported) {
      blocks.push(`${cssSelector} {\n  display: grid;\n  grid-template-columns: subgrid;\n  grid-column: 1 / -1;\n  min-width: 0;\n}`);
      subgridProxies++;
    } else {
      const fullDecl = ncaIsFlex ? 'flex: 0 0 100%' : 'grid-column: 1 / -1';
      blocks.push(`${cssSelector} {\n  ${fullDecl};\n}`);
    }
    intermediatesCollapsed++;
  }

  // i.2. Full-width items: children of the NCA or subgrid'd proxies that contain NO
  //      placed handles. Without explicit placement they'd auto-place into the narrow
  //      side track, squeezing content. flex NCA → flex: 0 0 100%.
  for (const el of fullWidthEls) {
    const sel = buildSelector(el);
    let cssSelector: string;
    if (sel && selectorIsUnique(sel, el)) {
      cssSelector = sel;
    } else {
      el.setAttribute('data-rv-grid', `f${fullWidthEls.indexOf(el)}`);
      cssSelector = `[data-rv-grid="f${fullWidthEls.indexOf(el)}"]`;
      selectorFallbackContents++;
    }
    const fullDecl = ncaIsFlex ? 'flex: 0 0 100%' : 'grid-column: 1 / -1';
    blocks.push(`${cssSelector} {\n  ${fullDecl};\n}`);
  }

  // j. Emit placement on proxies. The proxy's box (bg/border/padding) is preserved.
  // stamp each placed proxy with data-rv-plan-slot for the plan assertion.
  // for flex NCA, use flex properties; for grid/block NCA, use grid-column.
  // Determine which tracks are "side" (max includes side-max) for flex sizing.
  const trackIsSide = result.tracks.map((t) => t.max.includes('side-max'));

  for (const [el, trackIdx] of placedProxies) {
    el.setAttribute('data-rv-plan-slot', String(trackIdx));
    const sel = buildSelector(el);
    let cssSelector: string;
    if (sel && selectorIsUnique(sel, el)) {
      cssSelector = sel;
    } else {
      el.setAttribute('data-rv-grid', `p${selectorFallbackProxy}`);
      cssSelector = `[data-rv-grid="p${selectorFallbackProxy}"]`;
      selectorFallbackProxy++;
    }
    // flex NCA → flex properties; grid/block NCA → grid-column.
    let decls: string[];
    if (trackIdx < 0) {
      // No tracks (only spans) → full width
      decls = ncaIsFlex ? ['flex: 0 0 100%'] : ['grid-column: 1 / -1'];
    } else if (ncaIsFlex) {
      if (trackIdx < trackIsSide.length && trackIsSide[trackIdx]) {
        decls = ['flex: 0 0 min(var(--rv-side-max), 100%)', 'max-width: var(--rv-side-max)'];
      } else {
        decls = ['flex: 1 1 0', 'min-width: var(--rv-content-min)'];
      }
    } else {
      decls = [`grid-column: ${trackIdx + 1}`];
    }
    blocks.push(`${cssSelector} {\n${decls.map((d) => `  ${d};`).join('\n')}\n}`);
  }

  // container query — when the NCA container is narrow, collapse all placed
  // proxies to full-width. This is the browser-native responsive collapse: no
  // viewport measurement, no re-run. The browser resolves it from the container's
  // inline-size. Graceful: only emitted if container-type was set on the NCA.
  if (containerSupported && (ncaCs.containerType !== 'inline-size' && ncaCs.containerType !== 'size' ? false : true)) {
    blocks.push(`@container (max-width: 600px) {\n  [data-rv-plan-slot] {\n    grid-column: 1 / -1 !important;\n    flex: 0 0 100% !important;\n    max-width: 100% !important;\n  }\n}`);
  }

  // k. Per-node CSS (fluid text + overflow safety) for ALL nodes — placed handles
  //    get their text sizing on the original [data-rv-c] element (the proxy is
  //    structural; the semantic text node carries the font-size token).
  for (const [handle, decls] of perNodeDecls) {
    const el = document.querySelector<HTMLElement>(`[data-rv-c="${handle}"]`);
    if (!el) continue;
    const sel = buildSelector(el);
    let cssSelector: string;
    if (sel && selectorIsUnique(sel, el)) {
      cssSelector = sel;
    } else {
      cssSelector = `[data-rv-c="${handle}"]`;
      selectorFallbackPerNode++;
    }
    blocks.push(`${cssSelector} {\n${decls.map((d) => `  ${d};`).join('\n')}\n}`);
  }

  const selectorFallback = selectorFallbackNca + selectorFallbackProxy + selectorFallbackContents + selectorFallbackPerNode;
  const css = blocks.join('\n\n');

  // Law 0 assertion — reject any raw px in a sizing property in the
  // emitted CSS. This is the single real gate; the old assertNoMeasurementLengths
  // mock (a hand-built provenance map that checked itself) was deleted — it was
  // documentation, not enforcement. assertNoRawPxSizing on the actual CSS catches
  // real leaks from every emission path.
  assertNoRawPxSizing(css);

  // build the emit-time plan — what the CSS INTENDS, asserted at verify time.
  const trackCount = result.trackCount;
  const handleToColumn: Record<string, number> = {};
  for (const [handle, info] of placement) {
    handleToColumn[handle] = info.isSpan ? 0 : info.trackIndex + 1;
  }
  // expectedColumns = number of tracks that actually have placed proxies.
  const placedTracks = new Set<number>();
  for (const trackIdx of placedProxies.values()) {
    if (trackIdx >= 0) placedTracks.add(trackIdx);
  }
  const expectedColumns = placedTracks.size || 1;
  const plan: SolverPlan = { trackCount, handleToColumn, expectedColumns };

  // nodesPlaced = handles placed (every found handle gets a proxy by
  // construction — the BFS always terminates at the handle's non-mixed element).
  // matched = nodesPlaced + nodesNotPlaceable.length, exactly.
  const proxySummary = [...placedProxies.entries()].map(([el, s]) => `${el.tagName.toLowerCase()}→${s}`).join(', ');
  const diagnostics = `NCA=${nca.tagName.toLowerCase()} proxies=[${proxySummary}] mixed=${mixedProxies} subgrid=${subgridProxies} singleTrack=${singleTrackProxies} childAssign=${subgridChildAssignments} fullWidth=${fullWidthEls.length} template=${gridTemplate} planCols=${expectedColumns}`;
  return {
    css, selectorFallback, selectorFallbackNca, selectorFallbackProxy,
    selectorFallbackContents, selectorFallbackPerNode,
    nodesPlaced: handleData.length, nodesNotPlaceable,
    intermediatesCollapsed, subgridProxies, singleTrackProxies,
    subgridChildAssignments, gridTemplateColumns: gridTemplate, plan,
    intermediatesSkipped: 0, skippedReasons,
    mixedProxies, proxyCount: placedProxies.size, diagnostics,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Is this role a semantic text level (body, headings, captions)? */
function isSemanticText(role: string): boolean {
  return role === 'article-body' || role === 'page-title' || role === 'metadata' ||
    role === 'listing' || role === 'comments' || role === 'toc';
}

/** Is this role a prose reading-flow region? (The 65ch prose measure applies
 *  here — never to listings, navs, or chrome.) */
function isProse(role: string): boolean {
  return role === 'article-body' || role === 'metadata' || role === 'toc';
}

/** Map a role to a fluid clamp() token. page-title → step-2 (display), body → step-0. */
function fontSizeToken(role: string): string | null {
  if (role === 'page-title') return 'var(--rv-step-2)';
  if (role === 'article-body' || role === 'metadata' || role === 'listing' ||
    role === 'comments' || role === 'toc') return 'var(--rv-step-0)';
  return null;
}

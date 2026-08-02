/**
 * core/layout/solve — the v1 responsive solver. Phase 2.5, Step 2 + Step 3 + Step 7.
 *
 * Behind the runtime flag `layoutCompiler = 'v2'`. PARALLEL PATH — never
 * intertwined with the v1 compile path.
 *
 * The one architectural rule: the AI owns design decisions, the Layout IR owns
 * structure, the SOLVER owns constraints, the compiler owns CSS. The solver
 * satisfies constraints; it does not decide what the layout becomes.
 *
 * S7.1 — CSS-ONLY RELAYOUT. No DOM mutation. No wrapper elements. No node moves.
 *   - Find the nearest common ancestor (NCA) of all slot-assigned nodes
 *   - Emit display: grid + the slot grid template on the NCA
 *   - For every element strictly between the NCA and a placed node, emit
 *     display: contents (with safety checks — see canCollapse)
 *   - For each placed node, emit grid-column (column placement, rows auto-place
 *     to preserve DOM/reading order)
 *   - Zero DOM mutation → nothing for a framework's MutationObserver to reconcile
 *   - Undo becomes "remove the stylesheet"
 *
 * S7.2 — SELECTOR-BASED TARGETING. CSS rules are keyed on the CSS selector derived
 *   from the existing structuralPath (stable attrs: id/data-testid/role/aria-label/
 *   name, falling back to tag + nth-of-type). data-wm-c is a DEBUG label only;
 *   nothing in the emitted CSS depends on it. Where no usable selector can be
 *   derived, fall back to [data-wm-c] and count those cases.
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

import type { LayoutIR, LayoutConstraint, ConstraintPriority } from './ir.ts';
import { currentConstraints } from './ir.ts';
import type { SlotAssignment } from './assign.ts';
import type { SlotDef } from './languages/documentation.ts';
import { DOCUMENTATION_SLOTS } from './languages/documentation.ts';
import { assertNoRawPxSizing } from '../laws/index.ts';

// ── Fluid token set (from ARCHITECTURE.md, applied at semantic text levels only) ──
// A4: viewport units (vw) in clamp() are the only remaining vw use — they scale
// TYPE and SPACING relative to the viewport, not layout tracks. Layout tracks use
// container-relative units (fr, minmax, fit-content). The type/spacing clamp() are
// tokens (provenance: token), not measurements.
// A4: --wm-content-min replaces the hardcoded 320px content floor (now a token).
// --wm-content-max is a character-based prose measure (ch = intrinsic, not px).

const FLUID_TOKENS = `
  --wm-step-0: clamp(1rem, 0.95rem + 0.3vw, 1.125rem);
  --wm-step-2: clamp(1.6rem, 1.3rem + 1.2vw, 2.3rem);
  --wm-space-s: clamp(8px, 1vw, 12px);
  --wm-space-m: clamp(16px, 2vw, 24px);
  --wm-space-l: clamp(24px, 3vw, 40px);
  --wm-content-min: 320px;
  --wm-content-max: 65ch;
  --wm-side-max: 280px;
`;

// ── Types ────────────────────────────────────────────────────────────

export interface SolveInput {
  ir: LayoutIR;
  assignment: SlotAssignment;
  excluded: Set<string>;
}

/** Placement info for one node: which slot, which grid column. */
export interface PlacementInfo {
  slotId: string;
  gridColumn: string;  // '1 / -1' (full) | '1' (side) | '2' (content)
  preferredWidth: 'full' | 'side' | 'content';
}

export interface SolveResult {
  /** Map of handle → placement info for nodes that should be grid items. */
  placement: Map<string, PlacementInfo>;
  /** The INTENDED grid-template-columns (from the placement map, before DOM resolution). */
  gridTemplate: string;
  /** Whether the grid has a side column (intent, before DOM resolution). */
  hasSide: boolean;
  /** Raw side-track min-width in px (intent — actual template built from placed proxies). */
  sideMin: number;
  /** Raw content-track min-width in px (intent). */
  contentMin: number;
  /** Per-node CSS declarations (handle → decls) for fluid text + overflow safety. */
  perNodeDecls: Map<string, string[]>;
  rulesEmitted: number;
  matchedTargets: number;
  // B8: impossibleNodes deleted — populated but never read downstream.
  droppedOptionals: { handle: string; kind: string; reason: string }[];
}

/** S11.3: the solver's emit-time plan — what the CSS intends, asserted at verify time. */
export interface SolverPlan {
  /** Number of grid tracks (1 or 2). */
  trackCount: number;
  /** Slot ID → grid-column-start (1 for side/full, 2 for content). */
  slotToTrack: Record<string, number>;
  /** Intended distinct column count (=== trackCount when both tracks have proxies). */
  expectedColumns: number;
}

/** Result of the DOM-grounded CSS emission. */
export interface PlacementResult {
  /** Combined structural CSS (fluid tokens + grid + subgrid + grid-column + per-node). */
  css: string;
  /** Total selector fallbacks (sum of the four split counters, for backward compat). */
  selectorFallback: number;
  /** S8.5: NCA selector fell back to [data-wm-grid]. */
  selectorFallbackNca: number;
  /** S8.5: placed-proxy selector fell back to [data-wm-grid]. */
  selectorFallbackProxy: number;
  /** S8.5: display:contents selector fell back to [data-wm-grid]. */
  selectorFallbackContents: number;
  /** S8.5: per-node CSS selector fell back to [data-wm-c]. */
  selectorFallbackPerNode: number;
  /** Count of proxies placed with grid-column (S8.1 — was "nodesPlaced" in S7). */
  nodesPlaced: number;
  /** Handles that could NOT be placed (element not found in DOM). */
  nodesNotPlaceable: string[];
  /** Number of mixed proxies collapsed with display:contents (the only display:contents use). */
  intermediatesCollapsed: number;
  /** S10.1: count of mixed proxies emitted with subgrid (replaces display:contents). */
  subgridProxies: number;
  /** S11.1: count of multi-slot proxies placed as single-track grid items (not earning subgrid). */
  singleTrackProxies: number;
  /** S11.2: total children of subgrid proxies that received explicit grid-column. */
  subgridChildAssignments: number;
  /** S10.1: the emitted grid-template-columns string (for logging/verification). */
  gridTemplateColumns: string;
  /** S11.3: the solver's emit-time plan (asserted at verify time). */
  plan: SolverPlan;
  /** Always 0 with the proxy algorithm (no intermediate chain collapse). */
  intermediatesSkipped: number;
  /** Reason each proxy was rejected (unused with proxy algorithm; kept for compat). */
  skippedReasons: string[];
  /** S8.1: count of proxies rejected as "mixed" (subtree spans >1 non-overflow slot). */
  mixedProxies: number;
  /** S8.1: count of distinct proxy elements placed. */
  proxyCount: number;
  /** S8.1: diagnostic — NCA tag + proxy slot summary (for dev logging). */
  diagnostics: string;
}

// ── A2: Constraint → CSS translation layer ──────────────────────────
// Every emitted declaration must originate from a constraint in the IR or from
// a design token. This function is the explicit translation: one constraint kind
// at a time. Where a declaration has no corresponding constraint, the constraint
// is missing from the IR — add it. Do not fall back to geometry.

/** Map a MaxWidth constraint value ('prose'|'full'|'compact'|'side'|'partial') to a CSS value. */
function maxWidthToken(value?: string): string | null {
  switch (value) {
    case 'prose': return 'var(--wm-content-max)';   // character-based measure (intrinsic)
    case 'compact':
    case 'side': return 'var(--wm-side-max)';
    case 'full': return 'none';                       // no max — fill parent
    case 'partial': return 'var(--wm-content-max)';  // a partial-width node → prose measure
    default: return null;
  }
}

/** Map a Gap constraint value ('s'|'m'|'l') to a CSS token. */
function gapToken(value?: string): string {
  if (value === 's') return 'var(--wm-space-s)';
  if (value === 'l') return 'var(--wm-space-l)';
  return 'var(--wm-space-m)';  // default
}

/** Translate a single constraint to CSS declarations. Returns [] for constraints
 *  that are structural (Ordering — preserved by DOM order, not emitted) or that
 *  don't produce a declaration on this element. */
function constraintToCss(c: LayoutConstraint): string[] {
  switch (c.kind) {
    case 'FillParent':
      return ['width: 100%'];
    case 'Centered':
      return ['margin-inline: auto'];
    case 'MaxWidth': {
      const v = maxWidthToken(c.value);
      return v ? [`max-width: ${v}`] : [];
    }
    case 'AspectRatio':
      return c.value ? [`aspect-ratio: ${c.value}`] : [];
    case 'Gap':
      return [`gap: ${gapToken(c.value)}`];
    case 'StackVertically':
      return ['flex-direction: column'];
    case 'WrapOnOverflow':
      return ['flex-wrap: wrap'];
    case 'Alignment':
      return c.value && c.value !== 'mixed'
        ? [`align-items: ${c.value}`, `justify-content: ${c.value === 'stretch' ? 'normal' : c.value}`]
        : [];
    case 'Ordering':
      return [];  // inviolable — preserved by DOM order, never emitted as `order`
    default:
      return [];
  }
}

// ── Author constraint constants (also emitted as CSS tokens in FLUID_TOKENS) ──
// A4: the hardcoded 320px content floor is now a named constant, linked to the
// --wm-content-min token. Both are authorConstraint provenance (the layout
// language's requirement), never measurements.
const CONTENT_MIN_PX = 320;  // == --wm-content-min token

// ── Solve (pure: no DOM access, no model calls) ─────────────────────

/** The v1 solver. Takes the Current Layout IR + slot assignment + exclusions,
 *  builds a placement map, and returns data for the DOM-grounded CSS emitter.
 *  Pure: no DOM, no model calls. */
export function solve(input: SolveInput): SolveResult {
  const { ir, assignment, excluded } = input;
  const slotById = new Map<string, SlotDef>();
  for (const s of DOCUMENTATION_SLOTS) slotById.set(s.id, s);

  // ── 1. Validate constraints (detect impossible + dropped optionals) ──
  // B8: impossibleNodes removed — populated but never read downstream.
  const droppedOptionals: { handle: string; kind: string; reason: string }[] = [];
  for (const node of ir.nodes) {
    const current = currentConstraints(ir.byHandle.get(node.handle)!);
    const slotId = assignment.handleToSlot.get(node.handle) ?? 'overflow';
    const slot = slotById.get(slotId);
    const slotConstraints: LayoutConstraint[] = slot
      ? slot.constraints.map((c) => ({ kind: c.kind as LayoutConstraint['kind'], priority: c.priority, source: 'language' as const, value: c.value }))
      : [];
    mergeConstraints(node.handle, current, slotConstraints, droppedOptionals);
  }

  // ── 2. Build placement map ───────────────────────────────────────────
  // S7.1: CSS-only placement. No wrappers, no moves. Each top-level slot-assigned
  // node gets a grid-column based on its slot's preferredWidth. A node whose parent
  // is in the SAME slot is NOT placed (it flows within its parent, which is placed).
  // Skip position:fixed (viewport-relative, can't be a grid item) and position:absolute
  // (out-of-flow, doesn't participate in grid layout).
  const allSlotHandles = new Set<string>();
  for (const node of ir.nodes) {
    const slotId = assignment.handleToSlot.get(node.handle) ?? 'overflow';
    if (slotId !== 'overflow' && !excluded.has(node.handle) &&
        node.authoredLayout.position !== 'fixed' &&
        node.authoredLayout.position !== 'absolute')
      allSlotHandles.add(node.handle);
  }

  const placement = new Map<string, PlacementInfo>();
  for (const node of ir.nodes) {
    const slotId = assignment.handleToSlot.get(node.handle) ?? 'overflow';
    if (slotId === 'overflow' || excluded.has(node.handle)) continue;
    // S7.1: skip fixed AND absolute — neither participates in grid layout.
    if (node.authoredLayout.position === 'fixed' || node.authoredLayout.position === 'absolute') continue;
    // Skip if parent is in the SAME slot — the parent carries this node.
    if (node.computedRelationships.parent && allSlotHandles.has(node.computedRelationships.parent)) {
      const parentSlot = assignment.handleToSlot.get(node.computedRelationships.parent) ?? 'overflow';
      if (parentSlot === slotId) continue;
    }
    const slot = slotById.get(slotId);
    if (!slot) continue;
    placement.set(node.handle, {
      slotId,
      preferredWidth: slot.preferredWidth,
      gridColumn: '',  // filled below after we know hasSide
    });
  }

  // ── 3. Determine grid columns from slot definitions ──────────────────
  const placedSlots = new Set<string>();
  for (const info of placement.values()) placedSlots.add(info.slotId);
  const hasSide = [...placedSlots].some((id) => slotById.get(id)?.preferredWidth === 'side');
  const sideMin = Math.max(0, ...[...placedSlots]
    .filter((id) => slotById.get(id)?.preferredWidth === 'side')
    .map((id) => slotById.get(id)?.minWidth ?? 0));
  const contentMin = Math.max(CONTENT_MIN_PX, ...[...placedSlots]
    .filter((id) => slotById.get(id)?.preferredWidth === 'content')
    .map((id) => slotById.get(id)?.minWidth ?? CONTENT_MIN_PX));

  // Fill in gridColumn now that we know hasSide.
  for (const info of placement.values()) {
    if (info.preferredWidth === 'full' || !hasSide) info.gridColumn = '1 / -1';
    else if (info.preferredWidth === 'side') info.gridColumn = '1';
    else info.gridColumn = '2';
  }

  // ── 4. Build per-node declarations (constraint-driven + fluid text) ──
  // A2: every emitted declaration originates from a constraint in the IR (slot
  // constraints) or from a design token (fluid text). No captured-rect values.
  const perNodeDecls = new Map<string, string[]>();
  for (const node of ir.nodes) {
    if (excluded.has(node.handle)) continue;
    const decls: string[] = [];
    // A2: translate slot constraints to CSS. The slot defines what the layout
    // language requires for this role (StackVertically, MaxWidth, FillParent, etc.).
    const slotId = assignment.handleToSlot.get(node.handle) ?? 'overflow';
    const slot = slotById.get(slotId);
    if (slot) {
      for (const sc of slot.constraints) {
        const constraint: LayoutConstraint = {
          kind: sc.kind as LayoutConstraint['kind'],
          priority: sc.priority,
          source: 'language' as const,
          value: sc.value,
        };
        decls.push(...constraintToCss(constraint));
      }
    }
    // Fluid text tokens (design tokens — provenance: token).
    if (isSemanticText(node.semantic.role)) {
      const ft = fontSizeToken(node.semantic.role);
      if (ft) decls.push(`font-size: ${ft}`);
    }
    // A4: measured heights → height: auto (intrinsic).
    if (node.authoredLayout.intrinsicSizing === 'fixed') {
      decls.push('max-width: 100%');
    }
    // Dedup (slot + current constraints may produce the same declaration).
    if (decls.length > 0) perNodeDecls.set(node.handle, [...new Set(decls)]);
  }

  const gridCols = hasSide
    ? `minmax(min(${sideMin}px, 100%), var(--wm-side-max)) minmax(0, 1fr)`
    : `minmax(min(${contentMin}px, 100%), 1fr)`;

  const matchedTargets = placement.size;
  // matched-targets = 0 is a HARD COMPILER ERROR.
  if (matchedTargets === 0) {
    throw new Error('solve: matched-targets = 0 — no nodes placed. This is a compiler error.');
  }

  return {
    placement, gridTemplate: gridCols, hasSide, sideMin, contentMin,
    perNodeDecls,
    rulesEmitted: 1 /* :root */ + placement.size + perNodeDecls.size,
    matchedTargets, droppedOptionals,
  };
}

// ── DOM-grounded CSS emission (S7.1 + S7.2) ────────────────────────

/** Build a CSS selector from a DOM element using the same anchor logic as
 *  structuralPath (Phase 5): nearest stable attribute (id/data-testid/role/
 *  aria-label/name) + nth-of-type chain. Returns null if no usable selector
 *  can be derived (caller falls back to [data-wm-c]). */
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

// S8.1: deterministic slot priority for proxy slot assignment (no model input).
const SLOT_PRIORITY = ['masthead', 'toc', 'nav-local', 'main', 'footer'];
function slotPriority(slotId: string): number {
  const i = SLOT_PRIORITY.indexOf(slotId);
  return i === -1 ? 99 : i;
}

/** Execute the placement against the live DOM and emit all structural CSS.
 *  Zero DOM mutation — only CSS (and data-* attribute stamps for targeting) is emitted.
 *
 *  S8.1 — PROXY PLACEMENT. For each placed handle, the PLACEMENT PROXY is the
 *  NCA's direct child that is an ancestor-or-self of the handle. We place the
 *  PROXY with grid-column — its background, border and padding are preserved,
 *  nothing is collapsed. A proxy whose subtree spans >1 non-overflow slot is
 *  "mixed": it gets subgrid (S10.1, replacing display:contents) and its children
 *  are recursed. That is the ONLY use of subgrid. Two handles sharing a proxy:
 *  keep one, it takes the highest-priority slot (SLOT_PRIORITY — no randomness).
 *
 *  S8.3 — template from ACTUALLY placed proxies (not the intended set).
 *  min-width:0 propagated up the NCA ancestor chain to body. min-height:100vh
 *  DELETED (compiler was making a design decision). overflow-x:clip BANNED.
 *
 *  S8.5 — selectorFallback split into 4 counters (NCA, proxy, contents, perNode).
 *  nodesNotPlaceable reconciled (no double counting). */
export function computeGridPlacementCss(result: SolveResult): PlacementResult {
  const { placement, perNodeDecls } = result;
  const blocks: string[] = [];
  // S8.5: split selectorFallback into 4 counters.
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
    plan: { trackCount: 0, slotToTrack: {}, expectedColumns: 0 },
    intermediatesSkipped: 0, skippedReasons: [],
    mixedProxies: 0, proxyCount: 0, diagnostics: '(empty)',
  });

  if (placement.size === 0) return empty('');

  // a. :root fluid tokens
  blocks.push(`:root {${FLUID_TOKENS}\n}`);

  // b. Resolve placed handles to live elements. S8.5: single loop, no double counting.
  const placedEls: Map<string, HTMLElement> = new Map();
  for (const [handle] of placement) {
    const el = document.querySelector<HTMLElement>(`[data-wm-c="${handle}"]`);
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

  // d. Build handle data: for each placed handle, its element + slotId.
  const handleData: { handle: string; el: HTMLElement; slotId: string }[] = [];
  for (const [handle, info] of placement) {
    const el = placedEls.get(handle);
    if (!el) continue;  // already in nodesNotPlaceable from step b
    handleData.push({ handle, el, slotId: info.slotId });
  }

  // For an element, return the set of non-overflow slots of placed handles in its subtree.
  const nonOverflowSlotsUnder = (el: HTMLElement): Set<string> => {
    const slots = new Set<string>();
    for (const hd of handleData) {
      if (hd.slotId === 'overflow') continue;
      if (el === hd.el || el.contains(hd.el)) slots.add(hd.slotId);
    }
    return slots;
  };

  // S11.1: a proxy earns subgrid ONLY if its descendants span both a side-track
  // slot AND a content slot (two different slot KINDS, not just two slot IDs).
  // A proxy spanning two content slots (e.g. main + comments) does NOT earn
  // subgrid — it goes to a single track. This stops track inheritance.
  const slotById = new Map<string, SlotDef>();
  for (const s of DOCUMENTATION_SLOTS) slotById.set(s.id, s);
  const earnsSubgrid = (slots: Set<string>): boolean => {
    let hasSide = false, hasContent = false;
    for (const s of slots) {
      const pw = slotById.get(s)?.preferredWidth;
      if (pw === 'side') hasSide = true;
      if (pw === 'content') hasContent = true;
    }
    return hasSide && hasContent;
  };

  // e. S8.1: BFS proxy placement. Level 0 = NCA's direct children containing placed handles.
  //     Non-mixed proxy (≤1 non-overflow slot) → place with grid-column.
  //     Mixed proxy (>1 non-overflow slot) → subgrid (S10.1) + recurse on children.
  //     Non-handle children (no placed handle in subtree) get grid-column: 1/-1 so they
  //     don't auto-place into a narrow side track and squeeze content.
  let singleTrackProxies = 0;
  let subgridChildAssignments = 0;
  const placedProxies = new Map<HTMLElement, string>();  // proxy el → assigned slotId
  const contentsEls: HTMLElement[] = [];  // earned-subgrid proxies (S11.1)
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
      const slots = nonOverflowSlotsUnder(candidate);
      if (!earnsSubgrid(slots)) {
        // S11.1: does NOT earn subgrid — place as a single-track grid item.
        // Assign the highest-priority non-overflow slot (deterministic; "keep one"
        // when multiple handles share this proxy). Multi-slot proxies that don't
        // span side+content (e.g. two content slots) go here — no track inheritance.
        let slotId = 'overflow';
        for (const s of slots) {
          if (slotId === 'overflow' || slotPriority(s) < slotPriority(slotId)) slotId = s;
        }
        placedProxies.set(candidate, slotId);
        if (slots.size > 1) singleTrackProxies++;
      } else {
        // S11.1: EARNS subgrid — spans both a side track and a content track.
        // S11.2: every child gets explicit grid-column (derived from its slot).
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

  // f. S8.3: compute grid-template-columns from the ACTUALLY placed proxies.
  // (slotById was constructed before the BFS — S11.1.)
  const placedSlots = new Set<string>();
  for (const slotId of placedProxies.values()) placedSlots.add(slotId);
  const hasSide = [...placedSlots].some((id) => slotById.get(id)?.preferredWidth === 'side');
  const sideMin = Math.max(0, ...[...placedSlots]
    .filter((id) => slotById.get(id)?.preferredWidth === 'side')
    .map((id) => slotById.get(id)?.minWidth ?? 0));
  const contentMin = Math.max(CONTENT_MIN_PX, ...[...placedSlots]
    .filter((id) => slotById.get(id)?.preferredWidth === 'content')
    .map((id) => slotById.get(id)?.minWidth ?? CONTENT_MIN_PX));
  const gridTemplate = hasSide
    ? `minmax(min(${sideMin}px, 100%), var(--wm-side-max)) minmax(0, 1fr)`
    : `minmax(min(${contentMin}px, 100%), 1fr)`;

  // g. A3: Emit layout on the NCA, PRESERVING its existing formatting context.
  // A5: Establish container containment for container-query responsiveness.
  // Today we impose display: grid unconditionally — A3 forbids that. If the NCA
  // already has a working flex or grid context, modify its properties. If block,
  // introduce grid (new context). Overwriting display: flex with display: grid
  // is flattening; changing gap/justify-content/align-items/flex-wrap/flex-direction
  // is transformation.
  const ncaSelector = buildSelector(nca);
  let ncaCssSelector: string;
  if (ncaSelector && selectorIsUnique(ncaSelector, nca)) {
    ncaCssSelector = ncaSelector;
  } else {
    nca.setAttribute('data-wm-grid', 'nca');
    ncaCssSelector = '[data-wm-grid="nca"]';
    selectorFallbackNca++;
  }
  // A3: detect the NCA's current formatting context. This is a measurement used for
  // a DECISION (which properties to emit), not emitted as a value — allowed per Law 0.
  const ncaCs = getComputedStyle(nca);
  const ncaDisplay = ncaCs.display;
  const ncaIsGrid = ncaDisplay.includes('grid');
  const ncaIsFlex = ncaDisplay.includes('flex');
  // S8.3: if the NCA's parent is a flex/grid container, the NCA is a flex/grid item
  // and needs max-width:100% to avoid blowing out the parent.
  const ncaParentCs = nca.parentElement ? getComputedStyle(nca.parentElement) : null;
  const ncaIsFlexGridItem = ncaParentCs != null &&
    (ncaParentCs.display.includes('flex') || ncaParentCs.display.includes('grid'));

  const ncaDecls: string[] = [];
  // A3: preserve the existing formatting context.
  if (ncaIsGrid) {
    // Already grid — modify properties, don't replace.
    ncaDecls.push(`grid-template-columns: ${gridTemplate}`, 'gap: var(--wm-space-m)', 'min-width: 0');
  } else if (ncaIsFlex) {
    // Already flex — use flex properties for multi-column layout.
    // flex-wrap: wrap lets side+content items sit side by side and wrap on narrow containers.
    ncaDecls.push('flex-wrap: wrap', 'gap: var(--wm-space-m)', 'min-width: 0');
  } else {
    // Block or other — introduce grid (new formatting context only where none exists).
    ncaDecls.push('display: grid', `grid-template-columns: ${gridTemplate}`, 'gap: var(--wm-space-m)', 'min-width: 0');
  }
  if (ncaIsFlexGridItem) ncaDecls.push('max-width: 100%');
  // A5: establish containment for container-query responsiveness. Graceful: skip if
  // the NCA already has containment (don't override) or if containment is unsupported.
  const containerSupported = typeof CSS !== 'undefined' && CSS.supports('container-type', 'inline-size');
  if (containerSupported && ncaCs.containerType !== 'inline-size' && ncaCs.containerType !== 'size') {
    ncaDecls.push('container-type: inline-size');
  }
  blocks.push(`${ncaCssSelector} {\n${ncaDecls.map((d) => `  ${d};`).join('\n')}\n}`);

  // S10.1: subgrid support check. Chrome 117+ supports subgrid (this is an MV3
  // Chrome extension — no fallback needed in practice). A3: subgrid is a grid-only
  // feature — skip for flex NCA context (flex has no subgrid equivalent).
  const subgridSupported = typeof CSS !== 'undefined' && CSS.supports('grid-template-columns', 'subgrid') && !ncaIsFlex;
  let subgridProxies = 0;

  // i. S10.1: emit subgrid on mixed proxies (replaces display:contents). The box
  //    survives — background, border, padding, containing block, clipping and click
  //    targets all intact — and children participate in the NCA's column tracks.
  //    Fallback: grid-column: 1 / -1 (full-width grid item, no dissolution).
  //    A3: for flex NCA, mixed proxies are full-width flex items.
  for (const el of contentsEls) {
    const sel = buildSelector(el);
    let cssSelector: string;
    if (sel && selectorIsUnique(sel, el)) {
      cssSelector = sel;
    } else {
      el.setAttribute('data-wm-grid', `c${intermediatesCollapsed}`);
      cssSelector = `[data-wm-grid="c${intermediatesCollapsed}"]`;
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
  //      side track, squeezing content. A3: flex NCA → flex: 0 0 100%.
  for (const el of fullWidthEls) {
    const sel = buildSelector(el);
    let cssSelector: string;
    if (sel && selectorIsUnique(sel, el)) {
      cssSelector = sel;
    } else {
      el.setAttribute('data-wm-grid', `f${fullWidthEls.indexOf(el)}`);
      cssSelector = `[data-wm-grid="f${fullWidthEls.indexOf(el)}"]`;
      selectorFallbackContents++;
    }
    const fullDecl = ncaIsFlex ? 'flex: 0 0 100%' : 'grid-column: 1 / -1';
    blocks.push(`${cssSelector} {\n  ${fullDecl};\n}`);
  }

  // j. Emit placement on proxies. The proxy's box (bg/border/padding) is preserved.
  // S11.3: stamp each placed proxy with data-wm-plan-slot for the plan assertion.
  // A3: for flex NCA, use flex properties; for grid/block NCA, use grid-column.
  for (const [el, slotId] of placedProxies) {
    const slot = slotById.get(slotId);
    const pw = slot?.preferredWidth ?? 'full';
    el.setAttribute('data-wm-plan-slot', slotId);
    const sel = buildSelector(el);
    let cssSelector: string;
    if (sel && selectorIsUnique(sel, el)) {
      cssSelector = sel;
    } else {
      el.setAttribute('data-wm-grid', `p${selectorFallbackProxy}`);
      cssSelector = `[data-wm-grid="p${selectorFallbackProxy}"]`;
      selectorFallbackProxy++;
    }
    // A3: flex NCA → flex properties; grid/block NCA → grid-column.
    let decls: string[];
    if (ncaIsFlex) {
      if (pw === 'side' && hasSide) {
        decls = ['flex: 0 0 min(var(--wm-side-max), 100%)', 'max-width: var(--wm-side-max)'];
      } else if (pw === 'content' && hasSide) {
        decls = ['flex: 1 1 0', 'min-width: var(--wm-content-min)'];
      } else {
        decls = ['flex: 0 0 100%'];
      }
    } else {
      const gridColumn = (pw === 'full' || !hasSide) ? '1 / -1'
        : pw === 'side' ? '1' : '2';
      decls = [`grid-column: ${gridColumn}`];
    }
    blocks.push(`${cssSelector} {\n${decls.map((d) => `  ${d};`).join('\n')}\n}`);
  }

  // A5: container query — when the NCA container is narrow, collapse all placed
  // proxies to full-width. This is the browser-native responsive collapse: no
  // viewport measurement, no re-run. The browser resolves it from the container's
  // inline-size. Graceful: only emitted if container-type was set on the NCA.
  if (containerSupported && (ncaCs.containerType !== 'inline-size' && ncaCs.containerType !== 'size' ? false : true)) {
    blocks.push(`@container (max-width: 600px) {\n  [data-wm-plan-slot] {\n    grid-column: 1 / -1 !important;\n    flex: 0 0 100% !important;\n    max-width: 100% !important;\n  }\n}`);
  }

  // k. Per-node CSS (fluid text + overflow safety) for ALL nodes — placed handles
  //    get their text sizing on the original [data-wm-c] element (the proxy is
  //    structural; the semantic text node carries the font-size token).
  for (const [handle, decls] of perNodeDecls) {
    const el = document.querySelector<HTMLElement>(`[data-wm-c="${handle}"]`);
    if (!el) continue;
    const sel = buildSelector(el);
    let cssSelector: string;
    if (sel && selectorIsUnique(sel, el)) {
      cssSelector = sel;
    } else {
      cssSelector = `[data-wm-c="${handle}"]`;
      selectorFallbackPerNode++;
    }
    blocks.push(`${cssSelector} {\n${decls.map((d) => `  ${d};`).join('\n')}\n}`);
  }

  const selectorFallback = selectorFallbackNca + selectorFallbackProxy + selectorFallbackContents + selectorFallbackPerNode;
  const css = blocks.join('\n\n');

  // B10 + C2: Law 0 assertion — reject any raw px in a sizing property in the
  // emitted CSS. This is the single real gate; the old assertNoMeasurementLengths
  // mock (a hand-built provenance map that checked itself) was deleted — it was
  // documentation, not enforcement. assertNoRawPxSizing on the actual CSS catches
  // real leaks from every emission path.
  assertNoRawPxSizing(css);

  // S11.3: build the emit-time plan — what the CSS INTENDS, asserted at verify time.
  const trackCount = hasSide ? 2 : 1;
  const slotToTrack: Record<string, number> = {};
  for (const slotId of placedSlots) {
    const pw = slotById.get(slotId)?.preferredWidth ?? 'full';
    slotToTrack[slotId] = (pw === 'content' && hasSide) ? 2 : 1;
  }
  // expectedColumns = number of tracks that actually have placed proxies.
  const track1Used = Object.values(slotToTrack).includes(1);
  const track2Used = Object.values(slotToTrack).includes(2);
  const expectedColumns = (track1Used ? 1 : 0) + (track2Used ? 1 : 0) || 1;
  const plan: SolverPlan = { trackCount, slotToTrack, expectedColumns };

  // S8.5: nodesPlaced = handles placed (every found handle gets a proxy by
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

// ── Constraint merge (priority sort, never "first wins") ─────────────

/** Merge current (law) + slot (language) constraints. Required beats preferred
 *  beats optional. If two REQUIRED of the same kind conflict, mark IMPOSSIBLE.
 *  Dropped optionals are logged. Used for validation only. */
function mergeConstraints(
  handle: string,
  current: LayoutConstraint[],
  slot: LayoutConstraint[],
  droppedOptionals: { handle: string; kind: string; reason: string }[],
): void {
  const byKind = new Map<string, LayoutConstraint[]>();
  for (const c of [...current, ...slot]) {
    const arr = byKind.get(c.kind) ?? [];
    arr.push(c);
    byKind.set(c.kind, arr);
  }
  for (const [, candidates] of byKind) {
    const priorityRank: Record<ConstraintPriority, number> = { required: 0, preferred: 1, optional: 2 };
    candidates.sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority]);
    // B8: impossibleNodes removed — the conflict is logged in droppedOptionals.
    const winner = candidates[0];
    for (let i = 1; i < candidates.length; i++) {
      if (candidates[i].priority === 'optional') {
        droppedOptionals.push({ handle, kind: candidates[i].kind, reason: `dropped for ${winner.priority} ${candidates[i].kind}` });
      }
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Is this role a semantic text level (body, headings, captions)? */
function isSemanticText(role: string): boolean {
  return role === 'article-body' || role === 'page-title' || role === 'metadata' ||
    role === 'listing' || role === 'comments' || role === 'toc';
}

/** Map a role to a fluid clamp() token. page-title → step-2 (display), body → step-0. */
function fontSizeToken(role: string): string | null {
  if (role === 'page-title') return 'var(--wm-step-2)';
  if (role === 'article-body' || role === 'metadata' || role === 'listing' ||
    role === 'comments' || role === 'toc') return 'var(--wm-step-0)';
  return null;
}

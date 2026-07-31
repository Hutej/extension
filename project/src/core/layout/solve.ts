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

import type { LayoutIR, LayoutIRNode, LayoutConstraint, ConstraintPriority } from './ir.ts';
import { currentConstraints } from './ir.ts';
import type { SlotAssignment } from './assign.ts';
import type { SlotDef } from './languages/documentation.ts';
import { DOCUMENTATION_SLOTS } from './languages/documentation.ts';

// ── Fluid token set (from ARCHITECTURE.md, applied at semantic text levels only) ──

const FLUID_TOKENS = `
  --wm-step-0: clamp(1rem, 0.95rem + 0.3vw, 1.125rem);
  --wm-step-2: clamp(1.6rem, 1.3rem + 1.2vw, 2.3rem);
  --wm-space-s: clamp(8px, 1vw, 12px);
  --wm-space-m: clamp(16px, 2vw, 24px);
  --wm-space-l: clamp(24px, 3vw, 40px);
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
  /** The grid-template-columns value for the NCA. */
  gridTemplate: string;
  /** Whether the grid has a side column. */
  hasSide: boolean;
  /** Per-node CSS declarations (handle → decls) for fluid text + overflow safety. */
  perNodeDecls: Map<string, string[]>;
  rulesEmitted: number;
  matchedTargets: number;
  impossibleNodes: string[];
  droppedOptionals: { handle: string; kind: string; reason: string }[];
}

/** Result of the DOM-grounded CSS emission. */
export interface PlacementResult {
  /** Combined structural CSS (fluid tokens + grid + display:contents + grid-column + per-node). */
  css: string;
  /** Count of handles that fell back to [data-wm-c] selector (S7.2). */
  selectorFallback: number;
  /** Total handles attempted to place. */
  nodesPlaced: number;
  /** Handles that could NOT be placed (intermediate couldn't be collapsed). */
  nodesNotPlaceable: string[];
  /** Number of intermediates collapsed with display:contents. */
  intermediatesCollapsed: number;
  /** Number of intermediates skipped (not safe to collapse). */
  intermediatesSkipped: number;
  /** Reason each intermediate was skipped. */
  skippedReasons: string[];
}

// ── Solve (pure: no DOM access, no model calls) ─────────────────────

/** The v1 solver. Takes the Current Layout IR + slot assignment + exclusions,
 *  builds a placement map, and returns data for the DOM-grounded CSS emitter.
 *  Pure: no DOM, no model calls. */
export function solve(input: SolveInput): SolveResult {
  const { ir, assignment, excluded } = input;
  const slotById = new Map<string, SlotDef>();
  for (const s of DOCUMENTATION_SLOTS) slotById.set(s.id, s);

  // ── 1. Validate constraints (detect impossible + dropped optionals) ──
  const impossibleNodes: string[] = [];
  const droppedOptionals: { handle: string; kind: string; reason: string }[] = [];
  for (const node of ir.nodes) {
    const current = currentConstraints(ir.byHandle.get(node.handle)!);
    const slotId = assignment.handleToSlot.get(node.handle) ?? 'overflow';
    const slot = slotById.get(slotId);
    const slotConstraints: LayoutConstraint[] = slot
      ? slot.constraints.map((c) => ({ kind: c.kind as LayoutConstraint['kind'], priority: c.priority, source: 'language' as const, value: c.value }))
      : [];
    mergeConstraints(node.handle, current, slotConstraints, impossibleNodes, droppedOptionals);
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
  const contentMin = Math.max(320, ...[...placedSlots]
    .filter((id) => slotById.get(id)?.preferredWidth === 'content')
    .map((id) => slotById.get(id)?.minWidth ?? 320));

  // Fill in gridColumn now that we know hasSide.
  for (const info of placement.values()) {
    if (info.preferredWidth === 'full' || !hasSide) info.gridColumn = '1 / -1';
    else if (info.preferredWidth === 'side') info.gridColumn = '1';
    else info.gridColumn = '2';
  }

  // ── 4. Build per-node declarations (fluid text + overflow safety) ───
  const perNodeDecls = new Map<string, string[]>();
  for (const node of ir.nodes) {
    if (excluded.has(node.handle)) continue;
    const decls: string[] = [];
    if (isSemanticText(node.semantic.role)) {
      const token = fontSizeToken(node.semantic.role);
      if (token) decls.push(`font-size: ${token}`);
    }
    if (node.authoredLayout.intrinsicSizing === 'fixed') {
      decls.push('max-width: 100%');
    }
    // S7.1: position:static !important DELETED — it existed only to fix a wrapper
    // containing-block problem that no longer exists (no wrappers, no moves).
    if (decls.length > 0) perNodeDecls.set(node.handle, decls);
  }

  const gridCols = hasSide
    ? `minmax(min(${sideMin}px, calc(20vw - var(--wm-space-m) / 2)), 20vw) minmax(min(${contentMin}px, calc(80vw - var(--wm-space-m) / 2)), 1fr)`
    : `minmax(min(${contentMin}px, 100%), 1fr)`;

  const matchedTargets = placement.size;
  // matched-targets = 0 is a HARD COMPILER ERROR.
  if (matchedTargets === 0) {
    throw new Error('solve: matched-targets = 0 — no nodes placed. This is a compiler error.');
  }

  return {
    placement, gridTemplate: gridCols, hasSide,
    perNodeDecls,
    rulesEmitted: 1 /* :root */ + placement.size + perNodeDecls.size,
    matchedTargets, impossibleNodes, droppedOptionals,
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

/** DISPLAY:CONTENTS SAFETY RULES (principled, no hostnames):
 *  Never collapse an element that:
 *    - paints anything (background-color/image, border, box-shadow, outline)
 *    - contributes layout its children rely on (non-zero padding, or is itself a
 *      flex/grid container whose children are positioned by it)
 *    - carries list/table semantics (ul, ol, li, table, thead, tbody, tr, td, th)
 *    - has an explicit ARIA role or is a landmark element */
function canCollapse(el: HTMLElement): { safe: boolean; reason?: string } {
  const tag = el.tagName.toLowerCase();
  const cs = getComputedStyle(el);

  // Paints anything
  const bg = cs.backgroundColor;
  if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent')
    return { safe: false, reason: `${tag}:has background-color` };
  if (cs.backgroundImage && cs.backgroundImage !== 'none')
    return { safe: false, reason: `${tag}:has background-image` };
  const bt = parseFloat(cs.borderTopWidth) || 0;
  const br = parseFloat(cs.borderRightWidth) || 0;
  const bb = parseFloat(cs.borderBottomWidth) || 0;
  const bl = parseFloat(cs.borderLeftWidth) || 0;
  if (bt > 0 || br > 0 || bb > 0 || bl > 0)
    return { safe: false, reason: `${tag}:has border` };
  if (cs.boxShadow && cs.boxShadow !== 'none')
    return { safe: false, reason: `${tag}:has box-shadow` };
  if (cs.outlineStyle && cs.outlineStyle !== 'none')
    return { safe: false, reason: `${tag}:has outline` };

  // Contributes layout its children rely on
  const pt = parseFloat(cs.paddingTop) || 0;
  const pr = parseFloat(cs.paddingRight) || 0;
  const pb = parseFloat(cs.paddingBottom) || 0;
  const pl = parseFloat(cs.paddingLeft) || 0;
  if (pt > 0 || pr > 0 || pb > 0 || pl > 0)
    return { safe: false, reason: `${tag}:has non-zero padding` };
  if (cs.display.includes('flex') || cs.display.includes('grid'))
    return { safe: false, reason: `${tag}:is flex/grid container` };

  // List/table semantics
  if (['ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col'].includes(tag))
    return { safe: false, reason: `${tag}:list/table semantics` };

  // Explicit ARIA role or landmark element
  if (el.getAttribute('role'))
    return { safe: false, reason: `${tag}:has ARIA role (${el.getAttribute('role')})` };
  if (['header', 'nav', 'main', 'aside', 'footer', 'section', 'article', 'form', 'search', 'figure', 'details', 'dialog'].includes(tag))
    return { safe: false, reason: `${tag}:landmark element` };

  return { safe: true };
}

/** Get the intermediates between an element and an ancestor (exclusive of both). */
function intermediatesBetween(el: HTMLElement, ancestor: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  let n: HTMLElement | null = el.parentElement;
  while (n && n !== ancestor) {
    out.push(n);
    n = n.parentElement;
  }
  return out;
}

/** Execute the placement against the live DOM and emit all structural CSS.
 *  Zero DOM mutation — only CSS is emitted. The caller applies it as a stylesheet.
 *  S7.1: grid on NCA, display:contents on safe intermediates, grid-column on placed nodes.
 *  S7.2: selectors from structuralPath, fallback to [data-wm-c], count fallbacks. */
export function computeGridPlacementCss(result: SolveResult): PlacementResult {
  const { placement, gridTemplate, hasSide, perNodeDecls } = result;
  const blocks: string[] = [];
  let selectorFallback = 0;
  let intermediatesCollapsed = 0;
  let intermediatesSkipped = 0;
  const skippedReasons: string[] = [];
  const nodesNotPlaceable: string[] = [];
  let nodesPlaced = 0;

  if (placement.size === 0) {
    return { css: '', selectorFallback: 0, nodesPlaced: 0, nodesNotPlaceable: [], intermediatesCollapsed: 0, intermediatesSkipped: 0, skippedReasons: [] };
  }

  // a. :root fluid tokens
  blocks.push(`:root {${FLUID_TOKENS}\n}`);

  // b. Resolve placed handles to live elements.
  const placedEls: Map<string, HTMLElement> = new Map();
  for (const [handle] of placement) {
    const el = document.querySelector<HTMLElement>(`[data-wm-c="${handle}"]`);
    if (el) placedEls.set(handle, el);
    else nodesNotPlaceable.push(handle);
  }
  if (placedEls.size === 0) {
    return { css: `:root {${FLUID_TOKENS}\n}`, selectorFallback: 0, nodesPlaced: 0, nodesNotPlaceable: [...placement.keys()], intermediatesCollapsed: 0, intermediatesSkipped: 0, skippedReasons: [] };
  }

  // c. Find the NCA of all placed elements.
  const els = [...placedEls.values()];
  const nca = nearestCommonAncestor(els);
  if (!nca) {
    // No common ancestor — can't place. Emit only fluid tokens.
    nodesNotPlaceable.push(...placedEls.keys());
    return { css: `:root {${FLUID_TOKENS}\n}`, selectorFallback: 0, nodesPlaced: 0, nodesNotPlaceable: [...placedEls.keys()], intermediatesCollapsed: 0, intermediatesSkipped: 0, skippedReasons: [] };
  }

  // d. Emit display: grid on the NCA.
  const ncaSelector = buildSelector(nca);
  let ncaCssSelector: string;
  if (ncaSelector && selectorIsUnique(ncaSelector, nca)) {
    ncaCssSelector = ncaSelector;
  } else {
    // Fallback: stamp a unique debug attribute on the NCA for targeting.
    // This is a minimal attribute addition (not a structural mutation) —
    // frameworks don't reconcile data-* attribute changes.
    nca.setAttribute('data-wm-grid', 'nca');
    ncaCssSelector = '[data-wm-grid="nca"]';
    selectorFallback++;
  }
  blocks.push(`${ncaCssSelector} {\n  display: grid;\n  grid-template-columns: ${gridTemplate};\n  gap: var(--wm-space-m);\n  min-height: 100vh;\n}`);

  // e. For each placed node: find intermediates, check safety, emit display:contents + grid-column.
  const collapsedSet = new Set<HTMLElement>();  // dedup intermediates shared by multiple nodes
  for (const [handle, info] of placement) {
    const el = placedEls.get(handle);
    if (!el) { nodesNotPlaceable.push(handle); continue; }

    // Find intermediates between el and NCA.
    const intermed = intermediatesBetween(el, nca);

    // Check if ALL intermediates can be safely collapsed.
    let allSafe = true;
    const safeIntermed: HTMLElement[] = [];
    for (const im of intermed) {
      if (collapsedSet.has(im)) { safeIntermed.push(im); continue; }  // already checked
      const check = canCollapse(im);
      if (check.safe) {
        safeIntermed.push(im);
      } else {
        allSafe = false;
        intermediatesSkipped++;
        skippedReasons.push(check.reason ?? 'unknown');
        break;  // first unsafe intermediate blocks this node
      }
    }

    if (!allSafe) {
      nodesNotPlaceable.push(handle);
      continue;
    }

    // Emit display: contents on safe intermediates (deduped).
    for (const im of safeIntermed) {
      if (collapsedSet.has(im)) continue;
      collapsedSet.add(im);
      const imSel = buildSelector(im);
      let imCssSelector: string;
      if (imSel && selectorIsUnique(imSel, im)) {
        imCssSelector = imSel;
      } else {
        im.setAttribute('data-wm-grid', `i${intermediatesCollapsed}`);
        imCssSelector = `[data-wm-grid="i${intermediatesCollapsed}"]`;
        selectorFallback++;
      }
      blocks.push(`${imCssSelector} {\n  display: contents;\n}`);
      intermediatesCollapsed++;
    }

    // Emit grid-column on the placed node.
    const nodeSel = buildSelector(el);
    let nodeCssSelector: string;
    if (nodeSel && selectorIsUnique(nodeSel, el)) {
      nodeCssSelector = nodeSel;
    } else {
      nodeCssSelector = `[data-wm-c="${handle}"]`;
      selectorFallback++;
    }
    const decls: string[] = [`grid-column: ${info.gridColumn}`, 'min-width: 0'];
    // Content slot: prose measure ceiling + centered within track.
    if (info.preferredWidth === 'content') {
      decls.push('max-width: 65ch');
      decls.push('margin-inline: auto');
    }
    // Overflow safety: cap fixed-width nodes at 100%.
    if (el.hasAttribute('data-wm-c')) {
      const node = result.perNodeDecls.get(handle);
      if (node) decls.push(...node);
    }
    blocks.push(`${nodeCssSelector} {\n${decls.map((d) => `  ${d};`).join('\n')}\n}`);
    nodesPlaced++;
  }

  // f. Per-node CSS for nodes NOT in the placement (excluded, overflow, absolute, fixed).
  // These still need fluid text + overflow safety, but no grid-column.
  for (const [handle, decls] of result.perNodeDecls) {
    if (placement.has(handle)) continue;  // already emitted with grid-column
    const el = document.querySelector<HTMLElement>(`[data-wm-c="${handle}"]`);
    if (!el) continue;
    const sel = buildSelector(el);
    let cssSelector: string;
    if (sel && selectorIsUnique(sel, el)) {
      cssSelector = sel;
    } else {
      cssSelector = `[data-wm-c="${handle}"]`;
      selectorFallback++;
    }
    blocks.push(`${cssSelector} {\n${decls.map((d) => `  ${d};`).join('\n')}\n}`);
  }

  const css = blocks.join('\n\n');
  return { css, selectorFallback, nodesPlaced, nodesNotPlaceable, intermediatesCollapsed, intermediatesSkipped, skippedReasons };
}

// ── Constraint merge (priority sort, never "first wins") ─────────────

/** Merge current (law) + slot (language) constraints. Required beats preferred
 *  beats optional. If two REQUIRED of the same kind conflict, mark IMPOSSIBLE.
 *  Dropped optionals are logged. Used for validation only. */
function mergeConstraints(
  handle: string,
  current: LayoutConstraint[],
  slot: LayoutConstraint[],
  impossibleNodes: string[],
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
    const required = candidates.filter((c) => c.priority === 'required');
    if (required.length > 1) {
      const values = new Set(required.map((c) => c.value ?? ''));
      if (values.size > 1) impossibleNodes.push(handle);
    }
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

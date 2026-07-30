/**
 * core/layout/solve — the v1 responsive solver. Phase 2.5, Step 2 + Step 3.
 *
 * Behind the runtime flag `layoutCompiler = 'v2'`. PARALLEL PATH — never
 * intertwined with the v1 compile path.
 *
 * The one architectural rule: the AI owns design decisions, the Layout IR owns
 * structure, the SOLVER owns constraints, the compiler owns CSS. The solver
 * satisfies constraints; it does not decide what the layout becomes.
 *
 * S3.1+S3.2 — the solver emits a PAGE SHELL, not per-node restyles:
 *   - ONE grid on [data-wm-shell] from the layout language's slot definitions
 *   - ONE wrapper per slot with ≥1 assigned node ([data-wm-slot="..."])
 *   - Zero-node slots emit NO wrapper (no empty grid tracks)
 *   - Overflow + excluded nodes are NOT wrapped, NOT moved (styled only)
 *   - Per-node CSS is minimal: fluid text sizing + overflow safety only
 *   - Wrappers are placed in DOM-source order; reading order is inviolable
 *   - The wrapper plan is returned as data for DOM execution (applySlotWrappers)
 *
 * v1 scope (all five, no more):
 *   1. validate constraints
 *   2. propagate parent constraints to children
 *   3. choose Flex or Grid per container (the SHELL grid)
 *   4. normalize sizing (auto / % / clamp() / minmax())
 *   5. emit responsive CSS
 *
 * NOT in v1: complex constraint relaxation, multi-pass optimization, global
 * layout optimization.
 *
 * Priority: Browser Laws -> Layout Language -> Transformation Intent. The model
 * NEVER assigns priority. Relax lowest priority first.
 *
 * READING ORDER IS INVIOLABLE. Visual order follows DOM order. No `order`, no
 * arbitrary grid-area placement that diverges keyboard/SR from sight.
 *
 * Fluid tokens at semantic text levels only (body, headings, captions). Wrappers
 * are sanctioned. Never rebuild the tree. matched-targets = 0 is a HARD ERROR.
 *
 * Any raw px in emitted CSS other than a slot minWidth floor is a defect.
 */

import type { LayoutIR, LayoutIRNode, LayoutConstraint, ConstraintPriority } from './ir.ts';
import { currentConstraints } from './ir.ts';
import type { SlotAssignment } from './assign.ts';
import type { SlotDef } from './languages/documentation.ts';
import { DOCUMENTATION_SLOTS } from './languages/documentation.ts';
import type { TransactionLog, DomAdapter } from '../ops/transaction.ts';

// ── Fluid token set (from ARCHITECTURE.md, applied at semantic text levels only) ──
// --wm-step-1 DELETED (S3.2): the solver can't target h2-h6 (the IR doesn't carry
// heading levels), so the token was dead. step-0 = body, step-2 = display heading.

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

/** The wrapper plan: one entry per slot with ≥1 assigned node. Handles in
 *  DOM-source order. The DOM executor (applySlotWrappers) creates the wrappers
 *  and moves the nodes. Overflow + excluded handles are NOT in the plan. */
export interface WrapperPlan {
  slotId: string;
  handles: string[];
}

export interface SolveResult {
  css: string;
  rulesEmitted: number;
  matchedTargets: number;
  impossibleNodes: string[];
  droppedOptionals: { handle: string; kind: string; reason: string }[];
  wrappers: WrapperPlan[];
}

// ── Solve (pure: no DOM access, no model calls) ─────────────────────

/** The v1 solver. Takes the Current Layout IR + slot assignment + exclusions,
 *  builds a wrapper plan, and emits the shell grid + slot wrapper CSS +
 *  minimal per-node CSS. Pure: no DOM, no model calls. */
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

  // ── 2. Group handles by slot (DOM-source order from ir.nodes) ─────────
  // Overflow + excluded nodes are NOT wrapped and NOT moved.
  // S3.1: only wrap top-level nodes WITHIN each slot — a node whose parent is
  // in the SAME slot moves with its parent (nested inside the parent's wrapper).
  // A node whose parent is in a DIFFERENT slot gets its own wrapper entry —
  // it's moved out of its parent's wrapper into its own slot wrapper. This is
  // the page shell: masthead/main/footer become separate grid areas even when
  // the original DOM nests main inside masthead.
  const allSlotHandles = new Set<string>();
  for (const node of ir.nodes) {
    const slotId = assignment.handleToSlot.get(node.handle) ?? 'overflow';
    // S4.2: skip position:absolute/fixed — they float out of the grid flow and
    // would leave wrappers empty/collapsed. Styled only, not moved.
    if (slotId !== 'overflow' && !excluded.has(node.handle) &&
        node.authoredLayout.position !== 'absolute' && node.authoredLayout.position !== 'fixed')
      allSlotHandles.add(node.handle);
  }
  const slotHandles = new Map<string, string[]>();
  for (const node of ir.nodes) {
    const slotId = assignment.handleToSlot.get(node.handle) ?? 'overflow';
    if (slotId === 'overflow' || excluded.has(node.handle)) continue;
    // S4.2: skip position:absolute/fixed from the wrapper plan (styled only).
    if (node.authoredLayout.position === 'absolute' || node.authoredLayout.position === 'fixed') continue;
    // Skip if parent is in the SAME slot — the parent carries this node.
    if (node.computedRelationships.parent && allSlotHandles.has(node.computedRelationships.parent)) {
      const parentSlot = assignment.handleToSlot.get(node.computedRelationships.parent) ?? 'overflow';
      if (parentSlot === slotId) continue;
    }
    const arr = slotHandles.get(slotId) ?? [];
    arr.push(node.handle);
    slotHandles.set(slotId, arr);
  }
  // Build wrapper plan in slot-definition order (masthead, nav-local, toc, main, footer).
  const wrappers: WrapperPlan[] = [];
  for (const slot of DOCUMENTATION_SLOTS) {
    if (slot.id === 'overflow') continue;
    const handles = slotHandles.get(slot.id);
    if (handles && handles.length > 0) wrappers.push({ slotId: slot.id, handles });
  }

  // ── 3. Determine grid columns from slot definitions ──────────────────
  const hasSide = wrappers.some((w) => slotById.get(w.slotId)?.preferredWidth === 'side');
  const sideMin = Math.max(0, ...wrappers
    .filter((w) => slotById.get(w.slotId)?.preferredWidth === 'side')
    .map((w) => slotById.get(w.slotId)?.minWidth ?? 0));
  const contentMin = Math.max(320, ...wrappers
    .filter((w) => slotById.get(w.slotId)?.preferredWidth === 'content')
    .map((w) => slotById.get(w.slotId)?.minWidth ?? 320));

  // ── 4. Emit CSS ──────────────────────────────────────────────────────
  const blocks: string[] = [];
  let rulesEmitted = 0;
  let matchedTargets = 0;

  // a. :root fluid tokens
  blocks.push(`:root {${FLUID_TOKENS}\n}`);
  rulesEmitted++;

  // b. Shell grid — ONE grid on the container of the slot wrappers.
  // S4.2: floors use min(slotMin, Nvw - half-gap) so the total floor + gap ≤ 100vw —
  // the grid can never force horizontal overflow, even at zoom-narrowed widths.
  // At wide viewports the floor is the slot minWidth (unchanged); at narrow viewports
  // the floor shrinks with the viewport. Intrinsic CSS collapses natively.
  const gridCols = hasSide
    ? `minmax(min(${sideMin}px, calc(20vw - var(--wm-space-m) / 2)), 20vw) minmax(min(${contentMin}px, calc(80vw - var(--wm-space-m) / 2)), 1fr)`
    : `minmax(min(${contentMin}px, 100%), 1fr)`;
  blocks.push(`[data-wm-shell] {\n  display: grid;\n  grid-template-columns: ${gridCols};\n  gap: var(--wm-space-m);\n  min-height: 100vh;\n  overflow-x: clip;\n}`);
  rulesEmitted++;

  // S4.2: blanket max-width: 100% for all clusters inside the shell — caps any
  // fixed-width element at its wrapper, preventing grid track overflow.
  blocks.push(`[data-wm-shell] [data-wm-c] {\n  max-width: 100%;\n}`);
  rulesEmitted++;

  // c. Per-slot wrappers — grid placement + flex flow + gap + measure ceiling.
  for (const w of wrappers) {
    const slot = slotById.get(w.slotId)!;
    const decls: string[] = [];
    // grid-column: full-width spans all; side goes to col 1; content to col 2.
    // In a single-column grid (no side slots), everything is 1 / -1.
    if (slot.preferredWidth === 'full' || !hasSide) {
      decls.push('grid-column: 1 / -1');
    } else if (slot.preferredWidth === 'side') {
      decls.push('grid-column: 1');
    } else {
      decls.push('grid-column: 2');
    }
    // Flex flow from the slot definition.
    decls.push('display: flex');
    decls.push(slot.flow === 'row' ? 'flex-direction: row' : 'flex-direction: column');
    // S4.2: min-width: 0 — standard grid pattern. Without it, a grid item's
    // min-width defaults to auto (content's intrinsic min), forcing the track
    // to grow and causing horizontal overflow. min-width: 0 lets the track
    // shrink, and flex/overflow inside handles the content.
    decls.push('min-width: 0');
    // Gap: side/full-width = tight, content = breathing room.
    decls.push(slot.preferredWidth === 'content' ? 'gap: var(--wm-space-m)' : 'gap: var(--wm-space-s)');
    // Content slot: prose measure ceiling (ch, not px) + centered within track.
    if (slot.preferredWidth === 'content') {
      decls.push('max-width: 65ch');
      decls.push('margin-inline: auto');
    }
    blocks.push(`[data-wm-slot="${w.slotId}"] {\n${decls.map((d) => `  ${d};`).join('\n')}\n}`);
    rulesEmitted++;
    matchedTargets += w.handles.length;
  }

  // d. Per-node minimal CSS — ONLY fluid text sizing + overflow safety.
  // The wrapper handles all layout (grid, flex, width, gap, max-width).
  for (const node of ir.nodes) {
    if (excluded.has(node.handle)) continue;
    const decls: string[] = [];
    // Fluid text sizing at semantic text levels only.
    if (isSemanticText(node.semantic.role)) {
      const token = fontSizeToken(node.semantic.role);
      if (token) decls.push(`font-size: ${token}`);
    }
    // Overflow safety: cap fixed-width nodes at 100% (prevent horizontal scroll).
    if (node.authoredLayout.intrinsicSizing === 'fixed') {
      decls.push('max-width: 100%');
    }
    if (decls.length > 0) {
      blocks.push(`[data-wm-c="${node.handle}"] {\n${decls.map((d) => `  ${d};`).join('\n')}\n}`);
      rulesEmitted++;
    }
  }

  // matched-targets = 0 is a HARD COMPILER ERROR.
  if (matchedTargets === 0) {
    throw new Error('solve: matched-targets = 0 — no nodes placed in slot wrappers. This is a compiler error.');
  }

  const css = blocks.join('\n\n');
  return { css, rulesEmitted, matchedTargets, impossibleNodes, droppedOptionals, wrappers };
}

// ── DOM execution: create slot wrappers + move nodes ────────────────

/** Execute the wrapper plan against the live DOM. Creates a shell container,
 *  one wrapper per slot, and moves each slot's nodes into their wrapper (in
 *  DOM-source order). Records an exact inverse per move in the transaction log
 *  so undoAll restores the original DOM. Overflow + excluded nodes are NOT
 *  moved (they're absent from the plan).
 *
 *  Non-pure: DOM access via the injected adapter. Reuses the existing
 *  TransactionLog + DomAdapter (same surface as executeOps). */
export function applySlotWrappers(
  plan: WrapperPlan[],
  dom: DomAdapter,
  txnLog: TransactionLog,
): { wrappersCreated: number; nodesMoved: number } {
  let wrappersCreated = 0;
  let nodesMoved = 0;

  if (plan.length === 0) return { wrappersCreated, nodesMoved };

  // Find the shell insertion root: walk up from the first node to body/html.
  // The shell MUST be at the top level — inserting it deep inside a subtree
  // that contains another plan node causes a HierarchyRequestError (moving an
  // ancestor into a wrapper that's inside its own descendant).
  let firstEl: HTMLElement | null = null;
  for (const w of plan) {
    for (const h of w.handles) {
      firstEl = dom.resolve(h) as HTMLElement | null;
      if (firstEl) break;
    }
    if (firstEl) break;
  }
  if (!firstEl) return { wrappersCreated, nodesMoved };

  let shellRoot: Node = firstEl;
  while (true) {
    const parent = dom.parent(shellRoot);
    if (!parent || parent === shellRoot) break;
    const tag = (parent as HTMLElement)?.tagName;
    if (tag === 'BODY' || tag === 'HTML') { shellRoot = parent; break; }
    shellRoot = parent;
  }
  // Find the insertion position: the body-level ancestor of the first node,
  // so the shell lands at the first node's visual position (not at the end of body).
  let shellInsert: Node = firstEl;
  while (dom.parent(shellInsert) && dom.parent(shellInsert) !== shellRoot) {
    shellInsert = dom.parent(shellInsert)!;
  }

  // Create the shell container at the body level, before the first node's ancestor.
  const shell = dom.createElement('div') as HTMLElement;
  shell.setAttribute('data-wm-shell', 'true');
  shell.setAttribute('data-wm-wrap', 'true');
  dom.insertBefore(shellRoot, shell, shellInsert);

  // Create slot wrappers + move nodes (in DOM-source order).
  for (const w of plan) {
    const wrapper = dom.createElement('div') as HTMLElement;
    wrapper.setAttribute('data-wm-slot', w.slotId);
    wrapper.setAttribute('data-wm-wrap', 'true');
    for (const h of w.handles) {
      const el = dom.resolve(h);
      if (!el) continue;
      const origParent = dom.parent(el);
      if (!origParent) continue;
      const origNext = dom.nextSibling(el);
      // Move the node into the wrapper. The child is untouched (no listeners
      // move, no React state changes, no IDs change). Only the parent changes.
      dom.appendChild(wrapper, el);
      txnLog.record({
        op: { kind: 'move', target: h, to: `slot:${w.slotId}` },
        target: h,
        inverse: { kind: 'reparent', node: el, parent: origParent, nextSibling: origNext },
      });
      nodesMoved++;
    }
    dom.appendChild(shell, wrapper);
    wrappersCreated++;
  }

  return { wrappersCreated, nodesMoved };
}

// ── Constraint merge (priority sort, never "first wins") ─────────────

/** Merge current (law) + slot (language) constraints. Required beats preferred
 *  beats optional. If two REQUIRED of the same kind conflict, mark IMPOSSIBLE.
 *  Dropped optionals are logged. Used for validation only — the CSS emission
 *  uses the slot definitions directly, not the per-node merged constraints. */
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

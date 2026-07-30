/**
 * core/layout/solve — the v1 responsive solver. Phase 2.5, Step 2.
 *
 * Behind the runtime flag `layoutCompiler = 'v2'`. PARALLEL PATH — never
 * intertwined with the v1 compile path.
 *
 * The one architectural rule: the AI owns design decisions, the Layout IR owns
 * structure, the SOLVER owns constraints, the compiler owns CSS. The solver
 * satisfies constraints; it does not decide what the layout becomes.
 *
 * v1 scope (all five, no more):
 *   1. validate constraints
 *   2. propagate parent constraints to children
 *   3. choose Flex or Grid per container
 *   4. normalize sizing to auto / % / clamp() / minmax()
 *   5. emit responsive CSS
 *
 * NOT in v1: complex constraint relaxation, multi-pass optimization, global
 * layout optimization. The goal of v1 isn't perfection — it's to stop layouts
 * from breaking when the viewport changes.
 *
 * Priority comes from Browser Laws -> Layout Language -> Transformation Intent,
 * in that order. The model NEVER assigns priority. Relax lowest priority first.
 * Refuse only if genuinely impossible. Never "first wins".
 *
 * READING ORDER IS INVIOLABLE. Visual order follows DOM order. No `order`, no
 * arbitrary grid-area placement. Accessibility wins over aesthetics.
 *
 * Fluid tokens at semantic text levels only (body, headings, captions) — NOT on
 * every nested element. Uses the clamp() token set from ARCHITECTURE.md.
 *
 * Wrappers are sanctioned. Never rebuild the tree. Excluded subtrees are
 * skipped by the solver, restyled only. matched-targets = 0 is a HARD
 * COMPILER ERROR, never a silent skip.
 */

import type { LayoutIR, LayoutIRNode, LayoutConstraint, ConstraintPriority } from './ir.ts';
import { currentConstraints } from './ir.ts';
import type { SlotAssignment } from './assign.ts';
import type { SlotDef } from './languages/documentation.ts';
import { DOCUMENTATION_SLOTS } from './languages/documentation.ts';

// ── Fluid token set (from ARCHITECTURE.md, applied at semantic text levels only) ──

const FLUID_TOKENS = `
  --wm-step-0: clamp(1rem, 0.95rem + 0.3vw, 1.125rem);
  --wm-step-1: clamp(1.25rem, 1.1rem + 0.8vw, 1.6rem);
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

export interface SolveResult {
  css: string;
  rulesEmitted: number;
  matchedTargets: number;
  impossibleNodes: string[];
  droppedOptionals: { handle: string; kind: string; reason: string }[];
}

// ── Solve ────────────────────────────────────────────────────────────

/** The v1 solver. Takes the Current Layout IR + slot assignment + exclusions,
 *  applies slot constraints, normalizes sizing, and emits responsive CSS.
 *  Pure: no DOM access, no model calls. */
export function solve(input: SolveInput): SolveResult {
  const { ir, assignment, excluded } = input;
  const byHandle = ir.byHandle;
  const slotById = new Map<string, SlotDef>();
  for (const s of DOCUMENTATION_SLOTS) slotById.set(s.id, s);

  // ── 1. Validate + build target constraints per node ──────────────
  // Merge the node's current arrangement (law) with the slot's constraints
  // (language). Priority: required > preferred > optional. The model never
  // assigns priority.
  const targetConstraints = new Map<string, LayoutConstraint[]>();
  const impossibleNodes: string[] = [];
  const droppedOptionals: { handle: string; kind: string; reason: string }[] = [];

  for (const node of ir.nodes) {
    const current = currentConstraints(byHandle.get(node.handle)!);
    const slotId = assignment.handleToSlot.get(node.handle) ?? 'overflow';
    const slot = slotById.get(slotId);
    // The slot's constraints become language-priority constraints on the node.
    const slotConstraints: LayoutConstraint[] = slot
      ? slot.constraints.map((c) => ({ kind: c.kind, priority: c.priority, source: 'language' as const, value: c.value }))
      : [];

    // Merge: law constraints + language constraints. Conflict resolution is
    // by priority: required beats preferred beats optional. If two REQUIRED
    // constraints of the same kind conflict, mark IMPOSSIBLE.
    const merged = mergeConstraints(node.handle, current, slotConstraints, impossibleNodes, droppedOptionals);
    targetConstraints.set(node.handle, merged);
  }

  // ── 2. Propagate parent constraints to children ───────────────────
  // Parent MaxWidth + child FillParent → child width: min(100%, maxWidth).
  // We annotate each child with the parent's MaxWidth value for CSS emission.
  const parentMaxWidth = new Map<string, string | null>();
  for (const node of ir.nodes) {
    const parent = node.computedRelationships.parent;
    const parentConstraints = parent ? targetConstraints.get(parent) : undefined;
    const parentMax = parentConstraints?.find((c) => c.kind === 'MaxWidth');
    parentMaxWidth.set(node.handle, parentMax?.value ?? null);
  }

  // ── 3-5. Choose flex/grid, normalize sizing, emit CSS ─────────────
  const blocks: string[] = [];
  let rulesEmitted = 0;
  let matchedTargets = 0;

  // Emit the fluid token set on :root (once, at the top).
  blocks.push(`:root {${FLUID_TOKENS}\n}`);

  for (const node of ir.nodes) {
    // Excluded subtrees are skipped by the solver — restyle only, no layout CSS.
    if (excluded.has(node.handle)) continue;

    const constraints = targetConstraints.get(node.handle) ?? [];
    const decls = constraintsToCSS(node, constraints, parentMaxWidth.get(node.handle), slotById, assignment);
    if (decls.length === 0) continue;

    const selector = `[data-wm-c="${node.handle}"]`;
    blocks.push(`${selector} {\n${decls.map((d) => `  ${d};`).join('\n')}\n}`);
    rulesEmitted++;
    matchedTargets++;
  }

  // matched-targets = 0 is a HARD COMPILER ERROR.
  if (matchedTargets === 0) {
    throw new Error('solve: matched-targets = 0 — no nodes received layout CSS. This is a compiler error.');
  }

  const css = blocks.join('\n\n');
  return { css, rulesEmitted, matchedTargets, impossibleNodes, droppedOptionals };
}

// ── Constraint merge (priority sort, never "first wins") ─────────────

/** Merge current (law) + slot (language) constraints. Required beats preferred
 *  beats optional. If two REQUIRED of the same kind conflict, mark IMPOSSIBLE.
 *  Dropped optionals are logged. */
function mergeConstraints(
  handle: string,
  current: LayoutConstraint[],
  slot: LayoutConstraint[],
  impossibleNodes: string[],
  droppedOptionals: { handle: string; kind: string; reason: string }[],
): LayoutConstraint[] {
  // Group by kind. Within each kind, pick the highest-priority constraint.
  // If two required constraints of the same kind conflict, mark IMPOSSIBLE.
  const byKind = new Map<string, LayoutConstraint[]>();
  for (const c of [...current, ...slot]) {
    const arr = byKind.get(c.kind) ?? [];
    arr.push(c);
    byKind.set(c.kind, arr);
  }

  const out: LayoutConstraint[] = [];
  for (const [kind, candidates] of byKind) {
    // Sort by priority: required > preferred > optional.
    const priorityRank: Record<ConstraintPriority, number> = { required: 0, preferred: 1, optional: 2 };
    candidates.sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority]);

    const required = candidates.filter((c) => c.priority === 'required');
    if (required.length > 1) {
      // Two required of the same kind — check for conflict (different values).
      const values = new Set(required.map((c) => c.value ?? ''));
      if (values.size > 1) {
        impossibleNodes.push(handle);
        // Keep the first required (law priority); log the conflict.
        out.push(required[0]);
        continue;
      }
    }

    // Pick the highest-priority constraint. Log dropped optionals.
    const winner = candidates[0];
    out.push(winner);
    for (let i = 1; i < candidates.length; i++) {
      if (candidates[i].priority === 'optional') {
        droppedOptionals.push({ handle, kind: candidates[i].kind, reason: `dropped for ${winner.priority} ${kind}` });
      }
    }
  }
  return out;
}

// ── Constraint → CSS emission ────────────────────────────────────────

/** Convert a node's target constraints to CSS declarations. */
function constraintsToCSS(
  node: LayoutIRNode,
  constraints: LayoutConstraint[],
  parentMax: string | null,
  slotById: Map<string, SlotDef>,
  assignment: SlotAssignment,
): string[] {
  const decls: string[] = [];
  const a = node.authoredLayout;
  const slotId = assignment.handleToSlot.get(node.handle) ?? 'overflow';
  const slot = slotById.get(slotId);

  // ── Layout: Flex or Grid per container ──
  // The solver chooses based on the slot's flow + the node's authored layout.
  // Wrap-don't-replace: if the node already has flex/grid, keep it.
  if (a.isContainer) {
    const stackVert = constraints.find((c) => c.kind === 'StackVertically');
    const wrap = constraints.find((c) => c.kind === 'WrapOnOverflow');
    const align = constraints.find((c) => c.kind === 'Alignment');

    if (stackVert && stackVert.priority !== 'optional') {
      // StackVertically (required/preferred) → flex-column.
      if (!a.isFlex && !a.isGrid) {
        decls.push('display: flex');
        decls.push('flex-direction: column');
      }
      // If already flex/grid, the authored layout is preserved (wrap-don't-replace).
    }
    if (wrap) {
      decls.push('flex-wrap: wrap');
    }
    if (align?.value) {
      const v = align.value;
      if (v === 'start') decls.push('align-items: flex-start');
      else if (v === 'center') { decls.push('align-items: center'); decls.push('justify-content: center'); }
      else if (v === 'end') decls.push('align-items: flex-end');
      else if (v === 'stretch') decls.push('align-items: stretch');
    }
  }

  // ── Width: FillParent + MaxWidth propagation ──
  const fillParent = constraints.find((c) => c.kind === 'FillParent');
  const maxWidth = constraints.find((c) => c.kind === 'MaxWidth');

  if (fillParent) {
    // FillParent: width follows parent. If the parent has a MaxWidth, emit
    // width: min(100%, <parentMax>) to respect both. Do not refuse. Do not
    // pick one. (The worked propagation example from ARCHITECTURE.md.)
    if (a.intrinsicSizing === 'fixed' || a.intrinsicSizing === 'fluid') {
      // Normalize a fixed/fluid authored width to responsive.
      const pm = parentMax && parentMax !== '100%' ? parentMaxValue(parentMax) : null;
      const mw = maxWidth ? maxWidthValue(maxWidth.value, slot) : null;
      if (pm && mw && pm !== '100%' && mw !== '100%') {
        decls.push(`width: min(100%, min(${pm}, ${mw}))`);
      } else if (pm && pm !== '100%') {
        decls.push(`width: min(100%, ${pm})`);
      } else if (mw && mw !== '100%') {
        decls.push(`width: min(100%, ${mw})`);
      } else {
        decls.push('width: 100%');
      }
    }
    // If already auto-width (block), no width declaration needed — it fills parent by default.
  }

  // ── MaxWidth: the slot's measure ceiling ──
  // For CSS emission, prefer the slot's MaxWidth semantic value ('prose', 'side',
  // 'compact') over the law's generic 'partial'. The law says "there's a ceiling";
  // the slot says "what the ceiling is."
  const slotMaxWidth = slot?.constraints.find((c) => c.kind === 'MaxWidth');
  if (slotMaxWidth && slotMaxWidth.value !== 'partial') {
    decls.push(`max-width: ${maxWidthValue(slotMaxWidth.value, slot)}`);
  } else if (maxWidth) {
    const mw = maxWidthValue(maxWidth.value, slot);
    if (mw !== '100%') decls.push(`max-width: ${mw}`);
  } else if (slot?.preferredWidth === 'content') {
    // Content slot with no explicit MaxWidth: use a prose measure (65ch).
    decls.push('max-width: 65ch');
  } else if (slot?.preferredWidth === 'side' && !maxWidth) {
    // Side slot: cap at the slot's minWidth or a reasonable side width.
    decls.push(`max-width: ${Math.max(slot.minWidth, 300)}px`);
  }

  // ── Centered: margin-inline auto ──
  const centered = constraints.find((c) => c.kind === 'Centered');
  if (centered) {
    decls.push('margin-inline: auto');
  } else if (slot?.preferredWidth === 'content' && !a.centered) {
    // Content that should be centered but isn't: center it.
    decls.push('margin-inline: auto');
  }

  // ── AspectRatio: preserve intrinsic ratio (media) ──
  const aspect = constraints.find((c) => c.kind === 'AspectRatio');
  if (aspect?.value) {
    decls.push(`aspect-ratio: ${aspect.value}`);
  }

  // ── Gap: spacing between children (scale step) ──
  const gap = constraints.find((c) => c.kind === 'Gap');
  if (gap?.value) {
    const token = gap.value === 's' ? 'var(--wm-space-s)' : gap.value === 'l' ? 'var(--wm-space-l)' : 'var(--wm-space-m)';
    decls.push(`gap: ${token}`);
  }

  // ── Fluid font sizing at semantic text levels only ──
  // Normalize raw px font sizes to clamp() tokens. Applied ONLY at semantic
  // text levels (body, headings, captions) — NOT on every nested element.
  // The role determines the text level.
  const role = node.semantic.role;
  if (isSemanticText(role)) {
    const token = fontSizeToken(a, role);
    if (token) decls.push(`font-size: ${token}`);
  }

  // ── Overflow safety: prevent horizontal scroll ──
  // Any node with a fixed/fluid width that could overflow gets overflow-x: clip
  // as a safety net. This is a law (no horizontal scrolling), not a design choice.
  if (a.intrinsicSizing === 'fixed' && !decls.some((d) => d.startsWith('width:'))) {
    decls.push('max-width: 100%');
  }

  return decls;
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Is this role a semantic text level (body, headings, captions)? */
function isSemanticText(role: string): boolean {
  return role === 'article-body' || role === 'page-title' || role === 'metadata' ||
    role === 'listing' || role === 'comments' || role === 'toc';
}

/** Map a node's font size to a fluid clamp() token based on its role + size. */
function fontSizeToken(a: LayoutIRNode['authoredLayout'], role: string): string | null {
  // Extract the raw px font size from the widthRatio bucket (coarse).
  // The IR doesn't carry the raw fontSize; we infer the text level from the role.
  // page-title → step-2 (display), headings → step-1, body/metadata → step-0.
  if (role === 'page-title') return 'var(--wm-step-2)';
  if (role === 'article-body') return 'var(--wm-step-0)';
  if (role === 'metadata') return 'var(--wm-step-0)';
  if (role === 'listing' || role === 'comments' || role === 'toc') return 'var(--wm-step-0)';
  return null;
}

/** Resolve a MaxWidth value to a CSS px value. */
function maxWidthValue(value: string | undefined, slot: SlotDef | undefined): string {
  if (value === 'prose') return '65ch';
  if (value === 'side') return `${Math.max(slot?.minWidth ?? 200, 300)}px`;
  if (value === 'compact') return `${Math.max(slot?.minWidth ?? 160, 200)}px`;
  if (value === 'partial') return '100%';
  return value ?? '100%';
}

/** Resolve a parent MaxWidth value to a CSS value. */
function parentMaxValue(value: string | null): string {
  if (!value) return '100%';
  return maxWidthValue(value, undefined);
}

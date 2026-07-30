/**
 * core/layout/languages/documentation — the Documentation layout language.
 * Phase 2.5, Step 1.5D (D1).
 *
 * PURE DATA, no logic. Defines the slots a Documentation page lays out into, the
 * roles each slot accepts, and the constraints each slot carries. ONE language.
 *
 * The overflow slot is NOT a junk drawer: end of document flow, full measure,
 * preserves original relative order and stacking, inherits main's typography,
 * never hidden, never visually degraded.
 */

import type { DesignRole } from '../../perceive/semantic.ts';
import type { ConstraintPriority } from '../ir.ts';

export type SlotId =
  | 'masthead' | 'nav-local' | 'toc' | 'main' | 'footer' | 'overflow';

export interface SlotConstraint {
  kind: string;           // a ConstraintKind string (FillParent, MaxWidth, etc.)
  priority: ConstraintPriority;
  value?: string;
}

export interface SlotDef {
  id: SlotId;
  allowedRoles: DesignRole[];
  preferredWidth: 'full' | 'side' | 'content';
  flow: 'row' | 'column';
  ordering: 'source' | 'reverse' | 'stack';
  minWidth: number;       // px minimum (the solver respects this)
  constraints: SlotConstraint[];
}

export const DOCUMENTATION_SLOTS: readonly SlotDef[] = [
  {
    id: 'masthead',
    allowedRoles: ['page-title', 'nav-primary', 'search', 'toolbar', 'actions-primary'],
    preferredWidth: 'full',
    flow: 'row',
    ordering: 'source',
    minWidth: 0,
    constraints: [
      { kind: 'FillParent', priority: 'required' },
      { kind: 'StackVertically', priority: 'preferred' },
    ],
  },
  {
    id: 'nav-local',
    // On Documentation pages, a sidebar IS the side navigation panel. Merging
    // sidebar into nav-local makes sidebar <-> nav-local role flips cosmetic
    // (both land in the same slot → the layout is identical).
    allowedRoles: ['nav-local', 'sidebar'],
    preferredWidth: 'side',
    flow: 'column',
    ordering: 'source',
    minWidth: 180,
    constraints: [
      { kind: 'MaxWidth', priority: 'preferred', value: 'side' },
      { kind: 'StackVertically', priority: 'required' },
    ],
  },
  {
    id: 'toc',
    // X2: TOC role wired here. A table-of-contents is detected by principled
    // signals (fragment-anchor links pointing at headings, outside main flow).
    allowedRoles: ['toc'],
    preferredWidth: 'side',
    flow: 'column',
    ordering: 'source',
    minWidth: 160,
    constraints: [
      { kind: 'MaxWidth', priority: 'preferred', value: 'compact' },
      { kind: 'StackVertically', priority: 'required' },
    ],
  },
  {
    id: 'main',
    allowedRoles: ['article-body', 'listing', 'media', 'comments', 'metadata'],
    preferredWidth: 'content',
    flow: 'column',
    ordering: 'source',
    minWidth: 320,
    constraints: [
      { kind: 'MaxWidth', priority: 'preferred', value: 'prose' },
      { kind: 'StackVertically', priority: 'required' },
      { kind: 'FillParent', priority: 'preferred' },
    ],
  },
  {
    id: 'footer',
    allowedRoles: ['footer-chrome'],
    preferredWidth: 'full',
    flow: 'row',
    ordering: 'source',
    minWidth: 0,
    constraints: [
      { kind: 'FillParent', priority: 'required' },
      { kind: 'StackVertically', priority: 'preferred' },
    ],
  },
  {
    id: 'overflow',
    // The overflow slot is NOT a junk drawer. End of document flow, full measure,
    // preserves original relative order and stacking, inherits main's typography,
    // never hidden, never visually degraded. Catches unmatched/unknown nodes.
    allowedRoles: [],
    preferredWidth: 'full',
    flow: 'column',
    ordering: 'source',
    minWidth: 0,
    constraints: [
      { kind: 'FillParent', priority: 'required' },
      { kind: 'StackVertically', priority: 'preferred' },
    ],
  },
] as const;

/** Reverse lookup: role → slot id. First matching slot wins (slots are ordered).
 *  A role not in any slot's allowedRoles → null (assigns to overflow). */
const ROLE_TO_SLOT: ReadonlyMap<DesignRole, SlotId> = (() => {
  const m = new Map<DesignRole, SlotId>();
  for (const slot of DOCUMENTATION_SLOTS) {
    for (const role of slot.allowedRoles) {
      if (!m.has(role)) m.set(role, slot.id); // first match wins
    }
  }
  return m;
})();

export function slotForRole(role: DesignRole): SlotId | null {
  return ROLE_TO_SLOT.get(role) ?? null;
}

/**
 * core/layout/languages/documentation — the Documentation layout language.
 *
 * PURE DATA, no logic. Defines the slots a Documentation page lays out into, the
 * roles each slot accepts, and the constraints each slot carries. The fallback
 * language: when the model emits no language choice, this is what the page lays
 * out into.
 *
 * The overflow slot is NOT a junk drawer: end of document flow, full measure,
 * preserves original relative order and stacking, inherits main's typography,
 * never hidden, never visually degraded.
 */

import type { DesignRole } from '../../perceive/semantic.ts';
import type { LayoutLanguage, SlotDef } from './types.ts';

export const DOCUMENTATION: LayoutLanguage = {
  id: 'documentation',
  name: 'Documentation',
  description: 'Information-dense reading pages: articles, docs, references. A masthead, local nav or TOC rail, a prose main column, a footer.',
  archetypes: ['single-column', 'two-column-rail-left', 'two-column-rail-right', 'three-column'],
  suits: {
    roles: ['article-body', 'page-title', 'nav-local', 'toc', 'metadata'],
    componentTypes: ['prose', 'nav', 'list'],
    cardCount: 'low',
    mediaCount: 'low',
    proseVolume: 'dense',
  },
  slots: [
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
      // A sidebar IS the side navigation panel on Documentation pages. Merging
      // sidebar into nav-local makes sidebar <-> nav-local role flips cosmetic
      // (both land in the same slot -> the layout is identical).
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
      // TOC: detected by principled signals (fragment-anchor links pointing at
      // headings, outside main flow).
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
      // NOT a junk drawer. End of document flow, full measure, preserves original
      // relative order and stacking, inherits main's typography, never hidden,
      // never visually degraded. Catches unmatched/unknown nodes.
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
  ] as const,
};

// Re-export the data shapes so existing imports keep compiling during the
// transition. callers move to the LayoutLanguage API in index.ts.
export type { SlotConstraint, SlotDef } from './types.ts';

/** The Documentation slots, in order. Kept for the assigner's slotToHandles map. */
export const DOCUMENTATION_SLOTS: readonly SlotDef[] = DOCUMENTATION.slots;

/** Reverse lookup kept for backward-compat: role -> documentation slot id.
 *  New code uses the language-aware slotForRole in types.ts. */
export function slotForRole(role: DesignRole): string | null {
  for (const slot of DOCUMENTATION.slots) {
    if (slot.allowedRoles.includes(role)) return slot.id;
  }
  return null;
}
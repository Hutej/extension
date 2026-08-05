/**
 * core/layout/languages/types — the LayoutLanguage contract.
 *
 * A layout language is NOT CSS and NOT HTML. It is PURE DATA: the slots a page
 * lays out into, the roles each slot accepts, the constraints each slot carries
 * (each with a priority), the archetypes the language supports, and the
 * perception signals the language suits. The model chooses a language from a
 * shortlist perception proposes; the deterministic engine assigns regions into
 * the chosen language's slots and the solver emits CSS.
 *
 * ONE rule, from the architecture: the AI owns design decisions, the Layout IR
 * owns structure, the solver owns constraints, the compiler owns CSS. A layout
 * language is DATA the engine reads — it owns none of those decisions.
 *
 * Pure data, no logic beyond role->slot lookup. One language per file; the
 * registry in index.ts imports them all.
 */

import type { DesignRole } from '../../perceive/semantic.ts';
import type { ConstraintPriority } from '../ir.ts';

/** A constraint a slot places on its members, with a priority the solver reads. */
export interface SlotConstraint {
  /** A ConstraintKind string (FillParent, MaxWidth, StackVertically, ...). */
  kind: string;
  priority: ConstraintPriority;
  /** A semantic token, never a raw px measurement (see LayoutConstraint.value). */
  value?: string;
}

/** A slot definition. The solver respects minWidth and emits the constraints. */
export interface SlotDef {
  id: string;
  /** Design roles this slot accepts. First matching slot wins (slots ordered). */
  allowedRoles: DesignRole[];
  /** How the slot's width relates to the grid: full = span all tracks, side = a
   *  rail track, content = the main content track. Drives the fallback IR. */
  preferredWidth: 'full' | 'side' | 'content';
  flow: 'row' | 'column';
  ordering: 'source' | 'reverse' | 'stack';
  /** px minimum the solver respects (a floor, never an emitted measurement). */
  minWidth: number;
  constraints: SlotConstraint[];
}

/** Perception signals a language suits — measurement PROPOSES candidates, it
 *  does not SELECT. The model selects. These are scoring inputs. */
export interface LanguageSuits {
  /** Design roles the language is built around (high signal). */
  roles: DesignRole[];
  /** Component types the language suits (card, media, prose, list, nav, ...). */
  componentTypes: string[];
  cardCount: 'low' | 'medium' | 'high';
  mediaCount: 'low' | 'medium' | 'high';
  proseVolume: 'sparse' | 'moderate' | 'dense';
}

/** The contract every layout language file exports as a `LayoutLanguage`. */
export interface LayoutLanguage {
  /** Stable id, referenced by the model in the `language` relation. */
  id: string;
  /** Human name. */
  name: string;
  /** One-line description written for the model to read in the candidate shortlist. */
  description: string;
  /** Ordered slot list. The LAST slot is the overflow slot — it catches every
   *  unmatched region so no node is ever left unplaced. allowedRoles is empty
   *  on the overflow slot by convention (everything falls through to it). */
  slots: readonly SlotDef[];
  /** Archetype ids this language supports (ids into the ARCHETYPES registry in
   *  ir.ts). The first is the language's default archetype. The model picks one;
   *  resolveComposition validates the pick is in this list. */
  archetypes: readonly string[];
  /** Perception signals this language suits. Used by proposeLanguageCandidates. */
  suits: LanguageSuits;
}

/** The overflow slot of a language (its last slot). Every language has one. */
export function overflowSlot(lang: LayoutLanguage): SlotDef {
  return lang.slots[lang.slots.length - 1];
}

/** Language-aware role -> slot lookup. First matching slot wins (slots are
 *  ordered). A role in no slot's allowedRoles -> the overflow slot. Pure. */
export function slotForRole(lang: LayoutLanguage, role: DesignRole): string {
  for (const slot of lang.slots) {
    if (slot.allowedRoles.includes(role)) return slot.id;
  }
  return overflowSlot(lang).id;
}

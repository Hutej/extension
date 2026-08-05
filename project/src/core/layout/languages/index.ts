/**
 * core/layout/languages — the layout-language registry + candidate proposal.
 *
 * One pipeline ships SEVEN languages now: documentation (the fallback) plus
 * dashboard, bento, editorial, feed, split-view, gallery. Each is PURE DATA in
 * its own file (a LayoutLanguage). The model picks one from a shortlist; the
 * deterministic engine assigns regions into the chosen language's slots.
 *
 * Selection discipline (from the architecture): a language is NEVER selected by
 * measurement alone — measurement only PROPOSES candidates. Perception scores
 * each language against its own signals (role inventory, component types, card
 * count, media count, prose volume) and returns the top 3-5. The Architect
 * sees only that shortlist with each language's one-line description, then
 * emits the `language` relation. The model decides; measurement does not.
 */

import type { Perception } from '../../perceive/index.ts';
import type { DesignRole } from '../../perceive/semantic.ts';
import type { LayoutLanguage } from './types.ts';
import { DOCUMENTATION } from './documentation.ts';
import { DASHBOARD } from './dashboard.ts';
import { BENTO } from './bento.ts';
import { EDITORIAL } from './editorial.ts';
import { FEED } from './feed.ts';
import { SPLIT_VIEW } from './split-view.ts';
import { GALLERY } from './gallery.ts';

export type { LayoutLanguage, SlotDef, SlotConstraint, LanguageSuits } from './types.ts';
export { slotForRole, overflowSlot } from './types.ts';

/** All seven languages, ordered with documentation last (the fallback). */
export const LANGUAGES: readonly LayoutLanguage[] = [
  DASHBOARD, BENTO, EDITORIAL, FEED, SPLIT_VIEW, GALLERY, DOCUMENTATION,
];

const LANGUAGES_BY_ID = new Map<string, LayoutLanguage>(LANGUAGES.map((l) => [l.id, l]));

/** The set of valid language ids (for the validator). */
export const LANGUAGE_IDS = new Set<string>(LANGUAGES.map((l) => l.id));

/** Resolve a language id to its definition. Returns the documentation language
 *  (the fallback) when the id is unknown — a model naming a non-existent
 *  language falls back, never crashes. */
export function getLanguage(id: string | undefined): LayoutLanguage {
  if (id && LANGUAGES_BY_ID.has(id)) return LANGUAGES_BY_ID.get(id)!;
  return DOCUMENTATION;
}

export interface LanguageCandidate {
  id: string;
  description: string;
}

/** Score a language against a perception: how many of its suited roles are
 *  present, how many suited component types, and how well the card/media/prose
 *  levels match the page. Pure; takes perception as data. */
function scoreLanguage(lang: LayoutLanguage, p: Perception): number {
  const roleSet = new Set<DesignRole>(p.clusters.map((c) => c.designRole));
  const compSet = new Set<string>(p.clusters.map((c) => c.componentType));

  let score = 0;
  // Role overlap: each suited role present adds 1.
  for (const r of lang.suits.roles) if (roleSet.has(r)) score += 1.5;
  // Component-type overlap: each suited type present adds 1.
  for (const t of lang.suits.componentTypes) if (compSet.has(t)) score += 1;

  // Card / media / prose level matching.
  const cardCount = p.clusters.filter((c) => c.componentType === 'card').length;
  const mediaCount = p.clusters.filter((c) => c.componentType === 'media' || c.designRole === 'media').length;
  const proseLen = p.clusters.reduce((a, c) => a + (c.textProfile?.readingLength ?? 0), 0);
  const proseLevel = proseLen > 4000 ? 'dense' : proseLen > 1000 ? 'moderate' : 'sparse';

  if (countToLevel(cardCount, 'card') === lang.suits.cardCount) score += 1;
  if (countToLevel(mediaCount, 'media') === lang.suits.mediaCount) score += 1;
  if (proseLevel === lang.suits.proseVolume) score += 1;

  return score;
}

function countToLevel(n: number, kind: 'card' | 'media'): 'low' | 'medium' | 'high' {
  if (kind === 'media') return n >= 5 ? 'high' : n >= 2 ? 'medium' : 'low';
  return n >= 6 ? 'high' : n >= 2 ? 'medium' : 'low';
}

/** Propose 3-5 candidate languages from perception signals. Measurement
 *  PROPOSES; it does not SELECT. Documentation is always included as the
 *  safety fallback. Pure: takes perception as data, returns candidates. */
export function proposeLanguageCandidates(p: Perception): LanguageCandidate[] {
  const scored = LANGUAGES.map((l) => ({ lang: l, score: scoreLanguage(l, p) }));
  scored.sort((a, b) => b.score - a.score);
  // Top 5, but always at least 3, and documentation always included as fallback.
  const top = scored.slice(0, 5);
  const ids = new Set(top.map((s) => s.lang.id));
  if (!ids.has(DOCUMENTATION.id)) top.push({ lang: DOCUMENTATION, score: 0 });
  // Return at least 3 (pad from the remainder if we trimmed).
  const rest = scored.filter((s) => !ids.has(s.lang.id));
  while (top.length < 3 && rest.length) {
    const next = rest.shift()!;
    top.push(next);
    ids.add(next.lang.id);
  }
  return top.map((s) => ({ id: s.lang.id, description: s.lang.description }));
}

/** The candidate shortlist as a model-readable string for the Architect prompt. */
export function formatCandidates(candidates: LanguageCandidate[]): string {
  return candidates.map((c) => `- ${c.id}: ${c.description}`).join('\n');
}

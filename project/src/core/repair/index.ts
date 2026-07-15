/**
 * core/repair — route each failure to the cheapest fix that can work.
 *
 *   deterministic (no model call, each fixes only the check it can fix):
 *     contrast          -> forceContrast
 *     over-accent       -> trimAccent (strip bg from repeated/low-prominence clusters)
 *     overflow/overlap  -> clampTargets (clamp ONLY offending clusters) -> dropLayout (last resort, loud)
 *   regenerative (bounded model re-ask with a concrete critique):
 *     flat / still-incoherent / over-framed / under-covered -> reReason
 *   keepBest — keep the best NON-BROKEN attempt (never revert a merely-flat result)
 *   rollback — ONLY when content is actually broken (notBlank=false) and
 *   stripping hide rules did not bring it back
 *
 * KEY POLICY: overflow repairs run ONLY for overflow/overlap failures — they can
 * never reduce accent area, so they are never spent on a coherence failure (the
 * bug that burned the whole ladder before ever reaching the accent fix).
 */

import type { CompileOptions } from '../compile';
import type { VerifyResult } from '../verify';
import type { DesignSpec } from '../spec';
import { MAX_REPAIR_ATTEMPTS } from '../config';
import { MAX_ACCENT_FRACTION } from '../laws';

export interface RepairDecision {
  action: 'recompile' | 'reReason' | 'keepBest' | 'rollback';
  options: CompileOptions;
  critique?: string;
  reason: string;
}

export interface Attempt {
  spec: DesignSpec;
  css: string;
  notBroken: boolean;   // notBlank && noOverflow && noOverlap && contrastOk
  changeScore: number;
}

export function planRepair(verify: VerifyResult, prev: CompileOptions, reReasonsDone: number, paletteMode?: 'restrained' | 'vivid'): RepairDecision {
  const c = verify.checks;

  // Broken content is the only rollback path (after trying to strip hides).
  if (!c.notBlank) {
    if (!prev.dropHides) return { action: 'recompile', options: { ...prev, dropHides: true }, reason: 'content blanked — drop hides first' };
    return { action: 'rollback', options: prev, reason: 'content blanked' };
  }

  // ── Deterministic fixes: each targets ONLY the check it can actually fix, and
  // each is applied at most once (gated on the option not yet being set). We take
  // the highest-priority available fix, recompile, and re-verify — so multiple
  // simultaneous failures are handled one cheap recompile at a time. Overflow
  // repairs (padding/sizing/layout) run ONLY for overflow/overlap failures — they
  // can never reduce accent, so they must not be spent on a coherence failure.

  // Contrast: force a readable text color — the canvas body floor PLUS the
  // specific handles the sampler flagged (dark text on a dark painted block).
  if (!c.contrastOk && !prev.forceContrast) {
    return { action: 'recompile', options: { ...prev, forceContrast: true, contrastTargets: verify.contrastTargets }, reason: `force contrast (${verify.contrastTargets.length} flagged handle(s))` };
  }

  // Over-accent: strip accent backgrounds from repeated/low-prominence clusters
  // BEFORE spending a paid reReason. Triggered by the absolute repeated-accent
  // law (any mode) OR by area overflow (restrained only — vivid lifts the cap).
  // (Framing has no deterministic trim — it goes straight to reReason below.)
  const effectiveMaxAccent = paletteMode === 'vivid' ? Infinity : MAX_ACCENT_FRACTION;
  if (!c.coherent && !prev.trimAccent && (verify.repeatedAccent || verify.accentFraction > effectiveMaxAccent)) {
    const why = verify.repeatedAccent ? 'identical accent on repeated cluster (absolute law)' : 'over area budget';
    return { action: 'recompile', options: { ...prev, trimAccent: true }, reason: `trim accent (${why})` };
  }

  // Overflow / overlap: squeeze repair FIRST (drop columnCount on squeezed
  // clusters — free, targeted, kills the one-char-per-line failure), then
  // word-break for text bleeds, then targeted clamp on geometric overflow,
  // then blanket dropLayout (last resort).
  if (!c.noOverflow || !c.noOverlap) {
    if (verify.squeezeTargets.length && !prev.squeezeTargets) {
      return { action: 'recompile', options: { ...prev, squeezeTargets: verify.squeezeTargets }, reason: `squeeze repair on ${verify.squeezeTargets.length} cluster(s): ${verify.squeezeTargets.slice(0, 6).join(',')}` };
    }
    if (verify.bleedTargets.length && !prev.wordBreakTargets) {
      return { action: 'recompile', options: { ...prev, wordBreakTargets: verify.bleedTargets }, reason: `word-break on ${verify.bleedTargets.length} bleeding cluster(s): ${verify.bleedTargets.slice(0, 6).join(',')}` };
    }
    if (verify.overflowTargets.length && !prev.clampTargets) {
      return { action: 'recompile', options: { ...prev, clampTargets: verify.overflowTargets }, reason: `clamp ${verify.overflowTargets.length} overflowing cluster(s): ${verify.overflowTargets.slice(0, 6).join(',')}` };
    }
    if (!prev.dropLayout) {
      return { action: 'recompile', options: { ...prev, dropLayout: true }, reason: 'LOUD: dropLayout fired — design collapsed to paint (failure signal)' };
    }
    // Overflow truly unfixable and nothing else pending — keep the best attempt.
    if (c.changed && c.coherent && c.covered) return { action: 'keepBest', options: prev, reason: 'structural fixes exhausted' };
  }

  // ── Regenerative tier: quality failures a deterministic pass can't fix
  // (flat / still-incoherent after trim / over-framed / under-covered).
  if (!c.changed || !c.coherent || !c.covered) {
    if (reReasonsDone >= MAX_REPAIR_ATTEMPTS) return { action: 'keepBest', options: prev, reason: 'reReason budget exhausted' };
    return { action: 'reReason', options: prev, critique: critiqueFor(verify), reason: 'regenerate for quality' };
  }

  return { action: 'keepBest', options: prev, reason: 'no further repair' };
}

function critiqueFor(verify: VerifyResult): string {
  if (!verify.checks.changed) {
    return `Your previous design changed almost NO layout (changeScore=${verify.changeScore.toFixed(2)}). A recolor is not a redesign. You MUST alter arrangement AND the page background: change container/content widths (maxWidth + marginInline:auto), columns/spacing scale, type scale, AND set a deliberate canvas background distinct from the site default.`;
  }
  if (verify.repeatedAccent) {
    return `Your previous design painted the same accent color on every member of a repeated cluster. This is an absolute law: NEVER use an identical accent on every row of a repeated cluster (every card in a grid, every item in a list). It collapses the accent into a new background and destroys hierarchy. Treat repeated items as calm secondary surfaces; reserve the accent for the one or two singular, prominent regions.`;
  }
  if (!verify.checks.covered) {
    return `Your previous design left ${(100 - verify.coverageFraction * 100).toFixed(0)}% of the page's regions in their ORIGINAL look (coverage=${verify.coverageFraction.toFixed(2)}). Every region must be part of the design: restyle it into the new system, or set "hide": true on chrome (utility sidebars, banners, settings/appearance panels) that does not serve the requested experience. A page with original-looking patches is not a redesign. A text-color-only change on a background that clashes with your canvas does NOT count — repaint or hide those regions.`;
  }
  if (verify.accentFraction > MAX_ACCENT_FRACTION) {
    return `Your previous design over-used the accent color (it covered ${(verify.accentFraction * 100).toFixed(0)}% of the page). Accent is EMPHASIS ONLY — a few primary elements. Keep most surfaces calm and establish clear hierarchy.`;
  }
  // over-framed
  return `Your previous design framed almost everything (${(verify.framedFraction * 100).toFixed(0)}% of the page carries heavy borders/shadows). Frames belong on a FEW primary containers only — most content must stay unframed. Add hierarchy: primary vs secondary vs plain, and make the page BACKGROUND carry the aesthetic instead of bordering every cluster.`;
}

/** Highest-changeScore attempt that passed the not-broken checks, or null. */
export function bestNonBroken(attempts: Attempt[]): Attempt | null {
  let best: Attempt | null = null;
  for (const a of attempts) {
    if (!a.notBroken) continue;
    if (!best || a.changeScore > best.changeScore) best = a;
  }
  return best;
}

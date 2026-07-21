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
import type { PixelVerifyResult } from '../verify/pixel';
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
  notBroken: boolean;   // notBlank && noOverflow && noOverlap && contrastOk && contentCollapsed && contentVisible
  changeScore: number;
  covered: boolean;
  coherent: boolean;
  changed: boolean;
  contentCollapsed: boolean;
}

export function planRepair(verify: VerifyResult, prev: CompileOptions, reReasonsDone: number, paletteMode?: 'restrained' | 'vivid', pixel?: PixelVerifyResult | null): RepairDecision {
  const c = verify.checks;
  // WS1: pixel-grounded handles — invisible-text clusters the DOM contrast sampler
  // missed, and pixel-squeeze below the readable measure. Merged into the
  // deterministic repair so paint-2 targets what the USER sees, not just DOM flags.
  const pixelInvisible = pixel?.invisibleText ?? [];
  const pixelSqueeze = pixel?.squeeze ?? [];

  // Broken content is the only rollback path (after trying to strip hides).
  if (!c.notBlank) {
    if (!prev.dropHides) return { action: 'recompile', options: { ...prev, dropHides: true }, reason: 'content blanked — drop hides first' };
    return { action: 'rollback', options: prev, reason: 'content blanked' };
  }

  // Content collapsed (but not fully blanked) — regions shrank to near-zero.
  // Try dropping hides first (display:none causes collapse), then sizing
  // (maxHeight/height constraints), then all layout (flex/grid collapse).
  if (!c.contentCollapsed) {
    if (!prev.dropHides) return { action: 'recompile', options: { ...prev, dropHides: true }, reason: 'content collapsed — drop hides first' };
    // Targeted: drop layout on ONLY the collapsed region(s), preserving the rest of
    // the design. The blanket dropSizing below nukes ALL layout (turns a real reshape
    // into a recolor) — try the surgical fix first.
    if (verify.collapseTargets.length && !prev.collapseTargets) {
      return { action: 'recompile', options: { ...prev, collapseTargets: verify.collapseTargets }, reason: `targeted collapse repair on ${verify.collapseTargets.length} region(s): ${verify.collapseTargets.slice(0, 6).join(',')}` };
    }
    if (!prev.dropSizing) return { action: 'recompile', options: { ...prev, dropSizing: true }, reason: 'content collapsed — drop sizing (height constraints)' };
    if (!prev.dropLayout) return { action: 'recompile', options: { ...prev, dropLayout: true }, reason: 'content collapsed — drop all layout (flex/grid collapse)' };
    // Collapse unfixable (often a parent's layout squeezed the region). DON'T return
    // keepBest here — fall through so contrast/accent/overflow repairs can still fix
    // what's fixable. The keepBest at the end of planRepair catches the rest. This
    // prevents a single unfixable collapse from blocking every other repair (the
    // collapse-monopoly case: accent=1.000 + low contrast went unfixed because collapse monopolized).
  }

  // ── Deterministic fixes: each targets ONLY the check it can actually fix, and
  // each is applied at most once (gated on the option not yet being set). We take
  // the highest-priority available fix, recompile, and re-verify — so multiple
  // simultaneous failures are handled one cheap recompile at a time. Overflow
  // repairs (padding/sizing/layout) run ONLY for overflow/overlap failures — they
  // can never reduce accent, so they must not be spent on a coherence failure.

  // Contrast: force a readable text color — the canvas body floor PLUS the
  // specific handles the sampler flagged (dark text on a dark painted block).
  // WS1: also include pixel-invisible clusters (text rendering with near-zero
  // variance against its bg) — the DOM sampler can miss them; the pixel detector
  // catches them by reading rendered pixels. Trigger if EITHER DOM or pixel flags.
  const contrastHandles = Array.from(new Set([...verify.contrastTargets, ...pixelInvisible]));
  if ((!c.contrastOk || pixelInvisible.length > 0) && !prev.forceContrast) {
    return { action: 'recompile', options: { ...prev, forceContrast: true, contrastTargets: contrastHandles, contrastTargetBgs: verify.contrastTargetBgs }, reason: `force contrast (${contrastHandles.length} handle(s): ${verify.contrastTargets.length} DOM + ${pixelInvisible.length} pixel)` };
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
  // then blanket dropLayout (last resort). Overflow-specific repairs run
  // ONLY when !noOverflow — when !noOverlap alone, skip straight to keepBest
  // (overlap is caused by layout shifting, not by sizing growth).
  // WS1: pixel-squeeze (below readable measure) triggers the squeeze repair even
  // when there is no geometric overflow — the BBC one-word-per-line failure has
  // no overflow but is visibly broken. pixelSqueeze feeds the same target list.
  if (pixelSqueeze.length && !prev.squeezeTargets) {
    return { action: 'recompile', options: { ...prev, squeezeTargets: pixelSqueeze }, reason: `pixel squeeze repair on ${pixelSqueeze.length} cluster(s): ${pixelSqueeze.slice(0, 6).join(',')}` };
  }
  if (!c.noOverflow || !c.noOverlap) {
    if (!c.noOverflow) {
      if (verify.squeezeTargets.length && !prev.squeezeTargets) {
        return { action: 'recompile', options: { ...prev, squeezeTargets: verify.squeezeTargets }, reason: `squeeze repair on ${verify.squeezeTargets.length} cluster(s): ${verify.squeezeTargets.slice(0, 6).join(',')}` };
      }
      if (verify.bleedTargets.length && !prev.wordBreakTargets) {
        return { action: 'recompile', options: { ...prev, wordBreakTargets: verify.bleedTargets }, reason: `word-break on ${verify.bleedTargets.length} bleeding cluster(s): ${verify.bleedTargets.slice(0, 6).join(',')}` };
      }
      // Clip repair: when word-break didn't fix the bleeds (nowrap children or
      // fixed-width elements that can't wrap), clip the overflow. Less destructive
      // than dropLayout — preserves the entire layout.
      if (verify.bleedTargets.length && prev.wordBreakTargets && !prev.clipOverflowTargets) {
        return { action: 'recompile', options: { ...prev, clipOverflowTargets: verify.bleedTargets }, reason: `clip overflow on ${verify.bleedTargets.length} still-bleeding cluster(s) (word-break ineffective)` };
      }
      if (verify.overflowTargets.length && !prev.clampTargets) {
        return { action: 'recompile', options: { ...prev, clampTargets: verify.overflowTargets }, reason: `clamp ${verify.overflowTargets.length} overflowing cluster(s): ${verify.overflowTargets.slice(0, 6).join(',')}` };
      }
      if (!prev.dropLayout) {
        return { action: 'recompile', options: { ...prev, dropLayout: true }, reason: 'LOUD: dropLayout fired — design collapsed to paint (failure signal)' };
      }
    }
    // Overflow truly unfixable and nothing else pending — keep the best attempt.
    if (c.changed && c.coherent && c.covered) return { action: 'keepBest', options: prev, reason: 'structural fixes exhausted' };
  }

  // ── Regenerative tier: quality failures a deterministic pass can't fix
  // (flat / still-incoherent after trim / over-framed / under-covered / no reshape).
  if (!c.changed || !c.coherent || !c.covered || !c.layoutReshaped) {
    if (reReasonsDone >= MAX_REPAIR_ATTEMPTS) return { action: 'keepBest', options: prev, reason: 'reReason budget exhausted' };
    return { action: 'reReason', options: prev, critique: critiqueFor(verify), reason: 'regenerate for quality' };
  }

  return { action: 'keepBest', options: prev, reason: 'no further repair' };
}

function critiqueFor(verify: VerifyResult): string {
  // Collect ALL quality failures — the model needs to fix everything, not just the first.
  const parts: string[] = [];
  if (!verify.checks.changed) {
    parts.push(`Your previous design changed almost NO layout (changeScore=${verify.changeScore.toFixed(2)}). A recolor is not a redesign. You MUST alter arrangement AND the page background: change container/content widths (maxWidth + marginInline:auto), columns/spacing scale, type scale, AND set a deliberate canvas background distinct from the site default.`);
  }
  if (!verify.checks.layoutReshaped) {
    parts.push(`Your previous design did NOT reshape the structure — column count and content width are unchanged (a recolor). You MUST change the column arrangement (gridTemplateColumns) and/or the content width (maxWidth) so the layout visibly differs from the original. A color swap on stock layout is a FAILURE.`);
  }
  if (verify.repeatedAccent) {
    parts.push(`Your previous design painted the same accent color on every member of a repeated cluster. This is an absolute law: NEVER use an identical accent on every row of a repeated cluster. Treat repeated items as calm secondary surfaces; reserve the accent for singular, prominent regions.`);
  }
  if (!verify.checks.covered) {
    parts.push(`Your previous design left ${(100 - verify.coverageFraction * 100).toFixed(0)}% of the page's regions in their ORIGINAL look (coverage=${verify.coverageFraction.toFixed(2)}). Every region must be part of the design: restyle it or set "hide": true on chrome that doesn't serve the aesthetic. Clashing unaccounted regions will be base-coated, but base-coat is a safety net — you must actively design the major clusters.`);
  }
  if (verify.accentFraction > MAX_ACCENT_FRACTION) {
    parts.push(`Your previous design over-used the accent color (${(verify.accentFraction * 100).toFixed(0)}% of the page). Accent is EMPHASIS ONLY — a few primary elements. Keep most surfaces calm.`);
  }
  if (verify.framedFraction > 0.45) {
    parts.push(`Your previous design framed almost everything (${(verify.framedFraction * 100).toFixed(0)}% carries heavy borders). Frames belong on a FEW primary containers only — make the page BACKGROUND carry the aesthetic instead of bordering every cluster.`);
  }
  return parts.join(' ALSO: ') || 'The previous design failed quality checks. Review the page perception and produce a complete, coherent redesign.';
}

/** Best attempt that passed not-broken checks, preferring ones that also pass
 *  quality checks (covered/coherent/changed). If none are notBroken, fall back
 *  to the highest-changeScore attempt — a 90% good design is better than none. */
export function bestNonBroken(attempts: Attempt[]): Attempt | null {
  let best: Attempt | null = null;
  let bestScore = -1;
  for (const a of attempts) {
    if (!a.notBroken) continue;
    const score = (a.changed ? 4 : 0) + (a.coherent ? 2 : 0) + (a.covered ? 1 : 0) + a.changeScore;
    if (score > bestScore) { best = a; bestScore = score; }
  }
  if (best) return best;
  // Fallback: prefer attempts where content is NOT collapsed, then highest changeScore.
  // A design with 2 small collapsed sidebar items is better than no design at all.
  let fallback: Attempt | null = null;
  for (const a of attempts) {
    if (a.contentCollapsed) continue;
    if (!fallback || a.changeScore > fallback.changeScore) fallback = a;
  }
  if (fallback) return fallback;
  // Last resort: highest changeScore among all attempts.
  for (const a of attempts) {
    if (!fallback || a.changeScore > fallback.changeScore) fallback = a;
  }
  return fallback;
}

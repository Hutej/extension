/**
 * core/repair — route each failure to the cheapest fix that can work.
 *
 *   deterministic (no model call, escalating, terminating):
 *     contrast          -> forceContrast
 *     overflow/overlap  -> dropPadding -> dropSizing -> dropLayout (paint only)
 *   regenerative (bounded model re-ask with a concrete critique):
 *     flat / over-accented / over-framed -> reReason
 *   keepBest — keep the best NON-BROKEN attempt (never revert a merely-flat result)
 *   rollback — ONLY when content is actually broken (notBlank=false)
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

export function planRepair(verify: VerifyResult, prev: CompileOptions, reReasonsDone: number): RepairDecision {
  const c = verify.checks;
  if (!c.notBlank) return { action: 'rollback', options: prev, reason: 'content blanked' };

  // Deterministic contrast fix.
  if (!c.contrastOk && !prev.forceContrast) {
    return { action: 'recompile', options: { ...prev, forceContrast: true }, reason: 'force contrast' };
  }

  // Deterministic structural fix (overflow OR overlap), escalating and terminating.
  if (!c.noOverflow || !c.noOverlap) {
    if (!prev.dropPadding) return { action: 'recompile', options: { ...prev, dropPadding: true }, reason: 'drop padding' };
    if (!prev.dropSizing) return { action: 'recompile', options: { ...prev, dropSizing: true }, reason: 'drop sizing' };
    if (!prev.dropLayout) return { action: 'recompile', options: { ...prev, dropLayout: true }, reason: 'drop all layout (paint only)' };
    return { action: 'keepBest', options: prev, reason: 'structural fixes exhausted' };
  }

  // Quality tier — regenerate with a concrete critique, bounded.
  if (!c.changed || !c.coherent) {
    if (reReasonsDone >= MAX_REPAIR_ATTEMPTS) return { action: 'keepBest', options: prev, reason: 'reReason budget exhausted' };
    return { action: 'reReason', options: prev, critique: critiqueFor(verify), reason: 'regenerate for quality' };
  }

  return { action: 'keepBest', options: prev, reason: 'no further repair' };
}

function critiqueFor(verify: VerifyResult): string {
  if (!verify.checks.changed) {
    return `Your previous design changed almost NO layout (changeScore=${verify.changeScore.toFixed(2)}). A recolor is not a redesign. You MUST alter arrangement AND the page background: change container/content widths (maxWidth + marginInline:auto), columns/spacing scale, type scale, AND set a deliberate canvas background distinct from the site default.`;
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

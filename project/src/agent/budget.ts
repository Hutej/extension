/**
 * agent/budget — step count, wall clock, and cost tracking.
 * Exhaustion is not failure — stop, keep what landed, report what was skipped.
 */

import { AI_CONFIG } from '../core/config/index.ts';

export class Budget {
  maxSteps: number;
  maxWallMs: number;
  stepsUsed = 0;
  wallStart = Date.now();
  totalCostMs = 0;

  constructor(opts?: { maxSteps?: number; maxWallMs?: number }) {
    // The config values are the single source of truth (the old 12/60s
    // class defaults were dead code in production — the loop always passes
    // config — and misled readers into thinking the budget was 60s).
    this.maxSteps = opts?.maxSteps ?? AI_CONFIG.maxSteps;
    this.maxWallMs = opts?.maxWallMs ?? AI_CONFIG.maxWallMs;
  }

  exhausted(): boolean {
    return this.stepsUsed >= this.maxSteps || (Date.now() - this.wallStart) >= this.maxWallMs;
  }

  remaining(): { steps: number; wallMs: number } {
    return {
      steps: this.maxSteps - this.stepsUsed,
      wallMs: Math.max(0, this.maxWallMs - (Date.now() - this.wallStart)),
    };
  }

  recordStep(costMs: number = 0): void {
    this.stepsUsed++;
    this.totalCostMs += costMs;
  }

  /** D (Phase 2.5 TASK2): the maximum wall-ms an OBSERVATION call may spend
   *  from this point, so it can never breach the act reserve. The invariant:
   *  observation may only use (remaining - actReserveMs); act owns the reserve.
   *  Never below minTurnMs (a cap below that forbids any call). Pure — testable
   *  without a browser. */
  observationCap(actReserveMs: number, minTurnMs: number): number {
    const rem = this.remaining().wallMs;
    return Math.max(minTurnMs, rem - actReserveMs);
  }

  /** D (Phase 2.5 TASK2): is the act reserve still intact? At the boundary
   *  (remaining == reserve) the reserve is intact — act owns the full reserve
   *  (the loop sets restrictToAct=true and refuses observation). Pure. */
  reserveIntact(actReserveMs: number): boolean {
    return this.remaining().wallMs >= actReserveMs;
  }

  elapsedMs(): number {
    return Date.now() - this.wallStart;
  }
}

/**
 * T2 RELIABILITY AMENDMENT — the terminal disposition policy. PURE (and
 * dependency-free so tests can import it directly). Shared by every terminal
 * failure site in the loop (parse-retry floor, double parse failure, budget
 * exhaustion without done), replacing four duplicated unconditional rollbacks.
 * The verified failure path (proof/T2R_DECISION.md §C): the model applied a
 * valid transformation, the forced checkLayout verified it CLEAN, and a later
 * manufactured timeout (turn caps derived from remaining budget) or budget
 * exhaustion triggered RC3 — destroying verified user-requested work.
 *
 * Policy:
 *   no acts on the page                     → 'keep'    (nothing to destroy)
 *   acts applied, last state verified CLEAN → 'keep'    (do not destroy valid,
 *                                                          verified work)
 *   acts applied, state NOT verified        → 'rollback'(broken-or-unsafe —
 *                                                          RC3's real purpose)
 * "Verified clean" is tracked per-act by the loop's forced checkLayout
 * (baseline-diffed). A successful auto-undo restores the previously verified
 * state, so it does not clear the flag; a FAILED undo leaves a possibly-broken
 * page and does. A checkLayout that itself errored leaves the flag unchanged
 * (unknown — conservative: an initial false rolls back).
 */
export type TerminalDisposition = 'keep' | 'rollback';
export function disposeTerminalRun(hasActed: boolean, verifiedClean: boolean): TerminalDisposition {
  if (!hasActed) return 'keep';
  return verifiedClean ? 'keep' : 'rollback';
}

// ── T3 objective correctness — pure policy helpers ────────────────────

/**
 * Baseline-diff: keep only the strings in `after` that are NOT in `before`,
 * with the loop's normalized-key fallback for a label that shifted a few
 * chars (pre-existing issues are byte-identical pre/post for unchanged
 * elements; the normalized key tolerates a few chars of drift). Extracted
 * here so the checkLayout diff and the resize proof share ONE diff (rule 9 —
 * no second integrity path), and so it is unit-testable without a browser.
 */
export function diffNewIssues(after: string[], before: string[]): string[] {
  const normKey = (s: string) => {
    const m = s.match(/^([^:]+: <[a-z0-9]+> )"([^"]{0,12})/);
    return m ? m[1] + m[2] : s.slice(0, 40);
  };
  return after.filter((iss) => !before.includes(iss) && !before.some((b) => normKey(b) === normKey(iss)));
}

export type ResizeProofOutcome = 'error' | 'clean' | 'issues';

/**
 * T3 resize proof — classify the narrow-width re-check against the narrow
 * baseline. PURE. The proof's contract mirrors the forced checkLayout:
 *   - 'error'  : the dispatch failed or checkLayout errored — we could not
 *                measure; the caller must NOT destroy work on an unknown.
 *   - 'issues' : NEW issues at the narrow width that the narrow baseline did
 *                not have — the transformation breaks a narrower viewport.
 *   - 'clean'  : no new issues (or the proof was skipped: baseline null).
 */
export function classifyResizeProof(
  check: { error?: string; result?: { allIssues?: string[] } } | null,
  baseline: { allIssues: string[] } | null,
): { outcome: ResizeProofOutcome; newIssues: string[] } {
  if (!baseline) return { outcome: 'clean', newIssues: [] }; // skipped — never destroy on a skipped proof
  const dispatchFailed = !check || !!check.error || !check.result;
  if (dispatchFailed) return { outcome: 'error', newIssues: [] };
  const after = check.result?.allIssues ?? [];
  const newIssues = diffNewIssues(after, baseline.allIssues);
  return { outcome: newIssues.length > 0 ? 'issues' : 'clean', newIssues };
}

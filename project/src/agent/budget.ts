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

// ── transport circuit-breaker — pure policy (same section: loop decisions, no browser) ──

/**
 * R3 evidence: when the extension↔tab bridge dies mid-run, EVERY tool dispatch
 * fails with the SAME chrome.runtime.lastError message, the model retries
 * through the loop, and 88 calls / 575s burned with zero effect (req7 alone:
 * 24 blind applyCss calls into a dead port). The loop counts CONSECUTIVE
 * failures of THIS class and ends the run at the cap; any dispatch that is not
 * a transport failure proves the bridge is alive and resets the streak.
 *
 * ONLY chrome's own runtime-messaging failures count. Tool-authored errors
 * (validation, sanitizer/refusal results), dispatch timeouts, generic 'no
 * response from content script', and model parse failures are NOT transport
 * failures — none of them is evidence the bridge is dead, and none may trip
 * the breaker. 2 = the codebase's established consecutive-streak cap
 * (consecutiveNoInfo restricts at 2; the F5 checkLayout breaker trips at 2):
 * two identical pieces of evidence is what the loop already treats as "stop
 * trying".
 */
export const MAX_TRANSPORT_FAILURES = 2;

/** Chrome's own connection-level sendMessage failures — the dead-bridge class.
 *  A tool can never legitimately produce these strings: they originate only in
 *  dispatchTool's chrome.runtime.lastError callback. */
const TRANSPORT_ERROR_MARKERS: readonly string[] = [
  'Could not establish connection. Receiving end does not exist.',
  'The message port closed before a response was received.',
];

/** The transport-failure streak after one more dispatch result. Non-transport
 *  results (success, refusal, validation error, timeout) all prove the bridge
 *  is alive → the streak resets to 0. Pure — unit-testable without a tab. */
export function transportStreakAfter(current: number, error: unknown): number {
  const message = typeof error === 'string' ? error : '';
  const isTransportFailure = TRANSPORT_ERROR_MARKERS.some((marker) => message.includes(marker));
  return isTransportFailure ? current + 1 : 0;
}

/** The breaker's journal notice — single source so the claim stays honest
 *  everywhere it appears. States what is KNOWN (the transport is down, the run
 *  is ending, retrying cannot succeed) and names the recovery action (rule 13).
 *  It deliberately makes NO claim about the page state: whether this run's
 *  changes were kept or rolled back is the terminal disposition policy's
 *  decision, carried by the run reason — not by this entry. */
export function transportBreakerNotice(failures: number, lastError: string): string {
  return `[transport] the browser transport to this tab is unavailable — ${failures} consecutive tool dispatches failed with the same connection-level error ("${lastError}"). No further tool call can execute in this run; retrying through the model cannot succeed. The run is ending. Reload the page (or re-open the tab) and run the request again.`;
}

// ── R2-followup: no-new-information convergence guard ─────────────────

/** applyCss acts reporting visibleChange === false before the guard refuses
 *  the next one. 2 = the codebase's established consecutive-streak cap (the
 *  R2 note fired at 2; consecutiveNoInfo restricts at 2; the F5 breaker trips
 *  at 2). One invisible act can be a miscalibration; two in a row is the
 *  model re-authoring blind on shadowed targets. */
export const MAX_NO_VISIBLE_ACTS = 2;

/** The deterministic dispatch guard for the two no-progress classes the R3
 *  run actually exhibited (proof/r3-benchmark.json):
 *
 *  1. Re-verification of an UNCHANGED page — req5 spent ~38 of 52 paid turns
 *     calling checkLayout (19 consecutive) on a page no act had touched since
 *     the last definitive check; the journal already held that answer. A
 *     model-called checkLayout can only learn something new if an act or undo
 *     changed the page since the last definitive check.
 *  2. Re-authoring with no visible effect — the R2 guard appended an advisory
 *     note the model ignored (req7: 17 applyCss acts, 1 live sheet at the
 *     end, 10+ acts after the notes fired). At MAX_NO_VISIBLE_ACTS the next
 *     applyCss is REFUSED until an information-yielding observation re-scopes
 *     the model (the loop resets the streak on one).
 *
 *  PURE — returns the refusal reason (rule 13: always names the alternative)
 *  or null when the dispatch may proceed. The loop's OWN checkLayout calls
 *  (the forced post-act integrity check, the pre-act baseline, the resize
 *  proof) never pass through here — integrity enforcement is untouched; only
 *  model-initiated dispatch that cannot produce new evidence is refused.
 *  Visible progress (every act with visibleChange === true) is never refused —
 *  legitimate multi-step refinement continues exactly as before. */
export function convergenceRefusal(input: {
  toolName: string;
  noVisibleStreak: number;
  pageMutatedSinceCheck: boolean;
}): string | null {
  if (input.toolName === 'checkLayout' && !input.pageMutatedSinceCheck) {
    return 'checkLayout already measured this exact page state — its result is in the journal and nothing has changed the page since (no act or undo landed). Re-running it cannot produce new information. Call an act tool to change the page, done if the goal is satisfied, or giveUp.';
  }
  if (input.toolName === 'applyCss' && input.noVisibleStreak >= MAX_NO_VISIBLE_ACTS) {
    return `[convergence] your last ${input.noVisibleStreak} applyCss acts produced NO VISIBLE CHANGE — another stylesheet on the same shadowed targets will not help either. Call findElements on the region the goal names and inspect what it returns, then re-scope the next sheet to that evidence (applyCss is refused until an observation returns something new). Or done if the goal is already satisfied, or giveUp.`;
  }
  return null;
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

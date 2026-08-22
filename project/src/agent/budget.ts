/**
 * agent/budget — step count, wall clock, and cost tracking.
 * Exhaustion is not failure — stop, keep what landed, report what was skipped.
 */

export class Budget {
  maxSteps: number;
  maxWallMs: number;
  stepsUsed = 0;
  wallStart = Date.now();
  totalCostMs = 0;

  constructor(opts?: { maxSteps?: number; maxWallMs?: number }) {
    this.maxSteps = opts?.maxSteps ?? 12;
    this.maxWallMs = opts?.maxWallMs ?? 60_000;
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

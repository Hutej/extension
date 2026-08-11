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
  private callDurations: number[] = [];

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

  recordCallDuration(ms: number): void {
    this.callDurations.push(ms);
  }

  /** E: use the MAX of observed call durations, not the average.
   *  The average is too optimistic when the first call is fast and later
   *  calls are slow. Using the max means we never start a call that would
   *  overshoot — the worst case is the one we must plan for. */
  avgCallMs(): number {
    if (!this.callDurations.length) return 15_000;
    return Math.max(...this.callDurations);
  }

  elapsedMs(): number {
    return Date.now() - this.wallStart;
  }
}

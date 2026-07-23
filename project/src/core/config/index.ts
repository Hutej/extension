/**
 * core/config — model + pipeline settings.
 * No fallback chain (honest error > recolor), raised maxTokens,
 * DEBUG gated on dev env.
 */

export const AI_CONFIG = {
  // Design intelligence. The DesignSpec IS the product — strongest reasoning model.
  styleModel: 'gpt-5.1',
  // No fallback: a known-recolorer fallback is a worse failure than an honest error.
  styleFallbackModel: undefined as string | undefined,
  // Non-reasoning fallback temperature (unused now — no fallback).
  styleFallbackTemperature: 0.6,
  // Reasoning tokens bill against the completion budget — generous to prevent
  // JSON truncation when the model thinks at higher effort.
  styleMaxTokens: 24000,

  // Latency knob. The DESIGN THINKING lives in our system prompt (baked lessons),
  // so we ask for 'low' effort: near-full quality at a fraction of the wait.
  // Escalate to 'medium' ONLY if real runs visibly lose quality with the new
  // simplified prompt.
  styleReasoningEffort: 'low' as 'low' | 'medium',

  // Transport economy: the primary model gets exactly ONE hard-aborted attempt.
  timeoutMs: 120_000,        // primary: hard ≤120s abort, one shot
  fallbackTimeoutMs: 90_000, // (unused now — no fallback)
  // HTTP-level retries are for TRANSIENT server faults ONLY (429/5xx).
  maxTransientRetries: 2,
  baseBackoffMs: 1000,
};

/**
 * Paid model calls per transform. ONE-SHOT MANDATE: the happy path is a single
 * call — every repair lesson is baked into the first-call system prompt so the
 * model needs no runtime re-teaching. A paid reReason is a prompt FAILURE, not a
 * steady state; budget is 1 and every firing is logged loudly as a to-do.
 */
export const MAX_REPAIR_ATTEMPTS = 1;

// DEBUG: always log — the test harness reads console output for diagnosis.
const DEBUG = true;
export function logDebug(...args: unknown[]): void {
  if (DEBUG) console.log('[WebMorph]', ...args);
}

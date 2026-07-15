/**
 * core/config — model + pipeline settings.
 * Latency is intentionally NOT a constraint in Phase 1; correctness first.
 */

export const AI_CONFIG = {
  // Design intelligence. QUALITY OVER SPEED: the DesignSpec IS the product, so it
  // gets the strongest reasoning model on the account. gpt-4o followed the letter
  // of the brief but not the design intent — it recolored. Reasoning models
  // reject a custom temperature; never add one to the request.
  styleModel: 'gpt-5.1',
  // Fallback chain: if the primary model times out, is unavailable on this
  // account, or persistently rejects the request, reason falls through to this
  // model in the SAME run instead of hanging. A weaker design that arrives beats
  // a perfect design that never lands; verify/repair still gate quality.
  styleFallbackModel: 'gpt-4o',
  // Non-reasoning fallback gets a temperature (reasoning models reject one).
  styleFallbackTemperature: 0.6,
  // Reasoning tokens bill against the completion budget — keep this generous or
  // long reasoning silently truncates the JSON spec.
  styleMaxTokens: 16000,

  // Latency knob. The DESIGN THINKING lives in our system prompt (baked lessons),
  // not in model reasoning tokens — so we ask for 'low' effort: near-full quality
  // at a fraction of the wait. 'none'/'minimal' would strip too much; 'medium'
  // is the 3-5 min wait we are explicitly avoiding. 'low' is a VALID value for
  // gpt-5.x (confirmed on-account); if a model rejects it, reason drops the param
  // and logs the 400 body. Escalate ONLY if real runs visibly lose quality.
  styleReasoningEffort: 'low',

  // Transport economy: the primary model gets exactly ONE hard-aborted attempt.
  // If it lapses (~2 min) we do not wait or retry it — we fall to the fast model
  // once. Worst-case wall-clock is bounded ≈ primary + fallback + verify.
  timeoutMs: 120_000,        // primary: hard ≤120s abort, one shot
  fallbackTimeoutMs: 90_000, // fast fallback
  // HTTP-level retries are for TRANSIENT server faults ONLY (429/5xx) — never for
  // a timeout (a timeout means fall through the chain, not hammer the same model).
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

const DEBUG = true;
export function logDebug(...args: unknown[]): void {
  if (DEBUG) console.log('[WebMorph]', ...args);
}

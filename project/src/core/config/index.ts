/**
 * core/config — model + pipeline settings.
 * No fallback chain (honest error > recolor), raised maxTokens,
 * DEBUG gated on dev env.
 */

export const AI_CONFIG = {
  // Per-role models on Cloudflare Workers AI. GLM 5.2 is the flagship
  // (function calling + reasoning, 262K ctx); glm-4.7-flash is the fast
  // companion for the Critic.
  architectModel: process.env.RV_MODEL_ARCHITECT ?? '@cf/zai-org/glm-5.2',
  painterModel: process.env.RV_MODEL_PAINTER ?? '@cf/zai-org/glm-5.2',
  criticModel: process.env.RV_MODEL_CRITIC ?? '@cf/zai-org/glm-4.7-flash',
  styleModel: process.env.RV_MODEL ?? '@cf/zai-org/glm-5.2',
  // No fallback: a known-recolorer fallback is a worse failure than an honest error.
  styleFallbackModel: undefined as string | undefined,
  styleFallbackTemperature: 0.6,
  // Reasoning tokens bill against the completion budget — generous to prevent
  // JSON truncation when the model thinks at higher effort.
  styleMaxTokens: 24000,

  // Latency knob. The DESIGN THINKING lives in our system prompt (baked lessons),
  // so we ask for 'low' effort: near-full quality at a fraction of the wait.
  // 6a test: 'medium' timed out at 130s (hard abort) on GLM 5.2 / Cloudflare
  // Workers AI — the model's thinking time dominates wall-clock. 'low' runs
  // 59-90s with good quality (invisible=0, coverage=1.0). REVERT to 'low'.
  // Env-overridable (RV_EFFORT) kept for future re-testing with a faster model.
  styleReasoningEffort: (process.env.RV_EFFORT ?? 'low') as 'low' | 'medium',

  // Time budget (replaces the call-count cap). The wall-clock owns the run:
  // design ≤30s target, ≤120s absolute hard abort. Within it, as many Critic
  // repair rounds as fit (Critic is fastest, so several fit where one reReason
  // fit before). NO call-count cap is reintroduced; the budget is time.
  designTargetMs: 30_000,    // design (Architect + Painter parallel) target
  designMaxMs: 120_000,      // absolute hard abort for the whole transform
  criticMinMs: 8_000,        // don't start a Critic round if less than this remains
  // Per-call timeouts. The Architect + Painter run in PARALLEL on a large page;
  // each is capped SHORT of the absolute budget so the parallel design stage can't
  // hang and push the whole transform past the hard abort (a 130s timeout wastes
  // the paid call). If a role can't finish in time, it fails and the other role +
  // the Critic carry the design (a partial design is better than a timeout).
  architectTimeoutMs: 70_000, // Architect: ≤70s (fail fast on a large page)
  painterTimeoutMs: 90_000,     // Painter: ≤90s (palette is the long part, but cap it)
  criticTimeoutMs: 45_000,      // Critic: ≤45s (small repair spec)
  timeoutMs: 120_000,        // primary (restyle-only single call): hard ≤120s abort
  fallbackTimeoutMs: 90_000, // (unused now — no fallback)
  // HTTP-level retries are for TRANSIENT server faults ONLY (429/5xx). Bumped to 4
  // so a sustained 429 burst (heavy gpt-5.1 design calls in a back-to-back grid) is
  // ridden out instead of failing the run. The 429 backoff floor (rateLimitBackoffMs)
  // is generous so a retry doesn't slam back into the rate limit; the server's
  // Retry-After is honored when present (reason.retryWaitMs).
  maxTransientRetries: 4,
  baseBackoffMs: 1000,
  // 429-specific backoff floor (seconds). A 429 means "back off"; the exponential
  // baseBackoffMs (1s,2s,4s...) is too short for a sustained limit. Used as the
  // minimum when the server doesn't send Retry-After. The server's Retry-After
  // always wins when present.
  rateLimitBackoffMs: 8000,
};

/**
 * Repair budget. The call-count cap (MAX_REPAIR_ATTEMPTS) is REMOVED — the budget
 * is now TIME (designTargetMs/designMaxMs in AI_CONFIG). Critic repair rounds loop
 * within the remaining wall-clock; no call count is gated. Repair lessons are baked
 * into the role prompts so the model needs minimal runtime re-teaching.
 */

// DEBUG = false — was true, shipping page content to the console in production.
// Gate all content-bearing logs behind this. The test harness enables it via RV_DEBUG.
const DEBUG = (process.env.RV_DEBUG ?? 'false') === 'true';
export function logDebug(...args: unknown[]): void {
  if (DEBUG) console.log('[Revueon]', ...args);
}

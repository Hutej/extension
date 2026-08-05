/**
 * core/config — model + pipeline settings.
 * No fallback chain (honest error > recolor), raised maxTokens,
 * DEBUG gated on dev env.
 *
 * Call budget: the design stage runs Architect + Painter IN PARALLEL — that
 * is ONE round trip of LATENCY (wall-clock = max(architect, painter)), but
 * TWO calls of COST (both charge). The Critic (if triggered) is a second
 * round trip (one more call, one more latency step). Report both numbers
 * always: latency in round trips, cost in call count. A run with 2 paid calls
 * and 1 round trip is the happy path. 3 calls + 2 round trips means the
 * Critic ran (a repair). 2 calls + 1 round trip is NOT 2 round trips.
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

  // Per-role reasoning effort. The Architect makes STRUCTURE decisions, but on
  // GLM 5.2 / Cloudflare Workers AI 'medium' measured ~130s — well past the
  // 70s Architect timeout and far past the 5-10s latency target. Raising the
  // ceilings to fit medium is movement in the wrong direction (a 130s design
  // is not a 5-10s design). So the Architect reverts to 'low' until the prompt
  // is smaller; a medium-effort Architect aborts and falls back on nearly every
  // run, and a fallback design is indistinguishable from a bad design. The
  // Painter runs in PARALLEL (same wall-clock round trip) so its effort adds
  // COST but not LATENCY — kept at 'low'. The Critic is a fast repair pass at
  // 'low'. Env override: RV_EFFORT sets a global floor.
  // ponytail: 'medium' for the Architect times out at ~130s vs a 70s ceiling and
  // a 5-10s target — revert to 'low' rather than raise ceilings. The fallback
  // is now loudly flagged (architectFallback) so it can't look like quality.
  architectReasoningEffort: (process.env.RV_EFFORT_ARCHITECT ?? 'low') as 'low' | 'medium',
  painterReasoningEffort: (process.env.RV_EFFORT_PAINTER ?? 'low') as 'low' | 'medium',
  // Legacy: the shared effort, used by the Critic and the restyle-only path.
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

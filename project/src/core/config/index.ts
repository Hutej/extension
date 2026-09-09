/**
 * core/config — model + loop settings for the agent.
 *
 * Production Revueon uses EXACTLY ONE model: GLM 5.2 (reasoning, 262K ctx).
 * Vision (screenshots → a vision model) is TEST/QA infrastructure only and
 * lives in tests/, never in production src/ — production never sends a
 * screenshot to a vision model. See CORE MEMORY / CLAUDE.md image rule.
 */

export const AI_CONFIG = {
  // The ONE production model. Cloudflare Workers AI, OpenAI-compatible.
  strongModel: process.env.RV_MODEL_STRONG ?? '@cf/zai-org/glm-5.3-flash',

  // Consent gate (Phase 6 launch requirement). Enforced in BOTH the popup UI
  // (shows the disclosure) and the background's runLoop handler (the single
  // entry point, so no caller bypasses it). One constant so they cannot drift.
  consentRequired: true,

  // Loop budget (T2 reliability amendment). The old 12 steps / 60s wall were
  // sized for the REMOVED fast companion model (1.4-3.7s/call, Phase 6 notes);
  // the production model takes 8-20s/call (T2 A/B evidence), so 60s could not
  // fit even a 3-turn run and manufactured late-run timeouts that rolled back
  // VERIFIED transformations. The numbers below are a runaway CEILING, not the
  // governor: genuine stuck states are caught by the no-info restriction (2),
  // the checkLayout circuit breaker (2), the convergence guard, the min-turn
  // break, and the model's own done/giveUp long before these are reached.
  maxSteps: 80,
  maxWallMs: 300_000,

  // Per-call completion-token cap. null = NO artificial cap — the provider's
  // own default applies and the model is never truncated mid-thought (user
  // decision 31 Aug 2026: an output limit should never silently shrink what
  // the agent can author in one turn). Runaway safety stays with callTimeoutMs
  // and the loop ceilings; a benchmark can still set an explicit cap via the
  // revueon_max_tokens storage override.
  maxCompletionTokens: null as number | null,

  // Per-call timeout. P2 named change (pre-authorized by the owner: "60s ->
  // 120s ONLY if timeout-driven failures appear in the first 3 baseline
  // runs; log it"): the Task B baseline leg hit model-call timeouts in run 3
  // (breathing-room: "the model became unreachable (Model call timed out.)")
  // and run 9 (premium) — verified work kept, refinement strangled mid-run.
  // Sized for the UNCAPPED completion length (user decision: no artificial
  // output limit) — with reasoning, a flash-tier turn can run 25-50s at low
  // effort and longer at higher efforts.
  callTimeoutMs: 120_000,

  // GLM reasoning effort (reasoning_effort in the chat payload). 'low' is the
  // production default — proven across the R3/R10 runs and the P1 smoke.
  // 'minimal' is NOT a valid GLM value (the schema is low|medium|high; an
  // unsupported value gets the transport's 400-drop fallback, which silently
  // removes the param instead of honouring it). Benchmarks override this via
  // the revueon_reasoning_effort storage override, not by editing here.
  reasoningEffort: 'low' as 'low' | 'medium' | 'high',

  // HTTP-level retries for TRANSIENT server faults ONLY (429/5xx).
  maxTransientRetries: 4,
  baseBackoffMs: 1000,
  rateLimitBackoffMs: 8000,
};

const DEBUG = (process.env.RV_DEBUG ?? 'false') === 'true';
export function logDebug(...args: unknown[]): void {
  if (DEBUG) console.log('[Revueon]', ...args);
}

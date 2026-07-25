/**
 * core/config — model + pipeline settings.
 * No fallback chain (honest error > recolor), raised maxTokens,
 * DEBUG gated on dev env.
 */

export const AI_CONFIG = {
  // Per-role models. The monolithic call is SPLIT: Architect (composition) +
  // Painter (palette) run in parallel; Critic (repair) runs on the fastest model.
  // The design path = Architect + Painter + Critic rounds; restyle-only = Painter
  // alone; the fast path = no model. Env-overridable (WM_MODEL_*); the operator
  // updates these by eye from the bake-off (bakeoff.ts prints per-role winners).
  architectModel: process.env.WM_MODEL_ARCHITECT ?? 'gpt-5.1',
  painterModel: process.env.WM_MODEL_PAINTER ?? 'gpt-5.1',
  criticModel: process.env.WM_MODEL_CRITIC ?? 'gpt-4o-mini',
  // Single-call path model (restyle-only Painter-alone fallback + the bake-off).
  // WM_MODEL env override (for the bake-off; production default unchanged).
  styleModel: process.env.WM_MODEL ?? 'gpt-5.1',
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
  // HTTP-level retries are for TRANSIENT server faults ONLY (429/5xx).
  maxTransientRetries: 2,
  baseBackoffMs: 1000,
};

/**
 * Repair budget. The call-count cap (MAX_REPAIR_ATTEMPTS) is REMOVED — the budget
 * is now TIME (designTargetMs/designMaxMs in AI_CONFIG). Critic repair rounds loop
 * within the remaining wall-clock; no call count is gated. Repair lessons are baked
 * into the role prompts so the model needs minimal runtime re-teaching.
 */

// DEBUG: always log — the test harness reads console output for diagnosis.
const DEBUG = true;
export function logDebug(...args: unknown[]): void {
  if (DEBUG) console.log('[WebMorph]', ...args);
}

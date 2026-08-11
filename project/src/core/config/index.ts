/**
 * core/config — model + loop settings for the agent.
 *
 * One loop, two models: fast for concept matching (findElements), strong for
 * loop turns (decisions + content). Budgets: 12 steps, 60s wall clock.
 */

export const AI_CONFIG = {
  // Models on Cloudflare Workers AI. GLM 5.2 is the flagship (reasoning, 262K ctx);
  // glm-4.7-flash is the fast companion for concept matching.
  strongModel: process.env.RV_MODEL_STRONG ?? '@cf/zai-org/glm-5.2',
  fastModel: process.env.RV_MODEL_FAST ?? '@cf/zai-org/glm-4.7-flash',
  // F7: vision model for screenshots (kimi).
  visionModel: '@cf/moonshotai/kimi-k2.7-code',

  // Loop budget
  maxSteps: 12,
  maxWallMs: 60_000,
  maxCompletionTokens: 16_000,

  // Per-call timeout — the loop makes several small calls, not one big one.
  callTimeoutMs: 30_000,

  // HTTP-level retries for TRANSIENT server faults ONLY (429/5xx).
  maxTransientRetries: 4,
  baseBackoffMs: 1000,
  rateLimitBackoffMs: 8000,
};

const DEBUG = (process.env.RV_DEBUG ?? 'false') === 'true';
export function logDebug(...args: unknown[]): void {
  if (DEBUG) console.log('[Revueon]', ...args);
}

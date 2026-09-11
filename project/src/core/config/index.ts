/**
 * core/config — model + loop settings for the agent.
 *
* Production Revueon uses EXACTLY ONE model: eepseek v4 flash.
 */

export const AI_CONFIG = {
  // The ONE production model. Cloudflare Workers AI, OpenAI-compatible.
  strongModel: process.env.RV_MODEL_STRONG ?? '@cf/deepseek-ai/deepseek-v4-flash-0731',

  consentRequired: true,
  maxSteps: 80,
  maxWallMs: 300_000,
  maxCompletionTokens: null as number | null,
  callTimeoutMs: 120_000,
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

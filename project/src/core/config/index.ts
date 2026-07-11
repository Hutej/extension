/**
 * core/config — model + pipeline settings.
 * Latency is intentionally NOT a constraint in Phase 1; correctness first.
 */

export const AI_CONFIG = {
  // Model that produces the StyleSpec. Configurable; gpt-4o is the proven default
  // available on the project's OpenAI account.
  styleModel: 'gpt-4o',
  styleMaxTokens: 6000,
  styleTemperature: 0.5,

  timeoutMs: 90_000,
  maxRetries: 4,
  baseBackoffMs: 1000,
};

/** How many targeted repair passes verify->repair may attempt before giving up. */
export const MAX_REPAIR_ATTEMPTS = 2;

const DEBUG = true;
export function logDebug(...args: unknown[]): void {
  if (DEBUG) console.log('[WebMorph]', ...args);
}

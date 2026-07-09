export const AI_CONFIG = {
  model: 'gpt-5.2',
  max_tokens: 1500, // safety net
  temperature: 0.1,
  timeoutMs: 30000,
  maxRetries: 3,
  baseBackoffMs: 1000,
  maxOperations: 30, // validate output max ops
  maxOutlineTokens: 8000, // estimate for token budget
};

const DEBUG = false;

export function logDebug(...args: any[]) {
  if (DEBUG) {
    console.log('[WebMorph DEBUG]', ...args);
  }
}

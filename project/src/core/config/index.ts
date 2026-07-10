export const AI_CONFIG = {
  model: 'gpt-5.2',
  classifierModel: 'gpt-4o-mini',
  max_tokens: 1500, // safety net for plan output
  temperature: 0.1,
  timeoutMs: 30000,
  maxRetries: 5,
  baseBackoffMs: 1000,
  maxOperations: 30, // validate output max ops
  maxOutlineTokens: 3000, // estimate for token budget

  // Theme-specific (Tier-1 re-skin)
  themeMaxTokens: 800, // Reduced for compactness
  themeTemperature: 0.4,
  themeTimeoutMs: 60000,
  
  maxObserveNodes: 4000,
  maxObserveTimeMs: 150,
};

// ── Verify constants ───────────────────────────────────────────────

/** Maximum ratio of scrollWidth to innerWidth before declaring layout blow-out */
export const MAX_OVERFLOW_RATIO = 1.25;

/** Minimum WCAG contrast ratio for sampled text */
export const MIN_CONTRAST_RATIO = 4.5;

/** Number of text samples to check for contrast */
export const CONTRAST_SAMPLE_COUNT = 5;

/** Maximum number of theme regen attempts on verify failure */
export const MAX_THEME_REGEN_ATTEMPTS = 1;

// ── DEV-only logging ───────────────────────────────────────────────

export function logDebug(...args: any[]) {
  console.log('[WebMorph DEBUG]', ...args);
}

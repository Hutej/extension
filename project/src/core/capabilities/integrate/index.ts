/**
 * capabilities/integrate — Phase 5 (INTEGRATE, half of EXTRACT & INTEGRATE).
 * Call external APIs / AI with extracted data and export results.
 *
 * Contract only — not implemented yet. External calls are high-risk: every
 * outbound destination must be user-approved before this ships.
 */

export interface IntegrateOp {
  kind: 'httpRequest' | 'aiCall' | 'export';
  /** Outbound URL (must be user-approved at runtime). */
  url?: string;
  payloadFrom?: string; // reference to an ExtractResult
}

// TODO(phase-5): execute IntegrateOp with explicit per-destination user consent.
export {};

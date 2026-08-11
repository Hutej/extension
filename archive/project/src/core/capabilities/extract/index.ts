/**
 * capabilities/extract — Phase 5 (EXTRACT, half of EXTRACT & INTEGRATE).
 * Pull structured data off pages and watch/track changes over time.
 *
 * Contract only — not implemented yet.
 */

export interface ExtractOp {
  /** Perception handle whose repeated children become records. */
  target: string;
  /** field name -> relative selector or attribute to read. */
  fields: Record<string, string>;
  watch?: boolean;
}

export interface ExtractResult {
  records: Record<string, string>[];
  extractedAt: number;
}

// TODO(phase-5): read ExtractOp from the live DOM into ExtractResult.
export {};

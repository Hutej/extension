/** core/perceive/spatial — D2 (position, adjacency, columns, reading order,
 *  gutters, symmetry, focal point) + D7 (density, rhythm, room).
 *  Spatial relationships derived from cluster positions. */

import type { Cluster } from './index.ts';
import { deepQuerySelector } from './dom-utils.ts';

// ── C8 (carried from enrichment.ts): Density, rhythm, alignment ─────

export interface DensityProfile {
  rhythmBaseline: number;     // modal gap between siblings (px)
  alignmentEdges: number[];   // repeating x-positions (px, quantized to 8px)
  whitespaceGini: number;      // 0..1 — distribution of free space (lower = more even)
}

/** Measure page-level density, rhythm, and alignment from clusters.
 *  These are INPUTS to the designer, not gates — the pixel verifier must never
 *  judge them after the fact. */
export function measureDensity(clusters: Cluster[], _viewport: { w: number; h: number }): DensityProfile {
  const gaps = clusters.map((c) => c.layout.siblingGapPx).filter((g): g is number => g != null && g > 0);
  gaps.sort((a, b) => a - b);
  const rhythmBaseline = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
  const alignmentEdges: number[] = [];
  const sortedGaps = [...gaps].sort((a, b) => a - b);
  let whitespaceGini = 0;
  if (sortedGaps.length >= 2) {
    const n = sortedGaps.length;
    const sum = sortedGaps.reduce((s, g) => s + g, 0);
    if (sum > 0) {
      for (let i = 0; i < n; i++) {
        whitespaceGini += (2 * (i + 1) - n - 1) * sortedGaps[i];
      }
      whitespaceGini = Math.max(0, Math.min(1, whitespaceGini / (n * sum)));
    }
  }
  return { rhythmBaseline, alignmentEdges, whitespaceGini };
}

/** Measure alignment edges from live DOM positions. D2 will replace this with
 *  rect.x once positions are on the rects (delete the re-query workaround). */
export function measureAlignmentEdges(clusters: Cluster[], _vpW: number): number[] {
  const edgeCounts = new Map<number, number>();
  for (const c of clusters) {
    // ponytail: once rect.x is populated, use c.rect.x instead of re-querying.
    // D2 will make this change. For now, fall back to deepQuerySelector.
    const el = deepQuerySelector<HTMLElement>(c.selector);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 50 || r.height < 30) continue;
    const edge = Math.round(r.x / 8) * 8;
    edgeCounts.set(edge, (edgeCounts.get(edge) ?? 0) + 1);
  }
  return [...edgeCounts.entries()].filter(([, n]) => n >= 2).map(([e]) => e).sort((a, b) => a - b).slice(0, 8);
}

// ── D2+D7 functions will be added by subagents ─────────────────────

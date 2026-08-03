/** core/perceive/spatial — (position, adjacency, columns, reading order,
 *  gutters, symmetry, focal point) + (density, rhythm, room).
 *  Spatial relationships derived from cluster positions. */

import type { Cluster } from './index.ts';
import { colorfulness, parseColor } from '../../shared/color.ts';

// ── Density, rhythm, alignment ─────

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

/** Measure alignment edges from cluster rect positions (uses rect.x
 *  directly — positions are now on the rects, no live-DOM re-query). */
export function measureAlignmentEdges(clusters: Cluster[], _vpW: number): number[] {
  const edgeCounts = new Map<number, number>();
  for (const c of clusters) {
    if (c.rect.w < 50 || c.rect.h < 30) continue;
    const edge = Math.round(c.rect.x / 8) * 8;
    edgeCounts.set(edge, (edgeCounts.get(edge) ?? 0) + 1);
  }
  return [...edgeCounts.entries()].filter(([, n]) => n >= 2).map(([e]) => e).sort((a, b) => a - b).slice(0, 8);
}

// ── Position layer types ───────────────────────────────────────

export interface SpatialAdjacency {
  above: string | null;  // handle of cluster directly above
  below: string | null;
  left: string | null;
  right: string | null;
  gapAbove: number;  // px gap
  gapBelow: number;
  gapLeft: number;
  gapRight: number;
}

export interface Column {
  index: number;
  x: number;
  width: number;
  handles: string[];  // clusters in this column
  gutterLeft: number;  // px gap to previous column
}

export interface GutterInventory {
  modalHorizontal: number;  // px, between columns
  modalVertical: number;   // px, between rows
  distinctHorizontal: number[];  // all distinct h-gaps
  distinctVertical: number[];
}

export interface SymmetryProfile {
  leftWeight: number;
  rightWeight: number;
  topWeight: number;
  bottomWeight: number;
  balanceRatio: number;  // left/right (1.0 = symmetric)
}

export interface FocalPoint {
  handle: string;
  score: number;  // combined area × contrast × position weight
}

export interface SpatialModel {
  adjacency: Map<string, SpatialAdjacency>;
  columns: Column[];
  readingOrder: string[];  // handles in human reading order
  gutters: GutterInventory;
  symmetry: SymmetryProfile;
  focalPoint: FocalPoint | null;
}

// ── Vertical row groups ────────────────────────────────────────

/** A row group: clusters that share a y-band (overlapping or adjacent vertical
 *  positions). Carries the member handles, the y-band extent, and how the members
 *  align within the row. Measurements inform decisions (Law 0) — the px height is
 *  perception data the design step converts to ratios; vAlign/hAlign are ranks. */
export interface RowGroup {
  members: string[];      // cluster handles sharing the y-band (left-to-right)
  y: number;               // top of the y-band (px, document coords)
  yEnd: number;            // bottom of the y-band (px)
  height: number;          // yEnd - y (px) — the row's vertical extent
  vAlign: 'top' | 'center' | 'bottom' | 'mixed';   // how members line up vertically
  hAlign: 'start' | 'center' | 'end' | 'stretch' | 'mixed';  // horizontal distribution
}

// ── Density, rhythm, room types ───────────────────────────────

export interface RegionDensity {
  handle: string;
  textVolume: number;       // readingLength per 10k px²
  elementCount: number;     // count per 10k px²
  interactiveCount: number; // native controls per 10k px²
  mediaArea: number;        // px² (0 if no media)
  densityClass: 'sparse' | 'comfortable' | 'dense' | 'cramped';
  freeRoom: number;         // 0..1 (1 - content area / rect area)
  surroundingGap: number;   // px gap to nearest neighbor
}

export interface ExpandedDensityProfile extends DensityProfile {
  regions: RegionDensity[];
  pageDensityClass: 'sparse' | 'comfortable' | 'dense' | 'cramped';
  rhythmVariance: number;  // std dev of gaps
  rhythmConsistent: boolean; // variance < 20% of modal
  modalPadding: string;    // the most common padding value
  paddingOutliers: string[]; // handles that deviate
}

// ── buildSpatialModel ─────────────────────────────────────────

/** Compute the full spatial model: adjacency, columns, reading order,
 *  gutters, symmetry, and focal point. All derived from cluster rects —
 *  no DOM access. Measurements inform the designer; they never become CSS. */
export function buildSpatialModel(clusters: Cluster[], viewport: { w: number; h: number }): SpatialModel {
  const adjacency = computeAdjacency(clusters);
  const columns = detectColumns(clusters);
  const readingOrder = computeReadingOrder(clusters);
  const gutters = inventoryGutters(adjacency);
  const symmetry = computeSymmetry(clusters, viewport);
  const focalPoint = computeFocalPoint(clusters, viewport);
  return { adjacency, columns, readingOrder, gutters, symmetry, focalPoint };
}

// ── buildRowGroups ──────────────────────────────────────────────

const ROW_MIN_W = 40;
const ROW_MIN_H = 16;
const ROW_ALIGN_TOL_PX = 8;   // px tolerance for "edges line up"
const ROW_ALIGN_TOL_FRAC = 0.02; // 2% of parent width

/** Group clusters sharing a y-band into rows. A row = a set of clusters whose
 *  y-ranges overlap (any overlap — same greedy rule as computeReadingOrder).
 *  Rows with fewer than 2 members are dropped (a single cluster is not a group).
 *  vAlign is derived from how member tops/bottoms/centers line up; hAlign from
 *  how members distribute across their common parent's width (when they share
 *  one). Pure rect math — no DOM access. */
export function buildRowGroups(clusters: Cluster[]): RowGroup[] {
  const eligible = clusters.filter((c) => c.rect.w >= ROW_MIN_W && c.rect.h >= ROW_MIN_H);
  if (eligible.length < 2) return [];
  const sorted = [...eligible].sort((a, b) => a.rect.y - b.rect.y);
  const rows: { y: number; yEnd: number; members: Cluster[] }[] = [];
  for (const c of sorted) {
    const cy = c.rect.y;
    const cyEnd = c.rect.y + c.rect.h;
    let found = false;
    for (const row of rows) {
      if (cy < row.yEnd && row.y < cyEnd) {
        row.members.push(c);
        row.y = Math.min(row.y, cy);
        row.yEnd = Math.max(row.yEnd, cyEnd);
        found = true;
        break;
      }
    }
    if (!found) rows.push({ y: cy, yEnd: cyEnd, members: [c] });
  }
  const out: RowGroup[] = [];
  for (const row of rows) {
    if (row.members.length < 2) continue;
    const members = row.members.sort((a, b) => a.rect.x - b.rect.x);
    out.push({
      members: members.map((m) => m.handle),
      y: Math.round(row.y),
      yEnd: Math.round(row.yEnd),
      height: Math.round(row.yEnd - row.y),
      vAlign: classifyVAlign(members),
      hAlign: classifyHAlign(members, clusters),
    });
  }
  return out;
}

/** How members line up vertically within the row: tops aligned → 'top',
 *  bottoms aligned → 'bottom', centers aligned → 'center', else 'mixed'. */
function classifyVAlign(members: Cluster[]): RowGroup['vAlign'] {
  const spread = (xs: number[]): number => Math.max(...xs) - Math.min(...xs);
  if (spread(members.map((m) => m.rect.y)) <= ROW_ALIGN_TOL_PX) return 'top';
  if (spread(members.map((m) => m.rect.y + m.rect.h)) <= ROW_ALIGN_TOL_PX) return 'bottom';
  if (spread(members.map((m) => m.rect.y + m.rect.h / 2)) <= ROW_ALIGN_TOL_PX) return 'center';
  return 'mixed';
}

/** How members distribute horizontally across their common parent's width.
 *  Requires a shared parent cluster; without one the reference box is unknown
 *  → 'mixed'. leading≈0 & trailing≈0 → 'stretch'; leading≈0 → 'start';
 *  trailing≈0 → 'end'; leading≈trailing → 'center'; else 'mixed'. */
function classifyHAlign(members: Cluster[], all: Cluster[]): RowGroup['hAlign'] {
  const parentHandle = members[0].layout.parentHandle;
  if (!parentHandle || !members.every((m) => m.layout.parentHandle === parentHandle)) return 'mixed';
  const parent = all.find((c) => c.handle === parentHandle);
  if (!parent) return 'mixed';
  const pLeft = parent.rect.x;
  const pRight = parent.rect.x + parent.rect.w;
  const pWidth = pRight - pLeft;
  if (pWidth <= 0) return 'mixed';
  const tol = Math.max(ROW_ALIGN_TOL_PX, pWidth * ROW_ALIGN_TOL_FRAC);
  const mLeft = Math.min(...members.map((m) => m.rect.x));
  const mRight = Math.max(...members.map((m) => m.rect.x + m.rect.w));
  const leading = mLeft - pLeft;
  const trailing = pRight - mRight;
  if (Math.abs(leading) <= tol && Math.abs(trailing) <= tol) return 'stretch';
  if (Math.abs(leading) <= tol) return 'start';
  if (Math.abs(trailing) <= tol) return 'end';
  if (Math.abs(leading - trailing) <= tol) return 'center';
  return 'mixed';
}

// ── measureDensityV2 ───────────────────────────────────────────

/** Expanded density profile: per-region density, free room, vertical rhythm
 *  variance, and padding rhythm. Extends the DensityProfile so the
 *  existing `density` field on Perception stays type-compatible. */
export function measureDensityV2(clusters: Cluster[], viewport: { w: number; h: number }): ExpandedDensityProfile {
  const base = measureDensity(clusters, viewport);
  const adjacency = computeAdjacency(clusters);
  const regions: RegionDensity[] = [];

  for (const c of clusters) {
    const area = c.rect.w * c.rect.h;
    const areaUnits = area / 10000; // 10k px² units
    const textVolume = areaUnits > 0 ? c.textProfile.readingLength / areaUnits : 0;
    const elementCount = areaUnits > 0 ? c.count / areaUnits : 0;
    const interactiveCount = areaUnits > 0 ? (c.isNativeControl ? c.count : 0) / areaUnits : 0;
    const mediaArea = c.style.hasBgImage ? area : 0;
    const densityClass = classifyDensity(elementCount);
    const freeRoom = c.emptinessScore; // 0..1 — reuse the existing emptiness computation
    const a = adjacency.get(c.handle);
    const surroundingGap = a ? Math.min(a.gapAbove, a.gapBelow, a.gapLeft, a.gapRight) : 0;
    regions.push({ handle: c.handle, textVolume, elementCount, interactiveCount, mediaArea, densityClass, freeRoom, surroundingGap });
  }

  // Page-level density class from the average element count per 10k px².
  const avgElementCount = regions.length > 0
    ? regions.reduce((s, r) => s + r.elementCount, 0) / regions.length
    : 0;
  const pageDensityClass = classifyDensity(avgElementCount);

  // Vertical rhythm: variance of sibling gaps and whether a consistent
  // baseline exists (variance < 20% of the modal gap).
  const gaps = clusters.map((c) => c.layout.siblingGapPx).filter((g): g is number => g != null && g > 0);
  const rhythmVariance = stdDev(gaps);
  const rhythmConsistent = base.rhythmBaseline > 0 && rhythmVariance < base.rhythmBaseline * 0.2;

  // Padding rhythm: the most common computed padding value and outliers.
  const paddingCounts = new Map<string, number>();
  for (const c of clusters) {
    const p = c.style.padding;
    if (p) paddingCounts.set(p, (paddingCounts.get(p) ?? 0) + 1);
  }
  let modalPadding = '';
  let maxCount = 0;
  for (const [p, n] of paddingCounts) if (n > maxCount) { modalPadding = p; maxCount = n; }
  const paddingOutliers = modalPadding
    ? clusters.filter((c) => c.style.padding && c.style.padding !== modalPadding).map((c) => c.handle)
    : [];

  return {
    ...base,
    regions,
    pageDensityClass,
    rhythmVariance,
    rhythmConsistent,
    modalPadding,
    paddingOutliers,
  };
}

// ── Helpers ────────────────────────────────────────────────────────

/** Two clusters overlap horizontally (x-ranges intersect). */
function xOverlap(a: Cluster, b: Cluster): boolean {
  return a.rect.x < b.rect.x + b.rect.w && b.rect.x < a.rect.x + a.rect.w;
}

/** Two clusters overlap vertically (y-ranges intersect). */
function yOverlap(a: Cluster, b: Cluster): boolean {
  return a.rect.y < b.rect.y + b.rect.h && b.rect.y < a.rect.y + a.rect.h;
}

/** For each cluster, find the nearest cluster directly above, below, left,
 *  and right (by rect proximity + axis overlap) and the px gap to it. */
function computeAdjacency(clusters: Cluster[]): Map<string, SpatialAdjacency> {
  const adj = new Map<string, SpatialAdjacency>();
  for (const a of clusters) {
    const entry: SpatialAdjacency = {
      above: null, below: null, left: null, right: null,
      gapAbove: Infinity, gapBelow: Infinity, gapLeft: Infinity, gapRight: Infinity,
    };
    for (const b of clusters) {
      if (a.handle === b.handle) continue;
      // above: b sits above a (b.bottom <= a.top) with horizontal overlap
      if (b.rect.y + b.rect.h <= a.rect.y && xOverlap(a, b)) {
        const gap = a.rect.y - (b.rect.y + b.rect.h);
        if (gap < entry.gapAbove) { entry.gapAbove = gap; entry.above = b.handle; }
      }
      // below: b sits below a (b.top >= a.bottom) with horizontal overlap
      if (b.rect.y >= a.rect.y + a.rect.h && xOverlap(a, b)) {
        const gap = b.rect.y - (a.rect.y + a.rect.h);
        if (gap < entry.gapBelow) { entry.gapBelow = gap; entry.below = b.handle; }
      }
      // left: b sits left of a (b.right <= a.left) with vertical overlap
      if (b.rect.x + b.rect.w <= a.rect.x && yOverlap(a, b)) {
        const gap = a.rect.x - (b.rect.x + b.rect.w);
        if (gap < entry.gapLeft) { entry.gapLeft = gap; entry.left = b.handle; }
      }
      // right: b sits right of a (b.left >= a.right) with vertical overlap
      if (b.rect.x >= a.rect.x + a.rect.w && yOverlap(a, b)) {
        const gap = b.rect.x - (a.rect.x + a.rect.w);
        if (gap < entry.gapRight) { entry.gapRight = gap; entry.right = b.handle; }
      }
    }
    // No neighbor in a direction → gap 0 (not Infinity).
    if (entry.above === null) entry.gapAbove = 0;
    if (entry.below === null) entry.gapBelow = 0;
    if (entry.left === null) entry.gapLeft = 0;
    if (entry.right === null) entry.gapRight = 0;
    adj.set(a.handle, entry);
  }
  return adj;
}

/** Detect visual columns: clusters whose x-ranges overlap and whose widths
 *  are similar (within 30%) belong to the same column. Replaces the skeleton's
 *  guessed column count with real geometric columns. */
function detectColumns(clusters: Cluster[]): Column[] {
  if (clusters.length === 0) return [];
  const sorted = [...clusters].sort((a, b) => a.rect.x - b.rect.x);
  const cols: { x: number; xEnd: number; width: number; handles: string[] }[] = [];
  for (const c of sorted) {
    const cx = c.rect.x;
    const cxEnd = c.rect.x + c.rect.w;
    const cw = c.rect.w;
    // Find a column whose x-range overlaps and whose width is similar.
    let found = false;
    for (const col of cols) {
      const overlap = cx < col.xEnd && col.x < cxEnd;
      const widthSimilar = Math.abs(cw - col.width) / Math.max(1, col.width) < 0.3;
      if (overlap && widthSimilar) {
        col.handles.push(c.handle);
        col.x = Math.min(col.x, cx);
        col.xEnd = Math.max(col.xEnd, cxEnd);
        col.width = (col.width * (col.handles.length - 1) + cw) / col.handles.length;
        found = true;
        break;
      }
    }
    if (!found) cols.push({ x: cx, xEnd: cxEnd, width: cw, handles: [c.handle] });
  }
  cols.sort((a, b) => a.x - b.x);
  return cols.map((col, i) => ({
    index: i,
    x: Math.round(col.x),
    width: Math.round(col.width),
    handles: col.handles,
    gutterLeft: i === 0 ? 0 : Math.round(col.x - cols[i - 1].xEnd),
  }));
}

/** Reading order for LTR: rows top-to-bottom, within each row left-to-right.
 *  A row = a set of clusters whose y-ranges overlap. This is the order a human
 *  traverses, which is not always DOM order. */
function computeReadingOrder(clusters: Cluster[]): string[] {
  if (clusters.length === 0) return [];
  const byHandle = new Map(clusters.map((c) => [c.handle, c]));
  const sorted = [...clusters].sort((a, b) => a.rect.y - b.rect.y);
  const rows: { y: number; yEnd: number; handles: string[] }[] = [];
  for (const c of sorted) {
    const cy = c.rect.y;
    const cyEnd = c.rect.y + c.rect.h;
    let found = false;
    for (const row of rows) {
      // ponytail: any y-overlap groups into a row; a 50% threshold would be
      // tighter but any-overlap is the simpler correct default for reading order.
      if (cy < row.yEnd && row.y < cyEnd) {
        row.handles.push(c.handle);
        row.y = Math.min(row.y, cy);
        row.yEnd = Math.max(row.yEnd, cyEnd);
        found = true;
        break;
      }
    }
    if (!found) rows.push({ y: cy, yEnd: cyEnd, handles: [c.handle] });
  }
  rows.sort((a, b) => a.y - b.y);
  const order: string[] = [];
  for (const row of rows) {
    row.handles
      .map((h) => byHandle.get(h)!)
      .sort((a, b) => a.rect.x - b.rect.x)
      .forEach((c) => order.push(c.handle));
  }
  return order;
}

/** Inventory the page's repeated gaps: horizontal (between side-by-side
 *  clusters) and vertical (between stacked clusters). Gaps are quantized to
 *  4px for a meaningful modal value. */
function inventoryGutters(adjacency: Map<string, SpatialAdjacency>): GutterInventory {
  const hGaps: number[] = [];
  const vGaps: number[] = [];
  for (const adj of adjacency.values()) {
    if (adj.right !== null && adj.gapRight > 0) hGaps.push(adj.gapRight);
    if (adj.below !== null && adj.gapBelow > 0) vGaps.push(adj.gapBelow);
  }
  return {
    modalHorizontal: modalGap(hGaps),
    modalVertical: modalGap(vGaps),
    distinctHorizontal: [...new Set(hGaps)].sort((a, b) => a - b),
    distinctVertical: [...new Set(vGaps)].sort((a, b) => a - b),
  };
}

/** Visual weight distribution: left/right and top/bottom, weighted by area ×
 *  dominanceRank. balanceRatio = leftWeight / rightWeight (1.0 = symmetric). */
function computeSymmetry(clusters: Cluster[], viewport: { w: number; h: number }): SymmetryProfile {
  const cx = viewport.w / 2;
  const cy = viewport.h / 2;
  let leftW = 0, rightW = 0, topW = 0, bottomW = 0;
  for (const c of clusters) {
    const weight = c.rect.w * c.rect.h * (c.dominanceRank || 0.5);
    const midX = c.rect.x + c.rect.w / 2;
    const midY = c.rect.y + c.rect.h / 2;
    if (midX < cx) leftW += weight; else rightW += weight;
    if (midY < cy) topW += weight; else bottomW += weight;
  }
  const balanceRatio = rightW > 0 ? leftW / rightW : (leftW > 0 ? Infinity : 1);
  return { leftWeight: leftW, rightWeight: rightW, topWeight: topW, bottomWeight: bottomW, balanceRatio };
}

/** The cluster with the greatest combined area, colorfulness, and position
 *  weight (center of viewport scores higher). Returns the winning handle
 *  and its score, or null if there are no clusters. */
function computeFocalPoint(clusters: Cluster[], viewport: { w: number; h: number }): FocalPoint | null {
  if (clusters.length === 0) return null;
  const cx = viewport.w / 2;
  const cy = viewport.h / 2;
  const maxDist = Math.sqrt(cx * cx + cy * cy) || 1;
  const vpArea = viewport.w * viewport.h || 1;
  let best: FocalPoint | null = null;
  let bestScore = -1;
  for (const c of clusters) {
    const areaNorm = (c.rect.w * c.rect.h) / vpArea;
    const contrast = colorfulness(parseColor(c.style.background) ?? [0, 0, 0, 0]);
    const midX = c.rect.x + c.rect.w / 2;
    const midY = c.rect.y + c.rect.h / 2;
    const dist = Math.sqrt((midX - cx) ** 2 + (midY - cy) ** 2);
    const positionWeight = 1 - dist / maxDist;
    const score = areaNorm * contrast * positionWeight;
    if (score > bestScore) { bestScore = score; best = { handle: c.handle, score }; }
  }
  return best;
}

/** Density class from element count per 10k px². Thresholds are coarse
 *  heuristics — recalibrate from the test grid when density cases prove them
 *  wrong. ponytail: single guard, not a lookup table. */
function classifyDensity(elementCountPer10k: number): 'sparse' | 'comfortable' | 'dense' | 'cramped' {
  if (elementCountPer10k < 0.5) return 'sparse';
  if (elementCountPer10k < 2) return 'comfortable';
  if (elementCountPer10k < 5) return 'dense';
  return 'cramped';
}

/** Population standard deviation of an array of numbers. */
function stdDev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

/** Modal gap value, quantized to 4px buckets so near-identical gaps cluster.
 *  Returns 0 for an empty input. */
function modalGap(gaps: number[], quant = 4): number {
  if (gaps.length === 0) return 0;
  const counts = new Map<number, number>();
  for (const g of gaps) {
    const q = Math.round(g / quant) * quant;
    counts.set(q, (counts.get(q) ?? 0) + 1);
  }
  let best = 0, bestCount = 0;
  for (const [v, n] of counts) if (n > bestCount) { best = v; bestCount = n; }
  return best;
}

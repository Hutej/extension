/**
 * core/verify/pixel — pure rendered-pixel detectors. No DOM.
 *
 * After `apply`, verification must read RENDERED PIXELS — the only thing the user
 * judges. These four deterministic detectors (void / invisible-text / squeeze /
 * recolor) operate on a `PixelInput` (an ImageData-shaped buffer) + cluster rects,
 * so they are unit-testable without a browser. The content script supplies real
 * captures via chrome.tabs.captureVisibleTab (see capture.ts); the harness supplies
 * them via page.screenshot.
 *
 * All Tier-1, deterministic, zero model calls. A cheap vision model as Tier-2 is
 * built only if Tier-1 insufficiency is proven with data (flag-and-stop).
 */

/** An ImageData-shaped buffer (subset). Pure data — no DOM dependency. */
export interface PixelInput {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;   // RGBA, row-major
}

/** A cluster's rendered rect + enough text info to judge it. `fontSize` is the
 *  rendered font size in px (used by the squeeze detector). */
export interface ClusterRect {
  handle: string;
  rect: { x: number; y: number; w: number; h: number };
  text: string;
  fontSize?: number;
}

/** Minimum rendered chars-per-line before text is "squeezed" (matches the DOM-side
 *  MIN_CHARS_PER_LINE in laws). A text container whose effective cpl falls below
 *  this wraps every word — invisible to bleed checks but visibly broken. */
export const PIXEL_MIN_CPL = 12;
/** Below this pixel-variance threshold, a text-bearing rect has near-zero contrast
 *  against its surface = invisible text. Calibrated to match the harness floor. */
export const INVISIBLE_VARIANCE = 15;
/** A void is a large uniform region; require it this big so a tiny empty badge is
 *  not a false positive. */
export const VOID_MIN_AREA = 200 * 100;
/** Edge threshold (per-channel abs delta > this counts as an edge pixel). */
export const RECOLOR_EDGE_T = 40;
/** Recolor: edge-map agreement >= this fraction = "structure identical". */
export const RECOLOR_STRUCT_AGREE = 0.92;
/** Recolor: mean hue difference > this = "hue shifted" (radians, ~0.5 rad ≈ 29°). */
export const RECOLOR_HUE_SHIFT = 0.5;
/** Downscale width for the recolor edge-map comparison — coarse to ignore jitter. */
export const RECOLOR_W = 64;

/**
 * VOID detector: a large uniform-color region (near-zero pixel variance) overlapping
 * a cluster rect where perception saw content but there is no rendered text. This is
 * the blank-box bug: content was there, the redesign blanked its surface.
 *
 * Returns the handles of clusters that render as voids.
 */
export function detectVoids(capture: PixelInput, rects: ClusterRect[]): string[] {
  const out: string[] = [];
  for (const cr of rects) {
    if (cr.text.trim().length > 0) continue;          // text-bearing clusters are not voids
    if (cr.rect.w * cr.rect.h < VOID_MIN_AREA) continue;
    if (variance(capture, cr.rect) < 10) out.push(cr.handle);
  }
  return out;
}

/**
 * INVISIBLE-TEXT detector: a text-bearing rect whose rendered pixels have near-zero
 * variance — the text is the same color as its surface, so nothing is visible. This
 * is the invisible-repo-title bug: computed styles say "color set", pixels say blank.
 *
 * Returns the handles of clusters whose text renders invisible.
 */
export function detectInvisibleText(capture: PixelInput, rects: ClusterRect[]): string[] {
  const out: string[] = [];
  for (const cr of rects) {
    if (cr.text.trim().length <= 20) continue;        // need real text, not a label
    if (cr.rect.w < 50 || cr.rect.h < 50) continue;
    if (variance(capture, cr.rect) < INVISIBLE_VARIANCE) out.push(cr.handle);
  }
  return out;
}

/**
 * SQUEEZE detector: a text cluster whose effective chars-per-line (rect width ÷
 * average char width) falls below the readable floor. Text that "fits" but wraps
 * every word (one-word-per-line) is invisible to bleed checks but visibly broken.
 * Requires substantial text so a short label is not a false positive.
 *
 * Operates on the cluster rect + fontSize (geometry only) — does not need pixels.
 * Returns the handles of squeezed clusters.
 */
export function detectSqueeze(cr: ClusterRect): string[] {
  const text = cr.text.trim();
  if (text.length < 80) return [];                     // need real prose, not a label
  const fs = cr.fontSize ?? 16;
  const avgCharW = fs * 0.5;                            // approx avg char width, proportional fonts
  const cpl = cr.rect.w / avgCharW;
  return cpl < PIXEL_MIN_CPL ? [cr.handle] : [];
}

/**
 * RECOLOR detector: compares a before-capture to an after-capture, downscaled to a
 * coarse grid. If the edge map is (near) identical AND the mean hue shifted, the
 * change is a recolor on stock structure — a failure, not a redesign. Identical
 * structure + hue-only shift = recolor, mechanically.
 *
 * Pure: takes both captures as data. Returns true if the change reads as a recolor.
 */
export function detectRecolor(before: PixelInput, after: PixelInput): boolean {
  const e = edgeStats(before), f = edgeStats(after);
  if (!e.edges.length || e.edges.length !== f.edges.length) return false;
  let agree = 0;
  for (let i = 0; i < e.edges.length; i++) if (e.edges[i] === f.edges[i]) agree++;
  const structIdentical = agree / e.edges.length >= RECOLOR_STRUCT_AGREE;
  if (!structIdentical) return false;
  // mean ANGULAR hue difference (radians, wraparound); NaN hues (grayscale) excluded.
  // Two solid colors with different hues should read as a hue shift, not a no-op.
  let hueDiff = 0, n = 0;
  const TAU = Math.PI * 2;
  for (let i = 0; i < e.hues.length; i++) {
    if (Number.isNaN(e.hues[i]) || Number.isNaN(f.hues[i])) continue;
    let d = Math.abs(e.hues[i] - f.hues[i]);
    if (d > Math.PI) d = TAU - d;          // shortest angular distance
    hueDiff += d; n++;
  }
  const hueShift = n ? hueDiff / n : 0;
  return hueShift > RECOLOR_HUE_SHIFT;
}

// ── helpers ───────────────────────────────────────────────────────

/** Per-channel max-min span summed across RGB, sampled over the rect. Pure. */
function variance(capture: PixelInput, rect: { x: number; y: number; w: number; h: number }): number {
  const { width: W, data } = capture;
  let minR = 255, maxR = 0, minG = 255, maxG = 0, minB = 255, maxB = 0;
  const step = 4;
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(capture.width, Math.ceil(rect.x + rect.w));
  const y1 = Math.min(capture.height, Math.ceil(rect.y + rect.h));
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const i = (y * W + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (r < minR) minR = r; if (r > maxR) maxR = r;
      if (g < minG) minG = g; if (g > maxG) maxG = g;
      if (b < minB) minB = b; if (b > maxB) maxB = b;
    }
  }
  return (maxR - minR) + (maxG - minG) + (maxB - minB);
}

/** Downscale-agnostic edge map + hue list for the recolor comparison. Pure. */
function edgeStats(capture: PixelInput): { edges: number[]; hues: number[] } {
  const W = RECOLOR_W;
  const H = Math.max(1, Math.round((capture.height / Math.max(1, capture.width)) * W));
  // nearest-neighbor downscale to W×H
  const small = new Uint8ClampedArray(W * H * 4);
  const sx = capture.width / W, sy = capture.height / H;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const si = (Math.floor(y * sy) * capture.width + Math.floor(x * sx)) * 4;
      const di = (y * W + x) * 4;
      small[di] = capture.data[si];
      small[di + 1] = capture.data[si + 1];
      small[di + 2] = capture.data[si + 2];
      small[di + 3] = 255;
    }
  }
  const edges: number[] = [];
  const hues: number[] = [];
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = (y * W + x) * 4;
      const gx = Math.abs(small[i] - small[i - 4]) + Math.abs(small[i + 1] - small[i - 3]) + Math.abs(small[i + 2] - small[i - 2]);
      edges.push(gx > RECOLOR_EDGE_T ? 1 : 0);
      const mx = Math.max(small[i], small[i + 1], small[i + 2]);
      const mn = Math.min(small[i], small[i + 1], small[i + 2]);
      // hue via atan2 on the chroma plane (range -π..π). Grayscale (mx===mn) is
      // chromatically undefined -> NaN sentinel. (Do NOT use -1: it is a real angle.)
      hues.push(mx === mn ? Number.NaN : Math.atan2(Math.SQRT1_2 * (small[i + 1] - small[i + 2]), small[i] - (small[i + 1] + small[i + 2]) / 2));
    }
  }
  return { edges, hues };
}

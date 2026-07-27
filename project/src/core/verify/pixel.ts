/**
 * core/verify/pixel — pure rendered-pixel detectors. No DOM.
 *
 * After `apply`, verification reads RENDERED PIXELS — what the user actually sees.
 * These deterministic detectors (void / invisible-text / squeeze / recolor) operate
 * on a `PixelInput` (an ImageData-shaped buffer) + cluster rects, so they are
 * unit-testable without a browser. The content script supplies real captures via
 * chrome.tabs.captureVisibleTab (see capture.ts); the harness supplies them via
 * page.screenshot.
 *
 * All deterministic, zero model calls. A vision model is added only if these
 * detectors are proven insufficient with data.
 */

import { parseColor } from '../../shared/color.ts';

/** An ImageData-shaped buffer (subset). Pure data — no DOM dependency. */
export interface PixelInput {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;   // RGBA, row-major
}

/** A cluster's rendered rect + enough text info to judge it. `fontSize` is the
 *  rendered font size in px (used by the squeeze detector). `role` is the
 *  semantic role (used by the invisible-text detector to scan side-rail labels —
 *  short text on a nav/aside cluster that the >=20-char skip would otherwise miss).
 *  `hasImage` flags a content-image cluster (a thumbnail) — image-bearing clusters
 *  are content, never voids. `hasGradient` flags a gradient/texture background —
 *  the decorative-dead-zone case: a large colorful gradient with NO text or image
 *  reads as content-free even though its pixel variance is HIGH (the old flat-
 *  variance-only detector could never flag the Wikipedia gradient dead-zone). */
export interface ClusterRect {
  handle: string;
  rect: { x: number; y: number; w: number; h: number };
  text: string;
  fontSize?: number;
  role?: string | null;
  hasImage?: boolean;
  hasGradient?: boolean;
}

/** Minimum rendered chars-per-line before text is "squeezed" (matches the DOM-side
 *  MIN_CHARS_PER_LINE in laws). A text container whose effective cpl falls below
 *  this wraps every word — invisible to bleed checks but visibly broken. */
export const PIXEL_MIN_CPL = 12;
/** Below this pixel-variance threshold, a text-bearing rect has near-zero contrast
 *  against its surface = invisible text. Calibrated to match the harness floor. */
export const INVISIBLE_VARIANCE = 15;
/** A void is a large region; require it this big so a tiny empty badge is
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
/** A decorative dead-zone must cover at least this fraction of the viewport to read
 *  as a "drowned content column" rather than a legitimate hero/feature band. The
 *  Wikipedia gradient canvas covered ~90% of the viewport with no content. */
export const DECORATIVE_MIN_VIEWPORT_FRAC = 0.6;
/** Edge-density ceiling for a decorative dead-zone: a real content region has dense
 *  edges (text + images produce many high-contrast transitions). A large gradient/
 *  texture region has sparse edges — smooth color transitions, few sharp jumps. The
 *  ratio of edge pixels (<RECOLOR_EDGE_T) to sampled pixels: below this = decorative. */
export const DECORATIVE_EDGE_DENSITY_MAX = 0.12;

/**
 * VOID detector: a large content-FREE region overlapping a cluster rect. Two cases:
 *  1. FLAT void (the blank-box bug): a large region with near-zero pixel variance —
 *     content was there, the redesign blanked its surface. (Original detector.)
 *  2. DECORATIVE dead-zone (the Wikipedia gradient case): a large region with NO text
 *     and NO image whose background is a gradient/texture (high pixel variance, but
 *     no real content — the gradient DROWNED the content column). The old flat-
 *     variance-only test could never flag this — a colorful gradient has high variance.
 *     Detected by: text-less + image-less + large + a gradient/texture background OR
 *     sparse edge density (a smooth color field, not a text/image surface). Independent
 *     of color flatness — a vivid gradient dead-zone reads as a void here.
 *
 * Returns the handles of clusters that render as voids.
 */
export function detectVoids(capture: PixelInput, rects: ClusterRect[]): string[] {
  const out: string[] = [];
  const captureArea = capture.width * capture.height;
  for (const cr of rects) {
    if (cr.text.trim().length > 0) continue;          // text-bearing clusters are not voids
    if (cr.hasImage) continue;                        // image-bearing clusters are content, not voids
    if (cr.rect.w * cr.rect.h < VOID_MIN_AREA) continue;
    // Case 1: flat void (near-zero variance — the blank-box bug).
    if (variance(capture, cr.rect) < 10) { out.push(cr.handle); continue; }
    // Case 2: decorative dead-zone. A large text-less + image-less region that is NOT
    // a flat void but holds no real content. The signature: the region covers a large
    // fraction of the viewport AND its background is a gradient/texture (hasGradient)
    // OR its rendered pixels are edge-sparse (a smooth color field, not dense text/
    // image edges). This catches the Wikipedia gradient dead-zone the flat-variance
    // test could never see — a colorful gradient has high variance but no content.
    const viewportFrac = captureArea > 0 ? (cr.rect.w * cr.rect.h) / captureArea : 0;
    if (viewportFrac < DECORATIVE_MIN_VIEWPORT_FRAC) continue;
    if (cr.hasGradient) { out.push(cr.handle); continue; }
    if (edgeDensity(capture, cr.rect) < DECORATIVE_EDGE_DENSITY_MAX) out.push(cr.handle);
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
    const textLen = cr.text.trim().length;
    // Side-rail labels (nav/aside) are SHORT — the >=20-char skip would let an
    // invisible side-rail label through. For a rail cluster, scan even short text
    // (the invisible-right-rail-labels bug on a code-hosting site). A rail cluster
    // has role navigation/complementary or is an aside/nav.
    const isRail = cr.role === 'navigation' || cr.role === 'complementary' || cr.role === 'nav' || cr.role === 'aside' || cr.role === 'menu' || cr.role === 'menuitem';
    if (!isRail && textLen <= 20) continue;        // need real text, not a label
    if (isRail && textLen === 0) continue;          // empty rail cluster — nothing to read
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

/** Result of the post-apply pixel verification stage. `critiques` are pixel-grounded
 *  messages the repair router appends to a regeneration request so a visibly-broken
 *  design is mechanically impossible to report as passing. */
export interface PixelVerifyResult {
  voids: string[];          // cluster handles rendering as blank voids
  invisibleText: string[]; // cluster handles whose text renders invisible
  squeeze: string[];       // cluster handles squeezed below readable measure
  recolor: boolean;         // true if before/after reads as a recolor (stock structure, hue-only shift)
  passed: boolean;         // true iff all three lists are empty AND no recolor
  critiques: string[];     // human-readable, for the repair router
}

/** Phase-1 invisible-text failure classes. The repair comment in repair/index.ts
 *  promises the deterministic bg+text pair "guarantees the pixel-invisible ones are
 *  readable regardless" — but the guarantee silently fails in four distinct ways.
 *  Classifying each surviving invisible cluster tells us WHICH root cause to fix
 *  (and that the fix actually covered it), instead of asserting a guarantee the
 *  last run's 28 invisible-text clusters contradicted. Pure: takes the observed
 *  state as data. */
export type InvisibleFailureClass = 'no-handle' | 'wrong-bg' | 'cascade-loss' | 'multi-bg' | 'unknown';

export interface InvisibleFailureRecord {
  handle: string;
  cls: InvisibleFailureClass;
  evidence: string;
}

export interface InvisibleBreakdown {
  records: InvisibleFailureRecord[];
  byClass: Record<InvisibleFailureClass, number>;
}

/**
 * Classify each SURVIVING invisible-text cluster (invisible AFTER repair) into its
 * failure class. Pure — the DOM/apply side gathers the inputs and passes them as data:
 *   - invisible     : the handles still flagged by detectInvisibleText after repair.
 *   - emittedBg     : handle -> the bg color compile's forceContrast pair actually
 *                     painted on that cluster (from the emitted CSS; '' if none emitted
 *                     — the silent-skip case).
 *   - liveEffBg     : handle -> the effective background the text SITS on now, walked
 *                     from the live DOM (an ancestor's painted panel, a gradient stop).
 *   - multiBg      : handle -> true if the cluster's rect spans >1 distinct opaque-
 *                     ancestor background (a wide footer over two bg zones).
 * A cluster with no emitted pair = cascade-loss (our rule lost the cascade or the
 * handle vanished from perception). A pair whose emitted bg != live effective bg =
 * wrong-bg (we painted readable text against the WRONG surface). A cluster spanning
 * multiple bgs = multi-bg (one pair can't cover both). The classes are mutually
 * exclusive in priority order: no-handle is detected upstream (no [data-wm-c]); here
 * the survivors all have handles, so the classes are wrong-bg / cascade-loss / multi-bg.
 */
export function classifyInvisibleFailures(
  invisible: string[],
  emittedBg: Map<string, string>,
  liveEffBg: Map<string, string>,
  multiBg: Set<string>,
): InvisibleBreakdown {
  const records: InvisibleFailureRecord[] = [];
  const byClass: Record<InvisibleFailureClass, number> = { 'no-handle': 0, 'wrong-bg': 0, 'cascade-loss': 0, 'multi-bg': 0, unknown: 0 };
  for (const h of invisible) {
    const emitted = emittedBg.get(h) ?? '';
    const live = liveEffBg.get(h) ?? '';
    let cls: InvisibleFailureClass;
    let evidence: string;
    if (multiBg.has(h)) {
      cls = 'multi-bg';
      evidence = `cluster spans >1 distinct background (emitted bg=${emitted || 'none'}; live spans multiple surfaces)`;
    } else if (!emitted) {
      // No pair was emitted for this handle — either the handle vanished from the
      // live perception (compile's `if (!cl) continue` silent skip) or our rule lost
      // the cascade to a site !important rule (the pair was emitted but didn't win).
      // Distinguish by whether the handle is in the live map at all.
      cls = live ? 'cascade-loss' : 'cascade-loss';
      evidence = live ? `no emitted pair won for ${h} (cascade-loss: site rule beat [data-wm-c], or handle-target mismatch; live eff bg=${live})` : `handle ${h} not in live perception (compile silently skipped — cascade-loss)`;
    } else if (live && emitted && !sameColor(emitted, live)) {
      cls = 'wrong-bg';
      evidence = `pair derived from ${emitted} but text sits on ${live} — readable against the WRONG surface`;
    } else {
      cls = 'unknown';
      evidence = `emitted=${emitted} live=${live} — still invisible after a matching pair (residual: gradient stop not covered, or sub-pixel rendering)`;
    }
    byClass[cls]++;
    records.push({ handle: h, cls, evidence });
  }
  return { records, byClass };
}

/** Two CSS color strings are "the same surface" if they parse to the same opaque RGB.
 *  Loose (the live eff bg may be a rounded rgb() vs the emitted hex); unparseable
 *  sides (gradients/keywords) count as same only if the strings match. Pure — reuses
 *  the shared parseColor (one color parser in the codebase, not two). */
function sameColor(a: string, b: string): boolean {
  if (a === b) return true;
  const pa = parseColor(a), pb = parseColor(b);
  if (pa && pb && pa[3] >= 0.9 && pb[3] >= 0.9) return pa[0] === pb[0] && pa[1] === pb[1] && pa[2] === pb[2];
  return false;
}

/**
 * Run the rect-based detectors (void / invisible-text / squeeze) across the
 * captured positions and aggregate. Pure: takes captures + per-capture cluster
 * rects as data. Each capture MUST be paired with rects built at the SAME scroll
 * position — `getBoundingClientRect()` returns viewport-relative coords, so a rect
 * from scrollY=0 misaligned against a capture at scrollY=h/2 reads the wrong pixels
 * (the false-positive source). The caller builds one rects array per capture.
 * When a `before` capture is supplied, also runs the recolor detector (compares
 * the before to captures[0], the scrollY=0 after-shot).
 */
export function pixelVerify(captures: PixelInput[], rectsPerCapture: ClusterRect[][], before?: PixelInput): PixelVerifyResult {
  const voids: string[] = [];
  const invisible: string[] = [];
  const squeeze: string[] = [];
  // Track which voids are DECORATIVE dead-zones (gradient/texture, no content) so the
  // critique can tell the Architect to REMOVE/COLLAPSE the decorative wrapper, not just
  // "restore content" (the Wikipedia case: the gradient canvas drowned the content column).
  const decorativeVoids = new Set<string>();
  for (let ci = 0; ci < captures.length; ci++) {
    const c = captures[ci];
    const rects = rectsPerCapture[ci] ?? [];
    for (const h of detectVoids(c, rects)) {
      if (!voids.includes(h)) {
        voids.push(h);
        const cr = rects.find((r) => r.handle === h);
        // A decorative dead-zone: not a flat void (variance >= 10) — it's a gradient/
        // texture region with no content. The Architect should remove/collapse it.
        if (cr && (cr.hasGradient || variance(c, cr.rect) >= 10)) decorativeVoids.add(h);
      }
    }
    for (const h of detectInvisibleText(c, rects)) if (!invisible.includes(h)) invisible.push(h);
  }
  // Squeeze is geometry-only (rect width vs font size) — any capture's rects suffice.
  const squeezeRects = rectsPerCapture[0] ?? [];
  for (const cr of squeezeRects) for (const h of detectSqueeze(cr)) if (!squeeze.includes(h)) squeeze.push(h);
  // Recolor: stock structure + hue-only shift = a recolor, mechanically. Only when
  // a before-capture is supplied. captures[0] = the scrollY=0 after-shot.
  const recolor = before && captures.length > 0 ? detectRecolor(before, captures[0]) : false;
  const passed = voids.length === 0 && invisible.length === 0 && squeeze.length === 0 && !recolor;
  const critiques = [
    ...voids.map((h) => decorativeVoids.has(h)
      ? `cluster ${h} is a DECORATIVE DEAD-ZONE — a large gradient/texture region with NO text or image content that drowned the page's content. CSS cannot collapse this; you MUST use a "remove" op on the decorative wrapper (or restyle it so the content column reclaims the space). Do NOT decorate it — remove it or let the content use the room.`
      : `cluster ${h} renders as a blank void — content was there but the surface is now uniform`),
    ...invisible.map((h) => `cluster ${h} renders invisible — its text has near-zero contrast against its effective background`),
    ...squeeze.map((h) => `cluster ${h} text is squeezed below a readable measure (chars-per-line < floor) — widen it`),
  ];
  if (recolor) critiques.push('The redesign reads as a RECOLOR — the edge/structure map is near-identical to the original and only the hue shifted. A recolor is a FAILURE. You MUST change the structural layout: column count, content/region widths, spacing, arrangement — not just paint.');
  return { voids, invisibleText: invisible, squeeze, recolor, passed, critiques };
}


/** Per-channel max-min span summed across RGB, sampled over the rect. Pure. */
function variance(capture: PixelInput, rect: { x: number; y: number; w: number; h: number }): number {
  const { width: W, data } = capture;
  let minR = 255, maxR = 0, minG = 255, maxG = 0, minB = 255, maxB = 0;
  const step = 4;
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(capture.width, Math.ceil(rect.x + rect.w));
  const y1 = Math.min(capture.height, Math.ceil(rect.y + rect.h));
  let sampled = 0;
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const i = (y * W + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (r < minR) minR = r; if (r > maxR) maxR = r;
      if (g < minG) minG = g; if (g > maxG) maxG = g;
      if (b < minB) minB = b; if (b > maxB) maxB = b;
      sampled++;
    }
  }
  // No pixels in bounds (rect entirely outside the capture) — return max variance
  // so the cluster is NOT flagged as invisible (the false-positive source when the
  // capture is downscaled or the rect is at a different scroll position).
  if (sampled === 0) return 765;
  return (maxR - minR) + (maxG - minG) + (maxB - minB);
}

/** Edge density: fraction of sampled pixels in the rect that are EDGE pixels (a
 *  per-channel abs delta > RECOLOR_EDGE_T vs the previous pixel). A real content
 *  region (text + images) has dense high-contrast transitions; a large gradient/
 *  texture field has sparse edges — smooth color transitions. Used to detect a
 *  DECORATIVE dead-zone independent of color flatness (a colorful gradient has high
 *  variance but low edge density). Pure. */
function edgeDensity(capture: PixelInput, rect: { x: number; y: number; w: number; h: number }): number {
  const { width: W, data } = capture;
  const x0 = Math.max(1, Math.floor(rect.x));
  const y0 = Math.max(1, Math.floor(rect.y));
  const x1 = Math.min(capture.width - 1, Math.ceil(rect.x + rect.w));
  const y1 = Math.min(capture.height - 1, Math.ceil(rect.y + rect.h));
  let edges = 0, sampled = 0;
  const step = 4;
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const i = (y * W + x) * 4;
      const il = i - 4;     // left neighbor
      const it = i - W * 4; // top neighbor
      const dr = Math.abs(data[i] - data[il]) + Math.abs(data[i] - data[it]);
      const dg = Math.abs(data[i + 1] - data[il + 1]) + Math.abs(data[i + 1] - data[it + 1]);
      const db = Math.abs(data[i + 2] - data[il + 2]) + Math.abs(data[i + 2] - data[it + 2]);
      if ((dr + dg + db) / 2 > RECOLOR_EDGE_T) edges++;
      sampled++;
    }
  }
  return sampled > 0 ? edges / sampled : 0;
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

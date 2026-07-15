/**
 * core/verify — post-apply gate. Three not-broken checks + quality signals:
 *   changed   — did layout actually move? (LENIENT: low MIN_CHANGE_SCORE)
 *   coherent  — accent used sparingly (area-measured) AND surfaces not uniformly
 *               framed (count-measured over distinct clusters)
 *   noOverlap — our CSS introduced no NEW region collisions vs the original page
 *               (compares before/after overlap counts, so pre-existing floating/
 *               sticky overlaps never false-fail)
 */

import { findPrimaryContentNode, captureLayoutFingerprint, type LayoutFingerprint } from '../perceive/index.ts';
import {
  MIN_CONTRAST_RATIO, MAX_OVERFLOW_RATIO, CONTRAST_SAMPLE_COUNT,
  MIN_CHANGE_SCORE, MAX_ACCENT_FRACTION, MAX_FRAMED_FRACTION, MIN_COVERAGE_FRACTION, PERCEPTIBLE_COLOR_DELTA,
  luminanceCompatible, MIN_CHARS_PER_LINE,
} from '../laws/index.ts';
import { parseColor, contrastRatio, colorfulness, colorDistance, type RGBA } from '../../shared/color.ts';

const OVERLAP_TOLERANCE = 2; // allow minor noise / a couple of self-inflicted-but-benign overlaps

export interface VerifyResult {
  passed: boolean;
  checks: { notBlank: boolean; noOverflow: boolean; noOverlap: boolean; contrastOk: boolean; changed: boolean; coherent: boolean; covered: boolean };
  changeScore: number;
  accentFraction: number;
  framedFraction: number;
  coverageFraction: number;
  overflowTargets: string[];   // cluster handles whose box extends past the viewport — targeted repair clamps only these
  bleedTargets: string[];      // cluster handles whose text bleeds its block — targeted word-break repair (Mech 3)
  squeezeTargets: string[];    // cluster handles whose text is squeezed (< MIN_CHARS_PER_LINE) — targeted columnCount/width drop (Fix 3)
  contrastTargets: string[];   // cluster handles carrying flagged low-contrast text — targeted forceContrast fixes these
  repeatedAccent: boolean;     // any repeated cluster with an identical model-painted accent bg (absolute law, Mech 4)
  details: string[];
}

export function verifyStyle(before: LayoutFingerprint, paletteMode?: 'restrained' | 'vivid'): VerifyResult {
  const details: string[] = [];
  const after = captureLayoutFingerprint();

  // 1) Content present and painted.
  const primary = findPrimaryContentNode();
  let notBlank = false;
  if (primary) {
    const rect = primary.getBoundingClientRect();
    const text = (primary.textContent || '').trim();
    notBlank = rect.width > 0 && rect.height > 0 && text.length > 0;
    if (!notBlank) details.push(`primary content collapsed (${Math.round(rect.width)}x${Math.round(rect.height)})`);
  } else {
    details.push('no primary content node found — page may be blank');
  }

  // 2) No horizontal blow-out.
  const scrollW = document.documentElement.scrollWidth;
  const innerW = window.innerWidth || 1;
  const pageOverflowOk = scrollW / innerW <= MAX_OVERFLOW_RATIO;
  if (!pageOverflowOk) details.push(`layout blow-out: ${(scrollW / innerW).toFixed(2)}`);
  // NEW text bleeds (oversized type escaping its painted block) count as overflow
  // so the existing dropPadding -> dropSizing -> dropLayout escalation fixes them
  // (dropLayout strips fontSize, restoring the original fit).
  const noNewBleeds = after.bleedCount <= before.bleedCount;
  if (!noNewBleeds) details.push(`text bleeds its block: ${before.bleedCount} -> ${after.bleedCount}`);
  const noOverflow = pageOverflowOk && noNewBleeds;

  // 3) No NEW region collisions vs the original page.
  const noOverlap = after.overlapCount <= before.overlapCount + OVERLAP_TOLERANCE;
  if (!noOverlap) details.push(`new region overlaps: ${before.overlapCount} -> ${after.overlapCount}`);

  // 4) Contrast sane. Collect the specific cluster handles that carry flagged
  // low-contrast text so forceContrast can fix exactly those (Fix 2).
  const contrastFlags = new Set<string>();
  const contrastOk = checkContrast(details, contrastFlags);

  // 5) Layout actually changed (lenient).
  const changeScore = fingerprintDelta(before, after);
  const changed = changeScore >= MIN_CHANGE_SCORE;

  // 6) Coherence: sparing accent (area, restrained only) + non-uniform framing +
  // the absolute repeated-accent law (never identical accent on every member of
  // a repeated cluster — enforced in BOTH modes). Vivid lifts the area cap but
  // the repeated-accent law stays absolute (Mechanism 4).
  const accentFraction = measureAccentAreaFraction();
  const framedFraction = measureFramedClusterFraction();
  const repeatedAccent = checkRepeatedAccent(before);
  const accentOk = paletteMode === 'vivid' || accentFraction <= MAX_ACCENT_FRACTION;
  const coherent = accentOk && !repeatedAccent && framedFraction <= MAX_FRAMED_FRACTION;
  if (repeatedAccent) details.push('repeated-accent violation: identical accent on every member of a repeated cluster');

  // 7) Coverage: every region must be part of the design — repainted (by a
  // PERCEPTIBLE color delta, not epsilon jitter), moved/resized, or hidden.
  // LUMINANCE-AWARE (Mechanism 2): a text-color-only delta on a background that
  // clashes with the canvas does NOT count — the white-strip false pass.
  const canvasBg = readEffectiveCanvasBg();
  const coverageFraction = measureCoverage(before, after, canvasBg, details);
  const covered = coverageFraction >= MIN_COVERAGE_FRACTION;
  if (!covered) details.push(`page under-covered: ${(coverageFraction * 100).toFixed(0)}% of regions addressed`);
  details.push(`changeScore=${changeScore.toFixed(3)} accent=${accentFraction.toFixed(3)} framed=${framedFraction.toFixed(3)} coverage=${coverageFraction.toFixed(3)}`);

  // Which clusters overflow (for targeted repair) — computed regardless so repair can use it.
  const overflowTargets = findOverflowTargets();
  const bleedTargets = findBleedTargets();
  const squeezeTargets = findSqueezeTargets();

  const passed = notBlank && noOverflow && noOverlap && contrastOk && changed && coherent && covered;
  return { passed, checks: { notBlank, noOverflow, noOverlap, contrastOk, changed, coherent, covered }, changeScore, accentFraction, framedFraction, coverageFraction, overflowTargets, bleedTargets, squeezeTargets, contrastTargets: [...contrastFlags], repeatedAccent, details };
}

/**
 * Cluster handles whose own box extends past the viewport (geometric overflow).
 * Lets repair clamp ONLY the offenders instead of nuking every cluster's layout.
 * One representative per handle. (Text bleeds are handled separately by findBleedTargets.)
 */
function findOverflowTargets(): string[] {
  const innerW = window.innerWidth || 1280;
  const seen = new Set<string>();
  const targets: string[] = [];
  for (const el of Array.from(document.querySelectorAll('[data-wm-c]'))) {
    if (!(el instanceof HTMLElement) || el.hasAttribute('data-webmorph-ui')) continue;
    const h = el.getAttribute('data-wm-c')!;
    if (seen.has(h)) continue;
    const r = el.getBoundingClientRect();
    if (r.right > innerW + 4 || r.width > innerW + 4) { seen.add(h); targets.push(h); }
  }
  return targets;
}

/**
 * Cluster handles whose text content bleeds horizontally out of its own block
 * (Mechanism 3). Long unbreakable strings (code identifiers, nav labels) in a
 * narrowed container with overflow:visible. Lets repair emit overflow-wrap on
 * ONLY the bleeding clusters — free, deterministic, before any structural repair.
 * One representative per handle.
 */
function findBleedTargets(): string[] {
  const seen = new Set<string>();
  const targets: string[] = [];
  for (const el of Array.from(document.querySelectorAll('[data-wm-c]'))) {
    if (!(el instanceof HTMLElement) || el.hasAttribute('data-webmorph-ui')) continue;
    const h = el.getAttribute('data-wm-c')!;
    if (seen.has(h)) continue;
    const cs = getComputedStyle(el);
    if (cs.overflowX === 'visible' && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 8) {
      seen.add(h);
      targets.push(h);
    }
  }
  return targets;
}

/**
 * Cluster handles whose text is squeezed — effective chars-per-line falls below
 * MIN_CHARS_PER_LINE (Fix 3). Text that "fits" but wraps every word (one-char-
 * per-line, or 3-4 chars per line) is invisible to bleed checks but visibly
 * broken. Measured via clientWidth / (fontSize × 0.5) — no per-node layout thrash.
 * Only flags clusters with substantial text (not empty containers or tiny labels).
 * One representative per handle.
 */
function findSqueezeTargets(): string[] {
  const seen = new Set<string>();
  const targets: string[] = [];
  for (const el of Array.from(document.querySelectorAll('[data-wm-c]'))) {
    if (!(el instanceof HTMLElement) || el.hasAttribute('data-webmorph-ui')) continue;
    const h = el.getAttribute('data-wm-c')!;
    if (seen.has(h)) continue;
    // Only check clusters with substantial text content
    if ((el.textContent || '').trim().length < 40) continue;
    if (el.clientWidth <= 0 || el.clientHeight < 40) continue;
    const cs = getComputedStyle(el);
    const fs = parseFloat(cs.fontSize) || 16;
    const avgCharW = fs * 0.5; // approximate average char width for proportional fonts
    const cpl = el.clientWidth / avgCharW;
    if (cpl < MIN_CHARS_PER_LINE) {
      seen.add(h);
      targets.push(h);
    }
  }
  return targets;
}

// ── change signal ──────────────────────────────────────────────────

function fingerprintDelta(a: LayoutFingerprint, b: LayoutFingerprint): number {
  const bMap = new Map(b.regions.map((r) => [r.handle, r]));
  let shared = 0, moved = 0;
  for (const ra of a.regions) {
    const rb = bMap.get(ra.handle);
    if (!rb) continue;
    shared++;
    const d = Math.abs(ra.x - rb.x) + Math.abs(ra.y - rb.y) + Math.abs(ra.w - rb.w) + Math.abs(ra.h - rb.h);
    if (d > 12) moved++;
  }
  const regionFrac = shared ? moved / shared : 0;
  let widthFrac = 0;
  if (a.contentMaxWidthPx && b.contentMaxWidthPx) widthFrac = Math.min(1, Math.abs(a.contentMaxWidthPx - b.contentMaxWidthPx) / a.contentMaxWidthPx);
  const colFrac = a.columnCount !== b.columnCount ? 1 : 0;
  const maxA = a.typeSizesPx[a.typeSizesPx.length - 1] || 0;
  const maxB = b.typeSizesPx[b.typeSizesPx.length - 1] || 0;
  const typeFrac = maxA || maxB ? Math.min(1, Math.abs(maxA - maxB) / Math.max(maxA, maxB, 1)) : 0;
  return clamp01(regionFrac * 0.45 + widthFrac * 0.25 + colFrac * 0.15 + typeFrac * 0.15);
}

/**
 * Fraction of before-regions ADDRESSED by the design: repainted by a PERCEPTIBLE
 * color delta (not epsilon jitter), visibly moved/resized, or hidden entirely.
 * LUMINANCE-AWARE (Mechanism 2): a text-color-only delta on a background that
 * clashes with the canvas does NOT count as addressed — the white-strip false
 * pass where a white header sat on a near-black canvas with only its text
 * recolored. Pure math on measured luminance. One representative per handle;
 * before/after comparison so a site's own quirks never false-fail.
 */
function measureCoverage(a: LayoutFingerprint, b: LayoutFingerprint, canvasBg: string, details: string[]): number {
  const bMap = new Map<string, LayoutFingerprint['regions'][number]>();
  for (const r of b.regions) if (!bMap.has(r.handle)) bMap.set(r.handle, r);
  const seen = new Set<string>();
  let total = 0;
  let addressed = 0;
  const unaddressed: string[] = [];
  for (const ra of a.regions) {
    if (seen.has(ra.handle)) continue;
    seen.add(ra.handle);
    total++;
    const rb = bMap.get(ra.handle);
    if (!rb) { addressed++; continue; } // gone = hidden = a deliberate design decision
    const moved = Math.abs(ra.x - rb.x) + Math.abs(ra.y - rb.y) + Math.abs(ra.w - rb.w) + Math.abs(ra.h - rb.h) > 12;
    const [bgA, fgA] = ra.paint.split('|');
    const [bgB, fgB] = rb.paint.split('|');
    const bgD = perceptibleDelta(bgA, bgB);
    const fgD = perceptibleDelta(fgA, fgB);
    const isAddressed = regionAddressed(moved, bgD, fgD, bgA, canvasBg);
    if (isAddressed) addressed++;
    else if (unaddressed.length < 8) {
      const clash = fgD >= PERCEPTIBLE_COLOR_DELTA && bgD < PERCEPTIBLE_COLOR_DELTA && !luminanceCompatible(bgA, canvasBg);
      unaddressed.push(`${ra.handle}(bgΔ${Math.round(bgD)} fgΔ${Math.round(fgD)}${clash ? ' CLASH' : ''})`);
    }
  }
  details.push(`coverage ${addressed}/${total} addressed${unaddressed.length ? `; unaddressed: ${unaddressed.join(', ')}` : ''}`);
  return total ? addressed / total : 1;
}

/**
 * Whether a region counts as "addressed" — luminance-aware. PURE: takes all
 * inputs as data so it's unit-testable without a DOM (Mechanism 2).
 *  - moved → addressed
 *  - bg perceptibly repainted → addressed
 *  - text-only delta (bg NOT repainted) → addressed ONLY IF the region's
 *    existing bg is luminance-compatible with the canvas (else it's a foreign
 *    strip: white-on-near-black with recolored text still reads as original).
 */
export function regionAddressed(
  moved: boolean,
  bgDelta: number,
  fgDelta: number,
  regionBg: string,
  canvasBg: string,
): boolean {
  if (moved) return true;
  if (bgDelta >= PERCEPTIBLE_COLOR_DELTA) return true;
  if (fgDelta >= PERCEPTIBLE_COLOR_DELTA) {
    return luminanceCompatible(regionBg, canvasBg);
  }
  return false;
}

/** The effective canvas background after apply — read from the DOM (body, then html). */
function readEffectiveCanvasBg(): string {
  const body = getComputedStyle(document.body).backgroundColor;
  if (!isTransparentColor(body)) return body;
  return getComputedStyle(document.documentElement).backgroundColor;
}

function isTransparentColor(s: string): boolean {
  const c = parseColor(s);
  return c == null || c[3] < 0.1;
}

/** Perceptible RGB distance between two computed-color strings; unparseable-but-different (e.g. a gradient) counts as a full change. */
function perceptibleDelta(a: string, b: string): number {
  if (a === b) return 0;
  const pa = parseColor(a);
  const pb = parseColor(b);
  if (pa && pb) return colorDistance(pa, pb);
  return 999; // one side is a gradient/url/keyword and they differ — a real change
}

// ── coherence metrics ──────────────────────────────────────────────

/**
 * Repeated-accent violation (Mechanism 4, absolute law). Detects a repeated
 * cluster (multiple elements sharing a handle) where the model painted an
 * identical colorful background on every member. Compares against the before-
 * fingerprint so an ORIGINAL colorful repeated cluster (site's own, not model-
 * painted) is NOT a false positive — coverage catches those separately.
 */
function checkRepeatedAccent(before: LayoutFingerprint): boolean {
  const beforeBg = new Map<string, string>();
  for (const r of before.regions) if (!beforeBg.has(r.handle)) beforeBg.set(r.handle, r.paint.split('|')[0]);

  const counts = new Map<string, number>();
  for (const el of Array.from(document.querySelectorAll('[data-wm-c]'))) {
    if (el.hasAttribute('data-webmorph-ui')) continue;
    const h = el.getAttribute('data-wm-c')!;
    counts.set(h, (counts.get(h) ?? 0) + 1);
  }

  for (const [h, count] of counts) {
    if (count <= 1) continue;
    const rep = document.querySelector(`[data-wm-c="${h}"]`);
    if (!rep) continue;
    const afterC = parseColor(getComputedStyle(rep).backgroundColor);
    if (!afterC || colorfulness(afterC) < 0.35) continue; // not colorful after apply
    const beforeC = parseColor(beforeBg.get(h) ?? '');
    if (!beforeC || colorfulness(beforeC) < 0.35) return true; // model introduced accent on a repeated cluster
    // was already colorful before -> original, not a model violation (coverage handles it)
  }
  return false;
}

/** Accent: real painted area of colorful backgrounds ÷ viewport (catches "every link red"). */
function measureAccentAreaFraction(): number {
  const vpArea = (window.innerWidth || 1280) * (window.innerHeight || 800);
  let sum = 0;
  for (const el of Array.from(document.querySelectorAll('[data-wm-c]'))) {
    if (el.hasAttribute('data-webmorph-ui')) continue;
    const bg = parseColor(getComputedStyle(el).backgroundColor);
    if (!bg || colorfulness(bg) < 0.35) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    sum += Math.min(r.width * r.height, vpArea);
  }
  return Math.min(1, sum / vpArea);
}

/**
 * Framed: fraction of DISTINCT clusters (one representative each) carrying a heavy
 * border/offset-shadow. Count-based (not area) so large nested containers don't
 * saturate it — catches "border everything" without false-failing normal designs.
 */
function measureFramedClusterFraction(): number {
  const seen = new Set<string>();
  let total = 0, framed = 0;
  for (const el of Array.from(document.querySelectorAll('[data-wm-c]'))) {
    const h = el.getAttribute('data-wm-c')!;
    if (seen.has(h)) continue;
    seen.add(h);
    total++;
    const cs = getComputedStyle(el);
    const bw = parseFloat(cs.borderTopWidth) || 0;
    // Heavy border on all four sides is the reliable "frame everything" signal;
    // ignore pre-existing subtle shadows to avoid false-fails.
    if (bw >= 3 && cs.borderTopStyle !== 'none' && (parseFloat(cs.borderBottomWidth) || 0) >= 3) framed++;
  }
  return total ? framed / total : 0;
}

// ── contrast ───────────────────────────────────────────────────────

function checkContrast(details: string[], targets: Set<string>): boolean {
  // Largest type first: display/hero text is the most visible place to fail, and
  // document-order sampling used to spend the entire budget on nav links (the
  // washed-out coffee-shop hero passed exactly this way).
  const candidates = Array.from(document.querySelectorAll('h1, h2, h3, h4, p, li, td, a, span, blockquote'))
    .filter((el) => !el.hasAttribute('data-webmorph-ui') && (el.textContent || '').trim().length >= 5)
    .slice(0, 200)
    .map((el) => ({ el, fs: parseFloat(getComputedStyle(el).fontSize) || 0 }))
    .sort((a, b) => b.fs - a.fs);
  let checked = 0, failed = 0, failedTop = 0;
  for (const { el } of candidates) {
    if (checked >= CONTRAST_SAMPLE_COUNT) break;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const fg = parseColor(getComputedStyle(el).color);
    if (!fg) continue;
    checked++;
    if (contrastRatio(fg, effectiveBackground(el)) < MIN_CONTRAST_RATIO) {
      failed++;
      if (checked <= 3) failedTop++; // a failure among the biggest text is never acceptable
      // Record the cluster handle this text belongs to so forceContrast can fix it.
      const h = el.closest('[data-wm-c]')?.getAttribute('data-wm-c');
      if (h) targets.add(h);
      details.push(`low contrast on "${(el.textContent || '').trim().slice(0, 24)}"`);
    }
  }
  return !(checked > 0 && (failedTop > 0 || failed > checked / 2));
}

function effectiveBackground(el: Element): RGBA {
  let cur: Element | null = el;
  while (cur) {
    const c = parseColor(getComputedStyle(cur).backgroundColor);
    if (c && c[3] >= 0.1) return c;
    cur = cur.parentElement;
  }
  return [255, 255, 255, 1];
}

function clamp01(n: number): number { return Math.max(0, Math.min(1, n)); }

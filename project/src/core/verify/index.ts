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
  MIN_CONTRAST_RATIO, MAX_OVERFLOW_RATIO, CONTRAST_SAMPLE_COUNT, CONTRAST_MAX_FAILURES, CONTRAST_TOP_FAIL_COUNT,
  MIN_CHANGE_SCORE, MAX_ACCENT_FRACTION, MAX_FRAMED_FRACTION, MIN_COVERAGE_FRACTION, MIN_MODEL_COVERAGE_FRACTION, PERCEPTIBLE_COLOR_DELTA,
  luminanceCompatible, MIN_CHARS_PER_LINE,
} from '../laws/index.ts';
import { parseColor, contrastRatio, colorfulness, colorDistance, type RGBA } from '../../shared/color.ts';

const OVERLAP_TOLERANCE = 2; // allow minor noise / a couple of self-inflicted-but-benign overlaps

export interface VerifyResult {
  passed: boolean;
  checks: { notBlank: boolean; noOverflow: boolean; noOverlap: boolean; contrastOk: boolean; changed: boolean; coherent: boolean; covered: boolean; contentCollapsed: boolean; contentVisible: boolean; layoutReshaped: boolean };
  changeScore: number;
  layoutReshapedScore: number;   // Round 9: structural-change signal (columns + content width + region widths)
  accentFraction: number;
  framedFraction: number;
  coverageFraction: number;         // total: model + base-coat + hide
  modelCoverageFraction: number;    // model rules only (prevents base-coat-only escape)
  overflowTargets: string[];
  bleedTargets: string[];
  squeezeTargets: string[];
  collapseTargets: string[];   // handles of regions that collapsed (>100px→<20px) — for targeted repair
  contrastTargets: string[];
  contrastTargetBgs: Record<string, string>;   // handle -> effective bg the flagged text sits on
  repeatedAccent: boolean;
  details: string[];
}

export function verifyStyle(before: LayoutFingerprint, paletteMode?: 'restrained' | 'vivid', modelAddressed?: Set<string>): VerifyResult {
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

  // 1b) Content not collapsed — no significant before-region shrank to near-zero.
  // Catches the "blank void below the fold" failure: content containers that
  // were >100px tall before but <20px after (or gone entirely) = collapsed.
  const afterByHandle = new Map<string, LayoutFingerprint['regions'][number]>();
  for (const r of after.regions) if (!afterByHandle.has(r.handle)) afterByHandle.set(r.handle, r);
  const collapsedRegions: string[] = [];
  for (const ra of before.regions) {
    if (ra.h < 100) continue;
    const rb = afterByHandle.get(ra.handle);
    if (!rb || rb.h < 20) collapsedRegions.push(ra.handle);
  }
  const contentCollapsed = collapsedRegions.length === 0;
  if (!contentCollapsed) {
    const detail = collapsedRegions.slice(0, 6).map((h) => {
      const rb = before.regions.find((r) => r.handle === h);
      const ra = afterByHandle.get(h);
      return `${h}(${rb?.h ?? '?'}px→${ra?.h ?? 'gone'}px)`;
    }).join(', ');
    details.push(`content collapsed: ${collapsedRegions.length} region(s): ${detail}`);
  }

  // 1c) Content visible — no significant cluster has opacity near-zero.
  // Catches the model using opacity:0 to hide content (bypasses hideRefusal).
  let invisibleCount = 0;
  for (const el of Array.from(document.querySelectorAll('[data-wm-c]'))) {
    if (el.hasAttribute('data-webmorph-ui')) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 50 || rect.height < 50) continue;
    if (parseFloat(getComputedStyle(el).opacity) < 0.1) invisibleCount++;
  }
  const contentVisible = invisibleCount === 0;
  if (!contentVisible) details.push(`${invisibleCount} cluster(s) have opacity < 0.1 — content may be invisible`);

  // 2) No horizontal blow-out — DELTA: flag only overflow WE introduced, not pre-existing.
  const scrollW = document.documentElement.scrollWidth;
  const innerW = window.innerWidth || 1;
  const beforeRatio = before.scrollWidth / innerW;
  const afterRatio = scrollW / innerW;
  const pageOverflowOk = afterRatio <= Math.max(beforeRatio * 1.02, MAX_OVERFLOW_RATIO) + 0.01;
  if (!pageOverflowOk) details.push(`layout blow-out: ${afterRatio.toFixed(2)} (before=${beforeRatio.toFixed(2)})`);
  const noNewBleeds = after.bleedCount <= before.bleedCount;
  if (!noNewBleeds) details.push(`text bleeds its block: ${before.bleedCount} -> ${after.bleedCount}`);
  const noOverflow = pageOverflowOk && noNewBleeds;

  // 3) No NEW region collisions vs the original page.
  const noOverlap = after.overlapCount <= before.overlapCount + OVERLAP_TOLERANCE;
  if (!noOverlap) details.push(`new region overlaps: ${before.overlapCount} -> ${after.overlapCount}`);

  // 4) Contrast sane. Collect the specific cluster handles that carry flagged
  // low-contrast text so forceContrast can fix exactly those (Fix 2).
  const contrastFlags = new Set<string>();
  const contrastTargetBgs = new Map<string, string>();
  const contrastOk = checkContrast(details, contrastFlags, contrastTargetBgs);

  // 5) Layout actually changed (lenient).
  const changeScore = fingerprintDelta(before, after);
  const changed = changeScore >= MIN_CHANGE_SCORE;

  // 5b) STRUCTURAL reshape — the recolor-killer. changeScore blends paint-jitter
  // and padding shifts, so a recolor can pass it. This measures the two signals
  // that distinguish a real redesign from a recolor: did the column count change,
  // did the content width change materially, did major regions change width?
  // Round 9: LOG ONLY this run — calibrate the threshold from real data before
  // adding it to `passed` (enforce second).
  const columnsReshaped = before.columnCount !== after.columnCount;
  const wBefore = before.contentMaxWidthPx, wAfter = after.contentMaxWidthPx;
  const contentWidthChangedRel = (wBefore && wAfter) ? Math.abs(wAfter - wBefore) / wBefore : 0;
  let widthShared = 0, widthChanged = 0;
  for (const ra of before.regions) {
    const rb = afterByHandle.get(ra.handle);
    if (!rb) continue;
    widthShared++;
    if (Math.abs(ra.w - rb.w) > 24) widthChanged++;
  }
  const regionWidthChangedFrac = widthShared ? widthChanged / widthShared : 0;
  const layoutReshapedScore = clamp01((columnsReshaped ? 0.4 : 0) + Math.min(0.4, contentWidthChangedRel) + regionWidthChangedFrac * 0.2);
  const layoutReshaped = columnsReshaped || contentWidthChangedRel > 0.2 || regionWidthChangedFrac > 0.4;
  details.push(`layoutReshaped=${layoutReshaped} score=${layoutReshapedScore.toFixed(3)} cols=${before.columnCount}→${after.columnCount} contentW=${wBefore ?? '?'}→${wAfter ?? '?'} (${(contentWidthChangedRel * 100).toFixed(0)}%) regionWidthChanged=${(regionWidthChangedFrac * 100).toFixed(0)}%`);

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
  // SPLIT: total coverage (model + base-coat + hide) ≥ 0.85, model-only ≥ 0.40.
  // The model coverage gate prevents the base-coat-only escape.
  const canvasBg = readEffectiveCanvasBg();
  const { totalFraction, modelFraction } = measureCoverage(before, after, canvasBg, details, modelAddressed);
  const coverageFraction = totalFraction;
  const modelCoverageFraction = modelFraction;
  const covered = coverageFraction >= MIN_COVERAGE_FRACTION && modelCoverageFraction >= MIN_MODEL_COVERAGE_FRACTION;
  if (!covered) {
    if (coverageFraction < MIN_COVERAGE_FRACTION) details.push(`page under-covered: ${(coverageFraction * 100).toFixed(0)}% of regions addressed`);
    if (modelCoverageFraction < MIN_MODEL_COVERAGE_FRACTION) details.push(`model under-covered: only ${(modelCoverageFraction * 100).toFixed(0)}% by model rules (base-coat is safety net, not design)`);
  }
  details.push(`changeScore=${changeScore.toFixed(3)} accent=${accentFraction.toFixed(3)} framed=${framedFraction.toFixed(3)} coverage=${coverageFraction.toFixed(3)} modelCoverage=${modelCoverageFraction.toFixed(3)}`);

  // Which clusters overflow (for targeted repair) — computed regardless so repair can use it.
  const overflowTargets = findOverflowTargets();
  const bleedTargets = findBleedTargets();
  const squeezeTargets = findSqueezeTargets();

  // layoutReshaped is enforced: a recolor (columns + content width unchanged) fails
  // passed, so the loop doesn't break and the regenerative reReason fires with the
  // "reshape the structure" critique. Calibrated from 3 grid runs: two recolor-prone
  // recolors showed layoutReshaped=false while passing every other check.
  const passed = notBlank && noOverflow && noOverlap && contrastOk && changed && coherent && covered && contentCollapsed && contentVisible && layoutReshaped;
  return { passed, checks: { notBlank, noOverflow, noOverlap, contrastOk, changed, coherent, covered, contentCollapsed, contentVisible, layoutReshaped }, changeScore, layoutReshapedScore, accentFraction, framedFraction, coverageFraction, modelCoverageFraction, overflowTargets, bleedTargets, squeezeTargets, collapseTargets: [...collapsedRegions], contrastTargets: [...contrastFlags], contrastTargetBgs: Object.fromEntries(contrastTargetBgs), repeatedAccent, details };
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
 * color delta, visibly moved/resized, or hidden entirely. Returns BOTH total
 * (model + base-coat + hide) and model-only fractions — the split prevents the
 * base-coat-only escape (a lazy spec that passes total coverage via base-coat).
 * LUMINANCE-AWARE: a text-color-only delta on a clashing bg does NOT count.
 */
function measureCoverage(a: LayoutFingerprint, b: LayoutFingerprint, canvasBg: string, details: string[], modelAddressed?: Set<string>): { totalFraction: number; modelFraction: number } {
  const bMap = new Map<string, LayoutFingerprint['regions'][number]>();
  for (const r of b.regions) if (!bMap.has(r.handle)) bMap.set(r.handle, r);
  const seen = new Set<string>();
  let total = 0, addressed = 0, modelAddr = 0;
  const unaddressed: string[] = [];
  for (const ra of a.regions) {
    if (seen.has(ra.handle)) continue;
    seen.add(ra.handle);
    total++;
    const rb = bMap.get(ra.handle);
    if (!rb) { addressed++; if (modelAddressed?.has(ra.handle)) modelAddr++; continue; }
    const moved = Math.abs(ra.x - rb.x) + Math.abs(ra.y - rb.y) + Math.abs(ra.w - rb.w) + Math.abs(ra.h - rb.h) > 12;
    const [bgA, fgA] = ra.paint.split('|');
    const [bgB, fgB] = rb.paint.split('|');
    const bgD = perceptibleDelta(bgA, bgB);
    const fgD = perceptibleDelta(fgA, fgB);
    const isAddressed = regionAddressed(moved, bgD, fgD, bgA, canvasBg);
    if (isAddressed) {
      addressed++;
      if (modelAddressed?.has(ra.handle)) modelAddr++;
    } else if (unaddressed.length < 8) {
      const clash = fgD >= PERCEPTIBLE_COLOR_DELTA && bgD < PERCEPTIBLE_COLOR_DELTA && !luminanceCompatible(bgA, canvasBg);
      unaddressed.push(`${ra.handle}(bgΔ${Math.round(bgD)} fgΔ${Math.round(fgD)}${clash ? ' CLASH' : ''})`);
    }
  }
  details.push(`coverage ${addressed}/${total} addressed${unaddressed.length ? `; unaddressed: ${unaddressed.join(', ')}` : ''}`);
  return { totalFraction: total ? addressed / total : 1, modelFraction: total ? modelAddr / total : 1 };
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
    if (count <= 3) continue;  // ponytail: 2-3 members is a pair, not a "repeated cluster"
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

/** Accent: real painted area of colorful backgrounds ÷ viewport (catches "every link red").
 *  WS5: counts CANVAS-HELD color honestly — a vivid canvas is accent, not "zero accent".
 *  (Root cause: a design with color only on the canvas read accent=0.000 and passed
 *  coherence while looking flat. The metric must SEE canvas color.) */
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
  return accentFractionWithCanvas(sum, readEffectiveCanvasBg(), vpArea);
}

/**
 * WS5 pure helper: add the canvas background's saturated area to the accent sum
 * so a vivid canvas is counted as accent (the flat-while-colorful false pass).
 * Pure — unit-testable without a DOM. `canvasBg` is a CSS color string.
 */
export function accentFractionWithCanvas(clusterAccentArea: number, canvasBg: string, vpArea: number): number {
  let sum = clusterAccentArea;
  const c = parseColor(canvasBg);
  if (c && colorfulness(c) >= 0.35) sum += vpArea;   // vivid canvas = accent
  return Math.min(1, sum / Math.max(1, vpArea));
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

function checkContrast(details: string[], targets: Set<string>, targetBgs: Map<string, string>): boolean {
  // Largest type first: display/hero text is the most visible place to fail.
  const candidates = Array.from(document.querySelectorAll('h1, h2, h3, h4, p, li, td, a, span, blockquote'))
    .filter((el) => !el.hasAttribute('data-webmorph-ui') && (el.textContent || '').trim().length >= 5)
    .slice(0, 200)
    .map((el) => ({ el, fs: parseFloat(getComputedStyle(el).fontSize) || 0 }))
    .sort((a, b) => b.fs - a.fs);
  let checked = 0, failed = 0, failedTop = 0;
  for (const { el, fs } of candidates) {
    if (checked >= CONTRAST_SAMPLE_COUNT) break;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const fg = parseColor(getComputedStyle(el).color);
    if (!fg) continue;
    checked++;
    // WCAG: 4.5:1 for normal text, 3.0:1 for large text (≥18px or ≥14px bold).
    const isLarge = fs >= 18 || (fs >= 14 && parseInt(getComputedStyle(el).fontWeight) >= 700);
    const threshold = isLarge ? 3.0 : MIN_CONTRAST_RATIO;
    const eb = effectiveBackground(el);
    if (contrastRatio(fg, eb) < threshold) {
      failed++;
      if (checked <= CONTRAST_TOP_FAIL_COUNT) failedTop++;
      const h = el.closest('[data-wm-c]')?.getAttribute('data-wm-c');
      if (h) {
        targets.add(h);
        // Capture the EFFECTIVE background the text actually sits on (walked up
        // the parent chain) — the repair needs this, not the handle's own bg, or
        // it picks a readable color against the wrong surface (root cause of the
        // persistent contrast failure: text on an ancestor's painted panel).
        targetBgs.set(h, `rgb(${Math.round(eb[0])},${Math.round(eb[1])},${Math.round(eb[2])})`);
      }
      details.push(`low contrast on "${(el.textContent || '').trim().slice(0, 24)}"`);
    }
  }
  // Strict: ≤2 failures out of 50, AND zero failures among top-10 largest text.
  return !(checked > 0 && (failedTop > 0 || failed > CONTRAST_MAX_FAILURES));
}

/** Walk parent chain to find effective background. Alpha-composites semi-transparent
 *  colors over the parent so contrast is measured against the real perceived color. */
function effectiveBackground(el: Element): RGBA {
  let cur: Element | null = el;
  while (cur) {
    const c = parseColor(getComputedStyle(cur).backgroundColor);
    if (c && c[3] >= 0.95) return c;  // fully opaque
    if (c && c[3] >= 0.1) {
      // Semi-transparent — composite over parent's effective background.
      const parent = cur.parentElement ? effectiveBackground(cur.parentElement) : [255, 255, 255, 1] as RGBA;
      return alphaBlend(c, parent);
    }
    cur = cur.parentElement;
  }
  return [255, 255, 255, 1];
}

/** Alpha-composite fg over bg. */
function alphaBlend(fg: RGBA, bg: RGBA): RGBA {
  const a = fg[3] + bg[3] * (1 - fg[3]);
  if (a === 0) return [0, 0, 0, 0];
  return [
    (fg[0] * fg[3] + bg[0] * bg[3] * (1 - fg[3])) / a,
    (fg[1] * fg[3] + bg[1] * bg[3] * (1 - fg[3])) / a,
    (fg[2] * fg[3] + bg[2] * bg[3] * (1 - fg[3])) / a,
    a,
  ];
}

function clamp01(n: number): number { return Math.max(0, Math.min(1, n)); }

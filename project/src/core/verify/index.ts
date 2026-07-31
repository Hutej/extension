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
import { parseColor, contrastRatio, colorfulness, colorDistance, extractGradientStops, type RGBA } from '../../shared/color.ts';
import { packForSpec } from '../compile/expand.ts';
import type { DesignSpec } from '../spec/index.ts';

const OVERLAP_TOLERANCE = 2; // allow minor noise / a couple of self-inflicted-but-benign overlaps

/** Phase 2 — conformance: a deterministic, FREE check that the emitted CSS follows
 *  its own declared design system (the pack the expander resolved). The first
 *  CONSTRUCTIVE verification (everything before was defensive). Reported per run
 *  alongside the defensive checks; the violations are listed VERBATIM in the end
 *  report so we can calibrate before promoting conformance to a hard gate (next
 *  phase). Pure: takes the emitted CSS + the spec + the pack as data. */
export interface ConformanceResult {
  ok: boolean;
  /** Every violation, verbatim — for the end report (calibrate before enforcing). */
  violations: string[];
  /** The pack the expander resolved (the declared system the CSS is checked against). */
  packId: string;
  /** Handles the model gave raw rules for (the escape hatch) — the vocabulary-gap metric. */
  escapeHatchUses: string[];
  escapeHatchFraction: number;
}

export interface VerifyResult {
  passed: boolean;
  checks: { notBlank: boolean; noOverflow: boolean; noOverlap: boolean; contrastOk: boolean; changed: boolean; coherent: boolean; covered: boolean; contentIntact: boolean; contentVisible: boolean; layoutReshaped: boolean; usesRoom: boolean; movedAlive: boolean; reflowAddressed: boolean };
  changeScore: number;
  layoutReshapedScore: number;   // structural-change signal (columns + content width + region widths)
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
  contentWidthBefore: number | null;           // contentMaxWidthPx before apply (usesRoom critique)
  contentWidthAfter: number | null;            // contentMaxWidthPx after apply (usesRoom critique)
  repeatedAccent: boolean;
  /** Count of low-contrast text nodes WITHOUT a [data-wm-c] ancestor — invisible to
   *  handle-targeted repair (forceContrast targets handles) and to the pixel
   *  detector (only scans [data-wm-c] rects). The canvas text floor + base-coat are
   *  the only paths that reach un-clustered text. Surfaced for the Phase-1 run report
   *  so a no-handle failure class is visible, not silently dropped. */
  contrastNoHandle: number;
  /** Handles of moved/reordered nodes that did NOT survive the move (gone, hidden,
   *  zero-size, or lost their role) — for the moved-alive report + repair. */
  movedDead: string[];
  /** Side-rail handles the perception flagged as a warranted reflow that the
   *  Architect left untouched (same width+position, no op). Empty when the reflow
   *  was addressed (op on the handle) OR no reflow was warranted. */
  reflowSkippedHandles: string[];
  /** Phase 2 — conformance to the declared pack (spacing ∈ scale, type ∈ ramp,
   *  colors ∈ relationships). Logged (constructive signal, not a hard gate this
   *  phase); the violations are listed verbatim in the end report. null when the
   *  spec had no intents/pack (a raw-only or restyle-only run — no declared system). */
  conformance?: ConformanceResult;
  details: string[];
}

export function verifyStyle(before: LayoutFingerprint, paletteMode?: 'restrained' | 'vivid', modelAddressed?: Set<string>, skipReshapeChecks?: boolean, removedHandles?: Set<string>, movedHandles?: Set<string>, reflowOpportunity?: { kind: 'side-rail'; handle: string }[]): VerifyResult {
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
    // Exempt clusters intentionally removed by an op (risk 5: a remove deletes
    // the handle from the after-fingerprint; without this, contentIntact
    // false-fails on a legitimate structural removal).
    if (removedHandles?.has(ra.handle)) continue;
    const rb = afterByHandle.get(ra.handle);
    if (!rb || rb.h < 20) collapsedRegions.push(ra.handle);
  }
  const contentIntact = collapsedRegions.length === 0;
  if (!contentIntact) {
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

  // 1d) Moved nodes alive — a move/reorder op must leave the node present, visible,
  // and sized after relocation. A move that orphaned the node (parent gone), hid it,
  // or zeroed its rect is a silent break the DOM notBlank/contentIntact checks
  // don't catch (the handle may still "exist" but be display:none under a new
  // ancestor). Each moved handle is re-resolved live and checked: present, display
  // !=none, visibility !=hidden, opacity >=0.1, rect >0, role preserved.
  const movedDead: string[] = [];
  if (movedHandles && movedHandles.size) {
    for (const h of movedHandles) {
      const el = document.querySelector<HTMLElement>(`[data-wm-c="${h}"]`);
      if (!el) { movedDead.push(h); continue; }
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.1) { movedDead.push(h); continue; }
      if (r.width <= 1 || r.height <= 1) { movedDead.push(h); continue; }
    }
  }
  const movedAlive = movedDead.length === 0;
  if (!movedAlive) details.push(`moved nodes dead/hidden/zero-size: ${movedDead.slice(0, 6).join(', ')} — a move orphaned or hid a node`);

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
  // low-contrast text so forceContrast can fix exactly those. `noHandle` counts the
  // failing text WITHOUT a [data-wm-c] ancestor — invisible to handle-targeted repair
  // (forceContrast) and to the pixel detector (only scans [data-wm-c]); the canvas text
  // floor + base-coat are the only paths that reach it. Surfaced for the run report.
  const contrastFlags = new Set<string>();
  const contrastTargetBgs = new Map<string, string>();
  const noHandle = { count: 0 };
  const contrastOk = checkContrast(details, contrastFlags, contrastTargetBgs, noHandle);

  // 5) Layout actually changed (lenient).
  const changeScore = fingerprintDelta(before, after);
  const changed = changeScore >= MIN_CHANGE_SCORE;

  // 5b) STRUCTURAL reshape — the recolor-killer. changeScore blends paint-jitter
  // and padding shifts, so a recolor can pass it. This measures the two signals
  // that distinguish a real redesign from a recolor: did the column count change,
  // did the content width change materially, did major regions change width?
  // LOG ONLY this run — calibrate the threshold from real data before
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
  // USE THE ROOM: a wide page (content ≥70% of viewport) that narrows at all
  // beyond a small tolerance reads as "the whole site shrank" — dead margins
  // are visible to the eye long before 60%. Flag anything below 90% of the
  // original content width. layoutReshaped measures delta, not utilization;
  // this check catches dead margins directly.
  const vpW = window.innerWidth;
  const beforeW = before.contentMaxWidthPx;
  const afterW = after.contentMaxWidthPx;
  const wasWide = beforeW != null && beforeW >= vpW * 0.7;
  const narrowedHard = beforeW != null && afterW != null && afterW < beforeW * 0.9;
  const usesRoom = !(wasWide && narrowedHard);
  if (!usesRoom) {
    const pct = afterW != null ? ((afterW / beforeW!) * 100).toFixed(0) : '?';
    details.push(`dead-margin band: content narrowed ${Math.round(beforeW!)}px -> ${afterW != null ? Math.round(afterW) : '?'}px (${pct}% of original) on a wide page — content does not use the room`);
  }

  // 1e) Reflow forcing — when the perception flagged a structural reflow
  // opportunity (a side-rail beside main content), the Architect MUST address it:
  // an op (remove/move/reorder) on the handle, OR a material width/position change
  // (the rail reflowed — sidebar→top-bar widens to full width; a collapsed rail
  // narrows). A side-rail left at the same width+position with no op targeted it =
  // a warranted reflow the Architect skipped. Enforced ONLY on a redesign
  // (skipReshapeChecks = a palette-only request isn't claiming to reflow). The
  // 24px floor matches the region-width-change threshold — a real reflow (a rail
  // stretching from ~20% to ~100% of the viewport, or relocating above main) clears
  // it by orders of magnitude; a recolor that nudges padding does not.
  const reflowSkippedHandles: string[] = [];
  if (reflowOpportunity && reflowOpportunity.length && !skipReshapeChecks) {
    for (const r of reflowOpportunity) {
      const h = r.handle;
      if (removedHandles?.has(h)) continue;        // op removed it — addressed
      if (movedHandles?.has(h)) continue;          // op moved/reordered it — addressed
      const ra = before.regions.find((x) => x.handle === h);
      const rb = afterByHandle.get(h);
      if (!ra || !rb) continue;                    // gone from fingerprint — can't judge, benefit of the doubt
      if (Math.abs(ra.w - rb.w) > 24 || Math.abs(ra.x - rb.x) > 24 || Math.abs(ra.y - rb.y) > 24) continue;  // reflowed
      reflowSkippedHandles.push(h);
    }
  }
  const reflowSkipped = reflowSkippedHandles.length > 0;
  const reflowAddressed = !reflowSkipped;
  if (reflowSkipped) details.push(`reflow skipped: side-rail ${reflowSkippedHandles.slice(0, 6).join(', ')} left at same width+position — a warranted reflow was not addressed (no op + no grid/width change)`);

  // A restyle-only (pure palette) request isn't claiming to be a redesign, so the
  // "is this a real redesign" checks (layoutReshaped + usesRoom) are computed for the
  // report but NOT enforced in `passed` when skipReshapeChecks is set. The by-eye-
  // safety bars (notBlank, noOverflow, noOverlap, contrastOk, covered,
  // contentIntact, contentVisible) still hold — a palette change must not break
  // the page. The recolor pixel detector is skipped at the call site (no `before`).
  const enforcedReshape = skipReshapeChecks ? true : (layoutReshaped && usesRoom);
  const passed = notBlank && noOverflow && noOverlap && contrastOk && changed && coherent && covered && contentIntact && contentVisible && movedAlive && enforcedReshape && !reflowSkipped;
  return { passed, checks: { notBlank, noOverflow, noOverlap, contrastOk, changed, coherent, covered, contentIntact, contentVisible, layoutReshaped, usesRoom, movedAlive, reflowAddressed }, changeScore, layoutReshapedScore, accentFraction, framedFraction, coverageFraction, modelCoverageFraction, overflowTargets, bleedTargets, squeezeTargets, collapseTargets: [...collapsedRegions], contrastTargets: [...contrastFlags], contrastTargetBgs: Object.fromEntries(contrastTargetBgs), contentWidthBefore: beforeW, contentWidthAfter: afterW, repeatedAccent, contrastNoHandle: noHandle.count, movedDead, reflowSkippedHandles, details };
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
 * MIN_CHARS_PER_LINE. Text that "fits" but wraps every word (one-char-
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
    if (count <= 3) continue;  // 2-3 members is a pair, not a "repeated cluster"
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
 *  Counts CANVAS-HELD color honestly — a vivid canvas is accent, not "zero accent".
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
 * Pure helper: add the canvas background's saturated area to the accent sum
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

function checkContrast(details: string[], targets: Set<string>, targetBgs: Map<string, string>, noHandle: { count: number }): boolean {
  // S8.4: sample ONE REPRESENTATIVE PER [data-wm-c] handle (reuses the
  // findBleedTargets dedupe pattern) instead of a global size-sorted element
  // list. The old code had two compounding bugs:
  //  (a) candidates filtered to textContent.trim().length >= 5 — "MDN" is 3
  //      chars and never entered the list;
  //  (b) candidates sorted by font-size DESCENDING then capped at
  //      CONTRAST_SAMPLE_COUNT — 13px text was last in line and cut by the cap
  //      even after fixing (a).
  // Fix: one representative per handle, no char filter, no font-size sort. All
  // handle sizes are represented, not just large text.
  const seen = new Set<string>();
  const reps: { el: HTMLElement; h: string; fs: number }[] = [];
  for (const el of Array.from(document.querySelectorAll('[data-wm-c]'))) {
    if (!(el instanceof HTMLElement) || el.hasAttribute('data-webmorph-ui')) continue;
    const h = el.getAttribute('data-wm-c')!;
    if (seen.has(h)) continue;
    seen.add(h);
    reps.push({ el, h, fs: parseFloat(getComputedStyle(el).fontSize) || 0 });
  }
  let checked = 0, failed = 0;
  const checkedReps: { el: HTMLElement; h: string; fs: number; failed: boolean }[] = [];
  for (const { el, h, fs } of reps) {
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
    // Gradient-aware: if a gradient bar sits in the effective-background chain, the
    // text must clear the floor against EVERY stop. A fail against the worst stop = a fail.
    const gradStops = gradientStopsInChain(el);
    const worstStop = gradStops.length ? gradStops.reduce((a, b) => (contrastRatio(fg, b) < contrastRatio(fg, a) ? b : a)) : null;
    const failsSolid = contrastRatio(fg, eb) < threshold;
    const failsGradient = worstStop != null && contrastRatio(fg, worstStop) < threshold;
    const didFail = failsSolid || failsGradient;
    checkedReps.push({ el, h, fs, failed: didFail });
    if (didFail) {
      failed++;
      targets.add(h);
      targetBgs.set(h, `rgb(${Math.round(eb[0])},${Math.round(eb[1])},${Math.round(eb[2])})`);
      details.push(`low contrast on "${(el.textContent || '').trim().slice(0, 24)}"`);
    }
  }
  // S8.4: failedTop = failures among the top-N largest-font representatives.
  // Preserves the strict "top-10 largest text must ALL pass" rule WITHOUT the
  // global font-size sort that cut 13px text from sampling entirely.
  const sorted = [...checkedReps].sort((a, b) => b.fs - a.fs);
  const failedTop = sorted.slice(0, CONTRAST_TOP_FAIL_COUNT).filter((r) => r.failed).length;
  // Strict: ≤2 failures out of the sample, AND zero failures among top-N largest.
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

/** Walk the parent chain and collect gradient stops from any backgroundImage
 *  gradient that sits behind the text (a gradient bar in an ancestor). Text over
 *  a gradient must clear the contrast floor against EVERY stop, not just the
 *  effective solid background. Stops from nested gradients are flattened. */
function gradientStopsInChain(el: Element): RGBA[] {
  const stops: RGBA[] = [];
  let cur: Element | null = el;
  let hops = 0;
  while (cur && hops < 12) {
    const cs = getComputedStyle(cur);
    if (cs && cs.backgroundImage && cs.backgroundImage !== 'none') {
      for (const s of extractGradientStops(cs.backgroundImage)) stops.push(s);
    }
    cur = cur.parentElement;
    hops++;
  }
  return stops;
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

// ── Phase 2 — conformance (constructive verification) ───────────────

/** Tolerance for matching a spacing value to the scale (a value within this many
 *  px of a scale step counts as "on the scale" — base-coat + the structure path's
 *  min()/clamp() wraps introduce small derivations). */
const SPACING_TOLERANCE_PX = 2;

/** The set of colors the pack declares — the canvas, the text, the subtle, and
 *  every named accent. A color the emitted CSS uses that ISN'T one of these (and
 *  isn't a derived contrast pair the compiler computed) is an off-system color. */
function declaredColorSet(spec: DesignSpec, packId: string): Set<string> {
  const pack = packForSpec(spec);
  const out = new Set<string>();
  const add = (c?: string) => { if (c) { const p = parseColor(c); out.add(p ? `rgb(${Math.round(p[0])},${Math.round(p[1])},${Math.round(p[2])})` : c.toLowerCase()); } };
  add(pack.colors.canvas); add(pack.colors.text); add(pack.colors.subtle);
  for (const hex of Object.values(pack.colors.accents)) add(hex);
  for (const s of Object.values(pack.surfaces)) { add(s.bg); }
  // The canvas the Painter set (it may override the pack's canvas) is declared too.
  if (spec.canvas?.background) add(spec.canvas.background);
  if (spec.canvas?.color) add(spec.canvas.color);
  return out;
}

/** Extract every `value` from `prop: value !important;` declarations for a set of
 *  CSS property names in the emitted CSS string. Pure. */
function cssValuesForProps(css: string, props: string[]): string[] {
  const out: string[] = [];
  const propSet = new Set(props);
  // Match `prop: value !important;` or `prop: value;` (value up to ; or }).
  const re = /([a-z-]+)\s*:\s*([^;{}]+?)\s*(?:!important)?\s*(?:;|})/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    if (propSet.has(m[1])) out.push(m[2].trim());
  }
  return out;
}

/** Extract px values from a CSS value string (e.g. "12px" or "0 2px 8px rgba(...)"
 *  → [2, 8]). Pure. */
function pxValues(value: string): number[] {
  const out: number[] = [];
  const re = /(\d+(?:\.\d+)?)px/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) out.push(parseFloat(m[1]));
  return out;
}

/** Check the emitted CSS against the pack the expander resolved. Pure, free,
 *  deterministic. Returns the violations VERBATIM (for the end report) + the
 *  escape-hatch metric. A conformance failure is LOGGED this phase (constructive
 *  signal, not a hard gate — calibrate from the grid before promoting it). */
export function checkConformance(css: string, spec: DesignSpec, escapeHatchUses: string[], totalTargets: number): ConformanceResult {
  const pack = packForSpec(spec);
  const violations: string[] = [];

  // Only check when the spec declared a system (intents or a pack choice). A
  // raw-only or restyle-only run with no intents has no declared system —
  // conformance is null at the call site; this returns ok with no violations.
  if (!spec.intents?.length && !spec.pack) {
    return { ok: true, violations, packId: pack.id, escapeHatchUses, escapeHatchFraction: 0 };
  }

  // 1) Spacing ∈ declared scale. Every padding/gap/margin px value should be a
  //    step on the pack's spacingScale (±tolerance). A value off the scale is a
  //    violation (the model emitted a raw px the expander didn't clamp, or an
  //    escape-hatch rule with an off-system spacing).
  const spacingProps = ['padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'gap', 'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'margin-inline', 'margin-block'];
  const spacingValues = cssValuesForProps(css, spacingProps);
  const scale = pack.spacingScale;
  let spacingOff = 0;
  for (const v of spacingValues) {
    for (const px of pxValues(v)) {
      if (px === 0) continue;   // 0 is always on the scale.
      const onScale = scale.some((s) => Math.abs(s - px) <= SPACING_TOLERANCE_PX);
      if (!onScale) { spacingOff++; violations.push(`spacing off-scale: ${px}px not in [${scale.join(',')}]px`); }
    }
  }

  // 2) Type sizes ∈ declared ramp. Every font-size px value should be a ramp
  //    value (the pack's typeRamp). A value off the ramp is a violation.
  const typeValues = cssValuesForProps(css, ['font-size']);
  const ramp = Object.values(pack.typeRamp);
  let typeOff = 0;
  for (const v of typeValues) {
    for (const px of pxValues(v)) {
      if (ramp.includes(px)) continue;
      // clamp()/min() wrappers may carry a ramp value — check the bare px only.
      if (v.includes('clamp(') || v.includes('min(')) continue;
      typeOff++; violations.push(`type off-ramp: ${px}px not in ramp [${ramp.join(',')}]px`);
    }
  }

  // 3) Colors ∈ declared relationships. Every background/color/border-color the
  //    emitted CSS uses should be the canvas/text/subtle/a named accent/a pack
  //    surface — no off-system hex. (The contrast pairs the compiler computes are
  //    readable-text picks against a declared surface, so they're derived from the
  //    declared system — accept them as on-system if they're close to a declared
  //    color, else flag.) A loose check: the color must match a declared color OR
  //    be a near-black/near-white readable pair (the compiler's pickReadableText).
  const declared = declaredColorSet(spec, pack.id);
  const colorProps = ['background', 'color', 'border-color', 'background-color'];
  const colorValues = cssValuesForProps(css, colorProps);
  let colorOff = 0;
  for (const v of colorValues) {
    if (v.includes('var(') || v.includes('gradient') || v === 'none' || v === 'transparent') continue;
    const p = parseColor(v);
    if (!p) continue;   // unparseable (a gradient/keyword) — not a flat color.
    const norm = `rgb(${Math.round(p[0])},${Math.round(p[1])},${Math.round(p[2])})`;
    if (declared.has(norm)) continue;
    // A near-black or near-white readable pair the compiler picked — accept (it's
    // derived from the declared system, not an off-system invention).
    const lum = (p[0] + p[1] + p[2]) / 3;
    if (lum < 24 || lum > 231) continue;
    colorOff++; violations.push(`color off-system: ${v} not a declared canvas/text/subtle/accent/surface`);
  }

  // 4) Family consistency — every member of a group/role the model targeted got
  //    the same intent. Checked from the spec's intents: two intents on the same
  //    role/group with different emphasis/density/measure/aesthetic is a
  //    contradiction (the family is half-styled). This catches the model emitting
  //    conflicting intents on the same family.
  const byTarget = new Map<string, Set<string>>();
  for (const intent of spec.intents ?? []) {
    const key = `${intent.targetKind ?? ''}:${intent.target}`;
    const sig = [intent.emphasis, intent.density, intent.measure, intent.aesthetic ? JSON.stringify(intent.aesthetic) : ''].filter(Boolean).join('|');
    const set = byTarget.get(key) ?? new Set<string>();
    set.add(sig);
    byTarget.set(key, set);
  }
  let familyInconsistency = 0;
  for (const [key, sigs] of byTarget) {
    if (sigs.size > 1) { familyInconsistency++; violations.push(`family inconsistency: target ${key} has ${sigs.size} distinct intents — ${[...sigs].join(' / ')}`); }
  }

  const ok = spacingOff === 0 && typeOff === 0 && colorOff === 0 && familyInconsistency === 0;
  const escapeHatchFraction = totalTargets > 0 ? escapeHatchUses.filter((h) => true).length / Math.max(1, totalTargets) : 0;
  return { ok, violations, packId: pack.id, escapeHatchUses, escapeHatchFraction };
}

/**
 * core/verify — post-apply gate. Three not-broken checks + quality signals:
 *   changed   — did layout actually move? (LENIENT: low MIN_CHANGE_SCORE)
 *   coherent  — accent used sparingly (area-measured) AND surfaces not uniformly
 *               framed (count-measured over distinct clusters)
 *   noOverlap — our CSS introduced no NEW region collisions vs the original page
 *               (compares before/after overlap counts, so pre-existing floating/
 *               sticky overlaps never false-fail)
 */

import { findPrimaryContentNode, captureLayoutFingerprint, type LayoutFingerprint } from '../perceive';
import {
  MIN_CONTRAST_RATIO, MAX_OVERFLOW_RATIO, CONTRAST_SAMPLE_COUNT,
  MIN_CHANGE_SCORE, MAX_ACCENT_FRACTION, MAX_FRAMED_FRACTION,
} from '../laws';
import { parseColor, contrastRatio, colorfulness, type RGBA } from '@/shared/color';

const OVERLAP_TOLERANCE = 2; // allow minor noise / a couple of self-inflicted-but-benign overlaps

export interface VerifyResult {
  passed: boolean;
  checks: { notBlank: boolean; noOverflow: boolean; noOverlap: boolean; contrastOk: boolean; changed: boolean; coherent: boolean };
  changeScore: number;
  accentFraction: number;
  framedFraction: number;
  details: string[];
}

export function verifyStyle(before: LayoutFingerprint): VerifyResult {
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
  const noOverflow = scrollW / innerW <= MAX_OVERFLOW_RATIO;
  if (!noOverflow) details.push(`layout blow-out: ${(scrollW / innerW).toFixed(2)}`);

  // 3) No NEW region collisions vs the original page.
  const noOverlap = after.overlapCount <= before.overlapCount + OVERLAP_TOLERANCE;
  if (!noOverlap) details.push(`new region overlaps: ${before.overlapCount} -> ${after.overlapCount}`);

  // 4) Contrast sane.
  const contrastOk = checkContrast(details);

  // 5) Layout actually changed (lenient).
  const changeScore = fingerprintDelta(before, after);
  const changed = changeScore >= MIN_CHANGE_SCORE;

  // 6) Coherence: sparing accent (area) + non-uniform framing (count over clusters).
  const accentFraction = measureAccentAreaFraction();
  const framedFraction = measureFramedClusterFraction();
  const coherent = accentFraction <= MAX_ACCENT_FRACTION && framedFraction <= MAX_FRAMED_FRACTION;
  details.push(`changeScore=${changeScore.toFixed(3)} accent=${accentFraction.toFixed(3)} framed=${framedFraction.toFixed(3)}`);

  const passed = notBlank && noOverflow && noOverlap && contrastOk && changed && coherent;
  return { passed, checks: { notBlank, noOverflow, noOverlap, contrastOk, changed, coherent }, changeScore, accentFraction, framedFraction, details };
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

// ── coherence metrics ──────────────────────────────────────────────

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

function checkContrast(details: string[]): boolean {
  const els = document.querySelectorAll('p, h1, h2, h3, h4, li, td, a, span, blockquote');
  let checked = 0, failed = 0;
  for (const el of Array.from(els)) {
    if (checked >= CONTRAST_SAMPLE_COUNT) break;
    if (el.hasAttribute('data-webmorph-ui')) continue;
    const text = (el.textContent || '').trim();
    if (text.length < 5) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const fg = parseColor(getComputedStyle(el).color);
    if (!fg) continue;
    checked++;
    if (contrastRatio(fg, effectiveBackground(el)) < MIN_CONTRAST_RATIO) {
      failed++;
      details.push(`low contrast on "${text.slice(0, 24)}"`);
    }
  }
  return !(checked > 0 && failed > checked / 2);
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

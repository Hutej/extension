/** core/perceive/typography — (type ramp, per-region typography) +
 *  (text understanding: kind, direction, longest token, truncation). */

import type { Cluster } from './index.ts';

// ── Text understanding ────────────

export interface TextProfile {
  readingLength: number;
  kind: 'prose' | 'label' | 'heading' | 'number' | 'code' | 'none';
  dir: 'ltr' | 'rtl' | 'auto';
  longestToken: number;  // chars in the longest unbreakable token (word/URL)
  truncated: boolean;     // text-overflow: ellipsis or -webkit-line-clamp in effect
}

/** Analyze the text of a cluster: reading length, kind, direction, longest
 *  unbreakable token, and DOM truncation state. The longest token decides whether
 *  a track can safely narrow — the browser needs that number and so does the solver. */
export function analyzeText(cluster: Cluster, el: HTMLElement | null): TextProfile {
  if (!el) return { readingLength: 0, kind: 'none', dir: 'auto', longestToken: 0, truncated: false };
  const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
  const readingLength = text.length;
  const tag = cluster.tag;
  let kind: TextProfile['kind'] = 'none';
  if (/^h[1-6]$/.test(tag) || cluster.role === 'heading') kind = 'heading';
  else if (tag === 'pre' || tag === 'code' || /mono/i.test(cluster.style.fontFamily)) kind = 'code';
  else if (/^\$?[\d.,]+%?$/.test(text) && text.length < 20) kind = 'number';
  else if (readingLength < 40 && !text.includes('.')) kind = 'label';
  else if (readingLength > 80) kind = 'prose';
  else kind = 'label';

  const rawDir = el.dir || getComputedStyle(el).direction || 'auto';
  const dir = (rawDir === 'ltr' || rawDir === 'rtl' ? rawDir : 'auto') as 'ltr' | 'rtl' | 'auto';

  const tokens = text.split(/\s+/).filter(Boolean);
  let longestToken = 0;
  for (const t of tokens) longestToken = Math.max(longestToken, t.length);

  const cs = getComputedStyle(el);
  const truncated =
    (cs.textOverflow === 'ellipsis' && (cs.overflowX === 'hidden' || cs.overflowX === 'clip' || cs.overflow === 'hidden')) ||
    cs.webkitLineClamp !== 'none' && cs.webkitLineClamp !== '';

  return { readingLength, kind, dir, longestToken, truncated };
}

// ── Typography as a system ──────────────────────────────────────

export interface TypeStep {
  size: number;          // px
  weight: string;       // e.g. '400', '700'
  family: string;        // first font family
  lineHeight: string;    // computed line-height
  frequency: number;     // count of clusters using this size
  ratioToPrevious: number | null; // next/prev ratio (null for first)
}

export interface TypeRamp {
  steps: TypeStep[];      // sorted by size ascending
  consistentScale: boolean; // ratios within 10% of mean
  meanRatio: number | null;  // average ratio between steps
  families: string[];      // distinct font families in use
  weights: string[];      // distinct font weights
  lineHeightRange: [number, number]; // min, max line-height (parsed to number)
}

export interface TypographyProfile {
  sizePx: number;        // parsed font size
  weight: string;
  family: string;
  lineHeight: string;
  letterSpacing: string;
  textTransform: string;
  measureChars: number;  // characters per line estimate
  rank: number;          // 1 = largest on the page
}

/** Extract the page's actual type ramp: distinct sizes with frequency,
 *  the weight/family/line-height most commonly paired with each size, the
 *  ratio between consecutive steps, and whether a consistent scale exists.
 *  `lineHeightFor` is optional — pass `(c) => c.typography?.lineHeight` once
 *  per-cluster profiles are computed; without it line-heights default to
 *  'normal'. Measurements inform decisions, never become emitted CSS (Law 0). */
export function buildTypeRamp(
  clusters: Cluster[],
  lineHeightFor?: (cluster: Cluster) => string,
): TypeRamp {
  const groups = new Map<number, Cluster[]>();
  for (const c of clusters) {
    const size = parseFontSize(c.style.fontSize);
    if (size <= 0) continue;
    if (!groups.has(size)) groups.set(size, []);
    groups.get(size)!.push(c);
  }

  const sizes = [...groups.keys()].sort((a, b) => a - b);

  const steps: TypeStep[] = sizes.map((size, i) => {
    const group = groups.get(size)!;
    return {
      size,
      weight: mode(group.map(c => c.style.fontWeight)),
      family: mode(group.map(c => firstFamily(c.style.fontFamily))),
      lineHeight: mode(group.map(c => (lineHeightFor ? lineHeightFor(c) : 'normal'))),
      frequency: group.length,
      ratioToPrevious: i === 0 ? null : size / sizes[i - 1],
    };
  });

  const ratios = steps
    .map(s => s.ratioToPrevious)
    .filter((r): r is number => r !== null);
  const meanRatio = ratios.length > 0
    ? ratios.reduce((a, b) => a + b, 0) / ratios.length
    : null;
  const consistentScale =
    ratios.length > 0 &&
    meanRatio !== null &&
    ratios.every(r => Math.abs(r - meanRatio) <= Math.abs(meanRatio) * 0.1);

  const families = [...new Set(
    clusters.map(c => firstFamily(c.style.fontFamily)).filter(Boolean),
  )];
  const weights = [...new Set(
    clusters.map(c => c.style.fontWeight).filter(Boolean),
  )];

  const lhValues = clusters
    .map(c => parseLineHeightValue(lineHeightFor ? lineHeightFor(c) : 'normal'))
    .filter(n => !isNaN(n));
  const lineHeightRange: [number, number] = lhValues.length > 0
    ? [Math.min(...lhValues), Math.max(...lhValues)]
    : [0, 0];

  return { steps, consistentScale, meanRatio, families, weights, lineHeightRange };
}

/** Per-region typography profile: computed size, weight, family, line-height,
 *  letter-spacing, text-transform, measure (chars/line), and rank within the
 *  page's type hierarchy (1 = largest). Pass the page's `TypeRamp` as `ramp`
 *  to compute rank; without it rank defaults to 1. Rank matters more than
 *  absolute size — it tells the designer what must stay bigger than what. */
export function analyzeTypography(
  cluster: Cluster,
  el: HTMLElement | null,
  ramp?: TypeRamp | null,
): TypographyProfile {
  const sizePx = parseFontSize(cluster.style.fontSize);
  const weight = cluster.style.fontWeight;
  const family = firstFamily(cluster.style.fontFamily);

  let lineHeight = 'normal';
  let letterSpacing = 'normal';
  let textTransform = 'none';
  let measureChars = 0;

  if (el) {
    const cs = getComputedStyle(el);
    lineHeight = cs.lineHeight;
    letterSpacing = cs.letterSpacing;
    textTransform = cs.textTransform;

    // ponytail: rect.width / (0.5 × fontSize) — simplest chars/line estimate.
    // Falls back to 0 when the element has no layout (hidden / display:none).
    const rect = el.getBoundingClientRect();
    const avgCharWidth = 0.5 * sizePx;
    if (avgCharWidth > 0 && rect.width > 0) {
      measureChars = rect.width / avgCharWidth;
    }
  }

  let rank = 1;
  if (ramp && ramp.steps.length > 0) {
    const desc = [...ramp.steps].sort((a, b) => b.size - a.size);
    const idx = desc.findIndex(s => Math.abs(s.size - sizePx) < 0.5);
    rank = idx >= 0 ? idx + 1 : 1;
  }

  return { sizePx, weight, family, lineHeight, letterSpacing, textTransform, measureChars, rank };
}

// ── helpers (private) ────────────────────────────────────────────

function parseFontSize(s: string): number {
  if (!s) return 0;
  const m = s.match(/([\d.]+)px/);
  if (m) return parseFloat(m[1]);
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function firstFamily(fontFamily: string): string {
  if (!fontFamily) return '';
  return (fontFamily.split(',')[0] || '').trim().replace(/^["']|["']$/g, '');
}

function mode(values: string[]): string {
  if (values.length === 0) return '';
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  let best = values[0];
  let bestCount = 0;
  for (const [v, c] of counts) if (c > bestCount) { best = v; bestCount = c; }
  return best;
}

function parseLineHeightValue(s: string): number {
  if (!s || s === 'normal') return 1.2;
  if (s.endsWith('px')) return parseFloat(s);
  const n = parseFloat(s);
  return isNaN(n) ? NaN : n;
}

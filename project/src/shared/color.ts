/**
 * shared/color — pure color math shared by compile, verify, and repair.
 * No DOM access. Handles the color strings the browser hands back
 * (rgb/rgba) plus author values the AI might emit (hex, rgb).
 */

export type RGBA = [r: number, g: number, b: number, a: number];

/** Parse rgb()/rgba()/#hex/hsl()/hsla() into [r,g,b,a]. Returns null if not a solid parseable color. */
export function parseColor(input: string): RGBA | null {
  if (!input) return null;
  const s = input.trim().toLowerCase();
  if (s === 'transparent') return [0, 0, 0, 0];

  const rgb = s.match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)/);
  if (rgb) {
    const a = rgb[4] == null ? 1 : (rgb[4].endsWith('%') ? parseFloat(rgb[4]) / 100 : parseFloat(rgb[4]));
    return [clampByte(+rgb[1]), clampByte(+rgb[2]), clampByte(+rgb[3]), clamp01(a)];
  }

  const hex = s.match(/^#([0-9a-f]{3,8})$/);
  if (hex) {
    const h = hex[1];
    if (h.length === 3) return [x2(h[0]), x2(h[1]), x2(h[2]), 1];
    if (h.length === 4) return [x2(h[0]), x2(h[1]), x2(h[2]), x2(h[3]) / 255];
    if (h.length === 6) return [i2(h, 0), i2(h, 2), i2(h, 4), 1];
    if (h.length === 8) return [i2(h, 0), i2(h, 2), i2(h, 4), i2(h, 6) / 255];
  }

  const hsl = parseHsl(s);
  if (hsl) return hsl;

  return null;
}

/** Parse hsl()/hsla() into RGBA. Pure — standard HSL→RGB algorithm. */
function parseHsl(s: string): RGBA | null {
  const m = s.match(/hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%?[\s,]+([\d.]+)%?(?:[\s,/]+([\d.]+%?))?\s*\)/i);
  if (!m) return null;
  const h = +m[1] % 360;
  const sat = +m[2] / 100;
  const light = +m[3] / 100;
  const a = m[4] == null ? 1 : (m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m2 = light - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return [clampByte((r + m2) * 255), clampByte((g + m2) * 255), clampByte((b + m2) * 255), clamp01(a)];
}

/** True when the color is effectively see-through (so it must not be treated as a real surface). */
export function isTransparent(input: string): boolean {
  const c = parseColor(input);
  return c == null || c[3] < 0.1;
}

/** WCAG relative luminance (0..1). */
function luminance([r, g, b]: RGBA): number {
  const [rs, gs, bs] = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

/** WCAG contrast ratio between two solid colors (1..21). */
export function contrastRatio(fg: RGBA, bg: RGBA): number {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/**
 * WCAG AA contrast floor for a text element, by its size. Normal text (<24px,
 * or <18.66px non-bold): 4.5. Large text (≥24px, or ≥18.66px bold): 3.0 —
 * WCAG's own large-text allowance. Pure — used by the forced layout check so
 * the floor is unit-testable without a DOM.
 */
export function contrastFloor(fontSizePx: number, fontWeight: number | string): number {
  const w = typeof fontWeight === 'string' ? (parseInt(fontWeight, 10) || 400) : fontWeight;
  const large = fontSizePx >= 24 || (fontSizePx >= 18.66 && w >= 700);
  return large ? 3.0 : 4.5;
}

/**
 * Chroma-ish colorfulness in 0..1 = (max-min)/255. A loud accent (red, blue,
 * green) scores high; neutrals (white/gray/black) score ~0. Used by verify to
 * measure how much of the page carries an accent, without trusting cluster counts.
 */
export function colorfulness(c: RGBA): number {
  if (c[3] < 0.4) return 0;
  const max = Math.max(c[0], c[1], c[2]);
  const min = Math.min(c[0], c[1], c[2]);
  return (max - min) / 255;
}

/**
 * Extract the solid color stops from a CSS gradient (linear-gradient / radial-gradient
 * / conic-gradient). Returns the parsed RGBA of each stop color, or [] for a non-
 * gradient. Pure — used by compile + verify to contrast-check text against EVERY
 * stop of a gradient bar (text over a gradient must clear the contrast floor against
 * each stop, not just the first). Stops without a parseable color (e.g. transparent)
 * are skipped; a stop list that resolves to nothing returns [].
 */
export function extractGradientStops(bg: string): RGBA[] {
  if (!bg) return [];
  const s = bg.trim().toLowerCase();
  const grad = s.match(/^(linear-gradient|radial-gradient|conic-gradient|repeating-linear-gradient|repeating-radial-gradient)\s*\(([\s\S]*)\)$/i);
  if (!grad) return [];
  // Split the gradient body on commas at the top level (not inside nested parens).
  const parts: string[] = [];
  let depth = 0, cur = '';
  for (const ch of grad[2]) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { if (cur.trim()) parts.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  const stops: RGBA[] = [];
  for (const part of parts) {
    // A part is a stop if it begins with a color (hex/rgb/hsl/named) — skip the
    // angle/position declarations (e.g. "to right", "45deg", "at center").
    const first = part.split(/\s+/)[0];
    if (/^(to|at|\d+(deg|rad|turn|grad|%)|center|top|bottom|left|right)\b/i.test(first)) continue;
    const c = parseColor(part) ?? parseColor(first);
    if (c) stops.push(c);
  }
  return stops;
}

function clampByte(n: number): number { return Math.max(0, Math.min(255, Math.round(n))); }
function clamp01(n: number): number { return Math.max(0, Math.min(1, n)); }
function x2(ch: string): number { return parseInt(ch + ch, 16); }
function i2(h: string, i: number): number { return parseInt(h.slice(i, i + 2), 16); }

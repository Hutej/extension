/** core/perceive/surface — (background resolution, elevation model) +
 *  (borders, shape, surface identity) + (colour as HSL model). */

import type { Cluster } from './index.ts';
import { parseColor, colorfulness, extractGradientStops } from '../../shared/color.ts';

// ── Colour as a model ──────────────

export interface ColorEntry {
  hex: string;
  hsl: [number, number, number, number]; // h(0-360), s(0-100%), l(0-100%), a(0-1)
  freq: number;        // fraction of clusters with this color
  isBrand: boolean;    // detected by frequency in prominent positions
  role: 'bg' | 'text' | 'accent' | 'border';
}

export interface SurfaceGeometry {
  radii: number[];
  borderWidths: number[];
  hasShadow: boolean;
  shadowSpread: number;
  spacingRhythm: number;
}

export interface ColorModel {
  palette: ColorEntry[];
  relationships: string[];
  saturationRange: [number, number];
  lightnessRange: [number, number];
  geometry: SurfaceGeometry;
}

/** RGB → HSL. Returns [h(0-360), s(0-100), l(0-100), a(0-1)]. */
export function rgbToHsl(r: number, g: number, b: number, a = 1): [number, number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0));
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
  }
  return [Math.round(h), Math.round(s * 100), Math.round(l * 100), a];
}

/** RGB[HSL tuple] → #rrggbb. Exported for the T1 design snapshot (level 3)
 *  so both levels render colors identically. */
export function rgbToHex(hsl: [number, number, number, number]): string {
  const [h, s, l] = hsl;
  const sat = s / 100, light = l / 100;
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
  const toHex = (v: number) => Math.round((v + m2) * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** Build a colour model from the perception. */
export function buildColorModel(p: { clusters: Cluster[] }): ColorModel {
  const bgColors = new Map<string, { count: number; hsl: [number, number, number, number]; prominent: number }>();
  const textColors = new Map<string, { count: number; hsl: [number, number, number, number] }>();
  const accentColors = new Map<string, { count: number; hsl: [number, number, number, number]; prominent: number }>();

  for (const c of p.clusters) {
    const bg = parseColor(c.style.background);
    if (bg && bg[3] > 0.1) {
      const key = `${bg[0]},${bg[1]},${bg[2]}`;
      const hsl = rgbToHsl(bg[0], bg[1], bg[2], bg[3]);
      const entry = bgColors.get(key) ?? { count: 0, hsl, prominent: 0 };
      entry.count++;
      entry.prominent = Math.max(entry.prominent, c.dominanceRank);
      bgColors.set(key, entry);
    }
    const tx = parseColor(c.style.color);
    if (tx && tx[3] > 0.1) {
      const key = `${tx[0]},${tx[1]},${tx[2]}`;
      const hsl = rgbToHsl(tx[0], tx[1], tx[2], tx[3]);
      const entry = textColors.get(key) ?? { count: 0, hsl };
      entry.count++;
      textColors.set(key, entry);
    }
    if (c.hasSolidBg && colorfulness(parseColor(c.style.background) ?? [0, 0, 0, 0]) > 0.15) {
      const ac = parseColor(c.style.background);
      if (ac) {
        const key = `${ac[0]},${ac[1]},${ac[2]}`;
        const hsl = rgbToHsl(ac[0], ac[1], ac[2], ac[3]);
        const entry = accentColors.get(key) ?? { count: 0, hsl, prominent: 0 };
        entry.count++;
        entry.prominent = Math.max(entry.prominent, c.dominanceRank);
        accentColors.set(key, entry);
      }
    }
  }

  const total = p.clusters.length || 1;
  const palette: ColorEntry[] = [];
  for (const [, v] of [...bgColors.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 3)) {
    palette.push({ hex: rgbToHex(v.hsl), hsl: v.hsl, freq: v.count / total, isBrand: v.prominent > 0.5 && v.count > 1, role: 'bg' });
  }
  for (const [, v] of [...textColors.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 2)) {
    palette.push({ hex: rgbToHex(v.hsl), hsl: v.hsl, freq: v.count / total, isBrand: false, role: 'text' });
  }
  for (const [, v] of [...accentColors.entries()].sort((a, b) => (b[1].prominent * b[1].count) - (a[1].prominent * a[1].count)).slice(0, 3)) {
    palette.push({ hex: rgbToHex(v.hsl), hsl: v.hsl, freq: v.count / total, isBrand: v.prominent > 0.4 && v.count <= 2, role: 'accent' });
  }

  const hues = palette.filter((p) => p.role === 'accent' || p.isBrand).map((p) => p.hsl[0]).filter((h) => h > 0);
  const relationships: string[] = [];
  if (hues.length >= 2) {
    const uniqueHues = [...new Set(hues)];
    if (uniqueHues.length === 1) relationships.push('monochrome');
    else {
      for (let i = 0; i < uniqueHues.length; i++) {
        for (let j = i + 1; j < uniqueHues.length; j++) {
          const diff = Math.abs(uniqueHues[i] - uniqueHues[j]);
          const d = Math.min(diff, 360 - diff);
          if (d >= 170 && d <= 190) relationships.push('complementary');
          else if (d <= 30 || d >= 330) relationships.push('analogous');
          else if (d >= 118 && d <= 122) relationships.push('triadic');
        }
      }
    }
  }
  if (relationships.length === 0) relationships.push('monochrome');

  const sats = palette.map((p) => p.hsl[1]);
  const lights = palette.map((p) => p.hsl[2]);
  const saturationRange: [number, number] = [Math.min(...sats, 0), Math.max(...sats, 0)];
  const lightnessRange: [number, number] = [Math.min(...lights, 0), Math.max(...lights, 100)];

  const radii = new Set<number>();
  const borderWidths = new Set<number>();
  let hasShadow = false;
  let shadowSpread = 0;
  for (const c of p.clusters) {
    const r = parseFloat(c.style.borderRadius);
    if (r > 0) radii.add(Math.round(r));
    const bw = parseFloat(c.style.border);
    if (bw > 0) borderWidths.add(Math.round(bw));
    if (c.style.boxShadow !== 'none') {
      hasShadow = true;
      const m = c.style.boxShadow.match(/([\d.]+)px\s+([\d.]+)px\s+([\d.]+)px(?:\s+([\d.]+)px)?/);
      if (m) shadowSpread = Math.max(shadowSpread, parseFloat(m[3]) + (m[4] ? parseFloat(m[4]) : 0));
    }
  }
  const gaps = p.clusters.map((c) => c.layout.siblingGapPx).filter((g): g is number => g != null && g > 0);
  const spacingRhythm = gaps.length ? gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 0;

  return {
    palette, relationships: [...new Set(relationships)], saturationRange, lightnessRange,
    geometry: { radii: [...radii].sort((a, b) => a - b).slice(0, 5), borderWidths: [...borderWidths].sort((a, b) => a - b).slice(0, 3), hasShadow, shadowSpread, spacingRhythm },
  };
}

// ── Background, transparency, layering ─────────────────────────

export interface BackgroundResolution {
  effectiveColor: string;        // alpha-composited hex (#rrggbb)
  type: 'solid' | 'gradient' | 'image' | 'none';
  gradientStops?: string[];     // for gradients
  gradientAngle?: number;
  isContentImage: boolean;     // decorative vs content
  backdropFilter: string;      // 'none' or the filter value
  opacity: number;             // 0..1
  blendMode: string;
  transparentLayerCount: number;
  transparentLayerTotalAlpha: number;
}

export interface StackingContext {
  handle: string;
  reason: string;  // 'position+z-index', 'opacity', 'transform', 'filter', 'will-change'
  z: number | null;
  children: string[]; // handles of clusters inside this context
}

export interface ElevationModel {
  zIndexGroups: Map<number, string[]>;  // z-index → handles
  stackingContexts: StackingContext[];
  shadowTiers: Map<string, string[]>;   // 'small'|'medium'|'large' → handles
  floatingRegions: string[];           // position != static
}

// ── Borders, shape, surface identity ───────────────────────────

export interface ShadowParse {
  offsetX: number; offsetY: number; blur: number; spread: number;
  color: string; inset: boolean;
}

export interface BorderShapeProfile {
  borderWidths: { top: number; right: number; bottom: number; left: number };
  borderStyles: { top: string; right: string; bottom: string; left: string };
  borderColors: { top: string; right: string; bottom: string; left: string };
  radii: { tl: number; tr: number; br: number; bl: number };
  outline: string;
  shadows: ShadowParse[];
  shape: 'rectangular' | 'pill' | 'circular' | 'clipped';
}

export type SurfaceLanguage = 'flat' | 'outlined' | 'shadowed' | 'filled';

export interface SurfaceLanguageProfile {
  language: SurfaceLanguage;
  radiusVocabulary: number[];
  borderColorPalette: string[];
}

// ── helpers ────────────────────────────────────────────────────────

type RGBA = [number, number, number, number];

function rgbaToHex(c: RGBA): string {
  const to = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${to(c[0])}${to(c[1])}${to(c[2])}`;
}

/** Source-over alpha composite. Returns premultiplied-normalised RGBA. */
function compositeOver(src: RGBA, dst: RGBA): RGBA {
  const a = src[3] + dst[3] * (1 - src[3]);
  if (a <= 0) return [0, 0, 0, 0];
  return [
    (src[0] * src[3] + dst[0] * dst[3] * (1 - src[3])) / a,
    (src[1] * src[3] + dst[1] * dst[3] * (1 - src[3])) / a,
    (src[2] * src[3] + dst[2] * dst[3] * (1 - src[3])) / a,
    a,
  ];
}

/** Split a CSS value on top-level commas (ignoring commas inside parens). */
function splitTopLevel(value: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0, cur = '';
  for (const ch of value) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === sep && depth === 0) { if (cur.trim()) parts.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/** Parse a CSS box-shadow (possibly multi-layer) into ShadowParse[]. */
function parseBoxShadows(value: string): ShadowParse[] {
  if (!value || value === 'none') return [];
  const out: ShadowParse[] = [];
  for (const layer of splitTopLevel(value, ',')) {
    const inset = /\binset\b/i.test(layer);
    const body = layer.replace(/\binset\b/i, '').trim();
    // Colour is the trailing rgb()/rgba()/#hex/named token.
    const colorMatch = body.match(/(rgba?\([^)]+\)|#[0-9a-f]{3,8})\s*$/i);
    let color = 'rgba(0,0,0,0.2)';
    let rest = body;
    if (colorMatch && colorMatch.index != null) {
      color = colorMatch[0].trim();
      rest = body.slice(0, colorMatch.index).trim();
    }
    const nums = (rest.match(/-?[\d.]+/g) ?? []).map(Number);
    out.push({
      offsetX: nums[0] ?? 0, offsetY: nums[1] ?? 0,
      blur: nums[2] ?? 0, spread: nums[3] ?? 0, color, inset,
    });
  }
  return out;
}

/** Look up the live representative element for a cluster (light DOM; stamped attr). */
function elementForCluster(cluster: Cluster): HTMLElement | null {
  return document.querySelector<HTMLElement>(cluster.selector);
}

// ── functions ───────────────────────────────────────────────────

/** Resolve the effective background by walking up through transparency to an
 *  opaque base, alpha-compositing each transparent layer. Law 0: the returned
 *  colour is a decision input, never an emitted value. */
export function resolveEffectiveBackground(cluster: Cluster, el: HTMLElement | null): BackgroundResolution {
  const cs = el ? getComputedStyle(el) : null;
  const bgImage = cs ? cs.backgroundImage : 'none';
  const bg = cs ? cs.backgroundColor : cluster.style.background;

  // Background type from the element's own painted background.
  let type: BackgroundResolution['type'] = 'none';
  let gradientStops: string[] | undefined;
  let gradientAngle: number | undefined;
  let isContentImage = false;
  if (bgImage && bgImage !== 'none') {
    if (/gradient/i.test(bgImage)) {
      type = 'gradient';
      gradientStops = extractGradientStops(bgImage).map(rgbaToHex);
      const deg = bgImage.match(/([\d.]+)deg/);
      if (deg) gradientAngle = parseFloat(deg[1]);
      else if (/to\s+right/i.test(bgImage)) gradientAngle = 90;
      else if (/to\s+bottom/i.test(bgImage)) gradientAngle = 180;
      else if (/to\s+left/i.test(bgImage)) gradientAngle = 270;
      else gradientAngle = 0;
    } else if (/url\(/i.test(bgImage)) {
      type = 'image';
      isContentImage = true;
    }
  }
  if (type === 'none' && parseColor(bg) && (parseColor(bg) as RGBA)[3] > 0) type = 'solid';

  // Content image also includes <img> tags regardless of background.
  if (!isContentImage && el != null && el.tagName === 'IMG') isContentImage = true;

  // Alpha-composite up the parent chain until an opaque layer is found.
  let composited: RGBA = parseColor(bg) ?? [0, 0, 0, 0];
  let transparentLayerCount = 0;
  let transparentStackOpacity = 1 - composited[3]; // 1 - Π(1-α) over transparent layers
  let node = el?.parentElement ?? null;
  while (composited[3] < 0.999 && node) {
    const parentBg = parseColor(getComputedStyle(node).backgroundColor) ?? [0, 0, 0, 0];
    if (parentBg[3] < 0.999) {
      transparentLayerCount++;
      transparentStackOpacity = 1 - (1 - transparentStackOpacity) * (1 - parentBg[3]);
    }
    composited = compositeOver(composited, parentBg);
    node = node.parentElement;
  }
  // If still transparent at the top, composite over the page canvas (white fallback).
  if (composited[3] < 0.999) composited = compositeOver(composited, [255, 255, 255, 1]);

  const transparentLayerTotalAlpha = Math.min(1, transparentStackOpacity);

  return {
    effectiveColor: rgbaToHex(composited),
    type,
    gradientStops,
    gradientAngle,
    isContentImage,
    backdropFilter: cs ? cs.backdropFilter : 'none',
    opacity: cs ? parseFloat(cs.opacity) : 1,
    blendMode: cs ? cs.mixBlendMode : 'normal',
    transparentLayerCount,
    transparentLayerTotalAlpha,
  };
}

/** Build the page elevation model: z-index groups, stacking contexts, shadow
 *  tiers, and floating regions. */
export function buildElevationModel(clusters: Cluster[]): ElevationModel {
  const zIndexGroups = new Map<number, string[]>();
  const stackingContexts: StackingContext[] = [];
  const shadowTiers = new Map<string, string[]>([['small', []], ['medium', []], ['large', []]]);
  const floatingRegions: string[] = [];

  const els = new Map<string, HTMLElement | null>();
  for (const c of clusters) els.set(c.handle, elementForCluster(c));

  for (const c of clusters) {
    const el = els.get(c.handle) ?? null;
    // Floating regions: position != static (from the layout fact already captured).
    if (c.layout.position !== 'static') floatingRegions.push(c.handle);

    if (el) {
      const cs = getComputedStyle(el);
      const zRaw = cs.zIndex;
      if (zRaw !== 'auto') {
        const z = parseInt(zRaw, 10);
        if (!Number.isNaN(z)) {
          const arr = zIndexGroups.get(z) ?? [];
          arr.push(c.handle);
          zIndexGroups.set(z, arr);
        }
      }

      // Stacking context creators.
      const position = cs.position;
      const createsByZ = position !== 'static' && zRaw !== 'auto';
      const opacity = parseFloat(cs.opacity);
      const transform = cs.transform;
      const filter = cs.filter;
      const willChange = cs.willChange;
      let reason: string | null = null;
      let z: number | null = null;
      if (createsByZ) { reason = 'position+z-index'; z = parseInt(zRaw, 10); }
      else if (!Number.isNaN(opacity) && opacity < 1) reason = 'opacity';
      else if (transform !== 'none') reason = 'transform';
      else if (filter !== 'none') reason = 'filter';
      else if (willChange !== 'auto' && willChange !== '') reason = 'will-change';
      if (reason) {
        const children: string[] = [];
        for (const other of clusters) {
          if (other.handle === c.handle) continue;
          const oel = els.get(other.handle);
          if (oel && el.contains(oel)) children.push(other.handle);
        }
        stackingContexts.push({ handle: c.handle, reason, z, children });
      }
    }

    // Shadow tiers from the stored box-shadow (max blur drives the tier).
    if (c.style.boxShadow !== 'none') {
      const shadows = parseBoxShadows(c.style.boxShadow);
      const maxBlur = shadows.reduce((m, s) => Math.max(m, s.blur), 0);
      const tier = maxBlur < 4 ? 'small' : maxBlur <= 12 ? 'medium' : 'large';
      shadowTiers.get(tier)!.push(c.handle);
    }
  }

  return { zIndexGroups, stackingContexts, shadowTiers, floatingRegions };
}

// ── functions ───────────────────────────────────────────────────

/** Per-region border, radius, outline, shadow and shape classification. */
export function analyzeBorderShape(cluster: Cluster, el: HTMLElement | null): BorderShapeProfile {
  const cs = el ? getComputedStyle(el) : null;
  const w = cluster.rect.w;
  const h = cluster.rect.h;

  const px = (v: string | undefined, fallback = 0): number => {
    if (!v) return fallback;
    if (v.endsWith('%')) return (parseFloat(v) / 100) * w; // ponytail: %→px via width; rare vertical-% corners
    return parseFloat(v) || fallback;
  };

  if (!cs) {
    return {
      borderWidths: { top: 0, right: 0, bottom: 0, left: 0 },
      borderStyles: { top: 'none', right: 'none', bottom: 'none', left: 'none' },
      borderColors: { top: '', right: '', bottom: '', left: '' },
      radii: { tl: 0, tr: 0, br: 0, bl: 0 },
      outline: 'none',
      shadows: [],
      shape: 'rectangular',
    };
  }

  const borderWidths = {
    top: parseFloat(cs.borderTopWidth) || 0,
    right: parseFloat(cs.borderRightWidth) || 0,
    bottom: parseFloat(cs.borderBottomWidth) || 0,
    left: parseFloat(cs.borderLeftWidth) || 0,
  };
  const borderStyles = {
    top: cs.borderTopStyle, right: cs.borderRightStyle,
    bottom: cs.borderBottomStyle, left: cs.borderLeftStyle,
  };
  const borderColors = {
    top: cs.borderTopColor, right: cs.borderRightColor,
    bottom: cs.borderBottomColor, left: cs.borderLeftColor,
  };

  // Per-corner radii; a corner value may be "8px" or "50% 50%".
  const corner = (v: string): number => {
    const first = v.split(/\s+/)[0] ?? '0';
    return px(first);
  };
  const radii = {
    tl: corner(cs.borderTopLeftRadius),
    tr: corner(cs.borderTopRightRadius),
    br: corner(cs.borderBottomRightRadius),
    bl: corner(cs.borderBottomLeftRadius),
  };

  const shadows = parseBoxShadows(cs.boxShadow);

  // Shape classification.
  let shape: BorderShapeProfile['shape'] = 'rectangular';
  if (cs.clipPath !== 'none') {
    shape = 'clipped';
  } else {
    const minR = Math.min(radii.tl, radii.tr, radii.br, radii.bl);
    const isCircleish = w > 0 && h > 0 && Math.abs(w - h) <= 2 && minR >= Math.min(w, h) / 2 - 1;
    if (isCircleish) shape = 'circular';
    else if (h > 0 && minR >= h / 2 - 1) shape = 'pill';
  }

  const outline = `${cs.outlineWidth} ${cs.outlineStyle} ${cs.outlineColor}`;

  return { borderWidths, borderStyles, borderColors, radii, outline, shadows, shape };
}

/** Page-level surface language: radius vocabulary, border colour palette,
 *  and a single classification a Painter needs before choosing a treatment. */
export function classifySurfaceLanguage(clusters: Cluster[]): SurfaceLanguageProfile {
  const radiusSet = new Set<number>();
  const borderColorSet = new Set<string>();

  let shadowCount = 0, borderCount = 0, solidCount = 0;
  for (const c of clusters) {
    const r = parseFloat(c.style.borderRadius);
    if (r > 0) radiusSet.add(Math.round(r));
    // Border colour: extract the colour from the shorthand "1px solid rgb(...)".
    if (c.style.border !== 'none') {
      borderCount++;
      const m = c.style.border.match(/(rgba?\([^)]+\)|#[0-9a-f]{3,8})\s*$/i);
      if (m) borderColorSet.add(m[1]);
    }
    if (c.style.boxShadow !== 'none') shadowCount++;
    if (c.hasSolidBg) solidCount++;
  }

  const total = clusters.length || 1;
  let language: SurfaceLanguage;
  if (shadowCount > total * 0.3 && shadowCount >= borderCount) language = 'shadowed';
  else if (borderCount > total * 0.3) language = 'outlined';
  else if (solidCount > total * 0.5) language = 'filled';
  else language = 'flat';

  return {
    language,
    radiusVocabulary: [...radiusSet].sort((a, b) => a - b),
    borderColorPalette: [...borderColorSet],
  };
}

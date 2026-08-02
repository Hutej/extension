/** core/perceive/surface — D4 (background resolution, elevation model) +
 *  D6 (borders, shape, surface identity) + C6 (colour as HSL model). */

import type { Cluster } from './index.ts';
import { parseColor, colorfulness } from '../../shared/color.ts';

// ── C6 (carried from enrichment.ts): Colour as a model ──────────────

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

function rgbToHex(hsl: [number, number, number, number]): string {
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

// ── D4+D6 functions will be added by subagent ─────────────────────

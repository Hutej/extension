/**
 * core/design — the Design Context Bridge (T1).
 *
 * A compact, sampled design snapshot of the page, read from LIVE computed
 * styles at describePage time. Level-3 evidence: the model should learn the
 * page's visual system from ordinary observation instead of authoring blind or
 * paying for a level-4 perceivePage on every visual request (roadmap GAP 1/10).
 *
 * This is OBSERVATION: it collects evidence, decides nothing, and returns a
 * string that cannot be applied to a page (invariant 4). Vocabulary is aligned
 * with the level-4 serialization (accents, surface language, radii) so both
 * levels speak the same design language.
 *
 * Strategy: roadmap Option B — a fast sampled path, adapted from the archive's
 * extractDesignContext (archive/project/src/core/observe/index.ts), upgraded:
 * colors are parsed + deduped + COUNTED via the shared color primitives (the
 * archive compared raw strings, so rgb(255,255,255) and #fff counted as two),
 * transparent colors are ignored, every field is capped, and empty fields are
 * omitted rather than padded with filler. Counts are emitted (bg:#fff×12) so
 * the model sees the sample size behind every claim, not a bare assertion.
 */

import { parseColor, colorfulness } from '../shared/color';
import { rgbToHsl, rgbToHex } from './perceive/surface';
import type { CandidateRegion } from './inventory';

/** Hard cap on the serialized block — protects the 8,000-char journal budget
 *  (rule 12: if this clips, the model sees [TRUNCATED], never silence). */
export const DESIGN_SNAPSHOT_MAX_CHARS = 600;

const MAX_SAMPLED_REGIONS = 40;
const TOP_BG = 2;
const TOP_TEXT = 2;
const TOP_ACCENTS = 3;
const TOP_RADII = 3;
const TOP_SCALE = 5;
const TOP_WEIGHTS = 3;

/** Sampled once each — the archive's role list, kept (one element per role). */
const ROLE_SELECTORS = ['h1', 'h2', 'h3', 'p', 'a', 'button', 'input'] as const;

interface ColorStat { count: number; colorful: number; }

export function buildDesignSnapshot(regions: CandidateRegion[]): string {
  const bgs = new Map<string, ColorStat>();
  const texts = new Map<string, ColorStat>();
  const families = new Map<string, number>();
  const weights = new Set<string>();
  const sizes = new Map<number, number>(); // text-bearing element font sizes
  const headings = new Map<string, number>(); // h1/h2/h3 → px
  const radii = new Map<number, number>();
  const borderWidths = new Map<number, number>();
  const spacing = new Map<number, number>(); // quantized 4px buckets
  let shadows = 0, gradients = 0, glassy = 0, regionSampled = 0;
  // The page canvas (body, falling back to html) is qualitatively different
  // from sampled surface counts — it is reported separately and never has to
  // win a popularity contest to appear (this exact crowding-out was caught by
  // the freshness test: an inline-mutated body bg lost top-2 to button bg).
  let canvas = '';

  const noteBg = (v: string) => note(bgs, v);
  const noteText = (v: string) => note(texts, v);

  // 1. Body + document element — the canvas.
  for (const el of [document.body, document.documentElement]) {
    if (!el) continue;
    const cs = getComputedStyle(el);
    if (!canvas) canvas = cs.backgroundColor;
    noteBg(cs.backgroundColor);
    noteText(cs.color);
    collectType(cs, sizes, families, weights, false);
  }

  // 2. Role sampling — the archive's list, kept, but up to 3 elements per role
  //    (one first-link sample loses to ties; a link color is prime accent
  //    evidence and often appears on several links).
  for (const sel of ROLE_SELECTORS) {
    for (const el of Array.from(document.querySelectorAll(sel)).slice(0, 3)) {
      const cs = getComputedStyle(el);
      noteText(cs.color);
      noteBg(cs.backgroundColor);
      collectType(cs, sizes, families, weights, /^h\d$/.test(sel));
      collectShape(cs, radii, borderWidths);
      collectSpacing(cs, spacing);
      if (cs.boxShadow && cs.boxShadow !== 'none') shadows++;
      if (cs.backgroundImage && cs.backgroundImage !== 'none') gradients++;
    }
    const first = document.querySelector(sel);
    if (first && /^h\d$/.test(sel)) headings.set(sel, parseFloat(getComputedStyle(first).fontSize) || 0);
  }

  // 3. The regions describePage already found — same walk, zero extra scan.
  //    Design evidence must NOT depend on targetability (a region without a
  //    stable anchor still has a visual identity), so we read the transient
  //    element the walk captured, not the selector. Caps bound the cost on
  //    huge pages (the deliberate-failure fixture).
  for (const r of regions.slice(0, MAX_SAMPLED_REGIONS)) {
    const el = r.el;
    if (!el) continue;
    regionSampled++;
    const cs = getComputedStyle(el);
    noteBg(cs.backgroundColor);
    noteText(cs.color);
    collectShape(cs, radii, borderWidths);
    collectSpacing(cs, spacing);
    if (cs.boxShadow && cs.boxShadow !== 'none') shadows++;
    if (cs.backgroundImage && cs.backgroundImage !== 'none') gradients++;
    if (cs.backdropFilter && cs.backdropFilter !== 'none') glassy++;
  }

  // 4. Site design tokens — root-level custom properties, the highest-leverage
  //    authoring surface (overriding --site-token restyles every consumer; the
  //    2026-09-02 investigation's R6: the snapshot reported computed values and
  //    hid the token layer entirely). Best-effort: cross-origin sheets and
  //    pages without tokens simply report nothing. Cap 15, one line.
  const tokens: string[] = [];
  try {
    const names = new Set<string>();
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList;
      try { rules = (sheet as CSSStyleSheet).cssRules; } catch { continue; }
      for (const rule of Array.from(rules)) {
        const sel = (rule as CSSStyleRule).selectorText ?? '';
        if (/^(:root|html|body)\b/.test(sel)) {
          const st = (rule as CSSStyleRule).style;
          for (let i = 0; i < st.length; i++) if (st[i].startsWith('--')) names.add(st[i]);
        }
      }
    }
    const cs = getComputedStyle(document.documentElement);
    for (const n of names) {
      const v = cs.getPropertyValue(n).trim();
      if (v && tokens.length < 15) tokens.push(`${n}:${v.length > 24 ? v.slice(0, 24) : v}`);
    }
  } catch { /* token survey is best-effort evidence, never a failure */ }

  return serialize({
    bgs, texts, sizes, headings, families, weights, radii, borderWidths,
    spacing, shadows, gradients, glassy, regionSampled, canvas, tokens,
  });
}

// ── collectors ─────────────────────────────────────────────────────

function note(map: Map<string, ColorStat>, value: string): void {
  const c = parseColor(value);
  if (!c || c[3] < 0.1) return; // transparent is not a surface (shared/color contract)
  const key = `${c[0]},${c[1]},${c[2]}`;
  const e = map.get(key) ?? { count: 0, colorful: colorfulness(c) };
  e.count++;
  map.set(key, e);
}

function collectType(
  cs: CSSStyleDeclaration,
  sizes: Map<number, number>,
  families: Map<string, number>,
  weights: Set<string>,
  isHeading: boolean,
): void {
  const px = parseFloat(cs.fontSize);
  if (!isHeading && px > 0) sizes.set(px, (sizes.get(px) ?? 0) + 1);
  if (cs.fontWeight) weights.add(cs.fontWeight);
  const fam = (cs.fontFamily || '').split(',')[0]?.trim().replace(/^["']|["']$/g, '');
  if (fam) families.set(fam, (families.get(fam) ?? 0) + 1);
}

function collectShape(
  cs: CSSStyleDeclaration,
  radii: Map<number, number>,
  borderWidths: Map<number, number>,
): void {
  for (const v of [cs.borderTopLeftRadius, cs.borderBottomRightRadius]) {
    const r = parseFloat(v);
    if (r > 0) radii.set(Math.round(r), (radii.get(Math.round(r)) ?? 0) + 1);
  }
  const bw = parseFloat(cs.borderTopWidth);
  if (cs.borderTopStyle !== 'none' && bw > 0) {
    borderWidths.set(Math.round(bw), (borderWidths.get(Math.round(bw)) ?? 0) + 1);
  }
}

function collectSpacing(cs: CSSStyleDeclaration, spacing: Map<number, number>): void {
  const add = (raw: string) => {
    const v = parseFloat(raw);
    if (v > 0) {
      const q = Math.round(v / 4) * 4; // 4px grid — coarser than level 4's 8px, still compact
      spacing.set(q, (spacing.get(q) ?? 0) + 1);
    }
  };
  if (cs.display.includes('flex') || cs.display.includes('grid')) {
    if (cs.gap && cs.gap !== 'normal' && cs.gap !== '0px') add(cs.gap.split(/\s+/)[0]);
  }
  add(cs.paddingTop); add(cs.paddingLeft);
  add(cs.marginTop); add(cs.marginLeft);
}

// ── serialization ──────────────────────────────────────────────────

interface Sample {
  bgs: Map<string, ColorStat>; texts: Map<string, ColorStat>;
  sizes: Map<number, number>; headings: Map<string, number>;
  families: Map<string, number>; weights: Set<string>;
  radii: Map<number, number>; borderWidths: Map<number, number>;
  spacing: Map<number, number>;
  shadows: number; gradients: number; glassy: number; regionSampled: number;
  canvas: string;
  tokens: string[];
}

function keyToHex(key: string): string {
  return rgbToHex(rgbToHsl(...key.split(',').map(Number) as [number, number, number]));
}

function toHex(cssColor: string): string {
  const c = parseColor(cssColor);
  if (!c || c[3] < 0.1) return '';
  return keyToHex(`${c[0]},${c[1]},${c[2]}`);
}

function topColors(map: Map<string, ColorStat>, n: number, exclude?: string): string[] {
  const out: string[] = [];
  for (const [key, stat] of [...map.entries()].sort((a, b) => b[1].count - a[1].count)) {
    const hex = keyToHex(key);
    if (exclude && hex === exclude) continue;
    out.push(`${hex}×${stat.count}`);
    if (out.length >= n) break;
  }
  return out;
}

function serialize(s: Sample): string {
  const lines: string[] = [];

  const canvasHex = toHex(s.canvas);
  const bgList = topColors(s.bgs, TOP_BG, canvasHex);
  // accents: colorful solid backgrounds, dominant excluded, by frequency —
  // the same 0.15 colorfulness threshold buildColorModel uses (surface.ts).
  const accents = [...s.bgs.entries()]
    .filter(([, st]) => st.colorful > 0.15)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([key]) => keyToHex(key))
    .filter((hex) => hex !== canvasHex);
  const design: string[] = [];
  if (s.tokens.length) design.push(`tokens ${s.tokens.join(' ').slice(0, 200)}`);
  if (canvasHex) design.push(`canvas:${canvasHex}`);
  if (bgList.length) design.push(`bg:${bgList.join(',')}`);
  const textList = topColors(s.texts, TOP_TEXT);
  if (textList.length) design.push(`text:${textList.join(',')}`);
  if (accents.length) design.push(`accents:${accents.slice(0, TOP_ACCENTS).join(',')}`);
  if (design.length) lines.push(`DESIGN ${design.join(' ')}`);

  const bodyPx = [...s.sizes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const fam = [...s.families.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const type: string[] = [];
  if (bodyPx) type.push(`body:${bodyPx}px`);
  for (const h of ['h1', 'h2', 'h3'] as const) {
    const px = s.headings.get(h);
    if (px) type.push(`${h}:${Math.round(px)}px`);
  }
  if (fam) type.push(`font:${fam.slice(0, 24)}`);
  if (s.weights.size) type.push(`w:${[...s.weights].slice(0, TOP_WEIGHTS).join(',')}`);
  if (type.length) lines.push(`TYPE ${type.join(' ')}`);

  if (s.spacing.size) {
    const rhythm = median([...s.spacing.entries()].flatMap(([v, c]) => Array(c).fill(v) as number[]));
    const scale = [...s.spacing.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_SCALE).map(([v]) => v).sort((a, b) => a - b);
    const density = rhythm <= 4 ? 'compact' : rhythm <= 16 ? 'comfortable' : 'spacious';
    lines.push(`SPACE rhythm:${rhythm}px scale:${scale.join(',')}px density:${density}`);
  }

  if (s.regionSampled > 0) {
    const borderShare = [...s.borderWidths.values()].reduce((a, b) => a + b, 0);
    const language = s.glassy > 0 ? 'glassy' : s.shadows > s.regionSampled / 3 ? 'shadowed' : borderShare > s.regionSampled / 3 ? 'outlined' : 'flat';
    const radii = [...s.radii.entries()].sort((a, b) => a[0] - b[0]).slice(0, TOP_RADII).map(([v]) => `${v}px`);
    const borders = [...s.borderWidths.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([v]) => `${v}px`);
    const surface: string[] = [language];
    if (radii.length) surface.push(`radii:${radii.join(',')}`);
    if (borders.length) surface.push(`borders:${borders.join(',')}`);
    surface.push(`shadows:${s.shadows}/${s.regionSampled}`);
    surface.push(`gradients:${s.gradients > 0 ? 'yes' : 'none'}`);
    lines.push(`SURFACE ${surface.join(' ')}`);
  }

  let out = lines.join('\n');
  if (out.length > DESIGN_SNAPSHOT_MAX_CHARS) {
    out = out.slice(0, DESIGN_SNAPSHOT_MAX_CHARS - 13) + ' [TRUNCATED]';
  }
  return out;
}

function median(values: number[]): number {
  const v = [...values].sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : 0;
}

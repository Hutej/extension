/**
 * core/perceive/enrichment — C4-C10 perception enrichment functions.
 *
 * These functions run DURING perception (DOM access available) and add the
 * information the model was missing: heading outline tree (C4), colour model
 * (C6), component-type taxonomy (C7), density/rhythm/alignment (C8), text
 * understanding (C10). Each is additive — it enriches the existing Cluster /
 * Perception without changing what's already emitted.
 *
 * The pure classification lives in semantic.ts; these functions gather signals
 * from the live DOM and produce structured data the serializer emits.
 */

import type { Cluster } from './index.ts';
import { deepQuerySelector } from './index.ts';
import { parseColor, colorfulness } from '../../shared/color.ts';

// ── C4: Heading outline tree ──────────────────────────────────────

export interface HeadingNode {
  level: number;
  text: string;
  handle: string | null;
  depth: number;
  children: HeadingNode[];
}

/** Build a real document outline from h1-h6, ARIA headings, and role="heading".
 *  Produces a nested tree with depth, text, handle and the region each heading
 *  governs. Walks the DOM (including shadow roots) for all heading elements. */
export function buildOutline(): { tree: HeadingNode[]; clusterByHeading: Map<string, string> } {
  const headings: { level: number; text: string; el: Element; depth: number }[] = [];
  const walk = (el: Element | ShadowRoot, depth: number): void => {
    for (const child of Array.from(el.children)) {
      const tag = child.tagName.toLowerCase();
      const role = child.getAttribute('role');
      let level: number | null = null;
      if (/^h([1-6])$/.test(tag)) level = parseInt(tag[1], 10);
      else if (role === 'heading') {
        const ariaLevel = child.getAttribute('aria-level');
        level = ariaLevel ? Math.max(1, Math.min(6, parseInt(ariaLevel, 10))) : 2;
      }
      if (level != null) {
        headings.push({ level, text: (child.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80), el: child, depth });
      }
      walk(child, depth + 1);
      if (child instanceof HTMLElement && child.shadowRoot) walk(child.shadowRoot, depth + 1);
    }
  };
  walk(document.body, 0);

  // Build nested tree by level nesting (standard outline algorithm).
  const tree: HeadingNode[] = [];
  const stack: HeadingNode[] = [];
  const clusterByHeading = new Map<string, string>();
  for (const h of headings) {
    const handle = h.el.getAttribute('data-wm-c') || null;
    const node: HeadingNode = { level: h.level, text: h.text, handle, depth: h.depth, children: [] };
    // Pop the stack until the parent level is < this level.
    while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop();
    if (stack.length) stack[stack.length - 1].children.push(node);
    else tree.push(node);
    stack.push(node);
    if (handle) clusterByHeading.set(handle, h.text);
  }
  return { tree, clusterByHeading };
}

// ── C6: Colour as a model ──────────────────────────────────────────

export interface ColorEntry {
  hex: string;
  hsl: [number, number, number, number]; // h(0-360), s(0-100%), l(0-100%), a(0-1)
  freq: number;        // fraction of clusters with this color
  isBrand: boolean;    // detected by frequency in prominent positions
  role: 'bg' | 'text' | 'accent' | 'border';
}

export interface SurfaceGeometry {
  radii: number[];         // distinct border-radius values (px)
  borderWidths: number[];  // distinct border-width values (px)
  hasShadow: boolean;
  shadowSpread: number;    // approximate shadow blur+spread (px), 0 if none
  spacingRhythm: number;   // modal sibling gap (px)
}

export interface ColorModel {
  palette: ColorEntry[];
  relationships: string[];  // 'complementary', 'analogous', 'monochrome', 'triadic'
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

/** Build a colour model from the perception: parse every colour into HSL,
 *  derive the page's palette, detect relationships, and extract surface geometry. */
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
    // Accents: colorful solid-bg clusters
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

  // Dominant backgrounds (top 3 by frequency)
  for (const [, v] of [...bgColors.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 3)) {
    palette.push({
      hex: rgbToHex(v.hsl), hsl: v.hsl, freq: v.count / total,
      isBrand: v.prominent > 0.5 && v.count > 1, role: 'bg',
    });
  }
  // Text colors (top 2)
  for (const [, v] of [...textColors.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 2)) {
    palette.push({
      hex: rgbToHex(v.hsl), hsl: v.hsl, freq: v.count / total,
      isBrand: false, role: 'text',
    });
  }
  // Accents (top 3 by prominence × frequency)
  for (const [, v] of [...accentColors.entries()].sort((a, b) => (b[1].prominent * b[1].count) - (a[1].prominent * a[1].count)).slice(0, 3)) {
    palette.push({
      hex: rgbToHex(v.hsl), hsl: v.hsl, freq: v.count / total,
      isBrand: v.prominent > 0.4 && v.count <= 2, role: 'accent',
    });
  }

  // Hue relationships
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

  // Saturation + lightness ranges
  const sats = palette.map((p) => p.hsl[1]);
  const lights = palette.map((p) => p.hsl[2]);
  const saturationRange: [number, number] = [Math.min(...sats, 0), Math.max(...sats, 0)];
  const lightnessRange: [number, number] = [Math.min(...lights, 0), Math.max(...lights, 100)];

  // Surface geometry from cluster styles
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
      // Parse blur+spread from boxShadow: "Xpx Ypx Blurpx Spreadpx Color"
      const m = c.style.boxShadow.match(/([\d.]+)px\s+([\d.]+)px\s+([\d.]+)px(?:\s+([\d.]+)px)?/);
      if (m) shadowSpread = Math.max(shadowSpread, parseFloat(m[3]) + (m[4] ? parseFloat(m[4]) : 0));
    }
  }
  const gaps = p.clusters.map((c) => c.layout.siblingGapPx).filter((g): g is number => g != null && g > 0);
  const spacingRhythm = gaps.length ? gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 0;

  return {
    palette, relationships: [...new Set(relationships)], saturationRange, lightnessRange,
    geometry: {
      radii: [...radii].sort((a, b) => a - b).slice(0, 5),
      borderWidths: [...borderWidths].sort((a, b) => a - b).slice(0, 3),
      hasShadow, shadowSpread, spacingRhythm,
    },
  };
}

function rgbToHex(hsl: [number, number, number, number]): string {
  // Convert HSL back to hex for compact display
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

// ── C7: Component-type taxonomy ────────────────────────────────────

export type ComponentType =
  | 'card' | 'list' | 'table' | 'form' | 'hero' | 'navbar' | 'siderail'
  | 'breadcrumb' | 'tabstrip' | 'modal' | 'media' | 'codeblock' | 'quote'
  | 'footer-links' | 'cta' | 'avatar-group' | 'badge' | 'pagination' | 'unknown';

export interface ComponentClassification {
  type: ComponentType;
  confidence: number;
}

/** Classify a cluster into a recognisable component type beyond the 15 design
 *  roles. Uses structural + content signals (tag, child structure, text shape,
 *  link patterns). Pure — takes signals as data. */
export function classifyComponentType(cluster: Cluster, el: HTMLElement | null): ComponentClassification {
  if (!el) return { type: 'unknown', confidence: 0 };
  const tag = cluster.tag;
  const role = cluster.role;
  const designRole = cluster.designRole;
  const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
  const textLen = text.length;
  const links = el.querySelectorAll('a[href]').length;
  const children = el.children.length;

  // hero: large, top-of-page, display-type heading + short text
  if (designRole === 'page-title' || (cluster.rect.h > 200 && cluster.layout.widthRatio > 0.7 && textLen < 200 && el.querySelector('h1, h2, [role="heading"]')))
    return { type: 'hero', confidence: 0.7 };

  // navbar: nav role, wide, horizontal links
  if ((role === 'navigation' || tag === 'nav') && cluster.layout.widthRatio > 0.4 && links >= 3)
    return { type: 'navbar', confidence: 0.85 };

  // siderail: nav/aside, narrow, vertical
  if ((role === 'navigation' || role === 'complementary' || tag === 'aside') && cluster.layout.widthRatio <= 0.45)
    return { type: 'siderail', confidence: 0.8 };

  // table: table tag or grid with column headers
  if (tag === 'table' || role === 'table' || (el.querySelector('thead, th, [role="columnheader"]')))
    return { type: 'table', confidence: 0.9 };

  // form: form tag or multiple inputs
  if (tag === 'form' || role === 'form' || el.querySelectorAll('input, select, textarea').length >= 2)
    return { type: 'form', confidence: 0.85 };

  // breadcrumb: nav with separators (›, /, >) in text
  if (role === 'navigation' && /[›\/>·]\s/.test(text) && links >= 2 && textLen < 200)
    return { type: 'breadcrumb', confidence: 0.75 };

  // tabstrip: role="tablist" or [role="tab"] children
  if (role === 'tablist' || el.querySelector('[role="tab"], [role="tablist"]'))
    return { type: 'tabstrip', confidence: 0.9 };

  // modal: role="dialog" or aria-modal
  if (role === 'dialog' || el.getAttribute('aria-modal') === 'true')
    return { type: 'modal', confidence: 0.9 };

  // media block: img/video/figure/picture/svg, little text
  if (['img', 'picture', 'video', 'svg', 'figure'].includes(tag) || (cluster.style.hasBgImage && textLen < 40))
    return { type: 'media', confidence: 0.85 };

  // code block: pre/code/syntax
  if (tag === 'pre' || tag === 'code' || el.querySelector('pre, code'))
    return { type: 'codeblock', confidence: 0.85 };

  // quote: blockquote, q, or cite
  if (['blockquote', 'q', 'cite'].includes(tag))
    return { type: 'quote', confidence: 0.9 };

  // footer link group: footer-chrome role + link-dense
  if (designRole === 'footer-chrome' && links >= 3)
    return { type: 'footer-links', confidence: 0.8 };

  // cta: actions-primary + solid bg + button/link + short text
  if (designRole === 'actions-primary' && cluster.hasSolidBg && textLen < 60)
    return { type: 'cta', confidence: 0.75 };

  // avatar group: multiple img elements in a row, small
  const imgs = el.querySelectorAll('img').length;
  if (imgs >= 2 && cluster.rect.h < 80 && /row|flex/i.test(cluster.layout.display))
    return { type: 'avatar-group', confidence: 0.6 };

  // badge: small, solid bg, very short text
  if (cluster.rect.w < 120 && cluster.rect.h < 40 && cluster.hasSolidBg && textLen < 20)
    return { type: 'badge', confidence: 0.65 };

  // pagination: nav with numbers, links to "?page=" or numbered
  if (role === 'navigation' && /\b\d+\b/.test(text) && links >= 3 && textLen < 100)
    return { type: 'pagination', confidence: 0.65 };

  // card: solid bg + border/radius/shadow + moderate text + child structure
  if (cluster.hasSolidBg && (cluster.style.border !== 'none' || cluster.style.borderRadius !== '0px' || cluster.style.boxShadow !== 'none') && children >= 1 && textLen > 10)
    return { type: 'card', confidence: 0.7 };

  // list: ul/ol/list role or count > 2
  if (tag === 'ul' || tag === 'ol' || role === 'list' || cluster.count > 2)
    return { type: 'list', confidence: 0.7 };

  return { type: 'unknown', confidence: 0 };
}

// ── C8: Density, rhythm, alignment ────────────────────────────────

export interface DensityProfile {
  rhythmBaseline: number;     // modal gap between siblings (px)
  alignmentEdges: number[];   // repeating x-positions (px, quantized to 8px)
  whitespaceGini: number;      // 0..1 — distribution of free space (lower = more even)
}

/** Measure page-level density, rhythm, and alignment from clusters.
 *  These are INPUTS to the designer, not gates — the pixel verifier must never
 *  judge them after the fact. */
export function measureDensity(clusters: Cluster[], _viewport: { w: number; h: number }): DensityProfile {
  // Vertical rhythm: modal sibling gap
  const gaps = clusters.map((c) => c.layout.siblingGapPx).filter((g): g is number => g != null && g > 0);
  gaps.sort((a, b) => a - b);
  const rhythmBaseline = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;

  // Alignment edges are measured in measureAlignmentEdges (needs DOM positions).
  const alignmentEdges: number[] = [];

  // Whitespace distribution (Gini coefficient of inter-cluster gaps)
  const sortedGaps = [...gaps].sort((a, b) => a - b);
  let whitespaceGini = 0;
  if (sortedGaps.length >= 2) {
    const n = sortedGaps.length;
    const sum = sortedGaps.reduce((s, g) => s + g, 0);
    if (sum > 0) {
      for (let i = 0; i < n; i++) {
        whitespaceGini += (2 * (i + 1) - n - 1) * sortedGaps[i];
      }
      whitespaceGini = Math.max(0, Math.min(1, whitespaceGini / (n * sum)));
    }
  }

  return { rhythmBaseline, alignmentEdges, whitespaceGini };
}

/** Measure alignment edges from live DOM positions (needs the representative
 *  elements). Called from perceive() where the DOM is available. */
export function measureAlignmentEdges(clusters: Cluster[], _vpW: number): number[] {
  const edgeCounts = new Map<number, number>();
  for (const c of clusters) {
    const el = deepQuerySelector<HTMLElement>(c.selector);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 50 || r.height < 30) continue;
    const edge = Math.round(r.x / 8) * 8;
    edgeCounts.set(edge, (edgeCounts.get(edge) ?? 0) + 1);
  }
  // Edges that appear in 2+ clusters are "repeating"
  return [...edgeCounts.entries()].filter(([, n]) => n >= 2).map(([e]) => e).sort((a, b) => a - b).slice(0, 8);
}

// ── C10: Text understanding ────────────────────────────────────────

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
  // Kind: heading (h1-h6 or role=heading), code (pre/code/mono), number, label, prose
  const tag = cluster.tag;
  let kind: TextProfile['kind'] = 'none';
  if (/^h[1-6]$/.test(tag) || cluster.role === 'heading') kind = 'heading';
  else if (tag === 'pre' || tag === 'code' || /mono/i.test(cluster.style.fontFamily)) kind = 'code';
  else if (/^\$?[\d.,]+%?$/.test(text) && text.length < 20) kind = 'number';
  else if (readingLength < 40 && !text.includes('.')) kind = 'label';
  else if (readingLength > 80) kind = 'prose';
  else kind = 'label';

  // Direction
  const rawDir = el.dir || getComputedStyle(el).direction || 'auto';
  const dir = (rawDir === 'ltr' || rawDir === 'rtl' ? rawDir : 'auto') as 'ltr' | 'rtl' | 'auto';

  // Longest unbreakable token: split on whitespace, find the longest piece.
  // Also handle long URLs (no spaces) and camelCase identifiers.
  const tokens = text.split(/\s+/).filter(Boolean);
  let longestToken = 0;
  for (const t of tokens) {
    longestToken = Math.max(longestToken, t.length);
  }

  // Truncation: text-overflow:ellipsis or -webkit-line-clamp
  const cs = getComputedStyle(el);
  const truncated =
    (cs.textOverflow === 'ellipsis' && (cs.overflowX === 'hidden' || cs.overflowX === 'clip' || cs.overflow === 'hidden')) ||
    cs.webkitLineClamp !== 'none' && cs.webkitLineClamp !== '';

  return { readingLength, kind, dir, longestToken, truncated };
}

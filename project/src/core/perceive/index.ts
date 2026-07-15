/**
 * core/perceive — general RUNTIME page understanding. No fixed taxonomy, no
 * per-site logic. Walk the real visible DOM, read real computed styles +
 * geometry + text, let visually-similar elements CLUSTER themselves, and stamp
 * each emergent cluster with a stable signature-hash handle.
 *
 * This slice adds LAYOUT awareness so a redesign can change arrangement:
 *   - adaptive cluster retention (NO fixed count) by relative prominence + budget
 *   - per-cluster ClusterLayout (display/flow/width/container/owner/passive)
 *   - a LayoutSkeleton (regions / content column width / column count)
 *   - captureLayoutFingerprint() so verify can measure how much layout changed
 */

import { STYLE_ELEMENT_ID } from '../laws/index.ts';
import { isTransparent, parseColor } from '../../shared/color.ts';

const IGNORED_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'BR', 'HR', 'WBR', 'LINK', 'META', 'TEMPLATE', 'SLOT', 'PATH', 'DEFS']);
const ESCAPE_UI_ID = 'webmorph-escape-ui';

const MAX_NODES = 3000;
const MAX_TIME_MS = 4000;
const CLUSTER_ATTR = 'data-wm-c';
const PROMINENCE_FLOOR_RATIO = 0.015;  // tail below this * top is noise
const SERIALIZE_CHAR_BUDGET = 24000;   // adaptive cap by budget, not a fixed count (quality>speed: give the designer real evidence)

// ── Types ──────────────────────────────────────────────────────────

export interface ClusterStyle {
  background: string; color: string; border: string; borderRadius: string;
  boxShadow: string; fontFamily: string; fontSize: string; fontWeight: string;
  padding: string; display: string;
}

export interface ClusterLayout {
  display: string;
  flow: 'row' | 'column' | 'none';
  widthRatio: number;                    // rect.w / viewport.w
  isContainer: boolean;                  // lays out children
  ownedByFlexGrid: boolean;              // box owned by a flex/grid ancestor
  constraintOwnerHandle: string | null;  // handle of that ancestor, if it is a cluster
  parentHandle: string | null;
  isPassiveWrapper: boolean;             // safe to collapse via display:contents
  isOpaqueWrapper: boolean;              // large solid-bg container hiding the canvas backdrop
  depth: number;
}

export interface Cluster {
  handle: string;
  selector: string;
  count: number;
  tag: string;
  role: string | null;
  isNativeControl: boolean;
  isCheckboxRadio: boolean;
  hasSolidBg: boolean;
  rect: { w: number; h: number };
  samples: string[];
  style: ClusterStyle;
  layout: ClusterLayout;
  prominence: number;
}

export interface LayoutSkeleton {
  regions: { role: string; handle: string; widthRatio: number; order: number; rect: { w: number; h: number } }[];
  contentMaxWidthPx: number | null;
  columnCount: number;
}

export interface PageCanvas {
  bg: string; color: string; fontFamily: string; fontSize: string;
}

export interface Perception {
  builtInMs: number;
  nodeCount: number;
  canvas: PageCanvas;
  cssVars: { name: string; value: string }[];
  clusters: Cluster[];
  skeleton: LayoutSkeleton;
  handles: Set<string>;
  opaqueWrappers: Set<string>;   // handles of large solid-bg wrappers that hide the canvas
  viewport: { w: number; h: number };  // for area-fraction math (accent-trim budget)
}

export interface LayoutFingerprint {
  regions: { handle: string; x: number; y: number; w: number; h: number; paint: string }[];
  contentMaxWidthPx: number | null;
  columnCount: number;
  typeSizesPx: number[];
  overlapCount: number;   // non-nested region collisions (compared before/after by verify)
  bleedCount: number;     // text escaping its own painted block (compared before/after by verify)
}

interface Candidate {
  el: HTMLElement;
  tag: string;
  role: string | null;
  rect: { w: number; h: number };
  area: number;
  style: ClusterStyle;
  sample: string;
  hasSolidBg: boolean;
  flexDirection: string;
  depth: number;
  passive: boolean;
  childCount: number;
}

// ── Semantic role + accessible name (descriptive metadata only) ────

const IMPLICIT_ROLES: Record<string, string> = {
  nav: 'navigation', main: 'main', aside: 'complementary', header: 'banner',
  footer: 'contentinfo', ul: 'list', ol: 'list', li: 'listitem', form: 'form',
  article: 'article', table: 'table', img: 'img', figure: 'figure', section: 'region',
};

export function getSemanticRole(el: Element): string | null {
  const explicit = el.getAttribute('role');
  if (explicit) return explicit;
  const tag = el.tagName.toLowerCase();
  if (tag === 'a' && el.hasAttribute('href')) return 'link';
  if (tag === 'button') return 'button';
  if (tag === 'input') {
    const t = (el as HTMLInputElement).type;
    if (['button', 'submit', 'reset'].includes(t)) return 'button';
    if (t === 'checkbox') return 'checkbox';
    if (t === 'radio') return 'radio';
    return 'textbox';
  }
  if (tag === 'select') return 'combobox';
  if (tag === 'textarea') return 'textbox';
  if (/^h[1-6]$/.test(tag)) return 'heading';
  return IMPLICIT_ROLES[tag] ?? null;
}

export function getAccessibleName(el: Element): string {
  let name = el.getAttribute('aria-label') || '';
  if (!name && el.tagName === 'IMG') name = el.getAttribute('alt') || '';
  if (!name) name = el.getAttribute('title') || '';
  if (!name && 'placeholder' in el) name = (el as HTMLInputElement).placeholder || '';
  if (!name) {
    let direct = '';
    for (const n of Array.from(el.childNodes)) {
      if (n.nodeType === 3 && n.textContent) direct += n.textContent + ' ';
    }
    name = direct.trim();
  }
  return name.replace(/\s+/g, ' ').trim().slice(0, 60);
}

// ── Build perception ───────────────────────────────────────────────

export function perceive(): Perception {
  const t0 = performance.now();
  clearHandles();

  const candidates: Candidate[] = [];
  const vpW = window.innerWidth || 1280;
  const vpArea = vpW * (window.innerHeight || 800);
  let visited = 0;

  const walk = (el: HTMLElement, depth: number): void => {
    if (visited >= MAX_NODES || performance.now() - t0 > MAX_TIME_MS || depth > 24) return;
    const tag = el.tagName.toUpperCase();
    if (IGNORED_TAGS.has(tag)) return;
    if (el.id === STYLE_ELEMENT_ID || el.id === ESCAPE_UI_ID || el.hasAttribute('data-webmorph-ui')) return;

    const rect = el.getBoundingClientRect();
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    visited++;

    const descend = () => {
      for (const child of Array.from(el.children)) if (child instanceof HTMLElement) walk(child, depth + 1);
      if (el.shadowRoot) for (const child of Array.from(el.shadowRoot.children)) if (child instanceof HTMLElement) walk(child, depth + 1);
    };

    if (w <= 1 || h <= 1) { descend(); return; }

    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) === 0) { descend(); return; }

    const role = getSemanticRole(el);
    const bg = cs.backgroundColor;
    const solidBg = !isTransparent(bg);
    const border = normalizeBorder(cs);
    const hasShadow = cs.boxShadow !== 'none';
    const hasText = directTextLength(el) > 0;
    const isNativeControl = ['button', 'input', 'select', 'textarea'].includes(tag.toLowerCase());
    const isInteractive = role === 'link' || role === 'button' || isNativeControl;

    const isComponent = solidBg || role != null || (hasText && w > 24 && h > 12) ||
      cs.borderRadius !== '0px' || hasShadow || border !== 'none';

    if (isComponent) {
      const passive = !solidBg && border === 'none' && !hasShadow && !isInteractive && el.children.length >= 1;
      candidates.push({
        el, tag: tag.toLowerCase(), role,
        rect: { w, h }, area: w * h, hasSolidBg: solidBg,
        sample: getAccessibleName(el) || directText(el).slice(0, 48),
        flexDirection: cs.flexDirection, depth, passive, childCount: el.children.length,
        style: {
          background: bg, color: cs.color, border,
          borderRadius: cs.borderRadius, boxShadow: hasShadow ? cs.boxShadow : 'none',
          fontFamily: firstFamily(cs.fontFamily), fontSize: cs.fontSize, fontWeight: cs.fontWeight,
          padding: cs.padding, display: cs.display,
        },
      });
    }
    descend();
  };

  if (document.body) for (const child of Array.from(document.body.children)) if (child instanceof HTMLElement) walk(child, 0);

  const clusters = clusterAndStamp(candidates, vpArea, vpW);
  const canvas = readCanvas();
  const cssVars = readColorVars();
  const skeleton = buildSkeleton(clusters, vpW);

  return {
    builtInMs: Math.round(performance.now() - t0),
    nodeCount: visited,
    canvas, cssVars, clusters, skeleton,
    handles: new Set(clusters.map((c) => c.handle)),
    opaqueWrappers: new Set(clusters.filter((c) => c.layout.isOpaqueWrapper).map((c) => c.handle)),
    viewport: { w: vpW, h: window.innerHeight || 800 },
  };
}

// ── Clustering + adaptive retention + layout enrichment ────────────

function clusterAndStamp(candidates: Candidate[], vpArea: number, vpW: number): Cluster[] {
  const groups = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const sig = signature(c);
    const arr = groups.get(sig);
    if (arr) arr.push(c); else groups.set(sig, [c]);
  }

  interface Raw extends Cluster { _members: Candidate[]; }
  const raws: Raw[] = [];
  for (const [sig, members] of groups) {
    const rep = members[0];
    const cappedArea = members.reduce((s, m) => s + Math.min(m.area, vpArea), 0);
    const prominence = cappedArea / vpArea + members.length;
    const handle = 'c' + hash(sig);
    const samples: string[] = [];
    for (const m of members) {
      const s = m.sample.trim();
      if (s && !samples.includes(s)) samples.push(s);
      if (samples.length >= 3) break;
    }
    const isNativeControl = ['button', 'input', 'select', 'textarea'].includes(rep.tag);
    raws.push({
      handle, selector: `[${CLUSTER_ATTR}="${handle}"]`, count: members.length,
      tag: rep.tag, role: rep.role, isNativeControl,
      isCheckboxRadio: rep.role === 'checkbox' || rep.role === 'radio',
      hasSolidBg: rep.hasSolidBg, rect: rep.rect, samples, style: rep.style,
      layout: placeholderLayout(rep, vpW), prominence, _members: members,
    });
  }

  raws.sort((a, b) => b.prominence - a.prominence);

  // Adaptive retention: relative prominence floor + serialization budget. NO fixed count.
  const kept: Raw[] = [];
  if (raws.length) {
    const floor = raws[0].prominence * PROMINENCE_FLOOR_RATIO;
    let chars = 0;
    for (const r of raws) {
      if (r.prominence < floor) break;
      const cost = estimateChars(r);
      if (chars + cost > SERIALIZE_CHAR_BUDGET && kept.length > 0) break;
      kept.push(r);
      chars += cost;
    }
  }

  // Stamp handles on kept members.
  for (const r of kept) for (const m of r._members) m.el.setAttribute(CLUSTER_ATTR, r.handle);

  // Enrich layout facts now that handles exist (needs data-wm-c on ancestors).
  for (const r of kept) enrichLayout(r, r._members[0], vpW);

  return kept.map(({ _members, ...c }) => c);
}

function placeholderLayout(rep: Candidate, vpW: number): ClusterLayout {
  const disp = rep.style.display;
  const isFlex = disp.includes('flex');
  const isGrid = disp.includes('grid');
  // Opaque wrapper: wide (>85% viewport), solid bg, not a passive wrapper.
  // These hide the canvas backdrop and need to be made transparent when the
  // canvas is redesigned. Only flag on non-passive containers at low depth.
  const isOpaqueWrapper = rep.hasSolidBg && !rep.passive &&
    (rep.rect.w / vpW) >= 0.85 && rep.rect.h > 80;
  return {
    display: disp,
    flow: isFlex ? (rep.flexDirection.startsWith('column') ? 'column' : 'row') : (isGrid ? 'row' : 'none'),
    widthRatio: Math.min(1, rep.rect.w / vpW),
    isContainer: isFlex || isGrid || rep.childCount >= 2,
    ownedByFlexGrid: false,
    constraintOwnerHandle: null,
    parentHandle: null,
    isPassiveWrapper: rep.passive,
    isOpaqueWrapper,
    depth: rep.depth,
  };
}

function enrichLayout(cluster: Cluster, rep: Candidate, _vpW: number): void {
  // First flex/grid ancestor owns the box; record whether one exists + its handle.
  let owner: HTMLElement | null = null;
  let p = rep.el.parentElement;
  while (p && p !== document.body && p !== document.documentElement) {
    const d = getComputedStyle(p).display;
    if (d.includes('flex') || d.includes('grid')) { owner = p; break; }
    p = p.parentElement;
  }
  cluster.layout.ownedByFlexGrid = owner != null;
  cluster.layout.constraintOwnerHandle = owner?.getAttribute(CLUSTER_ATTR) || null;
  // Nearest ancestor cluster = parent handle.
  let a = rep.el.parentElement;
  while (a) {
    const h = a.getAttribute(CLUSTER_ATTR);
    if (h && h !== cluster.handle) { cluster.layout.parentHandle = h; break; }
    a = a.parentElement;
  }
}

function signature(c: Candidate): string {
  const s = c.style;
  return [
    c.tag, c.role ?? '-', s.background, s.color, s.border,
    pxBucket(s.borderRadius), s.boxShadow === 'none' ? '0' : '1',
    s.fontFamily, pxBucket(s.fontSize), s.fontWeight, s.display,
  ].join('|');
}

function estimateChars(c: Cluster): number {
  return 60 + c.samples.join('').length;
}

// ── Layout skeleton ────────────────────────────────────────────────

function buildSkeleton(clusters: Cluster[], vpW: number): LayoutSkeleton {
  const regions = clusters
    .filter((c) => c.layout.widthRatio >= 0.15 && c.rect.w > 0)
    .slice(0, 12)
    .map((c, i) => ({ role: c.role || c.tag, handle: c.handle, widthRatio: round2(c.layout.widthRatio), order: i, rect: { w: c.rect.w, h: c.rect.h } }));

  // Column count: distinct left-edge buckets among medium-width side-by-side regions.
  const cols = new Set<number>();
  for (const c of clusters) {
    if (c.layout.widthRatio >= 0.2 && c.layout.widthRatio <= 0.75) {
      const el = document.querySelector(c.selector) as HTMLElement | null;
      if (el) cols.add(Math.round(el.getBoundingClientRect().x / 40));
    }
  }
  const primary = findPrimaryContentNode();
  const contentMaxWidthPx = primary ? Math.round(primary.getBoundingClientRect().width) : null;
  return { regions, contentMaxWidthPx, columnCount: Math.max(1, cols.size) };
}

// ── Layout fingerprint (for verify's change signal) ────────────────

export function captureLayoutFingerprint(): LayoutFingerprint {
  const regions: LayoutFingerprint['regions'] = [];
  const els = Array.from(document.querySelectorAll(`[${CLUSTER_ATTR}]`)).slice(0, 60);
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 && r.height < 1) continue;
    const cs = getComputedStyle(el);
    regions.push({
      handle: el.getAttribute(CLUSTER_ATTR) || '',
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      paint: cs.backgroundColor + '|' + cs.color,
    });
  }
  const primary = findPrimaryContentNode();
  const contentMaxWidthPx = primary ? Math.round(primary.getBoundingClientRect().width) : null;

  const sizes = new Set<number>();
  for (const el of Array.from(document.querySelectorAll('h1, h2, h3, h4, p, li, a, button')).slice(0, 40)) {
    const fs = parseFloat(getComputedStyle(el).fontSize);
    if (fs) sizes.add(Math.round(fs));
  }
  const cols = new Set<number>();
  for (const el of Array.from(document.querySelectorAll(`[${CLUSTER_ATTR}]`))) {
    const r = el.getBoundingClientRect();
    const ratio = r.width / (window.innerWidth || 1280);
    if (ratio >= 0.2 && ratio <= 0.75) cols.add(Math.round(r.x / 40));
  }
  return { regions, contentMaxWidthPx, columnCount: Math.max(1, cols.size), typeSizesPx: [...sizes].sort((a, b) => a - b), overlapCount: computeOverlapCount(), bleedCount: countTextBleeds() };
}

/**
 * Count non-nested region collisions. Computed identically before AND after apply,
 * so verify can flag only NEW overlaps our CSS introduced — pre-existing overlaps
 * (floating infoboxes, sticky/absolute panels) cancel out and never false-fail.
 * One representative element per cluster (deduped by handle) keeps it O(regions^2).
 */
/**
 * Text bleeding horizontally out of its own painted block — e.g. oversized
 * display type escaping a fixed color-block header. Only elements that paint
 * their own background/border with overflow visible are counted; scrollable and
 * hidden containers overflow by design and are skipped. Compared before/after
 * by verify, so pre-existing bleeds never false-fail.
 */
function countTextBleeds(): number {
  let n = 0;
  for (const el of Array.from(document.querySelectorAll(`[${CLUSTER_ATTR}]`))) {
    if (!(el instanceof HTMLElement) || el.hasAttribute('data-webmorph-ui') || el.clientWidth === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.overflowX !== 'visible') continue;
    const bg = parseColor(cs.backgroundColor);
    const painted = (bg !== null && bg[3] >= 0.1) || ((parseFloat(cs.borderTopWidth) || 0) >= 2 && cs.borderTopStyle !== 'none');
    if (painted && el.scrollWidth > el.clientWidth + 8) n++;
  }
  return n;
}

function computeOverlapCount(): number {
  const vpW = window.innerWidth || 1280;
  const seen = new Set<string>();
  const regions: { el: Element; r: DOMRect }[] = [];
  for (const el of Array.from(document.querySelectorAll(`[${CLUSTER_ATTR}]`))) {
    const h = el.getAttribute(CLUSTER_ATTR)!;
    if (seen.has(h)) continue;
    seen.add(h);
    const r = el.getBoundingClientRect();
    if (r.width / vpW >= 0.2 && r.width / vpW <= 0.9 && r.height > 40) regions.push({ el, r });
    if (regions.length >= 18) break;
  }
  let collisions = 0;
  for (let i = 0; i < regions.length; i++) {
    for (let j = i + 1; j < regions.length; j++) {
      const A = regions[i], B = regions[j];
      if (A.el.contains(B.el) || B.el.contains(A.el)) continue;
      const x = Math.max(0, Math.min(A.r.right, B.r.right) - Math.max(A.r.left, B.r.left));
      const y = Math.max(0, Math.min(A.r.bottom, B.r.bottom) - Math.max(A.r.top, B.r.top));
      const ov = x * y;
      if (ov <= 0) continue;
      const minArea = Math.min(A.r.width * A.r.height, B.r.width * B.r.height);
      if (minArea > 0 && ov / minArea > 0.4) collisions++;
    }
  }
  return collisions;
}

// ── Page canvas + CSS variables ────────────────────────────────────

function readCanvas(): PageCanvas {
  const body = document.body;
  const bodyCs = body ? getComputedStyle(body) : null;
  const htmlCs = getComputedStyle(document.documentElement);
  let bg = bodyCs && !isTransparent(bodyCs.backgroundColor) ? bodyCs.backgroundColor : htmlCs.backgroundColor;
  if (isTransparent(bg)) bg = 'rgb(255, 255, 255)';
  return {
    bg, color: bodyCs ? bodyCs.color : 'rgb(0, 0, 0)',
    fontFamily: bodyCs ? firstFamily(bodyCs.fontFamily) : 'sans-serif',
    fontSize: bodyCs ? bodyCs.fontSize : '16px',
  };
}

function readColorVars(): { name: string; value: string }[] {
  const names = new Set<string>();
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try { rules = sheet.cssRules; } catch { continue; }
    if (!rules) continue;
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSStyleRule)) continue;
      if (!/:root|(^|,)\s*html\b/.test(rule.selectorText || '')) continue;
      for (let i = 0; i < rule.style.length; i++) {
        const prop = rule.style[i];
        if (prop.startsWith('--')) names.add(prop);
      }
    }
    if (names.size > 120) break;
  }
  const rootCs = getComputedStyle(document.documentElement);
  const out: { name: string; value: string }[] = [];
  for (const name of names) {
    const value = rootCs.getPropertyValue(name).trim();
    if (value && /(#|rgb|hsl|lab|lch|oklch)/i.test(value) && value.length < 40) out.push({ name, value });
    if (out.length >= 40) break;
  }
  return out;
}

// ── Primary content detection ──────────────────────────────────────

export function findPrimaryContentNode(): Element | null {
  let best: Element | null = null;
  let bestLen = 200;
  const vpArea = (window.innerWidth || 1280) * (window.innerHeight || 800);
  for (const el of Array.from(document.body.querySelectorAll('*'))) {
    if (el.hasAttribute('data-webmorph-ui')) continue;
    const textLen = (el.textContent || '').replace(/\s+/g, ' ').trim().length;
    if (textLen < bestLen) continue;
    let interactive = 0;
    el.querySelectorAll('a, button, input, select, textarea').forEach((i) => { interactive += (i.textContent || '').trim().length; });
    if (interactive / textLen >= 0.3) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width * rect.height < vpArea * 0.05) continue;
    best = el; bestLen = textLen;
  }
  return best;
}

export function clearHandles(): void {
  document.querySelectorAll(`[${CLUSTER_ATTR}]`).forEach((el) => el.removeAttribute(CLUSTER_ATTR));
}

// ── Serialize for the AI ───────────────────────────────────────────

export function serializePerception(p: Perception): string {
  const lines: string[] = [];
  lines.push('PAGE CANVAS');
  lines.push(`  viewport:${p.viewport.w}x${p.viewport.h}px (design to fit this width)`);
  lines.push(`  background:${short(p.canvas.bg)} text:${short(p.canvas.color)} font:${p.canvas.fontFamily} ${p.canvas.fontSize}`);

  lines.push('LAYOUT SKELETON');
  lines.push(`  columns:${p.skeleton.columnCount} contentWidth:${p.skeleton.contentMaxWidthPx ?? '?'}px`);
  if (p.skeleton.regions.length) {
    lines.push('PAGE COMPOSITION — decide these region proportions FIRST, then design inside them:');
    for (const r of p.skeleton.regions) {
      lines.push(`  [region] ${r.handle} ${r.role} ${r.rect.w}x${r.rect.h}px (${Math.round(r.widthRatio * 100)}%w)`);
    }
  }

  if (p.cssVars.length) {
    lines.push('CSS COLOR VARIABLES (override via "variables" to retheme framework CSS):');
    lines.push('  ' + p.cssVars.map((v) => `${v.name}:${short(v.value)}`).join('  '));
  }

  lines.push('');
  lines.push('COMPONENTS (target these ids; use styles for paint, layout for arrangement/sizing/spacing):');
  for (const c of p.clusters) {
    const L = c.layout;
    const parts = [
      `  ${c.handle} x${c.count} <${c.tag}>${c.role ? ' ' + c.role : ''}`,
      `~${c.rect.w}x${c.rect.h}(${Math.round(L.widthRatio * 100)}%w)`,
      `disp:${L.display}${L.isContainer ? '/container' : ''}`,
      `bg:${short(c.style.background)}`, `text:${short(c.style.color)}`,
    ];
    if (c.style.border !== 'none') parts.push(`border:${short(c.style.border)}`);
    if (c.style.borderRadius !== '0px') parts.push(`radius:${c.style.borderRadius}`);
    parts.push(`font:${c.style.fontFamily}/${c.style.fontSize}/${c.style.fontWeight}`);
    if (c.isNativeControl) parts.push('[native-control]');
    if (['img', 'picture', 'video', 'svg', 'figure'].includes(c.tag)) parts.push('[image]');
    if (L.isPassiveWrapper) parts.push('[passive-wrapper]');
    if (L.isOpaqueWrapper) parts.push('[opaque-wrapper]');
    let line = parts.join(' ');
    if (c.samples.length) line += `  e.g. ${c.samples.map((s) => JSON.stringify(s.slice(0, 30))).join(', ')}`;
    lines.push(line);
  }
  return lines.join('\n');
}

// ── small helpers ──────────────────────────────────────────────────

function normalizeBorder(cs: CSSStyleDeclaration): string {
  const w = parseFloat(cs.borderTopWidth) || 0;
  if (w === 0 || cs.borderTopStyle === 'none') return 'none';
  return `${cs.borderTopWidth} ${cs.borderTopStyle} ${cs.borderTopColor}`;
}
function directTextLength(el: Element): number {
  let n = 0;
  for (const node of Array.from(el.childNodes)) if (node.nodeType === 3) n += (node.textContent || '').trim().length;
  return n;
}
function directText(el: Element): string {
  let t = '';
  for (const node of Array.from(el.childNodes)) if (node.nodeType === 3) t += (node.textContent || '') + ' ';
  t = t.trim();
  return t || (el.textContent || '').replace(/\s+/g, ' ').trim();
}
function firstFamily(f: string): string { return (f.split(',')[0] || 'sans-serif').trim().replace(/['"]/g, ''); }
function pxBucket(v: string): string { const n = parseFloat(v); return isNaN(n) ? v : String(Math.round(n)); }
function round2(n: number): number { return Math.round(n * 100) / 100; }
function short(color: string): string { return color.replace(/\s+/g, ''); }
function hash(str: string): string {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36).padStart(6, '0').slice(-6);
}

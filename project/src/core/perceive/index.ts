/**
 * core/perceive — general RUNTIME page understanding. No fixed taxonomy, no
 * per-site logic. Walk the real visible DOM, read real computed styles +
 * geometry + text, let visually-similar elements CLUSTER themselves, and stamp
 * each emergent cluster with a stable signature-hash handle.
 *
 * Full-page rewrite: no node cap (see the whole page), coarsened signature
 * buckets (merge families), hierarchical tree serialization (model sees
 * parent-child nesting), two-tier detail (every handle listed, attention
 * focused), shadow-root tracking for downstream CSS injection, pre-resolved
 * CSS variables for pure compile/verify.
 */

import { STYLE_ELEMENT_ID } from '../laws/index.ts';
import { isTransparent, parseColor } from '../../shared/color.ts';

const IGNORED_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'BR', 'HR', 'WBR', 'LINK', 'META', 'TEMPLATE', 'SLOT', 'PATH', 'DEFS']);
const ESCAPE_UI_ID = 'webmorph-escape-ui';

const MAX_TIME_MS = 6000;           // budget — no node cap, time is the only limit
const MAX_DEPTH = 30;               // safety net (not a truncation — 30 is very deep)
const CLUSTER_ATTR = 'data-wm-c';
const TIER1_FULL_DETAIL_COUNT = 80; // top clusters by prominence get full serialization
const SERIALIZE_BUDGET = 12000;   // char budget for the serialized perception (demote/drop tail when over)

/** Last serialization budget stats — read by content.ts for the ledger. */
export let lastSerializeBudget = { before: 0, after: 0 };

// ── Types ──────────────────────────────────────────────────────────

export interface ClusterStyle {
  background: string; color: string; border: string; borderRadius: string;
  boxShadow: string; fontFamily: string; fontSize: string; fontWeight: string;
  padding: string; display: string;
  hasBgImage: boolean;   // own background-image is a url() — a CONTENT image (thumbnail). Gradients don't count.
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

/** Site identity for the design prompt (ruling: the model MAY know where it is;
 *  CODE must not branch on the domain). host = hostname, title = page <title>. */
export interface SiteIdentity {
  host: string;
  title: string;
}

export interface Perception {
  builtInMs: number;
  nodeCount: number;
  site: SiteIdentity;             // domain + page title — context for the design model
  canvas: PageCanvas;
  cssVars: { name: string; value: string }[];
  cssVarMap: Record<string, string>;    // --name → resolved rgb (for pure compile/verify)
  clusters: Cluster[];
  skeleton: LayoutSkeleton;
  handles: Set<string>;
  opaqueWrappers: Set<string>;          // handles of large solid-bg wrappers that hide the canvas
  scrollables: { handle: string; axis: 'x' | 'y' | 'both' }[];  // scrollable containers (req D)
  viewport: { w: number; h: number };   // for area-fraction math (accent-trim budget)
  shadowRoots: ShadowRoot[];            // open shadow roots for downstream CSS injection
}

export interface LayoutFingerprint {
  regions: { handle: string; x: number; y: number; w: number; h: number; paint: string }[];
  contentMaxWidthPx: number | null;
  columnCount: number;
  typeSizesPx: number[];
  overlapCount: number;
  bleedCount: number;
  scrollWidth: number;                  // ponytail: for delta-overflow in verify (Phase 3)
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
  const shadowRoots: ShadowRoot[] = [];
  const vpW = window.innerWidth || 1280;
  const vpArea = vpW * (window.innerHeight || 800);
  let visited = 0;

  const walk = (el: HTMLElement, depth: number): void => {
    if (performance.now() - t0 > MAX_TIME_MS || depth > MAX_DEPTH) return;
    const tag = el.tagName.toUpperCase();
    if (IGNORED_TAGS.has(tag)) return;
    if (el.id === STYLE_ELEMENT_ID || el.id === ESCAPE_UI_ID || el.hasAttribute('data-webmorph-ui')) return;

    const rect = el.getBoundingClientRect();
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    visited++;

    const descend = () => {
      for (const child of Array.from(el.children)) if (child instanceof HTMLElement) walk(child, depth + 1);
      if (el.shadowRoot) {
        shadowRoots.push(el.shadowRoot);
        for (const child of Array.from(el.shadowRoot.children)) if (child instanceof HTMLElement) walk(child, depth + 1);
      }
    };

    if (w <= 1 || h <= 1) { descend(); return; }

    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) === 0) { descend(); return; }

    const role = getSemanticRole(el);
    const bg = cs.backgroundColor;
    const solidBg = !isTransparent(bg);
    const hasBgImage = /url\(/i.test(cs.backgroundImage);  // content image (thumbnail) — never paint over it
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
          hasBgImage,
        },
      });
    }
    descend();
  };

  if (document.body) for (const child of Array.from(document.body.children)) if (child instanceof HTMLElement) walk(child, 0);

  const clusters = clusterAndStamp(candidates, vpArea, vpW);
  const canvas = readCanvas();
  const cssVars = readColorVars();
  const cssVarMap = resolveVarMap(cssVars);
  const skeleton = buildSkeleton(clusters, vpW);
  const scrollables = findScrollables(clusters);

  return {
    builtInMs: Math.round(performance.now() - t0),
    nodeCount: visited,
    site: { host: location.hostname, title: (document.title || '').slice(0, 80) },
    canvas, cssVars, cssVarMap, clusters, skeleton,
    handles: new Set(clusters.map((c) => c.handle)),
    opaqueWrappers: new Set(clusters.filter((c) => c.layout.isOpaqueWrapper).map((c) => c.handle)),
    scrollables,
    viewport: { w: vpW, h: window.innerHeight || 800 },
    shadowRoots,
  };
}

/** Detect scrollable containers among stamped clusters (req D). A page can have
 *  several scrollable regions (not just the document); the design model needs to
 *  know they exist so it styles their contents and never breaks their scroll.
 *  One representative per handle; only sizable containers (not tiny overflow clips). */
function findScrollables(clusters: Cluster[]): { handle: string; axis: 'x' | 'y' | 'both' }[] {
  const out: { handle: string; axis: 'x' | 'y' | 'both' }[] = [];
  const seen = new Set<string>();
  for (const cl of clusters) {
    if (seen.has(cl.handle)) continue;
    const el = document.querySelector(cl.selector) as HTMLElement | null;
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 100 || r.height < 100) continue;       // ponytail: skip tiny overflow clips
    const cs = getComputedStyle(el);
    const sx = cs.overflowX === 'auto' || cs.overflowX === 'scroll';
    const sy = cs.overflowY === 'auto' || cs.overflowY === 'scroll';
    if (!sx && !sy) continue;
    seen.add(cl.handle);
    out.push({ handle: cl.handle, axis: sx && sy ? 'both' : sx ? 'x' : 'y' });
  }
  return out;
}

// ── Clustering + retention + layout enrichment ─────────────────────

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

  // Retain ALL clusters — no prominence floor, no char budget truncation.
  // Every visible cluster the user can see must be in the inventory.
  // Two-tier serialization handles the prompt-size budget.
  const kept: Raw[] = raws;

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
  let owner: HTMLElement | null = null;
  let p = rep.el.parentElement;
  while (p && p !== document.body && p !== document.documentElement) {
    const d = getComputedStyle(p).display;
    if (d.includes('flex') || d.includes('grid')) { owner = p; break; }
    p = p.parentElement;
  }
  cluster.layout.ownedByFlexGrid = owner != null;
  cluster.layout.constraintOwnerHandle = owner?.getAttribute(CLUSTER_ATTR) || null;
  let a = rep.el.parentElement;
  while (a) {
    const h = a.getAttribute(CLUSTER_ATTR);
    if (h && h !== cluster.handle) { cluster.layout.parentHandle = h; break; }
    a = a.parentElement;
  }
}

/** Coarsened signature: 4px buckets for size, 8-step quantize for colors.
 *  Merges 14px/15px buttons into one cluster — stops family fragmentation.
 *  Reported style values stay exact; only the grouping is coarsened. */
function signature(c: Candidate): string {
  const s = c.style;
  return [
    c.tag, c.role ?? '-',
    colorBucket(s.background), colorBucket(s.color), s.border,
    pxBucket4(s.borderRadius), s.boxShadow === 'none' ? '0' : '1',
    s.fontFamily, pxBucket4(s.fontSize), s.fontWeight, s.display,
  ].join('|');
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
  // Content width from cluster data — O(clusters), no O(n²) DOM scan.
  const contentMaxWidthPx = findContentWidthFromClusters(clusters, vpW);
  return { regions, contentMaxWidthPx, columnCount: Math.max(1, cols.size) };
}

function findContentWidthFromClusters(clusters: Cluster[], vpW: number): number | null {
  let best = 0;
  for (const c of clusters) {
    if (c.layout.widthRatio >= 0.9) continue;       // skip full-width wrappers
    if (c.layout.isPassiveWrapper || c.layout.isOpaqueWrapper) continue;
    if (c.samples.length > 0 || c.role === 'main' || c.role === 'article') {
      best = Math.max(best, c.rect.w);
    }
  }
  return best || null;
}

// ── Layout fingerprint (for verify's change signal) ────────────────

export function captureLayoutFingerprint(): LayoutFingerprint {
  const regions: LayoutFingerprint['regions'] = [];
  // Deduplicate by handle — one representative per cluster, not per element.
  // Without this, multi-element clusters (count > 1) waste slots and push
  // below-fold handles past the cap, hiding their collapse from verify.
  const seenHandles = new Set<string>();
  const allEls = Array.from(document.querySelectorAll(`[${CLUSTER_ATTR}]`));
  for (const el of allEls) {
    if (regions.length >= 200) break;
    const h = el.getAttribute(CLUSTER_ATTR) || '';
    if (!h || seenHandles.has(h)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 && r.height < 1) continue;
    const cs = getComputedStyle(el);
    seenHandles.add(h);
    regions.push({
      handle: h,
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      paint: cs.backgroundColor + '|' + cs.color,
    });
  }
  const contentMaxWidthPx = findContentWidthFromStamped();

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
  return {
    regions, contentMaxWidthPx, columnCount: Math.max(1, cols.size),
    typeSizesPx: [...sizes].sort((a, b) => a - b),
    overlapCount: computeOverlapCount(), bleedCount: countTextBleeds(),
    scrollWidth: document.documentElement.scrollWidth,
  };
}

/** O(stamped) content-width — replaces the O(n²) findPrimaryContentNode for fingerprints. */
function findContentWidthFromStamped(): number | null {
  const vpW = window.innerWidth || 1280;
  let best = 0;
  for (const el of Array.from(document.querySelectorAll(`[${CLUSTER_ATTR}]`))) {
    const r = el.getBoundingClientRect();
    const ratio = r.width / vpW;
    if (ratio >= 0.9 || ratio < 0.15) continue;
    const role = el.getAttribute('role');
    const tag = el.tagName.toLowerCase();
    if (role === 'main' || tag === 'main' || role === 'article' || tag === 'article') {
      best = Math.max(best, r.width);
    }
  }
  if (!best) {
    for (const el of Array.from(document.querySelectorAll(`[${CLUSTER_ATTR}]`))) {
      const r = el.getBoundingClientRect();
      const ratio = r.width / vpW;
      if (ratio >= 0.9 || ratio < 0.2) continue;
      if ((el.textContent || '').trim().length > 200) { best = Math.max(best, r.width); break; }
    }
  }
  return best || null;
}

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

/** Resolve CSS variable values to rgb for pure compile/verify. parseColor handles
 *  rgb/hex/hsl; oklch/named get a DOM fallback (only runs during perception). */
function resolveVarMap(vars: { name: string; value: string }[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const v of vars) {
    if (parseColor(v.value)) { map[v.name] = v.value; continue; }
    // DOM fallback for oklch/named/exotic — runs once during perception.
    try {
      const el = document.createElement('div');
      el.style.color = v.value;
      el.style.display = 'none';
      document.body.appendChild(el);
      map[v.name] = getComputedStyle(el).color;
      el.remove();
    } catch { map[v.name] = v.value; }
  }
  return map;
}

// ── Primary content detection (O(stamped) — no O(n²) scan) ─────────

export function findPrimaryContentNode(): Element | null {
  // Fast path: look for main/article regions among stamped clusters.
  for (const el of Array.from(document.querySelectorAll(`[${CLUSTER_ATTR}]`))) {
    const role = el.getAttribute('role');
    const tag = el.tagName.toLowerCase();
    if (role === 'main' || tag === 'main' || role === 'article' || tag === 'article') {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return el;
    }
  }
  // Fallback: stamped cluster with most text content.
  let best: Element | null = null;
  let bestLen = 200;
  const vpArea = (window.innerWidth || 1280) * (window.innerHeight || 800);
  for (const el of Array.from(document.querySelectorAll(`[${CLUSTER_ATTR}]`))) {
    if (el.hasAttribute('data-webmorph-ui')) continue;
    const textLen = (el.textContent || '').replace(/\s+/g, ' ').trim().length;
    if (textLen < bestLen) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width * rect.height < vpArea * 0.05) continue;
    best = el; bestLen = textLen;
  }
  return best;
}

export function clearHandles(): void {
  document.querySelectorAll(`[${CLUSTER_ATTR}]`).forEach((el) => el.removeAttribute(CLUSTER_ATTR));
}

// ── Serialize for the AI — hierarchical tree, two-tier detail ───────

export function serializePerception(p: Perception): string {
  const header: string[] = [];
  header.push(`PAGE ${p.viewport.w}x${p.viewport.h} site:${p.site.host} "${p.site.title}" bg:${short(p.canvas.bg)} text:${short(p.canvas.color)} font:${p.canvas.fontFamily} ${p.canvas.fontSize}`);
  header.push(`COLS ${p.skeleton.columnCount} CONTENT ${p.skeleton.contentMaxWidthPx ?? '?'}px`);
  if (p.skeleton.regions.length) {
    header.push('REGIONS ' + p.skeleton.regions.map((r) => `${r.handle}=${r.role}(${Math.round(r.widthRatio * 100)}%w,${r.rect.w}x${r.rect.h})`).join(' '));
  }
  if (p.cssVars.length) {
    header.push('VARS ' + p.cssVars.map((v) => `${v.name}:${short(v.value)}`).join(' '));
  }
  if (p.scrollables.length) {
    header.push('SCROLLABLES ' + p.scrollables.map((s) => `${s.handle}=${s.axis}`).join(' '));
  }

  // Two-tier: top N by prominence get full detail; rest get compact one-liners.
  const byProminence = [...p.clusters].sort((a, b) => b.prominence - a.prominence);
  const tier1 = new Set(byProminence.slice(0, TIER1_FULL_DETAIL_COUNT).map((c) => c.handle));
  // Top-prominence clusters are never dropped (always keep the most important content).
  const topHandles = new Set(byProminence.slice(0, Math.min(5, byProminence.length)).map((c) => c.handle));

  // Build parent → children map for tree serialization.
  const childrenOf = new Map<string | null, Cluster[]>();
  for (const c of p.clusters) {
    const parent = c.layout.parentHandle;
    const arr = childrenOf.get(parent);
    if (arr) arr.push(c); else childrenOf.set(parent, [c]);
  }
  for (const arr of childrenOf.values()) arr.sort((a, b) => b.prominence - a.prominence);

  // Build entry list from the tree walk — structured so we can demote/drop on budget.
  interface Entry { cluster: Cluster; isFull: boolean; line: string; depth: number; dropped: boolean; }
  const entries: Entry[] = [];
  const walk = (handle: string | null, depth: number): void => {
    const children = childrenOf.get(handle);
    if (!children) return;
    for (const c of children) {
      const isFull = tier1.has(c.handle);
      entries.push({ cluster: c, isFull, line: isFull ? formatFull(c) : formatCompact(c), depth, dropped: false });
      walk(c.handle, depth + 1);
    }
  };
  walk(null, 0);

  const assemble = (): string => {
    const tree: string[] = ['TREE:'];
    for (const e of entries) {
      if (e.dropped) continue;
      tree.push('  '.repeat(Math.min(e.depth, 6)) + e.line);
    }
    return [...header, ...tree].join('\n');
  };

  let result = assemble();
  const before = result.length;
  lastSerializeBudget = { before, after: before };

  // Serialization budget: if over SERIALIZE_BUDGET, demote least-prominent full
  // entries to compact (formatFull→formatCompact shrinks the string), then drop
  // least-prominent compact entries (by prominence ascending). Top-prominence
  // clusters are always kept. YouTube 13.4K → ≤12K is the test case.
  if (before > SERIALIZE_BUDGET) {
    // Phase 1: demote full entries to compact (least-prominent first).
    const fullEntries = entries
      .filter((e) => e.isFull && !topHandles.has(e.cluster.handle))
      .sort((a, b) => a.cluster.prominence - b.cluster.prominence);
    for (const e of fullEntries) {
      if (result.length <= SERIALIZE_BUDGET) break;
      e.isFull = false;
      e.line = formatCompact(e.cluster);
      result = assemble();
    }
    // Phase 2: drop compact entries (least-prominent first).
    const compactEntries = entries
      .filter((e) => !e.isFull && !topHandles.has(e.cluster.handle))
      .sort((a, b) => a.cluster.prominence - b.cluster.prominence);
    for (const e of compactEntries) {
      if (result.length <= SERIALIZE_BUDGET) break;
      e.dropped = true;
      result = assemble();
    }
    lastSerializeBudget = { before, after: result.length };
  }

  return result;
}

function formatFull(c: Cluster): string {
  const L = c.layout;
  const parts = [
    `${c.handle} x${c.count} <${c.tag}>${c.role ? ' ' + c.role : ''}`,
    `${c.rect.w}x${c.rect.h} ${Math.round(L.widthRatio * 100)}%w`,
    `${L.display}${L.isContainer ? '/container' : ''}`,
    `bg:${short(c.style.background)}`, `text:${short(c.style.color)}`,
  ];
  if (c.style.border !== 'none') parts.push(`border:${short(c.style.border)}`);
  if (c.style.borderRadius !== '0px') parts.push(`r:${c.style.borderRadius}`);
  parts.push(`font:${c.style.fontFamily}/${c.style.fontSize}/${c.style.fontWeight}`);
  if (c.isNativeControl) parts.push('[native]');
  if (['img', 'picture', 'video', 'svg', 'figure'].includes(c.tag)) parts.push('[image]');
  if (L.isPassiveWrapper) parts.push('[passive]');
  if (L.isOpaqueWrapper) parts.push('[opaque]');
  let line = parts.join(' ');
  if (c.samples.length) line += ` e.g.${c.samples.slice(0, 2).map((s) => JSON.stringify(s.slice(0, 20))).join(',')}`;
  return line;
}

function formatCompact(c: Cluster): string {
  const parts = [
    `${c.handle} x${c.count} <${c.tag}>${c.role ? ' ' + c.role : ''}`,
    `${c.rect.w}x${c.rect.h} ${Math.round(c.layout.widthRatio * 100)}%w`,
  ];
  if (c.hasSolidBg) parts.push(`bg:${short(c.style.background)}`);
  if (['img', 'picture', 'video', 'svg', 'figure'].includes(c.tag)) parts.push('[image]');
  return parts.join(' ');
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
/** 4px buckets — merges 14px/15px buttons into the same cluster. */
function pxBucket4(v: string): string { const n = parseFloat(v); return isNaN(n) ? v : String(Math.floor(n / 4) * 4); }
/** 8-step per channel quantization for signature grouping (reported values stay exact). */
function colorBucket(colorStr: string): string {
  const c = parseColor(colorStr);
  if (!c) return colorStr;
  const q = (v: number) => Math.round(v / 32) * 32;
  return `${q(c[0])},${q(c[1])},${q(c[2])}`;
}
function round2(n: number): number { return Math.round(n * 100) / 100; }
function short(color: string): string { return color.replace(/\s+/g, ''); }
function hash(str: string): string {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36).padStart(6, '0').slice(-6);
}

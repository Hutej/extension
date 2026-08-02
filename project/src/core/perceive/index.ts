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

import { STYLE_ELEMENT_ID, SIDE_RAIL_MIN_FRAC, SIDE_RAIL_MAX_FRAC } from '../laws/index.ts';
import { formatPacks } from '../design/packs.ts';
import { isTransparent, parseColor, colorfulness } from '../../shared/color.ts';
import {
  classifyRole, rankDominance, detectGrouping, summarizeComposition,
  type ClusterSignals, type PageContext, type DesignRole, type CompositionSummary,
} from './semantic.ts';
import {
  buildOutline, buildColorModel, classifyComponentType, measureDensity, measureAlignmentEdges, analyzeText,
  type HeadingNode, type ColorModel, type ComponentType,
  type TextProfile, type DensityProfile,
} from './enrichment.ts';

const IGNORED_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'BR', 'HR', 'WBR', 'LINK', 'META', 'TEMPLATE', 'SLOT', 'PATH', 'DEFS']);
const ESCAPE_UI_ID = 'webmorph-escape-ui';

const MAX_TIME_MS = 6000;           // budget — no node cap, time is the only limit
const MAX_DEPTH = 30;               // safety net (not a truncation — 30 is very deep)
const CLUSTER_ATTR = 'data-wm-c';
const TIER1_FULL_DETAIL_COUNT = 80; // top clusters by prominence get full serialization
// Adaptive serialization budget (the budget is TIME, not chars). The fast path
// keeps FULL detail up to the soft ceiling; the compact/drop trim fires only when
// the serialized perception exceeds the HARD ceiling (a genuinely large page where
// the token cost would threaten the time budget). `the hard ceiling is a
// measured-size heuristic, not a precise model — a real serialize-time gate would
// be tighter, but the char ceiling is a stable proxy for the token/time cost and
// the role prompts are smaller than the old monolith, so the fast path keeps detail
// where it used to be trimmed.`
// B7: SERIALIZE_BUDGET_SOFT removed — unused (lint: no-unused-vars). The soft
// ceiling was superseded by the two-phase demote-then-drop approach below.
const SERIALIZE_BUDGET = 24000;        // hard ceiling — compact/drop tail beyond this

/** Last serialization budget stats — read by content.ts for the ledger. */
export let lastSerializeBudget = { before: 0, after: 0 };

// ── Types ──────────────────────────────────────────────────────────

export interface ClusterStyle {
  background: string; color: string; border: string; borderRadius: string;
  boxShadow: string; fontFamily: string; fontSize: string; fontWeight: string;
  padding: string; display: string;
  hasBgImage: boolean;   // own background-image is a url() — a CONTENT image (thumbnail). Gradients don't count.
  naturalAspect?: number; // intrinsic w÷h for img/video — the design model needs this to avoid distortion (the distortion root cause: today naturalWidth/Height is used only in verify/capture for screenshot decoding; the design step never sees it).
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
  siblingGapPx?: number;                 // gap to the next sibling (Phase 4: feeds the design-token spacing scale)
  // Phase 2.5 — Layout IR needs these authored-layout facts. Captured here (perception's job is
  // "computed styles") so the IR extraction stays pure (no DOM). Enrichment, not a rebuild.
  position: 'static' | 'relative' | 'absolute' | 'fixed' | 'sticky';
  flexWrap: boolean;                      // flex-wrap: wrap
  alignment: 'start' | 'center' | 'end' | 'stretch' | 'mixed';  // align-items + justify-content bucket
  widthSizing: 'auto' | 'fixed' | 'fluid';                       // how the cluster's width is authored
  centered: boolean;                                            // margin-inline: auto
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
  widthFractionOfParent: number;   // rect.w ÷ parent cluster rect.w at capture (1.0 if no parent cluster)
  /** 0..1 — painted area vs real text/media content. Near-empty for the
   *  empty-capsule / dead-band failures (a large box with little text and no
   *  image scores high). Drives the remove-op emptiness floor + the void gate. */
  emptinessScore: number;
  /** Structural move-safety for the op vocabulary. 'forbidden' = primary-content
   *  ancestors / scripts / the cluster itself being primary; 'risky' =
   *  event-heavy (inline on*), forms, live iframes, canvas/video; else 'safe'.
   *  Advisory for the model; compile's guard laws are the enforcement gate. */
  moveSafety: 'safe' | 'risky' | 'forbidden';
  /** DOM document-order index at capture. Cheap running counter; lets the
   *  model see source-vs-visual order divergence (a reorder opportunity). */
  sourceOrder: number;
  /** Phase 1 — the closed-vocabulary DESIGN role (page-title/article-body/nav-primary
   *  …) the cluster was deterministically classified into. The PRIMARY representation
   *  the model reasons over; the ARIA `role` above is a signal, not the contract. */
  designRole: DesignRole;
  /** Phase 1 — the classifier's confidence in the design role (0..1 = the winning
   *  score). Low confidence flags a cluster the human should check; the probe reports
   *  the low-confidence clusters per site for honest misclassification review. */
  designRoleConfidence: number;
  /** Phase 1 — per-region dominance rank (area × position × contrast weight, 0..1).
   *  A designer signal the old serialization omitted: which regions read as loud. */
  dominanceRank: number;
  /** Phase 1 — the sibling-group id this cluster belongs to (clusters that read as
   *  one unit — a row of cards, a stack of nav links). null if the cluster is not in a
   *  detected group. A designer signal the old serialization omitted: grouping. */
  group: string | null;
  /** C4 — the handle of the heading that governs this cluster's region, or null
   *  if no heading governs it. Gives the model document hierarchy and section
   *  boundaries (what is primary vs supporting, where a TOC comes from). */
  governingHeading: string | null;
  /** C7 — recognisable component type (card, list, table, form, hero, nav bar,
   *  side rail, etc.) beyond the 15 design roles. A card and a table are both
   *  "content" by role but need completely different treatment. */
  componentType: ComponentType;
  /** C7 — classifier confidence in the component type (0..1). */
  componentConfidence: number;
  /** C10 — text profile: reading length, kind (prose/label/heading/number/code),
   *  language direction, longest unbreakable token, DOM truncation state. */
  textProfile: TextProfile;
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
  /** Structural reflow opportunities detected from the skeleton (sidebar→top-bar,
   *  etc.). The Architect is REQUIRED to address each (an op OR a grid change) or
   *  verify's reflowSkipped gate fails the run. Pure structural detection — role +
   *  geometry, no domain logic. */
  reflowOpportunity: { kind: 'side-rail'; handle: string }[];
  /** Phase 1 — the page-level composition summary: the dominant regions, column
   *  count, top nav / rails, sibling-group count, and a one-line natural-language
   *  composition ("article-body is dominant + nav-primary(top); 2 columns, top nav
   *  band, right rail"). The model sees this UP FRONT, before any node. */
  composition: CompositionSummary;
  shadowRoots: ShadowRoot[];            // open shadow roots for downstream CSS injection
  /** B3: whether perception was truncated — a partial perception can ship a
   *  partial redesign as a success. Flag it so the caller can surface it. */
  truncated?: { walk: boolean; serialize: boolean };
  /** C4 — the document outline tree built from h1-h6 and ARIA headings. Gives
   *  the model document hierarchy, section boundaries, and what is primary vs
   *  supporting. The single highest-leverage addition either developer named. */
  outline: HeadingNode[];
  /** C6 — the page's colour model: palette in HSL with alpha, hue relationships
   *  (complementary/analogous/monochrome), saturation + lightness ranges, and
   *  surface geometry (radii, border widths, shadow, spacing rhythm). */
  colorModel: ColorModel;
  /** C8 — page-level density, rhythm, and alignment: modal sibling gap,
   *  repeating x-positions (alignment edges), and whitespace distribution. */
  density: DensityProfile;
}

export interface LayoutFingerprint {
  regions: { handle: string; x: number; y: number; w: number; h: number; paint: string }[];
  contentMaxWidthPx: number | null;
  columnCount: number;
  typeSizesPx: number[];
  overlapCount: number;
  bleedCount: number;
  scrollWidth: number;                  // for delta-overflow in verify (Phase 3)
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
  // B3: track whether the walk was truncated by the time/depth cap.
  let walkTruncated = false;

  const walk = (el: HTMLElement, depth: number): void => {
    if (performance.now() - t0 > MAX_TIME_MS || depth > MAX_DEPTH) { walkTruncated = true; return; }
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
    // Image natural aspect ratio — the intrinsic dimensions the design model needs
    // to avoid distortion. img only for now; video (videoWidth/Height) and
    // svg (viewBox) are rarer and can be added when a distortion case proves them needed.
    let naturalAspect: number | undefined;
    if (tag === 'IMG' && el instanceof HTMLImageElement && el.naturalWidth && el.naturalHeight) {
      naturalAspect = Math.round((el.naturalWidth / el.naturalHeight) * 100) / 100;
    }
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
          naturalAspect,
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
  const reflowOpportunity = detectReflowOpportunity(clusters);

  // Phase 1 — semantic enrichment: classify each cluster onto the closed design-role
  // vocabulary, rank dominance, detect sibling groups, and summarize the page
  // composition. ENRICHMENT, not a rewrite — geometry/tokens/detectors all stay; the
  // design role is ADDED to each cluster and the composition summary to the perception.
  // The representative element per cluster is read live (signals need the DOM); the
  // pure classifier lives in ./semantic.ts. Returns the ranked+positioned regions the
  // composition summary needs (real rect x/y, not the cluster's w/h-only rect).
  const ranked = enrichSemantic(clusters, { w: vpW, h: window.innerHeight || 800 });
  const composition = summarizeComposition(
    ranked,
    skeleton.columnCount,
    new Set(clusters.map((c) => c.group).filter(Boolean)).size,
    { w: vpW, h: window.innerHeight || 800 },
  );

  // C4-C10 — perception enrichment: heading outline, component types, text
  // profiles, colour model, density/rhythm/alignment. Each is additive — it
  // enriches the existing Cluster / Perception without changing what's emitted
  // today. The model was handed "two floors, white walls, blue door" and blamed
  // for the design; these give it the information it needs to see the page.

  // C4 — build the document outline tree from h1-h6 and ARIA headings.
  const outlineResult = buildOutline();
  // Attach governing heading to each cluster: the nearest preceding heading in
  // source order. A heading governs itself. Gives the model document hierarchy
  // and section boundaries (what is primary vs supporting).
  let currentHeading: string | null = null;
  for (const c of [...clusters].sort((a, b) => a.sourceOrder - b.sourceOrder)) {
    if (/^h[1-6]$/.test(c.tag) || c.role === 'heading') {
      currentHeading = c.handle;
      c.governingHeading = c.handle;
    } else {
      c.governingHeading = currentHeading;
    }
  }

  // C7 — classify each cluster into a recognisable component type.
  // C10 — analyze each cluster's text profile (reading length, kind, direction,
  // longest unbreakable token, DOM truncation).
  for (const c of clusters) {
    const el = representativeFor(c);
    const comp = classifyComponentType(c, el);
    c.componentType = comp.type;
    c.componentConfidence = comp.confidence;
    c.textProfile = analyzeText(c, el);
  }

  // C6 — build the colour model (palette in HSL, hue relationships, geometry).
  const colorModel = buildColorModel({ clusters });

  // C8 — measure density, rhythm, and alignment. These are INPUTS to the
  // designer, not gates — the pixel verifier must never judge them after the fact.
  const alignmentEdges = measureAlignmentEdges(clusters, vpW);
  const density = measureDensity(clusters, { w: vpW, h: window.innerHeight || 800 });
  density.alignmentEdges = alignmentEdges;

  return {
    builtInMs: Math.round(performance.now() - t0),
    nodeCount: visited,
    site: { host: location.hostname, title: (document.title || '').slice(0, 80) },
    canvas, cssVars, cssVarMap, clusters, skeleton,
    handles: new Set(clusters.map((c) => c.handle)),
    opaqueWrappers: new Set(clusters.filter((c) => c.layout.isOpaqueWrapper).map((c) => c.handle)),
    scrollables,
    viewport: { w: vpW, h: window.innerHeight || 800 },
    reflowOpportunity,
    composition,
    shadowRoots,
    // C4-C10: the new perception fields.
    outline: outlineResult.tree,
    colorModel,
    density,
    // B3: flag truncation so a partial redesign can't silently ship as success.
    truncated: { walk: walkTruncated, serialize: false },
  };
}

/** Detect structural reflow opportunities (sidebar→top-bar etc.). A SIDE RAIL is a
 *  region with role navigation/complementary/banner (or tag aside/nav) whose
 *  widthRatio is in [SIDE_RAIL_MIN_FRAC, SIDE_RAIL_MAX_FRAC] AND that has a
 *  main/article sibling in the skeleton. Pure structural — no domain logic, no
 *  aesthetic lookup. The Architect is required to address each (op or grid change)
 *  or verify's reflowSkipped gate fails the run. */
function detectReflowOpportunity(clusters: Cluster[]): { kind: 'side-rail'; handle: string }[] {
  const out: { kind: 'side-rail'; handle: string }[] = [];
  const hasMain = clusters.some((c) => c.role === 'main' || c.role === 'article' || c.tag === 'main' || c.tag === 'article');
  if (!hasMain) return out;       // no main content → no side-rail relationship
  const seen = new Set<string>();
  for (const c of clusters) {
    if (seen.has(c.handle)) continue;
    const isRailRole = c.role === 'navigation' || c.role === 'complementary' || c.role === 'banner' || c.tag === 'aside' || c.tag === 'nav';
    if (!isRailRole) continue;
    const frac = c.layout.widthRatio;
    if (frac < SIDE_RAIL_MIN_FRAC || frac > SIDE_RAIL_MAX_FRAC) continue;
    seen.add(c.handle);
    out.push({ kind: 'side-rail', handle: c.handle });
  }
  return out;
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
    const el = deepQuerySelector<HTMLElement>(cl.selector);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 100 || r.height < 100) continue;       // skip tiny overflow clips
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

// P5.1 + S3.5 — structural identity. The handle is derived from DOM STRUCTURE, not
// appearance: tag + nth-of-type chain, with stable attributes (id, data-testid,
// role, aria-label, name) short-circuiting the climb. FORBIDDEN as identity inputs:
// geometry, rects, widths, position, colours, the visual-signature hash, the
// semantic role. The visual signature is STILL used for CLUSTERING (grouping
// visually similar elements); the handle is the cluster's STRUCTURAL identity.
//
// S3.5: Anchor at the NEAREST element (self or ancestor) carrying a stable
// attribute. Only use nth-of-type in the chain BELOW the anchor. Long nth-of-type
// chains are fragile to sibling insertion by construction — a new <div> before an
// existing one shifts every subsequent sibling's nth-of-type. Anchoring at a
// stable attribute makes the chain immune to insertions ABOVE the anchor (the
// anchor's id/role/etc doesn't change under sibling reordering), so only the
// specific sub-chain below the insertion point is affected. This improves
// mutation identity without touching the format ('c' + 6-char hash).
function structuralPath(el: HTMLElement): string {
  // Find the nearest stable anchor (self or ancestor, excluding body/html).
  let anchor: HTMLElement | null = null;
  let n: HTMLElement | null = el;
  let searchDepth = 0;
  while (n && n !== document.body && n !== document.documentElement && searchDepth < 20) {
    if (n.id || n.getAttribute('data-testid') || n.getAttribute('role') ||
        n.getAttribute('aria-label') || n.getAttribute('name')) {
      anchor = n;
      break;
    }
    n = n.parentElement;
    searchDepth++;
  }

  // Build the path: anchor identifier + nth-of-type chain from anchor down to el.
  const parts: string[] = [];
  if (anchor) {
    const tag = anchor.tagName.toLowerCase();
    if (anchor.id) parts.push(`${tag}#${anchor.id}`);
    else if (anchor.getAttribute('data-testid')) parts.push(`${tag}[t=${anchor.getAttribute('data-testid')}]`);
    else if (anchor.getAttribute('role')) parts.push(`${tag}[r=${anchor.getAttribute('role')}]`);
    else if (anchor.getAttribute('aria-label')) parts.push(`${tag}[a=${anchor.getAttribute('aria-label')!.slice(0, 20)}]`);
    else if (anchor.getAttribute('name')) parts.push(`${tag}[n=${anchor.getAttribute('name')}]`);
  } else {
    parts.push('body');
  }

  // nth-of-type chain from el UP to (but not including) the anchor, then reverse
  // so the path reads anchor → ... → el (top to bottom, consistent with the old format).
  const chain: string[] = [];
  let node: HTMLElement | null = el;
  let d = 0;
  while (node && node !== anchor && d < 10) {
    const tag = node.tagName.toLowerCase();
    let cnt = 0;
    let sib = node.previousElementSibling;
    while (sib) { if (sib.tagName === node.tagName) cnt++; sib = sib.previousElementSibling as Element | null; }
    chain.push(`${tag}:${cnt + 1}`);
    node = node.parentElement;
    d++;
  }
  chain.reverse();
  return [...parts, ...chain].join('/');
}

// P5.2 — sticky roles. Classify ONCE per handle per session; cache the result
// against the stable handle and REUSE it on every subsequent perception. Re-
// classification is permitted ONLY when the node's own structural signature
// changes (which means a new handle → cache miss → fresh classification). The
// cache is session-scoped and cleared on navigation. Stored on globalThis so
// it persists across the probe's `new Function(src)()` re-executions.
const ROLE_CACHE_KEY = '__wmRoleCache';
interface RoleCacheEntry { role: DesignRole; confidence: number; }
function getRoleCache(): Map<string, RoleCacheEntry> {
  const w = globalThis as unknown as { [ROLE_CACHE_KEY]?: Map<string, RoleCacheEntry> };
  if (!w[ROLE_CACHE_KEY]) w[ROLE_CACHE_KEY] = new Map();
  return w[ROLE_CACHE_KEY]!;
}
export function clearRoleCache(): void {
  const w = globalThis as unknown as { [ROLE_CACHE_KEY]?: Map<string, RoleCacheEntry> };
  w[ROLE_CACHE_KEY] = new Map();
}

function clusterAndStamp(candidates: Candidate[], vpArea: number, vpW: number): Cluster[] {
  const groups = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const sig = signature(c);
    const arr = groups.get(sig);
    if (arr) arr.push(c); else groups.set(sig, [c]);
  }

  interface Raw extends Cluster { _members: Candidate[]; }
  const raws: Raw[] = [];
  const usedHandles = new Set<string>();
  for (const [_sig, members] of groups) {
    const rep = members[0];
    const cappedArea = members.reduce((s, m) => s + Math.min(m.area, vpArea), 0);
    const prominence = cappedArea / vpArea + members.length;
    // P5.1: handle derived from STRUCTURE (the representative's DOM path), not
    // the visual signature. The visual signature (sig) is still the grouping key.
    // P5.1 fix: collision resolution — if two structural paths hash to the same
    // 6-char value, append a deterministic counter salt to guarantee uniqueness.
    const sp = structuralPath(rep.el);
    let handle = 'c' + hash(sp);
    let salt = 0;
    while (usedHandles.has(handle)) { salt++; handle = 'c' + hash(sp + '#' + salt); }
    usedHandles.add(handle);
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
      layout: placeholderLayout(rep, vpW), prominence, widthFractionOfParent: 1,
      emptinessScore: 0, moveSafety: 'safe', sourceOrder: 0, _members: members,
      // Phase 1 design-role fields — set by enrichSemantic after stamping (needs the
      // live representative's signals). Defaults until then.
      designRole: 'ad-or-void', designRoleConfidence: 0, dominanceRank: 0, group: null,
      // C4/C7/C10 — set by enrichPerception after stamping. Defaults until then.
      governingHeading: null, componentType: 'unknown', componentConfidence: 0,
      textProfile: { readingLength: 0, kind: 'none', dir: 'auto', longestToken: 0, truncated: false },
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

  // Structural enrichment for the op vocabulary: emptiness + move-safety +
  // source order. Computed after stamping (moveSafety walks ancestors for
  // primary-content). One pass; O(clusters × depth), depth-bounded by the tree.
  let order = 0;
  for (const r of kept) {
    enrichSafety(r, r._members[0]);
    r.sourceOrder = order++;
  }

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
    // Phase 2.5 — defaults; enrichLayout fills the real values from computed style.
    position: 'static',
    flexWrap: false,
    alignment: 'start',
    widthSizing: 'auto',
    centered: false,
  };
}

function enrichLayout(cluster: Cluster, rep: Candidate, _vpW: number): void {
  const cs = getComputedStyle(rep.el);   // Phase 2.5 — one computed-style read for the layout facts
  let owner: HTMLElement | null = null;
  let p = rep.el.parentElement;
  while (p && p !== document.body && p !== document.documentElement) {
    const d = getComputedStyle(p).display;
    if (d.includes('flex') || d.includes('grid')) { owner = p; break; }
    p = p.parentElement;
  }
  cluster.layout.ownedByFlexGrid = owner != null;
  cluster.layout.constraintOwnerHandle = owner?.getAttribute(CLUSTER_ATTR) || null;
  // Phase 2.5 — authored-layout facts the IR needs (perception captures computed styles; the IR
  // projection stays pure). Bucketed/coarsened so they're stable across near-identical renders.
  cluster.layout.position = (['absolute', 'fixed', 'sticky', 'relative'].includes(cs.position)
    ? cs.position as ClusterLayout['position'] : 'static');
  cluster.layout.flexWrap = cs.flexWrap === 'wrap' || cs.flexWrap === 'wrap-reverse';
  const alignBucket = (v: string): 'start' | 'center' | 'end' | 'stretch' => {
    if (v === 'center' || v === 'stretch' || v === 'flex-end' || v === 'end') return v === 'flex-end' ? 'end' : v as 'center' | 'stretch';
    if (v === 'flex-start' || v === 'start') return 'start';
    return 'start';
  };
  const ai = alignBucket(cs.alignItems);
  const jc = alignBucket(cs.justifyContent);
  cluster.layout.alignment = ai === jc ? ai : 'mixed';
  // widthSizing: auto vs a fixed px vs a fluid (%/clamp/calc) authored width.
  const w = cs.width;
  if (w === 'auto') cluster.layout.widthSizing = 'auto';
  else if (/px$/.test(w)) cluster.layout.widthSizing = 'fixed';
  else if (/%|clamp|calc|min|max|vw|em|rem/.test(w)) cluster.layout.widthSizing = 'fluid';
  else cluster.layout.widthSizing = 'auto';
  cluster.layout.centered = cs.marginLeft === 'auto' && cs.marginRight === 'auto';
  let parentClusterEl: HTMLElement | null = null;
  let a = rep.el.parentElement;
  while (a) {
    const h = a.getAttribute(CLUSTER_ATTR);
    if (h && h !== cluster.handle) { cluster.layout.parentHandle = h; parentClusterEl = a; break; }
    a = a.parentElement;
  }
  // widthFractionOfParent: the cluster's rect width ÷ its parent cluster's rect
  // width at capture time. Used by compile to convert a fixed-px width to a
  // zoom-proof percentage of the parent (and to floor wide children so they can't
  // shrink into a dead-margin band). No parent cluster -> 1.0 (relative to viewport).
  if (parentClusterEl) {
    const pw = parentClusterEl.getBoundingClientRect().width;
    cluster.widthFractionOfParent = pw > 0 ? Math.min(1, cluster.rect.w / pw) : 1;
  } else {
    cluster.widthFractionOfParent = 1;
  }
  // Sibling gap: the vertical space between this element and the next visible
  // sibling. Feeds the design-token spacing scale (Phase 3's spacingScale, now
  // populated here). vertical gap only — the common case (stacked
  // siblings); horizontal gaps in row flows can be added when a density case
  // proves them needed.
  const thisRect = rep.el.getBoundingClientRect();
  let next: Element | null = rep.el.nextElementSibling;
  while (next && (!(next instanceof HTMLElement) || next.getBoundingClientRect().height <= 1)) next = next.nextElementSibling;
  if (next instanceof HTMLElement) {
    const gap = Math.round(next.getBoundingClientRect().top - thisRect.bottom);
    if (gap >= 0) cluster.layout.siblingGapPx = gap;
  }
}

/** Emptiness: how much of the cluster's painted area is real text/media vs dead
 *  space. A large box with short text and no background image scores near 1
 *  (the empty-capsule / dead-band failures). Pure-ish: reads rect + samples +
 *  hasBgImage — no per-pixel scan. 0 = content-dense, 1 = empty. */
const EMPTINESS_TEXT_CHARS_PER_KPX = 8; // ~8 chars/kpx² of box = "has real content"; a coarse content-density heuristic, recalibrate from the grid.

function computeEmptiness(cluster: Cluster): number {
  const areaKpx = (cluster.rect.w * cluster.rect.h) / 1000;
  if (areaKpx <= 0) return 0;
  // Aggregate text length across members (samples is capped at 3; use the
  // cluster's count × a per-member estimate from the samples).
  const sampleLen = cluster.samples.reduce((s, t) => s + t.length, 0);
  const textLen = sampleLen * Math.max(1, cluster.count);
  const hasImage = cluster.style.hasBgImage;
  // Image-bearing clusters are content, not voids.
  if (hasImage) return 0;
  // Tiny clusters aren't "empty" — they're just small.
  if (areaKpx < 20) return 0;
  // Content-density: chars per kpx². Below the threshold = sparse → high emptiness.
  const density = textLen / areaKpx;
  // Map density → emptiness (inverse, floored at 0, ceiling 1).
  // a linear inverse is a coarse heuristic — the void detector +
  // pixel scan are the real gate; this is the model's advisory score.
  return Math.max(0, Math.min(1, 1 - density / EMPTINESS_TEXT_CHARS_PER_KPX));
}

/** Move-safety for the op vocabulary. forbidden = the cluster itself is
 *  primary content OR an ancestor is primary (moving it would orphan the page's
 *  main content) OR it's a script. risky = event-heavy (inline on*), forms,
 *  live iframes, canvas/video. safe = anything else. Advisory for the model;
 *  compile's guard laws are the enforcement gate. */
function enrichSafety(cluster: Cluster, rep: Candidate): void {
  cluster.emptinessScore = computeEmptiness(cluster);
  const tag = rep.tag;
  const role = cluster.role;
  // The cluster itself is primary content → forbidden to move/remove.
  if (role === 'main' || role === 'article') { cluster.moveSafety = 'forbidden'; return; }
  if (tag === 'script' || tag === 'style') { cluster.moveSafety = 'forbidden'; return; }
  // Live media / interactive surfaces → risky (move only with consent).
  if (tag === 'video' || tag === 'canvas' || tag === 'iframe' || tag === 'embed') { cluster.moveSafety = 'risky'; return; }
  if (role === 'form' || tag === 'form' || tag === 'input' || tag === 'select' || tag === 'textarea') { cluster.moveSafety = 'risky'; return; }
  // Inline event handlers → risky (behavior is bound to this node).
  if (rep.el.hasAttribute && (rep.el.hasAttribute('onclick') || rep.el.hasAttribute('onmousedown') || rep.el.hasAttribute('onload'))) {
    cluster.moveSafety = 'risky'; return;
  }
  // An ancestor is primary content → moving this node could orphan it. Walk
  // ancestors (capped) for a main/article ancestor.
  let p: Element | null = rep.el.parentElement;
  let depth = 0;
  while (p && depth < 12) {
    const r = p.getAttribute('role') || p.tagName.toLowerCase();
    if (r === 'main' || r === 'article') { cluster.moveSafety = 'forbidden'; return; }
    p = p.parentElement;
    depth++;
  }
  cluster.moveSafety = 'safe';
}

// ── Phase 1 — semantic enrichment (design role + dominance + grouping) ───

/** The design-role classifier needs a representative element per cluster to read
 *  the signals (text length, link count, heading level, position, class tokens).
 *  One representative per handle (the first stamped member). The signals are
 *  generic and site-agnostic; the pure classifier lives in ./semantic.ts. */
function representativeFor(cluster: Cluster): HTMLElement | null {
  // C9: deepQuerySelector traverses shadow boundaries — composed-tree elements
  // were lost between the walk (which enters shadow roots) and the read-back
  // (which used plain querySelector).
  return deepQuerySelector<HTMLElement>(cluster.selector);
}

/** Gather the deterministic, generic signals for one cluster from its live
 *  representative. Zero site-specific rules — the class/id tokens (nav/search/
 *  comment/footer…) are universal conventions, not site recipes; geometric + text
 *  signals are the fallback when tokens don't match. */
function gatherSignals(cluster: Cluster, el: HTMLElement, _viewport: { w: number; h: number }): ClusterSignals {
  const rect = el.getBoundingClientRect();
  const textLen = (el.textContent || '').replace(/\s+/g, ' ').trim().length;
  const linkCount = el.querySelectorAll('a[href]').length;
  // Heading level: the cluster's own tag if it's a heading, else the deepest heading inside.
  let headingLevel: number | null = null;
  const tag = el.tagName.toLowerCase();
  const hMatch = tag.match(/^h([1-6])$/);
  if (hMatch) headingLevel = parseInt(hMatch[1], 10);
  const innerHeadings = el.querySelectorAll('h1, h2, h3, h4, h5, h6');
  const hasHeading = innerHeadings.length > 0 || headingLevel != null;
  if (headingLevel == null && innerHeadings.length) {
    // The shallowest heading inside = the cluster's effective level.
    let shallowest = 6;
    for (const h of Array.from(innerHeadings)) {
      const m = h.tagName.toLowerCase().match(/^h([1-6])$/);
      if (m) shallowest = Math.min(shallowest, parseInt(m[1], 10));
    }
    headingLevel = shallowest;
  }
  const cs = getComputedStyle(el);
  const classTokens = ((el.id || '') + ' ' + (typeof el.className === 'string' ? el.className : '')).toLowerCase();
  const fontSize = parseFloat(cs.fontSize) || 16;
  // Phase 2 / 1.6B — codeHint: the cluster IS or CONTAINS a code block. Universal
  // convention tokens (code/syntax/highlight/brush/example), monospace computed
  // font-family, and syntax-highlight token density (Prism/highlight.js child spans
  // with token/hljs/syntax classes). Principled signals only — no site names.
  const isMonospace = /mono/i.test(cs.fontFamily) && tag !== 'input' && tag !== 'textarea' && tag !== 'button';
  const syntaxTokenCount = el.querySelectorAll('[class*="token-"], [class*="hljs-"], [class*="syntax-"], [class*="hljs-"]').length;
  const codeHint = tag === 'pre' || tag === 'code' ||
    /\b(pre|code|syntax|highlight|brush|example)\b/.test(classTokens) ||
    el.querySelector('pre, code, .syntaxhighlight, [class*="highlight"], [class*="code"]') != null ||
    isMonospace ||
    syntaxTokenCount >= 3;
  // Phase 2 — inArticleFlow: the cluster sits inside a main/article region. A
  // text-less+image-less block with real height in article flow is content, not
  // a void (the MDN code-example trap).
  let inArticleFlow = false;
  let p: Element | null = el.parentElement;
  let hops = 0;
  while (p && hops < 16) {
    const r = p.getAttribute('role') || p.tagName.toLowerCase();
    if (r === 'article' || r === 'main') { inArticleFlow = true; break; }
    p = p.parentElement;
    hops++;
  }
  // X2 — tocHint: a table-of-contents. Principled detection: a nav/aside/ol/ul
  // landmark whose links are predominantly same-page fragment anchors (href^="#")
  // pointing at headings in the main content, positioned OUTSIDE main flow.
  // No site names, no selectors — universal structural signature.
  const tocHint = !inArticleFlow && detectToc(el);
  return {
    ariaRole: cluster.role,
    tag,
    textLen,
    linkCount,
    headingLevel,
    hasHeading,
    rectX: rect.x, rectY: rect.y, rectW: rect.width, rectH: rect.height,
    widthRatio: cluster.layout.widthRatio,
    widthFractionOfParent: cluster.widthFractionOfParent,
    normWidthFromParent: cluster.widthFractionOfParent < 1,
    count: cluster.count,
    classTokens,
    emptinessScore: cluster.emptinessScore,
    hasBgImage: cluster.style.hasBgImage,
    fontSize,
    isNativeControl: cluster.isNativeControl,
    hasSolidBg: cluster.hasSolidBg,
    codeHint,
    inArticleFlow,
    tocHint,
  };
}

/** X2 — detect a table-of-contents. Principled, no site names: a nav/aside/ol/ul
 *  landmark whose links are predominantly same-page fragment anchors (href^="#")
 *  pointing at headings (h1-h6 or [id] targets) in the main content. Returns true
 *  only when the structural signature is strong. */
function detectToc(el: HTMLElement): boolean {
  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute('role');
  const isTocLandmark = tag === 'nav' || tag === 'aside' || tag === 'ol' || tag === 'ul' ||
    role === 'navigation' || role === 'complementary' || role === 'list';
  if (!isTocLandmark) return false;
  const links = Array.from(el.querySelectorAll('a[href]'));
  if (links.length < 3) return false;       // a TOC has multiple entries
  // Fragment anchors: href starts with "#"
  const fragLinks = links.filter((a) => (a.getAttribute('href') || '').startsWith('#'));
  if (fragLinks.length / links.length < 0.6) return false;  // predominantly fragment links
  // The anchors must point at real targets (ids) in the document — heading-adjacent
  const targets = fragLinks.map((a) => a.getAttribute('href')!.slice(1)).filter(Boolean);
  let found = 0;
  for (const id of targets) {
    const target = document.getElementById(id);
    if (!target) continue;
    // The target is a heading or near a heading (the TOC entry's destination)
    if (/^h[1-6]$/.test(target.tagName.toLowerCase())) { found++; continue; }
    const near = target.querySelector('h1, h2, h3, h4, h5, h6');
    if (near) { found++; continue; }
    // An id on any element counts — it's a valid anchor target
    found++;
  }
  return found / targets.length >= 0.5;
}

/** Phase 1 enrichment: for each cluster, gather signals, classify onto the closed
 *  design-role vocabulary, rank dominance, and assign a sibling-group id. Mutates the
 *  clusters in place (sets designRole/designRoleConfidence/dominanceRank/group).
 *  Returns the ranked+positioned regions the composition summary needs. */
function enrichSemantic(clusters: Cluster[], viewport: { w: number; h: number }): { handle: string; role: DesignRole; rank: number; rectX: number; rectY: number; widthRatio: number }[] {
  const ctx: PageContext = { viewport };
  const ranked: { handle: string; role: DesignRole; rank: number; rectX: number; rectY: number; widthRatio: number }[] = [];
  for (const cluster of clusters) {
    const el = representativeFor(cluster);
    // 1.6B: a vanished representative that was pre/code at stamping time is content
    // (article-body), not a void — the MDN code-example trap. The stamping-time tag
    // is the only signal left; use it rather than defaulting everything to ad-or-void/0.
    if (!el) {
      if (cluster.tag === 'pre' || cluster.tag === 'code') {
        cluster.designRole = 'article-body';
        cluster.designRoleConfidence = 0.5;
      } else {
        cluster.designRole = 'ad-or-void';
        cluster.designRoleConfidence = 0;
      }
      cluster.dominanceRank = 0;
      cluster.group = null;
      continue;
    }
    const signals = gatherSignals(cluster, el, viewport);
    // P5.2 — sticky roles: classify ONCE per handle per session, cache, reuse.
    // The handle is structural (P5.1), so a cache hit means the node's structural
    // position hasn't changed → the role should not change. A cache miss means
    // the structural position changed (new handle) or it's a new node → classify
    // fresh and cache. Do NOT touch any classifier threshold — we are removing
    // the repeated dice roll, not changing the dice.
    const cache = getRoleCache();
    const cached = cache.get(cluster.handle);
    if (cached) {
      cluster.designRole = cached.role;
      cluster.designRoleConfidence = cached.confidence;
    } else {
      const cls = classifyRole(signals, ctx);
      cluster.designRole = cls.role;
      cluster.designRoleConfidence = cls.confidence;
      cache.set(cluster.handle, { role: cls.role, confidence: cls.confidence });
    }
    const cs = getComputedStyle(el);
    cluster.dominanceRank = rankDominance({
      rectX: signals.rectX, rectY: signals.rectY, rectW: signals.rectW, rectH: signals.rectH,
      widthRatio: cluster.layout.widthRatio,
      hasSolidBg: cluster.hasSolidBg,
      hasBorder: cluster.style.border !== 'none',
      hasShadow: cs.boxShadow !== 'none',
      fontSize: signals.fontSize,
      isColorful: colorfulness(parseColor(cluster.style.background) ?? [0, 0, 0, 0]) > 0.1,
    }, viewport);
    ranked.push({ handle: cluster.handle, role: cluster.designRole, rank: cluster.dominanceRank, rectX: signals.rectX, rectY: signals.rectY, widthRatio: cluster.layout.widthRatio });
  }
  // Sibling grouping — clusters that read as one unit (a row of cards, a stack of
  // nav links). detectGrouping is pure; feed it the stamped positions + parentage.
  const groupMap = detectGrouping(clusters.map((c) => {
    const el = representativeFor(c);
    const r = el ? el.getBoundingClientRect() : new DOMRect();
    return { handle: c.handle, parentHandle: c.layout.parentHandle, rectX: r.x, rectY: r.y, rectW: r.width, rectH: r.height };
  }));
  for (const c of clusters) c.group = groupMap.get(c.handle) ?? null;
  return ranked;
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
      const el = deepQuerySelector<HTMLElement>(c.selector);
      if (el) cols.add(Math.round(el.getBoundingClientRect().x / 40));
    }
  }
  // Content width from cluster data — O(clusters), no O(n²) DOM scan.
  const contentMaxWidthPx = findContentWidthFromClusters(clusters, vpW);
  return { regions, contentMaxWidthPx, columnCount: Math.max(1, cols.size) };
}

function findContentWidthFromClusters(clusters: Cluster[], _vpW: number): number | null {
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
  const allEls = deepQuerySelectorAll(`[${CLUSTER_ATTR}]`);
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
  for (const el of deepQuerySelectorAll(`[${CLUSTER_ATTR}]`)) {
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
  for (const el of deepQuerySelectorAll(`[${CLUSTER_ATTR}]`)) {
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
    for (const el of deepQuerySelectorAll(`[${CLUSTER_ATTR}]`)) {
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
  for (const el of deepQuerySelectorAll(`[${CLUSTER_ATTR}]`)) {
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
  for (const el of deepQuerySelectorAll(`[${CLUSTER_ATTR}]`)) {
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
  for (const el of deepQuerySelectorAll(`[${CLUSTER_ATTR}]`)) {
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
  for (const el of deepQuerySelectorAll(`[${CLUSTER_ATTR}]`)) {
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
  deepQuerySelectorAll(`[${CLUSTER_ATTR}]`).forEach((el) => el.removeAttribute(CLUSTER_ATTR));
}

/** C9 — deep querySelector that traverses shadow boundaries. Perception walks
 *  into shadow roots but the read-back (representativeFor, findScrollables,
 *  captureLayoutFingerprint) used plain querySelector, so composed-tree elements
 *  were lost between the two. Every site built this decade has shadow content. */
export function deepQuerySelector<T extends Element = HTMLElement>(selector: string): T | null {
  // Try the light DOM first (the common case).
  const el = document.querySelector<T>(selector);
  if (el) return el;
  // Traverse shadow roots for composed-tree elements.
  const walk = (root: Element | ShadowRoot | Document): T | null => {
    for (const child of Array.from(root.querySelectorAll('*'))) {
      if (child.matches?.(selector)) return child as T;
      if (child instanceof HTMLElement && child.shadowRoot) {
        const found = walk(child.shadowRoot);
        if (found) return found;
      }
    }
    return null;
  };
  return walk(document);
}

/** C9 — deep querySelectorAll that traverses shadow boundaries. */
export function deepQuerySelectorAll<T extends Element = HTMLElement>(selector: string): T[] {
  const results: T[] = [];
  const seen = new Set<Element>();
  // Light DOM
  for (const el of Array.from(document.querySelectorAll<T>(selector))) {
    results.push(el); seen.add(el);
  }
  // Shadow DOM
  const walk = (root: Element | ShadowRoot | Document): void => {
    for (const child of Array.from(root.querySelectorAll('*'))) {
      if (child.matches?.(selector) && !seen.has(child)) { results.push(child as T); seen.add(child); }
      if (child instanceof HTMLElement && child.shadowRoot) walk(child.shadowRoot);
    }
  };
  walk(document);
  return results;
}

/**
 * S3.4 — Perception settle condition. Replaces the fixed settleMs stopwatch
 * with a MutationObserver-based quiet window: proceed when no layout-affecting
 * mutations (childList, style/class attribute changes) fire for `quietMs`. The
 * existing `maxMs` is the hard ceiling (the old MAX_TIME_MS, kept as a safety
 * net). Returns whether the page truly settled (true) or the timeout kicked in
 * (false), plus the actual wait time. The MDN 96→77→95 node-count variance was
 * a timing artifact — with the sticky cache, a half-loaded page can seed the
 * cache and hold all session; the settle condition prevents that.
 */
export async function waitForSettle(quietMs = 500, maxMs = 6000): Promise<{ settled: boolean; waitMs: number }> {
  const t0 = performance.now();
  let lastMutation = t0;
  return new Promise((resolve) => {
    const observer = new MutationObserver((): void => { lastMutation = performance.now(); });
    observer.observe(document.body, {
      childList: true, subtree: true,
      attributes: true, attributeFilter: ['style', 'class'],
    });
    const check = (): void => {
      const now = performance.now();
      if (now - lastMutation >= quietMs || now - t0 >= maxMs) {
        observer.disconnect();
        resolve({ settled: now - lastMutation >= quietMs, waitMs: Math.round(now - t0) });
      } else {
        setTimeout(check, 100);
      }
    };
    setTimeout(check, quietMs);
  });
}

// ── Serialize for the AI — hierarchical tree, two-tier detail ───────

// ── Design tokens (Phase 3: deterministic scale extraction) ──────────

export interface DesignTokens {
  typeScale: { px: number; role: string }[];
  palette: { dominantBg: string; accents: string[]; textColors: string[] };
  // spacingScale — distinct sibling gaps quantized to 8px (the design
  // 8pt grid). Phase 4 populates this from cluster.layout.siblingGapPx.
  spacingScale: number[];
}

/** Extract a compact design-token summary from the perception — the page's type
 *  scale (px → role), palette (dominant bg, accent candidates, text colors), and
 *  spacing scale. Pure: takes Perception as data, no DOM access. Feeds a compact
 *  DESIGN TOKENS block into the design prompt so the model works with the page's
 *  actual systematic scale (not per-cluster ad hoc values), constraining the
 *  choice-space (a quality guard) and trimming redundant per-cluster font strings
 *  (a token/speed win). */
export function extractDesignTokens(p: Perception): DesignTokens {
  // Type scale: collect fontSize values, classify by frequency + size.
  const fontSizes = new Map<number, number>();
  for (const c of p.clusters) {
    const px = parseFloat(c.style.fontSize);
    if (!isNaN(px) && px > 0) fontSizes.set(px, (fontSizes.get(px) ?? 0) + 1);
  }
  const sortedSizes = [...fontSizes.entries()].sort((a, b) => a[0] - b[0]);
  const bodyPx = sortedSizes.length ? sortedSizes.reduce((a, b) => a[1] >= b[1] ? a : b)[0] : 16;
  const typeScale = sortedSizes.map(([px]) => ({
    px,
    role: px < bodyPx - 1 ? 'small' : px <= bodyPx + 1 ? 'body' : px < bodyPx * 1.5 ? 'heading' : 'display',
  }));

  // Palette: dominant bg (canvas), accent candidates (colorful solid-bg clusters),
  // text colors. Reuses the shared colorfulness + parseColor (one color parser).
  const dominantBg = short(p.canvas.bg);
  const textColors = new Set<string>();
  for (const c of p.clusters) if (c.style.color) textColors.add(short(c.style.color));
  const accents = p.clusters
    .filter((c) => c.hasSolidBg)
    .map((c) => ({ color: short(c.style.background), parsed: parseColor(c.style.background) }))
    .filter((c) => c.parsed && c.color !== dominantBg && colorfulness(c.parsed) > 0.1)
    .sort((a, b) => colorfulness(b.parsed!) - colorfulness(a.parsed!))
    .slice(0, 5)
    .map((c) => c.color);

  // Spacing scale: distinct sibling gaps quantized to 8px (the design 8pt grid).
  const gapSet = new Set<number>();
  for (const c of p.clusters) {
    if (c.layout.siblingGapPx != null && c.layout.siblingGapPx > 0) {
      gapSet.add(Math.round(c.layout.siblingGapPx / 8) * 8);
    }
  }
  const spacingScale = [...gapSet].sort((a, b) => a - b).slice(0, 6);

  return { typeScale, palette: { dominantBg, accents, textColors: [...textColors].slice(0, 5) }, spacingScale };
}

function formatDesignTokens(tokens: DesignTokens): string {
  const lines: string[] = ['DESIGN TOKENS:'];
  if (tokens.typeScale.length) lines.push('  type: ' + tokens.typeScale.map((t) => `${t.px}px=${t.role}`).join(', '));
  lines.push(`  canvas: ${tokens.palette.dominantBg}`);
  if (tokens.palette.accents.length) lines.push('  accents: ' + tokens.palette.accents.join(', '));
  if (tokens.palette.textColors.length) lines.push('  text: ' + tokens.palette.textColors.join(', '));
  if (tokens.spacingScale.length) lines.push('  spacing: ' + tokens.spacingScale.map((g) => `${g}px`).join(', '));
  return lines.join('\n');
}

export function serializePerception(p: Perception): string {
  const header: string[] = [];
  header.push(`PAGE ${p.viewport.w}x${p.viewport.h} site:${p.site.host} "${p.site.title}" bg:${short(p.canvas.bg)} text:${short(p.canvas.color)} font:${p.canvas.fontFamily} ${p.canvas.fontSize}`);
  header.push(`COLS ${p.skeleton.columnCount} CONTENT ${p.skeleton.contentMaxWidthPx ?? '?'}px`);
  // Phase 1 — the COMPOSITION summary: the page's macro shape, UP FRONT.
  header.push(`COMPOSITION ${p.composition.summary}`);

  // C4 — document outline tree: gives the model document hierarchy and section
  // boundaries (what is primary vs supporting, where a TOC comes from).
  if (p.outline?.length) header.push(formatOutline(p.outline));

  // C6 — colour as a model: palette in HSL with alpha, hue relationships,
  // saturation/lightness ranges, and surface geometry for the Painter.
  if (p.colorModel) header.push(formatColorModel(p.colorModel));

  // C8 — density, rhythm, alignment: inputs to the designer, not gates.
  if (p.density) header.push(formatDensity(p.density));

  if (p.skeleton.regions.length) {
    header.push('REGIONS ' + p.skeleton.regions.map((r) => `${r.handle}=${r.role}(${Math.round(r.widthRatio * 100)}%w,${r.rect.w}x${r.rect.h})`).join(' '));
  }
  if (p.cssVars.length) {
    header.push('VARS ' + p.cssVars.map((v) => `${v.name}:${short(v.value)}`).join(' '));
  }
  if (p.scrollables.length) {
    header.push('SCROLLABLES ' + p.scrollables.map((s) => `${s.handle}=${s.axis}`).join(' '));
  }
  if (p.reflowOpportunity.length) {
    header.push('REFLOW ' + p.reflowOpportunity.map((r) => `${r.kind}:${r.handle}`).join(' '));
  }

  // Design tokens + packs (unchanged).
  header.push(formatDesignTokens(extractDesignTokens(p)));
  header.push(formatPacks());

  // C5 — semantic compression: merge instead of amputate. Collapse repeated
  // sibling structures, fold trivial wrappers, drop pure-layout containers.
  // Target ~50 regions that describe the WHOLE page, not 80 that describe part.
  const merged = mergeClusters(p.clusters);
  const byProminence = [...merged].sort((a, b) => b.prominence - a.prominence);
  const tier1 = new Set(byProminence.slice(0, TIER1_FULL_DETAIL_COUNT).map((c) => c.handle));

  // Build parent → children map for tree serialization.
  const childrenOf = new Map<string | null, Cluster[]>();
  for (const c of merged) {
    const parent = c.layout.parentHandle;
    const arr = childrenOf.get(parent);
    if (arr) arr.push(c); else childrenOf.set(parent, [c]);
  }
  for (const arr of childrenOf.values()) arr.sort((a, b) => b.prominence - a.prominence);

  // Build entry list from the tree walk.
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

  const tree: string[] = ['TREE:'];
  for (const e of entries) {
    if (e.dropped) continue;
    tree.push('  '.repeat(Math.min(e.depth, 6)) + e.line);
  }
  const result = [...header, ...tree].join('\n');
  lastSerializeBudget = { before: result.length, after: result.length };

  // C5: the budget is held by merging, not amputation. If still over budget after
  // merging (a genuinely enormous page), demote least-prominent to compact. No
  // dropping — every visible region stays in the inventory.
  if (result.length > SERIALIZE_BUDGET) {
    let rebuilt = tree.slice(0, 1);
    for (const e of entries) {
      if (e.isFull && !tier1.has(e.cluster.handle) && result.length > SERIALIZE_BUDGET) {
        e.isFull = false;
        e.line = formatCompact(e.cluster);
      }
      if (!e.dropped) rebuilt.push('  '.repeat(Math.min(e.depth, 6)) + e.line);
    }
    const compactResult = [...header, ...rebuilt].join('\n');
    lastSerializeBudget = { before: result.length, after: compactResult.length };
    return compactResult;
  }

  return result;
}

/** C5 — semantic compression: merge repeated sibling structures into one
 *  representative plus a count, fold trivial wrappers into their meaningful child,
 *  and drop pure-layout containers that carry no content and no distinguishing
 *  style. 200 regions → ~50 that describe the whole page. */
function mergeClusters(clusters: Cluster[]): Cluster[] {
  // 1. Drop pure-layout containers: no content, no distinguishing style.
  const kept = clusters.filter((c) => {
    // Always keep interactive, media, headings, and high-dominance clusters.
    if (c.isNativeControl || c.role === 'heading' || c.dominanceRank > 0.3) return true;
    if (['img', 'picture', 'video', 'svg', 'figure'].includes(c.tag)) return true;
    if (c.style.hasBgImage) return true;
    // Drop: no text, no samples, no solid bg, no border, no shadow, high emptiness.
    const hasContent = c.samples.length > 0 || c.textProfile.readingLength > 0;
    const hasStyle = c.hasSolidBg || c.style.border !== 'none' || c.style.boxShadow !== 'none';
    if (!hasContent && !hasStyle && c.emptinessScore >= 0.9) return false;
    // Fold trivial passive wrappers (they carry no meaning; their children are
    // emitted separately). Keep them only if they have distinguishing style.
    if (c.layout.isPassiveWrapper && !hasStyle && c.samples.length === 0) return false;
    return true;
  });

  // 2. Collapse repeated sibling structures: clusters sharing a parent, same
  // design role, same component type, and similar width → one representative
  // with a merged count.
  const byParent = new Map<string | null, Cluster[]>();
  for (const c of kept) {
    const arr = byParent.get(c.layout.parentHandle);
    if (arr) arr.push(c); else byParent.set(c.layout.parentHandle, [c]);
  }
  const merged: Cluster[] = [];
  const usedMerged = new Set<string>();
  for (const [, sibs] of byParent) {
    // Group by (designRole, componentType, widthBucket)
    const groups = new Map<string, Cluster[]>();
    for (const s of sibs) {
      const widthBucket = Math.round(s.rect.w / 40) * 40;
      const key = `${s.designRole}|${s.componentType}|${widthBucket}`;
      const arr = groups.get(key);
      if (arr) arr.push(s); else groups.set(key, [s]);
    }
    for (const [, group] of groups) {
      if (group.length >= 2) {
        // Merge: keep the most prominent as representative, sum counts.
        const rep = [...group].sort((a, b) => b.prominence - a.prominence)[0];
        rep.count = group.reduce((s, c) => s + c.count, 0);
        merged.push(rep);
        for (const c of group) if (c !== rep) usedMerged.add(c.handle);
      } else {
        merged.push(group[0]);
      }
    }
  }
  // Keep any clusters not in the merged set (orphans from the parent grouping).
  for (const c of kept) if (!merged.includes(c) && !usedMerged.has(c.handle)) merged.push(c);
  return merged;
}

/** C4 — format the heading outline tree as an indented list. */
function formatOutline(nodes: HeadingNode[]): string {
  const lines: string[] = ['OUTLINE:'];
  const walk = (ns: HeadingNode[], depth: number): void => {
    for (const n of ns) {
      const tag = `h${n.level}`;
      const handle = n.handle ? ` [${n.handle}]` : '';
      lines.push(`${'  '.repeat(depth)}${tag} ${JSON.stringify(n.text.slice(0, 60))}${handle}`);
      walk(n.children, depth + 1);
    }
  };
  walk(nodes, 1);
  return lines.join('\n');
}

/** C6 — format the colour model compactly. */
function formatColorModel(cm: ColorModel): string {
  const lines: string[] = ['COLOR MODEL:'];
  const paletteStr = cm.palette.map((e) =>
    `${e.role}:${e.hex}(h${e.hsl[0]},s${e.hsl[1]},l${e.hsl[2]}${e.hsl[3] < 1 ? ',a' + e.hsl[3] : ''}${e.isBrand ? ',brand' : ''})`
  ).join(' ');
  lines.push(`  palette: ${paletteStr}`);
  if (cm.relationships.length) lines.push(`  relationships: ${cm.relationships.join(', ')}`);
  lines.push(`  sat:${cm.saturationRange[0]}-${cm.saturationRange[1]} light:${cm.lightnessRange[0]}-${cm.lightnessRange[1]}`);
  const g = cm.geometry;
  lines.push(`  geometry: radii[${g.radii.join(',')}] border[${g.borderWidths.join(',')}] shadow:${g.hasShadow ? g.shadowSpread + 'px' : 'none'} rhythm:${g.spacingRhythm}px`);
  return lines.join('\n');
}

/** C8 — format the density/rhythm/alignment profile. */
function formatDensity(d: DensityProfile): string {
  const lines = [`DENSITY: rhythm:${d.rhythmBaseline}px edges:[${d.alignmentEdges.join(',')}] whitespace-gini:${d.whitespaceGini.toFixed(2)}`];
  return lines.join('');
}

/**
 * Phase 2 — Painter-specific perception. The Painter decides the SURFACE (pack +
 * overrides + canvas + per-role aesthetics), not the layout, so it does not need
 * the per-cluster geometry/colors that dominate the full serialization. It DOES
 * need the role/group/handle identity to target `role@group` aesthetic intents
 * (a specific sidebar vs the news rail). This emits the header (site identity +
 * COMPOSITION + DESIGN TOKENS + DESIGN PACKS) + a compact role-grouped inventory
 * (one line per cluster: role@group handle x<count> <tag> [image] [native] [empty]
 * e.g.sample) — no geometry, no colors, no tree nesting. Cuts the Painter's prompt
 * ~40-50% (the TREE is the bulk), so the Painter's wall-clock drops (work item B).
 * The Architect keeps the full `serializePerception` (it needs geometry for reflow).
 * Pure: takes Perception as data. */
export function serializePainterPerception(p: Perception): string {
  const header: string[] = [];
  header.push(`PAGE ${p.viewport.w}x${p.viewport.h} site:${p.site.host} "${p.site.title}"`);
  header.push(`COMPOSITION ${p.composition.summary}`);
  if (p.skeleton.regions.length) {
    header.push('REGIONS ' + p.skeleton.regions.map((r) => `${r.handle}=${r.role}`).join(' '));
  }
  header.push(formatDesignTokens(extractDesignTokens(p)));
  header.push(formatPacks());

  // Compact role-grouped inventory — every cluster, identity only (no geometry/
  // colors). Sorted by prominence so the Painter reads the major regions first;
  // grouped by role so a role intent's fan-out is visible at a glance.
  const ordered = [...p.clusters].sort((a, b) => b.prominence - a.prominence);
  const lines = ordered.map((c) => {
    const parts = [`${c.designRole}${c.componentType !== 'unknown' ? ':' + c.componentType : ''}${c.group ? '@' + c.group : ''} ${c.handle} x${c.count} <${c.tag}>`];
    if (['img', 'picture', 'video', 'svg', 'figure'].includes(c.tag)) {
      parts.push('[image]');
      if (c.style.naturalAspect) parts.push(`aspect:${c.style.naturalAspect}`);
    }
    if (c.isNativeControl) parts.push('[native]');
    if (c.emptinessScore >= 0.6) parts.push(`empty${Math.round(c.emptinessScore * 10)}`);
    let line = parts.join(' ');
    if (c.samples.length) line += ` e.g.${c.samples.slice(0, 2).map((s) => JSON.stringify(s.slice(0, 20))).join(',')}`;
    return line;
  });
  return [...header, 'ROLE INVENTORY:', ...lines.map((l) => '  ' + l)].join('\n');
}

/**
 * S4.1 — v2-path Painter payload. The solver owns layout, so the Painter gets
 * role/slot-level information only — no geometry, rects, widths, positions, or
 * parent/child relationships. The slot assignment (already computed by the
 * solver) is threaded in so the Painter sees WHERE each cluster sits in the page
 * shell. Keeps site identity (host + title), design tokens, and design packs.
 * v2-path-only — the v1 `serializePainterPerception` is untouched.
 * Pure: takes Perception + SlotAssignment as data. */
export function serializeV2Painter(p: Perception, assignment: { handleToSlot: Map<string, string> }): string {
  const header: string[] = [];
  // Site identity — NO viewport dimensions (layout info the solver owns).
  header.push(`SITE ${p.site.host} "${p.site.title}"`);
  header.push(formatDesignTokens(extractDesignTokens(p)));
  header.push(formatPacks());

  // Compact role+slot inventory — every cluster, identity only. Sorted by
  // prominence so the Painter reads major regions first; grouped by role so
  // a role intent's fan-out is visible. Slot from the solver's assignment.
  const ordered = [...p.clusters].sort((a, b) => b.prominence - a.prominence);
  const lines = ordered.map((c) => {
    const slot = assignment.handleToSlot.get(c.handle) ?? 'overflow';
    const parts = [`${c.designRole}${c.componentType !== 'unknown' ? ':' + c.componentType : ''}${c.group ? '@' + c.group : ''} slot:${slot} dom${Math.round(c.dominanceRank * 10)} ${c.handle} x${c.count} <${c.tag}>`];
    if (['img', 'picture', 'video', 'svg', 'figure'].includes(c.tag)) {
      parts.push('[image]');
      if (c.style.naturalAspect) parts.push(`aspect:${c.style.naturalAspect}`);
    }
    if (c.isNativeControl) parts.push('[native]');
    if (c.emptinessScore >= 0.6) parts.push(`empty${Math.round(c.emptinessScore * 10)}`);
    let line = parts.join(' ');
    if (c.samples.length) line += ` e.g.${c.samples.slice(0, 2).map((s) => JSON.stringify(s.slice(0, 20))).join(',')}`;
    return line;
  });
  return [...header, 'ROLE+SLOT INVENTORY:', ...lines.map((l) => '  ' + l)].join('\n');
}

function formatFull(c: Cluster): string {
  const L = c.layout;
  // C11 — the new format: designRole + componentType lead, followed by identity,
  // geometry, paint, and the new C4/C10 signals. Dropped fields the model never
  // acted on: display, border (full string), fontWeight, padding,
  // widthFractionOfParent, isPassiveWrapper, isOpaqueWrapper, gap.
  const parts: string[] = [
    `${c.designRole}${c.group ? '@' + c.group : ''} dom${Math.round(c.dominanceRank * 10)}`,
    c.componentType !== 'unknown' ? `${c.componentType}:${c.componentConfidence.toFixed(1)}` : '',
    `${c.handle} x${c.count} <${c.tag}>${c.role ? ' ' + c.role : ''}`,
    `${c.rect.w}x${c.rect.h} ${Math.round(L.widthRatio * 100)}%w`,
    `bg:${short(c.style.background)}`, `text:${short(c.style.color)}`,
    `font:${c.style.fontSize}`,
  ].filter(Boolean);
  if (c.isNativeControl) parts.push('[native]');
  if (['img', 'picture', 'video', 'svg', 'figure'].includes(c.tag)) {
    parts.push('[image]');
    if (c.style.naturalAspect) parts.push(`aspect:${c.style.naturalAspect}`);
  }
  // C4 — governing heading (the section this cluster belongs to).
  if (c.governingHeading) parts.push(`heading:${c.governingHeading}`);
  // C10 — text profile: kind + longest unbreakable token (decides track narrowing).
  if (c.textProfile.kind !== 'none') {
    const tp = `text:${c.textProfile.kind}`;
    parts.push(c.textProfile.longestToken > 15 ? `${tp} maxtok:${c.textProfile.longestToken}` : tp);
    if (c.textProfile.truncated) parts.push('[truncated]');
    if (c.textProfile.dir === 'rtl') parts.push('rtl');
  }
  // Op cues (advisory for the Architect).
  if (c.emptinessScore >= 0.6) parts.push(`empty${Math.round(c.emptinessScore * 10)}`);
  if (c.moveSafety !== 'safe') parts.push(c.moveSafety === 'forbidden' ? 'forbid-move' : 'risky-move');
  let line = parts.join(' ');
  if (c.samples.length) line += ` e.g.${c.samples.slice(0, 2).map((s) => JSON.stringify(s.slice(0, 20))).join(',')}`;
  return line;
}

function formatCompact(c: Cluster): string {
  // C11 — compact line: role + componentType + identity + geometry + key signals.
  const parts: string[] = [
    `${c.designRole}${c.componentType !== 'unknown' ? ':' + c.componentType : ''} ${c.handle} x${c.count} <${c.tag}>${c.role ? ' ' + c.role : ''}`,
    `${c.rect.w}x${c.rect.h} ${Math.round(c.layout.widthRatio * 100)}%w`,
  ];
  if (c.hasSolidBg) parts.push(`bg:${short(c.style.background)}`);
  if (['img', 'picture', 'video', 'svg', 'figure'].includes(c.tag)) {
    parts.push('[image]');
    if (c.style.naturalAspect) parts.push(`aspect:${c.style.naturalAspect}`);
  }
  if (c.textProfile.kind !== 'none' && c.textProfile.longestToken > 15) parts.push(`maxtok:${c.textProfile.longestToken}`);
  if (c.emptinessScore >= 0.6) parts.push(`empty${Math.round(c.emptinessScore * 10)}`);
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
  // P5.1 fix: modulo 36^6 (2176782336) ensures the value fits in 6 base36 digits.
  // The old .slice(-6) dropped the most significant digit for values >= 36^6,
  // causing handle collisions (two different paths → same handle).
  return ((h >>> 0) % 2176782336).toString(36).padStart(6, '0');
}

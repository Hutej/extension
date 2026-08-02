/** core/perceive/dynamism — D5 (fixed/sticky/scroll behaviour) +
 *  D10 (safety flags: animations, transitions, will-change, virtualization,
 *  lazy-load, contain, iframes, closed shadow roots, !important).
 *
 *  Law 0: measurements inform decisions but never become output. No
 *  measurement value goes into emitted CSS — these flags are advisory inputs
 *  to the design model and the solver, never emitted tokens.
 *
 *  Pure enrichment: reads live DOM + computed styles via the representative
 *  element per cluster. Defines its own types; reports (does not add) the new
 *  fields it needs on Cluster/Perception. */

import type { Cluster } from './index.ts';
import { deepQuerySelector } from './dom-utils.ts';

// ── Types (exported; the spawning agent attaches the new fields) ─────────

export interface FixedStickyItem {
  handle: string;
  position: 'fixed' | 'sticky';
  stickEdge: 'top' | 'bottom' | 'left' | 'right' | null;
  offset: number;       // px
  scrollContainer: string | null;  // handle of scroll container cluster, or null for document
  occupiesW: number;
  occupiesH: number;
}

export interface ScrollBehaviorProfile {
  scrollContainers: { handle: string; axis: 'x' | 'y' | 'both'; snapType: string; snapAlign: string }[];
  anchorTargets: { id: string; handle: string | null }[];
  primaryNav: string | null;  // handle of the primary navigation cluster
  primaryNavLinks: string[];   // href destinations
  scrollDrivenLikely: boolean; // collapsing header pattern detected
}

export interface RegionSafety {
  handle: string;
  hasAnimations: boolean;
  hasTransitions: boolean;
  willChange: boolean;
  virtualized: boolean;
  lazyLoaded: boolean;
  contained: boolean;
  hasIframe: boolean;
  closedShadow: boolean;
  hasImportant: boolean;
  unsafe: boolean;  // any of the above = true
}

export interface SafetyProfile {
  regions: RegionSafety[];
  unsafeCount: number;
  fixedSticky: FixedStickyItem[];
  scrollBehavior: ScrollBehaviorProfile;
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Parse a computed-style offset ("0px", "12.5px", "auto") to a px number.
 *  Returns +Infinity when unset/auto so "is the offset set?" stays a simple
 *  finite check at the call site. */
function pxOrInf(v: string): number {
  if (v === 'auto' || v === '') return Infinity;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : Infinity;
}

/** The nearest scrollable ancestor of an element, or null for the document.
 *  Returns the cluster handle of that ancestor if it is a stamped cluster. */
function nearestScrollContainerHandle(el: HTMLElement, clusterOf: Map<HTMLElement, string>): string | null {
  let p: Element | null = el.parentElement;
  let depth = 0;
  while (p && depth < 32) {
    if (p instanceof HTMLElement) {
      const cs = getComputedStyle(p);
      const sx = cs.overflowX === 'auto' || cs.overflowX === 'scroll';
      const sy = cs.overflowY === 'auto' || cs.overflowY === 'scroll';
      if (sx || sy) return clusterOf.get(p) ?? null;  // scrollable but not a cluster → document
    }
    p = p.parentElement;
    depth++;
  }
  return null;
}

// ── D5.1 — fixed/sticky inventory ──────────────────────────────────────

/** Inventory every position:fixed and position:sticky element. The single
 *  biggest cause of broken transformations: a sticky header overlays content
 *  after a layout shift because the solver didn't know it reserves space.
 *  Stick edge is derived from which offset (top/bottom/left/right) is set to a
 *  finite value; offset is that px value. */
export function inventoryFixedSticky(clusters: Cluster[]): FixedStickyItem[] {
  const out: FixedStickyItem[] = [];
  // Map stamped representative elements → handle so the scroll-container lookup
  // resolves to a cluster handle in one walk, not per element.
  const clusterOf = new Map<HTMLElement, string>();
  for (const c of clusters) {
    const el = deepQuerySelector<HTMLElement>(c.selector);
    if (el) clusterOf.set(el, c.handle);
  }
  for (const c of clusters) {
    if (c.layout.position !== 'fixed' && c.layout.position !== 'sticky') continue;
    const el = deepQuerySelector<HTMLElement>(c.selector);
    if (!el) continue;
    const cs = getComputedStyle(el);
    const top = pxOrInf(cs.top);
    const bottom = pxOrInf(cs.bottom);
    const left = pxOrInf(cs.left);
    const right = pxOrInf(cs.right);
    // Stick edge: the offset that is actually set (finite). Prefer top/bottom
    // over left/right (the common case); among two set, the first in DOM order
    // of edges. sticky uses the inset that pins it in its scroll container.
    let stickEdge: 'top' | 'bottom' | 'left' | 'right' | null = null;
    let offset = 0;
    if (Number.isFinite(top)) { stickEdge = 'top'; offset = top; }
    else if (Number.isFinite(bottom)) { stickEdge = 'bottom'; offset = bottom; }
    else if (Number.isFinite(left)) { stickEdge = 'left'; offset = left; }
    else if (Number.isFinite(right)) { stickEdge = 'right'; offset = right; }
    const rect = el.getBoundingClientRect();
    // For fixed: the painted space (rect.w × rect.h). For sticky: the space in
    // its normal flow position — which is exactly the rect at capture time
    // (sticky occupies its flow slot until it sticks), so rect.w × rect.h holds
    // for both. The comment records the distinction for the reader.
    const occupiesW = Math.round(rect.width);
    const occupiesH = Math.round(rect.height);
    const scrollContainer = c.layout.position === 'fixed'
      ? null  // fixed is viewport-relative, not scroll-container-relative
      : nearestScrollContainerHandle(el, clusterOf);
    out.push({
      handle: c.handle,
      position: c.layout.position,
      stickEdge,
      offset: Number.isFinite(offset) ? Math.round(offset) : 0,
      scrollContainer,
      occupiesW,
      occupiesH,
    });
  }
  return out;
}

// ── D5.2 — scroll behaviour ────────────────────────────────────────────

/** Scroll containers (with scroll-snap), in-page anchor targets, the primary
 *  navigation region, and whether the page likely uses scroll-driven behaviour
 *  (a collapsing header: a sticky/fixed header + another sticky/fixed element
 *  that could be its sentinel — we can't observe at perception time, so we
 *  flag the *potential* pattern). */
export function inventoryScrollBehavior(clusters: Cluster[]): ScrollBehaviorProfile {
  const scrollContainers: ScrollBehaviorProfile['scrollContainers'] = [];
  for (const c of clusters) {
    const el = deepQuerySelector<HTMLElement>(c.selector);
    if (!el) continue;
    const cs = getComputedStyle(el);
    const sx = cs.overflowX === 'auto' || cs.overflowX === 'scroll';
    const sy = cs.overflowY === 'auto' || cs.overflowY === 'scroll';
    if (!sx && !sy) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 100 && r.height < 100) continue;  // skip tiny overflow clips
    scrollContainers.push({
      handle: c.handle,
      axis: sx && sy ? 'both' : sx ? 'x' : 'y',
      snapType: cs.scrollSnapType || 'none',
      snapAlign: cs.scrollSnapAlign || 'none',
    });
  }

  // In-page anchor targets: elements with an id, and links with href='#id'.
  // We record the id + the handle of the cluster containing the target (if any).
  const anchorTargets: ScrollBehaviorProfile['anchorTargets'] = [];
  const seenIds = new Set<string>();
  for (const el of Array.from(document.querySelectorAll('[id]'))) {
    const id = el.id;
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);
    let handle: string | null = null;
    // Walk up to the nearest stamped cluster.
    let p: Element | null = el;
    let depth = 0;
    while (p && depth < 24) {
      const h = p.getAttribute && p.getAttribute('data-wm-c');
      if (h) { handle = h; break; }
      p = p.parentElement;
      depth++;
    }
    anchorTargets.push({ id, handle });
  }

  // Primary navigation: the nav with the most links → their href destinations.
  let primaryNav: string | null = null;
  let primaryNavLinks: string[] = [];
  let bestLinkCount = 0;
  for (const c of clusters) {
    const isNav = c.role === 'navigation' || c.tag === 'nav' ||
      (c.role === 'complementary' && c.tag !== 'aside');  // nav-role aside edge: keep strict
    if (!isNav) continue;
    const el = deepQuerySelector<HTMLElement>(c.selector);
    if (!el) continue;
    const links = Array.from(el.querySelectorAll('a[href]'));
    if (links.length > bestLinkCount) {
      bestLinkCount = links.length;
      primaryNav = c.handle;
      primaryNavLinks = links
        .map((a) => a.getAttribute('href') || '')
        .filter((h) => h.length > 0)
        .slice(0, 64);  // ponytail: cap — a nav with hundreds of links is rare and noisy
    }
  }

  // Scroll-driven (collapsing header) potential: a sticky/fixed header cluster
  // PLUS another sticky/fixed cluster elsewhere that could act as its sentinel.
  // We cannot observe scroll at perception time; this flags the *potential*.
  const fixedSticky = clusters.filter(
    (c) => c.layout.position === 'fixed' || c.layout.position === 'sticky',
  );
  let scrollDrivenLikely = false;
  if (fixedSticky.length >= 2) {
    const header = fixedSticky.find((c) => c.role === 'banner' || c.tag === 'header' ||
      c.designRole === 'nav-primary' || c.designRole === 'toolbar');
    if (header) {
      // A second sticky/fixed element that is NOT the header → sentinel candidate.
      scrollDrivenLikely = fixedSticky.some((c) => c.handle !== header.handle);
    }
  }

  return { scrollContainers, anchorTargets, primaryNav, primaryNavLinks, scrollDrivenLikely };
}

// ── D10 — safety flags per region ───────────────────────────────────────

/** Whether a cluster's representative element has a non-trivial CSS transition
 *  active. `transitionProperty: all` or `none` is trivial; anything else
 *  (a named property like 'transform' or 'opacity') counts. */
function hasNonTrivialTransition(el: HTMLElement): boolean {
  const tp = getComputedStyle(el).transitionProperty;
  if (tp === 'none' || tp === 'all' || tp === '') return false;
  // 'all, ' (computed form for `transition: all`) is already covered; a named
  // property list like 'transform, opacity' is the non-trivial case.
  return tp.length > 0;
}

/** Detect a virtualized/windowed list: a very tall container (overflow auto/
 *  scroll) with many children but only a few visible (rect inside the
 *  container's clip). Intersection-observer patterns can't be observed at
 *  perception time; the tall-container-few-visible-children signature is the
 *  stable proxy. */
function looksVirtualized(el: HTMLElement): boolean {
  const cs = getComputedStyle(el);
  const sx = cs.overflowX === 'auto' || cs.overflowX === 'scroll';
  const sy = cs.overflowY === 'auto' || cs.overflowY === 'scroll';
  if (!sx && !sy) return false;
  const cr = el.getBoundingClientRect();
  if (cr.height < 600) return false;  // ponytail: tall threshold — virtualization pays off past ~1 screen of items
  const children = Array.from(el.children).filter((c) => c instanceof HTMLElement) as HTMLElement[];
  if (children.length < 20) return false;  // many items total
  // Visible = child rect intersects the container's content box (not clipped out).
  let visible = 0;
  for (const ch of children) {
    const r = ch.getBoundingClientRect();
    if (r.height <= 0) continue;
    // Intersects container's clip rect.
    if (r.bottom > cr.top && r.top < cr.bottom) visible++;
  }
  // Few visible relative to total → windowed rendering.
  return visible > 0 && visible < children.length * 0.3;
}

/** Lazy-load / intersection-observer content signatures: data-src, data-lazy,
 *  loading='lazy'. These elements load content on demand — moving or
 *  restyling them can break the observer or the load trigger. */
function looksLazyLoaded(el: HTMLElement): boolean {
  if (el.hasAttribute('loading') && el.getAttribute('loading') === 'lazy') return true;
  if (el.hasAttribute('data-src')) return true;
  if (el.hasAttribute('data-lazy')) return true;
  // A descendant lazy element means the cluster *contains* lazy content.
  return el.querySelector('[loading="lazy"], [data-src], [data-lazy]') != null;
}

/** Closed shadow root: a custom element (tagName contains '-') whose
 *  shadowRoot is null — either it has no shadow, or it's closed (we can't
 *  tell from outside, but the tag pattern + null shadow is the signal we
 *  act on: we cannot reach inside to style it). */
function hasClosedShadow(el: HTMLElement): boolean {
  if (!el.tagName.includes('-')) return false;
  // open shadow → shadowRoot is non-null; closed (or none) → null. We flag
  // the closed-or-absent case for custom elements because either way we
  // can't inject CSS inside it; the distinction doesn't change the risk.
  return el.shadowRoot === null;
}

/** Whether any CSS rule matching the element carries an !important declaration.
 *  Walks the element's matching rules via the CSS OM; falls back to false when
 *  the CSS OM is unavailable (e.g. cross-origin stylesheets — those rules
 *  don't appear in cssRules). */
function hasImportantDecl(el: HTMLElement): boolean {
  const sheets = document.styleSheets;
  for (let i = 0; i < sheets.length; i++) {
    let rules: CSSRuleList | null = null;
    try { rules = sheets[i].cssRules; } catch { /* cross-origin */ continue; }
    if (!rules) continue;
    for (let j = 0; j < rules.length; j++) {
      const rule = rules[j];
      if (!(rule instanceof CSSStyleRule)) continue;
      let matches = false;
      try { matches = el.matches(rule.selectorText); } catch { continue; }
      if (!matches) continue;
      const style = rule.style;
      for (let k = 0; k < style.length; k++) {
        if ((style.getPropertyPriority(style[k]) || '') === 'important') return true;
      }
    }
  }
  return false;
}

/** Per-region safety flags. Anything true makes the region unsafe or unstable
 *  to transform. `unsafe` is the OR of all flags so the model can gate on one
 *  bit without reading each field. */
export function flagSafety(clusters: Cluster[]): RegionSafety[] {
  const out: RegionSafety[] = [];
  for (const c of clusters) {
    const el = deepQuerySelector<HTMLElement>(c.selector);
    if (!el) {
      // ponytail: vanished representative — no DOM to probe; record a bare
      // (safe) entry so the region still appears in the profile.
      out.push({
        handle: c.handle, hasAnimations: false, hasTransitions: false, willChange: false,
        virtualized: false, lazyLoaded: false, contained: false, hasIframe: false,
        closedShadow: false, hasImportant: false, unsafe: false,
      });
      continue;
    }
    const cs = getComputedStyle(el);
    const hasAnimations = cs.animationName !== 'none';
    const hasTransitions = hasNonTrivialTransition(el);
    const willChange = cs.willChange !== 'auto';
    const virtualized = looksVirtualized(el);
    const lazyLoaded = looksLazyLoaded(el);
    const contained = cs.contain !== 'none';
    const hasIframe = el.tagName === 'IFRAME' || el.querySelector('iframe') != null;
    const closedShadow = hasClosedShadow(el);
    const hasImportant = hasImportantDecl(el);
    const unsafe = hasAnimations || hasTransitions || willChange || virtualized ||
      lazyLoaded || contained || hasIframe || closedShadow || hasImportant;
    out.push({
      handle: c.handle, hasAnimations, hasTransitions, willChange, virtualized,
      lazyLoaded, contained, hasIframe, closedShadow, hasImportant, unsafe,
    });
  }
  return out;
}

// ── Top-level entry: the full SafetyProfile (D5 + D10) ───────────────────

/** Build the full dynamism + safety profile: fixed/sticky inventory (D5.1),
 *  scroll behaviour (D5.2), and per-region safety flags (D10). The single
 *  function the perception pipeline calls to enrich a Perception. */
export function buildSafetyProfile(clusters: Cluster[]): SafetyProfile {
  const fixedSticky = inventoryFixedSticky(clusters);
  const scrollBehavior = inventoryScrollBehavior(clusters);
  const regions = flagSafety(clusters);
  const unsafeCount = regions.reduce((n, r) => n + (r.unsafe ? 1 : 0), 0);
  return { regions, unsafeCount, fixedSticky, scrollBehavior };
}

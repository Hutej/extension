/**
 * core/layout/exclusions — the relayout exclusion registry. 
 *
 * Marks subtrees `relayout: false` when they are controlled by JS widgets whose
 * layout the solver must not touch (shadow DOM, canvas, video, virtualized lists,
 * carousels, maps, JS-driven geometry). Restyling those subtrees remains allowed;
 * only the solver skips them.
 *
 * Principled detection ONLY — no hostnames, no site names, ever. Every check is a
 * universal structural signature, not a site recipe.
 *
 * Needs DOM access (runs during perception, in-page). Returns a handle → reason map.
 */

import type { Cluster } from '../perceive/index.ts';

export type ExclusionReason =
  | 'shadow-root'
  | 'media-tag'
  | 'editable'
  | 'carousel'
  | 'virtualization'
  | 'js-controlled-layout'
  | 'map';

/** Detect clusters whose layout is controlled by a JS widget or native media.
 *  Returns a map of handle → reason. Pure-ish: reads the DOM but does not modify it. */
export function detectExclusions(clusters: Cluster[]): Map<string, ExclusionReason> {
  const out = new Map<string, ExclusionReason>();
  for (const c of clusters) {
    const el = document.querySelector<HTMLElement>(c.selector);
    if (!el) continue;
    // 1. Shadow root — invisible to the solver's CSS; the widget owns its layout.
    if (el.shadowRoot) { out.set(c.handle, 'shadow-root'); continue; }
    // 2. Media tags — intrinsic dimensions, not solver-layoutable.
    if (['CANVAS', 'SVG', 'VIDEO', 'IFRAME', 'OBJECT'].includes(el.tagName)) {
      out.set(c.handle, 'media-tag'); continue;
    }
    // 3. Contenteditable / role=textbox / role=application — interactive surfaces.
    if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') {
      out.set(c.handle, 'editable'); continue;
    }
    const role = el.getAttribute('role');
    if (role === 'textbox' || role === 'application') {
      out.set(c.handle, 'editable'); continue;
    }
    // 4. Carousel — aria-roledescription, or track + transform + overflow + equal-width siblings.
    if (el.getAttribute('aria-roledescription') === 'carousel') {
      out.set(c.handle, 'carousel'); continue;
    }
    if (isCarousel(el)) { out.set(c.handle, 'carousel'); continue; }
    // 5. Virtualization — abs-positioned children with translate inside overflow-hidden.
    if (isVirtualized(el)) { out.set(c.handle, 'virtualization'); continue; }
    // 6. JS-controlled layout — inline style writes to width/height/transform.
    if (isJsControlledLayout(el)) { out.set(c.handle, 'js-controlled-layout'); continue; }
    // 7. Map — canvas / tiled abs-positioned children under a container with wheel/pointer handlers.
    if (isMap(el)) { out.set(c.handle, 'map'); continue; }
  }
  return out;
}

// ── Detectors (universal structural signatures) ───────────────────

/** Carousel: a track element (overflow:hidden + child with transform:translateX)
 *  and ≥2 equal-width siblings — a slide track. */
function isCarousel(el: HTMLElement): boolean {
  const cs = getComputedStyle(el);
  if (cs.overflowX !== 'hidden' && cs.overflowX !== 'scroll' && cs.overflow !== 'hidden') return false;
  const kids = Array.from(el.children).filter((c) => c instanceof HTMLElement) as HTMLElement[];
  if (kids.length < 2) return false;
  // Check for a transformed track child (the sliding container).
  const hasTrack = kids.some((k) => {
    const t = getComputedStyle(k).transform;
    return t !== 'none' && /translate/.test(t);
  });
  if (!hasTrack) return false;
  // Equal-width siblings (slides).
  const widths = kids.map((k) => k.getBoundingClientRect().width);
  const ref = widths[0];
  return ref > 50 && widths.every((w) => Math.abs(w - ref) < 5);
}

/** Virtualization: abs-positioned children with translate offsets inside an
 *  overflow-hidden container. The static signature of a virtual list — the
 *  dynamic child-count-changes-on-scroll check is omitted (false positives are
 *  safe: we skip relayout, not restyling). */
function isVirtualized(el: HTMLElement): boolean {
  const cs = getComputedStyle(el);
  if (cs.overflowY !== 'hidden' && cs.overflowY !== 'scroll' && cs.overflowY !== 'auto' &&
      cs.overflow !== 'hidden' && cs.overflow !== 'scroll') return false;
  const kids = Array.from(el.children).filter((c) => c instanceof HTMLElement) as HTMLElement[];
  if (kids.length < 3) return false;
  let absCount = 0;
  for (const k of kids) {
    const kcs = getComputedStyle(k);
    if (kcs.position !== 'absolute' && kcs.position !== 'fixed') continue;
    if (/translate/.test(kcs.transform)) absCount++;
  }
  // ponytail: static signature only — ≥3 abs+translate children inside overflow-hidden.
  // The dynamic child-count-on-scroll check would need a ResizeObserver; skipped
  // because false positives (excluding a non-virtualized container from relayout) are safe.
  return absCount >= 3;
}

/** JS-controlled layout: inline style writes to width/height/transform. Detects
 *  elements whose inline style attribute directly sets these properties — a
 *  signal that JS is managing the layout (React state-driven sizing, animation
 *  libraries, etc.). The dynamic "observed changing between samples" check is
 *  omitted; the static inline-style signature is the proxy. */
function isJsControlledLayout(el: HTMLElement): boolean {
  const style = el.getAttribute('style');
  if (!style) return false;
  // ponytail: check inline style for width/height/transform values that look
  // dynamically set (px values, not CSS-class definitions). A static heuristic —
  // the dynamic two-sample comparison would need observation; skipped for simplicity.
  return /(?:width|height|transform)\s*:\s*\d/.test(style);
}

/** Map: canvas or tiled abs-positioned children under a container with wheel/pointer
 *  event handlers. Detects map widgets (Google Maps, Leaflet, etc.). */
function isMap(el: HTMLElement): boolean {
  // Container with wheel/pointer handlers.
  const hasHandler = el.onwheel != null || el.onpointerdown != null ||
    el.hasAttribute('onwheel') || el.hasAttribute('onpointerdown');
  if (!hasHandler) return false;
  // Canvas child or tiled abs-positioned children.
  if (el.querySelector('canvas')) return true;
  const kids = Array.from(el.children).filter((c) => c instanceof HTMLElement) as HTMLElement[];
  let absCount = 0;
  for (const k of kids) {
    if (getComputedStyle(k).position === 'absolute') absCount++;
  }
  return absCount >= 3;
}
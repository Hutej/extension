/** core/perceive/media — (media inventory: images, video, canvas, SVG, icons).
 *  Enrichment: inventories every image, video, canvas, SVG and icon, reads
 *  intrinsic vs rendered dimensions, classifies media kind, and flags
 *  distortion + lazy loading. Measurements INFORM decisions but never become
 *  emitted CSS (Law 0) — this produces inventory data, not output. */

import type { Cluster } from './index.ts';
import { deepQuerySelector } from './dom-utils.ts';

// ── Types ──────────────────────────────────────────────────────────

export type MediaKind = 'icon' | 'photograph' | 'logo' | 'diagram' | 'decorative' | 'unknown';

export interface MediaItem {
  handle: string;
  tag: string;            // img, video, canvas, svg (div for background-image)
  kind: MediaKind;
  intrinsicW: number | null;
  intrinsicH: number | null;
  renderedW: number;
  renderedH: number;
  intrinsicAspect: number | null;
  renderedAspect: number;
  objectFit: string;
  lazyLoaded: boolean;
  distorted: boolean;     // rendered aspect differs from intrinsic by >5%
}

export interface MediaInventory {
  items: MediaItem[];
  totalMediaArea: number;  // sum of rendered areas
  distortionCount: number;
  lazyCount: number;
}

// ── Media cluster detection ─────────────────────────────────────────

const MEDIA_TAGS = new Set(['img', 'picture', 'video', 'svg', 'canvas', 'figure']);
const DISTORTION_THRESHOLD = 0.05;  // >5% aspect difference = distorted

function isMediaCluster(c: Cluster): boolean {
  return MEDIA_TAGS.has(c.tag) || c.style.hasBgImage === true;
}

// ── Intrinsic dimensions ────────────────────────────────────────────

/** Read intrinsic dimensions per media kind. img→naturalWidth/Height,
 *  video→videoWidth/Height, svg→viewBox or width/height attrs,
 *  canvas→width/height attrs. Returns null when unavailable. */
function intrinsicDims(el: Element, tag: string): { w: number; h: number } | null {
  if (tag === 'img' && el instanceof HTMLImageElement) {
    if (el.naturalWidth && el.naturalHeight) return { w: el.naturalWidth, h: el.naturalHeight };
  }
  if (tag === 'video' && el instanceof HTMLVideoElement) {
    if (el.videoWidth && el.videoHeight) return { w: el.videoWidth, h: el.videoHeight };
  }
  if (tag === 'svg') {
    const vb = el.getAttribute('viewBox');
    if (vb) {
      const parts = vb.split(/[\s,]+/).map(Number);
      if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) return { w: parts[2], h: parts[3] };
    }
    const w = parseFloat(el.getAttribute('width') || '');
    const h = parseFloat(el.getAttribute('height') || '');
    if (w > 0 && h > 0) return { w, h };
  }
  if (tag === 'canvas' && el instanceof HTMLCanvasElement) {
    if (el.width && el.height) return { w: el.width, h: el.height };
  }
  return null;
}

// ── Lazy-load detection ─────────────────────────────────────────────

/** Lazy loaded: loading='lazy' attribute, or intersection-observer signature
 *  (data-src, data-lazy, data-original attributes). */
function isLazyLoaded(el: Element): boolean {
  if (el.getAttribute('loading') === 'lazy') return true;
  return el.hasAttribute('data-src') || el.hasAttribute('data-lazy') ||
    el.hasAttribute('data-original') || el.hasAttribute('data-srcset');
}

// ── Media-kind classification ────────────────────────────────────────

const ICON_SIZE_PX = 32;        // small render → icon
const PHOTO_MIN_NATURAL = 100;  // naturalWidth > 100 → photograph, not icon
const LOGO_MAX_RENDER = 200;    // small-medium render for logo

/** Classify a media cluster into a MediaKind. Principled, no site names:
 *  size, tag, intrinsic dimensions, ancestor landmarks, class tokens. */
function classifyKind(
  el: Element | null,
  tag: string,
  renderedW: number,
  renderedH: number,
  intrinsicW: number | null,
  isBackground: boolean,
): MediaKind {
  // Background-image with no content element → decorative.
  if (isBackground) return 'decorative';

  // SVG with complex paths inside a figure → diagram.
  if (tag === 'svg' && el) {
    const parent = el.parentElement;
    if (parent && (parent.tagName === 'FIGURE' || parent.querySelector(':scope > figcaption') ||
      el.closest('figure'))) {
      const pathCount = el.querySelectorAll('path, polygon, polyline, line, circle, ellipse, rect').length;
      if (pathCount >= 2) return 'diagram';
    }
  }

  const classTokens = el ? (typeof el.className === 'string' ? el.className.toLowerCase() : '') : '';
  const hasIconClass = /\bicon\b/.test(classTokens);
  const small = renderedW < ICON_SIZE_PX || renderedH < ICON_SIZE_PX;

  // Icon: small render, or SVG, or class contains 'icon'.
  if (small && (tag === 'svg' || tag === 'img' || hasIconClass)) return 'icon';
  if (hasIconClass && tag === 'img') return 'icon';

  // Logo: img/svg in a nav/header/footer landmark, small-medium render.
  if (el && (tag === 'img' || tag === 'svg') && renderedW < LOGO_MAX_RENDER) {
    let p: Element | null = el.parentElement;
    let hops = 0;
    while (p && hops < 6) {
      const t = p.tagName.toLowerCase();
      const r = p.getAttribute('role');
      if (t === 'nav' || t === 'header' || t === 'footer' ||
        r === 'navigation' || r === 'banner' || r === 'contentinfo') {
        return 'logo';
      }
      p = p.parentElement;
      hops++;
    }
  }

  // Photograph: img with substantial natural dimensions, not an icon.
  if (tag === 'img' && intrinsicW != null && intrinsicW > PHOTO_MIN_NATURAL) return 'photograph';

  return 'unknown';
}

// ── Main entry ──────────────────────────────────────────────────────

/** Inventory every image, video, canvas, SVG and icon on the page.
 *  Iterates clusters, finds media clusters, resolves them live via
 *  deepQuerySelector (shadow-boundary aware), and reads their attributes +
 *  computed styles. Returns the full media inventory + aggregate counts. */
export function inventoryMedia(clusters: Cluster[], _viewport: { w: number; h: number }): MediaInventory {
  const items: MediaItem[] = [];
  let totalMediaArea = 0;
  let distortionCount = 0;
  let lazyCount = 0;

  for (const c of clusters) {
    if (!isMediaCluster(c)) continue;

    const renderedW = c.rect.w;
    const renderedH = c.rect.h;
    const isBackground = c.style.hasBgImage && !MEDIA_TAGS.has(c.tag);

    // Resolve the live element (background-image clusters use their own element;
    // content media clusters resolve the media element via the selector).
    const el = deepQuerySelector<Element>(c.selector);
    const mediaTag = isBackground ? 'div' : c.tag;

    let objectFit = 'fill';
    let lazyLoaded = false;
    let intrinsicW: number | null = null;
    let intrinsicH: number | null = null;

    if (el) {
      if (!isBackground) {
        const dims = intrinsicDims(el, c.tag);
        if (dims) { intrinsicW = dims.w; intrinsicH = dims.h; }
        objectFit = getComputedStyle(el).objectFit;
      } else {
        objectFit = getComputedStyle(el).backgroundSize;
      }
      lazyLoaded = isLazyLoaded(el);
    }

    const intrinsicAspect = (intrinsicW && intrinsicH && intrinsicH > 0)
      ? intrinsicW / intrinsicH : null;
    const renderedAspect = renderedH > 0 ? renderedW / renderedH : 0;

    let distorted = false;
    if (intrinsicAspect != null && renderedAspect > 0) {
      distorted = Math.abs(intrinsicAspect - renderedAspect) / intrinsicAspect > DISTORTION_THRESHOLD;
    }

    const kind = classifyKind(el, mediaTag, renderedW, renderedH, intrinsicW, isBackground);

    items.push({
      handle: c.handle,
      tag: mediaTag,
      kind,
      intrinsicW, intrinsicH,
      renderedW, renderedH,
      intrinsicAspect, renderedAspect,
      objectFit, lazyLoaded, distorted,
    });

    totalMediaArea += renderedW * renderedH;
    if (distorted) distortionCount++;
    if (lazyLoaded) lazyCount++;
  }

  return { items, totalMediaArea, distortionCount, lazyCount };
}

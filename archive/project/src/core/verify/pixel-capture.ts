/**
 * core/verify/pixel-capture — DOM + chrome.runtime orchestration for the pixel
 * detectors. Builds ClusterRect[] from the live [data-rv-c] elements, captures
 * the visible tab via the background service worker at scroll positions, and
 * runs pixelVerify.
 *
 * capture.ts holds the PURE decode helpers (screenshotToPixelInput); this module
 * holds the DOM/chrome orchestration that calls them — different responsibility,
 * hence a separate file. Extracted from content.ts (pure move, no behaviour change).
 */

import type { ClusterRect, PixelInput, PixelVerifyResult } from './pixel.ts';
import { pixelVerify } from './pixel.ts';
import { screenshotToPixelInput } from './capture.ts';

/** Build ClusterRect[] from the current [data-rv-c] elements for the pixel
 *  detectors. One representative per handle, with the rendered rect + text + font
 *  size. Skips our own UI nodes. `hasImage`/`hasGradient` flag content-image vs
 *  gradient/texture backgrounds so the void detector can recognize a DECORATIVE
 *  dead-zone (a large gradient with no content — the Wikipedia case) independent
 *  of color flatness. */
export function buildClusterRects(): ClusterRect[] {
  const seen = new Set<string>();
  const out: ClusterRect[] = [];
  for (const el of Array.from(document.querySelectorAll('[data-rv-c]'))) {
    if (el.hasAttribute('data-revueon-ui') || !(el instanceof HTMLElement)) continue;
    const handle = el.getAttribute('data-rv-c')!;
    if (seen.has(handle)) continue;
    seen.add(handle);
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    // role: the semantic role (for the rail-aware invisible-text detector). The
    // tag/role is the element's own; a rail label is often a <nav>/<aside> child.
    const role = el.getAttribute('role') || el.tagName.toLowerCase();
    const bgImage = cs.backgroundImage;
    // hasImage: a url() background = a content image (thumbnail). hasGradient: a
    // gradient/texture background (linear/radial/conic/repeating) — NOT a content
    // image. A cluster with a gradient bg and no text is a decorative dead-zone
    // candidate (the void detector's case 2).
    const hasImage = /url\(/i.test(bgImage);
    const hasGradient = /gradient/i.test(bgImage) && !hasImage;
    out.push({
      handle,
      rect: { x: r.left, y: r.top, w: r.width, h: r.height },
      text: (el.textContent || '').trim(),
      fontSize: parseFloat(cs.fontSize) || 16,
      role,
      hasImage,
      hasGradient,
    });
  }
  return out;
}

/** Capture the visible tab at scroll position y. Scrolls, waits two rAF, captures
 *  via the background service worker (only it can captureVisibleTab). Returns an
 *  empty PixelInput on error. Module-level so the before-capture (recolor detector)
 *  and the post-apply capture share the same path. */
export async function captureShotAt(y: number): Promise<PixelInput> {
  window.scrollTo(0, y);
  await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  return new Promise<PixelInput>((resolve) => {
    chrome.runtime.sendMessage({ action: 'captureVisibleTab' }, (resp: { ok: boolean; dataUrl?: string }) => {
      if (chrome.runtime.lastError || !resp?.ok || !resp.dataUrl) { resolve({ width: 0, height: 0, data: new Uint8ClampedArray(0) }); return; }
      void screenshotToPixelInput(resp.dataUrl, window.innerWidth || 1280).then(resolve).catch(() => resolve({ width: 0, height: 0, data: new Uint8ClampedArray(0) }));
    });
  });
}

/** Capture the visible tab at 3 scroll positions (top / mid / deep) and run
 *  the pixel detectors. Returns the PixelVerifyResult + the time it took. Asks the
 *  background service worker for captureVisibleTab (only it can capture a tab).
 *  Free, deterministic, zero model calls. When a `before` is supplied, the recolor
 *  detector compares it to captures[0] (the scrollY=0 after-shot). */
export async function captureAndPixelVerify(before?: PixelInput): Promise<{ result: PixelVerifyResult; ms: number }> {
  const tc = performance.now();
  // use document.body.scrollHeight (matching the test harness) so the
  // verify pass captures at the SAME scroll positions. document.documentElement
  // and document.body can differ (margins/overflow), causing the verify to miss
  // invisible text that the test harness catches — sticky headers are always at
  // the viewport top, but the content behind them changes per scroll position.
  const h = (document.body?.scrollHeight || document.documentElement.scrollHeight) || 1;
  const scrolls = [0, Math.floor(h / 2), Math.floor(h * 0.8)];
  // Build rects at EACH scroll position — getBoundingClientRect() returns viewport-
  // relative coords, so a rect from scrollY=0 misaligned against a capture at
  // scrollY=h/2 reads the wrong pixels (the false-positive source). The capture is
  // decoded at viewport width (CSS pixels) so the coordinate system matches the rects.
  const captures: PixelInput[] = [];
  const rectsPerCapture: ClusterRect[][] = [];
  for (const y of scrolls) {
    captures.push(await captureShotAt(y));
    rectsPerCapture.push(buildClusterRects());
  }
  window.scrollTo(0, 0);
  const result = pixelVerify(captures, rectsPerCapture, before);
  return { result, ms: Math.round(performance.now() - tc) };
}
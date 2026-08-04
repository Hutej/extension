/**
 * core/verify/capture — product path: chrome.tabs.captureVisibleTab (relayed via
 * the background service worker) → PixelInput, at 3 scroll positions (top / mid /
 * deep). The content script orchestrates; this module holds the pure-ish helpers
 * (decoding + orchestration) so they are unit-testable without a browser.
 *
 * The HARNESS path uses page.screenshot directly (see popup.test.ts pixelAudit).
 * Both produce the same PixelInput the pure detectors in pixel.ts consume.
 */

import type { PixelInput } from './pixel.ts';

/**
 * Orchestrate captures at a list of scroll positions. Pure-ish: takes a `shot`
 * function that returns a PixelInput for a given scroll-Y, scrolls the page
 * itself is the caller's job — this just sequences. Unit-testable with a stub.
 *
 * The real caller (content.ts) passes a `shot` that: sets scrollY, waits a frame,
 * asks the background for captureVisibleTab, decodes the PNG to a PixelInput.
 */
/**
 * Decode a PNG (data URL or Buffer) to a PixelInput by drawing it to a canvas at
 * a coarse width (the detectors downscale anyway). Runs in the page (uses Image
 * + canvas). Returns a 0-size PixelInput on decode failure.
 */
export async function screenshotToPixelInput(dataUrl: string, width = 256): Promise<PixelInput> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const w = width;
      const h = Math.max(1, Math.round((img.naturalHeight / Math.max(1, img.naturalWidth)) * w));
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      if (!ctx) { resolve({ width: 0, height: 0, data: new Uint8ClampedArray(0) }); return; }
      ctx.drawImage(img, 0, 0, w, h);
      resolve({ width: w, height: h, data: ctx.getImageData(0, 0, w, h).data });
    };
    img.onerror = () => resolve({ width: 0, height: 0, data: new Uint8ClampedArray(0) });
    img.src = dataUrl;
  });
}

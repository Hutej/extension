/**
 * core/execute/backstop — inline-style forceContrast backstop. Forces the
 * readable bg+text pair onto each invisible cluster's own element, beating
 * id-level site !important that defeats the CSS rule (the cascade-loss class).
 *
 * Extracted from content.ts (pure move, no behaviour change). Was a closure
 * inside runStyleImpl; it used no closure variables, so it is a standalone fn.
 */

import type { DesignSpec } from '../spec/index.ts';
import { deriveBaseTone } from '../compile/index.ts';
import { parseColor, pickReadableText } from '../../shared/color.ts';

/** Inline-style forceContrast backstop: forces the readable bg+text pair onto
 *  each invisible cluster's own element, beating id-level site !important that
 *  defeats the CSS rule (the cascade-loss class). Reused by both v1 and v2. */
export function applyInlineBackstop(curSpec: DesignSpec, targets: string[] | undefined, contrastTargetBgs: Record<string, string> | undefined): void {
  if (!targets?.length) return;
  const canvasTone = deriveBaseTone(curSpec.canvas?.background ?? '');
  const canvasParsed = parseColor(canvasTone);
  const opaque = (bg: string | undefined | null): string | null => {
    if (!bg) return null;
    const p = parseColor(bg);
    return p && p[3] === 1 ? bg : null;
  };
  for (const h of new Set(targets)) {
    const el = document.querySelector<HTMLElement>(`[data-rv-c="${h}"]`);
    if (!el) continue;
    // skip content images (url()) but NOT gradients. A gradient bg can
    // make text invisible; the inline backstop (inline+!important) overrides it
    // with a readable solid pair. Content images are preserved.
    if (/url\(/i.test(getComputedStyle(el).backgroundImage)) continue;
    const ownBg = getComputedStyle(el).backgroundColor;
    const effBg = opaque(contrastTargetBgs?.[h]) ?? opaque(ownBg) ?? canvasTone;
    const baseTone = deriveBaseTone(effBg);
    const baseParsed = parseColor(baseTone) ?? canvasParsed;
    const readableBg = baseParsed ? baseTone : '#ffffff';
    const readableText = baseParsed ? pickReadableText(baseParsed) : '#111111';
    el.style.setProperty('background', readableBg, 'important');
    el.style.setProperty('background-image', 'none', 'important');
    el.style.setProperty('color', readableText, 'important');
  }
}
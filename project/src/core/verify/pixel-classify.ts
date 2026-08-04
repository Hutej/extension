/**
 * core/verify/pixel-classify — DOM-grounded inputs for the invisible-text
 * failure classifier. Gathers the live computed styles + effective backgrounds the
 * PURE classifier in pixel.ts (classifyInvisibleFailures) needs.
 *
 * pixel.ts is "Pure rendered-pixel detectors. No DOM"; this module holds the
 * DOM-walking helpers (getComputedStyle, elementFromPoint, parent chain) that
 * feed the pure classifier — different responsibility, hence a separate file.
 * Extracted from content.ts (pure move, no behaviour change).
 */

import { parseColor } from '../../shared/color.ts';
import { classifyInvisibleFailures, type InvisibleBreakdown } from './pixel.ts';

/** instrument: classify each SURVIVING invisible-text cluster (still
 *  invisible after paint N) into its failure class — {no-handle, wrong-bg,
 *  cascade-loss, multi-bg} — so the run report names the ROOT CAUSE of every
 *  invisible cluster, not just the count. The repair comment promises the
 *  deterministic bg+text pair "guarantees the pixel-invisible ones are readable
 *  regardless"; this instrument proves or disproves that guarantee per run.
 *  Pure classification lives in core/verify/pixel (classifyInvisibleFailures);
 *  this gathers the DOM-grounded inputs the pure fn needs:
 *   - emittedBg[handle]  : the `background` our CSS actually painted on it (live).
 *   - liveEffBg[handle]  : the effective bg the text sits on (parent-chain walk).
 *   - multiBg            : handles whose rect spans >1 distinct opaque-ancestor bg.
 *  A no-handle survivor (text with no [data-rv-c]) is invisible to the pixel
 *  detector entirely (buildClusterRects only iterates [data-rv-c]); those are
 *  counted separately on VerifyResult.contrastNoHandle. */
export function classifyInvisible(invisible: string[]): InvisibleBreakdown | null {
  if (!invisible.length) return null;
  const emittedBg = new Map<string, string>();
  const liveEffBg = new Map<string, string>();
  const multiBg = new Set<string>();
  const colorDiag = new Map<string, string>();
  for (const h of invisible) {
    const el = document.querySelector<HTMLElement>(`[data-rv-c="${h}"]`);
    if (!el) continue;
    emittedBg.set(h, getComputedStyle(el).backgroundColor || '');
    liveEffBg.set(h, effectiveBgStr(el));
    // multi-bg: sample the rect's left/right thirds' effective backgrounds; if they
    // differ, the cluster spans >1 painted surface (one pair can't cover both).
    const r = el.getBoundingClientRect();
    if (r.width > 200) {
      const leftBg = effectiveBgAt(r.left + 8, r.top + r.height / 2);
      const rightBg = effectiveBgAt(r.right - 8, r.top + r.height / 2);
      if (leftBg && rightBg && leftBg !== rightBg) multiBg.add(h);
    }
    // DIAG : capture the cluster's computed color + the first text-bearing
    // descendant's tag/computed-color, so the harness's INVISIBLE-TEXT breakdown
    // shows WHY the forced color isn't reaching the text (root-causes `unknown`).
    if (colorDiag.size < 5) {
      const cs = getComputedStyle(el);
      const hasDirectText = (e: Element): boolean => Array.from(e.childNodes).some((n) => n.nodeType === 3 && n.textContent && n.textContent.trim());
      // search ANY descendant branch (first-child-only descent misses sibling text)
      let txtEl: Element | null = null;
      for (const d of Array.from(el.querySelectorAll('*'))) { if (hasDirectText(d)) { txtEl = d; break; } }
      if (!txtEl && hasDirectText(el)) txtEl = el;
      const txtColor = txtEl ? getComputedStyle(txtEl).color : '(no text desc)';
      const txtTag = txtEl ? `${txtEl.tagName.toLowerCase()}${txtEl.id ? '#' + txtEl.id : ''}${txtEl.className && typeof txtEl.className === 'string' ? '.' + String(txtEl.className).split(/\s+/).slice(0, 2).join('.') : ''}` : '-';
      const r2 = el.getBoundingClientRect();
      colorDiag.set(h, `clusterColor=${cs.color} display=${cs.display} bg=${cs.backgroundColor} rect=${Math.round(r2.width)}x${Math.round(r2.height)} textIn=<${txtTag}> txtColor=${txtColor}`);
    }
  }
  const bd = classifyInvisibleFailures(invisible, emittedBg, liveEffBg, multiBg);
  if (bd) for (const rec of bd.records) { const d = colorDiag.get(rec.handle); if (d) rec.evidence = `${rec.evidence} [${d}]`; }
  return bd;
}

/** Effective background of an element as a CSS rgb() string — the first opaque
 *  ancestor's bg, mirroring verify's effectiveBackground walk. */
export function effectiveBgStr(el: HTMLElement): string {
  let cur: Element | null = el;
  while (cur) {
    const c = parseColor(getComputedStyle(cur).backgroundColor);
    if (c && c[3] >= 0.95) return `rgb(${c[0]},${c[1]},${c[2]})`;
    cur = cur.parentElement;
  }
  return '';
}

/** Effective background at a viewport point via elementFromPoint — the real painted
 *  surface under a pixel (catches a bg boundary the rect-walk averages over). */
export function effectiveBgAt(x: number, y: number): string {
  const el = document.elementFromPoint(x, y) as Element | null;
  return el ? effectiveBgStr(el as HTMLElement) : '';
}

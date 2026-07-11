/**
 * capabilities/structure — the layout primitive. Mirrors capabilities/style:
 * one open-ended LayoutDecls bag in, SAFE CSS declarations out.
 *
 * This is where the "layout is where browsers break" physics is encoded as data
 * + rules so an arbitrary AI layout spec is trustworthy:
 *   - property allowlist (unknown keys dropped)
 *   - NEVER display:none as a layout op (ghost columns) — de-emphasis uses
 *     order/sizing/display:contents instead
 *   - display:contents only on a passive wrapper (else it destroys the box)
 *   - absolute wide width is paired with max-width:100% (overflow guard)
 *   - box-sizing:border-box whenever a width is set (Sizing law)
 *   - dropSizing repair strips growth on overflow
 *   - everything !important (cascade win)
 *
 * NOTE: research docs said "do not touch layout / keep minimal" — that was the
 * OLD reading-mode product. This product must change layout; the guardrails here
 * make it safe rather than forbidden.
 */

import { LAYOUT_PROPS, BOX_GROWTH_KEYS, SIZING_KEYS, isSafeValue } from '../../laws/index.ts';
import type { LayoutDecls } from '../../spec';

export interface LayoutBuildOptions {
  isConstraintOwner: boolean;   // target lays out its own children (flex/grid)
  ownsTarget: boolean;          // target's box is owned by a flex/grid ancestor
  isPassiveWrapper?: boolean;   // safe to collapse via display:contents
  dropSizing?: boolean;         // repair: strip width/flex growth on overflow
}

export interface LayoutBuildResult {
  decls: string[];
  dropped: string[];
}

export function buildLayoutDeclarations(input: LayoutDecls, opts: LayoutBuildOptions): LayoutBuildResult {
  const out = new Map<string, string>();
  const dropped: string[] = [];
  let widthValue = '';

  for (const [key, rawVal] of Object.entries(input)) {
    const cssProp = LAYOUT_PROPS[key];
    if (!cssProp) { dropped.push(key); continue; }
    const val = rawVal.trim();
    if (!isSafeValue(val)) { dropped.push(key + '(unsafe)'); continue; }

    // Ghost-column avoidance: display:none is never a layout op.
    if (cssProp === 'display' && val.toLowerCase() === 'none') { dropped.push('display:none(ghost-column)'); continue; }
    // display:contents destroys the target's box — only safe on a passive wrapper.
    if (cssProp === 'display' && val.toLowerCase() === 'contents' && !opts.isPassiveWrapper) {
      dropped.push('display:contents(impure)'); continue;
    }
    // Overflow repair: strip growth-causing sizing.
    if (opts.dropSizing && SIZING_KEYS.has(key)) { dropped.push(key + '(dropSizing)'); continue; }

    out.set(cssProp, val);
    if (key === 'width') widthValue = val;
  }

  // Overflow guard / max-width supremacy: an absolute wide width must be capped.
  if (widthValue && !out.has('max-width') && isAbsoluteWide(widthValue)) {
    out.set('max-width', '100%');
  }

  // Box-sizing coupling: any width change needs border-box or geometry shifts.
  for (const k of Object.keys(input)) {
    if (BOX_GROWTH_KEYS.has(k) && out.has(LAYOUT_PROPS[k])) { out.set('box-sizing', 'border-box'); break; }
  }

  const decls = Array.from(out.entries()).map(([p, v]) => `${p}: ${v} !important;`);
  return { decls, dropped };
}

/** A width that can overflow its owner: absolute unit and physically large, or >100vw. */
function isAbsoluteWide(width: string): boolean {
  const w = width.toLowerCase();
  const vw = w.match(/^([\d.]+)vw$/);
  if (vw) return parseFloat(vw[1]) > 100;
  const abs = w.match(/^([\d.]+)(px|pt|cm|in|mm|pc)$/);
  if (abs) {
    const px = unitToPx(parseFloat(abs[1]), abs[2]);
    return px > 1600; // wider than a typical desktop viewport
  }
  // percentages / auto / fit-content / min-content / clamp() etc. are safe
  return false;
}

function unitToPx(n: number, unit: string): number {
  switch (unit) {
    case 'px': return n;
    case 'pt': return n * 96 / 72;
    case 'pc': return n * 16;
    case 'in': return n * 96;
    case 'cm': return n * 96 / 2.54;
    case 'mm': return n * 96 / 25.4;
    default: return n;
  }
}

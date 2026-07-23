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

import { LAYOUT_PROPS, BOX_GROWTH_KEYS, SIZING_KEYS, isSafeValue, clampDisplayFont, clampColumnCount, normalizeGridTemplate } from '../../laws/index.ts';
import type { LayoutDecls } from '../../spec';

export interface LayoutBuildOptions {
  isConstraintOwner: boolean;   // target lays out its own children (flex/grid)
  ownsTarget: boolean;          // target's box is owned by a flex/grid ancestor
  isPassiveWrapper?: boolean;   // safe to collapse via display:contents
  dropSizing?: boolean;         // repair: strip width/flex growth on overflow
  containerWidthPx?: number;    // the cluster's measured block width — clamps display type to fit it
}

export interface LayoutBuildResult {
  decls: string[];
  dropped: string[];
}

export function buildLayoutDeclarations(input: LayoutDecls, opts: LayoutBuildOptions): LayoutBuildResult {
  const out = new Map<string, string>();
  const dropped: string[] = [];

  for (const [key, rawVal] of Object.entries(input)) {
    const cssProp = LAYOUT_PROPS[key];
    if (!cssProp) { dropped.push(key); continue; }
    let val = rawVal.trim();
    if (!isSafeValue(val)) { dropped.push(key + '(unsafe)'); continue; }

    // Ghost-column avoidance: display:none is never a layout op.
    if (cssProp === 'display' && val.toLowerCase() === 'none') { dropped.push('display:none(ghost-column)'); continue; }
    // display:contents destroys the target's box — only safe on a passive wrapper.
    if (cssProp === 'display' && val.toLowerCase() === 'contents' && !opts.isPassiveWrapper) {
      dropped.push('display:contents(impure)'); continue;
    }
    // Overflow repair: strip growth-causing sizing.
    if (opts.dropSizing && SIZING_KEYS.has(key)) { dropped.push(key + '(dropSizing)'); continue; }

    // ── Viewport-safe by construction (prevention beats repair) ──
    // A fixed px/vw width/min-width can never exceed its container: min(X, 100%).
    if ((cssProp === 'width' || cssProp === 'max-width' || cssProp === 'min-width') && isFixedLength(val)) {
      val = `min(${val}, 100%)`;
    }
    // Display type is clamped to fit its OWN container block (not just the
    // viewport) so oversized headings can't bleed out of a narrow card.
    if (cssProp === 'font-size') val = clampDisplayFont(val, opts.containerWidthPx);

    // columnCount: only accept if containerWidth ÷ count ≥ MIN_COLUMN_PX.
    // Otherwise clamp to the max count that fits (1 if none). Kills the one-char-
    // per-line failure (columnCount:2 in a ~150px column).
    if (cssProp === 'column-count') {
      const requested = parseInt(val);
      if (!isNaN(requested)) {
        const clamped = clampColumnCount(requested, opts.containerWidthPx);
        if (clamped !== requested) { dropped.push(`columnCount(clamped:${requested}->${clamped})`); }
        val = String(clamped);
      }
    }

    // grid-template-columns: normalize to overflow-safe form by
    // construction. Bare 'fr' → minmax(0, Xfr) so min-content can't force
    // overflow; fixed px tracks wider than container → min(Xpx, 100%).
    // This makes the 1.97× column blow-out impossible to emit, not repaired after.
    if (cssProp === 'grid-template-columns') {
      val = normalizeGridTemplate(val, opts.containerWidthPx);
      // Only set max-width:100% if the model didn't explicitly set one (order-independent).
      const hasModelMaxWidth = Object.keys(input).some((k) => LAYOUT_PROPS[k] === 'max-width');
      if (!hasModelMaxWidth) out.set('max-width', '100%');
    }

    out.set(cssProp, val);
  }

  // Box-sizing coupling: any width change needs border-box or geometry shifts.
  for (const k of Object.keys(input)) {
    if (BOX_GROWTH_KEYS.has(k) && out.has(LAYOUT_PROPS[k])) { out.set('box-sizing', 'border-box'); break; }
  }

  const decls = Array.from(out.entries()).map(([p, v]) => `${p}: ${v} !important;`);
  return { decls, dropped };
}

/** A fixed length that could exceed its container (px or vw). %/auto/min-content/fit-content/clamp()/calc()/min() are already safe. */
function isFixedLength(v: string): boolean {
  return /^[\d.]+(px|pt|cm|in|mm|pc|vw)$/i.test(v.trim());
}

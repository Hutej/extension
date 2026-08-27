/**
 * core/responsive — the responsive-CSS dominance check.
 *
 * Ported from Senior advice: Problem.txt (the count diagnostic): count
 * fixed-pixel LAYOUT signals (position:absolute/fixed, fixed px on
 * sizing/offset properties) against responsive signals (% , fr, auto,
 * minmax(), clamp(), fit-content, aspect-ratio, min/max-content, relative
 * units, Flexbox, Grid). If fixed-px DOMINATES, refuse — the layout was
 * reconstructed from measurements and will break on resize (Law 6: a
 * transformation must survive a window resize).
 *
 * What this is NOT: a ban on `px`. px is legitimate for borders, small
 * spacing, typography, shadows, radii, icons. We count px ONLY on the
 * properties that determine LAYOUT geometry — width, height, the min/max
 * sizing props, the four offsets (top/left/right/bottom), inset, and
 * position:absolute/fixed. A restyle that sets
 * `border: 2px solid red` or `font-size: 18px` is not dominated by fixed
 * layout and passes.
 *
 * Pure: takes the structured EmitItem[] already produced by parseCss (the
 * browser's CSSOM), returns a count. No DOM, no regex on a CSS string, no
 * false matches inside comments. applyCss calls this BEFORE emitting so a
 * fixed-px restyle is refused before any mutation — nothing to roll back,
 * the model retries with responsive CSS (consistent with F1's refuse-before-
 * mutate). Not applied to hide/heal/insert: those don't author arbitrary
 * restyle CSS (display:none / our derived container style / sanitized HTML).
 */

import type { EmitItem } from './emit';

// Layout-sizing + positioning properties. A px value on one of these fixes
// geometry to a measured size and breaks on resize. Logical (inline/block)
// variants included for completeness.
const SIZING_PROPS = new Set([
  'width', 'height',
  'min-width', 'max-width', 'min-height', 'max-height',
  'inline-size', 'block-size',
  'min-inline-size', 'max-inline-size', 'min-block-size', 'max-block-size',
  'top', 'left', 'right', 'bottom',
  'inset', 'inset-inline', 'inset-block',
  'inset-inline-start', 'inset-inline-end', 'inset-block-start', 'inset-block-end',
]);

/** A bare px length token: `900px`, `-12.5px` (CSSOM strips !important into the
 *  priority, so the value is just the length). A bare px length is a measured
 *  size written back — the surviving hard-law bug. calc()/min()/max() with a
 *  bare px inside are still fixed; calc(100% - 20px) is responsive (counted
 *  separately by isResponsiveValue). */
function isFixedPxValue(v: string): boolean {
  return /^-?\d*\.?\d+px$/.test(v.trim());
}

/** A responsive signal: relative/fluid sizing the browser re-solves on resize. */
function isResponsiveValue(v: string): boolean {
  const s = v.trim().toLowerCase();
  if (/%/.test(s)) return true;                          // percentages
  if (/\bfr\b/.test(s)) return true;                     // grid fr units
  if (/\bauto\b/.test(s)) return true;                   // auto sizing
  if (/\bmin-content\b|\bmax-content\b/.test(s)) return true;
  if (/\bfit-content\b/.test(s)) return true;
  if (/minmax\s*\(/.test(s)) return true;
  if (/clamp\s*\(/.test(s)) return true;
  if (/aspect-ratio\s*:/.test(s)) return true;           // value form "2 / 1"
  if (/aspect-ratio\b/.test(s)) return true;
  // Relative/fluid length units (scale with viewport/root/font, not fixed px).
  if (/\b(vw|vh|vmin|vmax|rem|em|ch|ex|rlh|rcap)\b/.test(s)) return true;
  return false;
}

export interface ResponsiveCount {
  fixedCount: number;
  responsiveCount: number;
  /** Human-readable fixed signals (capped) for the error message. */
  fixed: string[];
}

/** Count fixed-pixel layout signals vs responsive signals across EmitItem[]
 *  (recursing into @media/@supports). Pure. */
export function countResponsiveSignals(items: EmitItem[]): ResponsiveCount {
  let fixedCount = 0;
  let responsiveCount = 0;
  const fixed: string[] = [];

  const walk = (xs: EmitItem[]) => {
    for (const item of xs) {
      if (item.kind === 'style') {
        for (const d of item.declarations) {
          const prop = d.property.toLowerCase();
          const val = d.value;

          // position:absolute/fixed — fixes an element to coordinates.
          if (prop === 'position' && /\b(absolute|fixed)\b/.test(val.toLowerCase())) {
            fixedCount++;
            if (fixed.length < 6) fixed.push(`position:${val.trim()}`);
            continue;
          }
          // display:flex/grid — a responsive layout signal (the browser owns it).
          if (prop === 'display' && /\b(flex|inline-flex|grid|inline-grid)\b/.test(val.toLowerCase())) {
            responsiveCount++;
            continue;
          }
          // aspect-ratio property — responsive.
          if (prop === 'aspect-ratio') {
            responsiveCount++;
            continue;
          }
          // flex/grid layout properties — responsive structure signals.
          if (/^(flex|flex-|grid-|grid-template-|grid-area|justify-|align-|place-|gap|row-gap|column-gap)/.test(prop)) {
            responsiveCount++;
            continue;
          }

          // A px value on a LAYOUT-sizing/offset property = fixed geometry.
          if (SIZING_PROPS.has(prop) && isFixedPxValue(val)) {
            fixedCount++;
            if (fixed.length < 6) fixed.push(`${prop}: ${val.trim()}`);
            continue;
          }
          // A responsive value on any property = responsive signal.
          if (isResponsiveValue(val)) {
            responsiveCount++;
            continue;
          }
        }
      } else if (item.kind === 'at') {
        walk(item.items);
      }
    }
  };
  walk(items);

  return { fixedCount, responsiveCount, fixed };
}

/** Fixed-pixel layout dominates the CSS: more fixed-px layout signals than
 *  responsive ones, with at least one fixed signal present. A restyle with
 *  no layout declarations (colour/typography only) is fixedCount=0 and passes. */
export function fixedPxDominates(items: EmitItem[]): ResponsiveCount | null {
  const c = countResponsiveSignals(items);
  if (c.fixedCount > c.responsiveCount && c.fixedCount >= 1) return c;
  return null;
}

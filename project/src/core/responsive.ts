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

/** Intrinsic component dimensions — icons, badges, small controls, fixed-height
 *  toolbars — live below this; measured page geometry (content regions,
 *  columns, reconstructed layout) starts far above it. */
const INTRINSIC_COMPONENT_LIMIT_PX = 100;

/** A bare px length token: `900px`, `-12.5px` (CSSOM strips !important into the
 *  priority, so the value is just the length). A bare px length is a measured
 *  size written back — the surviving hard-law bug. calc()/min()/max() with a
 *  bare px inside are still fixed; calc(100% - 20px) is responsive (counted
 *  separately by isResponsiveValue).
 *
 *  R3a/R3b: a px length on a layout property is only a fixed-geometry signal
 *  when it is page-scale. Zero (`width: 0px`) is a hide/collapse pattern, and
 *  sub-100px values are intrinsic COMPONENT dimensions — an icon (`width: 16px;
 *  height: 16px`), a badge (`width: 10px`), a toolbar height — design decisions
 *  that survive resize at every viewport, so they cannot be Law-6 violations.
 *  Measured-layout reconstruction sizes content REGIONS, which start far above
 *  any component (the genuine-refusal fixture is width:500px/height:900px).
 *  Both proven false-positive classes killed one-shot sheets in the protocol
 *  experiment (R3a: 3/3 sheets over a single `width: 0px`; R3b rerun: the only
 *  two remaining refusals, 16px icons / 10px badges). The real risk of a
 *  wrongly-sized critical container is checkLayout's zero-size/narrow-content
 *  checks — post-act, baseline-diffed, auto-undo — the correct layer for it. */
function isFixedPxValue(v: string): boolean {
  const s = v.trim();
  if (!/^-?\d*\.?\d+px$/.test(s)) return false;
  return Math.abs(parseFloat(s)) >= INTRINSIC_COMPONENT_LIMIT_PX;
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

// ── T3 motion guard ─────────────────────────────────────────────────
// Transitions/animations on LAYOUT properties reflow the page on every
// animation frame — a transformation that makes the site lag is objectively
// broken, not stylistically bold. Same refuse-before-mutation position as the
// dominance gate. `transition: all` is refused too: it silently includes the
// layout properties. This is a safety rule for harmful defaults, not a
// creativity prison — transform/opacity/color transitions pass untouched.

const MOTION_PROPS = new Set(['transition', 'transition-property', 'animation', 'animation-name']);

/** Layout property tokens that must not be transitioned (exact token match —
 *  `border-width` is NOT `width`; margin/padding/inset families counted by prefix). */
function isLayoutMotionToken(t: string): boolean {
  if (/^(margin|padding|inset)(-|$)/.test(t)) return true;
  return ['width', 'height', 'top', 'left', 'right', 'bottom', 'all'].includes(t);
}

/** Scan parsed EmitItems for motion declarations that animate layout/reflow
 *  properties. Returns offending "property: value" strings (capped), empty when
 *  the sheet's motion is safe or absent. Pure. */
export function findLayoutMotion(items: EmitItem[]): string[] {
  const offending: string[] = [];
  const walk = (xs: EmitItem[]) => {
    for (const item of xs) {
      if (item.kind !== 'style') { if (item.kind === 'at' && !item.prelude.startsWith('@keyframes')) walk(item.items); continue; }
      for (const d of item.declarations) {
        const prop = d.property.toLowerCase();
        if (!MOTION_PROPS.has(prop)) continue;
        const tokens = d.value.toLowerCase().split(/[\s,()]+/).filter(Boolean);
        if (tokens.some(isLayoutMotionToken)) {
          if (offending.length < 4) offending.push(`${prop}: ${d.value.trim()}`);
        }
      }
    }
  };
  walk(items);
  return offending;
}

/**
 * Mechanical reduced-motion wrap for a sheet that declares motion: the SAME
 * selectors, transition/animation neutralised under prefers-reduced-motion.
 * No design decision is made here — this is the box-sizing:border-box of
 * motion (a mechanical correctness wrap, applied in applyCss when the sheet
 * declares motion). Selectors come from CSSOM selectorText (allSelectors), so
 * re-embedding them in a string is safe.
 */
export function buildReducedMotionCss(motionSelectors: string[]): string {
  if (motionSelectors.length === 0) return '';
  const rules = motionSelectors
    .map((s) => `  ${s} { transition: none !important; animation: none !important; }`)
    .join('\n');
  return `@media (prefers-reduced-motion: reduce) {\n${rules}\n}`;
}

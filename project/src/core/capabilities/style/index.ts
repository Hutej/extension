/**
 * capabilities/style — the Phase-1 primitive of the engine.
 *
 * Turns one open-ended declaration bag into a list of SAFE CSS declarations,
 * enforcing the browser laws that make an arbitrary AI spec trustworthy:
 *   - property allowlist (unknown/layout-dangerous keys dropped)
 *   - `background` shorthand, never background-color (Color Exp 003)
 *   - Contrast Lock: a background is never emitted without a coupled text color
 *   - box-sizing:border-box whenever a border/padding is added (Surface/Sizing)
 *   - appearance:none before surfacing native controls (Surface  Exp 002),
 *     except checkbox/radio which must keep native rendering
 *   - everything !important (Typography Exp / Precedence Exp 006)
 *
 * Future capabilities (structure/inject/act/...) will sit beside this one and
 * share the same "open-ended in, safe-ops out" shape.
 */

import { BASE_PROPS, INTERACTION_PROPS, BACKGROUND_KEYS, BOXING_KEYS, SURFACE_KEYS, isSafeValue, clampDisplayFont } from '../../laws/index.ts';
import type { StyleDecls } from '../../spec';
import { parseColor, pickReadableText, extractGradientStops, pickReadableTextForGradient } from '../../../shared/color.ts';

export interface BuildOptions {
  mode: 'base' | 'interaction';
  isNativeControl?: boolean;
  isCheckboxRadio?: boolean;
  /** Text color to fall back to when a background is set but its color can't be parsed. */
  defaultText?: string;
  /** Repair flag: force a readable text color on any rule that paints a background. */
  forceContrast?: boolean;
  /** Effective canvas background — under forceContrast, a rule that sets a text
   *  color but NO background gets its color made readable against this, so it
   *  can't be dark-on-dark on the redesigned canvas. */
  contrastBg?: string;
  /** The cluster's measured block width — display type in the styles bag is
   *  clamped to fit it, just like the layout bag (oversized type set via
   *  "styles" used to escape the clamp). */
  containerWidthPx?: number;
  /** CSS variable map from perception (--name → resolved rgb). Used to resolve
   *  var() backgrounds for contrast lock computation. */
  varMap?: Record<string, string>;
}

export interface BuildResult {
  decls: string[];
  dropped: string[];
}

export function buildDeclarations(input: StyleDecls, opts: BuildOptions): BuildResult {
  const map = opts.mode === 'interaction' ? INTERACTION_PROPS : BASE_PROPS;
  const out = new Map<string, string>(); // cssProp -> value (last wins, dedup)
  const dropped: string[] = [];

  let setsBackground = false;
  let hasExplicitColor = false;
  let needsBoxing = false;
  let touchesSurface = false;
  let bgValue = '';

  for (const [key, rawVal] of Object.entries(input)) {
    const cssProp = map[key];
    if (!cssProp) { dropped.push(key); continue; }
    let val = rawVal.trim();
    if (!isSafeValue(val)) { dropped.push(key + '(unsafe)'); continue; }

    // Display type set via the styles bag is clamped to fit its container too.
    if (cssProp === 'font-size') val = clampDisplayFont(val, opts.containerWidthPx);

    // Opacity floor: never let the model make a cluster invisible via opacity:0.
    // That's content destruction — same as hide but bypassing hideRefusal. If the
    // model wants to remove something, it must use "hide": true (which has guards).
    if (cssProp === 'opacity') {
      const num = parseFloat(val);
      if (!isNaN(num) && num < 0.1) { dropped.push(`opacity(${val}→dropped)`); continue; }
    }

    out.set(cssProp, val);
    if (BACKGROUND_KEYS.has(key)) { setsBackground = true; bgValue = val; }
    if (key === 'color') hasExplicitColor = true;
    if (BOXING_KEYS.has(key)) needsBoxing = true;
    if (SURFACE_KEYS.has(key)) touchesSurface = true;
  }

  // Contrast Lock — a background must never ship without a readable text color.
  // For a GRADIENT background, the text must contrast ≥4.5 against EVERY stop (text
  // over a light→dark gradient is invisible at the light end if the text is dark).
  // The Painter pair contract: a failing pair is deterministically corrected here.
  if (setsBackground && (!hasExplicitColor || opts.forceContrast)) {
    let parsed = parseColor(bgValue);
    // Resolve var() against the perception's CSS variable map for contrast computation.
    // The CSS output keeps the original var() value — the browser resolves it at render.
    if (!parsed && opts.varMap && bgValue.includes('var(')) {
      const resolved = resolveVar(bgValue, opts.varMap);
      if (resolved) parsed = parseColor(resolved);
    }
    let text: string;
    if (!parsed) {
      // A gradient (or other unparseable bg) — contrast-check against every stop.
      const stops = extractGradientStops(bgValue);
      if (stops.length > 0) {
        text = pickReadableTextForGradient(stops);
      } else {
        text = opts.defaultText || '';
      }
    } else {
      text = pickReadableText(parsed);
    }
    if (text && (opts.forceContrast || !hasExplicitColor)) out.set('color', text);
  } else if (opts.forceContrast && hasExplicitColor && opts.contrastBg) {
    let parsed = parseColor(opts.contrastBg);
    if (!parsed && opts.varMap && opts.contrastBg.includes('var(')) {
      const resolved = resolveVar(opts.contrastBg, opts.varMap);
      if (resolved) parsed = parseColor(resolved);
    }
    if (parsed) out.set('color', pickReadableText(parsed));
    else {
      // contrastBg is a gradient — pick readable text against every stop.
      const stops = extractGradientStops(opts.contrastBg);
      if (stops.length > 0) out.set('color', pickReadableTextForGradient(stops));
    }
  }

  // Box model safety — borders/padding require border-box or they shift geometry.
  if (needsBoxing) out.set('box-sizing', 'border-box');

  // Native control severance — required before surface upgrades take visual effect.
  if (opts.isNativeControl && !opts.isCheckboxRadio && touchesSurface) {
    out.set('appearance', 'none');
    out.set('-webkit-appearance', 'none');
  }

  const decls = Array.from(out.entries()).map(([p, v]) => `${p}: ${v} !important;`);
  return { decls, dropped };
}

/** Resolve var(--name) references in a CSS value using the perception's variable map. */
function resolveVar(value: string, varMap: Record<string, string>): string {
  return value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)/g, (_, name, fallback) => {
    if (varMap[name]) return varMap[name];
    if (fallback) return fallback.trim();
    return '';
  });
}

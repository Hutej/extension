/**
 * core/laws — browser-safety knowledge encoded as compiler guardrails.
 *
 * These are the hard-won priors from BROWSER_LAWS.md / CAPABILITY_JOURNAL.md,
 * distilled to the subset that the Phase-1 restyle compiler actually enforces.
 * They are REFERENCE, not scripture: the compiler is the single place that
 * guarantees safety, so every rule that matters lives here as data the engine
 * reads — never as scattered special-cases.
 *
 * Phase 1 is a PAINT-LAYER redesign: color, type, borders, radius, shadow,
 * backdrop, and safe inner spacing. Structural moves (width/position/margin/
 * display/flex/grid) are deliberately excluded here and owned by Phase 2.
 */

/**
 * Allowed style properties for BASE rules, mapped from the open-ended spec key
 * to the real CSS property emitted. Anything not in this map is dropped by the
 * compiler — that is what keeps an open-ended AI spec safe.
 *
 * `background` / `backgroundColor` both emit the `background` shorthand on
 * purpose (Color Exp 003: background-color paints *under* gradients/images and
 * silently fails; the shorthand nukes them).
 */
export const BASE_PROPS: Record<string, string> = {
  color: 'color',
  background: 'background',
  backgroundColor: 'background',
  backgroundImage: 'background-image',
  border: 'border',
  borderColor: 'border-color',
  borderWidth: 'border-width',
  borderStyle: 'border-style',
  borderTop: 'border-top',
  borderRight: 'border-right',
  borderBottom: 'border-bottom',
  borderLeft: 'border-left',
  borderRadius: 'border-radius',
  boxShadow: 'box-shadow',
  outline: 'outline',
  outlineOffset: 'outline-offset',
  outlineColor: 'outline-color',
  textShadow: 'text-shadow',
  textDecoration: 'text-decoration',
  textDecorationColor: 'text-decoration-color',
  textUnderlineOffset: 'text-underline-offset',
  textTransform: 'text-transform',
  letterSpacing: 'letter-spacing',
  wordSpacing: 'word-spacing',
  fontFamily: 'font-family',
  fontWeight: 'font-weight',
  fontStyle: 'font-style',
  fontSize: 'font-size',
  lineHeight: 'line-height',
  padding: 'padding',
  paddingTop: 'padding-top',
  paddingRight: 'padding-right',
  paddingBottom: 'padding-bottom',
  paddingLeft: 'padding-left',
  backdropFilter: 'backdrop-filter',
  filter: 'filter',
  opacity: 'opacity',
  transition: 'transition',
  cursor: 'cursor',
};

/**
 * Allowed properties for :hover / :focus-visible. Strictly compositor-safe
 * (Interaction Laws): transform/opacity/filter/box-shadow/color are the only
 * things that can animate without triggering layout thrash or hover flicker.
 * `transform` is allowed HERE only (never in base rules — that is movement).
 */
export const INTERACTION_PROPS: Record<string, string> = {
  transform: 'transform',
  opacity: 'opacity',
  filter: 'filter',
  boxShadow: 'box-shadow',
  color: 'color',
  background: 'background',
  backgroundColor: 'background',
  borderColor: 'border-color',
  outline: 'outline',
  outlineOffset: 'outline-offset',
  textDecoration: 'text-decoration',
  textDecorationColor: 'text-decoration-color',
  transition: 'transition',
};

/** Spec keys that count as "this rule paints a background" (drives the Contrast Lock). */
export const BACKGROUND_KEYS = new Set(['background', 'backgroundColor', 'backgroundImage']);

/** Spec keys that add box geometry and therefore require box-sizing:border-box (Surface/Sizing Laws). */
export const BOXING_KEYS = new Set([
  'border', 'borderWidth', 'borderTop', 'borderRight', 'borderBottom', 'borderLeft',
  'padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
]);

/** Spec keys that upgrade a surface — on native controls these need appearance:none first. */
export const SURFACE_KEYS = new Set([
  'background', 'backgroundColor', 'backgroundImage', 'border', 'borderColor',
  'borderWidth', 'borderStyle', 'borderRadius', 'boxShadow',
]);

/**
 * Allowed LAYOUT properties (capabilities/structure). This is the vocabulary that
 * lets a redesign change arrangement/sizing/spacing/type — not just paint.
 * Deliberately excludes position/top/left/float/inset and height (only min/max
 * height) because those are the layout footguns; safe reflow uses flex/grid/order.
 */
export const LAYOUT_PROPS: Record<string, string> = {
  width: 'width',
  maxWidth: 'max-width',
  minWidth: 'min-width',
  minHeight: 'min-height',
  maxHeight: 'max-height',
  display: 'display',
  gridTemplateColumns: 'grid-template-columns',
  gridTemplateRows: 'grid-template-rows',
  gridColumn: 'grid-column',
  gridRow: 'grid-row',
  gridAutoFlow: 'grid-auto-flow',
  gap: 'gap',
  rowGap: 'row-gap',
  columnGap: 'column-gap',
  flexDirection: 'flex-direction',
  flexWrap: 'flex-wrap',
  flexBasis: 'flex-basis',
  flexGrow: 'flex-grow',
  flexShrink: 'flex-shrink',
  flex: 'flex',
  justifyContent: 'justify-content',
  alignItems: 'align-items',
  alignContent: 'align-content',
  alignSelf: 'align-self',
  justifySelf: 'justify-self',
  placeItems: 'place-items',
  order: 'order',
  margin: 'margin',
  marginTop: 'margin-top',
  marginRight: 'margin-right',
  marginBottom: 'margin-bottom',
  marginLeft: 'margin-left',
  marginInline: 'margin-inline',
  marginBlock: 'margin-block',
  textAlign: 'text-align',
  columnCount: 'column-count',
};

/** Layout keys that grow the box and therefore require box-sizing:border-box. */
export const BOX_GROWTH_KEYS = new Set([
  'width', 'maxWidth', 'minWidth',
]);

/** Layout keys stripped by the overflow-repair pass (dropSizing). */
export const SIZING_KEYS = new Set(['width', 'flex', 'flexGrow', 'flexBasis', 'gridTemplateColumns']);

/** Verify thresholds. */
export const MIN_CONTRAST_RATIO = 4.5;
export const MAX_OVERFLOW_RATIO = 1.28;
export const CONTRAST_SAMPLE_COUNT = 8;

/**
 * Change/coherence thresholds. LENIENT by design: MIN_CHANGE_SCORE is LOW so only
 * an effectively-flat result (near-zero structural delta = the page reverted to
 * its original look) fails the `changed` check. Calibrated from logged real-run
 * scores — start low, never high. MAX_ACCENT_FRACTION caps how much of the
 * viewport a loud accent color may cover (kills "every link red").
 */
export const MIN_CHANGE_SCORE = 0.05;
export const MAX_ACCENT_FRACTION = 0.4;

/**
 * Framed-area ceiling — the border/frame analogue of the accent guard. If nearly
 * every surface carries a heavy border/offset-shadow, the design has no hierarchy
 * (the "border everything" failure). Generous: only flags near-universal framing.
 */
export const MAX_FRAMED_FRACTION = 0.78;

/** Two non-nested regions overlapping more than this fraction of the smaller = a layout collision. */
export const MAX_REGION_OVERLAP = 0.35;

/** The single injected style element id. Unlayered + appended last in <head> wins the cascade (Exp 006). */
export const STYLE_ELEMENT_ID = 'webmorph-style';

/**
 * Reject obviously dangerous values before they reach a declaration.
 * The CSS sanitizer is the real backstop (strips @import/expression/url), but
 * this keeps clearly-broken values out of the compiled output early.
 */
export function isSafeValue(value: string): boolean {
  if (!value || value.length > 2000) return false;
  const v = value.toLowerCase();
  if (v.includes('expression(') || v.includes('javascript:') || v.includes('</')) return false;
  if (v.includes('@import') || v.includes('-moz-binding')) return false;
  // Only allow url() pointing at https/data (matches sanitizer policy).
  const urls = v.match(/url\(([^)]*)\)/g);
  if (urls) {
    for (const u of urls) {
      const inner = u.replace(/url\(|\)|['"]/g, '').trim();
      if (!(inner.startsWith('data:') || inner.startsWith('https://') || inner === '' || inner.startsWith('#'))) {
        return false;
      }
    }
  }
  return true;
}

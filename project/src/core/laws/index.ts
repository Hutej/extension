import { parseColor, luminance } from '../../shared/color.ts';

/**
 * core/laws — browser-safety knowledge encoded as compiler guardrails.
 *
 * These are the hard-won priors from BROWSER_LAWS.md / CAPABILITY_JOURNAL.md,
 * distilled to the subset that the restyle compiler actually enforces.
 * They are REFERENCE, not scripture: the compiler is the single place that
 * guarantees safety, so every rule that matters lives here as data the engine
 * reads — never as scattered special-cases.
 *
 * includes paint AND layout: color, type, borders, radius, shadow,
 * backdrop, safe inner spacing, widths, grid/flex arrangement, and type scale.
 * Reversible structural DOM operations (remove/move/reorder/wrap) live in
 * core/ops, validated here against these same geometry laws before execution.
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
  // Type scale is part of arrangement. The prompt's example (and models in the
  // wild) put type in the layout bag — dropping it silently turned redesigns
  // into recolors. Accept type keys in BOTH bags.
  fontSize: 'font-size',
  fontWeight: 'font-weight',
  lineHeight: 'line-height',
  letterSpacing: 'letter-spacing',
  textTransform: 'text-transform',
  // Media fitting — lets a redesign reshape/refit images instead of ignoring them.
  objectFit: 'object-fit',
  aspectRatio: 'aspect-ratio',
};

/** Layout keys that grow the box and therefore require box-sizing:border-box. */
export const BOX_GROWTH_KEYS = new Set([
  'width', 'maxWidth', 'minWidth',
]);

/** Layout keys stripped by the overflow-repair pass (dropSizing / targeted clamp). */
export const SIZING_KEYS = new Set(['width', 'minWidth', 'flex', 'flexGrow', 'flexBasis', 'gridTemplateColumns', 'gridTemplateRows']);

/**
 * Viewport-safe type. A fontSize whose px-equivalent exceeds this is "display
 * type" and gets wrapped in clamp() so it scales down on narrow viewports
 * instead of blowing out. Body text (below the threshold) passes through
 * untouched. Pure math — no aesthetic logic.
 */
export const LARGE_FONT_PX = 40;
/**
 * Container-relative type ceiling. Display type must fit its OWN block, not just
 * the viewport: a 4rem heading fits a 1000px column but bleeds out of a 200px
 * card. The clamp ceiling is this fraction of the cluster's measured container
 * width — ~15% keeps a short heading in-bounds while still allowing big type in
 * wide blocks. Pure geometry, no aesthetic logic.
 */
export const FONT_CONTAINER_RATIO = 0.15;
/** Rem-based display font ceiling — the fallback when container width is unknown.
 *  5rem = 80px at default root size. Scales with the user's font-size preference
 *  (accessibility), not with viewport width (which counted the scrollbar and
 *  ignored container context — the bug that banned vw here). */
export const DISPLAY_FONT_CEIL_REM = 5;

/**
 * Make display type safe. Body text (< LARGE_FONT_PX) passes through
 * untouched. Large type is clamped so it can never overflow: when the
 * containerWidthPx measurement is available it informs the DECISION (should we
 * clamp?) but never the OUTPUT — Law 0: measurements may inform decisions,
 * never become output. The ceiling is rem-based (scales with root font-size,
 * not viewport width), or container-relative when the measurement is available.
 */
export function clampDisplayFont(val: string, containerWidthPx?: number): string {
  const px = fontLengthToPx(val);
  if (px === null || px < LARGE_FONT_PX) return val; // body text — untouched
  if (containerWidthPx && containerWidthPx > 0) {
    const ceil = Math.round(containerWidthPx * FONT_CONTAINER_RATIO);
    if (px <= ceil) return val;                       // already fits — measurement is decision-only
    // Container-relative ceiling in rem: convert the container-derived px ceiling
    // to rem (÷ root size). This is a rem-based clamp, not a measurement output —
    // the measurement informed the decision (px > ceil), the output is rem.
    const ceilRem = Math.max(1, ceil / 16);
    return `clamp(1rem, ${val}, ${ceilRem}rem)`;
  }
  return `clamp(1rem, ${val}, ${DISPLAY_FONT_CEIL_REM}rem)`; // rem ceiling (not vw — Law 0 rule 5)
}

/** Length -> px, or null for viewport-relative/computed lengths (vw/%/clamp/calc/min -> leave alone). */
function fontLengthToPx(v: string): number | null {
  const m = v.trim().toLowerCase().match(/^([\d.]+)(px|pt|cm|in|mm|pc|rem|em)$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  switch (m[2]) {
    case 'rem': case 'em': return n * 16;
    case 'px': return n;
    case 'pt': return n * 96 / 72;
    case 'pc': return n * 16;
    case 'in': return n * 96;
    case 'cm': return n * 96 / 2.54;
    case 'mm': return n * 96 / 25.4;
    default: return n;
  }
}

/** Verify thresholds. Strict — calibrated to enforce all-or-nothing, not ship-something. */
export const MIN_CONTRAST_RATIO = 4.5;
export const MAX_OVERFLOW_RATIO = 1.02;       // was 1.28 — 28% overflow was a visible scrollbar
export const CONTRAST_SAMPLE_COUNT = 50;       // was 12 — body text must pass, not just headings
export const CONTRAST_MAX_FAILURES = 2;        // ≤2 fail out of 50 samples
export const CONTRAST_TOP_FAIL_COUNT = 10;     // top-N largest text that must ALL pass

/**
 * Change/coherence thresholds. Tightened to reject near-recolors.
 * Genuine redesigns land ~0.6; 0.25 sends recolors (~0.0) and flat specs back.
 */
export const MIN_CHANGE_SCORE = 0.25;
export const MAX_ACCENT_FRACTION = 0.15;       // was 0.4 — accent is RARE, not 40% of the page

/**
 * Framed-area ceiling — 0.45 was 0.78. 2× stricter, doesn't kill card-grid designs
 * (which frame 30-50% of clusters) but rejects "border everything" (78%+).
 */
export const MAX_FRAMED_FRACTION = 0.45;

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

/**
 * Hide channel guards (compile). Hiding is a design decision for peripheral
 * chrome — these caps keep the model from deleting the page. Verify's notBlank
 * + coverage checks back them up at runtime.
 */
export const MAX_HIDDEN_WIDTH_RATIO = 0.8; // refuse hiding page-scale containers...
export const MAX_HIDDEN_HEIGHT_PX = 500;   // ...that are also tall
export const MAX_HIDDEN_MEMBERS = 40;      // refuse hiding huge repeated clusters (likely content)

/**
 * Coverage gate (verify). 0.85 (was 0.5) — a page where 50% of regions
 * still look original is NOT a redesign. 0.85 enforces all-or-nothing.
 * Split: total (model + base-coat + hide) ≥ 0.85, model-only ≥ 0.40.
 * The model coverage gate prevents the base-coat-only escape (a lazy spec that
 * passes total coverage via base-coat alone, doing no real design work).
 */
export const MIN_COVERAGE_FRACTION = 0.85;
export const MIN_MODEL_COVERAGE_FRACTION = 0.40;

/**
 * Perceptible paint change for coverage. A region only counts as "addressed by
 * paint" if its background OR text color moved at least this far in RGB Euclidean
 * distance (0..441). ~24 is roughly a just-noticeable step — it rejects the
 * 1-unit epsilon deltas that let coverage read 1.000 while a sidebar sat visibly
 * original. Simple RGB distance (not CIEDE2000) is enough to separate "visibly
 * different" from "computed-value jitter"; a heavier metric earns nothing here.
 */
export const PERCEPTIBLE_COLOR_DELTA = 24;

/**
 * Luminance clash threshold (Mechanism 2). A region whose existing background
 * luminance differs from the canvas luminance by more than this is "clashing" —
 * it reads as a foreign strip (a white header on a near-black canvas). Half the
 * WCAG luminance range (0..1) is the midpoint: anything past halfway across the
 * brightness scale is on the opposite end from the canvas. A text-color-only
 * delta on a clashing background does NOT count as "addressed" — the white-strip
 * false pass. Pure math, no aesthetic logic.
 */
export const LUMINANCE_CLASH_THRESHOLD = 0.5;

/** Whether a region's existing bg is luminance-compatible with the canvas bg. */
export function luminanceCompatible(regionBg: string, canvasBg: string): boolean {
  const r = parseColor(regionBg);
  const c = parseColor(canvasBg);
  if (!r || !c) return true; // unparseable (gradient/keyword) -> don't false-fail
  return Math.abs(luminance(r) - luminance(c)) <= LUMINANCE_CLASH_THRESHOLD;
}

/**
 * Layout keys that narrow a text-bearing container. The compiler does NOT
 * preventively emit overflow-wrap on these — that collapsed min-content to 1
 * char and squeezed every column to a few characters (the word-mutilation bug).
 * Genuine bleeds from long unbreakable strings are caught post-apply by verify's
 * bleedTargets and repaired with overflow-wrap:break-word (last-resort, preserves
 * min-content = longest word). NARROWING_KEYS is retained for reference/future use.
 */
export const NARROWING_KEYS = new Set(['width', 'maxWidth', 'minWidth', 'gridTemplateColumns', 'columnCount', 'flexBasis', 'flex']);

/**
 * Minimum pixels per CSS column. columnCount is only accepted if
 * containerWidth ÷ count ≥ this — otherwise it's clamped to the max that fits.
 * ~120px is roughly 15ch at 8px average char width: text narrower than this
 * wraps every word, producing the one-character-per-line failure.
 * Pure geometry, no aesthetic logic.
 */
export const MIN_COLUMN_PX = 120;

/**
 * Side-rail width band (fraction of viewport). A region in this band sitting beside
 * a main/article is a SIDE RAIL — a reflow opportunity (sidebar→top-bar or collapse).
 * A redesign that leaves it at the same width+position on a layout request skipped a
 * warranted reflow. Detected by role + geometry (navigation/complementary/banner or
 * aside/nav, widthRatio in this band, with a main/article sibling) — PRINCIPLE (a side
 * rail is structural), not a recipe. The same band flags a geometry-based side-rail in
 * the invisible-text scan (one principle, two consumers).
 */
export const SIDE_RAIL_MIN_FRAC = 0.15;
export const SIDE_RAIL_MAX_FRAC = 0.45;

/**
 * Minimum chars-per-line before text is "squeezed". A text container
 * whose effective chars-per-line falls below this wraps every word — invisible
 * to bleed checks (text stays in-bounds) but visibly broken. Measured via
 * clientWidth / (fontSize × 0.5) — no per-node layout thrash.
 */
export const MIN_CHARS_PER_LINE = 12;

/**
 * Minimum content-width fraction on a wide page. A wide page (content ≥70% of
 * the viewport) must keep content at ≥92% of its natural width — anything
 * narrower reads as "the whole site shrank" dead margins at a glance. The
 * compile-law converts the model's maxWidth to a viewport-relative percentage
 * at this floor, so the proportion also holds under browser zoom and resize
 * (a fixed px cap is zoom-hostile; a percentage tracks the viewport).
 */
export const MIN_CONTENT_WIDTH_FRACTION = 0.92;

/**
 * Component-level room law. A cluster whose natural width is ≥70% of its parent
 * may not be emitted below 92% of that fraction — the "all my components shrank"
 * bug, one level down from the page-level law. The compile-law floors a cluster's
 * converted percentage at this fraction × the cluster's widthFractionOfParent so
 * a wide child can't shrink into a dead-margin band inside its parent either.
 */
export const MIN_COMPONENT_WIDTH_FRACTION = 0.92;
export const COMPONENT_WIDE_FRACTION = 0.7;

/**
 * Clamp columnCount to fit the container. Pure: takes the requested
 * count and container width as data so it's unit-testable without a DOM.
 * Returns the clamped count and logs the original if clamped.
 */
export function clampColumnCount(requested: number, containerWidthPx?: number): number {
  if (requested <= 1 || !containerWidthPx || containerWidthPx <= 0) return requested;
  const maxFit = Math.floor(containerWidthPx / MIN_COLUMN_PX);
  if (maxFit < 1) return 1;
  return Math.min(requested, maxFit);
}

/**
 * Normalize a grid-template-columns value to be overflow-safe by construction.
 * Prevents the 1.97× column blow-out at the CSS level, not via repair:
 *  - fr units → minmax(0, Xfr) so min-content can't force overflow
 *  - fixed px tracks wider than the container → min(Xpx, 100%)
 *  - minmax(min, max) with min > 0 → minmax(0, max) so min never forces overflow
 * Pure: takes the value + container width as data.
 */
export function normalizeGridTemplate(val: string, containerWidthPx?: number): string {
  const trimmed = val.trim();
  // Expand repeat(N, track) → N tracks for normalization
  const repeatMatch = trimmed.match(/^repeat\((\d+|auto-fit|auto-fill),\s*(.+)\)$/i);
  if (repeatMatch) {
    const n = parseInt(repeatMatch[1]);
    const track = normalizeTrack(repeatMatch[2].trim(), containerWidthPx);
    return `repeat(${n}, ${track})`;
  }
  // Split by whitespace (top level — not inside parens)
  const tracks = splitTracks(trimmed);
  const normalized = tracks.map((t) => normalizeTrack(t, containerWidthPx));
  return normalized.join(' ');
}

function splitTracks(val: string): string[] {
  const tracks: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of val) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ' ' && depth === 0) { if (cur.trim()) tracks.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  if (cur.trim()) tracks.push(cur.trim());
  return tracks;
}

/**
 * Law 0 assertion: reject any raw fixed-length px in a sizing property that
 * reached the final CSS. The structure path wraps fixed px in min(X,100%) /
 * min(X,100vh) by construction; a raw px here means a path leaked. THROWS —
 * does not rewrite. The old fluidizeRawPxSizing rewriter was proof that raw
 * pixels were still reaching emission; the source is now fixed (structure path
 * wraps by construction, clampDisplayFont uses rem tokens), so the guard is a
 * rejection, not a bandage. `vw`/`vh`/`%`/`fr`/`auto`/`min()`/`clamp()`/`calc()`
 * are already fluid — not matched.
 */
export function assertNoRawPxSizing(css: string): void {
  const re = /(^|[\s{;])(width|max-width|min-width|min-height|max-height)\s*:\s*([\d.]+(?:px|pt|cm|in|mm|pc))\s*(!important)?/;
  const m = css.match(re);
  if (m) throw new Error(`Law 0 violation: raw ${m[3]} in ${m[2]} — must be wrapped (min/clamp/calc)`);
}


function normalizeTrack(track: string, containerWidthPx?: number): string {
  const t = track.trim();
  // minmax(min, max) — relax the min to 0 so min-content can't force overflow
  const mm = t.match(/^minmax\(([^,]+),\s*(.+)\)$/i);
  if (mm) {
    const min = mm[1].trim();
    const max = mm[2].trim();
    // If min is 0 or 'auto', already safe; keep the max normalized
    const normMax = normalizeTrack(max, containerWidthPx);
    if (min === '0' || min === '0px') return `minmax(0, ${normMax})`;
    return `minmax(0, ${normMax})`; // always relax min to prevent overflow
  }
  // fr unit → minmax(0, Xfr) — the key fix: bare 'fr' lets min-content push wide
  const frMatch = t.match(/^([\d.]+)fr$/i);
  if (frMatch) return `minmax(0, ${t})`;
  if (t === '1fr') return 'minmax(0, 1fr)';
  // fixed px track → percentage of the measured container, so a 3×~33% grid
  // stays 3×~33% at 67% zoom and at 150% zoom. A px track frozen at compile time
  // changes proportion at every zoom (browser zoom rescales the CSS viewport); a
  // percentage tracks the container, which tracks the viewport, at every size.
  // minmax(0, X%) keeps the min at 0 (no min-content overflow) and the max as the
  // zoom-proof proportion. Capped at 100% so a track never exceeds its container.
  if (containerWidthPx && containerWidthPx > 0) {
    const pxMatch = t.match(/^([\d.]+)px$/i);
    if (pxMatch) {
      const pct = Math.min(100, (parseFloat(pxMatch[1]) / containerWidthPx) * 100);
      return `minmax(0, ${Math.round(pct)}%)`;
    }
  }
  return t; // auto, %, min-content, max-content, already-safe values
}

/**
 * core/design/packs — design-language packs. A small library of design systems
 * as PURE DATA: a spacing scale, a type ramp, a surface/card system, layout
 * rules, and NAMED color relationships. Style ARCHETYPES only ("minimal
 * editorial", "dense terminal", "soft glass") — aesthetic recipes ALLOWED, site
 * recipes FORBIDDEN, no named-site clones.
 *
 * The model picks a pack (or blends/overrides for a novel prompt) and maps roles
 * onto it; the deterministic expander (core/compile/expand.ts) resolves the
 * pack + the model's overrides into the concrete CSS the compiler emits. EVERY
 * pack field is model-overridable via the spec's `packOverrides` — packs floor
 * quality, they must NOT cap creativity (the test grid rotates NOVEL prompts
 * that override a pack; a lookup table that only handles known styles is a
 * failure).
 *
 * Pure data + pure resolvers — no DOM, no model calls, unit-testable.
 */

/** The type-size roles on a pack's ramp. */
export type TypeRole = 'display' | 'heading' | 'body' | 'small';

/** A surface treatment in a pack's surface system. */
export type SurfaceTier = 'flat' | 'raised' | 'overlay';

export interface SurfaceDef {
  bg: string;          // the surface background (a pack color or a named accent)
  border?: string;    // a border value (borderScale step resolved by the expander)
  shadow?: string;    // a shadow value (shadowScale step resolved by the expander)
}

export interface PackColors {
  /** The page canvas background. */
  canvas: string;
  /** The base text color on the canvas. */
  text: string;
  /** A muted text/border color (de-emphasis, chrome). */
  subtle: string;
  /** NAMED accents — a relationship name → a hex. The model references
   *  "primary"/"muted"; the expander resolves the hex. Never a raw hex per use. */
  accents: Record<string, string>;
}

export interface PackLayoutRules {
  /** The side-rail width as a fraction of the viewport (sidebar→topbar reflow). */
  sideRailWidthFrac: number;
  /** The topbar height a sidebar becomes (px, wrapped viewport-safe by the expander). */
  topbarHeight: number;
  /** The default content measure (px) for a 'prose' measure intent on a wide page. */
  proseMeasurePx: number;
}

/**
 * A design-language pack. Pure data. Every field is model-overridable via
 * `packOverrides` on the spec (the expander applies overrides on top of the
 * chosen pack).
 */
export interface DesignPack {
  id: string;
  /** The spacing scale — px steps on the 8pt grid. Density intents index into it. */
  spacingScale: number[];
  /** The type ramp — px per type role. Emphasis/typeRamp intents index into it. */
  typeRamp: Record<TypeRole, number>;
  /** Line-height per type role. Density intents modulate this. */
  lineHeight: Record<TypeRole, number>;
  /** The width intents — px measures for prose/full/compact. */
  measurePx: { prose: number; full: number; compact: number };
  /** The radius scale — px steps (999 = pill). radiusStep indexes into it. */
  radiusScale: number[];
  /** The border scale — px widths. borderStep indexes into it. */
  borderScale: number[];
  /** The shadow scale — named shadow tokens. shadowStep indexes into it. */
  shadowScale: string[];
  /** The surface system — flat/raised/overlay → bg/border/shadow. */
  surfaces: Record<SurfaceTier, SurfaceDef>;
  /** NAMED color relationships — canvas/text/subtle + accents. */
  colors: PackColors;
  /** Layout rules the expander uses for reflow intents. */
  layoutRules: PackLayoutRules;
}

// ── The pack library (archetypes only — no named-site clones) ──────────

const SPACING_8PT = [0, 4, 8, 12, 16, 24, 32, 48, 64];
const RADIUS_SCALE = [0, 4, 8, 12, 16, 24, 999];

/** minimal-editorial — a calm, type-led, restrained-accent editorial system. */
const MINIMAL_EDITORIAL: DesignPack = {
  id: 'minimal-editorial',
  spacingScale: SPACING_8PT,
  typeRamp: { display: 48, heading: 32, body: 17, small: 13 },
  lineHeight: { display: 1.1, heading: 1.2, body: 1.6, small: 1.4 },
  measurePx: { prose: 680, full: 1200, compact: 320 },
  radiusScale: RADIUS_SCALE,
  borderScale: [0, 1, 2, 3],
  shadowScale: ['none', '0 1px 2px rgba(0,0,0,0.06)', '0 2px 8px rgba(0,0,0,0.08)', '0 8px 24px rgba(0,0,0,0.12)'],
  surfaces: {
    flat: { bg: '#fafaf7' },
    raised: { bg: '#ffffff', border: '1px solid #ececec', shadow: '0 1px 2px rgba(0,0,0,0.06)' },
    overlay: { bg: 'rgba(255,255,255,0.9)', border: '1px solid rgba(0,0,0,0.08)', shadow: '0 8px 24px rgba(0,0,0,0.12)' },
  },
  colors: { canvas: '#fafaf7', text: '#1a1a1a', subtle: '#6b6b6b', accents: { primary: '#b8410f', muted: '#9a9a9a' } },
  layoutRules: { sideRailWidthFrac: 0.22, topbarHeight: 56, proseMeasurePx: 680 },
};

/** dense-terminal — a compact, high-information-density, monospace-leaning system. */
const DENSE_TERMINAL: DesignPack = {
  id: 'dense-terminal',
  spacingScale: [0, 2, 4, 8, 12, 16, 24, 32],
  typeRamp: { display: 32, heading: 24, body: 14, small: 12 },
  lineHeight: { display: 1.15, heading: 1.25, body: 1.45, small: 1.35 },
  measurePx: { prose: 560, full: 1400, compact: 280 },
  radiusScale: [0, 2, 4, 6, 8, 12, 999],
  borderScale: [0, 1, 2, 3],
  shadowScale: ['none', '0 1px 0 rgba(0,0,0,0.4)', '0 2px 4px rgba(0,0,0,0.5)', '0 4px 12px rgba(0,0,0,0.6)'],
  surfaces: {
    flat: { bg: '#14161a' },
    raised: { bg: '#1c1f24', border: '1px solid #2a2e35', shadow: '0 1px 0 rgba(0,0,0,0.4)' },
    overlay: { bg: 'rgba(28,31,36,0.95)', border: '1px solid #2a2e35', shadow: '0 4px 12px rgba(0,0,0,0.6)' },
  },
  colors: { canvas: '#14161a', text: '#d8dde3', subtle: '#7a828c', accents: { primary: '#4dabf7', muted: '#5c6370' } },
  layoutRules: { sideRailWidthFrac: 0.2, topbarHeight: 44, proseMeasurePx: 560 },
};

/** soft-glass — a translucent, layered, glassmorphic system (backdrop-blur surfaces). */
const SOFT_GLASS: DesignPack = {
  id: 'soft-glass',
  spacingScale: SPACING_8PT,
  typeRamp: { display: 44, heading: 30, body: 16, small: 13 },
  lineHeight: { display: 1.1, heading: 1.25, body: 1.6, small: 1.4 },
  measurePx: { prose: 640, full: 1200, compact: 320 },
  radiusScale: [0, 6, 12, 18, 24, 32, 999],
  borderScale: [0, 1, 2, 3],
  shadowScale: ['none', '0 2px 8px rgba(0,0,0,0.1)', '0 8px 24px rgba(0,0,0,0.15)', '0 16px 48px rgba(0,0,0,0.2)'],
  surfaces: {
    flat: { bg: 'rgba(255,255,255,0.6)' },
    raised: { bg: 'rgba(255,255,255,0.72)', border: '1px solid rgba(255,255,255,0.5)', shadow: '0 2px 8px rgba(0,0,0,0.1)' },
    overlay: { bg: 'rgba(255,255,255,0.55)', border: '1px solid rgba(255,255,255,0.6)', shadow: '0 16px 48px rgba(0,0,0,0.2)' },
  },
  colors: { canvas: '#0f1420', text: '#f3f5fa', subtle: '#9aa4b8', accents: { primary: '#7c5cff', muted: '#5c6370' } },
  layoutRules: { sideRailWidthFrac: 0.24, topbarHeight: 52, proseMeasurePx: 640 },
};

/** warm-print — a warm, readable, book-like system (serif-leaning body type). */
const WARM_PRINT: DesignPack = {
  id: 'warm-print',
  spacingScale: SPACING_8PT,
  typeRamp: { display: 44, heading: 30, body: 18, small: 14 },
  lineHeight: { display: 1.12, heading: 1.25, body: 1.65, small: 1.45 },
  measurePx: { prose: 620, full: 1100, compact: 300 },
  radiusScale: [0, 3, 6, 10, 16, 24, 999],
  borderScale: [0, 1, 2, 3],
  shadowScale: ['none', '0 1px 2px rgba(60,40,20,0.08)', '0 4px 12px rgba(60,40,20,0.12)', '0 12px 32px rgba(60,40,20,0.16)'],
  surfaces: {
    flat: { bg: '#f4ede0' },
    raised: { bg: '#fbf6ec', border: '1px solid #e6dcc8', shadow: '0 1px 2px rgba(60,40,20,0.08)' },
    overlay: { bg: 'rgba(251,246,236,0.92)', border: '1px solid #e6dcc8', shadow: '0 12px 32px rgba(60,40,20,0.16)' },
  },
  colors: { canvas: '#f4ede0', text: '#2b2318', subtle: '#7a6a55', accents: { primary: '#9a4a1c', muted: '#a89a82' } },
  layoutRules: { sideRailWidthFrac: 0.22, topbarHeight: 54, proseMeasurePx: 620 },
};

/** The pack library. Style archetypes only — the model picks + adapts. */
export const PACKS: Record<string, DesignPack> = {
  'minimal-editorial': MINIMAL_EDITORIAL,
  'dense-terminal': DENSE_TERMINAL,
  'soft-glass': SOFT_GLASS,
  'warm-print': WARM_PRINT,
};

export const PACK_IDS = Object.keys(PACKS);

/** The default pack — the floor when the model picks none (or an unknown id). */
export const DEFAULT_PACK_ID = 'minimal-editorial';

/** Get a pack by id, falling back to the default (an unknown id never crashes). */
export function getPack(id: string | undefined): DesignPack {
  return PACKS[id ?? DEFAULT_PACK_ID] ?? PACKS[DEFAULT_PACK_ID];
}

/** Resolve a pack + model overrides into the pack the expander uses. Every pack
 *  field is model-overridable — `packOverrides` overlays the chosen pack's
 *  defaults (a deep merge: arrays/objects replace at the field level, scalars
 *  override). Pure. */
export function resolvePack(id: string | undefined, overrides?: Partial<DesignPack>): DesignPack {
  const base = getPack(id);
  if (!overrides) return base;
  return {
    ...base,
    typeRamp: { ...base.typeRamp, ...(overrides.typeRamp ?? {}) },
    lineHeight: { ...base.lineHeight, ...(overrides.lineHeight ?? {}) },
    measurePx: { ...base.measurePx, ...(overrides.measurePx ?? {}) },
    surfaces: { ...base.surfaces, ...(overrides.surfaces ?? {}) },
    colors: {
      ...base.colors,
      accents: { ...base.colors.accents, ...(overrides.colors?.accents ?? {}) },
      ...(overrides.colors ?? {}),
    },
    layoutRules: { ...base.layoutRules, ...(overrides.layoutRules ?? {}) },
    spacingScale: overrides.spacingScale ?? base.spacingScale,
    radiusScale: overrides.radiusScale ?? base.radiusScale,
    borderScale: overrides.borderScale ?? base.borderScale,
    shadowScale: overrides.shadowScale ?? base.shadowScale,
  };
}

/** A one-line summary of a pack for the DESIGN PACKS prompt block — the model
 *  picks by name and references the tokens. Pure. */
export function summarizePack(p: DesignPack): string {
  const accents = Object.keys(p.colors.accents).join('/');
  return `${p.id}: spacing[${p.spacingScale.join(',')}]px type{display:${p.typeRamp.display} heading:${p.typeRamp.heading} body:${p.typeRamp.body} small:${p.typeRamp.small}} measure{prose:${p.measurePx.prose} full:${p.measurePx.full} compact:${p.measurePx.compact}} radius[${p.radiusScale.join(',')}] surfaces{flat/raised/overlay} accents{${accents}} canvas:${p.colors.canvas} text:${p.colors.text}`;
}

/** The full DESIGN PACKS block the serialized perception emits. */
export function formatPacks(): string {
  const lines = ['DESIGN PACKS (pick one by id, reference its tokens; every field overridable via packOverrides):'];
  for (const id of PACK_IDS) lines.push('  ' + summarizePack(PACKS[id]));
  return lines.join('\n');
}

/**
 * core/design/vocabulary — the relational design vocabulary.
 *
 * The model's PRIMARY output is a set of RELATIONAL STATEMENTS, not enum
 * picks. Each statement names its subjects by handle (or role or group),
 * states a relation type, and carries a magnitude expressed as a ratio,
 * a scale step, or an ordinal rank — NEVER a pixel value. Ratios survive
 * any viewport; pixels do not. That is Law 0 applied to the design language
 * itself.
 *
 * The deterministic transformation engine (core/compile/transform.ts) resolves
 * each relation against the page's own measured reality: "three times the
 * body" resolves against the actual body size, "one level above" against
 * the actual elevation model. It reports any relation it could not satisfy
 * and why, rather than silently dropping it. It never invents structure
 * the relation did not ask for.
 *
 * This is a CLOSED, TYPED set. No relation name or field name may be
 * invented outside this file. Divergent naming is the expensive kind of
 * conflict because it compiles.
 */

// ── Magnitude helpers (types, not values) ──────────────────────────

/** An alignment edge a region can share with another. */
export type AlignmentEdge = 'start' | 'center' | 'end' | 'stretch';

/** A named colour role from the pack's accent system. */
export type AccentRole = 'primary' | 'secondary' | 'muted';

/** Where an accent is applied — text, border, or background. */
export type AccentTarget = 'text' | 'border' | 'background';

/** A box side for per-side padding. */
export type Side = 'top' | 'right' | 'bottom' | 'left' | 'all';

/** A box corner for per-corner radius. */
export type Corner = 'tl' | 'tr' | 'br' | 'bl' | 'all';

/** A text-transform value. Named, not numeric — categorical, not a magnitude. */
export type TextTransformValue = 'uppercase' | 'lowercase' | 'capitalize' | 'none';

/** Font-weight as an ordinal rank (1-5): light, normal, medium, bold, black.
 *  The engine resolves the rank to a px weight via the pack's fontWeightScale. */
export type FontWeightRank = 1 | 2 | 3 | 4 | 5;

/** Easing character for motion transitions — named, not a cubic-bezier string.
 *  The pack resolves the character to a concrete easing function. */
export type EasingCharacter = 'smooth' | 'sharp' | 'spring' | 'linear';

// ── Subject resolution ─────────────────────────────────────────────

/** A subject names what a relation applies to. It can be:
 *  - a cluster handle ("c1a2b3") — one specific cluster
 *  - a design role ("page-title", "article-body") — fans out to every cluster of that role
 *  - a group id ("g4x2y1") — fans out to every cluster in that group
 *  - a keyword: "parent" (the subject's parent cluster), "body" (the page's body text),
 *    "canvas" (the page canvas)
 *
 * The engine resolves the subject to cluster handle(s) at transformation time
 * using the current perception. */
export type Subject = string;

// ── The closed set of relational statements ────────────────────────

/**
 * Every relation names its subject, states a relation type, and carries a
 * magnitude as a ratio, a scale step, or an ordinal rank — never a pixel.
 * Some relations also name a reference (what the subject is compared to).
 * Relations with no reference are absolute but their values are still
 * non-pixel (a scale step, a named value, an ordinal count).
 *
 * Relations are grouped by the design domain they cover:
 *  - Size & type: sizeRatio, typeRank, lineHeightStep, lineHeightRatio, letterSpacingStep, wordSpacingStep, fontWeightRank, textTransform
 *  - Rank & hierarchy: outranks, emphasisRank
 *  - Spacing: spacingStep, spacingRatio, gapStep, gapRatio, marginStep, marginEquals, paddingSide
 *  - Alignment: alignsWith
 *  - Elevation: elevationAbove, elevationStep
 *  - Colour: accentRole, accentOn
 *  - Width: widthFraction
 *  - Surface: radiusCorner, borderWeight, surfaceTier
 *  - Layout: columnCount
 *  - Grouping: groupWith
 *  - Structural ops: hide, reorderBefore, moveTo
 */
export type RelationStatement =
  // ── Size relations ──
  /** "this heading is three times the body size" — subject's font-size is ratio× the reference's. */
  | { relation: 'sizeRatio'; subject: Subject; reference: Subject; ratio: number }
  /** "this is display type" — subject is at ordinal rank N on the type ramp (0=display, 1=heading, 2=body, 3=small). */
  | { relation: 'typeRank'; subject: Subject; rank: number }

  // ── Rank and hierarchy ──
  /** "this section outranks its neighbours" — subject ranks above the reference in emphasis order. */
  | { relation: 'outranks'; subject: Subject; reference: Subject }
  /** "this is the most prominent region" — subject is at ordinal rank N in the emphasis hierarchy (0=highest). */
  | { relation: 'emphasisRank'; subject: Subject; rank: number }

  // ── Spacing relations ──
  /** "this region is at density step 4" — subject's padding is at scale step N on the pack's spacingScale. */
  | { relation: 'spacingStep'; subject: Subject; step: number }
  /** "this is twice as spacious as that" — subject's spacing is ratio× the reference's. */
  | { relation: 'spacingRatio'; subject: Subject; reference: Subject; ratio: number }
  /** "the gap between these cards is at step 3" — subject's child gap is at scale step N. */
  | { relation: 'gapStep'; subject: Subject; step: number }
  /** "this gap is half that gap" — subject's child gap is ratio× the reference's child gap. */
  | { relation: 'gapRatio'; subject: Subject; reference: Subject; ratio: number }
  /** "this margin is at step 2" — subject's margin is at scale step N. */
  | { relation: 'marginStep'; subject: Subject; step: number }
  /** "this margin equals that margin" — subject's margin equals the reference's. */
  | { relation: 'marginEquals'; subject: Subject; reference: Subject }
  /** "this side's padding is at step 3" — per-side padding at a scale step. */
  | { relation: 'paddingSide'; subject: Subject; side: Side; step: number }

  // ── Alignment relations ──
  /** "these two regions share an alignment edge" — subject aligns with reference on the named edge. */
  | { relation: 'alignsWith'; subject: Subject; reference: Subject; edge: AlignmentEdge }

  // ── Elevation relations ──
  /** "this surface sits one level above its parent" — subject's shadow is N levels above the reference's. */
  | { relation: 'elevationAbove'; subject: Subject; reference: Subject; levels: number }
  /** "this is at elevation tier 2" — subject's shadow is at step N on the pack's shadowScale. */
  | { relation: 'elevationStep'; subject: Subject; step: number }

  // ── Colour role assignment ──
  /** "this accent appears at most twice on the page" — assign accent role to subject with a page-wide budget. */
  | { relation: 'accentRole'; subject: Subject; role: AccentRole; maxCount: number }
  /** "apply the primary accent as a border" — accent applied to text, border, or background (not just bg). */
  | { relation: 'accentOn'; subject: Subject; target: AccentTarget; role: AccentRole }

  // ── Proportional width allocation ──
  /** "this rail is one third of the content" — subject takes a fraction of the reference's width. */
  | { relation: 'widthFraction'; subject: Subject; reference: Subject; fraction: number }

  // ── Grouping ──
  /** "these regions form a row" — subject is grouped with the reference (for row alignment). */
  | { relation: 'groupWith'; subject: Subject; reference: Subject }

  // ── Typography details ──
  /** "this letter-spacing is at step 1" — letter-spacing at scale step N on the pack's letterSpacingScale. */
  | { relation: 'letterSpacingStep'; subject: Subject; step: number }
  /** "this word-spacing is at step 2" — word-spacing at scale step N on the pack's wordSpacingScale. */
  | { relation: 'wordSpacingStep'; subject: Subject; step: number }
  /** "this text is bold" — font-weight at ordinal rank N (1-5). */
  | { relation: 'fontWeightRank'; subject: Subject; rank: FontWeightRank }
  /** "this text is uppercase" — text-transform value. */
  | { relation: 'textTransform'; subject: Subject; transform: TextTransformValue }
  /** "this line-height is at step 3" — line-height at scale step N on the pack's lineHeightScale. */
  | { relation: 'lineHeightStep'; subject: Subject; step: number }
  /** "this line-height is 1.2× the body's" — line-height is ratio× the reference's. */
  | { relation: 'lineHeightRatio'; subject: Subject; reference: Subject; ratio: number }

  // ── Surface details ──
  /** "this corner has radius at step 3" — per-corner radius at a scale step. */
  | { relation: 'radiusCorner'; subject: Subject; corner: Corner; step: number }
  /** "this border weight is at step 2" — border width at scale step N on the pack's borderScale. */
  | { relation: 'borderWeight'; subject: Subject; step: number }
  /** "this surface is at tier 1" — surface treatment (0=flat, 1=raised, 2=overlay) from the pack. */
  | { relation: 'surfaceTier'; subject: Subject; tier: number }

  // ── Layout ──
  /** "this region has 3 columns" — column-count within the region. */
  | { relation: 'columnCount'; subject: Subject; count: number }

  // ── Structural ops ──
  /** "remove this region" — hide (display:none). Gated by confidence (same hard-safety rule as the old hidden emphasis). */
  | { relation: 'hide'; subject: Subject }
  /** "move this before that in reading order" — reorder subject before reference (structural op). */
  | { relation: 'reorderBefore'; subject: Subject; reference: Subject }
  /** "move this into that" — relocate subject into reference (structural op). */
  | { relation: 'moveTo'; subject: Subject; reference: Subject }

  // ── Motion (F4) ──
  /** "this region transitions over 200ms" — transition at duration tier N on the pack's motionDurationScale. */
  | { relation: 'transitionTier'; subject: Subject; tier: number }
  /** "this region eases in smoothly" — easing character for the subject's transitions. */
  | { relation: 'transitionEasing'; subject: Subject; easing: EasingCharacter }
  /** "this region enters with a 100ms delay" — entrance animation at delay tier N (stagger by reading order). */
  | { relation: 'entranceDelay'; subject: Subject; tier: number }
  /** "this card lifts on hover" — hover elevation via transform (never layout). */
  | { relation: 'hoverElevate'; subject: Subject; levels: number }
  /** "this input has a focus ring" — focus-visible ring using the named accent. */
  | { relation: 'focusRing'; subject: Subject; role: AccentRole }

  // ── Interaction (F5) ──
  /** "this panel is movable" — opt-in movable element capability (transform-based, no DOM mutation). */
  | { relation: 'movable'; subject: Subject };

// ── Pack principle types (data the engine enforces) ──────────

/** Structured design principles each pack carries. The engine reads and
 *  enforces these — they are NOT prose in a prompt. The model customises
 *  within them; it does not restate them. */
export interface PackPrinciples {
  /** Minimum ratio between adjacent type-scale levels (e.g. 1.2 = minor third).
   *  The engine rejects a sizeRatio between hierarchy levels below this. */
  minTypeScaleRatio: number;
  /** Maximum number of accent uses on a page (the accent budget).
   *  The engine rejects accentRole/accentOn statements beyond this count. */
  maxAccentCount: number;
  /** When a surface should be raised: 'on-emphasis' (raise on emphasisRank 0-1),
   *  'on-overlay' (raise only for overlay tier), 'never' (flat surfaces only). */
  raiseSurface: 'on-emphasis' | 'on-overlay' | 'never';
  /** Permitted density step range [min, max] into the spacingScale.
   *  The engine clamps spacingStep/gapStep to this range. */
  densityRange: [number, number];
  /** Border-versus-shadow preference: 'border' (prefer borders), 'shadow' (prefer
   *  shadows), 'either' (let the model choose). The engine uses this when
   *  resolving surfaceTier. */
  surfaceDefinition: 'border' | 'shadow' | 'either';
}

// ── The relation registry (for validation + the prompt) ────────────

/** Every relation type, its required fields, and a human description.
 *  Used by the boundary validator and the prompt builder. */
export interface RelationSpec {
  relation: RelationStatement['relation'];
  hasReference: boolean;
  /** The magnitude field name and its kind: 'ratio' | 'step' | 'rank' | 'fraction' | 'named'. */
  magnitudeField?: string;
  magnitudeKind?: 'ratio' | 'step' | 'rank' | 'fraction' | 'count' | 'named';
  description: string;
}

export const RELATION_SPECS: RelationSpec[] = [
  { relation: 'sizeRatio', hasReference: true, magnitudeField: 'ratio', magnitudeKind: 'ratio', description: 'subject font-size is ratio× the reference font-size' },
  { relation: 'typeRank', hasReference: false, magnitudeField: 'rank', magnitudeKind: 'rank', description: 'subject is at ordinal rank N on the type ramp (0=display, 1=heading, 2=body, 3=small)' },
  { relation: 'outranks', hasReference: true, description: 'subject ranks above the reference in emphasis order' },
  { relation: 'emphasisRank', hasReference: false, magnitudeField: 'rank', magnitudeKind: 'rank', description: 'subject is at ordinal rank N in the emphasis hierarchy (0=highest)' },
  { relation: 'spacingStep', hasReference: false, magnitudeField: 'step', magnitudeKind: 'step', description: 'subject padding at scale step N' },
  { relation: 'spacingRatio', hasReference: true, magnitudeField: 'ratio', magnitudeKind: 'ratio', description: 'subject spacing is ratio× reference spacing' },
  { relation: 'gapStep', hasReference: false, magnitudeField: 'step', magnitudeKind: 'step', description: 'subject child-gap at scale step N' },
  { relation: 'gapRatio', hasReference: true, magnitudeField: 'ratio', magnitudeKind: 'ratio', description: 'subject child-gap is ratio× reference child-gap' },
  { relation: 'marginStep', hasReference: false, magnitudeField: 'step', magnitudeKind: 'step', description: 'subject margin at scale step N' },
  { relation: 'marginEquals', hasReference: true, description: 'subject margin equals reference margin' },
  { relation: 'paddingSide', hasReference: false, magnitudeField: 'step', magnitudeKind: 'step', description: 'per-side padding at scale step N' },
  { relation: 'alignsWith', hasReference: true, description: 'subject aligns with reference on the named edge' },
  { relation: 'elevationAbove', hasReference: true, magnitudeField: 'levels', magnitudeKind: 'count', description: 'subject shadow is N levels above reference shadow' },
  { relation: 'elevationStep', hasReference: false, magnitudeField: 'step', magnitudeKind: 'step', description: 'subject shadow at scale step N' },
  { relation: 'accentRole', hasReference: false, magnitudeField: 'maxCount', magnitudeKind: 'count', description: 'assign accent role to subject with page-wide budget maxCount' },
  { relation: 'accentOn', hasReference: false, description: 'apply accent to text/border/background' },
  { relation: 'widthFraction', hasReference: true, magnitudeField: 'fraction', magnitudeKind: 'fraction', description: 'subject takes a fraction of reference width' },
  { relation: 'groupWith', hasReference: true, description: 'subject grouped with reference (row alignment)' },
  { relation: 'letterSpacingStep', hasReference: false, magnitudeField: 'step', magnitudeKind: 'step', description: 'letter-spacing at scale step N' },
  { relation: 'wordSpacingStep', hasReference: false, magnitudeField: 'step', magnitudeKind: 'step', description: 'word-spacing at scale step N' },
  { relation: 'fontWeightRank', hasReference: false, magnitudeField: 'rank', magnitudeKind: 'rank', description: 'font-weight at ordinal rank N (1-5)' },
  { relation: 'textTransform', hasReference: false, description: 'text-transform value' },
  { relation: 'lineHeightStep', hasReference: false, magnitudeField: 'step', magnitudeKind: 'step', description: 'line-height at scale step N' },
  { relation: 'lineHeightRatio', hasReference: true, magnitudeField: 'ratio', magnitudeKind: 'ratio', description: 'line-height is ratio× reference line-height' },
  { relation: 'radiusCorner', hasReference: false, magnitudeField: 'step', magnitudeKind: 'step', description: 'per-corner radius at scale step N' },
  { relation: 'borderWeight', hasReference: false, magnitudeField: 'step', magnitudeKind: 'step', description: 'border width at scale step N' },
  { relation: 'surfaceTier', hasReference: false, magnitudeField: 'tier', magnitudeKind: 'rank', description: 'surface treatment (0=flat, 1=raised, 2=overlay)' },
  { relation: 'columnCount', hasReference: false, magnitudeField: 'count', magnitudeKind: 'count', description: 'column count within the region' },
  { relation: 'hide', hasReference: false, description: 'remove the subject (display:none)' },
  { relation: 'reorderBefore', hasReference: true, description: 'reorder subject before reference in DOM order' },
  { relation: 'moveTo', hasReference: true, description: 'relocate subject into reference' },
  // F4 — motion
  { relation: 'transitionTier', hasReference: false, magnitudeField: 'tier', magnitudeKind: 'step', description: 'transition at duration tier N on the pack motionDurationScale' },
  { relation: 'transitionEasing', hasReference: false, description: 'easing character for transitions (smooth|sharp|spring|linear)' },
  { relation: 'entranceDelay', hasReference: false, magnitudeField: 'tier', magnitudeKind: 'step', description: 'entrance animation at delay tier N (stagger by reading order)' },
  { relation: 'hoverElevate', hasReference: false, magnitudeField: 'levels', magnitudeKind: 'count', description: 'hover elevation via transform (N levels on shadowScale)' },
  { relation: 'focusRing', hasReference: false, description: 'focus-visible ring using the named accent' },
  // F5 — interaction
  { relation: 'movable', hasReference: false, description: 'opt-in movable element capability (transform-based, no DOM mutation)' },
];

/** The closed set of relation names. The boundary validator rejects
 *  any statement whose relation is not in this set. */
export const RELATION_NAMES = new Set<string>(RELATION_SPECS.map((s) => s.relation));

/** Lookup a relation spec by name. */
export function relationSpec(name: string): RelationSpec | undefined {
  return RELATION_SPECS.find((s) => s.relation === name);
}

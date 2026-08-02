/**
 * core/spec — the DSL the AI emits and the compiler consumes.
 *
 * OPEN-ENDED (any tokens/values) but STRUCTURED (validated shape, real handles).
 * The compiler — not the AI — decides which declarations are safe to emit.
 *
 * Phase 2: the PRIMARY model output is per-role design INTENTS (RoleIntent[]),
 * not raw declarations. A deterministic expander (core/compile/expand.ts) maps
 * intents + a design-language pack + the Phase 1 semantic graph to the
 * concrete `rules`/`composition`/`ops` the compiler emits. The raw `rules`
 * path stays as a BOUNDED escape hatch — the model may emit a raw rule on a
 * specific handle when the intent vocabulary can't express the design; every
 * escape-hatch use is logged loudly (the count + the FRACTION = the vocabulary-
 * gap metric). Intents target roles OR groups OR handles, so identical
 * families can no longer be half-styled (family consistency by construction).
 *
 * Removed `keep` (was a loophole that codified partial redesigns —
 * the model could "keep" any cluster it didn't want to redesign and completeness
 * passed while the cluster stayed original). Removed `moves` (dead feature —
 * validated and planned but never executed). The base-coat harmonizer now
 * covers unaccounted clusters as a safety net.
 */

import type { DesignPack, TypeRole, SurfaceTier, SurfaceDef, PackLayoutRules } from '../design/packs';

/** Free-form declaration bag: spec-key -> value. Compiler drops unknown/unsafe keys. */
export type StyleDecls = Record<string, string>;   // paint keys
export type LayoutDecls = Record<string, string>;  // layout keys (widths/grid/flex/spacing/type)

export interface DesignRule {
  /** A component handle from perception (e.g. "c1a2b3"), or "canvas" for html/body. */
  target: string;
  styles?: StyleDecls;        // paint (capabilities/style)
  layout?: LayoutDecls;       // arrangement/sizing/spacing (capabilities/structure)
  hover?: StyleDecls;
  focusVisible?: StyleDecls;
  /** Remove this cluster from the page (compiled to display:none; guarded + reversible). */
  hide?: boolean;
}

/** A structural DOM operation. The Architect emits these alongside CSS layout;
 *  compile VALIDATES each against guard laws (pure) and content.ts EXECUTES the
 *  accepted ones against the live DOM, recording an exact inverse per op so the
 *  escape hatch can undo them. Ops are for what CSS can't do: collapsing an empty
 *  container so its space is RECLAIMED (remove), a true source-order change
 *  (reorder), reparenting/relocating including a floating/sticky lever (move),
 *  a grouping container created purely for layout (wrap). Conservative lift:
 *  CSS-layout still does most composition; ops are rare. */
export type OpKind = 'remove' | 'move' | 'reorder' | 'wrap';

export interface DesignOp {
  kind: OpKind;
  /** Cluster handle the op targets (resolved to a live stamped node at apply). */
  target: string;
  /** move: destination handle (a cluster to reparent into) or a named slot
   *  ('floating' = position:fixed mini-player lever). wrap: the new wrapper's
   *  intended display ('flex'|'grid'). reorder: the handle to insert before
   *  (omitted = move to end). */
  to?: string;
  /** reorder: insert target before this handle. wrap/reorder: omit for end. */
  before?: string;
  /** Risky-target consent. move/reorder/wrap on a 'risky' cluster (event-heavy,
   *  forms, live iframes, canvas/video) execute ONLY when the model sets this
   *  explicitly — a second thought, not a reflex. 'forbidden' targets (primary
   *  content, scripts) are refused regardless. */
  consent?: boolean;
  /** A7: the mutation reason from the closed list (escape-overflow-hidden,
   *  escape-stacking-context, cross-layout-regions, impossible-ancestry).
   *  Required for the op to execute — default is no DOM mutation. */
  reason?: string;
}

// ── Phase 2 — the role-intent DSL ───────────────────────────────────

/** How loud a region reads. The expander maps this to type (the pack's type
 *  ramp) + surface + accent. `hidden` is a destructive intent — gated by the
 *  hard-safety rule (only on roles with designRoleConfidence >= 0.5). */
export type Emphasis = 'hero' | 'normal' | 'de-emphasized' | 'hidden';

/** How tightly packed a region is. The expander maps this to spacing-scale
 *  steps + line-height from the pack. */
export type Density = 'compact' | 'comfortable' | 'spacious';

/** A structural placement intent — where a region goes. The expander derives a
 *  structural op + a composition grid change from this (so the model stops
 *  hand-writing composition/ops for the reflow cases the intents cover).
 *  `collapse` is a destructive intent — gated by the hard-safety rule. */
export type Placement =
  | 'keep'              // leave where it is
  | 'topbar'            // sidebar → full-width top bar (reorder + grid change)
  | 'collapse'          // remove (high-confidence voids only)
  | 'relocate'          // move to a destination (the `to` field names the dest handle)
  | { kind: 'relocate'; to: string };

/** A width intent. The expander maps this to the pack's measurePx (percentified
 *  by the existing compile laws, so zoom-proof). */
export type Measure = 'prose' | 'full' | 'compact';

/** Aesthetic overrides the model controls — in TOKEN GRAMMAR, never raw px.
 *  The expander resolves these against the pack + the model's packOverrides.
 *  A named accent ("primary"), a surface tier, scale *steps* (not raw values),
 *  a type-ramp role. The model never emits a raw hex/px the pack already owns. */
export interface AestheticOverrides {
  /** A pack accent name ("primary" | "muted" | a packOverrides accent). */
  accent?: string;
  /** A surface tier from the pack's surface system. */
  surface?: SurfaceTier;
  /** A step index into the pack's radiusScale. */
  radiusStep?: number;
  /** A step index into the pack's borderScale. */
  borderStep?: number;
  /** A step index into the pack's shadowScale. */
  shadowStep?: number;
  /** A texture treatment (glass adds backdrop-filter on the surface). */
  texture?: 'none' | 'grain' | 'glass';
  /** A type-size role on the pack's type ramp (overrides emphasis-derived size). */
  typeRamp?: TypeRole;
}

/** One per-role design intent. The PRIMARY model output. Targets a role, a
 *  group, or a single handle; role/group targets fan out to every member, so
 *  identical families can no longer be half-styled (family consistency by
 *  construction). The expander maps intent + pack + the Phase 1 semantic graph
 *  to the concrete rules/composition/ops the compiler emits. */
export interface RoleIntent {
  /** A design role ("listing", "nav-primary"), a group id ("g4x2y1"), or a
   *  single handle ("c1a2b3"). Role/group targets fan out to every member. */
  target: string;
  /** What `target` is. Inferred when omitted: a handle if it matches a known
   *  cluster handle, else a role (the expander resolves against the perception). */
  targetKind?: 'role' | 'group' | 'handle';
  emphasis?: Emphasis;
  density?: Density;
  placement?: Placement;
  measure?: Measure;
  aesthetic?: AestheticOverrides;
}



export interface DesignSpec {
  reasoning: string;
  /** Declared palette intent, chosen by the model from the user's words.
   *  "restrained" — accent used sparingly (area-capped by MAX_ACCENT_FRACTION).
   *  "vivid" — large saturated fields permitted, but the repeated-accent law
   *  (never identical accent on every member of a repeated cluster) is absolute. */
  paletteMode?: 'restrained' | 'vivid';
  variables?: Record<string, string>;
  /** Page-level canvas paint (html/body background + base text/font). */
  canvas?: StyleDecls;
  /** Page-level layout (content max-width, base spacing/type scale). */
  canvasLayout?: LayoutDecls;
  /** Region-level composition rules — target skeleton region handles to rewrite
   *  the page's proportions (widths, arrangement). Compiled FIRST, before
   *  component rules, so the macro structure is established. Same shape as rules;
   *  same laws pipeline. */
  composition?: DesignRule[];
  /** Structural DOM operations (Architect-owned, take-not-merge — like
   *  composition). Validated by compile against guard laws, executed against
   *  the live DOM by content.ts with an exact inverse recorded per op. */
  ops?: DesignOp[];
  /** Phase 2 — the model's per-role design intents. The PRIMARY model output.
   *  The expander (core/compile/expand.ts) maps intents + the pack + the Phase 1
   *  semantic graph to the concrete rules/composition/ops the compiler emits.
   *  Role/group targets fan out to every member — family consistency by construction. */
  intents?: RoleIntent[];
  /** Phase 2 — which design-language pack the model chose (a pack id, or
   *  undefined for the default). The expander resolves the pack + packOverrides. */
  pack?: string;
  /** Phase 2 — pack-field overrides (blending a novel prompt). Every pack field
   *  is model-overridable; these overlay the chosen pack's defaults so a novel
   *  prompt can adapt any pack without inventing a whole new system. */
  packOverrides?: Partial<DesignPack>;
  rules: DesignRule[];
}

// Backward-compatible aliases so persist/content keep compiling.
export type StyleRule = DesignRule;
export type StyleSpec = DesignSpec;

export interface ValidateResult {
  ok: boolean;
  spec?: DesignSpec;
  error?: string;
}

/**
 * Structural validation only — value-level safety is the compiler/sanitizer's
 * job. Guarantees the shape is sane and prunes junk so a malformed model
 * response can never crash the pipeline. Never throws.
 */
export function validateSpec(raw: unknown): ValidateResult {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'spec is not an object' };
  const r = raw as Record<string, unknown>;

  // Phase 2: the model may emit intents (the primary path) with NO raw rules,
  // OR raw rules (the escape hatch), OR both. The expander turns intents into
  // rules; a spec is valid if it has EITHER. A spec with neither is rejected.
  const hasRules = Array.isArray(r.rules);
  const hasIntents = Array.isArray(r.intents);
  if (!hasRules && !hasIntents) return { ok: false, error: 'spec has no rules or intents' };

  const rules: DesignRule[] = [];
  if (hasRules) for (const item of r.rules as unknown[]) {
    if (!item || typeof item !== 'object') continue;
    const ri = item as Record<string, unknown>;
    if (typeof ri.target !== 'string' || !ri.target) continue;
    const rule: DesignRule = { target: ri.target };
    const styles = asDecls(ri.styles);
    const layout = asDecls(ri.layout);
    const hover = asDecls(ri.hover);
    const focusVisible = asDecls(ri.focusVisible);
    if (styles) rule.styles = styles;
    if (layout) rule.layout = layout;
    if (hover) rule.hover = hover;
    if (focusVisible) rule.focusVisible = focusVisible;
    if (ri.hide === true) rule.hide = true;
    if (rule.styles || rule.layout || rule.hover || rule.focusVisible || rule.hide) rules.push(rule);
  }

  const spec: DesignSpec = {
    reasoning: typeof r.reasoning === 'string' ? r.reasoning : '',
    rules,
  };
  // Phase 2 — parse the intent DSL: intents + the pack choice + pack overrides.
  if (hasIntents) {
    const intents: RoleIntent[] = [];
    for (const item of r.intents as unknown[]) {
      if (!item || typeof item !== 'object') continue;
      const ii = item as Record<string, unknown>;
      if (typeof ii.target !== 'string' || !ii.target) continue;
      const intent: RoleIntent = { target: ii.target };
      if (ii.targetKind === 'role' || ii.targetKind === 'group' || ii.targetKind === 'handle') intent.targetKind = ii.targetKind;
      if (ii.emphasis === 'hero' || ii.emphasis === 'normal' || ii.emphasis === 'de-emphasized' || ii.emphasis === 'hidden') intent.emphasis = ii.emphasis;
      if (ii.density === 'compact' || ii.density === 'comfortable' || ii.density === 'spacious') intent.density = ii.density;
      intent.placement = parsePlacement(ii.placement);
      if (ii.measure === 'prose' || ii.measure === 'full' || ii.measure === 'compact') intent.measure = ii.measure;
      const a = parseAesthetic(ii.aesthetic);
      if (a) intent.aesthetic = a;
      if (intent.emphasis || intent.density || intent.placement || intent.measure || intent.aesthetic) intents.push(intent);
    }
    if (intents.length) spec.intents = intents;
  }
  if (typeof r.pack === 'string' && r.pack) spec.pack = r.pack;
  if (r.packOverrides && typeof r.packOverrides === 'object') spec.packOverrides = r.packOverrides as Partial<DesignPack>;
  if (r.paletteMode === 'restrained' || r.paletteMode === 'vivid') spec.paletteMode = r.paletteMode;
  // Parse composition rules (same shape as regular rules, compiled first).
  if (Array.isArray(r.composition)) {
    const compRules: DesignRule[] = [];
    for (const item of r.composition as unknown[]) {
      if (!item || typeof item !== 'object') continue;
      const ri = item as Record<string, unknown>;
      if (typeof ri.target !== 'string' || !ri.target) continue;
      const rule: DesignRule = { target: ri.target };
      const styles = asDecls(ri.styles);
      const layout = asDecls(ri.layout);
      if (styles) rule.styles = styles;
      if (layout) rule.layout = layout;
      if (ri.hide === true) rule.hide = true;
      if (rule.styles || rule.layout || rule.hide) compRules.push(rule);
    }
    if (compRules.length) spec.composition = compRules;
  }
  // Parse structural ops (shape-only — guard logic is compile's job). Dedup
  // by target+kind (first wins): two `remove` ops on the same target are
  // idempotent; two `move` ops conflict and the first is the intent.
  if (Array.isArray(r.ops)) {
    const ops: DesignOp[] = [];
    const seen = new Set<string>();
    for (const item of r.ops as unknown[]) {
      if (!item || typeof item !== 'object') continue;
      const oi = item as Record<string, unknown>;
      if (typeof oi.target !== 'string' || !oi.target) continue;
      const kind = oi.kind as string;
      if (kind !== 'remove' && kind !== 'move' && kind !== 'reorder' && kind !== 'wrap') continue;
      const key = `${kind}:${oi.target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const op: DesignOp = { kind: kind as OpKind, target: oi.target };
      if (typeof oi.to === 'string') op.to = oi.to;
      if (typeof oi.before === 'string') op.before = oi.before;
      if (oi.consent === true) op.consent = true;
      if (typeof oi.reason === 'string') op.reason = oi.reason;
      ops.push(op);
    }
    if (ops.length) spec.ops = ops;
  }
  const variables = asDecls(r.variables);
  const canvas = asDecls(r.canvas);
  const canvasLayout = asDecls(r.canvasLayout);
  if (variables) spec.variables = variables;
  if (canvas) spec.canvas = canvas;
  if (canvasLayout) spec.canvasLayout = canvasLayout;

  if (rules.length === 0 && !spec.intents?.length && !spec.canvas && !spec.canvasLayout && !spec.variables) {
    return { ok: false, error: 'spec produced no usable rules, intents, canvas, or variables' };
  }
  return { ok: true, spec };
}

/** Parse a Placement intent — a string kind, or { kind: 'relocate', to }. */
function parsePlacement(v: unknown): Placement | undefined {
  if (typeof v === 'string') {
    if (v === 'keep' || v === 'topbar' || v === 'collapse' || v === 'relocate') return v;
    return undefined;
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (o.kind === 'relocate' && typeof o.to === 'string') return { kind: 'relocate', to: o.to };
  }
  return undefined;
}

/** Parse AestheticOverrides — token grammar only (no raw values accepted here;
 *  the expander resolves named accents / scale steps / surface tiers). */
function parseAesthetic(v: unknown): AestheticOverrides | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const a = v as Record<string, unknown>;
  const out: AestheticOverrides = {};
  if (typeof a.accent === 'string' && a.accent) out.accent = a.accent;
  if (a.surface === 'flat' || a.surface === 'raised' || a.surface === 'overlay') out.surface = a.surface;
  if (typeof a.radiusStep === 'number') out.radiusStep = a.radiusStep;
  if (typeof a.borderStep === 'number') out.borderStep = a.borderStep;
  if (typeof a.shadowStep === 'number') out.shadowStep = a.shadowStep;
  if (a.texture === 'none' || a.texture === 'grain' || a.texture === 'glass') out.texture = a.texture;
  if (a.typeRamp === 'display' || a.typeRamp === 'heading' || a.typeRamp === 'body' || a.typeRamp === 'small') out.typeRamp = a.typeRamp;
  if (Object.keys(out).length) return out;
  return undefined;
}

/**
 * Merge an Architect spec (composition/layout/canvasLayout/hide — the structure)
 * with a Painter spec (canvas/variables/paletteMode/styles/hover/focusVisible —
 * the surface). Both are partial DesignSpecs; the merge produces the full spec the
 * compiler consumes. By target: the Architect's layout joins the Painter's styles
 * on the same cluster. Page-level: canvas/variables/paletteMode come from the
 * Painter; canvasLayout/composition come from the Architect. Pure: takes two
 * validated specs as data, returns one merged spec.
 *
 * A role may be absent (the restyle-only path passes no Architect); an absent role
 * contributes nothing. Conflicts on the same target's same bag are resolved
 * Painter-wins for styles, Architect-wins for layout (each role owns its bag, so a
 * true conflict shouldn't happen — but if both set `layout`, the Architect is the
 * authority on structure).
 */
export function mergeSpecs(architect?: DesignSpec, painter?: DesignSpec): DesignSpec {
  const rulesByTarget = new Map<string, DesignRule>();

  // Architect owns the layout bag + composition + canvasLayout + hide.
  if (architect) {
    for (const rule of architect.rules) {
      const existing = rulesByTarget.get(rule.target);
      if (existing) {
        if (rule.layout) existing.layout = { ...existing.layout, ...rule.layout };
        if (rule.hide) existing.hide = true;
      } else {
        rulesByTarget.set(rule.target, { target: rule.target, ...(rule.layout ? { layout: { ...rule.layout } } : {}), ...(rule.hide ? { hide: true } : {}) });
      }
    }
  }

  // Painter owns the styles + hover + focusVisible bag + canvas + variables + paletteMode.
  if (painter) {
    for (const rule of painter.rules) {
      const existing = rulesByTarget.get(rule.target);
      if (existing) {
        if (rule.styles) existing.styles = { ...(existing.styles ?? {}), ...rule.styles };
        if (rule.hover) existing.hover = { ...(existing.hover ?? {}), ...rule.hover };
        if (rule.focusVisible) existing.focusVisible = { ...(existing.focusVisible ?? {}), ...rule.focusVisible };
        if (rule.layout && !existing.layout) existing.layout = { ...rule.layout };
      } else {
        rulesByTarget.set(rule.target, {
          target: rule.target,
          ...(rule.styles ? { styles: { ...rule.styles } } : {}),
          ...(rule.hover ? { hover: { ...rule.hover } } : {}),
          ...(rule.focusVisible ? { focusVisible: { ...rule.focusVisible } } : {}),
          ...(rule.layout ? { layout: { ...rule.layout } } : {}),
        });
      }
    }
  }

  const rules = [...rulesByTarget.values()].filter((r) => r.styles || r.layout || r.hover || r.focusVisible || r.hide);

  // Phase 2 — merge intents by target. The Architect emits structural intents
  // (emphasis/density/placement/measure); the Painter emits aesthetic intents
  // (aesthetic) + the pack choice + packOverrides. Join per target: structural
  // fields from the Architect, aesthetic from the Painter (each role owns its
  // field). Dedup by target+targetKind (first wins).
  const intentsByTarget = new Map<string, RoleIntent>();
  const mergeIntent = (intent: RoleIntent): void => {
    const key = `${intent.targetKind ?? ''}:${intent.target}`;
    const existing = intentsByTarget.get(key);
    if (!existing) { intentsByTarget.set(key, { ...intent }); return; }
    // Structural fields — Architect wins (it owns structure).
    if (intent.emphasis && !existing.emphasis) existing.emphasis = intent.emphasis;
    if (intent.density && !existing.density) existing.density = intent.density;
    if (intent.placement && !existing.placement) existing.placement = intent.placement;
    if (intent.measure && !existing.measure) existing.measure = intent.measure;
    // Aesthetic — Painter wins (it owns surface); merge sub-fields.
    if (intent.aesthetic) {
      existing.aesthetic = { ...(existing.aesthetic ?? {}), ...intent.aesthetic };
    }
  };
  if (architect?.intents) for (const i of architect.intents) mergeIntent(i);
  if (painter?.intents) for (const i of painter.intents) mergeIntent(i);
  const intents = [...intentsByTarget.values()];

  // Composition: Architect-only (region-level structure). Take the Architect's.
  const composition = architect?.composition;
  // Ops: Architect-only (structural DOM mutations). Take-not-merge — ops don't
  // overlay (validateSpec already deduped by target+kind within a spec; across
  // specs the Architect is the sole source, the Painter emits none).
  const ops = architect?.ops;

  // Page-level: canvas/variables/paletteMode from the Painter; canvasLayout from
  // the Architect (the Painter has no layout). If a Painter set canvasLayout
  // (shouldn't, but defensively), the Architect wins on structure.
  const canvas = painter?.canvas ?? architect?.canvas;
  const variables = painter?.variables ?? architect?.variables;
  const paletteMode = painter?.paletteMode ?? architect?.paletteMode;
  const canvasLayout = architect?.canvasLayout ?? painter?.canvasLayout;
  // Phase 2 — pack: the Painter picks the pack (it owns the aesthetic system);
  // the Architect may name one too (Painter wins). packOverrides: deep-merge.
  const pack = painter?.pack ?? architect?.pack;
  const packOverrides = mergePackOverrides(architect?.packOverrides, painter?.packOverrides);

  return {
    reasoning: [architect?.reasoning, painter?.reasoning].filter(Boolean).join(' | ') || '',
    ...(paletteMode ? { paletteMode } : {}),
    ...(variables ? { variables } : {}),
    ...(canvas ? { canvas } : {}),
    ...(canvasLayout ? { canvasLayout } : {}),
    ...(composition ? { composition } : {}),
    ...(ops ? { ops } : {}),
    ...(intents.length ? { intents } : {}),
    ...(pack ? { pack } : {}),
    ...(packOverrides ? { packOverrides } : {}),
    rules,
  };
}

/** Deep-merge two packOverrides records (the Painter's overrides win on a shared
 *  field; the Architect's contribute otherwise). Returns undefined if both empty.
 *  The nested objects are merged at the field level; the result is a `Partial<DesignPack>` — the expander's `resolvePack` overlays it on the chosen pack,
 *  so a partial override (e.g. just `typeRamp.body`) is fine. */
function mergePackOverrides(a?: Partial<DesignPack>, b?: Partial<DesignPack>): Partial<DesignPack> | undefined {
  if (!a && !b) return undefined;
  if (!a) return b;
  if (!b) return a;
  const out: Partial<DesignPack> = { ...a, ...b };
  if (a.typeRamp || b.typeRamp) (out as Partial<DesignPack>).typeRamp = { ...(a.typeRamp as Record<TypeRole, number>), ...(b.typeRamp as Record<TypeRole, number>) } as Record<TypeRole, number>;
  if (a.lineHeight || b.lineHeight) (out as Partial<DesignPack>).lineHeight = { ...(a.lineHeight as Record<TypeRole, number>), ...(b.lineHeight as Record<TypeRole, number>) } as Record<TypeRole, number>;
  if (a.measurePx || b.measurePx) (out as Partial<DesignPack>).measurePx = { ...(a.measurePx as { prose: number; full: number; compact: number }), ...(b.measurePx as { prose: number; full: number; compact: number }) };
  if (a.colors || b.colors) (out as Partial<DesignPack>).colors = { ...(a.colors as { canvas: string; text: string; subtle: string; accents: Record<string, string> }), ...(b.colors as { canvas: string; text: string; subtle: string; accents: Record<string, string> }), accents: { ...(a.colors?.accents ?? {}), ...(b.colors?.accents ?? {}) } };
  if (a.surfaces || b.surfaces) (out as Partial<DesignPack>).surfaces = { ...(a.surfaces as Record<SurfaceTier, SurfaceDef>), ...(b.surfaces as Record<SurfaceTier, SurfaceDef>) } as Record<SurfaceTier, SurfaceDef>;
  if (a.layoutRules || b.layoutRules) (out as Partial<DesignPack>).layoutRules = { ...(a.layoutRules as PackLayoutRules), ...(b.layoutRules as PackLayoutRules) } as PackLayoutRules;
  return out;
}

/** Coerce a value into a flat string->string decl bag, or undefined. */
function asDecls(v: unknown): StyleDecls | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: StyleDecls = {};
  let n = 0;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof k !== 'string') continue;
    if (typeof val === 'string' || typeof val === 'number') { out[k] = String(val); n++; }
  }
  return n > 0 ? out : undefined;
}

/**
 * Completeness contract. Gate: does the spec have the minimums for a complete
 * redesign? Canvas + composition/layout + (rules OR intents) covering ≥15% of
 * clusters. If these pass, base-coat covers the rest. Unaccounted clusters are
 * listed for logging but do NOT fail the gate — base-coat is the safety net.
 *
 * Phase 2: the model may emit INTENTS (the primary path) with no raw rules.
 * Intents are design work — an intent target counts toward the rules gate and
 * the accounted set (the expander turns it into rules; the post-apply coverage
 * gate is the real backstop). A role/group target can't be resolved to handles
 * here (the expander does that), so it's counted as 1 toward the min — the
 * honest signal is "the model made a design decision," and the verify coverage
 * gate catches a spec that left most of the page unaddressed.
 */
export function checkCompleteness(spec: DesignSpec, handles: Set<string>): { ok: boolean; unaccounted: string[]; reason?: string } {
  if (!spec.canvas?.background) {
    return { ok: false, unaccounted: [], reason: 'No canvas background set — every design needs a deliberate canvas.' };
  }
  if (!spec.canvasLayout && (!spec.composition || spec.composition.length === 0)) {
    return { ok: false, unaccounted: [], reason: 'No canvasLayout or composition rules — the page proportions must be a deliberate decision.' };
  }
  const intentCount = spec.intents?.length ?? 0;
  const effective = spec.rules.length + intentCount;
  const minRules = Math.ceil(handles.size * 0.15);
  if (effective < minRules) {
    return { ok: false, unaccounted: [], reason: `Only ${spec.rules.length} rules + ${intentCount} intents for ${handles.size} clusters — need at least ${minRules} (15%). Style the major clusters actively.` };
  }
  // All gates pass — base-coat covers unaccounted clusters.
  const accounted = new Set<string>();
  for (const rule of spec.rules) {
    if (rule.styles || rule.layout || rule.hover || rule.focusVisible || rule.hide) accounted.add(rule.target);
  }
  if (spec.composition) {
    for (const rule of spec.composition) {
      if (rule.styles || rule.layout || rule.hide) accounted.add(rule.target);
    }
  }
  // Phase 2 — a handle-targeted intent accounts that handle (role/group targets
  // can't be resolved here; the expander does that — the verify coverage gate
  // is the backstop).
  if (spec.intents) {
    for (const intent of spec.intents) {
      if (intent.targetKind === 'handle' || (!intent.targetKind && /^c[0-9a-z]{6}$/.test(intent.target))) {
        accounted.add(intent.target);
      }
    }
  }
  const unaccounted = [...handles].filter((h) => !accounted.has(h));
  return { ok: true, unaccounted };
}

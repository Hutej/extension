/**
 * core/spec — the DSL the AI emits and the compiler consumes.
 *
 * OPEN-ENDED (any tokens/values) but STRUCTURED (validated shape, real handles).
 * The compiler — not the AI — decides which declarations are safe to emit.
 *
 * Removed `keep` (was a loophole that codified partial redesigns —
 * the model could "keep" any cluster it didn't want to redesign and completeness
 * passed while the cluster stayed original). Removed `moves` (dead feature —
 * validated and planned but never executed). The base-coat harmonizer now
 * covers unaccounted clusters as a safety net.
 */

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

  if (!Array.isArray(r.rules)) return { ok: false, error: 'spec.rules is not an array' };

  const rules: DesignRule[] = [];
  for (const item of r.rules as unknown[]) {
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

  if (rules.length === 0 && !spec.canvas && !spec.canvasLayout && !spec.variables) {
    return { ok: false, error: 'spec produced no usable rules, canvas, or variables' };
  }
  return { ok: true, spec };
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

  return {
    reasoning: [architect?.reasoning, painter?.reasoning].filter(Boolean).join(' | ') || '',
    ...(paletteMode ? { paletteMode } : {}),
    ...(variables ? { variables } : {}),
    ...(canvas ? { canvas } : {}),
    ...(canvasLayout ? { canvasLayout } : {}),
    ...(composition ? { composition } : {}),
    ...(ops ? { ops } : {}),
    rules,
  };
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
 * redesign? Canvas + composition/layout + ≥15% of clusters in rules. If these
 * pass, base-coat covers the rest. Unaccounted clusters are listed for logging
 * but do NOT fail the gate — base-coat is the safety net.
 */
export function checkCompleteness(spec: DesignSpec, handles: Set<string>): { ok: boolean; unaccounted: string[]; reason?: string } {
  if (!spec.canvas?.background) {
    return { ok: false, unaccounted: [], reason: 'No canvas background set — every design needs a deliberate canvas.' };
  }
  if (!spec.canvasLayout && (!spec.composition || spec.composition.length === 0)) {
    return { ok: false, unaccounted: [], reason: 'No canvasLayout or composition rules — the page proportions must be a deliberate decision.' };
  }
  const minRules = Math.ceil(handles.size * 0.15);
  if (spec.rules.length < minRules) {
    return { ok: false, unaccounted: [], reason: `Only ${spec.rules.length} rules for ${handles.size} clusters — need at least ${minRules} (15%). Style the major clusters actively.` };
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
  const unaccounted = [...handles].filter((h) => !accounted.has(h));
  return { ok: true, unaccounted };
}

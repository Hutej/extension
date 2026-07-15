/**
 * core/spec — the DSL the AI emits and the compiler consumes.
 *
 * OPEN-ENDED (any tokens/values) but STRUCTURED (validated shape, real handles).
 * The compiler — not the AI — decides which declarations are safe to emit.
 *
 * This slice expands the DSL from paint-only into a design system: per-rule
 * `layout` + page-level `canvasLayout` decl bags, plus an optional `moves[]`
 * relocation contract (planned/validated now; execution deferred to a later slice).
 * Backward compatible: legacy paint-only specs still validate and compile.
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
  /** Declare that this cluster's original design deliberately serves the aesthetic
   *  — it is accounted for but NOT restyled or hidden. Rare; must be justifiable.
   *  The compiler emits nothing for a keep-only rule; it exists so the completeness
   *  contract can distinguish "I examined this and kept it" from "I forgot it." */
  keep?: boolean;
}

/** A reversible relocation the compiler could not express as pure CSS. Planned only this slice. */
export interface MoveOp {
  target: string;             // cluster handle to move
  into: string;               // destination cluster handle
  position?: 'append' | 'prepend';
  reason: string;             // why CSS could not do it (stated intent)
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
  rules: DesignRule[];
  moves?: MoveOp[];
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
    if (ri.keep === true) rule.keep = true;
    if (rule.styles || rule.layout || rule.hover || rule.focusVisible || rule.hide || rule.keep) rules.push(rule);
  }

  const moves: MoveOp[] = [];
  if (Array.isArray(r.moves)) {
    for (const item of r.moves as unknown[]) {
      if (!item || typeof item !== 'object') continue;
      const mi = item as Record<string, unknown>;
      if (typeof mi.target !== 'string' || !mi.target) continue;
      if (typeof mi.into !== 'string' || !mi.into) continue;
      const position = mi.position === 'prepend' ? 'prepend' : 'append';
      moves.push({ target: mi.target, into: mi.into, position, reason: typeof mi.reason === 'string' ? mi.reason : '' });
    }
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
      if (ri.keep === true) rule.keep = true;
      if (rule.styles || rule.layout || rule.hide || rule.keep) compRules.push(rule);
    }
    if (compRules.length) spec.composition = compRules;
  }
  const variables = asDecls(r.variables);
  const canvas = asDecls(r.canvas);
  const canvasLayout = asDecls(r.canvasLayout);
  if (variables) spec.variables = variables;
  if (canvas) spec.canvas = canvas;
  if (canvasLayout) spec.canvasLayout = canvasLayout;
  if (moves.length) spec.moves = moves;

  if (rules.length === 0 && !spec.canvas && !spec.canvasLayout && !spec.variables && moves.length === 0) {
    return { ok: false, error: 'spec produced no usable rules, canvas, variables, or moves' };
  }
  return { ok: true, spec };
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
 * Completeness contract (Mechanism 1). Every retained cluster handle must be
 * accounted for: restyled (styles/layout/hover/focusVisible), hidden, or
 * explicitly kept. Returns the handles the spec left unaccounted — the caller
 * routes the single reReason budget with a critique that names them. Pure: takes
 * the handle set as data so it's unit-testable and callable before apply.
 */
export function checkCompleteness(spec: DesignSpec, handles: Set<string>): { ok: boolean; unaccounted: string[] } {
  const accounted = new Set<string>();
  for (const rule of spec.rules) {
    if (rule.styles || rule.layout || rule.hover || rule.focusVisible || rule.hide || rule.keep) {
      accounted.add(rule.target);
    }
  }
  if (spec.composition) {
    for (const rule of spec.composition) {
      if (rule.styles || rule.layout || rule.hide || rule.keep) accounted.add(rule.target);
    }
  }
  const unaccounted = [...handles].filter((h) => !accounted.has(h));
  return { ok: unaccounted.length === 0, unaccounted };
}

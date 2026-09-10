/**
 * runtime/compile — canonical resource compilation (plan/03 `runtime/compile`,
 * plan/08 §2–3, algorithms A3/A4 prelude).
 *
 * The compiler turns a validated style operation plus resolved target tokens
 * into the EXACT delivered bytes — the model never authors a selector, a URL,
 * or any raw CSS text (I01/I18). Output is a resource plan only; nothing here
 * inserts, measures or mutates.
 *
 * Policy (one parser+policy path, plan/22 AC-03 — not a property catalog):
 *   - Every declaration value is parsed with the pinned css-tree AST parser
 *     and walked: URL-bearing or network-capable constructs are rejected
 *     wherever they appear — including escaped tokens, data URIs, image-set
 *     strings, paint/worklet references and `attr()` (I18). The css-tree
 *     lexer additionally rejects syntax the platform does not know.
 *   - Functions are allow-listed (visual-only, network-free); `var()` may
 *     reference only Revueon-namespaced tokens (`--rv-*`) or explicitly
 *     observed safe site tokens passed in by the caller.
 *   - `all` (global reset) is rejected outright; hiding/interaction-cutting
 *     declarations (display/visibility/opacity/pointer-events/position/…)
 *     compile but are surfaced as HIGH-IMPACT claims so the transaction layer
 *     applies the same target/risk policy as the named hide/float operations
 *     (I17: raw CSS cannot bypass named-op constraints).
 *   - Selectors are generated: `:where([data-rv2-ns="<token>"][:state])`,
 *     pseudo-element appended outside the wrapper — uniform zero specificity
 *     so canonical customization order decides (plan/08 §3). No combinators,
 *     `:has`, `:is` or commas can ever enter the sheet.
 *   - Keyframes are runtime-namespaced, never DOM selectors, never important;
 *     every referenced name is rewritten. Motion authored without a
 *     reduced-motion counterpart is rejected (plan/08 §2).
 *   - `content` is only valid on generated ::before/::after surfaces.
 *   - The generated sheet is re-parsed as a final self-check; an unexpected
 *     URL node or at-rule kind in OUR OWN output is a compile failure.
 *
 * Diagnostics are grouped by field path with exact messages; unsafe CSS is
 * rejected, never silently stripped and re-authored (plan/03).
 */

import * as csstree from 'css-tree';
import {
  LIMITS,
  type CssCondition,
  type StyleDeclaration,
  type StyleOperation,
} from '../contracts.ts';

// ── value-function policy ────────────────────────────────────────────────

/** Visual-only, network-free value functions. Anything not listed rejects. */
const SAFE_VALUE_FUNCTIONS = new Set([
  // math
  'calc', 'min', 'max', 'clamp', 'round', 'mod', 'rem', 'abs', 'sign', 'hypot', 'pow', 'sqrt', 'log', 'exp',
  'minmax', 'repeat', 'fit-content',
  // color
  'rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color', 'color-mix', 'light-dark',
  // gradients
  'linear-gradient', 'radial-gradient', 'conic-gradient',
  'repeating-linear-gradient', 'repeating-radial-gradient', 'repeating-conic-gradient',
  // filters
  'blur', 'brightness', 'contrast', 'drop-shadow', 'grayscale', 'hue-rotate', 'invert', 'opacity', 'saturate', 'sepia',
  // transforms
  'translate', 'translatex', 'translatey', 'translatez', 'translate3d',
  'scale', 'scalex', 'scaley', 'scalez', 'scale3d',
  'rotate', 'rotatex', 'rotatey', 'rotatez', 'rotate3d',
  'skew', 'skewx', 'skewy', 'matrix', 'matrix3d', 'perspective',
  // easing / motion
  'cubic-bezier', 'steps', 'linear',
  // clip shapes
  'inset', 'circle', 'ellipse', 'polygon',
  // counters (content only) and environment
  'counter', 'counters', 'env',
  // variables (token policy applies inside)
  'var',
]);

/** Properties that cut content or interaction — compiled, but surfaced as
 *  high-impact claims for the transaction/risk layer (I17). */
const HIGH_IMPACT_PROPERTIES = new Set([
  'display', 'visibility', 'opacity', 'pointer-events', 'position',
  'overflow', 'overflow-x', 'overflow-y', 'user-select', 'touch-action',
  'inset', 'top', 'right', 'bottom', 'left', 'z-index', 'content',
]);

/** Motion-authoring properties that require a reduced-motion counterpart. */
const MOTION_PROPERTIES = /^((animation|transition)(-|$)|scroll-behavior$)/;

const RV_VAR_PREFIX = '--rv-';
/** Compile fails on the first diagnostic anyway; the cap keeps hostile input bounded. */
const DIAGNOSTIC_CAP = 64;
const TOKEN_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;
const KEYFRAME_AT_PATTERN = /^(from|to|\d+(\.\d+)?%)$/;

// ── result shapes ────────────────────────────────────────────────────────

export interface CompileDiagnostic {
  path: string;
  code: 'unsafe-value' | 'unsupported-syntax' | 'policy' | 'bounds' | 'target';
  message: string;
}

export type HighImpactRisk = 'hides-content' | 'blocks-interaction' | 'positions-overlay' | 'replaces-content';

export interface CompiledSheet {
  css: string;
  bytes: number;
  /** Target tokens the sheet references (inert until runtime activation). */
  namespaces: string[];
  /** Runtime-namespaced keyframe names present in the sheet. */
  keyframeNames: string[];
  highImpact: Array<{ property: string; value: string; targetRef: string; risk: HighImpactRisk }>;
  declarations: number;
}

export interface CompileStyleInput {
  operation: StyleOperation;
  /** Delivery namespace (installation + resource path, plan/08 §4). */
  namespace: string;
  /** Resolve a rule target to its runtime token (from the S3.1 registry or a
   *  same-batch local ref). The compiler never resolves nodes itself. */
  resolveToken(target: { targetRef?: string; localRef?: string }): { ok: true; token: string } | { ok: false; detail: string };
  /** Observed site custom properties the operation may read via var(). */
  observedSafeVars?: ReadonlySet<string>;
}

export type CompileStyleResult =
  | { ok: true; sheet: CompiledSheet }
  | { ok: false; diagnostics: CompileDiagnostic[] };

// ── AST value policy ─────────────────────────────────────────────────────

interface ValuePolicyContext {
  path: string;
  diagnostics: CompileDiagnostic[];
  observedSafeVars: ReadonlySet<string>;
  keyframeNames: ReadonlySet<string>;
  declaredKeyframes: ReadonlySet<string>;
}

function reject(ctx: ValuePolicyContext, code: CompileDiagnostic['code'], message: string): void {
  ctx.diagnostics.push({ path: ctx.path, code, message });
}

/** Walk one declaration value AST and enforce the value policy. Manual
 *  recursion: value trees are shallow and bounded by the 2 KiB value cap. */
function policyCheckValue(ast: csstree.CssNode, ctx: ValuePolicyContext, depth = 0): void {
  if (depth > LIMITS.maxJsonDepth || ctx.diagnostics.length >= DIAGNOSTIC_CAP) return;
  if (ast.type === 'Url') {
    reject(ctx, 'unsafe-value', 'URLs are never allowed in model-authored values (network-capable construct)');
    return;
  }
  if (ast.type === 'Raw') {
    reject(ctx, 'unsafe-value', `unparseable raw value fragment (possible escaped construct): "${ast.value.slice(0, 60)}"`);
    return;
  }
  if (ast.type === 'Function') {
    const name = csstree.keyword(ast.name).name.toLowerCase();
    if (!SAFE_VALUE_FUNCTIONS.has(name)) {
      reject(ctx, 'unsafe-value', `function "${name}()" is not in the safe visual allowlist`);
      return;
    }
    if (name === 'var') {
      const first = ast.children ? ast.children.first : undefined;
      if (!first || first.type !== 'Identifier' || !first.name.startsWith('--')) {
        reject(ctx, 'unsafe-value', 'var() must reference a custom property');
        return;
      }
      const varName = first.name;
      if (!varName.startsWith(RV_VAR_PREFIX) && !ctx.observedSafeVars.has(varName)) {
        reject(ctx, 'unsafe-value', `var() references unapproved token "${varName}"; only --rv-* or observed safe site tokens are allowed`);
        return;
      }
      // css-tree parses var() fallback arguments as Raw fragments. They are
      // model-authored, so they must not smuggle network constructs the
      // value-tree scan cannot see: fail closed on any forbidden construct
      // in the raw text (plan/08 §2: unapproved token contents that could
      // introduce network-valued properties are rejected). The recursion
      // into children stops here — the Raw fallback is fully handled above.
      if (ast.children) {
        for (const child of ast.children) {
          if (child.type === 'Raw' && /url\s*\(|image-set|\bimage\(|paint\(|attr\(|element\(|cross-fade|@import|src\s*\(|local\s*\(/i.test(child.value)) {
            reject(ctx, 'unsafe-value', `var() fallback contains a forbidden construct: "${child.value.slice(0, 60)}"`);
            return;
          }
        }
      }
      return;
    }
  }
  if (ast.type === 'Atrule') {
    reject(ctx, 'unsafe-value', 'at-rules inside values are not allowed');
    return;
  }
  const children = (ast as { children?: csstree.List<csstree.CssNode> }).children;
  if (children) {
    for (const child of children) policyCheckValue(child, ctx, depth + 1);
  }
}

/** Rewrite animation-name references to the runtime-namespaced form. Applied
 *  only inside animation/animation-name values (ident-boundary exact, names
 *  are schema-validated identifiers — never inside other properties). */
function rewriteKeyframeIdentsInText(value: string, declaredKeyframes: ReadonlySet<string>, namespacedNameOf: (name: string) => string): string {
  let out = value;
  for (const name of declaredKeyframes) {
    out = out.replace(new RegExp(`(?<![\\w-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'g'), namespacedNameOf(name));
  }
  return out;
}

// ── selector generation ──────────────────────────────────────────────────

export function selectorForRule(token: string, state: string, surface: 'element' | 'before' | 'after'): string {
  // Uniform zero specificity: target and state inside :where() so canonical
  // customization order decides (plan/08 §3). Pseudo-elements append outside
  // the wrapper (they cannot live inside :where()).
  const base = `[data-rv2-ns="${token}"]`;
  const statePart = state !== 'none' ? `:${state}` : '';
  const pseudoPart = surface !== 'element' ? `::${surface}` : '';
  return `:where(${base}${statePart})${pseudoPart}`;
}

// ── conditions ───────────────────────────────────────────────────────────

function conditionToMediaFeature(condition: Exclude<CssCondition, { type: 'supports' }>, ctx: ValuePolicyContext): string {
  switch (condition.type) {
    case 'viewport': {
      const parts: string[] = [];
      if (condition.minInlineSize !== undefined) parts.push(`(min-width: ${condition.minInlineSize}px)`);
      if (condition.maxInlineSize !== undefined) parts.push(`(max-width: ${condition.maxInlineSize}px)`);
      if (!parts.length) {
        reject(ctx, 'policy', 'a viewport condition needs minInlineSize or maxInlineSize');
        return '(min-width: 0px)';
      }
      return parts.join(' and ');
    }
    case 'prefers-color-scheme':
      return `(prefers-color-scheme: ${condition.scheme})`;
    case 'prefers-reduced-motion':
      return `(prefers-reduced-motion: ${condition.reduce ? 'reduce' : 'no-preference'})`;
  }
}

/** Serialize conditions into a @media/@supports preamble (innermost last). */
function conditionsToPrelude(conditions: CssCondition[], ctx: ValuePolicyContext): string {
  let prelude = '';
  for (const condition of conditions) {
    if (condition.type === 'supports') {
      // The supported pair must pass the same value policy before it is
      // emitted as a real @supports block (no side channel around the AST
      // policy).
      checkDeclaration(
        { property: condition.property, value: condition.value, priority: 'normal' },
        `${ctx.path}.conditions.supports`,
        ctx,
      );
      prelude += `@supports (${condition.property}: ${condition.value}) { `;
    } else {
      const feature = conditionToMediaFeature(condition, { ...ctx, path: `${ctx.path}.conditions` });
      prelude += `@media ${feature} { `;
    }
  }
  return prelude;
}

// ── declaration checks ───────────────────────────────────────────────────

function checkDeclaration(declaration: StyleDeclaration, path: string, ctx: ValuePolicyContext): { highImpact: HighImpactRisk | undefined } {
  const prop = csstree.property(declaration.property).name.toLowerCase();
  if (prop === 'all') {
    reject({ ...ctx, path }, 'policy', '"all" (global reset) is never allowed on website nodes');
    return { highImpact: undefined };
  }
  if (prop === 'behavior' || prop === '-ms-behavior') {
    reject({ ...ctx, path }, 'unsafe-value', 'legacy executable property rejected');
    return { highImpact: undefined };
  }
  let ast: csstree.CssNode;
  try {
    ast = csstree.parse(`${declaration.property}: ${declaration.value}`, { context: 'declaration', parseValue: true });
  } catch (err) {
    reject({ ...ctx, path }, 'unsupported-syntax', `value does not parse: ${(err as Error).message}`);
    return { highImpact: undefined };
  }
  policyCheckValue((ast as { value: csstree.CssNode }).value ?? ast, { ...ctx, path });
  // Browser-support check (static approximation via the pinned parser's
  // data): unsupported syntax is rejected explicitly, never silently kept.
  // Declarations containing var() are exempt: the substituted value is only
  // known at use time, so static matching is impossible by design; the value
  // policy above has already gated the referenced tokens and fallback.
  const valueText = csstree.generate(ast);
  if (ctx.diagnostics.length === 0 && !valueText.includes('var(')) {
    const match = csstree.lexer.matchDeclaration(ast as csstree.Declaration);
    if (!match.matched) {
      reject({ ...ctx, path }, 'unsupported-syntax', `declaration is not valid CSS syntax for this platform: ${match.error?.message ?? 'no match'}`);
    }
  }
  let highImpact: HighImpactRisk | undefined;
  if (HIGH_IMPACT_PROPERTIES.has(prop)) {
    if (prop === 'content') highImpact = 'replaces-content';
    else if (prop === 'pointer-events' || prop === 'user-select' || prop === 'touch-action') highImpact = 'blocks-interaction';
    else if (prop === 'position' || prop === 'inset' || prop === 'top' || prop === 'right' || prop === 'bottom' || prop === 'left' || prop === 'z-index') highImpact = 'positions-overlay';
    else highImpact = 'hides-content';
  }
  return { highImpact };
}

// ── compiler ─────────────────────────────────────────────────────────────

export function compileStyleOperation(input: CompileStyleInput): CompileStyleResult {
  const diagnostics: CompileDiagnostic[] = [];
  const { operation, namespace, resolveToken, observedSafeVars = new Set<string>() } = input;

  if (!TOKEN_PATTERN.test(namespace)) {
    diagnostics.push({ path: 'namespace', code: 'policy', message: 'namespace must match ^[A-Za-z0-9._-]{1,200}$' });
    return { ok: false, diagnostics };
  }
  if (operation.rules.length > LIMITS.maxStyleRules) {
    diagnostics.push({ path: 'rules', code: 'bounds', message: `more than ${LIMITS.maxStyleRules} rules` });
    return { ok: false, diagnostics };
  }

  const namespacedNameOf = (name: string): string => {
    // Deterministic runtime namespacing: dots are not valid in keyframe names.
    const ns = namespace.replace(/[^A-Za-z0-9_-]/g, '-').replace(/-+/g, '-').slice(0, 80);
    return `rv2-${ns}-${name}`;
  };

  const declaredKeyframes = new Set<string>((operation.keyframes ?? []).map((k) => k.name));
  const namespacedKeyframes = new Set<string>([...declaredKeyframes].map(namespacedNameOf));
  const usedTokens = new Set<string>();
  const highImpact: CompiledSheet['highImpact'] = [];
  const ruleBlocks: string[] = [];
  let declarationCount = 0;

  // Keyframes first (namespaced, never important, never selectors).
  for (const [ki, kf] of (operation.keyframes ?? []).entries()) {
    const frames: string[] = [];
    for (const [fi, frame] of kf.frames.entries()) {
      if (!KEYFRAME_AT_PATTERN.test(frame.at)) {
        diagnostics.push({ path: `keyframes[${ki}].frames[${fi}].at`, code: 'policy', message: `keyframe offset "${frame.at}" must be from, to or a percentage` });
        continue;
      }
      const decls: string[] = [];
      for (const [di, declaration] of frame.declarations.entries()) {
        if (declaration.priority === 'important') {
          diagnostics.push({ path: `keyframes[${ki}].frames[${fi}].declarations[${di}]`, code: 'policy', message: 'keyframe declarations are never important' });
          continue;
        }
        const ctx: ValuePolicyContext = {
          path: `keyframes[${ki}].frames[${fi}].declarations[${di}]`,
          diagnostics,
          observedSafeVars,
          keyframeNames: namespacedKeyframes,
          declaredKeyframes,
        };
        checkDeclaration(declaration, ctx.path, ctx);
        declarationCount += 1;
        decls.push(`${declaration.property}: ${declaration.value};`);
      }
      frames.push(`${frame.at} { ${decls.join(' ')} }`);
    }
    ruleBlocks.push(`@keyframes ${namespacedNameOf(kf.name)} { ${frames.join(' ')} }`);
  }

  // Rules: generated selectors only.
  for (const [ri, rule] of operation.rules.entries()) {
    const resolved = resolveToken(rule.target);
    if (!resolved.ok) {
      diagnostics.push({ path: `rules[${ri}].target`, code: 'target', message: resolved.detail });
      continue;
    }
    usedTokens.add(resolved.token);
    const selector = selectorForRule(resolved.token, rule.state, rule.surface);
    const decls: string[] = [];
    for (const [di, declaration] of rule.declarations.entries()) {
      const path = `rules[${ri}].declarations[${di}]`;
      const ctx: ValuePolicyContext = {
        path,
        diagnostics,
        observedSafeVars,
        keyframeNames: namespacedKeyframes,
        declaredKeyframes,
      };
      // content only on generated decorative surfaces (plan/08 §2).
      const prop = csstree.property(declaration.property).name.toLowerCase();
      if (prop === 'content' && rule.surface === 'element') {
        diagnostics.push({ path, code: 'policy', message: '"content" is only valid on generated ::before/::after surfaces' });
        continue;
      }
      const value = /^animation(-name)?$/.test(prop)
        ? rewriteKeyframeIdentsInText(declaration.value, declaredKeyframes, namespacedNameOf)
        : declaration.value;
      const { highImpact: risk } = checkDeclaration({ ...declaration, value }, path, ctx);
      if (risk) highImpact.push({ property: prop, value, targetRef: rule.target.targetRef ?? rule.target.localRef ?? '', risk });
      const important = declaration.priority === 'important' ? ' !important' : '';
      declarationCount += 1;
      decls.push(`${declaration.property}: ${value}${important};`);
    }
    if (decls.length === 0) continue;
    const prelude = conditionsToPrelude(rule.conditions, { path: `rules[${ri}]`, diagnostics, observedSafeVars, keyframeNames: namespacedKeyframes, declaredKeyframes });
    const close = ' }'.repeat((prelude.match(/\{/g) ?? []).length);
    ruleBlocks.push(`${prelude}${selector} { ${decls.join(' ')} }${close}`);
  }

  // Motion requires a reduced-motion counterpart (plan/08 §2).
  const authorsMotion = operation.rules.some((r) => r.declarations.some((d) => MOTION_PROPERTIES.test(csstree.property(d.property).name.toLowerCase())));
  if (authorsMotion) {
    const hasCounterpart = operation.rules.some(
      (r) => r.conditions.some((c) => c.type === 'prefers-reduced-motion' && c.reduce) &&
        r.declarations.some((d) => MOTION_PROPERTIES.test(csstree.property(d.property).name.toLowerCase())),
    );
    if (!hasCounterpart) {
      diagnostics.push({
        path: 'rules',
        code: 'policy',
        message: 'motion declarations require a prefers-reduced-motion counterpart rule in the same operation',
      });
    }
  }

  if (declarationCount > LIMITS.maxDeclarationsTotal) {
    diagnostics.push({ path: 'declarations', code: 'bounds', message: `more than ${LIMITS.maxDeclarationsTotal} declarations in one proposal` });
  }

  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }

  const css = ruleBlocks.join('\n');

  // Final self-check: our own output must parse as a stylesheet and contain
  // no URL nodes or unexpected at-rule kinds (generation-bug backstop).
  try {
    const sheetAst = csstree.parse(css, { context: 'stylesheet', parseValue: true }) as csstree.Atrule;
    const forbidden = (node: csstree.CssNode): boolean => {
      if (node.type === 'Url') return true;
      if (node.type === 'Atrule') {
        const kw = csstree.keyword(node.name).name.toLowerCase();
        return kw !== 'media' && kw !== 'supports' && kw !== 'keyframes';
      }
      return false;
    };
    let urlFound = false;
    const scan = (node: csstree.CssNode, depth: number): void => {
      if (urlFound || depth > LIMITS.maxJsonDepth * 4) return;
      if (forbidden(node)) {
        urlFound = true;
        return;
      }
      const children = (node as { children?: csstree.List<csstree.CssNode>; block?: { children: csstree.List<csstree.CssNode> } | null });
      const lists: Array<csstree.List<csstree.CssNode> | undefined> = [
        children.children,
        children.block?.children,
        (node as { prelude?: { children?: csstree.List<csstree.CssNode> } }).prelude?.children,
      ];
      for (const list of lists) {
        if (!list) continue;
        for (const child of list) scan(child, depth + 1);
      }
    };
    for (const child of (sheetAst as unknown as { children: csstree.List<csstree.CssNode> }).children) scan(child, 0);
    if (urlFound) {
      return { ok: false, diagnostics: [{ path: 'sheet', code: 'unsafe-value', message: 'generated sheet self-check failed: URL-capable construct present' }] };
    }
  } catch (err) {
    return { ok: false, diagnostics: [{ path: 'sheet', code: 'unsupported-syntax', message: `generated sheet does not parse: ${(err as Error).message}` }] };
  }

  const bytes = new TextEncoder().encode(css).length; // byte length without Node's Buffer (browser content world)
  if (bytes > LIMITS.maxSheetBytes) {
    return { ok: false, diagnostics: [{ path: 'sheet', code: 'bounds', message: `compiled sheet exceeds the ${LIMITS.maxSheetBytes}-byte ceiling` }] };
  }

  return {
    ok: true,
    sheet: {
      css,
      bytes,
      namespaces: [...usedTokens],
      keyframeNames: [...namespacedKeyframes],
      highImpact,
      declarations: declarationCount,
    },
  };
}

// ── insertUI creation plan (plan/28 §2 — validation only, S4.2 executes) ──

export interface InsertUiNodePlan {
  tag: string;
  text?: string;
  attrs?: Record<string, string>;
  children?: InsertUiNodePlan[];
  localId?: string;
  actionId?: string;
  /** Accessibility references to local ids; S4.2 rewrites them to runtime IDs. */
  refTargets?: Array<{ attr: 'for' | 'aria-describedby' | 'aria-labelledby'; localId: string }>;
}

export interface InsertUiPlan {
  anchor: { targetRef?: string; localRef?: string };
  position: 'before' | 'after' | 'first-child' | 'last-child';
  trees: InsertUiNodePlan[];
}

const INSERT_TAGS = new Set([
  'div', 'span', 'section', 'article', 'header', 'footer', 'nav', 'aside', 'p',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'strong', 'em', 'small',
  'code', 'pre', 'blockquote', 'br', 'hr', 'a', 'button', 'label', 'input',
  'select', 'option', 'details', 'summary', 'table', 'thead', 'tbody', 'tr',
  'th', 'td',
]);

const ALLOWED_ATTRS = new Set([
  'title', 'role', 'aria-label', 'aria-describedby', 'aria-labelledby', 'aria-expanded',
  'disabled', 'type', 'open', 'placeholder', 'min', 'max', 'step', 'initialvalue',
  'value', 'selected', 'scope', 'for',
]);

const LOCAL_INPUT_TYPES = new Set(['text', 'search', 'checkbox', 'radio', 'range', 'number']);

export function compileInsertUi(
  operation: import('../contracts.ts').InsertUiOperation,
): { ok: true; plan: InsertUiPlan } | { ok: false; diagnostics: CompileDiagnostic[] } {
  const diagnostics: CompileDiagnostic[] = [];
  if (operation.nodes.length > LIMITS.maxInsertNodes) {
    diagnostics.push({ path: 'nodes', code: 'bounds', message: `more than ${LIMITS.maxInsertNodes} nodes per batch` });
    return { ok: false, diagnostics };
  }
  const trees: InsertUiNodePlan[] = [];
  for (const [ni, node] of operation.nodes.entries()) {
    const plan = validateInsertNode(node, `nodes[${ni}]`, diagnostics, 0);
    if (plan) trees.push(plan);
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return {
    ok: true,
    plan: {
      anchor: operation.target,
      position: operation.position,
      trees,
    },
  };
}

const ARIA_REF_FIELDS = [
  ['labelFor', 'for'],
  ['ariaDescribedBy', 'aria-describedby'],
  ['ariaLabelledBy', 'aria-labelledby'],
] as const;

function validateInsertNode(
  node: import('../contracts.ts').InsertUiNode,
  path: string,
  diagnostics: CompileDiagnostic[],
  depth: number,
): InsertUiNodePlan | undefined {
  if (depth > LIMITS.maxInsertDepth) {
    diagnostics.push({ path, code: 'bounds', message: `tree deeper than ${LIMITS.maxInsertDepth} levels` });
    return undefined;
  }
  const tag = node.tag.toLowerCase();
  if (!INSERT_TAGS.has(tag)) {
    diagnostics.push({ path: `${path}.tag`, code: 'policy', message: `tag "${tag}" is not in the supported insert set` });
    return undefined;
  }
  const attrs: Record<string, string> = {};
  const refTargets: Array<{ attr: 'for' | 'aria-describedby' | 'aria-labelledby'; localId: string }> = [];
  for (const [key, value] of Object.entries(node.attributes ?? {})) {
    const attr = key.toLowerCase();
    if (attr.startsWith('on')) {
      diagnostics.push({ path: `${path}.attributes.${key}`, code: 'unsafe-value', message: 'inline event attributes are never allowed' });
      continue;
    }
    if (['src', 'srcdoc', 'href', 'action', 'method', 'formaction', 'style', 'class', 'id'].includes(attr)) {
      // Links use approved action refs (S4.2); no external targets, no style
      // sink, no form submission, no author-chosen DOM ids (plan/28 §2).
      diagnostics.push({ path: `${path}.attributes.${key}`, code: 'unsafe-value', message: `attribute "${attr}" is not allowed on owned nodes` });
      continue;
    }
    if (!ALLOWED_ATTRS.has(attr)) {
      diagnostics.push({ path: `${path}.attributes.${key}`, code: 'policy', message: `attribute "${attr}" is not in the typed attribute set` });
      continue;
    }
    if (attr === 'type' && tag === 'input') {
      const type = String(value).toLowerCase();
      if (!LOCAL_INPUT_TYPES.has(type)) {
        diagnostics.push({ path: `${path}.attributes.type`, code: 'policy', message: `local input type "${type}" is not allowed (never password/file/submit)` });
        continue;
      }
    }
    if (attr === 'type' && tag === 'button') continue; // forced below
    attrs[attr] = String(value);
  }
  // Dedicated local accessibility references (plan/28 §2): validated here,
  // rewritten to runtime-generated ids after the tree is created (S4.2).
  for (const [field, attr] of ARIA_REF_FIELDS) {
    const localId = node[field];
    if (localId !== undefined) refTargets.push({ attr, localId });
  }
  if (tag === 'button') attrs['type'] = 'button'; // always (plan/28 §2)
  if (tag === 'input' && attrs['type'] === undefined) attrs['type'] = 'text';

  const children: InsertUiNodePlan[] = [];
  for (const [ci, child] of (node.children ?? []).entries()) {
    const childPlan = validateInsertNode(child, `${path}.children[${ci}]`, diagnostics, depth + 1);
    if (childPlan) children.push(childPlan);
  }
  // Structural nesting the browser must not be left to repair (plan/28 §2).
  const childTags = children.map((c) => c.tag);
  if ((tag === 'ul' || tag === 'ol') && childTags.some((t) => t !== 'li')) {
    diagnostics.push({ path, code: 'policy', message: `${tag} children must be li` });
  }
  if (tag === 'select' && childTags.some((t) => t !== 'option')) {
    diagnostics.push({ path, code: 'policy', message: 'select children must be option' });
  }
  if (tag === 'details' && (childTags.length === 0 || childTags[0] !== 'summary')) {
    diagnostics.push({ path, code: 'policy', message: 'details must start with a summary child' });
  }
  if ((tag === 'thead' || tag === 'tbody') && childTags.some((t) => t !== 'tr')) {
    diagnostics.push({ path, code: 'policy', message: `${tag} children must be tr` });
  }
  if (tag === 'tr' && childTags.some((t) => t !== 'th' && t !== 'td')) {
    diagnostics.push({ path, code: 'policy', message: 'tr children must be th/td' });
  }
  if ((tag === 'table') && childTags.some((t) => t !== 'thead' && t !== 'tbody' && t !== 'tr')) {
    diagnostics.push({ path, code: 'policy', message: 'table children must be row groups or rows' });
  }
  return {
    tag,
    ...(node.text !== undefined ? { text: node.text } : {}),
    ...(Object.keys(attrs).length ? { attrs } : {}),
    ...(children.length ? { children } : {}),
    ...(node.localId !== undefined ? { localId: node.localId } : {}),
    ...(node.actionId !== undefined ? { actionId: node.actionId } : {}),
    ...(refTargets.length ? { refTargets } : {}),
  };
}

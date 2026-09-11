/**
 * contracts — the pure schema/validation layer (plan/02 §3 `contracts.ts`,
 * plan/04 data contracts, plan/08 §7 operation grammar v1).
 *
 * Everything here is plain data in → validated value or field-path
 * diagnostics out. No DOM, no chrome.*, no fetch, no state, no coercion:
 * model strings never become numbers/booleans, unknown fields are rejected
 * (v1 defines no extensions field), numbers must be finite, every persistent
 * or wire root carries an explicit schema/protocol version that fails closed.
 *
 * Layers (plan/02 §1): this is the bottom. It may import only `shared/*`.
 * The import gate (scripts/audit-imports.ts) enforces that.
 *
 * Consumers (later phases): broker dispatch, runtime validation, planning
 * prompt metadata, store codec. Nothing here executes effects — decoding
 * never mutates the page and never grants authority (I01/I04).
 */

// ── 1. Named limits (plan/15 §2, plan/08 §7, plan/04) ───────────────────

export const LIMITS = {
  maxJsonDepth: 32, // provider response nesting ceiling (plan/15)
  maxOperations: 64, // one proposal = one ordered batch, 1..64
  minOperations: 1,
  maxExpectations: 64,
  maxStyleRules: 256, // per style operation
  maxDeclarationsPerRule: 64,
  maxDeclarationsTotal: 2048, // per proposal (plan/15 single CSS group)
  maxCssKeyframes: 8,
  maxCssFrames: 32,
  maxConditionsPerRule: 8,
  maxReplaceTextBytes: 8 * 1024, // plan/08 §7 replaceText
  maxReasonChars: 240, // common optional public reason
  maxSummaryChars: 2000,
  maxInsertNodes: 200, // plan/15 generic owned UI
  maxInsertDepth: 12,
  maxInsertTextBytes: 16 * 1024,
  maxBindActions: 4, // bindKey actionIds 1..4
  maxLocalPredicates: 8,
  maxPredicateLiteralChars: 120,
  maxCollectionFields: 8,
  maxCollectionGroups: 12,
  minQuestionOptions: 2,
  maxQuestionOptions: 4,
  maxSetBindingPass: 200, // plan/04 matchBounds per incremental binding pass
  maxSetActiveMembers: 2000, // total active members/document
  maxTargetRefChars: 128,
  maxLocalIdChars: 64,
  maxEndpointChars: 2048,
  maxTitleChars: 200,
  maxLabelChars: 120, // collapse label
  maxChordChars: 64,
  cursorTtlMs: 30_000, // plan/04 snapshot cursor validity
  maxSheetBytes: 262_144, // compiled sheet delivery ceiling (S2.2 styles/S4.1 compiler)
  maxCustomizationBytes: 262_144, // plan/13 §1 per-customization storage budget
  maxOriginRecordBytes: 2 * 1024 * 1024, // plan/13 §1 per-origin record budget
  maxTotalRecordBytes: 6 * 1024 * 1024, // plan/13 §1 total customization data budget
  maxRevisionsKept: 2, // plan/13 §1: active + previous accepted revision
  maxTombstones: 32, // plan/13 §6 bounded removal tombstones per record
  tombstoneStaleMs: 5 * 60_000, // plan/13 §6 stale-message deadline
  maxRouteDiscriminators: 8, // plan/13 §2 user-approved query/hash discriminators
  maxDiscriminatorValueChars: 256,
} as const;

// ── 2. Decoder core ──────────────────────────────────────────────────────

export interface DecodeIssue {
  path: string;
  code:
    | 'type' | 'missing' | 'unknown-field' | 'unknown-value' | 'out-of-bounds'
    | 'not-finite' | 'too-deep' | 'invalid-id' | 'duplicate' | 'forward-reference'
    | 'conflict' | 'unsupported' | 'denied';
  message: string;
}

export type DecodeResult<T> = { ok: true; value: T } | { ok: false; issues: DecodeIssue[] };

export type Decoder<T> = (v: unknown, path?: string) => DecodeResult<T>;

const ok = <T>(value: T): DecodeResult<T> => ({ ok: true, value });
const fail = (path: string | undefined, code: DecodeIssue['code'], message: string): DecodeResult<never> => ({
  // Runtime callers always pass real field paths via the record machinery;
  // `undefined` only reaches here from contextual inline arrows and renders
  // with the neutral 'value' root.
  ok: false,
  issues: [{ path: path ?? 'value', code, message }],
});

/** Reject pathologically deep nested structures anywhere in a value tree. */
function boundedDepth(v: unknown, path: string | undefined, max: number, depth: number): DecodeResult<Record<string, unknown>> {
  const p = path ?? 'value';
  if (depth > max) return fail(p, 'too-deep', `nesting exceeds ${max} levels`);
  if (isPlainObject(v)) {
    for (const [k, child] of Object.entries(v)) {
      const r = boundedDepth(child, `${p}.${k}`, max, depth + 1);
      if (!r.ok) return r;
    }
  } else if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const r = boundedDepth(v[i], `${p}[${i}]`, max, depth + 1);
      if (!r.ok) return r;
    }
  }
  return ok(v as Record<string, unknown>);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Reject prototype-like keys — never spread attacker keys into records. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function decodeObject(v: unknown, path = 'value'): DecodeResult<Record<string, unknown>> {
  if (!isPlainObject(v)) return fail(path, 'type', 'expected a plain object');
  for (const key of Object.keys(v)) {
    if (FORBIDDEN_KEYS.has(key)) return fail(`${path}.${key}`, 'unknown-field', `forbidden key "${key}"`);
  }
  return ok(v);
}

export function decodeString(opts: { min?: number; max: number; pattern?: RegExp }): Decoder<string> {
  return (v, path = 'value') => {
    if (typeof v !== 'string') return fail(path, 'type', `expected a string, got ${typeof v}`);
    if (v.length < (opts.min ?? 1)) return fail(path, 'out-of-bounds', `length ${v.length} < minimum ${opts.min ?? 1}`);
    if (v.length > opts.max) return fail(path, 'out-of-bounds', `length ${v.length} > maximum ${opts.max}`);
    if (opts.pattern && !opts.pattern.test(v)) return fail(path, 'invalid-id', 'does not match the required shape');
    return ok(v);
  };
}

/** Finite number; never coerced from strings; NaN/Infinity rejected. */
export function decodeFiniteNumber(opts: { min?: number; max?: number; integer?: boolean }): Decoder<number> {
  return (v, path = 'value') => {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return fail(path, 'not-finite', typeof v === 'string' ? 'numbers are never coerced from strings' : 'expected a finite number');
    }
    if (opts.integer && !Number.isInteger(v)) return fail(path, 'type', 'expected an integer');
    if (opts.min !== undefined && v < opts.min) return fail(path, 'out-of-bounds', `${v} < minimum ${opts.min}`);
    if (opts.max !== undefined && v > opts.max) return fail(path, 'out-of-bounds', `${v} > maximum ${opts.max}`);
    return ok(v);
  };
}

export function decodeBoolean(v: unknown, path = 'value'): DecodeResult<boolean> {
  if (typeof v !== 'boolean') return fail(path, 'type', typeof v === 'string' ? 'booleans are never coerced from strings' : 'expected a boolean');
  return ok(v);
}

export function decodeLiteral<const T extends string>(values: readonly T[]): Decoder<T> {
  return (v, path = 'value') => {
    if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) {
      return fail(path, 'unknown-value', `expected one of: ${values.join(', ')}`);
    }
    return ok(v as T);
  };
}

export function decodeArray<T>(item: Decoder<T>, max: number): Decoder<T[]> {
  return (v, path = 'value') => {
    if (!Array.isArray(v)) return fail(path, 'type', 'expected an array');
    if (v.length > max) return fail(path, 'out-of-bounds', `${v.length} items > maximum ${max}`);
    const out: T[] = [];
    const issues: DecodeIssue[] = [];
    for (let i = 0; i < v.length; i++) {
      const r = item(v[i], `${path}[${i}]`);
      if (r.ok) out.push(r.value);
      else issues.push(...r.issues);
    }
    return issues.length ? { ok: false, issues } : ok(out);
  };
}

/** Object with an explicit field spec; unknown fields are rejected (v1 has
 *  no extensions field). `spec` maps field → decoder; optional fields use
 *  `optional(decoder)`. Depth is enforced here so recursive trees (insertUI)
 *  cannot blow the stack. */
export function decodeRecord<S extends Record<string, Decoder<unknown>>>(
  spec: S,
  opts: { maxDepth: number; depth?: number },
): Decoder<{ [K in keyof S]: S[K] extends Decoder<infer T> ? T : never }> {
  type Out = { [K in keyof S]: S[K] extends Decoder<infer T> ? T : never };
  return (v, p?: string, depth = 0): DecodeResult<{ [K in keyof S]: S[K] extends Decoder<infer T> ? T : never }> => {
    const path = p ?? 'value';
    if (depth > opts.maxDepth) return fail(path, 'too-deep', `nesting exceeds ${opts.maxDepth} levels`);
    const obj = decodeObject(v, path);
    if (!obj.ok) return obj;
    const issues: DecodeIssue[] = [];
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj.value)) {
      if (!(key in spec)) {
        issues.push({ path: `${path}.${key}`, code: 'unknown-field', message: `"${key}" is not part of schema v1` });
      }
    }
    for (const [key, decoder] of Object.entries(spec) as [string, Decoder<unknown>][]) {
      if (!(key in obj.value)) {
        if (isOptional(decoder)) continue;
        issues.push({ path: `${path}.${key}`, code: 'missing', message: 'required field is missing' });
        continue;
      }
      const r = decoder(obj.value[key], `${path}.${key}`);
      if (r.ok) out[key] = r.value;
      else issues.push(...r.issues);
    }
    return issues.length ? { ok: false, issues } : ok(out as Out);
  };
}

const OPTIONAL = Symbol('optional');
type OptionalDecoder<T> = ((v: unknown, path?: string) => DecodeResult<T>) & { [OPTIONAL]?: true };

export function optional<T>(decoder: Decoder<T>): OptionalDecoder<T | undefined> {
  const wrapped = ((v: unknown, path?: string) => {
    if (v === undefined) return ok(undefined);
    if (v === null) return fail(`${path ?? 'value'}`, 'type', 'optional fields must be omitted, not null');
    return decoder(v, path);
  }) as OptionalDecoder<T | undefined>;
  wrapped[OPTIONAL] = true;
  return wrapped;
}

function isOptional(d: unknown): boolean {
  return typeof d === 'function' && (d as OptionalDecoder<unknown>)[OPTIONAL] === true;
}

const TARGET_REF = decodeString({ max: LIMITS.maxTargetRefChars, pattern: /^[A-Za-z0-9._:-]+$/ });
const LOCAL_ID = decodeString({ max: LIMITS.maxLocalIdChars, pattern: /^[A-Za-z][A-Za-z0-9._-]*$/ });
const LOCAL_REF = LOCAL_ID; // names a node declared by an earlier insertUI creator

/** Exactly one of targetRef (observed) / localRef (earlier-owned node). */
function decodeTargetSpec(): Decoder<{ targetRef?: string; localRef?: string }> {
  const spec = {
    targetRef: optional(TARGET_REF),
    localRef: optional(LOCAL_REF),
  };
  return (v, path = 'value') => {
    const r = decodeRecord(spec, { maxDepth: LIMITS.maxJsonDepth })(v, path);
    if (!r.ok) return r;
    const { targetRef, localRef } = r.value;
    if (targetRef !== undefined && localRef !== undefined) {
      return fail(path, 'conflict', 'operation must reference either an observed targetRef or an earlier-owned localRef, never both');
    }
    if (targetRef === undefined && localRef === undefined) {
      return fail(`${path}.targetRef`, 'missing', 'operation requires a targetRef or a localRef to an earlier insertUI node');
    }
    return ok({ targetRef, localRef });
  };
}

// ── 3. Common records: DocumentKey, Epoch, Envelope, receipts, errors ────

export const DOCUMENT_KEY_SCHEMA_VERSION = 1;

export interface DocumentKey {
  tabId: number;
  frameId: number;
  browserDocumentId: string;
  runtimeInstanceId: string;
}

export const decodeDocumentKey: Decoder<DocumentKey> = decodeRecord(
  {
    tabId: decodeFiniteNumber({ integer: true, min: 0 }),
    frameId: decodeFiniteNumber({ integer: true, min: 0 }),
    browserDocumentId: decodeString({ max: 128 }),
    runtimeInstanceId: decodeString({ max: 128 }),
  },
  { maxDepth: LIMITS.maxJsonDepth },
);

export interface Epoch {
  routeEpoch: number;
  domRevision: number;
  customizationRevision: number;
  viewportRevision: number;
}

export const decodeEpoch: Decoder<Epoch> = decodeRecord(
  {
    routeEpoch: decodeFiniteNumber({ integer: true, min: 0 }),
    domRevision: decodeFiniteNumber({ integer: true, min: 0 }),
    customizationRevision: decodeFiniteNumber({ integer: true, min: 0 }),
    viewportRevision: decodeFiniteNumber({ integer: true, min: 0 }),
  },
  { maxDepth: LIMITS.maxJsonDepth },
);

export const PROTOCOL_VERSION = 1;

export type EnvelopeKind = 'run-command' | 'observe-request' | 'style-delivery' | 'control' | 'subscription';
export interface Envelope {
  protocolVersion: 1;
  requestId: string;
  kind: EnvelopeKind;
  runId?: string;
  documentKey?: DocumentKey;
  expectedRouteEpoch?: number;
  deadlineAt: number;
  /** Bounded plain object; per-kind payload validation belongs to the
   *  dispatching owner, not the transport envelope. */
  payload: Record<string, unknown>;
}

const ENVELOPE_KINDS = ['run-command', 'observe-request', 'style-delivery', 'control', 'subscription'] as const;

export const decodeEnvelope: Decoder<Envelope> = (v, path) => {
  const base = decodeRecord(
    {
      protocolVersion: decodeFiniteNumber({ integer: true, min: PROTOCOL_VERSION, max: PROTOCOL_VERSION }),
      requestId: decodeString({ max: 128, pattern: /^[A-Za-z0-9._:-]+$/ }),
      kind: decodeLiteral(ENVELOPE_KINDS),
      runId: optional(decodeString({ max: 128, pattern: /^[A-Za-z0-9._:-]+$/ })),
      documentKey: optional(decodeDocumentKey),
      expectedRouteEpoch: optional(decodeFiniteNumber({ integer: true, min: 0 })),
      deadlineAt: decodeFiniteNumber({ integer: true, min: 0 }),
      payload: (p, pth) => {
        if (!isPlainObject(p)) return fail(pth, 'type', 'expected a payload object');
        // Payload is validated against the kind by the dispatching owner; the
        // envelope layer only proves it is a bounded plain object.
        const r = decodeObject(p, pth);
        if (!r.ok) return r;
        return boundedDepth(r.value, pth, LIMITS.maxJsonDepth, 0);
      },
    },
    { maxDepth: LIMITS.maxJsonDepth },
  )(v, path);
  if (!base.ok) return base;
  return ok(base.value as Envelope);
};

// ── Error taxonomy (plan/04 §1, plan/05; unknown errors → non-retryable) ──

export type ErrorCode =
  | 'invalid-schema' | 'unknown-version' | 'unknown-field' | 'out-of-bounds' | 'missing-field'
  | 'duplicate-id' | 'forward-reference' | 'ambiguous-response'
  | 'stale-document' | 'stale-route' | 'stale-target' | 'unknown-target'
  | 'denied' | 'consent-required'
  | 'timeout-unknown' | 'provider-error' | 'provider-unavailable'
  | 'unsupported-capability' | 'unsupported-text-shape'
  | 'budget-exhausted' | 'quota-exceeded' | 'conflict' | 'internal';

export const ERROR_CODES: readonly ErrorCode[] = [
  'invalid-schema', 'unknown-version', 'unknown-field', 'out-of-bounds', 'missing-field',
  'duplicate-id', 'forward-reference', 'ambiguous-response',
  'stale-document', 'stale-route', 'stale-target', 'unknown-target',
  'denied', 'consent-required',
  'timeout-unknown', 'provider-error', 'provider-unavailable',
  'unsupported-capability', 'unsupported-text-shape',
  'budget-exhausted', 'quota-exceeded', 'conflict', 'internal',
];

export type ErrorPhase =
  | 'decode' | 'plan' | 'observe' | 'validate' | 'prepare'
  | 'deliver' | 'apply' | 'verify' | 'persist' | 'reconcile';

export const ERROR_PHASES: readonly ErrorPhase[] = [
  'decode', 'plan', 'observe', 'validate', 'prepare', 'deliver', 'apply', 'verify', 'persist', 'reconcile',
];

export type RetryClass = 'retryable-same-id' | 'retryable-backoff' | 'non-retryable' | 'user-decision';

export const RETRY_CLASSES: readonly RetryClass[] = [
  'retryable-same-id', 'retryable-backoff', 'non-retryable', 'user-decision',
];

/** Default retry class per error code. Unknown codes default non-retryable. */
const RETRY_CLASS_BY_CODE: Partial<Record<ErrorCode, RetryClass>> = {
  'timeout-unknown': 'retryable-same-id',
  'provider-unavailable': 'retryable-backoff',
  'stale-document': 'non-retryable',
  'stale-route': 'non-retryable',
  'stale-target': 'user-decision',
  'unknown-target': 'user-decision',
  'denied': 'non-retryable',
  'consent-required': 'user-decision',
  'budget-exhausted': 'non-retryable',
  'quota-exceeded': 'non-retryable',
  'ambiguous-response': 'non-retryable',
};

export function retryClassFor(code: string): RetryClass {
  return RETRY_CLASS_BY_CODE[code as ErrorCode] ?? 'non-retryable';
}

export interface ErrorRecord {
  code: ErrorCode;
  phase: ErrorPhase;
  retryClass: RetryClass;
  message: string;
  fieldPath?: string;
  groupId?: string;
  resourceId?: string;
  measuredCoverage?: string;
  recoveryAction?: string;
}

export const decodeErrorRecord: Decoder<ErrorRecord> = decodeRecord(
  {
    code: decodeLiteral(ERROR_CODES),
    phase: decodeLiteral(ERROR_PHASES),
    retryClass: decodeLiteral(RETRY_CLASSES),
    message: decodeString({ max: 1000 }),
    fieldPath: optional(decodeString({ max: 256 })),
    groupId: optional(decodeString({ max: 128 })),
    resourceId: optional(decodeString({ max: 128 })),
    measuredCoverage: optional(decodeString({ max: 256 })),
    recoveryAction: optional(decodeString({ max: 500 })),
  },
  { maxDepth: LIMITS.maxJsonDepth },
);

export type ReceiptStatus =
  | 'prepared' | 'applied-provisional' | 'accepted' | 'rolled-back'
  | 'conflicted' | 'not-applied' | 'outcome-unknown';

export const RECEIPT_STATUSES: readonly ReceiptStatus[] = [
  'prepared', 'applied-provisional', 'accepted', 'rolled-back', 'conflicted', 'not-applied', 'outcome-unknown',
];

export interface CommandReceipt {
  requestId: string;
  operationId: string;
  payloadDigest: string;
  status: ReceiptStatus;
  currentEpoch?: Epoch;
  resourceIds?: string[];
  error?: ErrorRecord;
}

export const decodeCommandReceipt: Decoder<CommandReceipt> = decodeRecord(
  {
    requestId: decodeString({ max: 128 }),
    operationId: decodeString({ max: 128 }),
    payloadDigest: decodeString({ max: 128 }),
    status: decodeLiteral(RECEIPT_STATUSES),
    currentEpoch: optional(decodeEpoch),
    resourceIds: optional(decodeArray(decodeString({ max: 128 }), 256)),
    error: optional(decodeErrorRecord),
  },
  { maxDepth: LIMITS.maxJsonDepth },
);

// ── 4. Operations (plan/08 §7 grammar v1; plan/28 §2 insertUI) ───────────

export type Operation =
  | StyleOperation | HideOperation | CollapseOperation | FloatOperation
  | ReplaceTextOperation | InsertUiOperation | BindKeyOperation
  | LocalRuleOperation | ProjectCollectionOperation | RelocateOperation;

export const OPERATION_KINDS = [
  'style', 'hide', 'collapse', 'float', 'replaceText',
  'insertUI', 'bindKey', 'localRule', 'projectCollection', 'relocate',
] as const;
export type OperationKind = (typeof OPERATION_KINDS)[number];

const REASON = optional(decodeString({ max: LIMITS.maxReasonChars }));

export interface StyleDeclaration {
  property: string;
  value: string;
  priority?: 'normal' | 'important';
}

const CSS_PROPERTY = decodeString({ max: 128, pattern: /^-?-?[a-zA-Z][a-zA-Z0-9-]*$/ });
const CSS_VALUE = decodeString({ max: 2048 });
// Value safety (URL/variable policy) is the S4.1 compiler's AST policy — the
// schema layer only bounds shape. Documented, not silently omitted.

export type CssCondition =
  | { type: 'viewport'; minInlineSize?: number; maxInlineSize?: number }
  | { type: 'prefers-color-scheme'; scheme: 'light' | 'dark' }
  | { type: 'prefers-reduced-motion'; reduce: boolean }
  | { type: 'supports'; property: string; value: string };

const decodeCssCondition: Decoder<CssCondition> = (v, path) => {
  const type = decodeLiteral(['viewport', 'prefers-color-scheme', 'prefers-reduced-motion', 'supports'])(isPlainObject(v) ? (v as { type?: unknown }).type : undefined, `${path}.type`);
  if (!type.ok) return type;
  switch (type.value) {
    case 'viewport':
      return decodeRecord({ type: decodeLiteral(['viewport']), minInlineSize: optional(decodeFiniteNumber({ min: 0, max: 100000 })), maxInlineSize: optional(decodeFiniteNumber({ min: 0, max: 100000 })) }, { maxDepth: LIMITS.maxJsonDepth })(v, path);
    case 'prefers-color-scheme':
      return decodeRecord({ type: decodeLiteral(['prefers-color-scheme']), scheme: decodeLiteral(['light', 'dark']) }, { maxDepth: LIMITS.maxJsonDepth })(v, path);
    case 'prefers-reduced-motion':
      return decodeRecord({ type: decodeLiteral(['prefers-reduced-motion']), reduce: decodeBoolean }, { maxDepth: LIMITS.maxJsonDepth })(v, path);
    case 'supports':
      return decodeRecord({ type: decodeLiteral(['supports']), property: CSS_PROPERTY, value: CSS_VALUE }, { maxDepth: LIMITS.maxJsonDepth })(v, path);
  }
};

export interface Keyframes {
  name: string;
  frames: { at: string; declarations: StyleDeclaration[] }[];
}

const decodeDeclaration: Decoder<StyleDeclaration> = decodeRecord(
  {
    property: CSS_PROPERTY,
    value: CSS_VALUE,
    priority: optional(decodeLiteral(['normal', 'important'])),
  },
  { maxDepth: LIMITS.maxJsonDepth },
);

const decodeStyleRule: Decoder<{ target: { targetRef?: string; localRef?: string }; surface: 'element' | 'before' | 'after'; state: string; declarations: StyleDeclaration[]; conditions: CssCondition[] }> = (v, path) => {
  const r = decodeRecord(
    {
      target: decodeTargetSpec(),
      surface: optional(decodeLiteral(['element', 'before', 'after'])),
      state: optional(decodeLiteral(['none', 'hover', 'focus-visible', 'focus-within', 'active', 'checked', 'disabled'])),
      declarations: decodeArray(decodeDeclaration, LIMITS.maxDeclarationsPerRule),
      conditions: optional(decodeArray(decodeCssCondition, LIMITS.maxConditionsPerRule)),
    },
    { maxDepth: LIMITS.maxJsonDepth },
  )(v, path);
  if (!r.ok) return r;
  if (r.value.declarations.length === 0) return fail(`${path}.declarations`, 'out-of-bounds', 'a style rule needs at least one declaration');
  if ((r.value.surface ?? 'element') !== 'element' && (r.value.state ?? 'none') !== 'none') {
    return fail(path, 'conflict', 'generated pseudo-element surfaces cannot also carry a state pseudo-class');
  }
  return ok({
    target: r.value.target,
    surface: r.value.surface ?? 'element',
    state: r.value.state ?? 'none',
    declarations: r.value.declarations,
    conditions: r.value.conditions ?? [],
  });
};

export interface StyleOperation {
  kind: 'style';
  reason?: string;
  rules: {
    target: { targetRef?: string; localRef?: string };
    surface: 'element' | 'before' | 'after';
    state: string;
    declarations: StyleDeclaration[];
    conditions: CssCondition[];
  }[];
  keyframes?: Keyframes[];
}

const decodeKeyframes: Decoder<Keyframes> = decodeRecord(
  {
    name: decodeString({ max: 64, pattern: /^-?[A-Za-z][A-Za-z0-9_-]*$/ }),
    frames: decodeArray(
      decodeRecord(
        { at: decodeString({ max: 64 }), declarations: decodeArray(decodeDeclaration, LIMITS.maxDeclarationsPerRule) },
        { maxDepth: LIMITS.maxJsonDepth },
      ),
      LIMITS.maxCssFrames,
    ),
  },
  { maxDepth: LIMITS.maxJsonDepth },
);

export interface HideOperation {
  kind: 'hide';
  reason?: string;
  target: { targetRef?: string; localRef?: string };
}

export interface CollapseOperation {
  kind: 'collapse';
  reason?: string;
  target: { targetRef?: string; localRef?: string };
  label: string;
  initialState?: 'collapsed' | 'expanded';
  placement?: 'before' | 'after';
  userOverride?: boolean;
}

export interface FloatOperation {
  kind: 'float';
  reason?: string;
  target: { targetRef?: string; localRef?: string };
  edge: 'top-start' | 'top-end' | 'bottom-start' | 'bottom-end';
  width?: string;
  maxHeight?: string;
  inset?: string;
}

export interface ReplaceTextOperation {
  kind: 'replaceText';
  reason?: string;
  target: { targetRef?: string; localRef?: string };
  text: string;
}

export interface InsertUiNode {
  localId?: string;
  tag: string;
  text?: string;
  children?: InsertUiNode[];
  attributes?: Record<string, string>;
  actionId?: string;
  labelFor?: string; // local accessibility reference within the same tree
  ariaDescribedBy?: string;
  ariaLabelledBy?: string;
}

export interface InsertUiOperation {
  kind: 'insertUI';
  reason?: string;
  target: { targetRef?: string; localRef?: string };
  position: 'before' | 'after' | 'first-child' | 'last-child';
  nodes: InsertUiNode[];
}

export interface BindKeyOperation {
  kind: 'bindKey';
  reason?: string;
  target?: { targetRef?: string; localRef?: string };
  chord: string;
  actionIds: string[];
  scope?: 'document' | 'target';
  repeat?: boolean;
  editablePolicy?: 'ignore' | 'allow';
  modalPolicy?: 'ignore' | 'allow';
}

export type LocalPredicate =
  | { type: 'member-of'; targetRef: string }
  | { type: 'expanded-equals'; value: boolean }
  | { type: 'owned-state-equals'; value: string }
  | { type: 'text-contains'; literal: string };

export interface LocalRuleOperation {
  kind: 'localRule';
  reason?: string;
  target: { targetRef?: string; localRef?: string };
  trigger: 'target-appeared' | 'trusted-shortcut' | 'owned-state-change';
  targetRef?: string;
  predicates: LocalPredicate[];
  actionId: string;
}

export interface ProjectCollectionOperation {
  kind: 'projectCollection';
  reason?: string;
  target: { targetRef?: string; localRef?: string };
  sourceSetRef: string;
  fields: { sourceField: string; label: string }[];
  view: 'list' | 'grid' | 'board';
  groupBy?: string;
  order?: 'source' | 'manual';
  showOriginal?: boolean;
}

export interface RelocateOperation {
  kind: 'relocate';
  reason?: string;
  target: { targetRef?: string; localRef?: string };
  destination: { targetRef?: string; localRef?: string };
  position: 'first-child' | 'last-child' | 'before' | 'after';
  placeholder?: 'flow-slot';
  structuralGrant?: boolean;
}

// insertUI node grammar (plan/28 §2): typed tag allowlist, typed attribute
// set, native nesting validated at compile time (S4.2). `scene` (owned canvas)
// joins the tag list in S8.4 with its own record schema.

export const INSERT_UI_TAGS = [
  'div', 'span', 'section', 'article', 'header', 'footer', 'nav', 'aside', 'p',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'strong', 'em', 'small',
  'code', 'pre', 'blockquote', 'br', 'hr', 'a', 'button', 'label', 'input',
  'select', 'option', 'details', 'summary', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
] as const;

export const INSERT_UI_INPUT_TYPES = ['text', 'search', 'checkbox', 'radio', 'range', 'number'] as const;

const SAFE_ATTRIBUTES = new Set([
  'title', 'role', 'aria-label', 'aria-expanded', 'disabled', 'type', 'open',
  'placeholder', 'min', 'max', 'step', 'value', 'scope',
]);

const decodeNodeTag = decodeLiteral(INSERT_UI_TAGS);
const decodeAttrKey = (v: unknown, path = 'attribute'): DecodeResult<string> => {
  const s = decodeString({ max: 64, pattern: /^[a-zA-Z-]+$/ })(v, path);
  if (!s.ok) return s;
  if (SAFE_ATTRIBUTES.has(s.value)) return ok(s.value);
  return fail(path, 'unknown-field', `attribute "${s.value}" is not in the typed attribute set`);
};

function decodeInsertNode(depth: number): Decoder<InsertUiNode> {
  return (v, path = 'value') => {
    if (depth > LIMITS.maxInsertDepth) return fail(path, 'too-deep', `insertUI tree exceeds ${LIMITS.maxInsertDepth} levels`);
    const r = decodeRecord(
      {
        localId: optional(LOCAL_ID),
        tag: decodeNodeTag,
        text: optional(decodeString({ max: LIMITS.maxInsertTextBytes })),
        children: optional((cv: unknown, cpath = 'children') => {
          if (!Array.isArray(cv)) return fail(cpath, 'type', 'expected an array of child nodes');
          if (cv.length > LIMITS.maxInsertNodes) return fail(cpath, 'out-of-bounds', `too many nodes (max ${LIMITS.maxInsertNodes})`);
          const out: InsertUiNode[] = [];
          const issues: DecodeIssue[] = [];
          for (let i = 0; i < cv.length; i++) {
            const cr = decodeInsertNode(depth + 1)(cv[i], `${cpath}[${i}]`);
            if (cr.ok) out.push(cr.value);
            else issues.push(...cr.issues);
          }
          return issues.length ? { ok: false, issues } : ok(out);
        }),
        attributes: optional((av: unknown, apath = 'attributes') => {
          const obj = decodeObject(av, apath);
          if (!obj.ok) return obj;
          const attrs: Record<string, string> = {};
          const issues: DecodeIssue[] = [];
          for (const [k, raw] of Object.entries(obj.value)) {
            const kr = decodeAttrKey(k, `${apath}.${k}`);
            if (!kr.ok) { issues.push(...kr.issues); continue; }
            const vr = decodeString({ max: 512 })(raw, `${apath}.${k}`);
            if (!vr.ok) { issues.push(...vr.issues); continue; }
            attrs[k] = vr.value;
          }
          return issues.length ? { ok: false, issues } : ok(attrs);
        }),
        actionId: optional(decodeString({ max: 64, pattern: /^[A-Za-z][A-Za-z0-9._-]*$/ })),
        labelFor: optional(LOCAL_ID),
        ariaDescribedBy: optional(LOCAL_ID),
        ariaLabelledBy: optional(LOCAL_ID),
      },
      { maxDepth: LIMITS.maxJsonDepth },
    )(v, path);
    if (!r.ok) return r;
    const node = r.value;
    // Buttons are always type=button; credential/payment input types are never
    // accepted (plan/17 §2, plan/28 §2).
    if (node.tag === 'input' && node.attributes?.type !== undefined) {
      const t = decodeLiteral(INSERT_UI_INPUT_TYPES)(node.attributes.type, `${path}.attributes.type`);
      if (!t.ok) return t;
    }
    if (node.tag === 'button' && node.attributes?.type !== undefined && node.attributes.type !== 'button') {
      return fail(`${path}.attributes.type`, 'conflict', 'owned buttons are always type=button — they never submit to the site');
    }
    return ok(node);
  };
}

const decodeBindActionIds = decodeArray(decodeString({ max: 64, pattern: /^[A-Za-z][A-Za-z0-9._-]*$/ }), LIMITS.maxBindActions);

const decodeLocalPredicate: Decoder<LocalPredicate> = (v, path) => {
  const type = decodeLiteral(['member-of', 'expanded-equals', 'owned-state-equals', 'text-contains'])(isPlainObject(v) ? (v as { type?: unknown }).type : undefined, `${path}.type`);
  if (!type.ok) return type;
  switch (type.value) {
    case 'member-of':
      return decodeRecord({ type: decodeLiteral(['member-of']), targetRef: TARGET_REF }, { maxDepth: LIMITS.maxJsonDepth })(v, path);
    case 'expanded-equals':
      return decodeRecord({ type: decodeLiteral(['expanded-equals']), value: decodeBoolean }, { maxDepth: LIMITS.maxJsonDepth })(v, path);
    case 'owned-state-equals':
      return decodeRecord({ type: decodeLiteral(['owned-state-equals']), value: decodeString({ max: 64 }) }, { maxDepth: LIMITS.maxJsonDepth })(v, path);
    case 'text-contains':
      return decodeRecord({ type: decodeLiteral(['text-contains']), literal: decodeString({ max: LIMITS.maxPredicateLiteralChars }) }, { maxDepth: LIMITS.maxJsonDepth })(v, path);
  }
};

// ── Ordered-batch validation: one linear pass, no graph engine ───────────

export interface BatchValidation {
  operations: Operation[];
  localIds: Map<string, number>; // localId → declaring operation index
}

/** Decode and validate 1..64 ordered operations. Local refs may name only
 *  nodes declared by an EARLIER insertUI in the same batch; duplicate local
 *  IDs are rejected; nested groups/DAG fields are unknown fields and already
 *  fail at decode. This is one linear pass, not a dependency graph. */
export function decodeOperationBatch(v: unknown, path = 'operations'): DecodeResult<Operation[]> {
  const arr = decodeArray(decodeOperation, LIMITS.maxOperations)(v, path);
  if (!arr.ok) return arr;
  const operations = arr.value;
  if (operations.length < LIMITS.minOperations) {
    return fail(path, 'out-of-bounds', `a proposal contains ${LIMITS.minOperations}..${LIMITS.maxOperations} ordered operations`);
  }
  const localIds = new Map<string, number>();
  const issues: DecodeIssue[] = [];
  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    const collect = (id: string): void => {
      if (localIds.has(id)) issues.push({ path: `${path}[${i}]`, code: 'duplicate', message: `localId "${id}" is declared by more than one node (also in operation ${localIds.get(id)})` });
      else localIds.set(id, i);
    };
    if (op.kind === 'insertUI') {
      for (const n of op.nodes) collectIds(n, collect);
    }
    const useLocal = (ref: string | undefined): void => {
      if (ref === undefined) return;
      const declaredAt = localIds.get(ref);
      if (declaredAt === undefined) {
        issues.push({ path: `${path}[${i}]`, code: 'forward-reference', message: `localRef "${ref}" names no node declared by an earlier operation (or is unknown)` });
      }
    };
    if (op.kind === 'style') for (const rule of op.rules) useLocal(rule.target.localRef);
    if ('target' in op && op.target !== undefined) useLocal(op.target.localRef);
  }
  if (issues.length) return { ok: false, issues };
  return ok(operations);
}

function collectIds(node: InsertUiNode, collect: (id: string) => void): void {
  if (node.localId !== undefined) collect(node.localId);
  for (const child of node.children ?? []) collectIds(child, collect);
}

function decodeOperation(v: unknown, path = 'operation'): DecodeResult<Operation> {
  const kind = decodeLiteral(OPERATION_KINDS)(isPlainObject(v) ? (v as { kind?: unknown }).kind : undefined, `${path}.kind`);
  if (!kind.ok) return kind;
  switch (kind.value) {
    case 'style': {
      const r = decodeRecord(
        {
          kind: decodeLiteral(['style']),
          reason: REASON,
          rules: decodeArray(decodeStyleRule, LIMITS.maxStyleRules),
          keyframes: optional(decodeArray(decodeKeyframes, LIMITS.maxCssKeyframes)),
        },
        { maxDepth: LIMITS.maxJsonDepth },
      )(v, path);
      if (!r.ok) return r;
      if (r.value.rules.length === 0) return fail(`${path}.rules`, 'out-of-bounds', 'a style operation needs 1..256 rules');
      return ok(r.value as StyleOperation);
    }
    case 'hide':
      return decodeRecord(
        { kind: decodeLiteral(['hide']), reason: REASON, target: decodeTargetSpec() },
        { maxDepth: LIMITS.maxJsonDepth },
      )(v, path) as DecodeResult<Operation>;
    case 'collapse':
      return decodeRecord(
        {
          kind: decodeLiteral(['collapse']), reason: REASON, target: decodeTargetSpec(),
          label: decodeString({ max: LIMITS.maxLabelChars }),
          initialState: optional(decodeLiteral(['collapsed', 'expanded'])),
          placement: optional(decodeLiteral(['before', 'after'])),
          userOverride: optional(decodeBoolean),
        },
        { maxDepth: LIMITS.maxJsonDepth },
      )(v, path) as DecodeResult<Operation>;
    case 'float':
      return decodeRecord(
        {
          kind: decodeLiteral(['float']), reason: REASON, target: decodeTargetSpec(),
          edge: decodeLiteral(['top-start', 'top-end', 'bottom-start', 'bottom-end']),
          width: optional(decodeString({ max: 256 })),
          maxHeight: optional(decodeString({ max: 256 })),
          inset: optional(decodeString({ max: 256 })),
        },
        { maxDepth: LIMITS.maxJsonDepth },
      )(v, path) as DecodeResult<Operation>;
    case 'replaceText': {
      const r = decodeRecord(
        {
          kind: decodeLiteral(['replaceText']), reason: REASON, target: decodeTargetSpec(),
          text: decodeString({ max: LIMITS.maxReplaceTextBytes }),
        },
        { maxDepth: LIMITS.maxJsonDepth },
      )(v, path);
      if (!r.ok) return r;
      return ok(r.value as ReplaceTextOperation);
    }
    case 'insertUI': {
      const r = decodeRecord(
        {
          kind: decodeLiteral(['insertUI']), reason: REASON, target: decodeTargetSpec(),
          position: decodeLiteral(['before', 'after', 'first-child', 'last-child']),
          nodes: (nv: unknown, npath = 'nodes') => {
            if (!Array.isArray(nv)) return fail(npath, 'type', 'expected an array of owned nodes');
            if (nv.length === 0) return fail(npath, 'out-of-bounds', 'insertUI needs at least one node');
            if (nv.length > LIMITS.maxInsertNodes) return fail(npath, 'out-of-bounds', `too many nodes (max ${LIMITS.maxInsertNodes})`);
            const out: InsertUiNode[] = [];
            const issues: DecodeIssue[] = [];
            for (let i = 0; i < nv.length; i++) {
              const nr = decodeInsertNode(1)(nv[i], `${npath}[${i}]`);
              if (nr.ok) out.push(nr.value);
              else issues.push(...nr.issues);
            }
            return issues.length ? { ok: false, issues } : ok(out);
          },
        },
        { maxDepth: LIMITS.maxJsonDepth },
      )(v, path);
      if (!r.ok) return r;
      return ok(r.value as InsertUiOperation);
    }
    case 'bindKey': {
      const r = decodeRecord(
        {
          kind: decodeLiteral(['bindKey']), reason: REASON,
          target: optional(decodeTargetSpec()),
          chord: decodeString({ max: LIMITS.maxChordChars }),
          actionIds: (av: unknown, apath = 'attributes') => {
            const ids = decodeBindActionIds(av, apath);
            if (!ids.ok) return ids;
            if (ids.value.length === 0) return fail(apath, 'out-of-bounds', 'bindKey needs 1..4 actionIds');
            return ids;
          },
          scope: optional(decodeLiteral(['document', 'target'])),
          repeat: optional(decodeBoolean),
          editablePolicy: optional(decodeLiteral(['ignore', 'allow'])),
          modalPolicy: optional(decodeLiteral(['ignore', 'allow'])),
        },
        { maxDepth: LIMITS.maxJsonDepth },
      )(v, path);
      if (!r.ok) return r;
      return ok(r.value as BindKeyOperation);
    }
    case 'localRule':
      return decodeRecord(
        {
          kind: decodeLiteral(['localRule']), reason: REASON, target: decodeTargetSpec(),
          trigger: decodeLiteral(['target-appeared', 'trusted-shortcut', 'owned-state-change']),
          targetRef: optional(TARGET_REF),
          predicates: optional(decodeArray(decodeLocalPredicate, LIMITS.maxLocalPredicates)),
          actionId: decodeString({ max: 64, pattern: /^[A-Za-z][A-Za-z0-9._-]*$/ }),
        },
        { maxDepth: LIMITS.maxJsonDepth },
      )(v, path) as DecodeResult<Operation>;
    case 'projectCollection':
      return decodeRecord(
        {
          kind: decodeLiteral(['projectCollection']), reason: REASON, target: decodeTargetSpec(),
          sourceSetRef: TARGET_REF,
          fields: decodeArray(
            decodeRecord(
              { sourceField: decodeString({ max: 128 }), label: decodeString({ max: 120 }) },
              { maxDepth: LIMITS.maxJsonDepth },
            ),
            LIMITS.maxCollectionFields,
          ),
          view: decodeLiteral(['list', 'grid', 'board']),
          groupBy: optional(decodeString({ max: 128 })),
          order: optional(decodeLiteral(['source', 'manual'])),
          showOriginal: optional(decodeBoolean),
        },
        { maxDepth: LIMITS.maxJsonDepth },
      )(v, path) as DecodeResult<Operation>;
    case 'relocate':
      return decodeRecord(
        {
          kind: decodeLiteral(['relocate']), reason: REASON, target: decodeTargetSpec(),
          destination: decodeTargetSpec(),
          position: decodeLiteral(['first-child', 'last-child', 'before', 'after']),
          placeholder: optional(decodeLiteral(['flow-slot'])),
          structuralGrant: optional(decodeBoolean),
        },
        { maxDepth: LIMITS.maxJsonDepth },
      )(v, path) as DecodeResult<Operation>;
  }
}

/** Total declaration count across a decoded proposal (plan/15 group budget). */
export function countDeclarations(operations: Operation[]): number {
  let total = 0;
  for (const op of operations) {
    if (op.kind === 'style') {
      for (const rule of op.rules) total += rule.declarations.length;
      for (const kf of op.keyframes ?? []) for (const f of kf.frames) total += f.declarations.length;
    }
  }
  return total;
}

// ── 5. Planner response union (plan/04 §3) — exactly one discriminator ───

export type ExpectationEffect =
  | 'hidden' | 'style' | 'text' | 'ui-inserted' | 'canvas-rendered'
  | 'binding-installed' | 'projection-visible' | 'relocated';

export const EXPECTATION_EFFECTS: readonly ExpectationEffect[] = [
  'hidden', 'style', 'text', 'ui-inserted', 'canvas-rendered', 'binding-installed', 'projection-visible', 'relocated',
];

export interface Expectation {
  effect: ExpectationEffect;
  targetRef?: string;
  localRef?: string;
  property?: string;
  value?: string;
}

export interface Proposal {
  kind: 'proposal';
  schemaVersion: 1;
  summary: string;
  operations: Operation[];
  expectations?: Expectation[];
}

export interface RequestEvidence {
  kind: 'requestEvidence';
  queryKind: 'expand-regions' | 'inspect-target' | 'inspect-fields' | 'resolve-selector';
  targetRef?: string;
  fields?: string[];
  cursor?: string;
}

export interface PlannerQuestion {
  kind: 'question';
  question: string;
  options: string[];
  reason: string;
}

export interface CannotComplete {
  kind: 'cannotComplete';
  reason: string;
  missingCapability?: string;
}

export type PlannerResponse = Proposal | RequestEvidence | PlannerQuestion | CannotComplete;

const RESPONDER_KINDS = ['proposal', 'requestEvidence', 'question', 'cannotComplete'] as const;

export function decodePlannerResponse(v: unknown, path = 'response'): DecodeResult<PlannerResponse> {
  const kind = decodeLiteral(RESPONDER_KINDS)(isPlainObject(v) ? (v as { kind?: unknown }).kind : undefined, `${path}.kind`);
  if (!kind.ok) return kind;
  switch (kind.value) {
    case 'proposal': {
      const r = decodeRecord(
        {
          kind: decodeLiteral(['proposal']),
          schemaVersion: decodeFiniteNumber({ integer: true, min: 1, max: 1 }),
          summary: decodeString({ max: LIMITS.maxSummaryChars }),
          operations: (ov: unknown, opath = 'operations') => decodeOperationBatch(ov, opath),
          expectations: optional(
            decodeArray(
              decodeRecord(
                {
                  effect: decodeLiteral(EXPECTATION_EFFECTS),
                  targetRef: optional(TARGET_REF),
                  localRef: optional(LOCAL_REF),
                  property: optional(CSS_PROPERTY),
                  value: optional(decodeString({ max: 512 })),
                },
                { maxDepth: LIMITS.maxJsonDepth },
              ),
              LIMITS.maxExpectations,
            ),
          ),
        },
        { maxDepth: LIMITS.maxJsonDepth },
      )(v, path);
      if (!r.ok) return r;
      const value = r.value;
      if (countDeclarations(value.operations) > LIMITS.maxDeclarationsTotal) {
        return fail(`${path}.operations`, 'out-of-bounds', `proposal exceeds ${LIMITS.maxDeclarationsTotal} total declarations`);
      }
      // Expectation refs must resolve within the batch namespace.
      if (value.expectations) {
        const declared = new Set(localIdsOf(value.operations));
        for (const e of value.expectations) {
          if (e.localRef !== undefined && !declared.has(e.localRef)) {
            return fail(`${path}.expectations`, 'forward-reference', `expectation localRef "${e.localRef}" names no declared node`);
          }
        }
      }
      return ok({ kind: 'proposal', schemaVersion: 1, summary: value.summary, operations: value.operations, expectations: value.expectations });
    }
    case 'requestEvidence':
      return decodeRecord(
        {
          kind: decodeLiteral(['requestEvidence']),
          queryKind: decodeLiteral(['expand-regions', 'inspect-target', 'inspect-fields', 'resolve-selector']),
          targetRef: optional(TARGET_REF),
          fields: optional(decodeArray(decodeString({ max: 128 }), 32)),
          cursor: optional(decodeString({ max: 256 })),
        },
        { maxDepth: LIMITS.maxJsonDepth },
      )(v, path) as DecodeResult<PlannerResponse>;
    case 'question': {
      const r = decodeRecord(
        {
          kind: decodeLiteral(['question']),
          question: decodeString({ max: 1000 }),
          options: decodeArray(decodeString({ max: 300 }), LIMITS.maxQuestionOptions),
          reason: decodeString({ max: 1000 }),
        },
        { maxDepth: LIMITS.maxJsonDepth },
      )(v, path);
      if (!r.ok) return r;
      if (r.value.options.length < LIMITS.minQuestionOptions) {
        return fail(`${path}.options`, 'out-of-bounds', `a question offers ${LIMITS.minQuestionOptions}..${LIMITS.maxQuestionOptions} options (custom answer is always allowed)`);
      }
      return ok(r.value as PlannerQuestion);
    }
    case 'cannotComplete':
      return decodeRecord(
        {
          kind: decodeLiteral(['cannotComplete']),
          reason: decodeString({ max: 1000 }),
          missingCapability: optional(decodeString({ max: 128 })),
        },
        { maxDepth: LIMITS.maxJsonDepth },
      )(v, path) as DecodeResult<PlannerResponse>;
  }
}

function localIdsOf(operations: Operation[]): string[] {
  const ids: string[] = [];
  for (const op of operations) {
    if (op.kind === 'insertUI') {
      const walk = (n: InsertUiNode): void => { if (n.localId !== undefined) ids.push(n.localId); for (const c of n.children ?? []) walk(c); };
      for (const n of op.nodes) walk(n);
    }
  }
  return ids;
}


// ── 5b. Observation records (plan/04 §2) ─────────────────────────────────

export interface RegionSemantics {
  tag: string;
  /** Author-declared role when present; otherwise the landmark
   *  approximation is labeled as such — never claimed as ARIA-tree parity. */
  role?: string;
  roleSource?: 'declared' | 'landmark-approximation';
  /** Accessible-name approximation from aria-label/alt/placeholder/label
   *  association; privacy-redacted. Labeled approximation. */
  nameApprox?: string;
  nameSource?: 'aria-label' | 'alt' | 'placeholder' | 'aria-labelledby' | 'title-attr' | 'button-text';
}

export interface RegionGeometry {
  /** Quantized viewport-relative rect (CSS px, rounded to integers). */
  x: number; y: number; w: number; h: number;
  inViewport: boolean;
  clipped?: boolean;
}

export interface Region {
  targetRef: string;
  rootRef: string;
  parentRef?: string;
  kind: 'element';
  semantics: RegionSemantics;
  textSample?: string;
  textLength?: number;
  geometry: RegionGeometry;
  stability: 'session-only';
  hidden: boolean;
  /** Action catalog ids this region participates in. */
  affordances?: string[];
}

export interface ActionEntry {
  actionId: string;
  kind: 'button' | 'link' | 'input' | 'select' | 'textarea' | 'submit';
  targetRef: string;
  /** Declared control type (input type attr) — never a value. */
  controlType?: string;
  disabled: boolean;
}

export interface SnapshotCoverage {
  visitedNodes: number;
  selectedRegions: number;
  completed: boolean;
  reason?: 'node-budget' | 'time-budget' | 'privacy' | 'unsupported-root' | 'unstable';
  nextCursor?: string;
}

export interface PageSnapshot {
  schemaVersion: 1;
  snapshotId: string;
  collectedAt: number;
  viewport: { width: number; height: number };
  documentMetadata: { origin: string; titleRedacted?: string };
  roots: Array<{ rootId: string; kind: 'document' | 'shadow-root' }>;
  regions: Region[];
  actions: ActionEntry[];
  coverage: SnapshotCoverage;
}

export interface SnapshotCursor {
  snapshotId: string;
  epoch: number;
  offset: number;
  expiresAt: number;
}

// ── 6. Records: scope, descriptor, customization, origin (plan/04 §2/§4) ─

export const ORIGIN_RECORD_SCHEMA_VERSION = 2;

export type ScopeMode = 'exactPath' | 'pathPrefix' | 'origin';

/** plan/13 §2: a route discriminator is a user-selected allowlisted query key
 *  with its approved value, or an approved hash value. Stored values are the
 *  exact approved strings — no automatic wildcard over all query values. */
export type RouteDiscriminator =
  | { kind: 'query'; key: string; value: string }
  | { kind: 'hash'; value: string };

export interface RouteScope {
  mode: ScopeMode;
  path?: string; // required for exactPath/pathPrefix
  discriminators?: RouteDiscriminator[]; // optional, user-approved at save time
}

const DISCRIMINATOR = (v: unknown, path = 'discriminator'): DecodeResult<RouteDiscriminator> => {
  const r = decodeRecord(
    {
      kind: decodeLiteral(['query', 'hash']),
      key: optional(decodeString({ max: 128, pattern: /^[^\s&=#]+$/ })),
      value: decodeString({ max: LIMITS.maxDiscriminatorValueChars, pattern: /^[^\s]+$/ }),
    },
    { maxDepth: LIMITS.maxJsonDepth },
  )(v, path);
  if (!r.ok) return r;
  const d = r.value;
  if (d.kind === 'query' && d.key === undefined) {
    return fail(`${path}.key`, 'missing', 'a query discriminator requires its allowlisted key');
  }
  if (d.kind === 'hash' && d.key !== undefined) {
    return fail(`${path}.key`, 'unknown-value', 'a hash discriminator carries no query key');
  }
  return ok(d as RouteDiscriminator);
};

export const decodeRouteScope: Decoder<RouteScope> = (v, path = 'scope') => {
  const r = decodeRecord(
    {
      mode: decodeLiteral(['exactPath', 'pathPrefix', 'origin']),
      path: optional(decodeString({ max: 2048, pattern: /^\/.*$/ })),
      discriminators: optional(decodeArray(DISCRIMINATOR, LIMITS.maxRouteDiscriminators)),
    },
    { maxDepth: LIMITS.maxJsonDepth },
  )(v, path);
  if (!r.ok) return r;
  if (r.value.mode !== 'origin' && r.value.path === undefined) {
    return fail(`${path}.path`, 'missing', `scope mode "${r.value.mode}" requires a path`);
  }
  return ok(r.value);
};

export type ContinuityPolicy = 'session-instance' | 'stable-single' | 'future-set';
export type Stability = 'session-only' | 'stable-anchor' | 'set-template' | 'ambiguous';

export interface TargetDescriptor {
  descriptorVersion: 1;
  rootPath: string[];
  selection: 'single' | 'set';
  anchor: {
    tag?: string;
    stableId?: string;
    testAttribute?: { name: string; value: string };
    role?: string;
    accessibleLabel?: string;
  };
  relation: 'self' | 'descendant' | 'direct-child' | 'sibling';
  semanticGuards?: { role?: string; controlType?: string; textDiscriminator?: string };
  matchBounds: { min: number; max: number };
  routeScopeRef: string;
  continuityPolicy: ContinuityPolicy;
}

export const decodeTargetDescriptor: Decoder<TargetDescriptor> = (v, path = 'descriptor') => {
  const r = decodeRecord(
    {
      descriptorVersion: decodeFiniteNumber({ integer: true, min: 1, max: 1 }),
      rootPath: decodeArray(decodeString({ max: 256, pattern: /^[A-Za-z0-9._:-]+$/ }), 16),
      selection: decodeLiteral(['single', 'set']),
      anchor: decodeRecord(
        {
          tag: optional(decodeString({ max: 64, pattern: /^[a-zA-Z][a-zA-Z0-9-]*$/ })),
          stableId: optional(decodeString({ max: 256 })),
          testAttribute: optional(decodeRecord({ name: decodeString({ max: 128, pattern: /^data-[a-z0-9-]+$/ }), value: decodeString({ max: 256 }) }, { maxDepth: LIMITS.maxJsonDepth })),
          role: optional(decodeString({ max: 64, pattern: /^[a-z]+$/ })),
          accessibleLabel: optional(decodeString({ max: 300 })),
        },
        { maxDepth: LIMITS.maxJsonDepth },
      ),
      relation: decodeLiteral(['self', 'descendant', 'direct-child', 'sibling']),
      semanticGuards: optional(
        decodeRecord(
          {
            role: optional(decodeString({ max: 64, pattern: /^[a-z]+$/ })),
            controlType: optional(decodeString({ max: 64, pattern: /^[a-z]+$/ })),
            textDiscriminator: optional(decodeString({ max: 300 })),
          },
          { maxDepth: LIMITS.maxJsonDepth },
        ),
      ),
      matchBounds: decodeRecord(
        {
          min: decodeFiniteNumber({ integer: true, min: 0 }),
          max: decodeFiniteNumber({ integer: true, min: 1, max: LIMITS.maxSetActiveMembers }),
        },
        { maxDepth: LIMITS.maxJsonDepth },
      ),
      routeScopeRef: decodeString({ max: 256 }),
      continuityPolicy: decodeLiteral(['session-instance', 'stable-single', 'future-set']),
    },
    { maxDepth: LIMITS.maxJsonDepth },
  )(v, path);
  if (!r.ok) return r;
  const d = r.value;
  if (d.selection === 'single' && d.matchBounds.max !== 1) {
    return fail(`${path}.matchBounds.max`, 'conflict', 'a single-target descriptor requires exactly max 1');
  }
  if (d.matchBounds.min > d.matchBounds.max) {
    return fail(`${path}.matchBounds`, 'conflict', 'matchBounds.min must not exceed max');
  }
  if (d.continuityPolicy === 'future-set' && d.selection !== 'set') {
    return fail(path, 'conflict', 'future-set continuity requires selection "set"');
  }
  return ok(d as TargetDescriptor);
};

export interface Revision {
  revisionId: string;
  parentRevisionId?: string;
  capabilityVersion: 1;
  targetDescriptors: TargetDescriptor[];
  operations: Operation[];
  savedAt: number;
  source: 'user-planned' | 'imported-reviewed';
  providerSummary?: { profileId: string; modelId: string };
}

export interface Customization {
  customizationId: string;
  title: string;
  enabled: boolean;
  scope: RouteScope;
  activeRevisionId: string;
  revisions: Revision[];
  createdAt: number;
  updatedAt: number;
  contentSensitivity: 'page-only' | 'includes-user-content';
  grants: string[];
}

export interface OriginRecord {
  schemaVersion: 2;
  origin: string;
  recordRevision: number;
  lastMutationId: string;
  customizations: Customization[];
  updatedAt: number;
  /** plan/13 §6: bounded removal tombstones — a stale session cannot
   *  resurrect a removed customizationId until the stale deadline passes. */
  tombstones?: Tombstone[];
}

export interface Tombstone {
  customizationId: string;
  mutationId: string;
  at: number;
}

const ID = decodeString({ max: 128, pattern: /^[A-Za-z0-9._:-]+$/ });

export const decodeRevision: Decoder<Revision> = (v, path) => {
  const r = decodeRecord(
    {
      revisionId: ID,
      parentRevisionId: optional(ID),
      capabilityVersion: decodeFiniteNumber({ integer: true, min: 1, max: 1 }),
      targetDescriptors: decodeArray(decodeTargetDescriptor, 64),
      operations: (ov: unknown, opath = 'operations') => decodeOperationBatch(ov, opath),
      savedAt: decodeFiniteNumber({ integer: true, min: 0 }),
      source: decodeLiteral(['user-planned', 'imported-reviewed']),
      providerSummary: optional(
        decodeRecord(
          { profileId: ID, modelId: decodeString({ max: 256 }) },
          { maxDepth: LIMITS.maxJsonDepth },
        ),
      ),
    },
    { maxDepth: LIMITS.maxJsonDepth },
  )(v, path);
  if (!r.ok) return r;
  return ok(r.value as Revision);
};

export const decodeCustomization: Decoder<Customization> = decodeRecord(
  {
    customizationId: ID,
    title: decodeString({ max: LIMITS.maxTitleChars }),
    enabled: decodeBoolean,
    scope: decodeRouteScope,
    activeRevisionId: ID,
    revisions: decodeArray(decodeRevision, 64),
    createdAt: decodeFiniteNumber({ integer: true, min: 0 }),
    updatedAt: decodeFiniteNumber({ integer: true, min: 0 }),
    contentSensitivity: decodeLiteral(['page-only', 'includes-user-content']),
    grants: decodeArray(ID, 64),
  },
  { maxDepth: LIMITS.maxJsonDepth },
);

export const decodeOriginRecord: Decoder<OriginRecord> = (v, path = 'record') => {
  const r = decodeRecord(
    {
      schemaVersion: decodeFiniteNumber({ integer: true, min: ORIGIN_RECORD_SCHEMA_VERSION, max: ORIGIN_RECORD_SCHEMA_VERSION }),
      origin: decodeString({ max: 512, pattern: /^https?:\/\/[^\s]+$/ }),
      recordRevision: decodeFiniteNumber({ integer: true, min: 0 }),
      lastMutationId: ID,
      customizations: decodeArray(decodeCustomization, 256),
      updatedAt: decodeFiniteNumber({ integer: true, min: 0 }),
      tombstones: optional(
        decodeArray(
          decodeRecord(
            { customizationId: ID, mutationId: ID, at: decodeFiniteNumber({ integer: true, min: 0 }) },
            { maxDepth: LIMITS.maxJsonDepth },
          ),
          LIMITS.maxTombstones,
        ),
      ),
    },
    { maxDepth: LIMITS.maxJsonDepth },
  )(v, path);
  if (!r.ok) return r;
  const rec = r.value as OriginRecord;
  // Referential integrity: activeRevisionId must name a stored revision.
  for (const c of rec.customizations) {
    if (!c.revisions.some((rev) => rev.revisionId === c.activeRevisionId)) {
      return fail(`${path}.customizations`, 'unknown-value', `activeRevisionId "${c.activeRevisionId}" names no stored revision`);
    }
  }
  return ok(rec);
};

// ── 7. Provider profiles and grants (plan/04 §6, plan/11, plan/17 §4) ────

export const PROFILE_VERSION = 1;

export type ProviderProtocol = 'openai-chat' | 'anthropic-messages';

export interface ProviderCapabilities {
  jsonSchemaMode?: boolean;
  jsonObjectMode?: boolean;
  streaming?: boolean;
  systemRole?: boolean;
  tokenParameter?: 'max_tokens' | 'max_completion_tokens';
}

export interface ProviderProfile {
  profileVersion: 1;
  profileId: string;
  label: string;
  protocol: ProviderProtocol;
  endpoint: string; // exact URL; https, or http on loopback only (plan/17 §4)
  modelId: string;
  auth: { kind: 'bearer' | 'api-key-header' | 'none'; headerName?: string };
  capabilities?: ProviderCapabilities;
  contextLimit?: number;
  outputLimit?: number;
  callTimeoutMs?: number;
}

const HTTPS_ENDPOINT = (v: unknown, path = 'endpoint'): DecodeResult<string> => {
  const s = decodeString({ max: LIMITS.maxEndpointChars })(v, path);
  if (!s.ok) return s;
  let url: URL;
  try { url = new URL(s.value); } catch { return fail(path, 'invalid-id', 'endpoint must be an absolute URL'); }
  if (url.protocol === 'https:') return ok(s.value);
  if (url.protocol === 'http:') {
    const host = url.hostname;
    const loopback = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
    if (loopback) return ok(s.value);
    return fail(path, 'denied', 'plain HTTP is allowed only for loopback hosts (local models)');
  }
  return fail(path, 'denied', `unsupported endpoint protocol "${url.protocol}"`);
};

const FORBIDDEN_HEADER_NAMES = new Set([
  'host', 'content-length', 'connection', 'origin', 'referer', 'user-agent',
  'cookie', 'authorization', 'accept-encoding', 'expect',
]);

export const decodeProviderProfile: Decoder<ProviderProfile> = (v, path = 'profile') => {
  const r = decodeRecord(
    {
      profileVersion: decodeFiniteNumber({ integer: true, min: PROFILE_VERSION, max: PROFILE_VERSION }),
      profileId: ID,
      label: decodeString({ max: 120 }),
      protocol: decodeLiteral(['openai-chat', 'anthropic-messages']),
      endpoint: HTTPS_ENDPOINT,
      modelId: decodeString({ max: 256, min: 1 }),
      auth: decodeRecord(
        {
          kind: decodeLiteral(['bearer', 'api-key-header', 'none']),
          headerName: optional((hv: unknown, hpath = 'headerName') => {
            const s = decodeString({ max: 64, pattern: /^[A-Za-z0-9-]+$/ })(hv, hpath);
            if (!s.ok) return s;
            if (FORBIDDEN_HEADER_NAMES.has(s.value.toLowerCase())) {
              return fail(hpath, 'denied', `"${s.value}" is a browser-owned/hop-by-hop header and cannot be overridden`);
            }
            return ok(s.value);
          }),
        },
        { maxDepth: LIMITS.maxJsonDepth },
      ),
      capabilities: optional(
        decodeRecord(
          {
            jsonSchemaMode: optional(decodeBoolean),
            jsonObjectMode: optional(decodeBoolean),
            streaming: optional(decodeBoolean),
            systemRole: optional(decodeBoolean),
            tokenParameter: optional(decodeLiteral(['max_tokens', 'max_completion_tokens'])),
          },
          { maxDepth: LIMITS.maxJsonDepth },
        ),
      ),
      contextLimit: optional(decodeFiniteNumber({ integer: true, min: 1024, max: 10_000_000 })),
      outputLimit: optional(decodeFiniteNumber({ integer: true, min: 256, max: 1_000_000 })),
      callTimeoutMs: optional(decodeFiniteNumber({ integer: true, min: 1000, max: 600_000 })),
    },
    { maxDepth: LIMITS.maxJsonDepth },
  )(v, path);
  if (!r.ok) return r;
  const p = r.value as ProviderProfile;
  if (p.auth.kind === 'api-key-header' && p.auth.headerName === undefined) {
    return fail(`${path}.auth.headerName`, 'missing', 'api-key-header auth requires a headerName');
  }
  return ok(p);
}

export interface UserGrant {
  grantVersion: 1;
  grantId: string;
  origin: string;
  routeScope: RouteScope;
  capabilityCategories: ('style' | 'text' | 'ui-insert' | 'behavior' | 'projection' | 'relocation' | 'persist')[];
  disclosureVersion: number;
  approvedAt: number;
  expiresAt?: number;
}

export const decodeUserGrant: Decoder<UserGrant> = (v, path = 'grant') => {
  const r = decodeRecord(
    {
      grantVersion: decodeFiniteNumber({ integer: true, min: 1, max: 1 }),
      grantId: ID,
      origin: decodeString({ max: 512, pattern: /^https?:\/\/[^\s]+$/ }),
      routeScope: decodeRouteScope,
      capabilityCategories: decodeArray(
        decodeLiteral(['style', 'text', 'ui-insert', 'behavior', 'projection', 'relocation', 'persist']),
        8,
      ),
      disclosureVersion: decodeFiniteNumber({ integer: true, min: 1 }),
      approvedAt: decodeFiniteNumber({ integer: true, min: 0 }),
      expiresAt: optional(decodeFiniteNumber({ integer: true, min: 0 })),
    },
    { maxDepth: LIMITS.maxJsonDepth },
  )(v, path);
  if (!r.ok) return r;
  return ok(r.value as UserGrant);
};

/** A model- or page-supplied "consent" flag is never authority (I19, T25). */
export function isAuthoritySignal(): false {
  return false;
}

// ── 9. Trust boundaries (S1.2 — invariants I18/I19/I24; T04/T21/T25) ────

/**
 * Denied-by-default trust policy over PLAIN sender metadata.
 *
 * The browser reports `chrome.runtime.MessageSender`; the broker (S2.1) will
 * pass that object here as plain data. This layer never touches chrome.*.
 * Classification is structural — what the BROWSER reports about the sender —
 * never what a message payload claims. No payload field (`role`, `consent`,
 * `grant`, `source`, …) is ever authority (I19, T25).
 */
export type SenderRole = 'workspace' | 'broker' | 'runtime' | 'unknown';

export interface SenderTabLike {
  id?: number;
  url?: string;
}

/** Structural mirror of the fields the browser reports on a MessageSender. */
export interface SenderLike {
  id?: string;
  url?: string;
  origin?: string;
  tab?: SenderTabLike;
  frameId?: number;
  documentId?: string;
}

function isWebUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Classify a message sender into exactly one role, or `unknown` (denied for
 * every Kind). Extension pages win first (the fallback workspace tab also
 * reports a tab), then the service worker (only the id is set), then the
 * per-document runtime (tab + frame + documentId + web URL).
 */
export function classifySender(sender: SenderLike, ownExtensionId: string): SenderRole {
  if (typeof sender.id !== 'string' || sender.id !== ownExtensionId) return 'unknown';
  const origin = typeof sender.origin === 'string' ? sender.origin : undefined;
  const url = typeof sender.url === 'string' ? sender.url : undefined;
  const ownOrigin = `chrome-extension://${ownExtensionId}`;
  if (origin === ownOrigin) return 'workspace';
  if (url !== undefined && url.startsWith(`${ownOrigin}/`)) return 'workspace';
  if (
    origin === undefined && url === undefined && sender.tab === undefined &&
    sender.frameId === undefined && sender.documentId === undefined
  ) {
    return 'broker';
  }
  if (
    sender.tab !== undefined && typeof sender.frameId === 'number' && sender.frameId >= 0 &&
    typeof sender.documentId === 'string' && url !== undefined && isWebUrl(url)
  ) {
    return 'runtime';
  }
  return 'unknown';
}

/**
 * Per-Kind sender-role allowlist from plan/06 §1 (sender column). Receivers
 * verify the role independently of the payload; a payload can never elevate
 * its sender. Unknown Kinds deny every role.
 */
const KIND_SENDER_ROLES: Readonly<Record<string, readonly SenderRole[]>> = {
  RegisterDocument: ['runtime'],
  StartRun: ['workspace'],
  CancelRun: ['workspace'],
  Observe: ['workspace'],
  Inspect: ['workspace'],
  Expand: ['workspace'],
  ValidateProposal: ['workspace'],
  ApplyBatch: ['workspace'],
  GetOperation: ['workspace', 'broker'],
  StageStyle: ['runtime'],
  RemoveStyle: ['runtime'],
  CommitComposition: ['runtime'],
  RenewLease: ['workspace'],
  // plan/04 §4: the broker alone writes OriginRecords — content runtimes can
  // never save/enable/remove, whatever a page asks them to forward.
  SaveRevision: ['workspace'],
  SetEnabled: ['workspace'],
  RemoveCustomization: ['workspace'],
  GetOriginRecord: ['workspace'],
  ExportQuarantine: ['workspace'],
  // S5.2: broker-relayed record continuity (the broker forwards confirmed
  // record mutations to registered runtimes; a workspace may also address
  // its own document directly, as with ApplyBatch).
  SavedRevision: ['workspace', 'broker'],
  RuntimeState: ['workspace'],
  RunProgress: ['workspace'],
  RouteChanged: ['broker'],
  PermissionRevoked: ['broker'],
  AnswerQuestion: ['workspace'],
  ApproveProposal: ['workspace'],
};

export function senderMayInvoke(role: SenderRole, kind: string): boolean {
  if (role === 'unknown') return false;
  return KIND_SENDER_ROLES[kind]?.includes(role) ?? false;
}

/**
 * Credentials live in trusted contexts only (plan/17 §4). The workspace may
 * SUBMIT a credential for storage; only the broker reads credentials back —
 * and it never echoes them into replies, logs, exports, or messages to
 * content runtimes (T25: no credential in any content-bound DTO).
 */
export function maySubmitCredentials(role: SenderRole): boolean {
  return role === 'workspace' || role === 'broker';
}

export function mayReadCredentials(role: SenderRole): boolean {
  return role === 'broker';
}

/**
 * Provider disclosure and consent (plan/17 §4–5, plan/04 §6). The disclosure
 * identifies what is sent (page evidence + goal), where (the exact provider
 * endpoint), retention (provider policy) and the local-only guarantee for
 * saved customizations. An acknowledgement is valid only for the exact
 * current disclosure version AND the exact configured endpoint: changing the
 * endpoint invalidates consent and requires explicit re-acknowledgement.
 * Merely opening settings creates no acknowledgement record, so it can never
 * count as consent — nor can a legacy boolean flag or a page/model "consent".
 */
export const PROVIDER_DISCLOSURE_VERSION = 1;

export interface DisclosureAck {
  disclosureVersion: number;
  endpoint: string;
  acknowledgedAt: number;
}

const DISCLOSURE_ACK_DECODER = decodeRecord(
  {
    disclosureVersion: decodeFiniteNumber({ integer: true, min: 1, max: 1000 }),
    endpoint: decodeString({ max: LIMITS.maxEndpointChars }),
    acknowledgedAt: decodeFiniteNumber({ integer: true, min: 0 }),
  },
  { maxDepth: 8 },
);

export const decodeDisclosureAck: Decoder<DisclosureAck> = (v, path = 'ack') => DISCLOSURE_ACK_DECODER(v, path);

export type ConsentDecision = { ok: true } | { ok: false; reason: string };

export function evaluateProviderConsent(ack: unknown, configuredEndpoint: string): ConsentDecision {
  const r = DISCLOSURE_ACK_DECODER(ack, 'ack');
  if (!r.ok) {
    const i = r.issues[0];
    return { ok: false, reason: `acknowledgement record missing or malformed (${i?.path}: ${i?.message})` };
  }
  const a = r.value as DisclosureAck;
  if (a.disclosureVersion !== PROVIDER_DISCLOSURE_VERSION) {
    return { ok: false, reason: `acknowledged disclosure v${a.disclosureVersion} is not the current v${PROVIDER_DISCLOSURE_VERSION}; re-acknowledge` };
  }
  if (a.endpoint !== configuredEndpoint) {
    return { ok: false, reason: 'acknowledged disclosure was for a different endpoint; consent does not carry over' };
  }
  return { ok: true };
}

/**
 * Site (page) permission is separate from provider permission (plan/17 §4).
 * An activeTab session grant covers the selected document for the session; a
 * saved grant is explicit, versioned and scoped to one origin plus capability
 * categories. Both fail closed; expiry is evaluated against an explicit
 * `nowMs` so this layer stays pure and clock-free.
 */
export function evaluateSitePermission(
  grant: UserGrant | undefined,
  origin: string,
  category: UserGrant['capabilityCategories'][number],
  nowMs: number,
): ConsentDecision {
  if (grant === undefined) return { ok: false, reason: 'no site grant for this origin' };
  if (grant.grantVersion !== 1) return { ok: false, reason: 'unsupported site grant version' };
  if (grant.origin !== origin) return { ok: false, reason: 'site grant is for a different origin' };
  if (!grant.capabilityCategories.includes(category)) return { ok: false, reason: `capability category "${category}" is not granted` };
  if (grant.expiresAt !== undefined && nowMs > grant.expiresAt) return { ok: false, reason: 'site grant has expired' };
  return { ok: true };
}

/**
 * Credentials are never placed in URLs and never follow a cross-host
 * redirect (plan/17 §4; T25). These guards are the pure policy the provider
 * client (S6.1) must call before every request and redirect evaluation.
 */
export function credentialAppearsInUrl(credential: string, url: string): boolean {
  if (credential === '') return false;
  try {
    const u = new URL(url);
    return (
      u.search.includes(credential) || u.hash.includes(credential) ||
      u.username.includes(credential) || u.password.includes(credential)
    );
  } catch {
    return url.includes(credential);
  }
}

// ── Field-level evidence minimization (T04) ─────────────────────────────

/**
 * Residual redaction layer over kept evidence strings (plan/17 §5: regular
 * expressions may redact residual content, but are not a substitute for
 * field selection — S3 observation performs the primary field selection;
 * this is the last filter before anything leaves the extension).
 */
const REDACTIONS: ReadonlyArray<{ re: RegExp; to: string }> = [
  { re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, to: '[redacted:email]' },
  { re: /bearer\s+[-a-z0-9._~+/]+=*/gi, to: '[redacted:bearer]' },
  {
    re: /([?&])(token|key|auth|api_?key|access_?token|refresh_?token|sig|signature|password|passwd|secret|code)=[^&\s]*/gi,
    to: '$1$2=[redacted]',
  },
];

export function redactSensitiveText(text: string): string {
  let out = text;
  for (const { re, to } of REDACTIONS) out = out.replace(re, to);
  return out;
}

/**
 * Sensitive evidence FIELD names (exact, case-insensitive) dropped by
 * `minimizeEvidence` wherever they appear. The reserved name `value` covers
 * form-control values: evidence field names are explicit, so design facts
 * must use specific names (text, color, fontSize, …) — never `value`.
 */
const SENSITIVE_FIELD_NAMES: ReadonlySet<string> = new Set([
  'value', 'inputvalue', 'password', 'passwd', 'email', 'mail', 'token',
  'secret', 'apikey', 'api_key', 'authorization', 'auth', 'cookie', 'cookies',
  'credential', 'credentials', 'card', 'cardnumber', 'card_number', 'cvv',
  'cvc', 'ssn', 'phone', 'tel', 'html', 'innerhtml', 'outerhtml',
  'sourcehtml', 'source_html', 'localstorage', 'sessionstorage', 'indexeddb',
  'screenshot', 'bearer',
]);

function isSensitiveFieldName(key: string): boolean {
  const normalized = key.toLowerCase();
  if (normalized.startsWith('data-')) return true; // hidden DOM/private attributes (plan/17 §5)
  return SENSITIVE_FIELD_NAMES.has(normalized);
}

/** URL-shaped evidence fields keep origin + pathname only (plan/17 §5: full URLs excluded; tokens live in queries). */
function isUrlFieldName(key: string): boolean {
  const k = key.toLowerCase();
  return k.endsWith('url') || k.endsWith('href') || k.endsWith('src') || k.endsWith('uri') || k.endsWith('link');
}

function minimizeUrlField(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      return redactSensitiveText(`${u.origin}${u.pathname}`); // userinfo/query/fragment never leave
    }
    return '[dropped:url]'; // non-web schemes never leave the extension
  } catch {
    return redactSensitiveText(raw); // relative reference — residual redaction only
  }
}

/**
 * Minimize observation-shaped plain evidence before it leaves the extension
 * (provider payload, log, export): sensitive fields are dropped entirely —
 * values are never rewritten inside field names or wire contracts — and kept
 * strings pass through the residual redaction layer. Depth pressure is an
 * explicit marker, never silent truncation. Pure: the input is not mutated.
 */
export function minimizeEvidence(value: unknown, depth = 0): unknown {
  if (depth > LIMITS.maxJsonDepth) return '[evidence:depth-limit]';
  if (typeof value === 'string') return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map((v) => minimizeEvidence(v, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveFieldName(key)) continue;
      out[key] = isUrlFieldName(key) && typeof v === 'string' ? minimizeUrlField(v) : minimizeEvidence(v, depth + 1);
    }
    return out;
  }
  return value;
}

export function isAllowedRedirect(originalEndpoint: string, redirectUrl: string): boolean {
  try {
    return new URL(redirectUrl).origin === new URL(originalEndpoint).origin;
  } catch {
    return false;
  }
}

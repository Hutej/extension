/**
 * runtime/transaction — one-batch reversible application (plan/03
 * `runtime/transaction`, plan/08 §4–5, algorithms A4/A5).
 *
 * One proposal is one ordered batch and one revision (I11): every operation
 * prepares an owned inverse BEFORE any side effect (I05); the whole batch
 * accepts only after inert staging, the single synchronous write section and
 * delivery/placement verification all pass — any failure rolls the ENTIRE
 * candidate back without touching independent accepted customizations
 * (I12). Rollback is compare-and-restore on the SAME native reference
 * (I08/I09): a failed candidate returns the predecessor's effective value; a
 * release (disable/remove) returns the underlying site baseline. A site value
 * that changed meanwhile is never overwritten — the conflict stays visible
 * (I10/I23). No clone, no innerHTML, no global undoAll.
 *
 * Canonical composition (plan/08 §3): ONE accepted aggregate bundle per
 * document, recomposed from all accepted revisions' fragments in
 * customization acceptance order, then operation order. A candidate stages a
 * candidate aggregate = unchanged accepted fragments (recompiled with
 * identical values/order under the new generation token) + the candidate
 * fragment — at most one accepted and one candidate physical bundle (the
 * broker boundary enforces the rest). Uniform :where() specificity means
 * canonical order, not sheet insertion order, decides.
 *
 * Supported v1 executors: style, hide (a display fragment through the same
 * path), replaceText, insertUI. Everything else is refused
 * `unsupported-capability` BEFORE any side effect (plan/08 §1). Structured
 * effect/integrity measurement is S4.3; this task verifies delivery,
 * placement and written values — real checks, never a fake pass.
 */

import {
  decodeOperationBatch,
  type DocumentKey,
  type ErrorRecord,
  type Operation,
  type ReceiptStatus,
  type StyleOperation,
} from '../contracts.ts';
import {
  compileInsertUi,
  compileStyleOperation,
  type HighImpactRisk,
} from './compile.ts';
import type { Verifier, VerificationReport, VerifyPlan } from './verify.ts';
import type { ContentCreator } from './content.ts';
import type { ResolvedTargetRegistry } from './targets.ts';
import { TOKEN_ATTRIBUTE, type TokenScope } from './styles.ts';
import {
  COLLAPSED_ATTRIBUTE, MAX_BINDINGS_PER_DOCUMENT, type BehaviorCore, type BindingSpec,
  type CollapseWiring, type RulePredicate, type RuleSpec, disclosureState, evaluateRule, isBindActionId,
  isRuleActionId, parseChord, plainTypingChord, reservedChord, validateBindAction, wireCollapseToggle,
} from './behavior.ts';

// ── style-delivery client seam (runtime→broker; no background import) ──

export interface StageOrderLike {
  operationId: string;
  namespace: string;
  css: string;
  rootId?: string;
}

export type StyleOutcome =
  | { ok: true; state: 'inserted' | 'removed' | 'committed' }
  | { ok: true; state: 'unknown' }
  | { ok: false; code: string; message: string };

export interface StyleClient {
  stage(order: StageOrderLike): Promise<StyleOutcome>;
  remove(operationId: string, css?: string): Promise<StyleOutcome>;
  commit(operationId: string): Promise<StyleOutcome>;
}

// ── public shapes ────────────────────────────────────────────────────────

export interface BatchRequest {
  batchId: string;
  customizationId: string;
  revisionId: string;
  operations: Operation[];
}

export interface BatchReceipt {
  batchId: string;
  payloadDigest: string;
  status: ReceiptStatus;
  resourceIds: string[];
  routeEpoch?: number;
  error?: ErrorRecord;
  /** Bounded conflict claims: what stayed conflicting and why (I10). */
  conflicts?: string[];
  /** Predecessor-bundle cleanup failed: the bytes stay recorded and block
   *  another replacement until reconciled (plan/08 §3). */
  cleanupPending?: boolean;
  /** S4.3: the exact-revision VerificationReport that gated acceptance. */
  report?: VerificationReport;
}

export interface TransactionDeps {
  doc: Document;
  targets: ResolvedTargetRegistry;
  tokens: TokenScope;
  content: ContentCreator;
  routeEpoch(): number;
  documentKey(): DocumentKey | null;
  now(): number;
  randomId(): string;
  /** Persisted non-secret installation id (plan/08 §3 namespace component). */
  installationId(): string;
  styleClient: StyleClient;
  /** S7.1: the per-document keyboard-binding executor (exact listener
   *  ownership; see runtime/behavior.ts). */
  behavior: BehaviorCore;
  /** S4.3: the mandatory structured verifier. A missing verifier refuses the
   *  batch before any side effect — acceptance is impossible without a report. */
  verify?: Verifier;
  /** Bounded settle wait between the write section and verification. */
  settle?(): Promise<void>;
}

export interface Transaction {
  applyBatch(req: BatchRequest, signal?: { cancelled: boolean }): Promise<BatchReceipt>;
  /** Release one customization to the site baseline (disable/remove path);
   *  never a global undoAll. */
  releaseCustomization(customizationId: string): Promise<BatchReceipt>;
  receiptFor(batchId: string): BatchReceipt | undefined;
  revisions(): Array<{ customizationId: string; revisionId: string }>;
}

// ── ledger ───────────────────────────────────────────────────────────────

interface TextResource {
  node: Text;
  siteBaseline: string;
  installed: string;
}

interface RevisionRecord {
  customizationId: string;
  revisionId: string;
  batchId: string;
  /** Source style operations (style + hide) for deterministic recompiles. */
  styleOps: StyleOperation[];
  texts: TextResource[];
  ownedNodes: Element[];
  /** S7.1: this revision's installed keyboard bindings with their exact
   *  dispose handles (release/rollback own them; no listener duplication). */
  bindings: Array<{ spec: BindingSpec; handle: { dispose(): void } }>;
  /** S7.2: this revision's installed local rule (at most one per revision). */
  rules: Array<{ key: string; handle: { dispose(): void } }>;
  /** S7.2: owned collapse disclosures (toggle + state attribute baseline). */
  collapses: Array<{ target: Element; toggle: Element; attrBaseline: string | null; collapsed: boolean; wiring: CollapseWiring | null }>;
  /** Elements this revision's fragment targets (token membership). */
  elements: Element[];
  highImpact: Array<{ property: string; value: string; risk: HighImpactRisk }>;
  /** Bounded effect samples for the COMBINED revision verification (T30):
   *  what this revision's fragment declares, on which exact element. */
  decls: Array<{ el: Element; property: string; value: string }>;
}

/** plan/08 §3: up to 64 logical style fragments per document. */
export const MAX_REVISIONS = 64;
/** Retained terminal receipts for dedupe/GetOperation (plan/06 §4). */
const MAX_RETAINED_RECEIPTS = 128;

const digestOf = (s: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0') + ':' + s.length.toString(16);
};

const err = (
  code: ErrorRecord['code'],
  phase: ErrorRecord['phase'],
  message: string,
  recoveryAction?: string,
): ErrorRecord => ({
  code,
  phase,
  retryClass:
    code === 'timeout-unknown' ? 'retryable-same-id'
      : code === 'conflict' || code === 'stale-target' || code === 'unknown-target' ? 'user-decision'
        : 'non-retryable',
  message: message.slice(0, 1000),
  ...(recoveryAction ? { recoveryAction } : {}),
});

const epochOf = (routeEpoch: number) => ({
  routeEpoch,
  domRevision: 0,
  customizationRevision: 0,
  viewportRevision: 0,
});

const UNSUPPORTED_KINDS = new Set(['float', 'projectCollection', 'relocate']);

/** A verifier that throws or answers for a different revision is UNKNOWN —
 *  never an accidental pass (T13). */
const syntheticReport = (req: BatchRequest, detail: string): VerificationReport => ({
  revisionId: req.revisionId,
  batchId: req.batchId,
  epoch: 0,
  status: 'unknown',
  issues: [{ key: 'verify:internal', section: 'integrity', status: 'unknown', detail }],
  counts: { pass: 0, satisfied: 0, fail: 0, unknown: 1 },
  coverage: { protectedTargets: 0, sentinels: 0, combinedRevisions: 0, checks: 1, unmeasuredDecls: 0, preExistingBroken: 0, rechecked: false },
});

/** Bounded owned-text sample collection for the WCAG AA contrast check. */
const collectOwnedText = (roots: Element[]): Array<{ el: Element; sample: string }> => {
  const out: Array<{ el: Element; sample: string }> = [];
  const walk = (el: Element, depth: number): void => {
    if (out.length >= 8 || depth > 12) return;
    let t = '';
    for (const c of el.childNodes) if (c.nodeType === 3) t += c.textContent ?? '';
    if (t.trim()) out.push({ el, sample: t.slice(0, 200) });
    for (const c of Array.from(el.children ?? [])) walk(c, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return out;
};

export function createTransaction(deps: TransactionDeps): Transaction {
  const revisions = new Map<string, RevisionRecord>();
  /** Text-node claims: exact native reference → owning customization. */
  const textClaims = new Map<Text, string>();
  const receipts = new Map<string, { digest: string; receipt: BatchReceipt }>();
  let generation = 0;
  let compositionNs = '';
  let acceptedOpId: string | null = null;
  let acceptedCss = '';
  /** Predecessor-bundle removal failed once: stays visible, blocks the next
   *  aggregate replacement until reconciled (plan/08 §3). */
  let cleanupPending = false;

  const currentElements = (): Set<Element> => {
    const all = new Set<Element>();
    for (const rev of revisions.values()) for (const el of rev.elements) all.add(el);
    return all;
  };

  const remember = (batchId: string, digest: string, receipt: BatchReceipt): BatchReceipt => {
    receipts.set(batchId, { digest, receipt });
    if (receipts.size > MAX_RETAINED_RECEIPTS) {
      receipts.delete(receipts.keys().next().value as string);
    }
    return receipt;
  };

  const refuse = (req: BatchRequest, digest: string, error: ErrorRecord, status: ReceiptStatus = 'not-applied'): BatchReceipt =>
    remember(req.batchId, digest, {
      batchId: req.batchId,
      payloadDigest: digest,
      status,
      resourceIds: [],
      routeEpoch: deps.routeEpoch(),
      error,
    });

  /** Recompile one revision's fragment under a new generation token.
   *  Deterministic: identical operations → identical values/order (plan/08
   *  §3). Membership elements were resolved at acceptance; the token is the
   *  only thing that changes. */
  const recompileFragment = (rev: RevisionRecord, ns: string): string => {
    const parts: string[] = [];
    for (const op of rev.styleOps) {
      const compiled = compileStyleOperation({
        operation: op,
        namespace: ns,
        resolveToken: () => ({ ok: true, token: ns }),
      });
      // Accepted fragments compiled before under a valid policy; a recompile
      // of the same source cannot newly fail. Fail closed regardless.
      if (compiled.ok) parts.push(compiled.sheet.css);
    }
    for (const _c of rev.collapses) {
      parts.push(`:where([data-rv2-ns="${ns}"][${COLLAPSED_ATTRIBUTE}="1"]) { display: none !important; }`);
    }
    return parts.join('\n');
  };

  const compileCandidate = (
    styleOps: StyleOperation[],
    ns: string,
    resolveToken: (t: { targetRef?: string; localRef?: string }) => { ok: true; token: string } | { ok: false; detail: string },
  ): { ok: true; css: string; highImpact: Array<{ property: string; value: string; risk: HighImpactRisk }> } | { ok: false; diagnostics: Array<{ path: string; message: string }> } => {
    const parts: string[] = [];
    const highImpact: Array<{ property: string; value: string; risk: HighImpactRisk }> = [];
    for (const [i, op] of styleOps.entries()) {
      const compiled = compileStyleOperation({ operation: op, namespace: ns, resolveToken });
      if (!compiled.ok) {
        return { ok: false, diagnostics: compiled.diagnostics.map((d) => ({ path: `operations[${i}].${d.path}`, message: d.message })) };
      }
      parts.push(compiled.sheet.css);
      highImpact.push(...compiled.sheet.highImpact);
    }
    return { ok: true, css: parts.join('\n'), highImpact };
  };

  interface PreparedBatch {
    digest: string;
    entryEpoch: number;
    documentKey: DocumentKey;
    styleOps: StyleOperation[];
    candidateElements: Element[];
    fragmentCss: string;
    highImpact: Array<{ property: string; value: string; risk: HighImpactRisk }>;
    textPreps: Array<{ node: Text; installed: string; predecessorValue: string | null; siteBaseline: string; claimedNew: boolean }>;
    inserts: Array<{ anchor: Element; position: 'before' | 'after' | 'first-child' | 'last-child'; roots: Element[] }>;
    bindPreps: Array<{ spec: BindingSpec }>;
    /** Handles created in the write section (empty until then). */
    bindHandles: Array<{ dispose(): void }>;
    /** S7.2: owned collapse disclosures to build in the write section. */
    collapsePreps: Array<{ target: Element; toggle: Element; attrBaseline: string | null; collapsed: boolean; expectedToggleParent: Element | null }>;
    /** S7.2: the revision's rule(s) — one saved rule expands to per-member
     *  copies (seed evaluation deferred to post-acceptance: an external
     *  click must never survive a rollback). */
    rulePreps: Array<{ spec: RuleSpec; seed: Element }>;
    /** Handles created in the write section (empty until then). */
    collapseWiring: CollapseWiring[];
    ruleHandles: Array<{ dispose(): void }>;
    droppedTexts: Array<{ node: Text; siteBaseline: string; predecessorInstalled: string }>;
    aggregateCss: string | null;
    replaces: RevisionRecord | undefined;
    plan: VerifyPlan;
    candidateDecls: Array<{ el: Element; property: string; value: string }>;
  }

  const prepare = (req: BatchRequest): { ok: true; prepared: PreparedBatch } | { ok: false; receipt: BatchReceipt } => {
    const digest = digestOf(JSON.stringify(req.operations));
    const dk = deps.documentKey();
    if (!dk) {
      return { ok: false, receipt: refuse(req, digest, err('stale-document', 'apply', 'the runtime has no verified registration', 'reload the document')) };
    }
    const decoded = decodeOperationBatch(req.operations, 'operations');
    if (!decoded.ok) {
      const first = decoded.issues[0];
      return { ok: false, receipt: refuse(req, digest, err('invalid-schema', 'decode', `${first.path}: ${first.message}`)) };
    }
    const ops = decoded.value;

    // Unsupported kinds are refused BEFORE any side effect (plan/08 §1).
    for (const [i, op] of ops.entries()) {
      if (UNSUPPORTED_KINDS.has(op.kind)) {
        return {
          ok: false,
          receipt: refuse(req, digest, err('unsupported-capability', 'validate', `operation ${i} ("${op.kind}") has no executor in this revision; it was not executed`, 're-propose without it, or wait for the capability task that owns it')),
        };
      }
    }

    const entryEpoch = deps.routeEpoch();
    const epoch = epochOf(entryEpoch);
    const batchLocal = new Map<string, Element>();
    const styleOps: StyleOperation[] = [];
    const styleTargets = new Map<string, Element>();
    const candidateElements: Element[] = [];
    const textPreps: PreparedBatch['textPreps'] = [];
    const inserts: PreparedBatch['inserts'] = [];
    const bindPreps: PreparedBatch['bindPreps'] = [];
    const batchChords = new Set<string>();
    const collapsePreps: PreparedBatch['collapsePreps'] = [];
    const rulePreps: PreparedBatch['rulePreps'] = [];
    const highImpact: PreparedBatch['highImpact'] = [];
    const newClaims = new Set<Text>();
    const styleRuleEls: Element[][] = [];
    const hideScope: Element[] = [];
    const protectedMap = new Map<string, Element>();
    const ownedTextSamples: Array<{ el: Element; sample: string }> = [];

    const resolveTarget = (spec: { targetRef?: string; localRef?: string }, path: string): { ok: true; el: Element; key: string } | { ok: false; error: ErrorRecord } => {
      if (spec.targetRef !== undefined) {
        const r = deps.targets.resolve(spec.targetRef, epoch);
        if (!r.ok) {
          const code = r.reason === 'missing' ? 'unknown-target' : 'stale-target';
          return { ok: false, error: err(code, 'validate', `${path}: ${r.detail}`, 're-observe for fresh target refs') };
        }
        if (r.rootId !== 'document') {
          return { ok: false, error: err('unsupported-capability', 'validate', `${path}: the target lives in root "${r.rootId}"; document-root sheets do not reach shadow descendants (open-root sheets arrive with a later slice)`) };
        }
        return { ok: true, el: r.node, key: spec.targetRef };
      }
      const el = batchLocal.get(spec.localRef!);
      if (!el) {
        return { ok: false, error: err('unknown-target', 'validate', `${path}: localRef "${spec.localRef}" names no node created by an earlier operation`) };
      }
      return { ok: true, el, key: spec.localRef! };
    };

    const replaced = revisions.get(req.customizationId);

    // Quota (plan/08 §3 fragment budget) — refuse BEFORE losing inverses.
    if (!replaced && revisions.size >= MAX_REVISIONS) {
      return { ok: false, receipt: refuse(req, digest, err('quota-exceeded', 'validate', `the document already holds ${MAX_REVISIONS} accepted revisions`)) };
    }
    if (cleanupPending && (styleOpsWillExist(ops) || (replaced !== undefined && replaced.styleOps.length > 0))) {
      return {
        ok: false,
        receipt: refuse(req, digest, err('conflict', 'deliver', 'a previous predecessor bundle could not be cleaned up; replacements are blocked until it is reconciled', 'retry the release of the obsolete bundle')),
      };
    }

    for (const [i, op] of ops.entries()) {
      const path = `operations[${i}]`;
      switch (op.kind) {
        case 'style': {
          // Every rule target resolves before any side effect — stale/missing
          // targets keep their exact error codes (no compile-diag laundering).
          const ruleEls: Element[] = [];
          for (const [ri, rule] of op.rules.entries()) {
            const r = resolveTarget(rule.target, `${path}.rules[${ri}].target`);
            if (!r.ok) return { ok: false, receipt: refuse(req, digest, r.error) };
            styleTargets.set(rule.target.targetRef ?? rule.target.localRef ?? `${i}:${ri}`, r.el);
            ruleEls.push(r.el);
            for (const d of rule.declarations) {
              const dp = d.property.toLowerCase();
              const dv = d.value.trim().toLowerCase();
              if ((dp === 'display' && dv === 'none') || (dp === 'visibility' && dv === 'hidden')) {
                // The CSS equivalent of hide joins the authorized hide scope
                // (same target/risk policy as the named operation, I17).
                hideScope.push(r.el);
              }
            }
          }
          styleOps.push(op);
          styleRuleEls.push(ruleEls);
          break;
        }
        case 'hide': {
          // A hide IS a display fragment through the same compiled path
          // (plan/08 §1: same target/risk policy as style — I17).
          const hideTarget = resolveTarget(op.target, `${path}.target`);
          if (!hideTarget.ok) return { ok: false, receipt: refuse(req, digest, hideTarget.error) };
          styleTargets.set(op.target.targetRef ?? op.target.localRef ?? `${i}`, hideTarget.el);
          hideScope.push(hideTarget.el);
          styleRuleEls.push([hideTarget.el]);
          styleOps.push({
            kind: 'style',
            rules: [{
              target: op.target,
              surface: 'element',
              state: 'none',
              declarations: [{ property: 'display', value: 'none', priority: 'important' }],
              conditions: [],
            }],
          });
          break;
        }
        case 'replaceText': {
          const target = resolveTarget(op.target, `${path}.target`);
          if (!target.ok) return { ok: false, receipt: refuse(req, digest, target.error) };
          const leaf = deps.content.textLeafOf(target.el);
          if (!leaf.ok) return { ok: false, receipt: refuse(req, digest, err('unsupported-text-shape', 'validate', `${path}: ${leaf.message}`)) };
          if (op.text === '') {
            return { ok: false, receipt: refuse(req, digest, err('denied', 'validate', `${path}: an empty replacement needs explicit content-removal approval, which arrives with the grant task`)) };
          }
          const node = leaf.text;
          const owner = textClaims.get(node);
          if (owner !== undefined && owner !== req.customizationId) {
            return {
              ok: false,
              receipt: refuse(req, digest, err('conflict', 'validate', `${path}: the text node is already claimed by customization "${owner}"`, 'release that customization first')),
            };
          }
          if (newClaims.has(node)) {
            return { ok: false, receipt: refuse(req, digest, err('duplicate-id', 'validate', `${path}: two replaceText operations in one batch claim the same Text node`)) };
          }
          newClaims.add(node);
          // Baselines: the site baseline transfers from the predecessor claim
          // (plan/08 §5); the predecessor value is the candidate-rollback
          // target. An unclaimed node's current value IS the site baseline.
          const predText = replaced?.texts.find((t) => t.node === node);
          const siteBaseline = predText ? predText.siteBaseline : node.nodeValue ?? '';
          const predecessorValue = predText ? predText.installed : null;
          textPreps.push({ node, installed: op.text, predecessorValue, siteBaseline, claimedNew: !predText });
          protectedMap.set(op.target.targetRef ?? op.target.localRef ?? `${i}`, target.el);
          break;
        }
        case 'insertUI': {
          const plan = compileInsertUi(op);
          if (!plan.ok) {
            const first = plan.diagnostics[0];
            return { ok: false, receipt: refuse(req, digest, err('invalid-schema', 'validate', `${path}.${first.path}: ${first.message}`)) };
          }
          const anchorR = resolveTarget(op.target, `${path}.target`);
          if (!anchorR.ok) return { ok: false, receipt: refuse(req, digest, anchorR.error) };
          const built = deps.content.build(plan.plan);
          if (!built.ok) {
            const first = built.diagnostics[0];
            return { ok: false, receipt: refuse(req, digest, err('invalid-schema', 'validate', `${path}.${first.path}: ${first.message}`)) };
          }
          // Exact placement validated before any side effect (plan/28 §2).
          try {
            deps.content.checkPlacement(anchorR.el, op.position, built.roots);
          } catch (e) {
            return { ok: false, receipt: refuse(req, digest, err('invalid-schema', 'validate', `${path}: ${(e as Error).message}`)) };
          }
          for (const [localId, el] of built.byLocalId) batchLocal.set(localId, el);
          inserts.push({ anchor: anchorR.el, position: op.position, roots: built.roots });
          protectedMap.set(op.target.targetRef ?? op.target.localRef ?? `${i}`, anchorR.el);
          ownedTextSamples.push(...collectOwnedText(built.roots));
          break;
        }
        case 'bindKey': {
          // S7.1 (plan/09 §2): chord/action/policy checks all happen BEFORE
          // any side effect — a refused binding installs nothing.
          if (op.target?.targetRef === undefined && op.target?.localRef === undefined) {
            return { ok: false, receipt: refuse(req, digest, err('invalid-schema', 'validate', `${path}.target: bindKey needs the exact target its actions act on`)) };
          }
          const bindTarget = resolveTarget(op.target!, `${path}.target`);
          if (!bindTarget.ok) return { ok: false, receipt: refuse(req, digest, bindTarget.error) };
          const parsed = parseChord(op.chord);
          if (!parsed.ok) {
            return { ok: false, receipt: refuse(req, digest, err('invalid-schema', 'validate', `${path}.chord: ${parsed.reason}`, parsed.suggestion)) };
          }
          if (reservedChord(parsed.chord)) {
            return { ok: false, receipt: refuse(req, digest, err('unsupported-capability', 'validate', `${path}.chord: "${op.chord}" is reserved by the browser; pages cannot intercept it`, 'bind a different chord, e.g. Alt+<key>')) };
          }
          if (plainTypingChord(parsed.chord)) {
            return { ok: false, receipt: refuse(req, digest, err('conflict', 'validate', `${path}.chord: "${op.chord}" is plain typing — it conflicts with every editable surface`, 'add a Ctrl/Alt/Meta modifier, or bind a named key like F5')) };
          }
          // Conflict (plan/09 §2): one chord, one binding — the current
          // owner wins; the replacement's OWN chords are exempt.
          const bound = deps.behavior.boundChords();
          let othersChords = 0;
          for (const [, owner] of bound) if (owner !== req.customizationId) othersChords += 1;
          const owner = bound.get(parsed.chord.normalized);
          if (owner !== undefined && owner !== req.customizationId) {
            return { ok: false, receipt: refuse(req, digest, err('conflict', 'validate', `${path}.chord: "${op.chord}" is already bound by customization "${owner}"`, 'choose a different chord, or disable that customization first')) };
          }
          if (batchChords.has(parsed.chord.normalized)) {
            return { ok: false, receipt: refuse(req, digest, err('duplicate-id', 'validate', `${path}.chord: "${op.chord}" is bound twice in one batch`)) };
          }
          if (othersChords + batchChords.size + 1 > MAX_BINDINGS_PER_DOCUMENT) {
            return { ok: false, receipt: refuse(req, digest, err('quota-exceeded', 'validate', `this document already holds ${othersChords + batchChords.size} keyboard bindings (limit ${MAX_BINDINGS_PER_DOCUMENT})`, 'disable a binding to free a chord')) };
          }
          batchChords.add(parsed.chord.normalized);
          for (const actionId of op.actionIds) {
            if (!isBindActionId(actionId)) {
              return { ok: false, receipt: refuse(req, digest, err('invalid-schema', 'validate', `${path}.actionIds: "${actionId}" is not in the bind action catalog (focus, scrollIntoView, activate, followLink, toggleDisclosure)`)) };
            }
            const valid = validateBindAction(actionId, bindTarget.el);
            if (!valid.ok) {
              return { ok: false, receipt: refuse(req, digest, err('unsupported-capability', 'validate', `${path}: action "${actionId}" is unsupported on this target: ${valid.detail}`)) };
            }
          }
          bindPreps.push({
            spec: {
              customizationId: req.customizationId,
              ...parsed.chord,
              target: bindTarget.el,
              actions: op.actionIds as BindingSpec['actions'],
              scope: op.scope ?? 'document',
              repeat: op.repeat === true,
              editablePolicy: op.editablePolicy ?? 'ignore',
              modalPolicy: op.modalPolicy ?? 'ignore',
            },
          });
          // Integrity: a hidden/gone bind target would leave a dead shortcut —
          // protect it like any other batch target.
          protectedMap.set(op.target.targetRef ?? op.target.localRef ?? `bind:${i}`, bindTarget.el);
          break;
        }
        case 'collapse': {
          // S7.2 (plan/08 §1/§7): owned accessible disclosure controlling
          // local presentation. User override is MANDATORY — the toggle is
          // always installed; the model cannot disable it.
          if (op.userOverride === false) {
            return { ok: false, receipt: refuse(req, digest, err('invalid-schema', 'validate', `${path}.userOverride: collapse user override cannot be disabled`)) };
          }
          if (op.label.trim() === '') {
            return { ok: false, receipt: refuse(req, digest, err('invalid-schema', 'validate', `${path}.label: the disclosure toggle needs a non-empty accessible label`)) };
          }
          const collapseTarget = resolveTarget(op.target, `${path}.target`);
          if (!collapseTarget.ok) return { ok: false, receipt: refuse(req, digest, collapseTarget.error) };
          const placement = op.placement ?? 'before';
          const toggleLocalId = `rv-collapse-${i}`;
          const toggleOp = {
            kind: 'insertUI', target: op.target, position: placement,
            nodes: [{
              localId: toggleLocalId, tag: 'button', text: op.label,
              attributes: { type: 'button', 'aria-expanded': op.initialState === 'expanded' ? 'true' : 'false' },
            }],
          } as import('../contracts.ts').InsertUiOperation;
          const togglePlan = compileInsertUi(toggleOp);
          if (!togglePlan.ok) {
            const first = togglePlan.diagnostics[0];
            return { ok: false, receipt: refuse(req, digest, err('invalid-schema', 'validate', `${path}.${first.path}: ${first.message}`)) };
          }
          const builtToggle = deps.content.build(togglePlan.plan);
          if (!builtToggle.ok) {
            const first = builtToggle.diagnostics[0];
            return { ok: false, receipt: refuse(req, digest, err('invalid-schema', 'validate', `${path}.${first.path}: ${first.message}`)) };
          }
          const toggle = builtToggle.byLocalId.get(toggleLocalId);
          if (!toggle) {
            return { ok: false, receipt: refuse(req, digest, err('internal', 'validate', `${path}: the disclosure toggle did not build`)) };
          }
          try {
            deps.content.checkPlacement(collapseTarget.el, placement, builtToggle.roots);
          } catch (e) {
            return { ok: false, receipt: refuse(req, digest, err('invalid-schema', 'validate', `${path}: ${(e as Error).message}`)) };
          }
          for (const [localId, el] of builtToggle.byLocalId) batchLocal.set(localId, el);
          inserts.push({ anchor: collapseTarget.el, position: placement, roots: builtToggle.roots });
          // The collapsed element is an INTENTIONAL hide scope member when it
          // starts collapsed (same exemption policy as the hide operation).
          const collapsed = op.initialState !== 'expanded';
          if (collapsed) hideScope.push(collapseTarget.el);
          // The target joins the composition token scope: the collapse rule
          // (token + owned state attribute) reaches it; release removes the
          // token with the rest of the fragment.
          candidateElements.push(collapseTarget.el);
          collapsePreps.push({
            target: collapseTarget.el,
            toggle,
            attrBaseline: collapseTarget.el.getAttribute(COLLAPSED_ATTRIBUTE),
            collapsed,
            expectedToggleParent: (placement === 'before' || placement === 'after'
              ? collapseTarget.el.parentNode
              : collapseTarget.el) as Element | null,
          });
          protectedMap.set(op.target.targetRef ?? op.target.localRef ?? `collapse:${i}`, collapseTarget.el);
          break;
        }
        case 'localRule': {
          // S7.2 (plan/09 §3, plan/08 §7): finite trigger/predicate/action
          // rules; the runtime owns once/cooldown/override. Replay expands
          // one saved rule into per-member copies that share the rule's
          // once-per-instance key.
          if (op.trigger !== 'target-appeared') {
            return { ok: false, receipt: refuse(req, digest, err('unsupported-capability', 'validate', `${path}.trigger: "${op.trigger}" has no executor in this revision; it was not executed`, 're-propose with trigger "target-appeared"')) };
          }
          if (!isRuleActionId(op.actionId)) {
            return { ok: false, receipt: refuse(req, digest, err('invalid-schema', 'validate', `${path}.actionId: "${op.actionId}" is not in the rule action catalog (activateDisclosure, focus)`)) };
          }
          const ruleTarget = resolveTarget(op.target, `${path}.target`);
          if (!ruleTarget.ok) return { ok: false, receipt: refuse(req, digest, ruleTarget.error) };
          const predicates: RulePredicate[] = [];
          for (const [pi, predicate] of (op.predicates ?? []).entries()) {
            const ppath = `${path}.predicates[${pi}]`;
            switch (predicate.type) {
              case 'member-of': {
                const member = deps.targets.resolve(predicate.targetRef, epoch);
                if (!member.ok) {
                  return { ok: false, receipt: refuse(req, digest, err(member.reason === 'missing' ? 'unknown-target' : 'stale-target', 'validate', `${ppath}: ${member.detail}`)) };
                }
                predicates.push({ type: 'member-of', element: member.node });
                break;
              }
              case 'expanded-equals':
                predicates.push({ type: 'expanded-equals', value: predicate.value });
                break;
              case 'text-contains':
                predicates.push({ type: 'text-contains', literal: predicate.literal });
                break;
              case 'owned-state-equals':
                return { ok: false, receipt: refuse(req, digest, err('unsupported-capability', 'validate', `${ppath}: owned-state predicates have no executor in this revision; it was not executed`)) };
            }
          }
          let affordance: Element | null = null;
          if (op.targetRef !== undefined) {
            const aff = deps.targets.resolve(op.targetRef, epoch);
            if (!aff.ok) {
              return { ok: false, receipt: refuse(req, digest, err(aff.reason === 'missing' ? 'unknown-target' : 'stale-target', 'validate', `${path}.targetRef: ${aff.detail}`)) };
            }
            if (aff.rootId !== 'document') {
              return { ok: false, receipt: refuse(req, digest, err('unsupported-capability', 'validate', `${path}.targetRef: the affordance lives in root "${aff.rootId}"; rules address document-root instances`)) };
            }
            affordance = aff.node;
            if (!ruleTarget.el.contains(affordance)) {
              return { ok: false, receipt: refuse(req, digest, err('unsupported-capability', 'validate', `${path}.targetRef: the disclosure affordance must live inside the rule's target instance`)) };
            }
          }
          if (op.actionId === 'activateDisclosure') {
            if (affordance === null) {
              return { ok: false, receipt: refuse(req, digest, err('invalid-schema', 'validate', `${path}.targetRef: activateDisclosure needs the disclosure affordance ref`)) };
            }
            if (disclosureState(affordance) === null) {
              return { ok: false, receipt: refuse(req, digest, err('unsupported-capability', 'validate', `${path}.targetRef: the affordance exposes no observable expanded state (aria-expanded or a native details/summary)`)) };
            }
          }
          if (op.actionId === 'focus') {
            const focusable = validateBindAction('focus', ruleTarget.el);
            if (!focusable.ok) {
              return { ok: false, receipt: refuse(req, digest, err('unsupported-capability', 'validate', `${path}: action "focus" is unsupported on this target: ${focusable.detail}`)) };
            }
          }
          rulePreps.push({
            spec: { customizationId: req.customizationId, actionId: op.actionId, predicates, affordance },
            seed: ruleTarget.el,
          });
          break;
        }
      }
    }

    // Compile the candidate fragment under a fresh generation token.
    generation += 1; // reserve the generation number deterministically
    const nsNew = `rv2.i${deps.installationId()}.g${generation}`;
    const collectTarget = (_spec: { targetRef?: string; localRef?: string }): { ok: true; token: string } | { ok: false; detail: string } => {
      // Targets were pre-resolved above with exact error codes; the compiler
      // only needs the composition token.
      return { ok: true, token: nsNew };
    };
    for (const t of styleTargets.values()) candidateElements.push(t);
    let fragmentCss = '';
    if (styleOps.length > 0) {
      const compiled = compileCandidate(styleOps, nsNew, collectTarget);
      if (!compiled.ok) {
        const first = compiled.diagnostics[0];
        return { ok: false, receipt: refuse(req, digest, err('invalid-schema', 'validate', `${first.path}: ${first.message}`, 're-propose with policy-compliant values')) };
      }
      fragmentCss = compiled.css;
      highImpact.push(...compiled.highImpact);
    }
    // S7.2: one deterministic collapse rule per owned disclosure — the token
    // marks membership, the owned state attribute carries the toggle state.
    for (const _c of collapsePreps) {
      fragmentCss += `\n:where([data-rv2-ns="${nsNew}"][${COLLAPSED_ATTRIBUTE}="1"]) { display: none !important; }`;
    }

    // Candidate aggregate = unchanged accepted fragments (recompiled under
    // the new token, identical values/order) + the candidate fragment, in
    // canonical order (plan/08 §3).
    const otherCss: string[] = [];
    for (const [cid, rev] of revisions) {
      if (cid === req.customizationId) continue;
      const css = recompileFragment(rev, nsNew);
      if (css) otherCss.push(css);
    }
    const joined = [...otherCss, fragmentCss].filter(Boolean).join('\n');
    const aggregateCss = joined.length > 0 ? joined : null;

    // Dropped claims: predecessor text resources the candidate does not
    // re-claim release to the site baseline at the swap (plan/08 §5).
    const droppedTexts: PreparedBatch['droppedTexts'] = [];
    if (replaced) {
      for (const t of replaced.texts) {
        if (!newClaims.has(t.node)) droppedTexts.push({ node: t.node, siteBaseline: t.siteBaseline, predecessorInstalled: t.installed });
      }
    }

    // ── S4.3 verification plan: delivery/effect/integrity/combined scope ──
    const styleChecks: VerifyPlan['styles'] = [];
    let unmeasured = 0;
    const candidateDecls: RevisionRecord['decls'] = [];
    for (const [i, op] of styleOps.entries()) {
      for (const [ri, rule] of op.rules.entries()) {
        const ruleEl = styleRuleEls[i]?.[ri];
        if (!ruleEl) continue;
        const pseudo = rule.surface === 'before' ? '::before' as const : rule.surface === 'after' ? '::after' as const : undefined;
        for (const [k, d] of rule.declarations.entries()) {
          if (d.property.startsWith('--')) { unmeasured += 1; continue; }
          if (styleChecks.length < 32) {
            styleChecks.push({ key: `effect:style:op${i}:rule${ri}:decl${k}:${d.property}`, el: ruleEl, property: d.property, value: d.value, ...(pseudo ? { pseudo } : {}) });
          } else {
            unmeasured += 1;
          }
          if (candidateDecls.length < 16) candidateDecls.push({ el: ruleEl, property: d.property, value: d.value });
        }
      }
      for (const kf of op.keyframes ?? []) for (const f of kf.frames) unmeasured += f.declarations.length;
    }
    const protectedEls: VerifyPlan['protectedEls'] = [];
    {
      const seenKeys = new Set<string>();
      for (const [key, el] of [...protectedMap, ...styleTargets]) {
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        protectedEls.push({ key, el });
      }
    }
    const sentinels: VerifyPlan['sentinels'] = [];
    {
      const sentinelSeen = new Set<Element>(protectedEls.map((p) => p.el));
      for (const p of protectedEls) {
        if (sentinels.length >= 24) break;
        const parentRaw = (p.el.parentElement ?? p.el.parentNode) as Element | null;
        const parent = parentRaw && parentRaw.nodeType === 1 ? parentRaw : null;
        if (parent && !sentinelSeen.has(parent)) {
          sentinelSeen.add(parent);
          sentinels.push({ key: `sentinel:${p.key}:parent`, el: parent });
        }
        if (!parent) continue;
        const siblings = Array.from(parent.children ?? []);
        const idx = siblings.indexOf(p.el);
        // Each sibling gets its OWN stable key: two siblings under one key
        // would collide in the baseline map (a focusable sibling's baseline
        // was then measured against the other sibling — a false integrity
        // fail; caught by the S7.1 keys fixture).
        for (const [which, sib] of [['prev', siblings[idx - 1]], ['next', siblings[idx + 1]]] as const) {
          if (sib && !sentinelSeen.has(sib) && sentinels.length < 24) {
            sentinelSeen.add(sib);
            sentinels.push({ key: `sentinel:${p.key}:sibling-${which}`, el: sib });
          }
        }
      }
    }
    const excluded = new Map<Element, Set<string>>();
    for (const d of candidateDecls) {
      const set = excluded.get(d.el) ?? new Set<string>();
      set.add(d.property);
      excluded.set(d.el, set);
    }
    const combined: VerifyPlan['combined'] = [];
    for (const [cid, rev] of revisions) {
      if (cid === req.customizationId) continue;
      combined.push({
        customizationId: cid,
        revisionId: rev.revisionId,
        checks: rev.decls
          .filter((d) => !excluded.get(d.el)?.has(d.property))
          .slice(0, 4)
          .map((d, j) => ({ key: `combined:${cid}:${j}:${d.property}`, el: d.el, property: d.property, value: d.value })),
        texts: rev.texts.filter((t) => !newClaims.has(t.node)).slice(0, 4).map((t, j) => ({ key: `combined:${cid}:text:${j}`, node: t.node, installed: t.installed })),
        nodes: rev.ownedNodes.slice(0, 4).map((el, j) => ({ key: `combined:${cid}:node:${j}`, el })),
      });
    }
    const verifyPlan: VerifyPlan = {
      batchId: req.batchId,
      revisionId: req.revisionId,
      entryEpoch,
      staged: false,
      styles: styleChecks,
      hides: hideScope,
      texts: textPreps.map((t, j) => ({ key: `effect:text:${j}`, node: t.node, installed: t.installed })),
      // before/after place beside the anchor (parent = its parent);
      // first-child/last-child place INSIDE the anchor (parent = the anchor).
      inserts: inserts.map((ins, j) => ({
        key: `effect:insert:${j}`,
        roots: ins.roots,
        expectedParent: (ins.position === 'before' || ins.position === 'after'
          ? ins.anchor.parentNode
          : ins.anchor) as Element | null,
      })),
      protectedEls,
      sentinels,
      combined,
      ownedText: ownedTextSamples,
      bindings: bindPreps.map((b, j) => ({ key: `effect:bind:${j}`, normalized: b.spec.normalized })),
      collapses: collapsePreps.map((c, j) => ({
        key: `effect:collapse:${j}`,
        toggle: c.toggle,
        expectedParent: c.expectedToggleParent,
        target: c.target,
        collapsed: c.collapsed,
      })),
      rules: rulePreps.map((_, j) => ({ key: `effect:rule:${j}`, ruleKey: req.customizationId })),
      tokenChecks: candidateElements.map((el, j) => ({ key: `delivery:token:${j}`, el, ns: nsNew })),
      unmeasuredDecls: unmeasured,
    };

    return {
      ok: true,
      prepared: {
        digest,
        entryEpoch,
        documentKey: dk,
        styleOps,
        candidateElements,
        fragmentCss,
        highImpact,
        textPreps,
        inserts,
        bindPreps,
        bindHandles: [],
        collapsePreps,
        rulePreps,
        collapseWiring: [],
        ruleHandles: [],
        droppedTexts,
        aggregateCss,
        replaces: replaced,
        plan: verifyPlan,
        candidateDecls,
      },
    };
  };

  /** Final identity re-check right before the synchronous write section: a
   *  target that mutated after the CSS ack must not activate (T08). */
  const finalIdentityCheck = (prepared: PreparedBatch): ErrorRecord | null => {
    const epoch = epochOf(deps.routeEpoch());
    for (const prep of prepared.textPreps) {
      if (!prep.node.isConnected) return err('stale-target', 'apply', 'a text target left the document after CSS delivery', 'remove happened without activation; re-observe');
    }
    for (const ins of prepared.inserts) {
      if (!ins.anchor.isConnected) return err('stale-target', 'apply', 'an insertUI anchor left the document after CSS delivery', 'no activation on stale targets');
    }
    for (const bind of prepared.bindPreps) {
      if (!bind.spec.target.isConnected) return err('stale-target', 'apply', 'a keyboard binding target left the document after CSS delivery', 'no activation on stale targets');
    }
    for (const c of prepared.collapsePreps) {
      // Only the target is a live-document identity; the toggle is built
      // detached and inserted during the write section.
      if (!c.target.isConnected) return err('stale-target', 'apply', 'a collapse target left the document after CSS delivery', 'no activation on stale targets');
    }
    for (const prep of prepared.rulePreps) {
      if (!prep.seed.isConnected) return err('stale-target', 'apply', 'a behavior rule target left the document after CSS delivery', 'no activation on stale targets');
    }
    for (const op of prepared.styleOps) {
      for (const rule of op.rules) {
        if (rule.target.targetRef === undefined) continue;
        const r = deps.targets.resolve(rule.target.targetRef, epoch);
        if (!r.ok) return err('stale-target', 'apply', `style target "${rule.target.targetRef}" became stale after CSS delivery: ${r.detail}`);
      }
    }
    return null;
  };

  const staleOrCancelled = (prepared: PreparedBatch, signal: { cancelled: boolean } | undefined): ErrorRecord | null => {
    if (signal?.cancelled) return err('conflict', 'apply', 'the run was cancelled; the candidate was not accepted', 'the candidate rolls back; accepted work survives');
    if (deps.routeEpoch() !== prepared.entryEpoch) return err('stale-route', 'apply', 'the route changed mid-apply; the candidate was not accepted', 're-observe at the current route epoch');
    return null;
  };

  const applyBatch = async (req: BatchRequest, signal?: { cancelled: boolean }): Promise<BatchReceipt> => {
    // 1. Dedupe: the same operation id replays its receipt — but only while
    //    that revision is still LIVE. releaseCustomization deletes the
    //    revision record: a re-apply of released intent (route return,
    //    re-enable, new set members) is fresh work, not a replay (T11).
    const digest = digestOf(JSON.stringify(req.operations));
    const prior = receipts.get(req.batchId);
    if (prior && revisions.has(req.customizationId)) {
      if (prior.digest === digest) return prior.receipt;
      // A different payload under the same id never executes and never
      // overwrites the recorded receipt for the original payload (T14).
      return {
        batchId: req.batchId,
        payloadDigest: digest,
        status: 'not-applied',
        resourceIds: [],
        routeEpoch: deps.routeEpoch(),
        error: err('duplicate-id', 'validate', 'this operation id was already recorded with a different payload digest', 'reissue with a fresh operation id'),
      };
    }

    const preparedResult = prepare(req);
    if (!preparedResult.ok) return preparedResult.receipt;
    const prepared = preparedResult.prepared;
    const epochNow = () => deps.routeEpoch();

    // S4.3: acceptance is gated on a structured VerificationReport for THIS
    // revision (I11). A missing verifier refuses before any side effect (T13).
    if (!deps.verify) {
      return refuse(req, digest, err('conflict', 'verify', 'mandatory verification is unavailable; the batch was not applied', 'run with the verification runtime present'));
    }
    const verifier = deps.verify;
    const captured = verifier.captureBaseline(prepared.plan);
    if (!captured.ok) {
      return refuse(req, digest, err('conflict', 'verify', `the mandatory baseline could not be measured: ${captured.detail}`, 're-observe and retry'));
    }

    // The staged operation id is DOCUMENT- and GENERATION-scoped (plan/06
    // §2: bundles are per-document deliveries; a re-applied revision after a
    // release recomposes a new generation with a new namespace, so it is a
    // new stage — never a digest collision in the broker's ledger).
    const docScope = deps.documentKey()?.browserDocumentId ?? 'x';
    const stagedOpId = prepared.aggregateCss !== null ? `${req.batchId}:d${docScope}:g${generation}:css` : null;

    // 2. Stage the inert candidate aggregate (intent before insert is the
    //    broker's job; a refused/unknown staging never reaches activation).
    if (stagedOpId) {
      const reply = await deps.styleClient.stage({
        operationId: stagedOpId,
        namespace: `rv2.i${deps.installationId()}.g${generation}`,
        css: prepared.aggregateCss!,
      });
      const problem = staleOrCancelled(prepared, signal);
      if (problem) {
        await removeBundleBestEffort(stagedOpId, prepared.aggregateCss!);
        return refuse(req, digest, problem, 'not-applied');
      }
      if (!reply.ok) {
        return refuse(req, digest, err(reply.code === 'conflict' ? 'conflict' : reply.code === 'quota-exceeded' ? 'quota-exceeded' : 'internal', 'deliver', `staging refused: ${reply.message}`));
      }
      if (reply.state === 'unknown') {
        // I06: unknown, never not-applied. Disarm the namespace; the broker's
        // reconcile exact-cleans the uncertain bundle (S2.2).
        deps.tokens.revoke(`rv2.i${deps.installationId()}.g${generation}`);
        return remember(req.batchId, digest, {
          batchId: req.batchId,
          payloadDigest: digest,
          status: 'outcome-unknown',
          resourceIds: [],
          routeEpoch: epochNow(),
          error: err('timeout-unknown', 'deliver', 'the candidate bundle delivery outcome is unknown; it was not activated', 'retry the same operation id, or let the broker reconcile the uncertain bundle'),
        });
      }
    }

    if (stagedOpId) prepared.plan.staged = true;

    // 3. Final identity re-check — no await between this and the writes.
    const stale = finalIdentityCheck(prepared);
    if (stale) {
      if (stagedOpId) await removeBundleBestEffort(stagedOpId, prepared.aggregateCss!);
      return refuse(req, digest, stale, 'not-applied');
    }

    const oldNs = compositionNs;
    const oldSet = currentElements();
    const newSet = new Set<Element>([...oldSet, ...prepared.candidateElements]);
    const conflicts: string[] = [];
    const nsNew = `rv2.i${deps.installationId()}.g${generation}`;

    // 4. ONE synchronous local mutation section (plan/08 §4 step 5):
    //    retire replaced tokens → native writes → activate new membership.
    try {
      if (stagedOpId) {
        for (const el of oldSet) {
          if (!newSet.has(el) && el.getAttribute?.(TOKEN_ATTRIBUTE) === oldNs) el.removeAttribute(TOKEN_ATTRIBUTE);
        }
      }
      // Dropped claims release to the site baseline at the swap (plan/08 §5);
      // a newer site value is never overwritten.
      for (const drop of prepared.droppedTexts) {
        if (!drop.node.isConnected) { conflicts.push(`dropped text claim: node left the document`); continue; }
        if (drop.node.nodeValue !== drop.predecessorInstalled) { conflicts.push(`dropped text claim: the site changed the value meanwhile; the newer value stays`); continue; }
        drop.node.nodeValue = drop.siteBaseline;
      }
      for (const t of prepared.textPreps) t.node.nodeValue = t.installed;
      for (const ins of prepared.inserts) deps.content.insert(ins.anchor, ins.position, ins.roots);
      // S7.2: collapse state + wiring. The attribute write is an OWNED
      // mutation (site baseline recorded at prepare, restored on release/
      // rollback); the toggle listener lives on the OWNED button. A replaced
      // revision's collapse state yields to the successor's declaration.
      if (prepared.replaces) {
        for (const c of prepared.replaces.collapses) {
          if (c.attrBaseline === null) c.target.removeAttribute(COLLAPSED_ATTRIBUTE);
          else c.target.setAttribute(COLLAPSED_ATTRIBUTE, c.attrBaseline);
        }
      }
      for (const c of prepared.collapsePreps) {
        if (c.collapsed) c.target.setAttribute(COLLAPSED_ATTRIBUTE, '1');
      }
      for (const c of prepared.collapsePreps) {
        prepared.collapseWiring.push(wireCollapseToggle(c.toggle as HTMLElement, c.target));
      }
      // S7.2: rules install here (a reversible resource); their seed
      // actions fire only AFTER acceptance — an external click must never
      // survive a rollback.
      for (const prep of prepared.rulePreps) {
        prepared.ruleHandles.push(deps.behavior.installRule(prep.spec));
      }
      // S7.1: bindings install AFTER all other native writes, in batch order —
      // exact registry entries under the transaction's ownership.
      for (const bind of prepared.bindPreps) prepared.bindHandles.push(deps.behavior.install(bind.spec));
      if (stagedOpId) deps.tokens.activate(nsNew, [...newSet].filter((el) => el.isConnected));
    } catch (e) {
      const rolled = await rollbackCandidate(prepared, req, digest, oldNs, oldSet, newSet, stagedOpId, nsNew, conflicts, `write section failed: ${(e as Error).message}`);
      return rolled;
    }

    // 5. Bounded settle, then epoch/cancel recheck.
    await (deps.settle ? deps.settle() : Promise.resolve());
    const afterSettle = staleOrCancelled(prepared, signal);
    if (afterSettle) {
      return rollbackCandidate(prepared, req, digest, oldNs, oldSet, newSet, stagedOpId, nsNew, conflicts, afterSettle.message);
    }

    // 6. S4.3 mandatory structured verification: delivery/effect/integrity
    //    against the captured baseline, one bounded recheck of unknowns; the
    //    aggregate gates acceptance (I11 — unknown is never accepted).
    let report: VerificationReport;
    try {
      report = await verifier.verify(prepared.plan, captured.baseline);
    } catch (e) {
      report = syntheticReport(req, `the verifier failed: ${(e as Error).message}`);
    }
    const counted = report.counts.pass + report.counts.satisfied + report.counts.fail + report.counts.unknown;
    if (report.revisionId !== req.revisionId || !['pass', 'fail', 'unknown'].includes(report.status) || counted === 0) {
      // A report with NO measured checks can never pass (T13: no empty-array
      // fallback pass; a missing/empty verifier is unknown).
      report = syntheticReport(req, 'the verifier returned no usable report for this revision');
    }
    if (report.status !== 'pass') {
      const keys = report.issues.slice(0, 3).map((i) => i.key).join(', ');
      return rollbackCandidate(prepared, req, digest, oldNs, oldSet, newSet, stagedOpId, nsNew, conflicts,
        `verification ${report.status}${keys ? `: ${keys}` : ''}`, report);
    }

    // 7. Acceptance: commit metadata FIRST (predecessor retained), recheck,
    //    then release the predecessor bundle (plan/08 §4 step 8).
    if (stagedOpId) {
      const commitReply = await deps.styleClient.commit(stagedOpId);
      const late = staleOrCancelled(prepared, signal);
      if (!commitReply.ok || late) {
        // Late promotion compensation: the whole candidate reverses under the
        // SAME operation id; the predecessor is re-activated (I07/I12).
        const reason = late ? late.message : `commit metadata ack refused: ${commitReply.ok ? '' : commitReply.message}`;
        return rollbackCandidate(prepared, req, digest, oldNs, oldSet, newSet, stagedOpId, nsNew, conflicts, `late promotion compensated: ${reason}`, report);
      }
    }

    // Transfer site-base inverses and retire obsolete predecessor resources
    // (plan/08 §5): the replaced revision's owned trees are removed now, its
    // text claims transfer to this revision.
    const replacedOwned = prepared.replaces?.ownedNodes ?? [];
    if (prepared.replaces) {
      for (const t of prepared.replaces.texts) {
        if (!prepared.textPreps.some((p) => p.node === t.node)) textClaims.delete(t.node);
      }
      deps.content.remove(replacedOwned);
    // The replaced revision's bindings, rules and collapse wiring retire
    // with it (its toggle nodes go with replacedOwned; its attribute state
    // was already yielded to the successor's declaration in the write
    // section). Stale handles over a same-chord successor entry are exact
    // no-ops.
    if (prepared.replaces) {
      for (const b of prepared.replaces.bindings) b.handle.dispose();
      for (const r of prepared.replaces.rules) r.handle.dispose();
      for (const c of prepared.replaces.collapses) {
        if (c.wiring) c.wiring.dispose();
      }
    }
    }
    for (const t of prepared.textPreps) textClaims.set(t.node, req.customizationId);

    let cleanupFailed = false;
    if (stagedOpId && acceptedOpId !== null) {
      const rm = await deps.styleClient.remove(acceptedOpId, acceptedCss);
      if (!rm.ok) {
        // I10: the failed cleanup stays visible and blocks the next
        // replacement (checked in prepare).
        cleanupPending = true;
        cleanupFailed = true;
      }
    }
    if (stagedOpId) {
      acceptedOpId = stagedOpId;
      acceptedCss = prepared.aggregateCss!;
      compositionNs = nsNew;
    }

    const record: RevisionRecord = {
      customizationId: req.customizationId,
      revisionId: req.revisionId,
      batchId: req.batchId,
      styleOps: prepared.styleOps,
      texts: prepared.textPreps.map((t) => ({ node: t.node, siteBaseline: t.siteBaseline, installed: t.installed })),
      ownedNodes: prepared.inserts.flatMap((i) => i.roots),
      bindings: prepared.bindHandles.map((handle, j) => ({ spec: prepared.bindPreps[j]!.spec, handle })),
      rules: prepared.ruleHandles.map((handle, j) => ({ key: req.customizationId, handle, ruleKey: req.customizationId })),
      collapses: prepared.collapsePreps.map((c, j) => ({
        target: c.target,
        toggle: c.toggle,
        attrBaseline: c.attrBaseline,
        collapsed: c.collapsed,
        wiring: prepared.collapseWiring[j] ?? null,
      })),
      elements: prepared.candidateElements,
      highImpact: prepared.highImpact,
      decls: prepared.candidateDecls,
    };
    revisions.set(req.customizationId, record);

    // S7.2: each rule copy's SEED action fires only now — post-acceptance,
    // so an external (non-reversible) click can never survive a rollback.
    // The once-per-instance state marks the attempt either way (plan/09 §3).
    for (const prep of prepared.rulePreps) {
      try {
        evaluateRule(prep.spec, prep.seed, prep.spec.affordance, deps.now());
      } catch {
        /* a throwing site handler consumed the one attempt; the rule stays */
      }
    }

    const resourceIds = [
      ...(prepared.aggregateCss !== null ? ['aggregate-css'] : []),
      ...prepared.textPreps.map((_, i) => `text-${i}`),
      ...prepared.inserts.map((_, i) => `insert-${i}`),
      ...prepared.bindPreps.map((_, i) => `bind-${i}`),
      ...prepared.collapsePreps.map((_, i) => `collapse-${i}`),
      ...prepared.rulePreps.map((_, i) => `rule-${i}`),
    ];
    return remember(req.batchId, digest, {
      batchId: req.batchId,
      payloadDigest: digest,
      status: 'accepted',
      resourceIds,
      routeEpoch: epochNow(),
      ...(cleanupFailed ? { cleanupPending: true } : {}),
      report,
    });
  };

  const restoreTextRollback = (
    t: PreparedBatch['textPreps'][number],
    conflicts: string[],
  ): void => {
    if (!t.node.isConnected) {
      conflicts.push(`text target left the document; its claim is recorded, not restored by guess`);
      return;
    }
    if (t.node.nodeValue !== t.installed) {
      conflicts.push(`text target was changed by the site during the candidate; the newer value stays`);
      return;
    }
    t.node.nodeValue = t.predecessorValue ?? t.siteBaseline;
  };

  const removeBundleBestEffort = async (opId: string, css: string): Promise<void> => {
    try {
      await deps.styleClient.remove(opId, css);
    } catch {
      // The broker ledger records the failed removal; reconcile exact-cleans.
    }
  };

  /** A5 candidate rollback: disarm tokens first, reverse native writes in
   *  reverse creation order (compare-and-restore), exact-clean the staged
   *  bundle, keep every conflict visible. Independent accepted revisions are
   *  never touched. */
  const rollbackCandidate = async (
    prepared: PreparedBatch,
    req: BatchRequest,
    digest: string,
    oldNs: string,
    oldSet: Set<Element>,
    newSet: Set<Element>,
    stagedOpId: string | null,
    nsNew: string,
    conflicts: string[],
    reason: string,
    report?: VerificationReport,
  ): Promise<BatchReceipt> => {
    // Disarm FIRST (I07): the candidate namespace can never reactivate.
    deps.tokens.revoke(nsNew);
    deps.tokens.disarm(nsNew, [...newSet]);
    if (stagedOpId) {
      // Restore the accepted aggregate's membership.
      for (const el of oldSet) if (el.isConnected) deps.tokens.activate(oldNs, [el]);
    }
    // Reverse creation order: inserts after texts are removed first;
    // candidate bindings uninstall exactly, then the predecessor's bindings
    // re-install from their specs (a same-chord replacement overwrote the
    // registry entry — the old shortcut must survive the rollback).
    for (const h of [...prepared.bindHandles].reverse()) h.dispose();
    // S7.2: the candidate's rule never fired its seed (post-acceptance only)
    // and the collapse wiring/attribute state reverse exactly.
    for (const h of [...prepared.ruleHandles].reverse()) h.dispose();
    for (const w of [...prepared.collapseWiring].reverse()) w.dispose();
    for (const c of prepared.collapsePreps) {
      if (c.collapsed) {
        if (c.attrBaseline === null) c.target.removeAttribute(COLLAPSED_ATTRIBUTE);
        else c.target.setAttribute(COLLAPSED_ATTRIBUTE, c.attrBaseline);
      }
    }
    if (prepared.replaces) {
      for (const b of prepared.replaces.bindings) deps.behavior.install(b.spec);
      // The replaced revision's collapse state re-applies (the write section
      // yielded it to the candidate's declaration).
      for (const c of prepared.replaces.collapses) {
        if (c.collapsed) c.target.setAttribute(COLLAPSED_ATTRIBUTE, '1');
      }
    }
    for (const ins of [...prepared.inserts].reverse()) deps.content.remove(ins.roots);
    for (const t of [...prepared.textPreps].reverse()) restoreTextRollback(t, conflicts);
    for (const drop of [...prepared.droppedTexts].reverse()) {
      if (!drop.node.isConnected) continue;
      if (drop.node.nodeValue === drop.siteBaseline) drop.node.nodeValue = drop.predecessorInstalled;
    }
    if (stagedOpId) await removeBundleBestEffort(stagedOpId, prepared.aggregateCss!);
    return remember(req.batchId, digest, {
      batchId: req.batchId,
      payloadDigest: digest,
      status: conflicts.length > 0 ? 'conflicted' : 'rolled-back',
      resourceIds: [],
      routeEpoch: deps.routeEpoch(),
      error: err('conflict', 'apply', reason, 'the whole candidate rolled back; earlier accepted revisions are untouched'),
      ...(conflicts.length ? { conflicts: conflicts.slice(0, 16) } : {}),
      ...(report ? { report } : {}),
    });
  };

  /** Release one customization to the site baseline (disable/remove). Text
   *  claims restore the SITE value (not the predecessor's); owned trees are
   *  removed exactly; the aggregate is recomposed without the fragment. */
  const releaseCustomization = async (customizationId: string): Promise<BatchReceipt> => {
    const rev = revisions.get(customizationId);
    if (!rev) {
      return {
        batchId: `release:${customizationId}`,
        payloadDigest: '',
        status: 'not-applied',
        resourceIds: [],
        error: err('unknown-target', 'reconcile', `no accepted revision for customization "${customizationId}"`),
      };
    }
    const conflicts: string[] = [];
    for (const t of rev.texts) {
      textClaims.delete(t.node);
      if (!t.node.isConnected) { conflicts.push('a released text node left the document; nothing was overwritten'); continue; }
      if (t.node.nodeValue !== t.installed) { conflicts.push('the site changed a released text value meanwhile; the newer value stays'); continue; }
      t.node.nodeValue = t.siteBaseline;
    }
    deps.content.remove(rev.ownedNodes);
    // S7.1: exact uninstall of this revision's keyboard bindings.
    for (const b of rev.bindings) b.handle.dispose();
    // S7.2: the rule uninstalls (its already-caused external effects stay —
    // no replayed or inverse consequential action, plan/08 §1); owned
    // collapse disclosures restore the site's attribute baseline exactly.
    for (const r of rev.rules) r.handle.dispose();
    for (const c of rev.collapses) {
      if (c.wiring) c.wiring.dispose();
      if (c.attrBaseline === null) c.target.removeAttribute(COLLAPSED_ATTRIBUTE);
      else c.target.setAttribute(COLLAPSED_ATTRIBUTE, c.attrBaseline);
    }
    revisions.delete(customizationId);

    // Recompose the aggregate without the released fragment.
    const others = [...revisions.values()];
    const oldOpId = acceptedOpId;
    const oldNs = compositionNs;
    const oldSet = new Set<Element>(rev.elements);
    if (others.length > 0) {
      generation += 1;
      const nsNew = `rv2.i${deps.installationId()}.g${generation}`;
      const css = others.map((r) => recompileFragment(r, nsNew)).filter(Boolean).join('\n');
      const opId = `release:${customizationId}:${deps.randomId()}`;
      const reply = await deps.styleClient.stage({ operationId: opId, namespace: nsNew, css });
      if (reply.ok && reply.state === 'inserted') {
        for (const el of rev.elements) if (el.isConnected && el.getAttribute(TOKEN_ATTRIBUTE) === oldNs) el.removeAttribute(TOKEN_ATTRIBUTE);
        const members: Element[] = [];
        for (const r of others) for (const el of r.elements) members.push(el);
        deps.tokens.activate(nsNew, members.filter((el) => el.isConnected));
        const commitReply = await deps.styleClient.commit(opId);
        if (commitReply.ok) {
          if (oldOpId !== null) {
            const rm = await deps.styleClient.remove(oldOpId, acceptedCss);
            if (!rm.ok) cleanupPending = true;
          }
          acceptedOpId = opId;
          acceptedCss = css;
          compositionNs = nsNew;
        }
      }
    } else {
      // No fragments remain: the whole aggregate retires.
      for (const el of oldSet) if (el.isConnected && el.getAttribute(TOKEN_ATTRIBUTE) === oldNs) el.removeAttribute(TOKEN_ATTRIBUTE);
      deps.tokens.revoke(oldNs);
      if (oldOpId !== null) {
        const rm = await deps.styleClient.remove(oldOpId, acceptedCss);
        if (!rm.ok) cleanupPending = true;
      }
      acceptedOpId = null;
      acceptedCss = '';
      compositionNs = '';
    }

    return {
      batchId: `release:${customizationId}`,
      payloadDigest: '',
      status: conflicts.length > 0 ? 'conflicted' : 'accepted',
      resourceIds: rev.texts.map((_, i) => `text-${i}`),
      ...(conflicts.length ? { conflicts: conflicts.slice(0, 16) } : {}),
      ...(cleanupPending ? { cleanupPending: true } : {}),
    };
  };

  return {
    applyBatch,
    releaseCustomization,
    receiptFor: (batchId) => receipts.get(batchId)?.receipt,
    revisions: () => [...revisions.values()].map((r) => ({ customizationId: r.customizationId, revisionId: r.revisionId })),
  };
}

function styleOpsWillExist(ops: Operation[]): boolean {
  return ops.some((op) => op.kind === 'style' || op.kind === 'hide');
}

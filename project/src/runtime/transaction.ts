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
import type { ContentCreator } from './content.ts';
import type { ResolvedTargetRegistry } from './targets.ts';
import { TOKEN_ATTRIBUTE, type TokenScope } from './styles.ts';

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
  /** Elements this revision's fragment targets (token membership). */
  elements: Element[];
  highImpact: Array<{ property: string; value: string; risk: HighImpactRisk }>;
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

const UNSUPPORTED_KINDS = new Set(['collapse', 'float', 'bindKey', 'localRule', 'projectCollection', 'relocate']);

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
    droppedTexts: Array<{ node: Text; siteBaseline: string; predecessorInstalled: string }>;
    aggregateCss: string | null;
    replaces: RevisionRecord | undefined;
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
    const highImpact: PreparedBatch['highImpact'] = [];
    const newClaims = new Set<Text>();

    const resolveTarget = (spec: { targetRef?: string; localRef?: string }, path: string): { ok: true; el: Element } | { ok: false; error: ErrorRecord } => {
      if (spec.targetRef !== undefined) {
        const r = deps.targets.resolve(spec.targetRef, epoch);
        if (!r.ok) {
          const code = r.reason === 'missing' ? 'unknown-target' : 'stale-target';
          return { ok: false, error: err(code, 'validate', `${path}: ${r.detail}`, 're-observe for fresh target refs') };
        }
        if (r.rootId !== 'document') {
          return { ok: false, error: err('unsupported-capability', 'validate', `${path}: the target lives in root "${r.rootId}"; document-root sheets do not reach shadow descendants (open-root sheets arrive with a later slice)`) };
        }
        return { ok: true, el: r.node };
      }
      const el = batchLocal.get(spec.localRef!);
      if (!el) {
        return { ok: false, error: err('unknown-target', 'validate', `${path}: localRef "${spec.localRef}" names no node created by an earlier operation`) };
      }
      return { ok: true, el };
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
        case 'style':
          // Every rule target resolves before any side effect — stale/missing
          // targets keep their exact error codes (no compile-diag laundering).
          for (const [ri, rule] of op.rules.entries()) {
            const r = resolveTarget(rule.target, `${path}.rules[${ri}].target`);
            if (!r.ok) return { ok: false, receipt: refuse(req, digest, r.error) };
            styleTargets.set(rule.target.targetRef ?? rule.target.localRef ?? `${i}:${ri}`, r.el);
          }
          styleOps.push(op);
          break;
        case 'hide': {
          // A hide IS a display fragment through the same compiled path
          // (plan/08 §1: same target/risk policy as style — I17).
          const hideTarget = resolveTarget(op.target, `${path}.target`);
          if (!hideTarget.ok) return { ok: false, receipt: refuse(req, digest, hideTarget.error) };
          styleTargets.set(op.target.targetRef ?? op.target.localRef ?? `${i}`, hideTarget.el);
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
        droppedTexts,
        aggregateCss,
        replaces: replaced,
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
    // 1. Dedupe: the same operation id replays its receipt; a different
    //    payload under the same id never executes (T14/T08).
    const digest = digestOf(JSON.stringify(req.operations));
    const prior = receipts.get(req.batchId);
    if (prior) {
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

    const stagedOpId = prepared.aggregateCss !== null ? `${req.batchId}:css` : null;

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

    // 6. Verification (S4.2 scope: delivery, placement, token membership and
    //    written values — S4.3 adds the measured effect/integrity report).
    const verifyProblems: string[] = [];
    for (const [i, t] of prepared.textPreps.entries()) {
      if (!t.node.isConnected || t.node.nodeValue !== t.installed) verifyProblems.push(`text resource ${i} did not hold its installed value`);
    }
    for (const [i, ins] of prepared.inserts.entries()) {
      if (!ins.roots.every((r) => r.isConnected)) verifyProblems.push(`insertUI ${i} is not connected at its anchor`);
    }
    for (const el of prepared.candidateElements) {
      if (el.isConnected && el.getAttribute(TOKEN_ATTRIBUTE) !== nsNew) {
        verifyProblems.push('a candidate target lost its token membership (site interference or re-render)');
      }
    }
    if (verifyProblems.length > 0) {
      return rollbackCandidate(prepared, req, digest, oldNs, oldSet, newSet, stagedOpId, nsNew, conflicts, `verification failed: ${verifyProblems.join('; ')}`);
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
        return rollbackCandidate(prepared, req, digest, oldNs, oldSet, newSet, stagedOpId, nsNew, conflicts, `late promotion compensated: ${reason}`);
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
      elements: prepared.candidateElements,
      highImpact: prepared.highImpact,
    };
    revisions.set(req.customizationId, record);

    const resourceIds = [
      ...(prepared.aggregateCss !== null ? ['aggregate-css'] : []),
      ...prepared.textPreps.map((_, i) => `text-${i}`),
      ...prepared.inserts.map((_, i) => `insert-${i}`),
    ];
    return remember(req.batchId, digest, {
      batchId: req.batchId,
      payloadDigest: digest,
      status: 'accepted',
      resourceIds,
      routeEpoch: epochNow(),
      ...(cleanupFailed ? { cleanupPending: true } : {}),
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
  ): Promise<BatchReceipt> => {
    // Disarm FIRST (I07): the candidate namespace can never reactivate.
    deps.tokens.revoke(nsNew);
    deps.tokens.disarm(nsNew, [...newSet]);
    if (stagedOpId) {
      // Restore the accepted aggregate's membership.
      for (const el of oldSet) if (el.isConnected) deps.tokens.activate(oldNs, [el]);
    }
    // Reverse creation order: inserts after texts are removed first.
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

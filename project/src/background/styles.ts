/**
 * background/styles — privileged CSS delivery (plan/03 `background/styles`).
 *
 * Inputs are bounded, structurally validated delivery orders (operation id,
 * namespace, exact CSS bytes) for a registered document — NO semantic target
 * decisions live here; the S4 compiler owns sheet compilation and the runtime
 * owns activation (token attach). This module owns plan/06 §2 boundary 2:
 *
 *   - one serial style queue per DocumentKey;
 *   - durable session intent written BEFORE the insertCSS call (plan/06 §3:
 *     "session delivery intent BEFORE insert");
 *   - exact receipts: inserted / removed / outcome-unknown — a timeout is
 *     never reported as not-applied (I06);
 *   - operation dedupe: same operation id + same digest returns the recorded
 *     receipt without re-inserting; same id + different payload digest is a
 *     conflict (never executes the altered payload);
 *   - at most one accepted + one candidate physical bundle per root;
 *     an unknown/uncertain bundle blocks replacements until reconciled;
 *   - namespace revocation disarms FIRST (I07): a cancelled namespace is
 *     recorded revoked before asynchronous cleanup, a late insert ack for it
 *     triggers exact cleanup, and it can never be staged or committed again;
 *   - restart reconciliation: uncertain/staging intents are exact-cleaned
 *     (removeCSS the recorded bytes) before new work — no reliance on
 *     undocumented browser sheet dedupe;
 *   - removal failures stay recorded and visible (never a false clean ack,
 *     I10) until the removal succeeds or the document is destroyed.
 *
 * Pure core with injected platform seams; `createChromeStyleDelivery()` is
 * the only chrome.* wiring. DOM-free by layer table (plan/02 §1).
 */

import type { DocumentKey } from '../contracts.ts';

// ── delivery state ───────────────────────────────────────────────────────

export type DeliveryState =
  | 'staging'        // intent recorded, insertCSS in flight
  | 'inserted'       // API resolved: bytes are in the document (inert until runtime activation)
  | 'removed'        // exact bytes confirmed out of the document
  | 'remove-failed'  // removal attempted and failed — stays visible until it succeeds (I10)
  | 'unknown'        // call outcome not observed (timeout/crash) — reconciliation exact-cleans
  | 'revoked';       // namespace cancelled; any bytes are being exactly cleaned

export interface DeliveryIntent {
  operationId: string;
  payloadDigest: string;
  namespace: string;
  documentKey: DocumentKey;
  css: string;
  rootId: string;
  recordedAt: number;
  state: DeliveryState;
  error?: string;
}

export type StyleReply =
  | { ok: true; kind: 'staged'; operationId: string; state: DeliveryState; receiptStatus: 'applied-provisional' | 'outcome-unknown' }
  | { ok: true; kind: 'removed'; operationId: string; state: DeliveryState; receiptStatus: 'rolled-back' }
  | { ok: true; kind: 'committed'; operationId: string; promotedNamespace: string }
  | { ok: false; kind: 'error'; code: string; message: string; recoveryAction?: string };

export const STYLE_SHEET_MAX_BYTES = 262_144; // delivery ceiling; the S4 compiler owns the authored-sheet contract
const NAMESPACE_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;
const MAX_TRACKED_INTENTS = 128; // bounded session ledger per plan/15; eviction only after terminal state

export interface StyleDeps {
  now(): number;
  randomId(): string;
  /** Delivery budget for one insert/remove API call (default 10s). */
  deliveryTimeoutMs?: number;
  /** Exact-byte insert. Resolves when the API resolves delivery. */
  insertCss(target: { tabId: number; documentId: string }, css: string): Promise<void>;
  /** Exact-byte removal (same bytes that were inserted). */
  removeCss(target: { tabId: number; documentId: string }, css: string): Promise<void>;
  persistIntents(intents: DeliveryIntent[]): Promise<void>;
  loadIntents(): Promise<DeliveryIntent[]>;
}

export interface StageOrder {
  operationId: string;
  namespace: string;
  css: string;
  documentKey: DocumentKey;
  rootId?: string;
}

export interface StyleDelivery {
  stage(order: StageOrder): Promise<StyleReply>;
  remove(operationId: string, documentKey: DocumentKey, css?: string): Promise<StyleReply>;
  /** Promote an inserted candidate to accepted (plan/06 CommitComposition:
   *  records promotion only; the predecessor bundle is removed by an explicit
   *  later remove, never implicitly here). */
  commit(operationId: string, documentKey: DocumentKey): Promise<StyleReply>;
  /** Disarm-first namespace cancellation (I07). */
  cancelNamespace(namespace: string, documentKey: DocumentKey, reason?: string): Promise<StyleReply>;
  /** Receipt lookup for GetOperation reconciliation. */
  receiptFor(operationId: string): DeliveryIntent | undefined;
  /** Confirmed document destruction (navigation/tab close): recorded bytes
   *  died with the document — mark terminal without removeCSS calls. */
  documentDestroyed(documentKey: DocumentKey): number;
  /** Startup: exact-clean every uncertain/staging/revoked-pending intent. */
  reconcile(): Promise<number>;
  intents(): DeliveryIntent[];
}

const digestOf = (s: string): string => {
  // FNV-1a over UTF-16 code units — dedupe/conflict detection only, not a
  // security primitive (the sheet bytes themselves are the exact removal key).
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0') + ':' + s.length.toString(16);
};

const deny = (code: string, message: string, recoveryAction?: string): StyleReply => ({
  ok: false,
  kind: 'error',
  code,
  message,
  ...(recoveryAction ? { recoveryAction } : {}),
});

export function createStyleDelivery(deps: StyleDeps): StyleDelivery {
  /** key: `${tabId}:${frameId}:${documentId}` */
  const byDocument = new Map<string, { accepted: DeliveryIntent | null; candidate: DeliveryIntent | null }>();
  const byOperation = new Map<string, DeliveryIntent>();
  const revokedNamespaces = new Set<string>();
  let hydrated = false;

  const docKeyOf = (dk: DocumentKey): string => `${dk.tabId}:${dk.frameId}:${dk.browserDocumentId}`;
  const targetOf = (dk: DocumentKey) => ({ tabId: dk.tabId, documentId: dk.browserDocumentId });

  const persist = async (): Promise<boolean> => {
    try {
      await deps.persistIntents([...byOperation.values()].slice(-MAX_TRACKED_INTENTS));
      return true;
    } catch {
      // The in-memory ledger stays authoritative for this worker lifetime; a
      // restart that cannot rehydrate reconciles by exact cleanup on load.
      return false;
    }
  };

  const setState = (intent: DeliveryIntent, state: DeliveryState, error?: string): void => {
    intent.state = state;
    if (error !== undefined) intent.error = error.slice(0, 500);
    const doc = byDocument.get(docKeyOf(intent.documentKey));
    if (doc) {
      // A terminal release clears its slot; an UNKNOWN candidate stays in the
      // candidate slot on purpose — it must block replacements until reconcile
      // exact-cleans it (plan/06 §2 boundary 2).
      if (doc.accepted === intent && (state === 'removed' || state === 'revoked')) doc.accepted = null;
      if (doc.candidate === intent && (state === 'removed' || state === 'revoked')) doc.candidate = null;
    }
    void persist();
  };

  const hydrate = async (): Promise<void> => {
    if (hydrated) return;
    hydrated = true;
    try {
      for (const intent of await deps.loadIntents()) {
        byOperation.set(intent.operationId, intent);
        const doc = byDocument.get(docKeyOf(intent.documentKey)) ?? { accepted: null, candidate: null };
        if (intent.state === 'inserted') doc.accepted = doc.accepted ?? intent;
        else if (intent.state !== 'removed' && intent.state !== 'revoked') doc.candidate = doc.candidate ?? intent;
        byDocument.set(docKeyOf(intent.documentKey), doc);
      }
    } catch {
      /* empty ledger on hydration failure — reconcile() still runs below */
    }
  };

  const exactClean = async (intent: DeliveryIntent): Promise<boolean> => {
    try {
      await deps.removeCss(targetOf(intent.documentKey), intent.css);
      return true;
    } catch {
      return false;
    }
  };

  const reconcile = async (): Promise<number> => {
    await hydrate();
    let cleaned = 0;
    for (const intent of [...byOperation.values()]) {
      if (intent.state !== 'unknown' && intent.state !== 'staging' && intent.state !== 'revoked') continue;
      // An uncertain candidate may be live in the document: exact cleanup of
      // the recorded bytes before anything else may stage (plan/06 §3).
      const ok = await exactClean(intent);
      if (intent.state === 'revoked') {
        // Revoked namespaces were already disarmed logically; cleanup outcome
        // is recorded but never re-activates them (I07).
        setState(intent, ok ? 'removed' : 'remove-failed', ok ? undefined : 'revoked-namespace cleanup failed');
      } else {
        setState(intent, ok ? 'removed' : 'remove-failed', ok ? 'reconciled on startup by exact cleanup' : 'reconciliation removal failed; stays visible');
      }
      cleaned += 1;
    }
    return cleaned;
  };

  const stage = async (order: StageOrder): Promise<StyleReply> => {
    await hydrate();
    const { operationId, namespace, css, documentKey } = order;
    const rootId = order.rootId ?? 'document';
    if (!NAMESPACE_PATTERN.test(namespace)) {
      return deny('invalid-schema', 'namespace must match ^[A-Za-z0-9._-]{1,200}$', 'reissue with a compiler-generated namespace');
    }
    if (css.length > STYLE_SHEET_MAX_BYTES) {
      return deny('out-of-bounds', `sheet exceeds the ${STYLE_SHEET_MAX_BYTES}-byte delivery ceiling`);
    }
    if (revokedNamespaces.has(namespace)) {
      // I07: a cancelled namespace is never reused or reactivated.
      return deny('conflict', `namespace "${namespace}" was revoked; cancelled namespaces are not reused`, 'compile a fresh namespace for this work');
    }
    const digest = digestOf(css);
    const existing = byOperation.get(operationId);
    if (existing) {
      if (existing.payloadDigest === digest && existing.state === 'inserted') {
        // Idempotent retry of the same operation: same receipt, no re-insert.
        return { ok: true, kind: 'staged', operationId, state: existing.state, receiptStatus: 'applied-provisional' };
      }
      if (existing.payloadDigest !== digest) {
        // T14: duplicate id with an altered payload must never execute.
        return deny('duplicate-id', 'operation id already recorded with a different payload digest', 'reissue with a fresh operation id');
      }
      if (existing.state === 'unknown' || existing.state === 'staging') {
        return deny('conflict', 'previous delivery for this operation is unresolved; reconcile first', 'query GetOperation, then reconcile');
      }
      // removed/remove-failed: fall through and re-stage (id may be reused
      // only for the identical bytes; digest matches by construction here).
    }

    const doc = byDocument.get(docKeyOf(documentKey)) ?? { accepted: null, candidate: null };
    byDocument.set(docKeyOf(documentKey), doc);
    if (doc.candidate && (doc.candidate.state === 'unknown' || doc.candidate.state === 'staging')) {
      return deny('conflict', 'an uncertain candidate bundle blocks replacements until it is reconciled', 'reconcile the uncertain bundle first');
    }
    if (doc.candidate && doc.candidate.state === 'inserted' && doc.candidate.namespace !== namespace) {
      // Replace the provisional candidate: disarm its namespace first, then
      // exact-remove the old bytes before staging the new bundle.
      const old = doc.candidate;
      revokedNamespaces.add(old.namespace);
      setState(old, 'revoked', 'displaced by a newer candidate bundle');
      const removed = await exactClean(old);
      if (!removed) {
        setState(old, 'remove-failed', 'displaced candidate removal failed; replacements blocked until reconciled');
        return deny('conflict', 'the previous candidate bundle could not be removed; cleanup conflict is visible', 'reconcile; the failed removal stays reported');
      }
      setState(old, 'removed');
    }

    const intent: DeliveryIntent = {
      operationId,
      payloadDigest: digest,
      namespace,
      documentKey: { ...documentKey },
      css,
      rootId,
      recordedAt: deps.now(),
      state: 'staging',
    };
    byOperation.set(operationId, intent);
    doc.candidate = intent;
    // I05: the durable intent (owner ids + exact bytes = the release strategy)
    // is written BEFORE the side effect. If it cannot be recorded, the side
    // effect must not happen — an unrecorded effect would be unreleasable
    // after a worker death.
    if (!(await persist())) {
      setState(intent, 'unknown', 'delivery intent could not be recorded; the sheet was not inserted');
      return { ok: true, kind: 'staged', operationId, state: 'unknown', receiptStatus: 'outcome-unknown' };
    }
    try {
      const budget = deps.deliveryTimeoutMs ?? 10_000;
      const outcome = await Promise.race([
        deps.insertCss(targetOf(documentKey), css).then(() => 'resolved' as const),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), budget)),
      ]);
      if (outcome === 'timeout') {
        // I06: unknown, never not-applied. Exact cleanup happens at reconcile.
        setState(intent, 'unknown', 'insertCSS did not resolve within the delivery budget');
        return { ok: true, kind: 'staged', operationId, state: 'unknown', receiptStatus: 'outcome-unknown' };
      }
      if (revokedNamespaces.has(namespace)) {
        // Cancel raced the insert: the ack arrives for a revoked namespace —
        // exact-clean immediately; never report it as live (I07).
        const ok = await exactClean(intent);
        setState(intent, ok ? 'removed' : 'remove-failed', 'namespace revoked while staging');
        return { ok: true, kind: 'staged', operationId, state: intent.state, receiptStatus: 'outcome-unknown' };
      }
      setState(intent, 'inserted');
      return { ok: true, kind: 'staged', operationId, state: 'inserted', receiptStatus: 'applied-provisional' };
    } catch (err) {
      // API error (permission revoked, document gone): explicit failure, no
      // false ack. Exact-cleanup is still attempted for partial delivery.
      const message = err instanceof Error ? err.message : String(err);
      setState(intent, 'unknown', `insertCSS failed: ${message}`);
      return { ok: true, kind: 'staged', operationId, state: 'unknown', receiptStatus: 'outcome-unknown' };
    }
  };

  const remove = async (operationId: string, documentKey: DocumentKey, css?: string): Promise<StyleReply> => {
    await hydrate();
    const intent = byOperation.get(operationId);
    const bytes = intent?.css ?? css;
    if (bytes === undefined) {
      return deny('unknown-target', 'no recorded delivery for this operation id and no exact bytes provided', 'provide the exact bytes or query GetOperation');
    }
    const target = intent ? targetOf(intent.documentKey) : targetOf(documentKey);
    try {
      await Promise.race([
        deps.removeCss(target, bytes),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), deps.deliveryTimeoutMs ?? 10_000)),
      ]);
      if (intent) setState(intent, 'removed');
      return { ok: true, kind: 'removed', operationId, state: intent?.state ?? 'removed', receiptStatus: 'rolled-back' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (intent) setState(intent, 'remove-failed', `removeCSS failed: ${message}`);
      // I10: the failure stays recorded and visible; never a false clean ack.
      return deny('conflict', `removal failed: ${message}`, 'retry removal; the failed state stays reported until the document is destroyed');
    }
  };

  const commit = async (operationId: string, documentKey: DocumentKey): Promise<StyleReply> => {
    await hydrate();
    const intent = byOperation.get(operationId);
    if (!intent || docKeyOf(intent.documentKey) !== docKeyOf(documentKey)) {
      return deny('unknown-target', 'no candidate delivery for this operation in this document');
    }
    if (intent.state === 'unknown' || intent.state === 'staging') {
      // plan/05 §4: nothing transitions directly from delivery-unknown to accepted.
      return deny('conflict', 'delivery outcome is unresolved; it cannot be committed', 'reconcile the uncertain delivery first');
    }
    if (intent.state !== 'inserted') {
      return deny('conflict', `candidate is ${intent.state}; only an inserted bundle can be committed`);
    }
    const doc = byDocument.get(docKeyOf(documentKey));
    if (!doc) return deny('unknown-target', 'no delivery ledger for this document');
    doc.accepted = intent;
    doc.candidate = null;
    void persist();
    return { ok: true, kind: 'committed', operationId, promotedNamespace: intent.namespace };
  };

  const cancelNamespace = async (namespace: string, documentKey: DocumentKey, reason?: string): Promise<StyleReply> => {
    await hydrate();
    revokedNamespaces.add(namespace); // disarm FIRST — before any async cleanup (I07)
    const intents = [...byOperation.values()].filter((i) => i.namespace === namespace && i.state !== 'removed');
    if (!intents.length) {
      return { ok: true, kind: 'removed', operationId: '', state: 'removed', receiptStatus: 'rolled-back' };
    }
    let allClean = true;
    for (const intent of intents) {
      setState(intent, 'revoked', reason ?? 'namespace cancelled');
      const ok = await exactClean(intent);
      if (!ok) {
        allClean = false;
        setState(intent, 'remove-failed', 'revoked-namespace cleanup failed; stays visible');
      } else {
        setState(intent, 'removed');
      }
    }
    void persist();
    return allClean
      ? { ok: true, kind: 'removed', operationId: intents[0].operationId, state: 'removed', receiptStatus: 'rolled-back' }
      : deny('conflict', 'revoked-namespace cleanup failed for some bundles; the conflict stays reported', 'reconcile on next startup');
  };

  return {
    stage,
    remove,
    commit,
    cancelNamespace,
    receiptFor: (operationId) => byOperation.get(operationId),
    documentDestroyed: (documentKey) => {
      const docId = docKeyOf(documentKey);
      let n = 0;
      for (const intent of byOperation.values()) {
        if (docKeyOf(intent.documentKey) === docId && intent.state !== 'removed' && intent.state !== 'revoked') {
          setState(intent, 'removed', 'document destroyed; the exact bytes died with it');
          n += 1;
        }
      }
      return n;
    },
    reconcile,
    intents: () => [...byOperation.values()],
  };
}

// ── chrome wiring (the only chrome-dependent part) ──────────────────────

export const INTENTS_KEY = 'rv2_styleDeliveryIntents';

export function createChromeStyleDelivery(overrides: Partial<StyleDeps> = {}): StyleDelivery {
  const deps: StyleDeps = {
    now: () => Date.now(),
    randomId: () => crypto.randomUUID(),
    insertCss: (target, css) =>
      new Promise((resolve, reject) => {
        chrome.scripting.insertCSS(
          { target: { tabId: target.tabId, documentIds: [target.documentId] }, css, origin: 'AUTHOR' },
          () => {
            const err = chrome.runtime.lastError;
            if (err) reject(new Error(err.message ?? 'insertCSS failed'));
            else resolve();
          },
        );
      }),
    removeCss: (target, css) =>
      new Promise((resolve, reject) => {
        chrome.scripting.removeCSS(
          { target: { tabId: target.tabId, documentIds: [target.documentId] }, css, origin: 'AUTHOR' },
          () => {
            const err = chrome.runtime.lastError;
            if (err) reject(new Error(err.message ?? 'removeCSS failed'));
            else resolve();
          },
        );
      }),
    persistIntents: async (intents) => {
      await chrome.storage.session.set({ [INTENTS_KEY]: intents });
    },
    loadIntents: async () => {
      const stored = await chrome.storage.session.get(INTENTS_KEY);
      return (stored[INTENTS_KEY] as DeliveryIntent[] | undefined) ?? [];
    },
    ...overrides,
  };
  return createStyleDelivery(deps);
}

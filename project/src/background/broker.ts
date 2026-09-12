/**
 * background/broker — the MV3 privilege boundary (plan/03 `background/broker`
 * + `background/documents`, consolidated per plan/02 §3).
 *
 * Every v2 request travels as an Envelope (plan/04 §1). This module:
 *   1. classifies the BROWSER-reported sender and verifies the sender role
 *      against the per-command allowlist (contracts §9) — payload fields can
 *      never elevate a sender (I19);
 *   2. decodes the envelope, then the command payload for its transport kind;
 *   3. owns the document registry: DocumentKey (tabId+frameId+browserDocumentId
 *      +runtimeInstanceId) and the authoritative route epoch — a tab id alone
 *      never authorizes anything (I04);
 *   4. enforces one run owner per document;
 *   5. relays page-scoped commands to the registered runtime and bounds the
 *      wait — a timeout is reported `timeout-unknown`, never `not-applied`
 *      (I06).
 *
 * The core below is pure over plain data (`SenderLike`, unknown message) with
 * injected platform seams; `installBroker()` is the only chrome.* wiring and
 * is called from entrypoints/background.ts. The registry survives service
 * worker restarts through chrome.storage.session (hydration barrier: the
 * listener is installed synchronously, handlers await hydration).
 *
 * DOM-free by layer table (plan/02 §1): nothing here imports runtime/.
 */

import {
  classifySender,
  senderMayInvoke,
  decodeEnvelope,
  decodeObject,
  decodeOperationBatch,
  decodeRecord,
  decodeString,
  decodeLiteral,
  decodeArray,
  decodeRevision,
  decodeRouteScope,
  decodeBoolean,
  optional,
  LIMITS,
  type DocumentKey,
  type Envelope,
  type ErrorRecord,
  type ErrorCode,
  type ErrorPhase,
  type SenderLike,
} from '../contracts.ts';
import { createChromeStyleDelivery, type StyleDelivery, type StageOrder } from './styles.ts';
import { createStore, type StoreCore, type StoreOutcome } from './store.ts';
import type { Customization } from '../contracts.ts';

// ── replies ──────────────────────────────────────────────────────────────

export type BrokerReply =
  | { ok: true; kind: 'registered'; documentKey: DocumentKey; routeEpoch: number; applicable?: Customization[] }
  | { ok: true; kind: 'run-started'; runId: string }
  | { ok: true; kind: 'run-cancelled'; cancelled: boolean }
  | { ok: true; kind: 'relayed'; receipt: Record<string, unknown> }
  | { ok: true; kind: 'saved'; origin: string; recordRevision: number; mutationId: string; delivery?: Record<string, unknown>[] }
  | { ok: true; kind: 'record-revision'; recordRevision: number }
  | { ok: true; kind: 'origin-record'; originRecord: Record<string, unknown> | null }
  | { ok: true; kind: 'quarantine'; entries: Array<{ key: string; reason: string; bytes: number }>; raw?: string }
  | { ok: true; kind: 'documents'; documents: Array<{ documentKey: DocumentKey; tabId: number; frameId: number; routeEpoch: number; origin: string | null; parentOrigin: string | null; runOwner: boolean; registeredAt: number }> }
  | { ok: false; kind: 'error'; error: ErrorRecord; conflict?: Record<string, unknown> };

export function errorRecord(
  code: ErrorCode,
  phase: ErrorPhase,
  message: string,
  extra?: Partial<Pick<ErrorRecord, 'fieldPath' | 'recoveryAction' | 'groupId' | 'resourceId'>>,
): ErrorRecord {
  return {
    code,
    phase,
    retryClass: code === 'timeout-unknown' ? 'retryable-same-id' : code === 'unknown-target' || code === 'conflict' ? 'user-decision' : 'non-retryable',
    message: message.slice(0, 1000),
    ...extra,
  };
}

const deny = (code: ErrorCode, phase: ErrorPhase, message: string, extra?: Parameters<typeof errorRecord>[3]): BrokerReply => ({
  ok: false,
  kind: 'error',
  error: errorRecord(code, phase, message, extra),
});

// ── payload decoders (per-command, owned here — plan/04: per-kind payload
//    validation belongs to the dispatching owner) ─────────────────────────

const ID = decodeString({ max: 128, pattern: /^[A-Za-z0-9._:-]+$/ });
const COMMANDS_BY_TRANSPORT: Record<Envelope['kind'], readonly string[]> = {
  'run-command': ['StartRun', 'CancelRun', 'ApplyBatch'],
  'observe-request': ['Observe', 'Inspect', 'Expand'],
  'style-delivery': ['StageStyle', 'RemoveStyle', 'CommitComposition'],
  control: ['RegisterDocument', 'GetOperation', 'RenewLease', 'SaveRevision', 'SetEnabled', 'RemoveCustomization', 'GetOriginRecord', 'ExportQuarantine', 'ListDocuments', 'GetState'],
  subscription: ['RuntimeState', 'RunProgress'], // runtime→workspace projections: never routed
};

function decodeCommand(transport: Envelope['kind'], payload: Record<string, unknown>): { command: string } | ErrorRecord {
  const allowed = COMMANDS_BY_TRANSPORT[transport];
  // Extract the command name only — the rest of the payload is validated by
  // the per-command decoder (decodeObject rejects prototype-like keys).
  const extracted = decodeObject(payload, 'payload');
  if (!extracted.ok) return errorRecord('invalid-schema', 'decode', firstIssue(extracted.issues));
  const raw = extracted.value.command;
  if (typeof raw !== 'string' || !/^[A-Za-z]+$/.test(raw) || raw.length > 64) {
    return errorRecord('invalid-schema', 'decode', 'payload.command must be a command name string');
  }
  if (!allowed.includes(raw)) {
    return errorRecord('invalid-schema', 'decode', `command "${raw}" is not valid for transport kind "${transport}"`);
  }
  return { command: raw };
}

/** Per-command payload spec: every payload carries its own `command` field
 *  (the dispatching owner validates it); unknown fields stay rejected. */
const REGISTER_PAYLOAD = decodeRecord(
  {
    command: decodeLiteral(['RegisterDocument']),
    runtimeInstanceId: ID,
    capabilities: optional(decodeArray(decodeString({ max: 64 }), 16)),
  },
  { maxDepth: 8 },
);

const START_RUN_PAYLOAD = decodeRecord(
  {
    command: decodeLiteral(['StartRun']),
    goal: decodeString({ max: LIMITS.maxSummaryChars }),
  },
  { maxDepth: 8 },
);

const APPLY_BATCH_PAYLOAD = decodeRecord(
  {
    command: decodeLiteral(['ApplyBatch']),
    batch: decodeRecord(
      {
        batchId: ID,
        customizationId: ID,
        revisionId: ID,
        operations: (ov: unknown, opath = 'operations') => decodeOperationBatch(ov, opath),
      },
      { maxDepth: LIMITS.maxJsonDepth },
    ),
  },
  { maxDepth: LIMITS.maxJsonDepth },
);

const GET_OPERATION_PAYLOAD = decodeRecord(
  { command: decodeLiteral(['GetOperation']), operationId: ID },
  { maxDepth: 8 },
);

const COMMIT_PAYLOAD = decodeRecord(
  { command: decodeLiteral(['CommitComposition']), operationId: ID },
  { maxDepth: 8 },
);

const OBSERVE_PAYLOAD = decodeRecord(
  { command: decodeLiteral(['Observe']) },
  { maxDepth: 8 },
);

const INSPECT_PAYLOAD = decodeRecord(
  { command: decodeLiteral(['Inspect']), targetRef: decodeString({ max: 64, pattern: /^[A-Za-z0-9._-]+$/ }), fields: optional(decodeArray(decodeString({ max: 32 }), 16)) },
  { maxDepth: 8 },
);

const EXPAND_PAYLOAD = decodeRecord(
  { command: decodeLiteral(['Expand']), cursor: decodeString({ max: 256, pattern: /^[A-Za-z0-9._:-]+$/ }) },
  { maxDepth: 8 },
);

const STAGE_STYLE_PAYLOAD = decodeRecord(
  {
    command: decodeLiteral(['StageStyle']),
    operationId: ID,
    namespace: decodeString({ max: 200, pattern: /^[A-Za-z0-9._-]+$/ }),
    css: decodeString({ max: 262_144 }),
    rootId: optional(decodeString({ max: 128, pattern: /^[A-Za-z0-9._-]+$/ })),
  },
  { maxDepth: 8 },
);

const REMOVE_STYLE_PAYLOAD = decodeRecord(
  {
    command: decodeLiteral(['RemoveStyle']),
    operationId: ID,
    css: optional(decodeString({ max: 262_144 })),
  },
  { maxDepth: 8 },
);

const CONTENT_SENSITIVITY = decodeLiteral(['page-only', 'includes-user-content']);

// plan/13 §3: the workspace requests a save with the accepted revision, the
// expected record revision and a unique mutation id. All fields validated.
const SAVE_REVISION_PAYLOAD = decodeRecord(
  {
    command: decodeLiteral(['SaveRevision']),
    origin: decodeString({ max: 512, pattern: /^https?:\/\/[^\s]+$/ }),
    customizationId: ID,
    title: decodeString({ max: LIMITS.maxTitleChars }),
    scope: (v: unknown, p?: string) => decodeRouteScope(v, p ?? 'scope'),
    contentSensitivity: CONTENT_SENSITIVITY,
    grants: decodeArray(ID, 64),
    revision: (v: unknown, p?: string) => decodeRevision(v, p ?? 'revision'),
    expectedRecordRevision: decodeFiniteRecordInt('expectedRecordRevision'),
    mutationId: ID,
  },
  { maxDepth: LIMITS.maxJsonDepth },
);

const SET_ENABLED_PAYLOAD = decodeRecord(
  {
    command: decodeLiteral(['SetEnabled']),
    origin: decodeString({ max: 512, pattern: /^https?:\/\/[^\s]+$/ }),
    customizationId: ID,
    enabled: decodeBoolean,
    expectedRecordRevision: decodeFiniteRecordInt('expectedRecordRevision'),
    mutationId: ID,
  },
  { maxDepth: 8 },
);

const REMOVE_CUSTOMIZATION_PAYLOAD = decodeRecord(
  {
    command: decodeLiteral(['RemoveCustomization']),
    origin: decodeString({ max: 512, pattern: /^https?:\/\/[^\s]+$/ }),
    customizationId: ID,
    expectedRecordRevision: decodeFiniteRecordInt('expectedRecordRevision'),
    mutationId: ID,
  },
  { maxDepth: 8 },
);

const GET_ORIGIN_RECORD_PAYLOAD = decodeRecord(
  { command: decodeLiteral(['GetOriginRecord']), origin: decodeString({ max: 512, pattern: /^https?:\/\/[^\s]+$/ }) },
  { maxDepth: 8 },
);

const EXPORT_QUARANTINE_PAYLOAD = decodeRecord(
  { command: decodeLiteral(['ExportQuarantine']), key: decodeString({ max: 600, pattern: /^rv/ }) },
  { maxDepth: 8 },
);

const LIST_DOCUMENTS_PAYLOAD = decodeRecord(
  { command: decodeLiteral(['ListDocuments']) },
  { maxDepth: 8 },
);

const GET_STATE_PAYLOAD = decodeRecord(
  { command: decodeLiteral(['GetState']) },
  { maxDepth: 8 },
);

/** Non-negative bounded integer field (record revisions, counts). */
function decodeFiniteRecordInt(name: string) {
  return (v: unknown, p?: string) => {
    const path = p ?? name;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > Number.MAX_SAFE_INTEGER) {
      return { ok: false as const, issues: [{ path, code: 'out-of-bounds' as const, message: `${name} must be a non-negative integer` }] };
    }
    return { ok: true as const, value: v };
  };
}

function firstIssue(issues: { path: string; message: string }[]): string {
  const i = issues[0];
  return i ? `${i.path}: ${i.message}` : 'undecodable message';
}

// ── registry ─────────────────────────────────────────────────────────────

export interface DocumentRecord {
  key: string;
  documentKey: DocumentKey;
  routeEpoch: number;
  registeredAt: number;
  run: { runId: string; startedAt: number } | null;
  /** Site origin from the BROWSER sender at registration (S5.2: record
   *  applicability and enable/disable/remove broadcast targeting). Null for
   *  non-site documents (extension pages never register as runtimes). */
  origin: string | null;
}

const registryKey = (tabId: number, frameId: number, browserDocumentId: string): string =>
  `${tabId}:${frameId}:${browserDocumentId}`;

// ── core ─────────────────────────────────────────────────────────────────

export interface BrokerDeps {
  ownExtensionId: string;
  now(): number;
  randomId(): string;
  /** Deliver a message to a tab's document runtime. Rejects when no receiver. */
  sendToTab(tabId: number, message: unknown): Promise<unknown>;
  persistRegistry(records: DocumentRecord[]): Promise<void>;
  loadRegistry(): Promise<DocumentRecord[]>;
  /** Privileged CSS delivery (plan/03 background/styles) — S2.2. */
  styles: StyleDelivery;
  /** Persistent record owner (plan/03 background/store) — S5.1. */
  store: StoreCore;
  /** Deliver a message to a tab's document runtime. Rejects when no receiver. */
  sendToTab(tabId: number, message: unknown): Promise<unknown>;
  /** Deliver to a specific frame of a tab (S5.2 broadcast targeting). */
  sendToFrame(tabId: number, frameId: number, message: unknown): Promise<unknown>;
  /** S8.3 permission display: the browser's frame tree for a tab (frame ids,
   *  parent ids and URLs). Browser-derived only — a payload can never name
   *  frame identity. Returns null when webNavigation cannot serve the tree. */
  allFrames?(tabId: number): Promise<Array<{ frameId: number; parentFrameId: number; url: string }> | null>;
  /** Reconcile pending writes at startup; surfaced for diagnostics. */
  onStoreHydrated?(result: { quarantined: number; pending: Array<{ outcome: string }>; totalBytes: number }): void;
}

export interface BrokerCore {
  /** Full vertical for one inbound message. Returns `undefined` for inbound
   *  projections (RuntimeState/RunProgress) that are not routed commands. */
  handleMessage(sender: SenderLike, raw: unknown): Promise<BrokerReply | undefined>;
  /** Re-send an already-processed record mutation to every registered
   *  document of the origin and collect per-document acks (S5.2 broadcast). */
  broadcastRecordMutation(origin: string, payload: Record<string, unknown>): Promise<Record<string, unknown>[]>;
  /** webNavigation commit/history update: advance the route epoch for every
   *  registered document in the tab and notify its runtime. When the browser
   *  reports the new documentId (commit events), registry entries for other
   *  frame-0 documents in the tab are destroyed documents — pruned. */
  routeEvent(tabId: number, frameId: number, currentDocumentId?: string): Promise<number>;
  /** Confirmed document destruction (tab closed). */
  tabClosed(tabId: number): Promise<number>;
  /** Snapshot for diagnostics/tests. */
  records(): DocumentRecord[];
  hydrated(): Promise<void>;
}

export function createBrokerCore(deps: BrokerDeps): BrokerCore {
  const registry = new Map<string, DocumentRecord>();
  let hydration: Promise<void> | null = null;

  const persist = async (): Promise<void> => {
    try {
      await deps.persistRegistry([...registry.values()]);
    } catch {
      // Registry stays authoritative in memory for this worker lifetime; a
      // restart that cannot rehydrate re-registers runtimes on pageshow.
    }
  };

  const hydrate = (): Promise<void> => {
    if (!hydration) {
      hydration = deps
        .loadRegistry()
        .then((records) => {
          for (const r of records) registry.set(r.key, r);
        })
        .catch(() => {
          /* empty registry on hydration failure — runtimes re-register */
        });
    }
    return hydration;
  };

  /** S5.2: re-send a record mutation to every registered document of the
   *  origin and collect per-document acks — missing acks stay visible
   *  (I10), never a global clean result when one frame failed. */
  const broadcastRecordMutation = async (origin: string, payload: Record<string, unknown>): Promise<Record<string, unknown>[]> => {
    const results: Record<string, unknown>[] = [];
    for (const record of registry.values()) {
      if (record.origin !== origin) continue;
      const envelope: Envelope = {
        protocolVersion: 1,
        requestId: deps.randomId(),
        kind: 'control',
        documentKey: record.documentKey,
        expectedRouteEpoch: record.routeEpoch,
        deadlineAt: deps.now() + 5000,
        payload,
      };
      try {
        const reply = await deps.sendToFrame(record.documentKey.tabId, record.documentKey.frameId, envelope);
        results.push({ tabId: record.documentKey.tabId, frameId: record.documentKey.frameId, acked: true, reply: reply as Record<string, unknown> });
      } catch (err) {
        results.push({ tabId: record.documentKey.tabId, frameId: record.documentKey.frameId, acked: false, error: (err as Error).message.slice(0, 200) });
      }
    }
    return results;
  };

  const resolveDocument = (env: Envelope): BrokerReply | { record: DocumentRecord } => {
    const dk = env.documentKey;
    if (!dk) return deny('invalid-schema', 'decode', 'page-scoped command requires a documentKey', { fieldPath: 'documentKey' });
    if (env.expectedRouteEpoch === undefined) {
      return deny('invalid-schema', 'decode', 'page-scoped command requires expectedRouteEpoch', { fieldPath: 'expectedRouteEpoch' });
    }
    const record = registry.get(registryKey(dk.tabId, dk.frameId, dk.browserDocumentId));
    if (!record) {
      // A tab id alone never authorizes: the exact document must be registered.
      return deny('unknown-target', 'reconcile', 'no registered runtime for this document', {
        recoveryAction: 'reload the target document so its runtime registers, then select it explicitly',
      });
    }
    if (record.documentKey.runtimeInstanceId !== dk.runtimeInstanceId) {
      // Late message from a disposed/replaced runtime instance (I03).
      return deny('stale-document', 'reconcile', 'the sending runtime instance is no longer the registered one', {
        recoveryAction: 'the document was re-injected; discard in-flight work for the old instance',
      });
    }
    if (env.expectedRouteEpoch !== record.routeEpoch) {
      return deny('stale-route', 'reconcile', `route epoch moved: expected ${env.expectedRouteEpoch}, current ${record.routeEpoch}`, {
        recoveryAction: 're-read document state at the current route epoch before retrying',
      });
    }
    return { record };
  };

  const handleMessage = async (sender: SenderLike, raw: unknown): Promise<BrokerReply | undefined> => {
    await hydrate();

    const role = classifySender(sender, deps.ownExtensionId);

    // Fast, decode-free filter for inbound runtime→workspace projections: the
    // broker observes them (it must return false so broadcasts stay quiet)
    // but never routes them. A subscription-kind envelope claiming a NON-
    // projection command falls through to the strict decode path, which
    // rejects the transport-kind laundering.
    if (
      typeof raw === 'object' && raw !== null &&
      (raw as Record<string, unknown>).protocolVersion === 1 &&
      (raw as Record<string, unknown>).kind === 'subscription'
    ) {
      const fastPayload = (raw as Record<string, unknown>).payload;
      const fastCommand = typeof fastPayload === 'object' && fastPayload !== null
        ? (fastPayload as Record<string, unknown>).command
        : undefined;
      if (fastCommand === 'RuntimeState' || fastCommand === 'RunProgress') return undefined;
    }

    const env = decodeEnvelope(raw, 'envelope');
    if (!env.ok) return deny('invalid-schema', 'decode', firstIssue(env.issues));
    const envelope = env.value;

    if (envelope.deadlineAt <= deps.now()) {
      return deny('denied', 'decode', 'request arrived after its deadline; it was not processed', {
        recoveryAction: 'reissue with a fresh deadline',
      });
    }

    const cmd = decodeCommand(envelope.kind, envelope.payload);
    if ('code' in cmd) return { ok: false, kind: 'error', error: cmd };
    const { command } = cmd;

    if (command === 'RuntimeState' || command === 'RunProgress') {
      // Projections are never routed commands; the broker observes silently
      // (the fast path above normally catches these first).
      return undefined;
    }

    if (!senderMayInvoke(role, command)) {
      return deny('denied', 'decode', `sender role "${role}" may not invoke ${command}`, {
        recoveryAction: 'send from the trusted context that owns this command',
      });
    }

    switch (command) {
      case 'RegisterDocument': {
        // Identity comes from the BROWSER sender only (plan/06 RegisterDocument
        // authority). The payload cannot name a tab or document.
        const tabId = sender.tab?.id;
        const frameId = sender.frameId;
        const browserDocumentId = sender.documentId;
        if (typeof tabId !== 'number' || typeof frameId !== 'number' || typeof browserDocumentId !== 'string') {
          return deny('denied', 'decode', 'registration requires browser-reported tab, frame and document identity');
        }
        const p = REGISTER_PAYLOAD(envelope.payload, 'payload');
        if (!p.ok) return deny('invalid-schema', 'decode', firstIssue(p.issues));
        const key = registryKey(tabId, frameId, browserDocumentId);
        const existing = registry.get(key);
        const sameInstance = existing !== undefined && existing.documentKey.runtimeInstanceId === p.value.runtimeInstanceId;
        const record: DocumentRecord = {
          key,
          documentKey: { tabId, frameId, browserDocumentId, runtimeInstanceId: p.value.runtimeInstanceId },
          // Route epoch survives re-handshakes (BFCache pageshow, reinjection):
          // only navigation events advance it.
          routeEpoch: existing?.routeEpoch ?? 0,
          registeredAt: deps.now(),
          run: sameInstance ? existing.run : null,
          // The site origin comes from the BROWSER sender only (plan/06 §1
          // registration authority) — a payload can never name its origin.
          origin: senderOriginOf(sender),
        };
        registry.set(key, record);
        await persist();
        // S5.2: the registration reply carries the applicable saved intent —
        // validated records only, filtered by the browser-reported origin
        // (plan/06 §1 RegisterDocument; plan/13 §1 content obtains records
        // through the broker, never storage directly).
        let applicable: Customization[] = [];
        const origin = record.origin;
        if (origin !== null) {
          try {
            const rec = await deps.store.getRecord(origin);
            applicable = rec?.customizations ?? [];
          } catch {
            applicable = []; // unreadable record stays quarantined; replay proceeds without it
          }
        }
        return { ok: true, kind: 'registered', documentKey: record.documentKey, routeEpoch: record.routeEpoch, applicable };
      }

      case 'StartRun': {
        const resolved = resolveDocument(envelope);
        if (!('record' in resolved)) return resolved;
        const record = resolved.record;
        const p = START_RUN_PAYLOAD(envelope.payload, 'payload');
        if (!p.ok) return deny('invalid-schema', 'decode', firstIssue(p.issues));
        if (record.run) {
          return deny('conflict', 'plan', 'one run owner per document: a run is already active', {
            recoveryAction: 'cancel the active run first (CancelRun) or choose another document',
          });
        }
        const runId = deps.randomId();
        record.run = { runId, startedAt: deps.now() };
        await persist();
        return { ok: true, kind: 'run-started', runId };
      }

      case 'CancelRun': {
        const resolved = resolveDocument(envelope);
        if (!('record' in resolved)) return resolved;
        const record = resolved.record;
        const cancelled = record.run !== null;
        record.run = null;
        await persist();
        return { ok: true, kind: 'run-cancelled', cancelled };
      }

      case 'ApplyBatch': {
        // One proposal is one ordered batch, relayed to the registered
        // runtime (plan/06 §1 ApplyBatch: workspace → broker → runtime).
        // The envelope is relayed unchanged; the runtime re-validates and
        // executes through its serial queue (I04 fence on both sides).
        const resolved = resolveDocument(envelope);
        if (!('record' in resolved)) return resolved;
        const p = APPLY_BATCH_PAYLOAD(envelope.payload, 'payload');
        if (!p.ok) return deny('invalid-schema', 'decode', firstIssue(p.issues));
        return relayToRuntime(deps, resolved.record.documentKey.tabId, envelope, resolved.record.documentKey.frameId);
      }

      case 'GetOperation': {
        const resolved = resolveDocument(envelope);
        if (!('record' in resolved)) return resolved;
        const record = resolved.record;
        const p = GET_OPERATION_PAYLOAD(envelope.payload, 'payload');
        if (!p.ok) return deny('invalid-schema', 'decode', firstIssue(p.issues));
        // Style-delivery receipts live in the broker ledger (T14: a lost ack
        // is reconciled through GetOperation, never by blind re-execution).
        const styleReceipt = deps.styles.receiptFor(p.value.operationId);
        if (styleReceipt) {
          const status = styleReceipt.state === 'inserted' ? 'applied-provisional'
            : styleReceipt.state === 'unknown' || styleReceipt.state === 'staging' ? 'outcome-unknown'
            : 'rolled-back';
          return {
            ok: true,
            kind: 'relayed',
            receipt: {
              ok: true,
              receipt: {
                requestId: envelope.requestId,
                operationId: p.value.operationId,
                payloadDigest: styleReceipt.payloadDigest,
                status,
                currentEpoch: { routeEpoch: record.routeEpoch, domRevision: 0, customizationRevision: 0, viewportRevision: 0 },
                ...(styleReceipt.error ? { error: { code: 'internal', phase: 'deliver', retryClass: 'retryable-same-id', message: styleReceipt.error } } : {}),
              },
            },
          };
        }
        // Relay to the registered runtime and bound the wait. The envelope is
        // forwarded unchanged: the runtime fences it against its own identity
        // (documentKey + expectedRouteEpoch) independently (I04).
        return relayToRuntime(deps, record.documentKey.tabId, envelope, record.documentKey.frameId);
      }

      case 'Observe':
      case 'Inspect':
      case 'Expand': {
        const resolved = resolveDocument(envelope);
        if (!('record' in resolved)) return resolved;
        // Per-command payload validation (bounded, kind-specific).
        if (envelope.kind !== 'observe-request') {
          return deny('invalid-schema', 'decode', `${command} requires the observe-request transport kind`);
        }
        if (command === 'Observe') {
          const p = OBSERVE_PAYLOAD(envelope.payload, 'payload');
          if (!p.ok) return deny('invalid-schema', 'decode', firstIssue(p.issues));
        } else if (command === 'Inspect') {
          const p = INSPECT_PAYLOAD(envelope.payload, 'payload');
          if (!p.ok) return deny('invalid-schema', 'decode', firstIssue(p.issues));
        } else {
          const p = EXPAND_PAYLOAD(envelope.payload, 'payload');
          if (!p.ok) return deny('invalid-schema', 'decode', firstIssue(p.issues));
        }
        // Observation executes in the registered runtime, which owns the
        // snapshot/cursor/target registry. Relay is deadline-bounded (I06).
        return relayToRuntime(deps, resolved.record.documentKey.tabId, envelope, resolved.record.documentKey.frameId);
      }

      case 'StageStyle': {
        const resolved = resolveDocument(envelope);
        if (!('record' in resolved)) return resolved;
        const p = STAGE_STYLE_PAYLOAD(envelope.payload, 'payload');
        if (!p.ok) return deny('invalid-schema', 'decode', firstIssue(p.issues));
        const order: StageOrder = {
          operationId: p.value.operationId,
          namespace: p.value.namespace,
          css: p.value.css,
          documentKey: resolved.record.documentKey,
          ...(p.value.rootId !== undefined ? { rootId: p.value.rootId } : {}),
        };
        return styleReplyToBrokerReply(await deps.styles.stage(order));
      }

      case 'RemoveStyle': {
        const resolved = resolveDocument(envelope);
        if (!('record' in resolved)) return resolved;
        const p = REMOVE_STYLE_PAYLOAD(envelope.payload, 'payload');
        if (!p.ok) return deny('invalid-schema', 'decode', firstIssue(p.issues));
        return styleReplyToBrokerReply(await deps.styles.remove(
          p.value.operationId,
          resolved.record.documentKey,
          p.value.css,
        ));
      }

      case 'CommitComposition': {
        const resolved = resolveDocument(envelope);
        if (!('record' in resolved)) return resolved;
        const p = COMMIT_PAYLOAD(envelope.payload, 'payload');
        if (!p.ok) return deny('invalid-schema', 'decode', firstIssue(p.issues));
        return styleReplyToBrokerReply(await deps.styles.commit(p.value.operationId, resolved.record.documentKey));
      }

      case 'RenewLease':
        // Owners arrive with the controller task (S6); refuse honestly
        // instead of pretending to execute.
        return deny('unsupported-capability', 'decode', `${command} has no owner yet; it arrives with a later roadmap task`);

      case 'SaveRevision': {
        const p = SAVE_REVISION_PAYLOAD(envelope.payload, 'payload');
        if (!p.ok) return deny('invalid-schema', 'decode', firstIssue(p.issues));
        // plan/04 §2: saved intent is self-contained — operations reference
        // descriptor indexes (`d<i>`), never stale session observation refs.
        const refProblem = checkDescriptorRefs(p.value.revision as unknown as { targetDescriptors: unknown[]; operations: Array<Record<string, unknown>> });
        if (refProblem) return deny('invalid-schema', 'decode', refProblem, { fieldPath: 'revision' });
        const reply = storeReply(await deps.store.save({ ...p.value, revision: p.value.revision }));
        if (reply.ok) {
          const delivery = await broadcastRecordMutation(p.value.origin, {
            command: 'SavedRevision', origin: p.value.origin, recordRevision: (reply as { recordRevision: number }).recordRevision, customization: {
              customizationId: p.value.customizationId,
              title: p.value.title,
              enabled: true,
              scope: p.value.scope,
              activeRevisionId: p.value.revision.revisionId,
              revisions: [p.value.revision],
              createdAt: deps.now(),
              updatedAt: deps.now(),
              contentSensitivity: p.value.contentSensitivity,
              grants: p.value.grants,
            },
          });
          return { ...reply, delivery } as BrokerReply;
        }
        return reply;
      }

      case 'SetEnabled': {
        const p = SET_ENABLED_PAYLOAD(envelope.payload, 'payload');
        if (!p.ok) return deny('invalid-schema', 'decode', firstIssue(p.issues));
        const reply = storeReply(await deps.store.setEnabled(p.value));
        if (reply.ok) {
          const delivery = await broadcastRecordMutation(p.value.origin, {
            command: 'SetEnabled', origin: p.value.origin, customizationId: p.value.customizationId, enabled: p.value.enabled,
          });
          return { ...reply, delivery } as BrokerReply;
        }
        return reply;
      }

      case 'RemoveCustomization': {
        const p = REMOVE_CUSTOMIZATION_PAYLOAD(envelope.payload, 'payload');
        if (!p.ok) return deny('invalid-schema', 'decode', firstIssue(p.issues));
        const reply = storeReply(await deps.store.removeCustomization(p.value));
        if (reply.ok) {
          const delivery = await broadcastRecordMutation(p.value.origin, {
            command: 'RemoveCustomization', origin: p.value.origin, customizationId: p.value.customizationId,
          });
          return { ...reply, delivery } as BrokerReply;
        }
        return reply;
      }

      case 'GetOriginRecord': {
        const p = GET_ORIGIN_RECORD_PAYLOAD(envelope.payload, 'payload');
        if (!p.ok) return deny('invalid-schema', 'decode', firstIssue(p.issues));
        // The record is served to the trusted workspace only (roles table);
        // it is plain validated JSON — structured-clone safe.
        const record = await deps.store.getRecord(p.value.origin);
        return { ok: true, kind: 'origin-record', originRecord: (record as unknown as Record<string, unknown> | null) ?? null };
      }

      case 'ExportQuarantine': {
        const p = EXPORT_QUARANTINE_PAYLOAD(envelope.payload, 'payload');
        if (!p.ok) return deny('invalid-schema', 'decode', firstIssue(p.issues));
        // Raw quarantined bytes for workspace review/export only — never
        // decoded into a runtime, never executed (plan/13 §7).
        const raw = await deps.store.exportQuarantined(p.value.key);
        if (raw === undefined) return deny('unknown-target', 'reconcile', 'no quarantined entry under that key');
        return { ok: true, kind: 'quarantine', entries: deps.store.quarantined(), raw };
      }

      case 'ListDocuments': {
        const p = LIST_DOCUMENTS_PAYLOAD(envelope.payload, 'payload');
        if (!p.ok) return deny('invalid-schema', 'decode', firstIssue(p.issues));
        // Read-only registry snapshot for the workspace's exact-target picker
        // (plan/16 §1: the user pins a document explicitly — never a tab-id
        // guess). The registry carries no page content: keys/epochs/origins
        // only, exactly what broadcasts already expose.
        // S8.3: the parent origin is tracked for permission DISPLAY only
        // (plan/12 §3) — the workspace shows embedded-frame documents as
        // "frame N of <parent origin>". It is browser-derived and never part
        // of any targeting or saved intent (no frame-index guess, I19/I26).
        const trees = new Map<number, Array<{ frameId: number; parentFrameId: number; url: string }> | null>();
        const documents: Array<{ documentKey: DocumentKey; tabId: number; frameId: number; routeEpoch: number; origin: string | null; parentOrigin: string | null; runOwner: boolean; registeredAt: number }> = [];
        for (const r of registry.values()) {
          let parentOrigin: string | null = null;
          if (r.documentKey.frameId !== 0) {
            const tabId = r.documentKey.tabId;
            if (!trees.has(tabId)) trees.set(tabId, (deps.allFrames ? await deps.allFrames(tabId) : null) ?? null);
            const tree = trees.get(tabId);
            const self = tree?.find((f) => f.frameId === r.documentKey.frameId);
            const parent = self ? tree?.find((f) => f.frameId === self.parentFrameId) : undefined;
            try {
              parentOrigin = parent?.url ? new URL(parent.url).origin : null;
            } catch {
              parentOrigin = null;
            }
          }
          documents.push({
            documentKey: r.documentKey,
            tabId: r.documentKey.tabId,
            frameId: r.documentKey.frameId,
            routeEpoch: r.routeEpoch,
            origin: r.origin,
            parentOrigin,
            runOwner: r.run !== null,
            registeredAt: r.registeredAt,
          });
        }
        return { ok: true, kind: 'documents', documents };
      }

      case 'GetState': {
        const p = GET_STATE_PAYLOAD(envelope.payload, 'payload');
        if (!p.ok) return deny('invalid-schema', 'decode', firstIssue(p.issues));
        // Relayed to the exact registered runtime (same fence as every
        // page-scoped command): the runtime answers with its live projection.
        // An unreachable runtime stays an explicit error — never a fabricated
        // clean state (I10).
        const resolved = resolveDocument(envelope);
        if (!('record' in resolved)) return resolved;
        return relayToRuntime(deps, resolved.record.documentKey.tabId, envelope, resolved.record.documentKey.frameId);
      }

      default:
        return deny('invalid-schema', 'decode', `unknown command "${command}"`);
    }
  };

  const routeEvent = async (tabId: number, frameId: number, currentDocumentId?: string): Promise<number> => {
    await hydrate();
    // A commit replaces the frame's document: every other frame-0 entry in
    // this tab is a destroyed document (its runtime died with the navigation).
    if (currentDocumentId !== undefined) {
      for (const [key, record] of registry) {
        if (
          record.documentKey.tabId === tabId && record.documentKey.frameId === 0 &&
          record.documentKey.browserDocumentId !== currentDocumentId
        ) {
          registry.delete(key);
          // Delivered sheets die with the document; record terminal receipts.
          deps.styles.documentDestroyed(record.documentKey);
        }
      }
    }
    let notified = 0;
    for (const record of registry.values()) {
      if (record.documentKey.tabId !== tabId) continue;
      if (frameId === 0 && record.documentKey.frameId !== 0) continue;
      if (currentDocumentId !== undefined && record.documentKey.browserDocumentId !== currentDocumentId) continue;
      record.routeEpoch += 1;
      record.run = null; // navigation invalidates the active run (plan/05 §3)
      notified += 1;
      // Fire-and-forget: the runtime also detects navigation locally; a lost
      // notification is recovered by the epoch fence on the next command.
      deps.sendToTab(tabId, {
        protocolVersion: 1,
        requestId: deps.randomId(),
        kind: 'subscription',
        documentKey: record.documentKey,
        deadlineAt: deps.now() + 5000,
        payload: { command: 'RouteChanged', routeEpoch: record.routeEpoch },
      }).catch(() => undefined);
    }
    if (notified) await persist();
    return notified;
  };

  const tabClosed = async (tabId: number): Promise<number> => {
    await hydrate();
    let removed = 0;
    for (const [key, record] of registry) {
      if (record.documentKey.tabId === tabId) {
        registry.delete(key);
        deps.styles.documentDestroyed(record.documentKey);
        removed += 1;
      }
    }
    if (removed) await persist();
    return removed;
  };

  return {
    handleMessage,
    routeEvent,
    tabClosed,
    records: () => [...registry.values()],
    hydrated: hydrate,
    broadcastRecordMutation,
  };
}

function stylesFor(deps: BrokerDeps): StyleDelivery {
  return deps.styles;
}

/** Site origin from the BROWSER sender only (plan/06 §1). Extension pages
 *  have no site origin; http(s) tab senders do. */
function senderOriginOf(sender: SenderLike): string | null {
  const candidate = sender.origin ?? sender.tab?.url ?? sender.url ?? '';
  if (!/^https?:\/\/[^/]+/.test(candidate)) return null;
  try {
    return new URL(candidate).origin;
  } catch {
    return null;
  }
}

/** plan/04 §2: a saved revision is self-contained. Its operations reference
 *  descriptor indexes (`d<i>` where i names targetDescriptors[i]) — stale
 *  session observation refs are rejected at save time. */
function checkDescriptorRefs(revision: { targetDescriptors: unknown[]; operations: Array<Record<string, unknown>> }): string | null {
  const allowed = new Set(revision.targetDescriptors.map((_, i) => `d${i}`));
  const localIds = new Set<string>();
  const visit = (t: unknown): string | null => {
    if (t === null || typeof t !== 'object') return null;
    const targetRef = (t as Record<string, unknown>).targetRef;
    const localRef = (t as Record<string, unknown>).localRef;
    if (typeof localRef === 'string') localIds.add(localRef);
    if (typeof targetRef === 'string' && !allowed.has(targetRef)) {
      return `saved operations must reference descriptor refs d0..d${revision.targetDescriptors.length - 1}, got "${targetRef}"`;
    }
    return null;
  };
  for (const op of revision.operations) {
    const kind = op.kind;
    const problem =
      kind === 'style'
        ? (op.rules as Array<{ target?: unknown }>).map((r) => visit(r.target)).find(Boolean) ?? null
        : kind === 'relocate'
          ? visit(op.target) ?? visit(op.destination)
          : visit(op.target);
    if (problem) return problem;
  }
  void localIds;
  return null;
}

/** Map a store outcome to a broker reply: explicit saved/conflict/unsaved —
 *  a quota failure or unknown write never masquerades as saved (I21). */
function storeReply(outcome: StoreOutcome<{ recordRevision: number; origin?: string; mutationId?: string }>): BrokerReply {
  if (outcome.ok) {
    return {
      ok: true,
      kind: outcome.value.mutationId !== undefined ? 'saved' : 'record-revision',
      ...(outcome.value.origin !== undefined ? { origin: outcome.value.origin } : {}),
      recordRevision: outcome.value.recordRevision,
      ...(outcome.value.mutationId !== undefined ? { mutationId: outcome.value.mutationId } : {}),
    } as BrokerReply;
  }
  return {
    ok: false,
    kind: 'error',
    error: errorRecord(outcome.code, outcome.code === 'conflict' ? 'reconcile' : 'persist', outcome.message, {
      ...(outcome.fieldPath !== undefined ? { fieldPath: outcome.fieldPath } : {}),
      ...(outcome.code === 'conflict'
        ? { recoveryAction: 'refresh the origin record (GetOriginRecord), merge disjoint customizations if wanted, then re-save with the current recordRevision' }
        : outcome.code === 'quota-exceeded'
          ? { recoveryAction: 'the applied work stays applied-unsaved on this document; export or delete saved data before retrying' }
          : {}),
    }),
    ...(outcome.conflict !== undefined ? { conflict: outcome.conflict as unknown as Record<string, unknown> } : {}),
  };
}

/** Deadline-bounded relay of a page-scoped command to the registered
 *  runtime. The envelope is forwarded unchanged: the runtime fences it
 *  against its own identity (documentKey + expectedRouteEpoch) (I04). A
 *  timeout is unknown, never "not applied" (I06). */
function relayToRuntime(
  deps: BrokerDeps,
  tabId: number,
  envelope: Envelope,
  frameId = 0,
): Promise<BrokerReply> {
  const budgetMs = Math.max(0, Math.min(envelope.deadlineAt - deps.now(), 5000));
  let raced = false;
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => {
      raced = true;
      reject(new Error('relay deadline'));
    }, budgetMs);
  });
  return (async () => {
    try {
      // S8.3: the relay targets the registered document's EXACT frame — a
      // frame document's commands reach that frame's runtime (plan/12 §3).
      // frameId 0 uses the EXACT top-frame context too: a bare sendToTab
      // broadcasts to every frame, and another frame's synchronous fence
      // rejection would race ahead of the addressed runtime's queued
      // acceptance (the first answer would be a rejection — T06).
      const deliver = deps.sendToFrame(tabId, frameId, envelope);
      const reply = await Promise.race([deliver, timeout]);
      if (reply !== null && typeof reply === 'object' && 'ok' in (reply as Record<string, unknown>)) {
        return { ok: true, kind: 'relayed', receipt: reply as Record<string, unknown> };
      }
      return deny('internal', 'reconcile', 'runtime reply was not a well-formed response');
    } catch (err) {
      if (raced) {
        return deny('timeout-unknown', 'deliver', 'the runtime did not answer within the relay budget', {
          recoveryAction: 'retry the same request id, or re-read document state',
        });
      }
      return deny('stale-document', 'reconcile', `runtime unreachable: ${(err as Error).message}`, {
        recoveryAction: 'reload the target document so its runtime re-registers',
      });
    }
  })();
}

function styleReplyToBrokerReply(reply: Awaited<ReturnType<StyleDelivery['stage']>>): BrokerReply {
  if (reply.ok) {
    if (reply.kind === 'committed') {
      return { ok: true, kind: 'relayed', receipt: { ok: true, receipt: { operationId: reply.operationId, status: 'accepted', promotedNamespace: reply.promotedNamespace } } };
    }
    return { ok: true, kind: 'relayed', receipt: { ok: true, receipt: { operationId: reply.operationId, status: reply.receiptStatus, deliveryState: reply.state } } };
  }
  return {
    ok: false,
    kind: 'error',
    error: errorRecord(
      reply.code as ErrorCode,
      'deliver',
      reply.message,
      reply.recoveryAction ? { recoveryAction: reply.recoveryAction } : undefined,
    ),
  };
}

// ── chrome wiring (the only chrome-dependent part) ─────────────────────

const REGISTRY_KEY = 'rv2_documentRegistry';

/** Structural mirror of the browser's MessageSender for the trust layer. */
function senderLikeOf(sender: chrome.runtime.MessageSender): SenderLike {
  return {
    id: sender.id,
    url: sender.url,
    origin: sender.origin,
    tab: sender.tab ? { id: sender.tab.id, url: sender.tab.url } : undefined,
    frameId: sender.frameId,
    documentId: sender.documentId,
  };
}

function isV2EnvelopeShape(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null) return false;
  const r = raw as Record<string, unknown>;
  // The legacy dispatcher keys on `action`; v2 envelopes key on protocolVersion.
  return r.protocolVersion === 1 && typeof r.requestId === 'string' && typeof r.payload === 'object';
}

/**
 * Install the v2 broker into the service worker: the message listener is
 * registered SYNCHRONOUSLY (MV3 event registration requirement); handlers
 * await registry hydration inside. Navigation/tab events advance route
 * epochs and release destroyed documents.
 */
export function installBroker(): void {
  const deps: BrokerDeps = {
    ownExtensionId: chrome.runtime.id,
    now: () => Date.now(),
    randomId: () => crypto.randomUUID(),
    sendToTab: (tabId, message) =>
      new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, message as Record<string, unknown>, (reply) => {
          const err = chrome.runtime.lastError;
          if (err) reject(new Error(err.message ?? 'no receiver'));
          else resolve(reply as unknown);
        });
      }),
    sendToFrame: (tabId, frameId, message) =>
      new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, message as Record<string, unknown>, { frameId }, (reply) => {
          const err = chrome.runtime.lastError;
          if (err) reject(new Error(err.message ?? 'no receiver'));
          else resolve(reply as unknown);
        });
      }),
    // S8.3 permission display: the browser's frame tree (never a payload).
    allFrames: async (tabId) => {
      try {
        const frames = await chrome.webNavigation.getAllFrames({ tabId });
        return (frames ?? []).map((f: { frameId: number; parentFrameId: number; url: string }) => ({ frameId: f.frameId, parentFrameId: f.parentFrameId, url: f.url }));
      } catch {
        return null; // the tree is unavailable — the display omits the parent
      }
    },
    persistRegistry: async (records) => {
      await chrome.storage.session.set({ [REGISTRY_KEY]: records });
    },
    loadRegistry: async () => {
      const stored = await chrome.storage.session.get(REGISTRY_KEY);
      return (stored[REGISTRY_KEY] as DocumentRecord[] | undefined) ?? [];
    },
    styles: createChromeStyleDelivery(),
    store: createStore({
      local: chrome.storage.local,
      session: chrome.storage.session,
      now: () => Date.now(),
      byteSize: (s) => new TextEncoder().encode(s).length,
    }),
  };
  const core = createBrokerCore(deps);
  // Startup reconciliation: exact-clean uncertain/staging intents before any
  // new delivery (plan/03: recover uncertain intent by exact cleanup), then
  // reconcile pending record writes and quarantine legacy entries (T12/T26).
  void core.hydrated().then(async () => {
    await stylesFor(deps).reconcile();
    const hydration = await deps.store.hydrate();
    deps.onStoreHydrated?.({
      quarantined: hydration.quarantined.length,
      pending: hydration.pending,
      totalBytes: hydration.totalBytes,
    });
  });

  chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
    if (!isV2EnvelopeShape(raw)) return false; // legacy dispatcher owns these
    core
      .handleMessage(senderLikeOf(sender), raw)
      .then((reply) => {
        if (reply !== undefined) sendResponse(reply);
      })
      .catch((err: unknown) => {
        // A handler crash after a privileged call is outcome-unknown, never
        // a silent not-applied (I06).
        try {
          sendResponse({
            ok: false,
            kind: 'error',
            error: errorRecord('internal', 'decode', `broker handler failed: ${(err as Error).message}`),
          });
        } catch {
          /* response channel already gone */
        }
      });
    return true; // async response
  });

  // Route invalidation: full navigations (onCommitted) and same-document
  // history updates (onHistoryStateUpdated). Top frame only for now (P1).
  // The browser-reported documentId identifies the NEW document: destroyed
  // sibling entries are pruned so late messages deterministically miss (I04).
  chrome.webNavigation?.onCommitted.addListener((details) => {
    if (details.frameId !== 0) return;
    void core.routeEvent(details.tabId, details.frameId, (details as { documentId?: string }).documentId);
  });
  chrome.webNavigation?.onHistoryStateUpdated.addListener((details) => {
    if (details.frameId !== 0) return;
    void core.routeEvent(details.tabId, details.frameId, (details as { documentId?: string }).documentId);
  });

  // Confirmed document destruction releases registry entries.
  chrome.tabs?.onRemoved.addListener((tabId) => {
    void core.tabClosed(tabId);
  });
}

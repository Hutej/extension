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
  decodeRecord,
  decodeString,
  decodeLiteral,
  decodeArray,
  optional,
  LIMITS,
  type DocumentKey,
  type Envelope,
  type ErrorRecord,
  type ErrorCode,
  type ErrorPhase,
  type SenderLike,
} from '../contracts.ts';

// ── replies ──────────────────────────────────────────────────────────────

export type BrokerReply =
  | { ok: true; kind: 'registered'; documentKey: DocumentKey; routeEpoch: number }
  | { ok: true; kind: 'run-started'; runId: string }
  | { ok: true; kind: 'run-cancelled'; cancelled: boolean }
  | { ok: true; kind: 'relayed'; receipt: Record<string, unknown> }
  | { ok: false; kind: 'error'; error: ErrorRecord };

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
  'run-command': ['StartRun', 'CancelRun'],
  'observe-request': [], // planner→runtime evidence queries arrive with S3
  'style-delivery': [], // StageStyle/RemoveStyle/CommitComposition arrive with S2.2
  control: ['RegisterDocument', 'GetOperation', 'RenewLease', 'SaveRevision', 'SetEnabled', 'RemoveCustomization'],
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

const GET_OPERATION_PAYLOAD = decodeRecord(
  { command: decodeLiteral(['GetOperation']), operationId: ID },
  { maxDepth: 8 },
);

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
}

export interface BrokerCore {
  /** Full vertical for one inbound message. Returns `undefined` for inbound
   *  projections (RuntimeState/RunProgress) that are not routed commands. */
  handleMessage(sender: SenderLike, raw: unknown): Promise<BrokerReply | undefined>;
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
        };
        registry.set(key, record);
        await persist();
        return { ok: true, kind: 'registered', documentKey: record.documentKey, routeEpoch: record.routeEpoch };
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

      case 'GetOperation': {
        const resolved = resolveDocument(envelope);
        if (!('record' in resolved)) return resolved;
        const record = resolved.record;
        const p = GET_OPERATION_PAYLOAD(envelope.payload, 'payload');
        if (!p.ok) return deny('invalid-schema', 'decode', firstIssue(p.issues));
        // Relay to the registered runtime and bound the wait. The envelope is
        // forwarded unchanged: the runtime fences it against its own identity
        // (documentKey + expectedRouteEpoch) independently (I04).
        const budgetMs = Math.max(0, Math.min(envelope.deadlineAt - deps.now(), 5000));
        let raced = false;
        const timeout = new Promise<never>((_, reject) => {
          setTimeout(() => {
            raced = true;
            reject(new Error('relay deadline'));
          }, budgetMs);
        });
        try {
          const reply = await Promise.race([deps.sendToTab(record.documentKey.tabId, envelope), timeout]);
          if (reply !== null && typeof reply === 'object' && 'ok' in (reply as Record<string, unknown>)) {
            return { ok: true, kind: 'relayed', receipt: reply as Record<string, unknown> };
          }
          return deny('internal', 'reconcile', 'runtime reply was not a well-formed response');
        } catch (err) {
          if (raced) {
            // I06: timeout is unknown, never "not applied".
            return deny('timeout-unknown', 'deliver', 'the runtime did not answer within the relay budget', {
              recoveryAction: 'retry the same request id, or re-read document state',
            });
          }
          return deny('stale-document', 'reconcile', `runtime unreachable: ${(err as Error).message}`, {
            recoveryAction: 'reload the target document so its runtime re-registers',
          });
        }
      }

      case 'RenewLease':
      case 'SaveRevision':
      case 'SetEnabled':
      case 'RemoveCustomization':
        // Owners arrive with the store/controller tasks (S2.3/S4); refuse
        // honestly instead of pretending to execute.
        return deny('unsupported-capability', 'decode', `${command} has no owner yet; it arrives with a later roadmap task`);

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
    persistRegistry: async (records) => {
      await chrome.storage.session.set({ [REGISTRY_KEY]: records });
    },
    loadRegistry: async () => {
      const stored = await chrome.storage.session.get(REGISTRY_KEY);
      return (stored[REGISTRY_KEY] as DocumentRecord[] | undefined) ?? [];
    },
  };
  const core = createBrokerCore(deps);

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

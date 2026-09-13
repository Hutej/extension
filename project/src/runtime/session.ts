/**
 * runtime/session — per-document runtime bootstrap, the serial mutation queue
 * and cancellation (plan/03 `runtime/session` + `runtime/queue`, consolidated
 * per plan/02 §3).
 *
 * One instance per document (I03): the boot detects an already-installed
 * instance in this isolated world (extension update/reinjection, double
 * injection), disposes it, and takes over — listeners are never duplicated.
 * Registration identity is derived from the BROWSER sender on the broker
 * side; the runtime adopts the verified DocumentKey from the handshake reply
 * and fences every subsequent command against it (I04).
 *
 * Route continuity (plan/12 §2) without history monkey patching: the runtime
 * observes popstate/hashchange/pageshow, re-reads location.href at command
 * entry, and adopts the broker's authoritative epoch from RouteChanged. The
 * isolated-world history patch is the legacy path's backup detector and is
 * NOT used here.
 *
 * The queue is the plan/06 §2 "small Promise chain with priority lanes" —
 * one task at a time, revoke/cancel/dispose > rollback > apply/undo >
 * reconcile > observation, bounded pending tasks, coalesced reconcile work.
 * S2.1 executes no mutations: the queue is proven by tests and composed here
 * so S2.2's transaction slots into an already-verified serializer.
 *
 * The pure core (queue + session fence) is exported for unit tests; all
 * chrome.* wiring lives in `bootRuntimeSession()`, called from the content
 * entrypoint.
 */

import {
  classifySender,
  senderMayInvoke,
  decodeEnvelope,
  decodeOperationBatch,
  decodeRecord,
  decodeString,
  decodeLiteral,
  decodeArray,
  decodeFiniteNumber,
  decodeBoolean,
  decodeCustomization,
  optional,
  type DocumentKey,
  type Envelope,
  type ErrorRecord,
  type SenderLike,
} from '../contracts.ts';
import { createObservationEngine, type ObservationEngine } from './observe.ts';
import { createTargetRegistry } from './targets.ts';
import { createTokenScope } from './styles.ts';
import { createContentCreator } from './content.ts';
import { createTransaction, type BatchReceipt, type StyleClient, type StyleOutcome } from './transaction.ts';
import { createReplay, type ReplayCore, type ReplayEntry } from './replay.ts';
import type { Customization } from '../contracts.ts';
import { createVerifier, probeCanonicalAllOf, probeCanonicalOf } from './verify.ts';
import { createBehavior } from './behavior.ts';
import { createProjection } from './projection.ts';

// ── serial queue (plan/06 §2 boundary 1) ─────────────────────────────────

/** Lower number = runs first. revoke/cancel/dispose > rollback > apply/undo >
 *  dynamic reconcile > optional observation (plan/06 §2). */
export const QUEUE_PRIORITY = { revoke: 0, rollback: 1, apply: 2, reconcile: 3, observation: 4 } as const;
export type QueuePriority = (typeof QUEUE_PRIORITY)[keyof typeof QUEUE_PRIORITY];

export const MAX_PENDING_TASKS = 32;

export class QueueCancelledError extends Error {
  constructor(reason: string) {
    super(`cancelled: ${reason}`);
    this.name = 'QueueCancelledError';
  }
}

export class QueueBusyError extends Error {
  constructor() {
    super(`more than ${MAX_PENDING_TASKS} pending tasks; refusing new work`);
    this.name = 'QueueBusyError';
  }
}

export interface TaskQueue {
  submit<T>(
    priority: QueuePriority,
    task: (signal: { cancelled: boolean }) => Promise<T> | T,
    opts?: { coalesceKey?: string },
  ): Promise<T>;
  /** Arm cancellation: queued work at priority > rollback is rejected
   *  deterministically; revoke/rollback lanes still run (cleanup must
   *  proceed). In-flight tasks observe `signal.cancelled` at yield points —
   *  cancellation takes effect at the next safe point (plan/06 §6). */
  cancelPending(reason?: string): void;
  /** Disarm cancellation for a fresh run generation. */
  newGeneration(): void;
  cancelled(): boolean;
  pendingCount(): number;
}

interface QueueEntry {
  priority: QueuePriority;
  task: (signal: { cancelled: boolean }) => Promise<unknown> | unknown;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

export function createTaskQueue(): TaskQueue {
  const lanes: QueueEntry[][] = [[], [], [], [], []];
  let running = false;
  let cancelArmed = false;
  let cancelReason = 'run cancelled';
  const coalescing = new Map<string, Promise<unknown>>();
  const signal = { cancelled: false };

  const pump = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      for (;;) {
        // Cancellation overtakes at the task boundary: once armed, every
        // queued task above the rollback lane is rejected before it starts.
        if (cancelArmed) {
          for (let p = QUEUE_PRIORITY.apply; p <= QUEUE_PRIORITY.observation; p++) {
            const lane = lanes[p];
            while (lane.length) lane.shift()!.reject(new QueueCancelledError(cancelReason));
          }
        }
        const laneIndex = lanes.findIndex((l) => l.length > 0);
        if (laneIndex === -1) return;
        const entry = lanes[laneIndex].shift()!;
        try {
          entry.resolve(await entry.task(signal));
        } catch (err) {
          entry.reject(err);
        }
      }
    } finally {
      running = false;
    }
  };

  return {
    submit<T>(
    priority: QueuePriority,
    task: (signal: { cancelled: boolean }) => Promise<T> | T,
    opts?: { coalesceKey?: string },
  ): Promise<T> {
      // Coalesced reconcile: a pending task with the same key IS the work —
      // returning its promise deduplicates instead of queueing a second pass.
      if (opts?.coalesceKey !== undefined) {
        const existing = coalescing.get(opts.coalesceKey);
        if (existing) return existing as Promise<T>;
      }
      if (cancelArmed && priority > QUEUE_PRIORITY.rollback) {
        return Promise.reject(new QueueCancelledError(cancelReason));
      }
      const pending = lanes.reduce((n, l) => n + l.length, 0);
      if (pending >= MAX_PENDING_TASKS) return Promise.reject(new QueueBusyError());

      const entry: QueueEntry = {} as QueueEntry;
      const promise = new Promise<T>((resolve, reject) => {
        entry.resolve = resolve as (v: unknown) => void;
        entry.reject = reject;
      });
      entry.priority = priority;
      entry.task = task;
      lanes[priority].push(entry);
      const coalesceKey = opts?.coalesceKey;
      if (coalesceKey !== undefined) {
        coalescing.set(coalesceKey, promise);
        // Cleanup must not surface a rejection through the detached chain.
        void promise
          .catch(() => undefined)
          .finally(() => {
            if (coalescing.get(coalesceKey) === promise) coalescing.delete(coalesceKey);
          });
      }
      void pump();
      return promise;
    },

    cancelPending(reason) {
      cancelReason = reason ?? 'run cancelled';
      signal.cancelled = true;
      cancelArmed = true;
      void pump(); // drain the rejected lanes at the first safe point
    },

    newGeneration() {
      cancelArmed = false;
      signal.cancelled = false;
    },

    cancelled: () => cancelArmed,
    pendingCount: () => lanes.reduce((n, l) => n + l.length, 0),
  };
}

// ── runtime session core (pure, unit-testable) ───────────────────────────

export type RuntimeLifecycle = 'booting' | 'ready' | 'suspended' | 'disposing' | 'disposed';

export interface SessionCore {
  lifecycle(): RuntimeLifecycle;
  documentKey(): DocumentKey | null;
  routeEpoch(): number;
  /** Adopt the verified handshake result. */
  registered(documentKey: DocumentKey, routeEpoch: number): void;
  /** Broker-authoritative route change (RouteChanged). Monotonic. */
  adoptRouteEpoch(routeEpoch: number): void;
  /** Local same-document navigation detected (popstate/hashchange/pageshow or
   *  URL inequality at command entry): bump BEFORE any awaited work (plan/05 §3). */
  noteLocalNavigation(): number;
  /** I04 fence for a command arriving at this runtime. Returns an ErrorRecord
   *  when the command must be rejected, or null when it may proceed. */
  fence(env: Envelope): ErrorRecord | null;
  suspend(): void;
  resume(): void;
  dispose(): void;
}

export const sessionError = (
  code: ErrorRecord['code'],
  message: string,
  recoveryAction?: string,
): ErrorRecord => ({
  code,
  phase: 'reconcile',
  retryClass: code === 'timeout-unknown' ? 'retryable-same-id' : 'non-retryable',
  message,
  ...(recoveryAction ? { recoveryAction } : {}),
});

export function createSessionCore(): SessionCore {
  let lifecycle: RuntimeLifecycle = 'booting';
  let documentKey: DocumentKey | null = null;
  let routeEpoch = 0;

  return {
    lifecycle: () => lifecycle,
    documentKey: () => documentKey,
    routeEpoch: () => routeEpoch,
    registered(dk, epoch) {
      documentKey = dk;
      // Adopt the broker-verified epoch; never regress behind what we have.
      routeEpoch = Math.max(routeEpoch, epoch);
      if (lifecycle === 'booting' || lifecycle === 'suspended') lifecycle = 'ready';
    },
    adoptRouteEpoch(epoch) {
      if (epoch > routeEpoch) routeEpoch = epoch;
    },
    noteLocalNavigation() {
      routeEpoch += 1;
      return routeEpoch;
    },
    fence(env) {
      if (lifecycle === 'disposed' || lifecycle === 'disposing') {
        return sessionError('denied', 'the runtime for this document is disposed', 'reload the document to register a fresh runtime');
      }
      const dk = env.documentKey;
      if (!dk) return sessionError('invalid-schema', 'command carries no documentKey');
      if (!documentKey) return sessionError('stale-document', 'this runtime has no verified registration');
      if (dk.runtimeInstanceId !== documentKey.runtimeInstanceId || dk.tabId !== documentKey.tabId) {
        // A late message addressed to a previous instance (or a forged key):
        // deterministic rejection, never execution (I03/I04).
        return sessionError('stale-document', 'command is addressed to a different runtime instance', 'discard in-flight work for the replaced instance');
      }
      if (env.expectedRouteEpoch !== undefined && env.expectedRouteEpoch !== routeEpoch) {
        return sessionError('stale-route', `route epoch moved: command expects ${env.expectedRouteEpoch}, runtime is at ${routeEpoch}`, 're-observe at the current route epoch');
      }
      return null;
    },
    suspend() {
      if (lifecycle === 'ready' || lifecycle === 'booting') lifecycle = 'suspended';
    },
    resume() {
      if (lifecycle === 'suspended') lifecycle = 'ready';
    },
    dispose() {
      if (lifecycle === 'disposed') return;
      lifecycle = 'disposed';
      documentKey = null;
    },
  };
}

// ── chrome wiring (the only chrome-dependent part) ───────────────────────

const HANDSHAKE_RETRIES = 5;
const HANDSHAKE_RETRY_MS = 200;
const RELAY_BUDGET_MS = 5000;

/** Runtime-inbound command kinds: receipt lookup (S2.1), bounded observation
 *  (S3.1), one-batch application (S4.2 — the runtime owns the transaction),
 *  record relays (S5.2) and the S6.2 workspace state pull. */
const RUNTIME_INBOUND_COMMANDS = new Set(['GetOperation', 'Observe', 'Inspect', 'Expand', 'ApplyBatch', 'SavedRevision', 'SetEnabled', 'RemoveCustomization', 'GetState']);

function randomInstanceId(): string {
  // crypto.randomUUID needs a secure context; getRandomValues does not.
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function envelopeOf(kind: Envelope['kind'], payload: Record<string, unknown>, documentKey?: DocumentKey): Envelope {
  return {
    protocolVersion: 1,
    requestId: randomInstanceId(),
    kind,
    ...(documentKey ? { documentKey } : {}),
    deadlineAt: Date.now() + RELAY_BUDGET_MS,
    payload,
  };
}

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

const ROUTE_CHANGED_PAYLOAD = decodeRecord(
  {
    command: decodeString({ max: 64 }),
    routeEpoch: decodeFiniteNumber({ integer: true, min: 0 }),
  },
  { maxDepth: 8 },
);

/** Monotonic projection sequence (plan/06 §4: increasing owner sequence; a
 *  stale/missed push is ignored, a gap pulls via GetState). */
let stateSeq = 0;

/** Broadcast the bounded session projection to subscribed workspaces
 *  (plan/06 RuntimeState: owner → subscribed workspace). Fire-and-forget. */
function broadcastState(core: SessionCore, customizations: ReplayEntry[] = []): void {
  if (core.lifecycle() === 'disposed') return;
  const seq = ++stateSeq;
  void chrome.runtime
    .sendMessage(envelopeOf('subscription', { command: 'RuntimeState', state: core.lifecycle(), routeEpoch: core.routeEpoch(), seq, customizations }, core.documentKey() ?? undefined))
    .catch(() => undefined); // no subscriber — fine
}

/** GetState reply — the CURRENT projection plus the next sequence number, so
 *  a workspace that reopens can resynchronize without waiting for a change. */
function stateReply(core: SessionCore, customizations: ReplayEntry[]): Record<string, unknown> {
  return {
    ok: true,
    kind: 'state',
    state: core.lifecycle(),
    routeEpoch: core.routeEpoch(),
    seq: ++stateSeq,
    customizations,
  };
}

/**
 * Boot one v2 runtime session for this document. Detects and disposes an
 * already-installed instance (extension update/reinjection), performs the
 * RegisterDocument handshake, and installs the runtime-side listener.
 * Resolves once the session is ready or disposed; never throws into the
 * host entrypoint.
 */
export async function bootRuntimeSession(): Promise<{ dispose(): void; core: SessionCore; queue: TaskQueue } | null> {
  // I03 — one instance per document: the previous instance (extension update,
  // reinjection) is disposed directly; we share the isolated world.
  globalThis.__revueonRuntimeSession?.dispose();

  const runtimeInstanceId = randomInstanceId();
  const core = createSessionCore();
  const queue = createTaskQueue();
  let disposed = false;

  // S3.1: the runtime owns observation — bounded snapshots, cursors and the
  // target registry live here for this document's lifetime. The registry is
  // SHARED: ApplyBatch (S4.2) resolves the exact nodes Observe registered.
  const targets = createTargetRegistry();
  const observation: ObservationEngine = createObservationEngine(
    {
      doc: document,
      epoch: () => core.routeEpoch(),
      now: () => Date.now(),
      randomId: randomInstanceId,
    },
    targets,
  );

  // Persisted non-secret installation id (plan/08 §3 namespace component).
  const installationId = (): string => {
    try {
      const KEY = 'rv2-installation-id';
      const existing = localStorage.getItem(KEY);
      if (existing) return existing.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
      const fresh = randomInstanceId().replace(/-/g, '').slice(0, 24);
      localStorage.setItem(KEY, fresh);
      return fresh;
    } catch {
      return randomInstanceId().replace(/-/g, '').slice(0, 24); // storage unavailable — per-session id
    }
  };

  // Runtime→broker style delivery client (plan/06 §1: StageStyle/
  // RemoveStyle/CommitComposition are runtime-sender commands).
  const sendStyleCommand = async (payload: Record<string, unknown>): Promise<StyleOutcome> => {
    const envelope: Envelope = {
      protocolVersion: 1,
      requestId: randomInstanceId(),
      kind: 'style-delivery',
      ...(core.documentKey() ? { documentKey: core.documentKey()! } : {}),
      expectedRouteEpoch: core.routeEpoch(),
      deadlineAt: Date.now() + 15_000,
      payload,
    };
    const reply = (await chrome.runtime.sendMessage(envelope)) as Record<string, unknown> | null;
    const receipt = (reply && typeof reply === 'object' ? (reply as { receipt?: Record<string, unknown> }).receipt : undefined) as Record<string, unknown> | undefined;
    const inner = (receipt && typeof receipt === 'object' ? (receipt as { receipt?: Record<string, unknown> }).receipt : undefined) as Record<string, unknown> | undefined;
    const error = (reply && typeof reply === 'object' ? (reply as { error?: Record<string, unknown> }).error : undefined) as Record<string, unknown> | undefined;
    if (error) return { ok: false, code: String(error.code ?? 'internal'), message: String(error.message ?? 'style delivery refused') };
    const status = String(inner?.status ?? '');
    const state = String(inner?.deliveryState ?? '');
    if (status === 'applied-provisional') return { ok: true, state: state === 'unknown' || state === 'staging' ? 'unknown' : 'inserted' };
    if (status === 'outcome-unknown') return { ok: true, state: 'unknown' };
    if (status === 'rolled-back') return { ok: true, state: 'removed' };
    if (status === 'accepted') return { ok: true, state: 'committed' };
    return { ok: false, code: 'internal', message: `unexpected style-delivery reply: ${JSON.stringify(reply).slice(0, 200)}` };
  };
  const styleClient: StyleClient = {
    stage: (order) => sendStyleCommand({ command: 'StageStyle', operationId: order.operationId, namespace: order.namespace, css: order.css, ...(order.rootId !== undefined ? { rootId: order.rootId } : {}) }),
    remove: (operationId, css) => sendStyleCommand(css !== undefined ? { command: 'RemoveStyle', operationId, css } : { command: 'RemoveStyle', operationId }),
    commit: (operationId) => sendStyleCommand({ command: 'CommitComposition', operationId }),
  };

  // S7.1: the per-document keyboard-binding executor (plan/03 runtime/
  // behavior) — one keydown listener per session, exact registry entries.
  const behavior = createBehavior({ doc: document });

  // S4.3: the mandatory structured verifier — acceptance is impossible
  // without its report (I11). Read-only measurements; no window resize (I22).
  const verifier = createVerifier({
    doc: document,
    now: () => Date.now(),
    computedOf: (el, pseudo) => window.getComputedStyle(el, pseudo ?? undefined),
    canonicalOf: probeCanonicalOf(document),
    canonicalAllOf: probeCanonicalAllOf(document),
    rectOf: (el) => el.getBoundingClientRect(),
    // One bounded recheck after the settle: default CSS transitions run
    // 200-400ms — the recheck must land after they finish (owner direction:
    // a mid-transition read never reverts approved work).
    recheckWait: () => new Promise((resolve) => setTimeout(resolve, 450)),
    isBound: (normalized: string) => behavior.isBound(normalized),
    hasRule: (customizationId: string) => behavior.hasRule(customizationId),
  });

  // S4.2: the one-batch transaction — the runtime's only mutation path (I03:
  // the legacy dispatcher remains the only OTHER mutation owner until the
  // plan/19 cutover disables it).
  const tokens = createTokenScope(document);
  const transaction = createTransaction({
    doc: document,
    targets,
    tokens,
    content: createContentCreator(document),
    routeEpoch: () => core.routeEpoch(),
    documentKey: () => core.documentKey(),
    now: () => Date.now(),
    randomId: randomInstanceId,
    installationId,
    styleClient,
    behavior,
    projection: (spec, container) => createProjection({ doc: document }, spec, container),
    verify: verifier,
    settle: () =>
      new Promise<void>((resolve) => {
        let done = false;
        const finish = (): void => {
          if (!done) {
            done = true;
            resolve();
          }
        };
        requestAnimationFrame(() => requestAnimationFrame(finish));
        setTimeout(finish, 250); // bounded even when rAF never fires
      }),
  });

  // S5.2: route-aware replay + same-document reconciliation of saved intent
  // (plan/13 §4/§5) — the SAME transaction path as an initial apply (I14).
  const replay: ReplayCore = createReplay({
    doc: document,
    targets,
    transaction,
    href: () => location.href,
    now: () => Date.now(),
    randomId: randomInstanceId,
    onStatesChanged: (entries) => broadcastState(core, entries),
  });

  const INSPECT_PAYLOAD = decodeRecord(
    { command: decodeLiteral(['Inspect']), targetRef: decodeString({ max: 64, pattern: /^[A-Za-z0-9._-]+$/ }), fields: optional(decodeArray(decodeString({ max: 32 }), 16)) },
    { maxDepth: 8 },
  );
  const EXPAND_PAYLOAD = decodeRecord(
    { command: decodeLiteral(['Expand']), cursor: decodeString({ max: 256, pattern: /^[A-Za-z0-9._:-]+$/ }) },
    { maxDepth: 8 },
  );

  const ID_FIELD = decodeString({ max: 128, pattern: /^[A-Za-z0-9._:-]+$/ });
  const APPLY_BATCH_PAYLOAD = decodeRecord(
    {
      command: decodeLiteral(['ApplyBatch']),
      batch: decodeRecord(
        {
          batchId: ID_FIELD,
          customizationId: ID_FIELD,
          revisionId: ID_FIELD,
          operations: (ov: unknown, opath = 'operations') => decodeOperationBatch(ov, opath),
        },
        { maxDepth: 32 },
      ),
    },
    { maxDepth: 32 },
  );

  const register = async (): Promise<boolean> => {
    for (let attempt = 0; attempt < HANDSHAKE_RETRIES; attempt++) {
      try {
        const reply = await chrome.runtime.sendMessage(
          envelopeOf('control', { command: 'RegisterDocument', runtimeInstanceId }),
        );
        if (
          reply !== null && typeof reply === 'object' &&
          (reply as Record<string, unknown>).ok === true &&
          (reply as Record<string, unknown>).kind === 'registered'
        ) {
          const r = reply as { documentKey: DocumentKey; routeEpoch: number; applicable?: Customization[] };
          core.registered(r.documentKey, r.routeEpoch);
          // S5.2: the broker-verified applicable records replay through the
          // serial queue at reconcile priority (boot is never a mutation).
          if (r.applicable && r.applicable.length > 0) {
            void queue.submit(QUEUE_PRIORITY.reconcile, () => replay.setApplicable(r.applicable!));
          }
          return true;
        }
        return false; // deterministic broker refusal — do not spin
      } catch {
        // Service worker may still be starting — bounded retry.
        await new Promise((resolve) => setTimeout(resolve, HANDSHAKE_RETRY_MS));
      }
    }
    return false;
  };

  const domListeners: Array<[EventTarget, string, (ev: Event) => void]> = [];
  const addDomListener = (target: EventTarget, type: string, fn: (ev: Event) => void): void => {
    target.addEventListener(type, fn);
    domListeners.push([target, type, fn]);
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    queue.cancelPending('runtime disposing');
    replay.dispose();
    behavior.dispose();
    core.dispose();
    for (const [target, type, fn] of domListeners) target.removeEventListener(type, fn);
    domListeners.length = 0;
    chrome.runtime.onMessage.removeListener(runtimeListener);
    if (globalThis.__revueonRuntimeSession?.instanceId === runtimeInstanceId) {
      delete globalThis.__revueonRuntimeSession;
    }
  };

  // Local route detection WITHOUT history monkey patching (plan/12 §2).
  let lastUrl = location.href;
  const onLocalNavigation = (): void => {
    if (disposed) return;
    if (lastUrl !== location.href) {
      lastUrl = location.href;
      core.noteLocalNavigation();
      // Local route change (popstate/hashchange): re-evaluate record scopes
      // without waiting for the broker's RouteChanged (plan/06 §5).
      void queue.submit(QUEUE_PRIORITY.reconcile, () => replay.onRouteChanged());
    }
  };

  // Inbound: broker-forwarded commands and route events. Commands must come
  // from a trusted extension context, satisfy the per-command allowlist, and
  // pass the document fence (I04).
  const runtimeListener = (
    raw: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (reply: unknown) => void,
  ): boolean => {
    if (disposed) return false;
    const env = decodeEnvelope(raw, 'envelope');
    if (!env.ok) return false; // legacy-path or garbage message: not ours
    const envelope = env.value;
    const role = classifySender(senderLikeOf(sender), chrome.runtime.id);

    if (envelope.kind === 'subscription') {
      // RouteChanged: broker-authoritative route epoch. Accept only from
      // trusted extension contexts (broker or workspace role) — never from a
      // page-world content script, which shares this extension id — and only
      // for OUR document (a stale event for a destroyed sibling entry must
      // not move this runtime's epoch).
      if (role !== 'broker' && role !== 'workspace') return false;
      const p = ROUTE_CHANGED_PAYLOAD(envelope.payload, 'payload');
      const own = core.documentKey();
      if (
        p.ok && p.value.command === 'RouteChanged' && own &&
        envelope.documentKey &&
        envelope.documentKey.runtimeInstanceId === own.runtimeInstanceId &&
        envelope.documentKey.browserDocumentId === own.browserDocumentId
      ) {
        core.adoptRouteEpoch(p.value.routeEpoch);
        // S5.2: the authoritative route epoch moved — re-evaluate scope
        // (out-of-scope tokens revoked before new activation, plan/13 §4).
        void queue.submit(QUEUE_PRIORITY.reconcile, () => replay.onRouteChanged());
      }
      return false;
    }

    // URL equality at command entry (plan/06 §5) — the epoch fence before
    // any await, no isolated-world history patching involved.
    onLocalNavigation();

    const payloadCommand = (envelope.payload as Record<string, unknown>).command;
    const command = typeof payloadCommand === 'string' ? payloadCommand : '';
    // A broker-role sender is a trusted relay: the broker verified the
    // originator's role against the same allowlist before forwarding
    // (plan/06 §1 hops). Direct workspace senders still pass the allowlist.
    if (!RUNTIME_INBOUND_COMMANDS.has(command)) return false;
    if (role !== 'broker' && !senderMayInvoke(role, command)) return false;

    const fence = core.fence(envelope);
    if (fence) {
      sendResponse({ ok: false, kind: 'error', error: fence });
      return false;
    }
    if (command === 'GetOperation') {
      // S4.2: the runtime retains operation receipts — a lost Apply reply is
      // reconciled by receipt lookup, never by re-execution (plan/06 §4).
      const operationId = (envelope.payload as Record<string, unknown>).operationId;
      const retained = typeof operationId === 'string' ? transaction.receiptFor(operationId) : undefined;
      if (retained) {
        sendResponse({ ok: true, kind: 'receipt', receipt: retained });
        return false;
      }
      sendResponse({
        ok: false,
        kind: 'error',
        error: {
          code: 'unknown-target',
          phase: 'reconcile',
          retryClass: 'user-decision',
          message: `no receipt retained for operation "${typeof operationId === 'string' ? operationId : ''}"`,
          recoveryAction: 'obtain fresh state and a new reviewed operation',
        },
      });
      return false;
    }

    // S6.2: the workspace's state pull (close/reopen resynchronization) — a
    // read-only projection, answered from live replay state (never invented).
    if (command === 'GetState') {
      sendResponse(stateReply(core, replay.states()));
      return false;
    }

    // S5.2: broker-relayed record continuity — a trusted workspace record
    // write was confirmed by the broker, which now targets THIS document.
    // The runtime reconciles locally and answers with its own result (I10:
    // missing acks stay visible broker-side).
    if (command === 'SavedRevision' || command === 'SetEnabled' || command === 'RemoveCustomization') {
      const p = decodeRecord(
        {
          command: decodeLiteral(['SavedRevision', 'SetEnabled', 'RemoveCustomization']),
          origin: optional(decodeString({ max: 512 })),
          // SavedRevision carries the whole validated customization instead.
          customizationId: optional(ID_FIELD),
          enabled: optional(decodeBoolean),
          recordRevision: optional(decodeFiniteNumber({ integer: true, min: 0 })),
          customization: optional((v: unknown, path = 'customization') => decodeCustomization(v, path)),
        },
        { maxDepth: 8 },
      )(envelope.payload, 'payload');
      if (!p.ok) {
        sendResponse({ ok: false, kind: 'error', error: sessionError('invalid-schema', 'malformed record-relay payload') });
        return false;
      }
      void queue
        .submit(QUEUE_PRIORITY.reconcile, async () => {
          if (p.value.command === 'SavedRevision') {
            const customization = (envelope.payload as { customization?: Customization }).customization;
            if (customization) await replay.setApplicable([customization]);
            else throw new Error('SavedRevision relay carries no customization');
          } else if (p.value.command === 'SetEnabled') {
            if (p.value.customizationId === undefined) throw new Error('SetEnabled relay carries no customizationId');
            await replay.setEnabled(p.value.customizationId, p.value.enabled === true);
          } else {
            if (p.value.customizationId === undefined) throw new Error('RemoveCustomization relay carries no customizationId');
            await replay.removeCustomization(p.value.customizationId);
          }
          broadcastState(core, replay.states());
          return { ok: true, kind: 'record-ack', customizationId: p.value.customizationId };
        })
        .then(
          (ack) => {
            try { sendResponse(ack); } catch { /* channel gone */ }
          },
          (err: unknown) => {
            try {
              sendResponse({ ok: false, kind: 'error', error: sessionError('internal', `record reconcile failed: ${err instanceof Error ? err.message : String(err)}`) });
            } catch { /* channel gone */ }
          },
        );
      return true; // async response
    }

    // S4.2: one proposal is one ordered batch — it runs through the serial
    // queue at apply priority, fenced and cancellable at every await.
    if (command === 'ApplyBatch') {
      const p = APPLY_BATCH_PAYLOAD(envelope.payload, 'payload');
      if (!p.ok) {
        sendResponse({ ok: false, kind: 'error', error: sessionError('invalid-schema', `malformed ApplyBatch payload: ${p.issues[0].path}: ${p.issues[0].message}`) });
        return false;
      }
      const batch = p.value.batch;
      void queue
        .submit(QUEUE_PRIORITY.apply, (signal) => transaction.applyBatch(batch, signal))
        .then(
          (receipt: BatchReceipt) => {
            try { sendResponse({ ok: true, kind: 'receipt', receipt }); } catch { /* channel gone */ }
          },
          (err: unknown) => {
            try {
              sendResponse({ ok: false, kind: 'error', error: sessionError('internal', `apply failed: ${err instanceof Error ? err.message : String(err)}`) });
            } catch { /* channel gone */ }
          },
        );
      return true; // async response
    }

    // S3.1 observation commands run through the serial queue at observation
    // priority (plan/06 §2): bounded, cooperative, cancellable.
    if (command === 'Observe' || command === 'Inspect' || command === 'Expand') {
      void queue
        .submit(QUEUE_PRIORITY.observation, () => {
          if (disposed) throw new Error('runtime disposed');
          if (command === 'Observe') {
            return { ok: true, kind: 'snapshot', snapshot: observation.collectSnapshot() };
          }
          if (command === 'Expand') {
            const p = EXPAND_PAYLOAD(envelope.payload, 'payload');
            if (!p.ok) return { ok: false, kind: 'error', error: sessionError('invalid-schema', 'malformed expand payload') };
            const r = observation.expand(p.value.cursor);
            return r.ok
              ? { ok: true, kind: 'snapshot', snapshot: r.snapshot }
              : { ok: false, kind: 'error', error: sessionError(r.reason === 'stale' ? 'stale-route' : 'unknown-target', r.detail, 're-observe for a fresh cursor') };
          }
          const p = INSPECT_PAYLOAD(envelope.payload, 'payload');
          if (!p.ok) return { ok: false, kind: 'error', error: sessionError('invalid-schema', 'malformed inspect payload') };
          const r = observation.inspect(p.value.targetRef, p.value.fields ?? []);
          return r.ok
            ? { ok: true, kind: 'facts', facts: r.facts }
            : { ok: false, kind: 'error', error: sessionError(r.reason === 'stale' ? 'stale-target' : 'unknown-target', r.detail, 're-observe to refresh target refs') };
        })
        .then(
          (reply) => {
            try { sendResponse(reply); } catch { /* channel gone */ }
          },
          (err: unknown) => {
            try {
              sendResponse({ ok: false, kind: 'error', error: sessionError('internal', `observation failed: ${err instanceof Error ? err.message : String(err)}`) });
            } catch { /* channel gone */ }
          },
        );
      return true; // async response
    }
    return false;
  };

  chrome.runtime.onMessage.addListener(runtimeListener);

  addDomListener(window, 'popstate', () => onLocalNavigation());
  addDomListener(window, 'hashchange', () => onLocalNavigation());
  addDomListener(window, 'pageshow', (ev) => {
    if (disposed) return;
    if ((ev as PageTransitionEvent).persisted) {
      // BFCache restore: renew the handshake, then resume (plan/12 §2).
      core.suspend();
      void register().then(() => {
        if (!disposed) {
          lastUrl = location.href;
          core.resume();
          broadcastState(core);
        }
      });
    } else {
      onLocalNavigation();
    }
  });

  // Register the global marker only after the listener is installed so a
  // concurrent boot always finds a disposable instance.
  globalThis.__revueonRuntimeSession = { instanceId: runtimeInstanceId, dispose };

  const registered = await register();
  if (!registered) {
    // The broker refused (or stayed unreachable): this instance must not sit
    // as a half-open listener. Dispose deterministically and report.
    dispose();
    return null;
  }
  broadcastState(core);
  return { dispose, core, queue };
}

declare global {
  var __revueonRuntimeSession: { instanceId: string; dispose(): void } | undefined;
}

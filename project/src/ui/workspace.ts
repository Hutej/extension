/**
 * ui/workspace — the shared visible workspace: target pinning, run control,
 * truthful status projection, settings/consent/opt-out, question/approval UX,
 * customization management and the diagnostic panel
 * (plan/03 §6 ui rows consolidated per plan/02 §3; plan/16 §1/§2/§4;
 * plan/05 §1–2 state ownership).
 *
 * One workspace UI hosts the run: a side panel on supported Chromium and the
 * SAME page as an extension tab elsewhere (plan/00 §"Visible extension
 * workspace"). Closing it cancels unfinished planning (`pagehide` → stop);
 * accepted customizations keep living in the per-document runtime and in the
 * saved OriginRecord — reopening resynchronizes through ListDocuments +
 * GetState, never by guessing.
 *
 * Structure of this file:
 *   - pure status projection (plan/16 §2 wording table — exhaustive typed
 *     states, no false success, no HTML string rendering);
 *   - pure save prep: `buildSavedRevision` maps a proposal's observation
 *     targetRefs to self-contained `d<i>` descriptor references (plan/04 §2:
 *     saved intent is self-contained; a ref with no observed evidence cannot
 *     be saved honestly);
 *   - `createWorkspaceCore(deps)` — the stateful owner: typed state machine,
 *     broker messaging via Envelope DTOs, controller wiring, record
 *     mutations (save/enable/remove/undo with fresh expected revisions);
 *   - `mountWorkspace(root, deps)` — native DOM only (text nodes, buttons,
 *     labels, radios), aria-live polite status, always-available Stop.
 *
 * Layer table (plan/02 §1): imports contracts and the planning controller;
 * never DOM executors, never storage internals — persistence goes through
 * broker commands, the platform seam injects storage for settings only.
 */

import {
  decodeArray,
  decodeBoolean,
  decodeDisclosureAck,
  decodeFiniteNumber,
  decodeObject,
  decodeProviderProfile,
  decodeRecord,
  decodeString,
  evaluateProviderConsent,
  LIMITS,
  optional,
  PROVIDER_DISCLOSURE_VERSION,
  type DisclosureAck,
  type DocumentKey,
  type Envelope,
  type OriginRecord,
  type PageSnapshot,
  type PlannerQuestion,
  type Proposal,
  type ProviderProfile,
  type Region,
  type Revision,
  type RouteScope,
} from '../contracts.ts';
import {
  createPlanningController,
  type PlanningController,
  type PlanningControllerDeps,
  type PlanningRun,
  type RunCounters,
} from '../planning/controller.ts';
import { createDiagnosticRing, type DiagnosticRing } from '../diagnostics.ts';
import { CONSEQUENTIAL_BIND_ACTIONS } from '../runtime/behavior.ts';

// ── settings storage (trusted-context; chrome.storage.local seam) ─────────

export const WORKSPACE_SETTINGS_KEY = 'rv2_workspaceSettings';
export const WORKSPACE_SETTINGS_VERSION = 1;

export interface WorkspaceSettings {
  settingsVersion: 1;
  profiles: ProviderProfile[];
  /** profileId → credential. Trusted-context storage only (plan/17 §4);
   *  never rendered back, never exported, never sent to content contexts. */
  credentials: Record<string, string>;
  activeProfileId: string | null;
  consentAcks: DisclosureAck[];
  /** The user's pinned target tab — persisted so a reopened workspace shows
   *  its record again, but always REVALIDATED against live registrations
   *  (plan/05 §1): a pin whose document no longer registers is dropped,
   *  never guessed onto another tab. */
  pinnedTabId: number | null;
  /** The real model opt-out (AC-07): off means no planning fetch happens at
   *  all; deterministic saved customizations stay manageable. */
  aiEnabled: boolean;
}

export const DEFAULT_SETTINGS: WorkspaceSettings = {
  settingsVersion: 1,
  profiles: [],
  credentials: {},
  activeProfileId: null,
  consentAcks: [],
  pinnedTabId: null,
  aiEnabled: true,
};

const decodeCredentialMap = (v: unknown, path = 'credentials') => {
  const r = decodeObject(v, path);
  if (!r.ok) return r;
  const out: Record<string, string> = {};
  let count = 0;
  for (const [k, val] of Object.entries(r.value)) {
    if (count >= 16) break;
    const key = decodeString({ max: 128, pattern: /^[A-Za-z0-9._:-]+$/ })(k, `${path}.${k}`);
    if (!key.ok) continue;
    const value = decodeString({ max: 4096 })(val, `${path}.${k}`);
    if (!value.ok) continue;
    out[key.value] = value.value;
    count += 1;
  }
  return { ok: true as const, value: out };
};

export const decodeWorkspaceSettings = (
  v: unknown,
  path = 'settings',
): { ok: true; value: WorkspaceSettings } | { ok: false; issues: Array<{ path: string; message: string }> } => {
  const r = decodeRecord(
    {
      settingsVersion: decodeFiniteNumber({ integer: true, min: WORKSPACE_SETTINGS_VERSION, max: WORKSPACE_SETTINGS_VERSION }),
      profiles: decodeArray(decodeProviderProfile, 16),
      credentials: decodeCredentialMap,
      activeProfileId: optional(decodeString({ max: 128, pattern: /^[A-Za-z0-9._:-]+$/ })),
      consentAcks: decodeArray(decodeDisclosureAck, 64),
      pinnedTabId: optional((v: unknown, p = 'pinnedTabId') => {
        if (v === null) return { ok: true as const, value: null };
        const n = decodeFiniteNumber({ integer: true, min: 0, max: 2 ** 31 })(v, p);
        return n.ok ? { ok: true as const, value: n.value } : n;
      }),
      aiEnabled: decodeBoolean,
    },
    { maxDepth: 12 },
  )(v, path);
  return r as { ok: true; value: WorkspaceSettings } | { ok: false; issues: Array<{ path: string; message: string }> };
};

// ── typed run phases and the truthful status projection (plan/16 §2) ──────

export type WorkspacePhase =
  | 'idle'
  | 'starting'
  | 'observing'
  | 'planning'
  | 'awaiting-question'
  | 'awaiting-approval'
  | 'applying'
  | 'saving'
  | 'complete'
  | 'applied-unsaved'
  | 'conflicted'
  | 'stopped'
  | 'failed'
  | 'busy';

export type StatusTone = 'info' | 'ok' | 'warn' | 'error';

export interface StatusView {
  text: string;
  tone: StatusTone;
}

/** Exact plan/16 §2 wording. `detail` is bounded public text (an error code,
 *  a recovery action) — never raw page content. */
export function statusFor(
  phase: WorkspacePhase,
  ctx: { profileLabel?: string; elapsedMs?: number; detail?: string } = {},
): StatusView {
  const elapsed =
    ctx.elapsedMs !== undefined ? ` (${(ctx.elapsedMs / 1000).toFixed(0)}s so far)` : '';
  const detail = ctx.detail !== undefined ? ` ${ctx.detail}` : '';
  switch (phase) {
    case 'idle':
      return { text: 'Choose the exact target page, type a goal, then Start.', tone: 'info' };
    case 'starting':
      return { text: `Starting…${detail}`, tone: 'info' };
    case 'observing':
      return { text: `Reading page…${elapsed}`, tone: 'info' };
    case 'planning':
      return { text: `Waiting for ${ctx.profileLabel ?? 'the model'}…${elapsed}. Stop stays available.`, tone: 'info' };
    case 'awaiting-question':
      return { text: 'The planner needs your answer before it continues. Nothing is applied yet.', tone: 'warn' };
    case 'awaiting-approval':
      return { text: 'Review the proposed changes below. Nothing is applied until you choose Apply.', tone: 'warn' };
    case 'applying':
      return { text: `Previewing; checking changes…${elapsed}`, tone: 'info' };
    case 'saving':
      return { text: 'Applying worked; saving your intent…', tone: 'info' };
    case 'complete':
      return { text: `Applied and saved.${detail}`, tone: 'ok' };
    case 'applied-unsaved':
      return { text: `Applied in this tab; saving failed.${detail}`, tone: 'error' };
    case 'conflicted':
      return { text: `Applied, but some cleanup could not be confirmed.${detail}`, tone: 'warn' };
    case 'stopped':
      return { text: 'Stopped; previous accepted changes kept.', tone: 'info' };
    case 'failed':
      return { text: detail || 'The request could not be completed.', tone: 'error' };
    case 'busy':
      return { text: `A run is already active on this page.${detail}`, tone: 'warn' };
  }
}

/** Blocked reasons are explicit pre-run refusals with zero calls (I19/AC-07). */
export type BlockReason =
  | { reason: 'no-target'; text: string }
  | { reason: 'no-goal'; text: string }
  | { reason: 'ai-off'; text: string }
  | { reason: 'no-profile'; text: string }
  | { reason: 'no-consent'; text: string };

// ── pure save prep: proposal → self-contained revision (plan/04 §2) ───────

/** All targetRefs referenced by the batch's operations. */
export function refsOfProposal(proposal: Proposal): string[] {
  const refs = new Set<string>();
  const note = (t: { targetRef?: string; localRef?: string } | undefined): void => {
    if (t?.targetRef !== undefined) refs.add(t.targetRef);
  };
  for (const op of proposal.operations) {
    switch (op.kind) {
      case 'style':
        for (const rule of op.rules) note(rule.target);
        break;
      case 'relocate':
        note(op.target);
        note(op.destination);
        break;
      case 'localRule':
        note(op.target);
        if (op.targetRef !== undefined) refs.add(op.targetRef);
        for (const predicate of op.predicates ?? []) {
          if (predicate.type === 'member-of') refs.add(predicate.targetRef);
        }
        break;
      case 'bindKey':
        note(op.target);
        break;
      default:
        note(op.target);
    }
  }
  return [...refs];
}

/** Deep-clone the proposal operations with every targetRef rewritten to its
 *  descriptor index. Local refs are untouched (they name owned nodes). */
function rewriteRefs(proposal: Proposal, refToIndex: Map<string, number>): Proposal['operations'] {
  const map = (t: { targetRef?: string; localRef?: string }): { targetRef?: string; localRef?: string } =>
    t.targetRef !== undefined && refToIndex.has(t.targetRef)
      ? { ...t, targetRef: `d${refToIndex.get(t.targetRef)}` }
      : t;
  return proposal.operations.map((op) => {
    switch (op.kind) {
      case 'style':
        return { ...op, rules: op.rules.map((r) => ({ ...r, target: map(r.target) })) };
      case 'relocate':
        return { ...op, target: map(op.target), destination: map(op.destination) };
      case 'localRule':
        return {
          ...op,
          target: map(op.target),
          ...(op.targetRef !== undefined ? { targetRef: map({ targetRef: op.targetRef }).targetRef } : {}),
          ...(op.predicates !== undefined
            ? {
                predicates: op.predicates.map((p) =>
                  p.type === 'member-of' ? { ...p, targetRef: map({ targetRef: p.targetRef }).targetRef! } : p,
                ),
              }
            : {}),
        };
      case 'bindKey':
        return op.target ? { ...op, target: map(op.target) } : op;
      default:
        return { ...op, target: map(op.target) };
    }
  }) as Proposal['operations'];
}

export interface SavedRevisionInput {
  proposal: Proposal;
  /** Observed regions for every referenced targetRef, accumulated across the
   *  run's observations (the runtime resolves live refs; the descriptor is
   *  the durable evidence-based projection of that observation). */
  evidence: Map<string, Region>;
  origin: string;
  revisionId: string;
  savedAt: number;
  profile?: { profileId: string; modelId: string };
}

export type SavedRevisionResult =
  | { ok: true; revision: Revision }
  | { ok: false; error: string };

/** Build the self-contained saved revision: one TargetDescriptor per distinct
 *  referenced ref, anchors derived from the OBSERVED region semantics
 *  (tag, declared role, accessible-name approximation). A ref with no
 *  observed evidence cannot be saved — an honest error, never a guessed
 *  selector (plan/04 §2; the broker's save-time check enforces d<i> anyway). */
export function buildSavedRevision(input: SavedRevisionInput): SavedRevisionResult {
  const refs = refsOfProposal(input.proposal);
  const refToIndex = new Map<string, number>();
  const descriptors: Revision['targetDescriptors'] = [];
  // S7.2: a rule's instance target addresses a PATTERN (new matching
  // instances are picked up by reconciliation), so its descriptor is a
  // bounded future-set instead of a single observed node.
  const ruleInstanceRefs = new Set<string>();
  for (const op of input.proposal.operations) {
    if (op.kind === 'localRule' && op.target.targetRef !== undefined) ruleInstanceRefs.add(op.target.targetRef);
  }
  for (const ref of refs) {
    const region = input.evidence.get(ref);
    if (region === undefined) {
      return { ok: false, error: `target "${ref}" has no observed evidence to save; re-run and try again (the applied work stays in this tab)` };
    }
    // Shadow-root targets are not yet saveable: rootPath hops would need
    // shadow-host selectors the observation layer does not disclose for
    // regions. Honest refusal instead of a light-DOM guess (I26).
    if (region.rootRef !== 'document') {
      return { ok: false, error: `target "${ref}" is inside a shadow root; saving shadow-root targets is not supported yet` };
    }
    const anchor: Revision['targetDescriptors'][number]['anchor'] = {
      tag: region.semantics.tag,
      ...(region.semantics.role !== undefined && region.semantics.roleSource === 'declared'
        ? { role: region.semantics.role }
        : {}),
      ...(region.semantics.nameApprox !== undefined
        ? { accessibleLabel: region.semantics.nameApprox.slice(0, 300) }
        : {}),
    };
    if (Object.keys(anchor).length === 0) {
      return { ok: false, error: `target "${ref}" has no stable anchor evidence (tag unknown); it cannot be saved` };
    }
    const isRuleInstance = ruleInstanceRefs.has(ref);
    refToIndex.set(ref, descriptors.length);
    descriptors.push({
      descriptorVersion: 1,
      rootPath: [],
      selection: isRuleInstance ? 'set' : 'single',
      anchor,
      relation: 'self',
      matchBounds: isRuleInstance ? { min: 1, max: 64 } : { min: 1, max: 1 },
      routeScopeRef: input.origin,
      continuityPolicy: isRuleInstance ? 'future-set' : 'stable-single',
    });
  }
  const operations = rewriteRefs(input.proposal, refToIndex);
  return {
    ok: true,
    revision: {
      revisionId: input.revisionId,
      capabilityVersion: 1,
      targetDescriptors: descriptors,
      operations,
      savedAt: input.savedAt,
      source: 'user-planned',
      ...(input.profile !== undefined ? { providerSummary: input.profile } : {}),
    },
  };
}

/** Human-readable scope for the customization list (never a promise of
 *  "every page"). */
export function scopeText(scope: RouteScope): string {
  switch (scope.mode) {
    case 'exactPath':
      return `this exact path (${scope.path})`;
    case 'pathPrefix':
      return `pages under ${scope.path}`;
    case 'origin':
      return `all pages on this site`;
  }
}

/** Live state wording (plan/16 §2; enabled is saved intent, applied is
 *  measured live — never interchangeable, I22-adjacent truth rule). */
export function liveStateText(live: string | undefined, detail: string | undefined, enabled: boolean): string {
  if (live === undefined) return enabled ? 'enabled; live state unknown in this view' : 'disabled';
  switch (live) {
    case 'applied':
      return 'applied on the open page';
    case 'waiting':
      return 'enabled; target not present in this view';
    case 'suspended':
      return `suspended${detail ? `: ${detail}` : ' (target ambiguous or the site changed)'}`;
    case 'out-of-scope':
      return 'enabled; this page is outside its saved scope';
    case 'paused':
      return `paused${detail ? `: ${detail}` : ' after repeated conflicts — explicit action needed'}`;
    case 'disabled':
      return 'disabled on the open page';
    case 'conflicted':
      return `some cleanup could not be confirmed${detail ? `: ${detail}` : ''}`;
    default:
      return `live state: ${live}`;
  }
}

// ── workspace deps (platform seams; injected for tests) ───────────────────

export interface WorkspaceTabInfo {
  id: number;
  url?: string;
  title?: string;
}

export interface WorkspaceDeps {
  now(): number;
  randomId(): string;
  /** chrome.runtime.sendMessage — to the broker. */
  sendToBroker(raw: unknown): Promise<unknown>;
  /** chrome.runtime.onMessage — subscription feed (RuntimeState pushes). */
  onMessage(handler: (raw: unknown) => void): () => void;
  /** chrome.tabs.query — titles/urls for the target picker display. */
  listTabs(): Promise<WorkspaceTabInfo[]>;
  loadSettings(): Promise<unknown>;
  saveSettings(settings: WorkspaceSettings): Promise<void>;
  /** Controller factory override (unit tests inject a fake). */
  createController?: (deps: PlanningControllerDeps) => PlanningController;
  /** Diagnostic ring override (unit tests). */
  ring?: DiagnosticRing;
}

// ── internal state ────────────────────────────────────────────────────────

export interface DocumentInfo {
  documentKey: DocumentKey;
  tabId: number;
  frameId: number;
  routeEpoch: number;
  origin: string | null;
  runOwner: boolean;
  title?: string;
  url?: string;
}

export interface LiveDocState {
  lifecycle: string;
  routeEpoch: number;
  seq: number;
  customizations: Array<{ customizationId: string; title: string; revisionId: string; state: string; detail?: string }>;
}

export interface WorkspaceState {
  phase: WorkspacePhase;
  blocked: BlockReason | null;
  documents: DocumentInfo[];
  pinnedDocument: DocumentInfo | null;
  live: Record<string, LiveDocState>;
  run: {
    runId: string | null;
    goal: string;
    startedAt: number | null;
    counters: RunCounters | null;
  } | null;
  pendingQuestion: { questionId: string; question: PlannerQuestion } | null;
  pendingProposal: Proposal | null;
  pendingSave: { proposal: Proposal; customizationId: string; revisionId: string; scope: RouteScope; origin: string } | null;
  lastSaveConflict: string | null;
  record: OriginRecord | null;
  recordError: string | null;
  /** Bounded public detail for the current phase (failure reasons, scope) —
   *  rendered through statusFor, never a hidden channel. */
  statusDetail: string | null;
  settings: WorkspaceSettings;
  diagnostics: string;
}

const QUESTION_EXPIRY_MS = 5 * 60 * 1000; // plan/11 §5: the human wait expires

// ── workspace core ────────────────────────────────────────────────────────

export interface WorkspaceCore {
  state(): WorkspaceState;
  subscribe(listener: (state: WorkspaceState) => void): () => void;
  init(): Promise<void>;
  refreshDocuments(): Promise<void>;
  setPinnedTab(tabId: number | null): void;
  start(goal: string): Promise<void>;
  stop(): Promise<void>;
  answerQuestion(answer: string): Promise<void>;
  approve(scope: RouteScope): Promise<void>;
  discardProposal(): void;
  retrySave(): Promise<void>;
  refreshRecord(): Promise<void>;
  setEnabled(customizationId: string, enabled: boolean): Promise<void>;
  removeCustomization(customizationId: string): Promise<void>;
  undoLatestRevision(customizationId: string): Promise<void>;
  saveSettings(settings: WorkspaceSettings): Promise<void>;
  acknowledgeConsent(): Promise<void>;
  activeProfile(): ProviderProfile | null;
  dispose(): void;
}

export function createWorkspaceCore(deps: WorkspaceDeps): WorkspaceCore {
  const ring: DiagnosticRing = deps.ring ?? createDiagnosticRing({ now: deps.now });
  let settings: WorkspaceSettings = DEFAULT_SETTINGS;
  let phase: WorkspacePhase = 'idle';
  let blocked: BlockReason | null = null;
  let documents: DocumentInfo[] = [];
  let pinnedTabId: number | null = null;
  let live: Record<string, LiveDocState> = {};
  let run: WorkspaceState['run'] = null;
  let pendingQuestion: WorkspaceState['pendingQuestion'] = null;
  let pendingProposal: Proposal | null = null;
  let pendingSave: WorkspaceState['pendingSave'] = null;
  let lastSaveConflict: string | null = null;
  let record: OriginRecord | null = null;
  let recordError: string | null = null;
  let statusDetail: string | null = null;
  const listeners = new Set<(s: WorkspaceState) => void>();
  let questionTimer: ReturnType<typeof setTimeout> | null = null;
  let abort: AbortController | null = null;
  let planningRun: PlanningRun | null = null;
  /** Evidence accumulated across this run's observations (descriptor source). */
  let evidence = new Map<string, Region>();

  const emit = (p: WorkspacePhase, detail?: string): void => {
    phase = p;
    statusDetail = detail !== undefined ? detail : null;
    ring.add({ context: 'workspace', phase: p, resultCode: 'ok', ...(detail !== undefined ? { detail } : {}) });
    publish();
  };

  const publish = (): void => {
    const state: WorkspaceState = {
      phase,
      blocked,
      documents,
      pinnedDocument: pinnedDocumentOf(),
      live,
      run,
      pendingQuestion,
      pendingProposal,
      pendingSave,
      lastSaveConflict,
      record,
      recordError,
      statusDetail,
      settings,
      diagnostics: ring.summary(),
    };
    for (const l of listeners) l(state);
  };

  const pinnedDocumentOf = (): DocumentInfo | null =>
    documents.find((d) => (pinnedTabId !== null ? d.tabId === pinnedTabId : false)) ?? null;

  const docKeyString = (dk: DocumentKey): string => `${dk.tabId}:${dk.frameId}:${dk.browserDocumentId}`;

  const currentEpoch = (doc: DocumentInfo): number =>
    live[docKeyString(doc.documentKey)]?.routeEpoch ?? doc.routeEpoch;

  const envelope = (kind: Envelope['kind'], payload: Record<string, unknown>, documentKey?: DocumentKey, expectedRouteEpoch?: number): Envelope => ({
    protocolVersion: 1,
    requestId: deps.randomId(),
    kind,
    ...(documentKey !== undefined ? { documentKey } : {}),
    ...(expectedRouteEpoch !== undefined ? { expectedRouteEpoch } : {}),
    deadlineAt: deps.now() + 15_000,
    payload,
  });

  const send = async (env: Envelope): Promise<Record<string, unknown>> => {
    const reply = (await deps.sendToBroker(env)) as Record<string, unknown> | null;
    if (reply === null || typeof reply !== 'object') {
      throw new Error('the broker did not answer; the service worker may have just started — retry');
    }
    return reply;
  };

  /** Compact id segment: replay staged operation ids are
   *  `<batchId>:d<docId>:g<gen>:css`, so workspace-generated ids must stay
   *  SHORT — a `cust-<uuid>` prefix pushed the composed id past the 128-char
   *  bound and suspended every saved customization on replay (caught by the
   *  S6.2 browser E2E). 12 hex chars keep ids unique enough for this scale. */
  const shortId = (): string => deps.randomId().replace(/-/g, '').slice(0, 12);
  const newCustomizationId = (): string => `cust-${shortId()}`;
  const newRevisionId = (): string => `rev-${shortId()}`;
  const newBatchId = (): string => `batch-${shortId()}`;
  const newMutationId = (): string => `mut-${shortId()}`;

  const errorText = (reply: Record<string, unknown>): string => {
    const error = reply.error as { message?: string; code?: string; recoveryAction?: string } | undefined;
    if (!error) return 'unknown error reply';
    return [error.message ?? error.code, error.recoveryAction ? `(${error.recoveryAction})` : ''].filter(Boolean).join(' ');
  };

  const activeProfile = (): ProviderProfile | null => {
    const id = settings.activeProfileId;
    if (id === null) return null;
    return settings.profiles.find((p) => p.profileId === id) ?? null;
  };

  // ── messaging: documents, record, state pulls ────────────────────────

  const refreshDocuments = async (): Promise<void> => {
    let tabs: WorkspaceTabInfo[] = [];
    try {
      tabs = await deps.listTabs();
    } catch {
      tabs = []; // titles are cosmetic; origin/epoch come from the broker
    }
    const reply = await send(envelope('control', { command: 'ListDocuments' }));
    if (reply.ok !== true || reply.kind !== 'documents') {
      ring.add({ context: 'workspace', phase: 'refresh-documents', resultCode: 'error', detail: errorText(reply) });
      publish();
      return;
    }
    const list = (reply.documents ?? []) as Array<Record<string, unknown>>;
    documents = list.map((d) => {
      const key = d.documentKey as DocumentKey;
      const tab = tabs.find((t) => t.id === key.tabId);
      return {
        documentKey: key,
        tabId: key.tabId,
        frameId: key.frameId,
        routeEpoch: (d.routeEpoch as number) ?? 0,
        origin: (d.origin as string | null) ?? null,
        runOwner: d.runOwner === true,
        ...(tab?.title !== undefined ? { title: tab.title } : {}),
        ...(tab?.url !== undefined ? { url: tab.url } : {}),
      };
    });
    if (pinnedTabId !== null && !documents.some((d) => d.tabId === pinnedTabId)) {
      pinnedTabId = null; // the pinned document is gone — never silently re-pin
      void persistSettings({ ...settings, pinnedTabId: null }).catch(() => undefined);
    }
    // Resynchronize live state for every registered document (close/reopen).
    for (const doc of documents) {
      try {
        const stateReply = await send(
          envelope('control', { command: 'GetState' }, doc.documentKey, currentEpoch(doc)),
        );
        const receipt = stateReply.receipt as Record<string, unknown> | undefined;
        if (stateReply.ok === true && receipt && receipt.ok === true) {
          adoptLiveState(doc.documentKey, receipt);
        }
      } catch {
        // An unreachable runtime stays visible with its registry facts only.
      }
    }
    publish();
    await refreshRecord();
  };

  const adoptLiveState = (dk: DocumentKey, receipt: Record<string, unknown>): void => {
    const key = docKeyString(dk);
    const seq = (receipt.seq as number) ?? 0;
    const existing = live[key];
    if (existing !== undefined && existing.seq >= seq) return; // stale push ignored
    live[key] = {
      lifecycle: String(receipt.state ?? 'unknown'),
      routeEpoch: (receipt.routeEpoch as number) ?? existing?.routeEpoch ?? 0,
      seq,
      customizations: (receipt.customizations ?? []) as LiveDocState['customizations'],
    };
  };

  const refreshRecord = async (): Promise<void> => {
    const doc = pinnedDocumentOf();
    if (doc === null || doc.origin === null) {
      record = null;
      recordError = null;
      publish();
      return;
    }
    try {
      const reply = await send(envelope('control', { command: 'GetOriginRecord', origin: doc.origin }));
      if (reply.ok !== true || reply.kind !== 'origin-record') {
        recordError = errorText(reply);
        record = null;
      } else {
        record = (reply.originRecord as OriginRecord | null) ?? null;
        recordError = null;
      }
    } catch (err) {
      recordError = `the record could not be read: ${(err as Error).message}`;
      record = null;
    }
    publish();
  };

  // ── run flow ──────────────────────────────────────────────────────────

  const controller: PlanningController = (deps.createController ?? createPlanningController)({
    now: deps.now,
    randomId: deps.randomId,
    sleep: (ms, signal) =>
      new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => resolve(), ms);
        signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new Error('aborted'));
        }, { once: true });
      }),
    observe: async (documentKey) => {
      const doc = documents.find((d) => docKeyString(d.documentKey) === docKeyString(documentKey));
      if (doc === undefined) throw new Error('the target document is no longer registered');
      const reply = await send(envelope('observe-request', { command: 'Observe' }, documentKey, currentEpoch(doc)));
      if (reply.ok !== true) throw new Error(errorText(reply));
      const receipt = reply.receipt as Record<string, unknown> | undefined;
      if (!receipt || receipt.ok !== true) throw new Error('observation was refused by the page runtime');
      const snapshot = receipt.snapshot as PageSnapshot;
      for (const region of snapshot.regions) evidence.set(region.targetRef, region);
      return snapshot;
    },
    inspect: async (documentKey, targetRef, fields) => {
      const doc = documents.find((d) => docKeyString(d.documentKey) === docKeyString(documentKey));
      if (doc === undefined) return { ok: false, detail: 'the target document is no longer registered' };
      const reply = await send(
        envelope('observe-request', { command: 'Inspect', targetRef, ...(fields.length > 0 ? { fields } : {}) }, documentKey, currentEpoch(doc)),
      );
      if (reply.ok !== true) return { ok: false, detail: errorText(reply) };
      const receipt = reply.receipt as Record<string, unknown> | undefined;
      if (!receipt || receipt.ok !== true) return { ok: false, detail: 'inspect was refused by the page runtime' };
      return { ok: true, detail: JSON.stringify(receipt.facts ?? {}).slice(0, 2000) };
    },
  });

  const clearQuestionTimer = (): void => {
    if (questionTimer !== null) {
      clearTimeout(questionTimer);
      questionTimer = null;
    }
  };

  const finishCounters = (counters: RunCounters): void => {
    run = run && { ...run, counters };
    ring.add({
      context: 'workspace',
      phase: 'run-finished',
      resultCode: 'ok',
      counts: { modelResponses: counters.modelResponses, httpAttempts: counters.httpAttempts, evidenceRequests: counters.evidenceRequests },
      durationMs: counters.wallMs,
    });
  };

  const handleOutcome = async (outcome: Awaited<ReturnType<PlanningRun['answer']>> | import('../planning/controller.ts').RunOutcome): Promise<void> => {
    switch (outcome.kind) {
      case 'proposal':
        pendingProposal = outcome.proposal;
        finishCounters(outcome.counters);
        emit('awaiting-approval');
        return;
      case 'question':
        pendingQuestion = { questionId: outcome.questionId, question: outcome.question };
        finishCounters(outcome.counters);
        emit('awaiting-question');
        clearQuestionTimer();
        questionTimer = setTimeout(() => {
          // plan/11 §5: expiry is the workspace's clock — never guess.
          void stop(`the question expired without an answer; start again for fresh evidence`).then(() => {
            ring.add({ context: 'workspace', phase: 'question-expired', resultCode: 'timeout-unknown' });
          });
        }, QUESTION_EXPIRY_MS);
        return;
      case 'cannot-complete':
        finishCounters(outcome.counters);
        emit('failed', outcome.reason);
        return;
      case 'provider-error':
        finishCounters(outcome.counters);
        ring.add({ context: 'workspace', phase: 'provider', resultCode: outcome.code, detail: outcome.message });
        emit('failed', `The model provider failed (${outcome.code}): ${outcome.message}`);
        return;
      case 'stopped':
        finishCounters(outcome.counters);
        emit('stopped');
        return;
    }
  };

  const start = async (goal: string): Promise<void> => {
    if (phase !== 'idle' && phase !== 'complete' && phase !== 'stopped' && phase !== 'failed' && phase !== 'busy' && phase !== 'conflicted' && phase !== 'applied-unsaved') {
      return; // a run is already in flight — Stop first
    }
    blocked = null;
    const doc = pinnedDocumentOf();
    if (doc === null) {
      blocked = { reason: 'no-target', text: 'Select the exact target page first.' };
      publish();
      return;
    }
    if (goal.trim() === '') {
      blocked = { reason: 'no-goal', text: 'Type what should change first.' };
      publish();
      return;
    }
    const profile = activeProfile();
    if (!settings.aiEnabled) {
      blocked = {
        reason: 'ai-off',
        text: 'AI planning is off — saved customizations keep working. Turn it on in Settings to plan new changes.',
      };
      publish();
      return;
    }
    if (profile === null) {
      blocked = { reason: 'no-profile', text: 'No provider profile is configured. Open Settings and add one.' };
      publish();
      return;
    }
    const ack = settings.consentAcks.find((a) => a.endpoint === profile.endpoint);
    const consent = evaluateProviderConsent(ack, profile.endpoint);
    if (!consent.ok) {
      blocked = { reason: 'no-consent', text: `Provider consent is missing for ${profile.endpoint}. Review and acknowledge the disclosure in Settings. No call was made.` };
      ring.add({ context: 'workspace', phase: 'consent-gate', resultCode: 'consent-required' });
      publish();
      return;
    }

    evidence = new Map();
    pendingQuestion = null;
    pendingProposal = null;
    pendingSave = null;
    lastSaveConflict = null;
    run = { runId: null, goal, startedAt: deps.now(), counters: null };
    abort = new AbortController();
    emit('starting');

    // One run owner per document (plan/06 §2) — StartRun first.
    try {
      const reply = await send(
        envelope('run-command', { command: 'StartRun', goal: goal.slice(0, LIMITS.maxSummaryChars) }, doc.documentKey, currentEpoch(doc)),
      );
      if (reply.ok !== true) {
        run = null;
        if ((reply.error as { code?: string } | undefined)?.code === 'conflict') {
          emit('busy', 'Stop cancels the active run; then Start again.');
        } else {
          emit('failed', errorText(reply));
        }
        return;
      }
      run.runId = (reply.runId as string) ?? null;
    } catch (err) {
      run = null;
      emit('failed', `could not reach the broker: ${(err as Error).message}`);
      return;
    }

    // Fresh observation of the pinned document.
    emit('observing');
    let snapshot: PageSnapshot;
    try {
      const reply = await send(envelope('observe-request', { command: 'Observe' }, doc.documentKey, currentEpoch(doc)));
      if (reply.ok !== true) {
        run = null;
        void send(envelope('run-command', { command: 'CancelRun' }, doc.documentKey, currentEpoch(doc))).catch(() => undefined);
        emit('failed', errorText(reply));
        return;
      }
      const receipt = reply.receipt as Record<string, unknown> | undefined;
      if (!receipt || receipt.ok !== true) {
        run = null;
        emit('failed', 'the page runtime refused observation');
        return;
      }
      snapshot = receipt.snapshot as PageSnapshot;
      for (const region of snapshot.regions) evidence.set(region.targetRef, region);
    } catch (err) {
      run = null;
      emit('failed', `reading the page failed: ${(err as Error).message}`);
      return;
    }

    // Bounded planning in the visible workspace (the controller re-checks
    // consent — defense in depth).
    emit('planning');
    const credential = settings.credentials[profile.profileId];
    planningRun = await controller.run({
      goal,
      documentKey: doc.documentKey,
      snapshot,
      profile,
      ...(credential !== undefined && credential !== '' ? { credential } : {}),
      consentAck: ack,
      signal: abort!.signal,
    });
    await handleOutcome(planningRun.outcome);
  };

  const stop = async (withDetail?: string): Promise<void> => {
    clearQuestionTimer();
    pendingQuestion = null;
    pendingProposal = null;
    abort?.abort();
    abort = null;
    const doc = pinnedDocumentOf();
    if (run?.runId !== null && doc !== null) {
      try {
        await send(envelope('run-command', { command: 'CancelRun' }, doc.documentKey, currentEpoch(doc)));
      } catch {
        // The broker registered cancellation best-effort; the runtime fence
        // and page lifecycle bound any leftover work.
      }
    }
    run = null;
    emit('stopped', withDetail);
  };

  const answerQuestion = async (answer: string): Promise<void> => {
    if (pendingQuestion === null || planningRun === null) return;
    const { questionId } = pendingQuestion;
    clearQuestionTimer();
    pendingQuestion = null;
    emit('planning');
    const outcome = await planningRun.answer(answer);
    void questionId;
    await handleOutcome(outcome);
  };

  const approve = async (scope: RouteScope): Promise<void> => {
    const proposal = pendingProposal;
    const doc = pinnedDocumentOf();
    if (proposal === null || doc === null || run === null) return;
    const customizationId = newCustomizationId();
    const revisionId = newRevisionId();
    pendingProposal = null;
    pendingSave = { proposal, customizationId, revisionId, scope, origin: doc.origin ?? '' };
    emit('applying');
    const reply = await send(
      envelope(
        'run-command',
        {
          command: 'ApplyBatch',
          batch: {
            batchId: newBatchId(),
            customizationId,
            revisionId,
            operations: proposal.operations,
          },
        },
        doc.documentKey,
        currentEpoch(doc),
      ),
    );
    if (reply.ok !== true) {
      const code = (reply.error as { code?: string } | undefined)?.code;
      emit('failed', code === 'stale-route' ? 'The page changed since the proposal; run again with fresh evidence.' : errorText(reply));
      return;
    }
    // The broker relays the runtime receipt twice-wrapped for run commands
    // (runtime → broker wraps → reply.receipt.receipt); the state/snapshot
    // projections come through singly. Accept both shapes.
    const receiptEnvelope = reply.receipt as Record<string, unknown> | undefined;
    const receipt = (receiptEnvelope?.receipt ?? receiptEnvelope) as Record<string, unknown> | undefined ?? {};
    const status = String(receipt.status ?? '');
    if (status === 'accepted') {
      await saveAccepted();
      return;
    }
    if (status === 'rolled-back') {
      const error = receipt.error as { message?: string } | undefined;
      emit('failed', `Could not verify the preview; it was reverted.${error?.message ? ` ${error.message}` : ''}`);
      return;
    }
    if (status === 'conflicted') {
      const conflicts = (receipt.conflicts as string[] | undefined) ?? [];
      emit('conflicted', conflicts.length > 0 ? ` Detail: ${conflicts.slice(0, 3).join('; ')}` : '');
      return;
    }
    if (status === 'outcome-unknown') {
      emit('failed', 'The result could not be confirmed (outcome unknown); it was treated as not applied. Re-run if needed.');
      return;
    }
    emit('failed', `the page runtime reported: ${status}`);
  };

  const discardProposal = (): void => {
    if (pendingProposal === null) return;
    pendingProposal = null;
    emit('idle', 'Proposal discarded; nothing was applied.');
  };

  const saveAccepted = async (): Promise<void> => {
    const save = pendingSave;
    const profile = activeProfile();
    if (save === null || profile === null) {
      emit('failed', 'the accepted work lost its save context');
      return;
    }
    emit('saving');
    // Fresh expected revision right before the write (plan/06 §2 boundary 3).
    let expectedRecordRevision = 0;
    try {
      const reply = await send(envelope('control', { command: 'GetOriginRecord', origin: save.origin }));
      if (reply.ok === true && reply.kind === 'origin-record') {
        expectedRecordRevision = ((reply.originRecord as OriginRecord | null) ?? null)?.recordRevision ?? 0;
      }
    } catch {
      // The save below will surface the honest store outcome.
    }
    const built = buildSavedRevision({
      proposal: save.proposal,
      evidence,
      origin: save.origin,
      revisionId: save.revisionId,
      savedAt: deps.now(),
      profile: { profileId: profile.profileId, modelId: profile.modelId },
    });
    if (!built.ok) {
      emit('applied-unsaved', built.error);
      pendingSave = save;
      return;
    }
    const reply = await send(
      envelope('control', {
        command: 'SaveRevision',
        origin: save.origin,
        customizationId: save.customizationId,
        title: save.proposal.summary.slice(0, LIMITS.maxTitleChars),
        scope: save.scope,
        contentSensitivity: 'page-only',
        grants: [],
        revision: built.revision,
        expectedRecordRevision,
        mutationId: newMutationId(),
      }),
    );
    if (reply.ok === true && reply.kind === 'saved') {
      pendingSave = null;
      lastSaveConflict = null;
      emit('complete', ` Scope: ${scopeText(save.scope)}.`);
      void refreshDocuments();
      return;
    }
    const code = (reply.error as { code?: string } | undefined)?.code;
    const recovery = (reply.error as { recoveryAction?: string } | undefined)?.recoveryAction;
    lastSaveConflict = (reply.conflict as string | undefined) ?? null;
    pendingSave = save;
    emit('applied-unsaved', `${errorText(reply)}${recovery ? '' : ''}`.trim() || 'the record write failed');
    ring.add({ context: 'workspace', phase: 'save', resultCode: code ?? 'error' });
  };

  const retrySave = async (): Promise<void> => {
    if (pendingSave === null) return;
    lastSaveConflict = null;
    await saveAccepted();
  };

  // ── record mutations (fresh expected revision per mutation) ───────────

  const mutateRecord = async (
    build: (ctx: { record: OriginRecord | null; expectedRecordRevision: number }) => Record<string, unknown> | { error: string },
  ): Promise<void> => {
    const doc = pinnedDocumentOf();
    if (doc === null || doc.origin === null) return;
    try {
      const read = await send(envelope('control', { command: 'GetOriginRecord', origin: doc.origin }));
      if (read.ok !== true || read.kind !== 'origin-record') {
        recordError = errorText(read);
        publish();
        return;
      }
      const current = (read.originRecord as OriginRecord | null) ?? null;
      const ctx = { record: current, expectedRecordRevision: current?.recordRevision ?? 0 };
      const payload = build(ctx);
      if ('error' in payload && payload.error) {
        publish();
        return;
      }
      const reply = await send(envelope('control', { ...payload } as Record<string, unknown>));
      if (reply.ok !== true) {
        ring.add({ context: 'workspace', phase: 'record-mutation', resultCode: (reply.error as { code?: string } | undefined)?.code ?? 'error', detail: errorText(reply).slice(0, 160) });
      }
    } catch (err) {
      ring.add({ context: 'workspace', phase: 'record-mutation', resultCode: 'error', detail: (err as Error).message.slice(0, 160) });
    }
    await refreshRecord();
    await refreshDocuments();
  };

  const setEnabled = (customizationId: string, enabled: boolean): Promise<void> =>
    mutateRecord((ctx) => ({
      command: 'SetEnabled',
      origin: pinnedDocumentOf()?.origin ?? '',
      customizationId,
      enabled,
      expectedRecordRevision: ctx.expectedRecordRevision,
      mutationId: newMutationId(),
    }));

  const removeCustomization = (customizationId: string): Promise<void> =>
    mutateRecord((ctx) => ({
      command: 'RemoveCustomization',
      origin: pinnedDocumentOf()?.origin ?? '',
      customizationId,
      expectedRecordRevision: ctx.expectedRecordRevision,
      mutationId: newMutationId(),
    }));

  const undoLatestRevision = (customizationId: string): Promise<void> =>
    mutateRecord((ctx) => {
      const cust = ctx.record?.customizations.find((c) => c.customizationId === customizationId);
      if (cust === undefined) return { error: 'the customization is no longer in the record' };
      const idx = cust.revisions.findIndex((r) => r.revisionId === cust.activeRevisionId);
      if (idx < 1) return { error: 'there is no previous revision to undo to' };
      const previous = cust.revisions[idx - 1];
      return {
        command: 'SaveRevision',
        origin: ctx.record!.origin,
        customizationId,
        title: cust.title,
        scope: cust.scope,
        contentSensitivity: cust.contentSensitivity,
        grants: cust.grants,
        revision: previous,
        expectedRecordRevision: ctx.expectedRecordRevision,
        mutationId: newMutationId(),
      };
    });

  // ── settings ─────────────────────────────────────────────────────────

  const persistSettings = async (next: WorkspaceSettings): Promise<void> => {
    settings = next;
    await deps.saveSettings(next);
    publish();
  };

  const acknowledgeConsent = async (): Promise<void> => {
    const profile = activeProfile();
    if (profile === null) return;
    const ack: DisclosureAck = {
      disclosureVersion: PROVIDER_DISCLOSURE_VERSION,
      endpoint: profile.endpoint,
      acknowledgedAt: deps.now(),
    };
    // Endpoint-scoped: an ack for a different endpoint never carries over.
    const others = settings.consentAcks.filter((a) => a.endpoint !== profile.endpoint);
    await persistSettings({ ...settings, consentAcks: [...others, ack] });
    ring.add({ context: 'workspace', phase: 'consent-ack', resultCode: 'ok' });
  };

  // ── subscription feed (RuntimeState pushes) ───────────────────────────

  const onPush = (raw: unknown): void => {
    if (typeof raw !== 'object' || raw === null) return;
    const env = raw as { kind?: unknown; documentKey?: DocumentKey; payload?: { command?: unknown; state?: unknown; routeEpoch?: unknown; seq?: unknown; customizations?: unknown } };
    if (env.kind !== 'subscription' || env.payload?.command !== 'RuntimeState') return;
    if (env.documentKey === undefined) return;
    adoptLiveState(env.documentKey, {
      state: env.payload.state,
      routeEpoch: env.payload.routeEpoch,
      seq: env.payload.seq,
      customizations: env.payload.customizations,
    });
    publish();
  };

  const init = async (): Promise<void> => {
    const stored = await deps.loadSettings();
    const decoded = decodeWorkspaceSettings(stored);
    settings = decoded.ok ? decoded.value : DEFAULT_SETTINGS;
    // The persisted pin is adopted provisionally and revalidated against
    // live registrations inside refreshDocuments (plan/05 §1).
    pinnedTabId = settings.pinnedTabId ?? null;
    try {
      await refreshDocuments();
    } catch (err) {
      ring.add({ context: 'workspace', phase: 'init', resultCode: 'error', detail: (err as Error).message.slice(0, 160) });
      publish();
    }
    publish();
  };

  const unsubscribePush = deps.onMessage(onPush);

  return {
    state: () => ({
      phase,
      blocked,
      documents,
      pinnedDocument: pinnedDocumentOf(),
      live,
      run,
      pendingQuestion,
      pendingProposal,
      pendingSave,
      lastSaveConflict,
      record,
      recordError,
      statusDetail,
      settings,
      diagnostics: ring.summary(),
    }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    init,
    refreshDocuments,
    setPinnedTab(tabId) {
      pinnedTabId = tabId;
      // plan/05 §1: the selection persists but is revalidated on next load.
      void persistSettings({ ...settings, pinnedTabId: tabId }).catch(() => undefined);
      publish();
      void refreshRecord();
    },
    start,
    stop,
    answerQuestion,
    approve,
    discardProposal,
    retrySave,
    refreshRecord,
    setEnabled,
    removeCustomization,
    undoLatestRevision,
    saveSettings: persistSettings,
    acknowledgeConsent,
    activeProfile,
    dispose() {
      clearQuestionTimer();
      abort?.abort();
      unsubscribePush();
      listeners.clear();
    },
  };
}

// ── DOM mount (native controls only; all text through text nodes) ─────────

const WORKSPACE_CSS = `
  :host, html, body { margin: 0; padding: 0; }
  body { font: 13px/1.5 system-ui, -apple-system, sans-serif; color: #1b1d22; background: #f7f7f8; }
  main { max-width: 640px; margin: 0 auto; padding: 12px 14px 40px; display: grid; gap: 14px; }
  h1 { font-size: 16px; margin: 0; }
  h2 { font-size: 13px; margin: 0 0 6px; text-transform: uppercase; letter-spacing: .04em; color: #555a66; }
  section, details { background: #fff; border: 1px solid #d9dbe2; border-radius: 8px; padding: 10px 12px; }
  .status { padding: 8px 10px; border-radius: 6px; border: 1px solid #c9ccd6; background: #f1f2f6; white-space: pre-wrap; }
  .status.ok { border-color: #2e7d32; background: #e8f4e9; }
  .status.error { border-color: #b3261e; background: #fdeeec; }
  .status.warn { border-color: #8a6d00; background: #fdf6e0; }
  button { font: inherit; padding: 5px 12px; border-radius: 6px; border: 1px solid #848aa0; background: #fff; cursor: pointer; }
  button:hover { background: #f0f2ff; }
  button[disabled] { opacity: .5; cursor: default; }
  button.primary { background: #3450d4; border-color: #3450d4; color: #fff; }
  button.primary:hover { background: #2b41b8; }
  button.danger { border-color: #b3261e; color: #b3261e; }
  textarea, input, select { font: inherit; width: 100%; box-sizing: border-box; padding: 5px 7px; border: 1px solid #848aa0; border-radius: 6px; background: #fff; }
  textarea { min-height: 56px; resize: vertical; }
  label { display: block; margin: 8px 0 3px; font-weight: 600; }
  fieldset { border: 1px solid #d9dbe2; border-radius: 8px; margin: 0; padding: 6px 10px 8px; }
  legend { font-weight: 700; padding: 0 4px; }
  .radios { display: grid; gap: 3px; max-height: 190px; overflow: auto; }
  .radios label { display: flex; gap: 6px; align-items: center; font-weight: 400; margin: 0; }
  .muted { color: #555a66; font-size: 12px; }
  .row { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
  ul.plain { list-style: none; margin: 6px 0 0; padding: 0; display: grid; gap: 8px; }
  ul.plain li { border: 1px solid #e2e3ea; border-radius: 6px; padding: 8px 10px; }
  .cust-head { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; flex-wrap: wrap; }
  .cust-head strong { font-size: 13px; }
  pre.diag { background: #f1f2f6; border: 1px solid #d9dbe2; border-radius: 6px; padding: 8px; overflow: auto; max-height: 220px; font-size: 11px; white-space: pre-wrap; }
  .kv { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; font-size: 12px; }
  .kv dt { font-weight: 600; color: #555a66; }
  .kv dd { margin: 0; word-break: break-word; }
`;

/** Mount the workspace UI. Returns an unmount handle (sidepanel teardown). */
export function mountWorkspace(root: HTMLElement, deps: WorkspaceDeps): { unmount(): void; core: WorkspaceCore } {
  const core = createWorkspaceCore(deps);
  const doc = root.ownerDocument ?? document;

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  };

  // Static skeleton (built once; dynamic regions re-render).
  const style = el('style');
  style.textContent = WORKSPACE_CSS;

  const main = el('main');
  const h1 = el('h1', 'Revueon workspace');
  const openTabBtn = el('button', 'Open this workspace in a tab');
  openTabBtn.type = 'button';
  openTabBtn.title = 'Side panel unavailable? The same workspace runs as an extension tab.';
  openTabBtn.addEventListener('click', () => {
    const url = typeof chrome !== 'undefined' && chrome.runtime?.getURL ? chrome.runtime.getURL('sidepanel.html') : '/sidepanel.html';
    void globalThis.open?.(url, '_blank');
  });

  // Target section
  const targetSection = el('section');
  const targetHeading = el('h2', 'Target page');
  const targetHint = el('p', 'Pages with a live Revueon runtime are listed. You choose the exact page — nothing is picked for you.');
  targetHint.className = 'muted';
  const refreshBtn = el('button', 'Refresh page list');
  refreshBtn.type = 'button';
  const radiosField = doc.createElement('fieldset');
  const radiosLegend = el('legend', 'Pinned target');
  const radiosBox = el('div');
  radiosBox.className = 'radios';
  radiosField.append(radiosLegend, radiosBox);
  const noneLabel = el('label');
  const noneRadio = doc.createElement('input');
  noneRadio.type = 'radio';
  noneRadio.name = 'rv-target';
  noneRadio.value = '';
  noneLabel.append(noneRadio, doc.createTextNode(' No target pinned'));
  radiosBox.append(noneLabel);
  targetSection.append(targetHeading, targetHint, refreshBtn, radiosField);

  // Run section
  const runSection = el('section');
  const runHeading = el('h2', 'Request');
  const goalLabel = el('label', 'What should change?');
  goalLabel.htmlFor = 'rv-goal';
  const goalInput = doc.createElement('textarea');
  goalInput.id = 'rv-goal';
  const startBtn = el('button', 'Start');
  startBtn.type = 'button';
  startBtn.className = 'primary';
  const stopBtn = el('button', 'Stop');
  stopBtn.type = 'button';
  stopBtn.className = 'danger';
  const statusBox = el('div');
  statusBox.id = 'rv-status';
  statusBox.className = 'status';
  statusBox.setAttribute('role', 'status');
  statusBox.setAttribute('aria-live', 'polite');
  const questionBox = el('div');
  questionBox.hidden = true;
  const proposalBox = el('div');
  proposalBox.hidden = true;
  const retryBox = el('div');
  retryBox.hidden = true;
  const controlsRow = el('div');
  controlsRow.className = 'row';
  controlsRow.append(startBtn, stopBtn);
  runSection.append(runHeading, goalLabel, goalInput, controlsRow, statusBox, questionBox, proposalBox, retryBox);

  // Customizations section
  const custSection = el('section');
  const custHeading = el('h2', 'Customizations on this site');
  const custList = el('ul');
  custList.className = 'plain';
  const custNote = el('p');
  custNote.className = 'muted';
  custSection.append(custHeading, custNote, custList);

  // Settings section
  const settingsDetails = doc.createElement('details');
  const settingsSummary = el('summary', 'Settings — provider, consent, AI on/off');
  const profileSelect = doc.createElement('select');
  profileSelect.setAttribute('aria-label', 'Active provider profile');
  const newProfileBtn = el('button', 'New profile');
  newProfileBtn.type = 'button';
  const fLabel = el('label', 'Profile name');
  fLabel.htmlFor = 'rv-p-label';
  const fLabelInput = doc.createElement('input');
  fLabelInput.id = 'rv-p-label';
  fLabelInput.type = 'text';
  fLabelInput.placeholder = 'My model provider';
  const fProtocol = doc.createElement('select');
  fProtocol.id = 'rv-p-protocol';
  fProtocol.setAttribute('aria-label', 'Protocol');
  for (const p of ['openai-chat', 'anthropic-messages'] as const) {
    const o = doc.createElement('option');
    o.value = p;
    o.textContent = p;
    fProtocol.append(o);
  }
  const protocolLabel = el('label', 'Protocol');
  protocolLabel.htmlFor = 'rv-p-protocol';
  const fEndpointLabel = el('label', 'Endpoint URL (https, or http on localhost)');
  fEndpointLabel.htmlFor = 'rv-p-endpoint';
  const fEndpoint = doc.createElement('input');
  fEndpoint.id = 'rv-p-endpoint';
  fEndpoint.type = 'url';
  fEndpoint.placeholder = 'https://api.example.com/v1/chat/completions';
  const fModelLabel = el('label', 'Model id');
  fModelLabel.htmlFor = 'rv-p-model';
  const fModel = doc.createElement('input');
  fModel.id = 'rv-p-model';
  fModel.type = 'text';
  const fAuthLabel = el('label', 'Authentication');
  fAuthLabel.htmlFor = 'rv-p-auth';
  const fAuth = doc.createElement('select');
  fAuth.id = 'rv-p-auth';
  fAuth.setAttribute('aria-label', 'Authentication kind');
  for (const a of ['none', 'bearer', 'api-key-header'] as const) {
    const o = doc.createElement('option');
    o.value = a;
    o.textContent = a;
    fAuth.append(o);
  }
  const fHeaderLabel = el('label', 'API key header name');
  fHeaderLabel.htmlFor = 'rv-p-header';
  const fHeader = doc.createElement('input');
  fHeader.id = 'rv-p-header';
  fHeader.type = 'text';
  fHeader.placeholder = 'x-api-key';
  const fCredentialLabel = el('label', 'Credential (API key) — stored locally, never shown again');
  fCredentialLabel.htmlFor = 'rv-p-credential';
  const fCredential = doc.createElement('input');
  fCredential.id = 'rv-p-credential';
  fCredential.type = 'password';
  fCredential.autocomplete = 'off';
  const saveProfileBtn = el('button', 'Save profile');
  saveProfileBtn.type = 'button';
  const profileStatus = el('p');
  profileStatus.className = 'muted';
  profileStatus.setAttribute('role', 'status');

  const consentBox = el('div');
  const aiLabel = el('label');
  const aiToggle = doc.createElement('input');
  aiToggle.type = 'checkbox';
  aiToggle.id = 'rv-ai';
  aiLabel.append(aiToggle, doc.createTextNode(' AI planning enabled (turn off to stop all model calls; saved customizations keep working)'));
  aiLabel.style.display = 'block';
  aiLabel.htmlFor = 'rv-ai';

  settingsDetails.append(
    settingsSummary,
    profileSelect,
    newProfileBtn,
    fLabel, fLabelInput,
    protocolLabel, fProtocol,
    fEndpointLabel, fEndpoint,
    fModelLabel, fModel,
    fAuthLabel, fAuth,
    fHeaderLabel, fHeader,
    fCredentialLabel, fCredential,
    saveProfileBtn,
    profileStatus,
    consentBox,
    aiLabel,
  );

  // Diagnostics section
  const diagDetails = doc.createElement('details');
  const diagSummary = el('summary', 'Diagnostics');
  const diagBody = el('div');

  root.append(style, main);
  main.append(h1, openTabBtn, targetSection, runSection, custSection, settingsDetails, diagDetails);
  diagDetails.append(diagSummary, diagBody);

  // ── dynamic rendering ────────────────────────────────────────────────

  let ignoreRadioEvents = false;

  const renderTargets = (s: WorkspaceState): void => {
    const selected = s.pinnedDocument?.tabId ?? null;
    ignoreRadioEvents = true;
    for (const label of [...radiosBox.querySelectorAll('label')]) {
      if (label !== noneLabel) label.remove();
    }
    if (s.documents.length === 0) {
      const p = el('p', 'No pages with a live Revueon runtime. Open (or reload) an ordinary web page.');
      p.className = 'muted';
      radiosBox.append(p);
    }
    for (const d of s.documents) {
      const label = el('label');
      const radio = doc.createElement('input');
      radio.type = 'radio';
      radio.name = 'rv-target';
      radio.value = String(d.tabId);
      if (d.tabId === selected) radio.checked = true;
      const name = d.title ? d.title.slice(0, 60) : 'untitled page';
      label.append(radio, doc.createTextNode(` ${name} — ${d.origin ?? 'unknown origin'} (tab ${d.tabId}${d.runOwner ? ', run active' : ''})`));
      radiosBox.append(label);
    }
    noneRadio.checked = selected === null;
    ignoreRadioEvents = false;
  };

  const renderRun = (s: WorkspaceState): void => {
    const inFlight = ['starting', 'observing', 'planning', 'awaiting-question', 'awaiting-approval', 'applying', 'saving'].includes(s.phase);
    startBtn.disabled = inFlight;
    stopBtn.disabled = !inFlight; // Stop is always reachable while anything runs (I22)
    const view = statusFor(s.phase, {
      profileLabel: core.activeProfile()?.label,
      elapsedMs: s.run?.startedAt != null ? deps.now() - s.run.startedAt : undefined,
      detail: s.statusDetail ?? undefined,
    });
    // Blocked pre-run refusals render their explicit reason (zero calls made).
    statusBox.className = `status ${view.tone}`;
    statusBox.textContent = s.blocked !== null && s.phase === 'idle' ? s.blocked.text : view.text;
    if (s.run?.counters != null) {
      statusBox.textContent += `\nmodel responses: ${s.run.counters.modelResponses}, HTTP attempts: ${s.run.counters.httpAttempts}, wall ${(s.run.counters.wallMs / 1000).toFixed(1)}s`;
    }

    // Question area
    questionBox.textContent = '';
    if (s.pendingQuestion !== null) {
      questionBox.hidden = false;
      const q = el('p', s.pendingQuestion.question.question);
      q.style.fontWeight = '700';
      questionBox.append(q);
      for (const option of s.pendingQuestion.question.options) {
        const b = el('button', option);
        b.type = 'button';
        b.addEventListener('click', () => void core.answerQuestion(option));
        questionBox.append(b);
        questionBox.append(doc.createTextNode(' '));
      }
      const answerLabel = el('label', 'Or type your own answer');
      answerLabel.htmlFor = 'rv-answer';
      const answerInput = doc.createElement('input');
      answerInput.id = 'rv-answer';
      answerInput.type = 'text';
      const sendBtn = el('button', 'Send answer');
      sendBtn.type = 'button';
      sendBtn.className = 'primary';
      const sendOwn = (): void => {
        const value = answerInput.value.trim();
        if (value !== '') void core.answerQuestion(value);
      };
      sendBtn.addEventListener('click', sendOwn);
      answerInput.addEventListener('keydown', (ev) => {
        if ((ev as KeyboardEvent).key === 'Enter') sendOwn();
      });
      questionBox.append(answerLabel, answerInput, sendBtn);
    } else {
      questionBox.hidden = true;
    }

    // Proposal/approval area
    proposalBox.textContent = '';
    if (s.pendingProposal !== null && s.phase === 'awaiting-approval') {
      proposalBox.hidden = false;
      const summary = el('p', `Proposed: ${s.pendingProposal.summary}`);
      summary.style.fontWeight = '700';
      proposalBox.append(summary);
      const ops = el('ul');
      ops.className = 'plain';
      for (const op of s.pendingProposal.operations.slice(0, 16)) {
        ops.append(el('li', `${op.kind} — ${describeOperation(op)}`));
      }
      proposalBox.append(ops);
      const scopeLabel = el('label', 'Apply where? (saved scope)');
      scopeLabel.htmlFor = 'rv-scope';
      const scopeSelect = doc.createElement('select');
      scopeSelect.id = 'rv-scope';
      const path = pathOfPinned(s);
      const modes: Array<{ mode: RouteScope['mode']; text: string }> = [
        { mode: 'exactPath', text: `this exact path (${path})` },
        { mode: 'pathPrefix', text: `pages under ${path}` },
        { mode: 'origin', text: 'all pages on this site' },
      ];
      for (const m of modes) {
        const o = doc.createElement('option');
        o.value = m.mode;
        o.textContent = m.text;
        if (m.mode === 'exactPath') o.selected = true;
        scopeSelect.append(o);
      }
      const applyBtn = el('button', 'Apply');
      applyBtn.type = 'button';
      applyBtn.className = 'primary';
      applyBtn.addEventListener('click', () => {
        const mode = scopeSelect.value as RouteScope['mode'];
        void core.approve({ mode, ...(mode !== 'origin' ? { path } : {}) });
      });
      const discardBtn = el('button', 'Discard');
      discardBtn.type = 'button';
      discardBtn.addEventListener('click', () => core.discardProposal());
      proposalBox.append(scopeLabel, scopeSelect);
      const row = el('div');
      row.className = 'row';
      row.append(applyBtn, discardBtn);
      proposalBox.append(row);
    } else {
      proposalBox.hidden = true;
    }

    // Retry-save area (applied-unsaved)
    retryBox.textContent = '';
    if (s.phase === 'applied-unsaved' && s.pendingSave !== null) {
      retryBox.hidden = false;
      const retryBtn = el('button', 'Retry save');
      retryBtn.type = 'button';
      retryBtn.className = 'primary';
      retryBtn.addEventListener('click', () => void core.retrySave());
      const hint = el('p', 'Your change is applied in this tab only. Retry save writes it permanently; reloading the tab clears unsaved work.');
      hint.className = 'muted';
      retryBox.append(hint, retryBtn);
    } else {
      retryBox.hidden = true;
    }
  };

  const describeOperation = (op: import('../contracts.ts').Operation): string => {
    const firstRef = (t: { targetRef?: string; localRef?: string } | undefined): string =>
      t?.targetRef ?? t?.localRef ?? '(owned node)';
    switch (op.kind) {
      case 'style':
        return `${op.rules.length} style rule(s) on ${firstRef(op.rules[0]?.target)}`;
      case 'hide':
        return `hide ${firstRef(op.target)}`;
      case 'replaceText':
        return `replace text of ${firstRef(op.target)} with “${op.text.slice(0, 40)}”`;
      case 'insertUI':
        return `insert UI ${op.position} ${firstRef(op.target)}`;
      case 'relocate':
        return `move ${firstRef(op.target)} relative to ${firstRef(op.destination)}`;
      case 'bindKey': {
        // plan/09 §1: generic activation is potentially consequential — the
        // review must show the exact target + actions and say plainly that
        // undo removes the shortcut, NOT the site's own effect.
        const base = `bind “${op.chord}” → ${op.actionIds.join(', ')} on ${firstRef(op.target)}`;
        const consequential = op.actionIds.some((a) => (CONSEQUENTIAL_BIND_ACTIONS as ReadonlySet<string>).has(a));
        return consequential
          ? `${base} — pressing it activates this page's own control; undo removes the shortcut, not any effect it causes`
          : base;
      }
      case 'collapse':
        return `add a disclosure toggle “${op.label}” ${op.placement ?? 'before'} ${firstRef(op.target)} (starts ${op.initialState ?? 'collapsed'}; you can always expand)`;
      case 'localRule': {
        // plan/09 §3: the automatic trigger acts WITHOUT a gesture — the
        // review must say what will be clicked and that undo removes the
        // rule, not effects already caused.
        const base = `rule: when a new matching element appears ${firstRef(op.target)}`;
        if (op.actionId === 'activateDisclosure') {
          return `${base}, click its own disclosure control automatically — undo removes the rule, not collapses it already caused`;
        }
        if (op.actionId === 'focus') return `${base}, focus it`;
        return `${base}, ${op.actionId}`;
      }
      default:
        return `${op.kind} on ${firstRef('target' in op ? op.target : undefined)}`;
    }
  };

  const pathOfPinned = (s: WorkspaceState): string => {
    const url = s.pinnedDocument?.url;
    if (url === undefined) return '/';
    try {
      return new URL(url).pathname || '/';
    } catch {
      return '/';
    }
  };

  const renderCustomizations = (s: WorkspaceState): void => {
    custList.textContent = '';
    if (s.record === null || s.record.customizations.length === 0) {
      custNote.textContent = s.recordError ?? 'No saved customizations for this site yet.';
      return;
    }
    custNote.textContent = 'Saved customizations apply from local storage — they replay without any model call.';
    const liveKey = s.pinnedDocument !== null ? `${s.pinnedDocument.documentKey.tabId}:${s.pinnedDocument.documentKey.frameId}:${s.pinnedDocument.documentKey.browserDocumentId}` : null;
    const liveEntries = liveKey !== null ? (s.live[liveKey]?.customizations ?? []) : [];
    for (const cust of s.record.customizations) {
      const live = liveEntries.find((e) => e.customizationId === cust.customizationId);
      const li = el('li');
      const head = el('div');
      head.className = 'cust-head';
      const title = el('strong', cust.title);
      head.append(title);
      const scopeSpan = el('span', scopeText(cust.scope));
      scopeSpan.className = 'muted';
      head.append(scopeSpan);
      const toggleLabel = el('label');
      const toggle = doc.createElement('input');
      toggle.type = 'checkbox';
      toggle.checked = cust.enabled;
      toggle.addEventListener('change', () => void core.setEnabled(cust.customizationId, toggle.checked));
      toggleLabel.append(toggle, doc.createTextNode(` enabled`));
      const liveText = el('p', liveStateText(live?.state, live?.detail, cust.enabled));
      liveText.className = 'muted';
      li.append(head, toggleLabel, liveText);
      const activeIdx = cust.revisions.findIndex((r) => r.revisionId === cust.activeRevisionId);
      if (activeIdx > 0) {
        const undoBtn = el('button', 'Undo latest revision');
        undoBtn.type = 'button';
        undoBtn.addEventListener('click', () => void core.undoLatestRevision(cust.customizationId));
        li.append(undoBtn, doc.createTextNode(' '));
      }
      const removeBtn = el('button', 'Remove');
      removeBtn.type = 'button';
      removeBtn.className = 'danger';
      removeBtn.addEventListener('click', () => void core.removeCustomization(cust.customizationId));
      li.append(removeBtn);
      custList.append(li);
    }
  };

  const renderSettings = (s: WorkspaceState): void => {
    // Profile select
    profileSelect.textContent = '';
    if (s.settings.profiles.length === 0) {
      const o = doc.createElement('option');
      o.value = '';
      o.textContent = '(no profiles yet — create one below)';
      profileSelect.append(o);
    } else {
      for (const p of s.settings.profiles) {
        const o = doc.createElement('option');
        o.value = p.profileId;
        o.textContent = `${p.label} — ${p.modelId}`;
        if (p.profileId === s.settings.activeProfileId) o.selected = true;
        profileSelect.append(o);
      }
    }
    aiToggle.checked = s.settings.aiEnabled;

    // Consent area — explicit, endpoint-specific (I19; opening settings grants nothing).
    consentBox.textContent = '';
    const profile = core.activeProfile();
    if (profile === null) {
      const p = el('p', 'Add and save a provider profile to configure model calls.');
      p.className = 'muted';
      consentBox.append(p);
    } else {
      const ack = s.settings.consentAcks.find((a) => a.endpoint === profile.endpoint);
      const consented = evaluateProviderConsent(ack, profile.endpoint).ok;
      const disclosure = el('p',
        `Before Revueon calls your model provider, you need to acknowledge: the selected page evidence and your goal are sent to ${profile.endpoint}. That provider's retention policy applies to what it receives. Your saved customizations stay local unless you export them. This acknowledgement applies to this endpoint only.`);
      disclosure.className = 'muted';
      consentBox.append(disclosure);
      if (consented) {
        const ok = el('p', `Acknowledged for ${profile.endpoint}.`);
        ok.className = 'muted';
        consentBox.append(ok);
      } else {
        const ackBtn = el('button', `I understand — allow calls to ${profile.endpoint}`);
        ackBtn.type = 'button';
        ackBtn.className = 'primary';
        ackBtn.addEventListener('click', () => void core.acknowledgeConsent());
        consentBox.append(ackBtn);
      }
    }
  };

  const renderDiagnostics = (s: WorkspaceState): void => {
    diagBody.textContent = '';
    const dl = el('dl');
    dl.className = 'kv';
    const add = (k: string, v: string): void => {
      dl.append(el('dt', k), el('dd', v));
    };
    add('phase', s.phase);
    if (s.pinnedDocument !== null) {
      const key = `${s.pinnedDocument.documentKey.tabId}:${s.pinnedDocument.documentKey.frameId}:${s.pinnedDocument.documentKey.browserDocumentId}`;
      const liveState = s.live[key];
      add('pinned document', `tab ${s.pinnedDocument.tabId}, epoch ${liveState?.routeEpoch ?? s.pinnedDocument.routeEpoch}, runtime ${liveState?.lifecycle ?? 'unknown'}`);
      add('saved record revision', s.record !== null ? String(s.record.recordRevision) : (s.recordError ?? 'none'));
      const liveCount = liveState?.customizations.length ?? 0;
      add('live customizations on this page', String(liveCount));
    } else {
      add('pinned document', 'none');
    }
    if (s.run?.counters != null) {
      add('last run', `${s.run.counters.modelResponses} model responses, ${s.run.counters.httpAttempts} HTTP attempts, ${(s.run.counters.wallMs / 1000).toFixed(1)}s`);
    }
    diagBody.append(dl);
    const pre = el('pre');
    pre.className = 'diag';
    pre.textContent = s.diagnostics !== '' ? s.diagnostics : '(no diagnostic events yet)';
    diagBody.append(pre);
  };

  // ── static listeners ─────────────────────────────────────────────────

  radiosBox.addEventListener('change', () => {
    if (ignoreRadioEvents) return;
    const checked = radiosBox.querySelector<HTMLInputElement>('input[type=radio]:checked');
    core.setPinnedTab(checked !== null && checked.value !== '' ? Number(checked.value) : null);
  });

  refreshBtn.addEventListener('click', () => void core.refreshDocuments());

  startBtn.addEventListener('click', () => void core.start(goalInput.value));

  stopBtn.addEventListener('click', () => void core.stop());

  newProfileBtn.addEventListener('click', () => {
    profileSelect.value = '';
    fLabelInput.value = '';
    fEndpoint.value = '';
    fModel.value = '';
    fAuth.value = 'none';
    fHeader.value = '';
    fCredential.value = '';
    fLabelInput.focus();
  });

  profileSelect.addEventListener('change', () => {
    const profile = core.state().settings.profiles.find((p) => p.profileId === profileSelect.value);
    if (profile === undefined) return;
    void core.saveSettings({ ...core.state().settings, activeProfileId: profile.profileId });
    fLabelInput.value = profile.label;
    fProtocol.value = profile.protocol;
    fEndpoint.value = profile.endpoint;
    fModel.value = profile.modelId;
    fAuth.value = profile.auth.kind;
    fHeader.value = profile.auth.headerName ?? '';
    fCredential.placeholder = (core.state().settings.credentials[profile.profileId] ?? '') !== '' ? '(unchanged — stored)' : '';
  });

  fAuth.addEventListener('change', () => {
    fHeader.parentElement?.classList.toggle('hidden', fAuth.value !== 'api-key-header');
  });

  const saveProfileFromForm = (): void => {
    const s = core.state();
    const existingId = profileSelect.value || undefined;
    const profileLike = {
      profileVersion: 1 as const,
      profileId: existingId ?? `profile-${deps.randomId()}`,
      label: fLabelInput.value.trim() || 'My provider',
      protocol: fProtocol.value as 'openai-chat' | 'anthropic-messages',
      endpoint: fEndpoint.value.trim(),
      modelId: fModel.value.trim(),
      auth:
        fAuth.value === 'none'
          ? { kind: 'none' as const }
          : fAuth.value === 'bearer'
            ? { kind: 'bearer' as const }
            : { kind: 'api-key-header' as const, headerName: fHeader.value.trim() },
    };
    const decoded = decodeProviderProfile(profileLike);
    if (!decoded.ok) {
      const issue = decoded.issues[0];
      profileStatus.textContent = `The profile is not valid: ${issue.path}: ${issue.message}`;
      return;
    }
    const next: WorkspaceSettings = {
      ...s.settings,
      profiles: existingId
        ? s.settings.profiles.map((p) => (p.profileId === existingId ? decoded.value : p))
        : [...s.settings.profiles, decoded.value],
      activeProfileId: decoded.value.profileId,
      credentials: fCredential.value !== '' ? { ...s.settings.credentials, [decoded.value.profileId]: fCredential.value } : s.settings.credentials,
    };
    void core.saveSettings(next).then(() => {
      profileStatus.textContent = `Saved ${decoded.value.label}.`;
      fCredential.value = '';
      render(core.state());
    });
  };
  saveProfileBtn.addEventListener('click', saveProfileFromForm);

  aiToggle.addEventListener('change', () => {
    void core.saveSettings({ ...core.state().settings, aiEnabled: aiToggle.checked });
  });

  const onVisibilityStop = (): void => {
    // Closing the workspace cancels unfinished planning; accepted work stays
    // in the runtime and the saved record (plan/05 §2, plan/03 ui/workspace).
    if (core.state().phase !== 'idle' && core.state().phase !== 'complete' && core.state().phase !== 'stopped' && core.state().phase !== 'failed') {
      void core.stop();
    }
  };
  globalThis.addEventListener?.('pagehide', onVisibilityStop);

  const render = (s: WorkspaceState): void => {
    renderTargets(s);
    renderRun(s);
    renderCustomizations(s);
    renderSettings(s);
    renderDiagnostics(s);
  };

  const unsubscribe = core.subscribe(render);
  void core.init().then(() => render(core.state()));
  // Periodic re-render only while a run is in flight (elapsed timers).
  const ticker = setInterval(() => {
    if (['observing', 'planning', 'applying', 'starting', 'saving'].includes(core.state().phase)) {
      render(core.state());
    }
  }, 1000);

  return {
    core,
    unmount() {
      clearInterval(ticker);
      globalThis.removeEventListener?.('pagehide', onVisibilityStop);
      unsubscribe();
      core.dispose();
      root.textContent = '';
    },
  };
}

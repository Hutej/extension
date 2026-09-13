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
      // Legacy pin fields (S8.3): still accepted so settings persisted by an
      // earlier build decode cleanly — the values are ignored (the target now
      // follows the browser's active tab; no manual pin exists).
      pinnedTabId: optional((v: unknown, p = 'pinnedTabId') => {
        if (v === null) return { ok: true as const, value: null };
        const n = decodeFiniteNumber({ integer: true, min: 0, max: 2 ** 31 })(v, p);
        return n.ok ? { ok: true as const, value: n.value } : n;
      }),
      pinnedFrameId: optional((v: unknown, p = 'pinnedFrameId') => {
        if (v === undefined) return { ok: true as const, value: 0 };
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
      case 'projectCollection':
        note(op.target);
        refs.add(op.sourceSetRef);
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
      case 'projectCollection': {
        const setRef = refToIndex.get(op.sourceSetRef);
        return {
          ...op,
          target: map(op.target),
          ...(setRef !== undefined ? { sourceSetRef: `d${setRef}` } : {}),
        };
      }
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
  /** chrome.tabs.query — titles/urls for the target chip display. */
  listTabs(): Promise<WorkspaceTabInfo[]>;
  /** The browser's ACTIVE tab of this window (the side panel attaches to
   *  the window the user is working in — the page the user is on is the
   *  target, never a manual pick). The implementation may fall back to the
   *  last real web tab when the workspace itself is the active tab (the
   *  extension-tab fallback). */
  activeTabId(): Promise<number | null>;
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
  /** S8.3 permission display: the enclosing frame's origin (browser-derived).
   *  Null for top documents or when the frame tree is unavailable. */
  parentOrigin?: string | null;
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
  /** The ACTIVE tab's registered document — the one and only target. */
  targetDocument: DocumentInfo | null;
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
  /** Re-read the browser's active tab and re-target (the UI polls this).
   *  A run in flight keeps its document — the run owns one target. */
  refreshTarget(): Promise<void>;
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
  /** The browser-reported active tab — the one and only target (the user
   *  never picks a page manually; user-decided UX change, plan/16 §1). */
  let activeTab: number | null = null;
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
      targetDocument: targetDocumentOf(),
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

  /** The current target = the ACTIVE tab's registered document. The top
   *  document (frameId 0) is preferred; a frame-only registration falls
   *  back to that frame (an honest edge, never a guess onto another tab). */
  const targetDocumentOf = (): DocumentInfo | null => {
    if (activeTab === null) return null;
    const mine = documents.filter((d) => d.tabId === activeTab);
    return mine.find((d) => d.frameId === 0) ?? mine[0] ?? null;
  };

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
        parentOrigin: (d.parentOrigin as string | null) ?? null,
        runOwner: d.runOwner === true,
        ...(tab?.title !== undefined ? { title: tab.title } : {}),
        ...(tab?.url !== undefined ? { url: tab.url } : {}),
      };
    });
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
    const doc = targetDocumentOf();
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
        void releaseRun();
        emit('failed', outcome.reason);
        return;
      case 'provider-error':
        finishCounters(outcome.counters);
        ring.add({ context: 'workspace', phase: 'provider', resultCode: outcome.code, detail: outcome.message });
        void releaseRun();
        emit('failed', `The model provider failed (${outcome.code}): ${outcome.message}`);
        return;
      case 'stopped':
        finishCounters(outcome.counters);
        void releaseRun();
        emit('stopped');
        return;
    }
  };

  const start = async (goal: string): Promise<void> => {
    if (phase !== 'idle' && phase !== 'complete' && phase !== 'stopped' && phase !== 'failed' && phase !== 'busy' && phase !== 'conflicted' && phase !== 'applied-unsaved') {
      return; // a run is already in flight — Stop first
    }
    blocked = null;
    const doc = targetDocumentOf();
    if (doc === null) {
      blocked = { reason: 'no-target', text: 'Open the web page you want to change, then type here. If nothing appears, reload that page once.' };
      publish();
      return;
    }
    if (goal.trim() === '') {
      blocked = { reason: 'no-goal', text: 'Type what you want changed on the page, then press Send.' };
      publish();
      return;
    }
    const profile = activeProfile();
    if (!settings.aiEnabled) {
      blocked = {
        reason: 'ai-off',
        text: 'AI planning is off. Saved changes keep working — turn AI on in Settings to make new changes.',
      };
      publish();
      return;
    }
    if (profile === null) {
      blocked = { reason: 'no-profile', text: 'You need an AI provider first. Tap Settings (top right), add one, then try again. Nothing was sent.' };
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

  // The broker holds ONE run owner per document (StartRun); it is released
  // ONLY by CancelRun. Every terminal outcome of a planning run must release
  // it, or the NEXT StartRun is refused as a conflict and the workspace is
  // stuck in 'busy' ("Something is already running") with no way out —
  // worst UX (owner report, 2026-09-13). Best-effort + idempotent.
  const releaseRun = async (): Promise<void> => {
    const doc = targetDocumentOf();
    if (run?.runId !== null && doc !== null) {
      try {
        await send(envelope('run-command', { command: 'CancelRun' }, doc.documentKey, currentEpoch(doc)));
      } catch {
        // best-effort; the runtime fence and page lifecycle bound any work.
      }
    }
  };

  const stop = async (withDetail?: string): Promise<void> => {
    clearQuestionTimer();
    pendingQuestion = null;
    pendingProposal = null;
    abort?.abort();
    abort = null;
    const doc = targetDocumentOf();
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
    const doc = targetDocumentOf();
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
    // The planning run's purpose is fulfilled the moment ApplyBatch is
    // dispatched — release the broker owner now (ApplyBatch is not gated by
    // run ownership), so a new run can start regardless of the receipt.
    void releaseRun();
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
    void releaseRun();
    emit('idle', 'Proposal discarded; nothing was applied.');
  };

  const saveAccepted = async (): Promise<void> => {
    const save = pendingSave;
    const profile = activeProfile();
    if (save === null || profile === null) {
      emit('failed', 'the accepted work lost its save context');
      return;
    }
    // S8.3 frame boundary (plan/12 §3): frame transformations are
    // session-only in the first frame release. The applied change stays live
    // until the run ends; no persistent frame scope is saved (never a saved
    // frame index — a later scope-schema ADR owns that boundary).
    const runDoc = targetDocumentOf();
    if (runDoc !== null && runDoc.frameId !== 0) {
      pendingSave = null;
      emit('applied-unsaved', 'Frame transformations are session-only in this release: the change stays applied in this frame until the run ends or the tab reloads, but it is not saved — a persistent frame scope is a future capability.');
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
    const doc = targetDocumentOf();
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
      origin: targetDocumentOf()?.origin ?? '',
      customizationId,
      enabled,
      expectedRecordRevision: ctx.expectedRecordRevision,
      mutationId: newMutationId(),
    }));

  const removeCustomization = (customizationId: string): Promise<void> =>
    mutateRecord((ctx) => ({
      command: 'RemoveCustomization',
      origin: targetDocumentOf()?.origin ?? '',
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
    try {
      activeTab = await deps.activeTabId();
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
      targetDocument: targetDocumentOf(),
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
    async refreshTarget() {
      // A run in flight keeps its document — one run, one target.
      const inFlight = ['starting', 'observing', 'planning', 'awaiting-question', 'awaiting-approval', 'applying', 'saving'].includes(phase);
      const next = await deps.activeTabId();
      const changed = next !== activeTab;
      if (!inFlight) activeTab = next;
      if (changed && !inFlight) {
        await refreshDocuments();
      } else {
        publish();
      }
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
// ── DOM mount (native controls only; all text through text nodes) ─────────

const WORKSPACE_CSS = `
  :host, html, body { margin: 0; padding: 0; height: 100%; }
  body { font: 13px/1.5 system-ui, -apple-system, sans-serif; color: #1b1d22; background: #f4f5f7; }
  * { box-sizing: border-box; }
  .sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
  main.rv-app { display: flex; flex-direction: column; height: 100vh; max-width: none; margin: 0; padding: 0; gap: 0; }

  .rv-header { display: flex; align-items: center; gap: 8px; padding: 10px 12px; background: #fff; border-bottom: 1px solid #e2e4ea; }
  .rv-brand { font-weight: 700; font-size: 14px; }
  #rv-chip { flex: 1; min-width: 0; font-size: 12px; color: #555a66; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #rv-chip b { color: #1b1d22; font-weight: 600; }
  .rv-header button { flex-shrink: 0; }

  .rv-view { flex: 1; min-height: 0; overflow-y: auto; padding: 12px; }
  .rv-view[hidden] { display: none; }

  #rv-chat { display: flex; flex-direction: column; gap: 8px; }
  .msg { max-width: 88%; padding: 8px 11px; border-radius: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
  .msg.user { align-self: flex-end; background: #dbeafe; }
  .msg.rev { align-self: flex-start; background: #fff; border: 1px solid #e2e4ea; }
  .msg.ok { align-self: flex-start; background: #e8f4e9; border: 1px solid #cde8cf; }
  .msg.error { align-self: flex-start; background: #fdeeec; border: 1px solid #f2c4c0; }
  .msg.warn { align-self: flex-start; background: #fdf6e0; border: 1px solid #eadfb8; }
  .card { align-self: stretch; background: #fff; border: 1px solid #d9dbe2; border-radius: 10px; padding: 10px 12px; }
  .card h3 { margin: 0 0 6px; font-size: 13px; }
  .card ul.plain { list-style: none; margin: 6px 0; padding: 0; }
  .card ul.plain li { padding: 3px 0 3px 18px; position: relative; }
  .card ul.plain li::before { content: '•'; position: absolute; left: 8px; color: #555a66; }

  .rv-input-row { display: flex; gap: 8px; padding: 10px 12px; background: #fff; border-top: 1px solid #e2e4ea; }
  .rv-input-row textarea { flex: 1; font: inherit; padding: 8px 10px; border: 1px solid #b9bdcb; border-radius: 10px; resize: none; min-height: 40px; max-height: 120px; }
  .rv-input-row textarea:focus-visible { outline: 2px solid #1d4ed8; outline-offset: 1px; }

  button { font: inherit; padding: 6px 12px; border-radius: 8px; border: 1px solid #848aa0; background: #fff; cursor: pointer; }
  button:hover { background: #f0f2ff; }
  button:focus-visible { outline: 2px solid #1d4ed8; outline-offset: 1px; }
  button.primary { background: #1d4ed8; border-color: #1d4ed8; color: #fff; }
  button.primary:hover { background: #1e40af; }
  button.danger { color: #b3261e; border-color: #b3261e; }
  button:disabled { opacity: .55; cursor: not-allowed; }

  .muted { color: #555a66; font-size: 12px; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
  ul.plain { list-style: none; margin: 6px 0; padding: 0; }
  ul.plain li { background: #fff; border: 1px solid #e2e4ea; border-radius: 10px; padding: 10px 12px; margin-bottom: 8px; }
  ul.plain .cust-head { display: flex; gap: 8px; justify-content: space-between; flex-wrap: wrap; }
  fieldset { border: 1px solid #d9dbe2; border-radius: 10px; margin: 0 0 12px; padding: 10px 12px; }
  fieldset legend { font-weight: 600; padding: 0 4px; }
  label { display: block; margin: 8px 0 2px; }
  input[type=text], input[type=url], input[type=password], select, textarea {
    width: 100%; font: inherit; padding: 6px 8px; border: 1px solid #b9bdcb; border-radius: 8px; background: #fff;
  }
  details { margin: 12px 0; }
  details summary { cursor: pointer; font-weight: 600; }
  dl.kv { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; margin: 6px 0; }
  dl.kv dt { font-weight: 600; }
  pre.diag { font-size: 11px; background: #f1f2f6; border-radius: 8px; padding: 8px; overflow-x: auto; }
  .hidden { display: none; }
`;

interface ChatMessage {
  role: 'user' | 'rev';
  text: string;
  tone?: 'ok' | 'warn' | 'error';
}

/** Beginner-friendly wording for each run phase — the chat voice. */
function chatPhaseText(
  phase: WorkspacePhase,
  ctx: { profileLabel?: string; detail?: string; elapsedMs?: number } = {},
): string | null {
  const detail = ctx.detail ?? '';
  switch (phase) {
    case 'idle':
      return null;
    case 'starting':
      return 'Getting started…';
    case 'observing':
      return 'Reading your page…';
    case 'planning':
      return `Thinking (with ${ctx.profileLabel ?? 'your AI'})… this can take a moment — press Stop anytime.`;
    case 'awaiting-question':
      return 'Quick question before I continue:';
    case 'awaiting-approval':
      return "Here's my plan. Look it over, then press Apply — nothing changes on your page until you do.";
    case 'applying':
      return 'Applying and double-checking…';
    case 'saving':
      return 'Saving so it comes back next time you visit…';
    case 'complete':
      return `Done — applied and saved.${detail}`;
    case 'applied-unsaved':
      return `Applied on this page, but saving didn't work.${detail} Your change stays in this tab for now.`;
    case 'conflicted':
      return `Applied, with one thing to note.${detail}`;
    case 'stopped':
      return 'Stopped. Changes that were already approved stay.';
    case 'failed':
      return detail || "That didn't work — check the message above, then try again.";
    case 'busy':
      return 'Something is already running on this page. Press Stop first.';
  }
}

export function mountWorkspace(root: HTMLElement, deps: WorkspaceDeps): { unmount(): void; core: WorkspaceCore } {
  const core = createWorkspaceCore(deps);
  const doc = root.ownerDocument ?? document;

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const style = el('style');
  style.textContent = WORKSPACE_CSS;

  // ── static skeleton: header + three views ────────────────────────────
  const main = el('main');
  main.className = 'rv-app';

  const header = el('header');
  header.className = 'rv-header';
  const brand = el('span', 'Revueon');
  brand.className = 'rv-brand';
  const chip = el('span', 'No page yet');
  chip.id = 'rv-chip';
  chip.setAttribute('role', 'status');
  chip.setAttribute('aria-live', 'polite');
  const changesBtn = el('button', 'My changes');
  changesBtn.type = 'button';
  changesBtn.title = 'See and manage the changes saved for this site';
  const settingsBtn = el('button', 'Settings');
  settingsBtn.type = 'button';
  settingsBtn.setAttribute('aria-label', 'Settings — AI provider and options');
  header.append(brand, chip, changesBtn, settingsBtn);

  // Screen-reader live region carrying the same phase text (also the
  // stable status oracle for tests).
  const statusLive = el('div');
  statusLive.id = 'rv-status';
  statusLive.className = 'sr-only';
  statusLive.setAttribute('role', 'status');
  statusLive.setAttribute('aria-live', 'polite');

  // Chat view
  const chatView = el('section');
  chatView.className = 'rv-view';
  chatView.id = 'rv-chat-view';
  const chatLog = el('div');
  chatLog.id = 'rv-chat';
  chatLog.setAttribute('role', 'log');
  chatLog.setAttribute('aria-label', 'Conversation');
  const cards = el('div');
  cards.id = 'rv-cards';
  const inputRow = el('div');
  inputRow.className = 'rv-input-row';
  const goalInput = doc.createElement('textarea');
  goalInput.id = 'rv-goal';
  goalInput.setAttribute('aria-label', 'What should change on this page?');
  goalInput.placeholder = 'What should change on this page?';
  goalInput.rows = 2;
  const sendBtn = el('button', 'Send');
  sendBtn.type = 'button';
  sendBtn.className = 'primary';
  const stopBtn = el('button', 'Stop');
  stopBtn.type = 'button';
  stopBtn.className = 'danger';
  inputRow.append(goalInput, sendBtn, stopBtn);
  chatView.append(chatLog, cards, inputRow);

  // Settings view (separate page — plan/16 §1)
  const settingsView = el('section');
  settingsView.className = 'rv-view';
  settingsView.id = 'rv-settings-view';
  settingsView.hidden = true;
  const backFromSettings = el('button', '← Back');
  backFromSettings.type = 'button';
  backFromSettings.setAttribute('aria-label', 'Back to chat');
  const settingsHeading = el('h2', 'Settings');
  const profileField = el('fieldset');
  const profileLegend = el('legend', 'AI provider');
  const profileSelect = doc.createElement('select');
  profileSelect.id = 'rv-profile';
  profileSelect.setAttribute('aria-label', 'Active provider profile');
  const newProfileBtn = el('button', 'New provider');
  newProfileBtn.type = 'button';
  profileField.append(profileLegend, profileSelect, newProfileBtn);
  const providerForm = el('fieldset');
  const providerLegend = el('legend', 'Provider details');
  const fLabel = el('label', 'Name (anything you like)');
  fLabel.htmlFor = 'rv-p-label';
  const fLabelInput = doc.createElement('input');
  fLabelInput.id = 'rv-p-label';
  fLabelInput.type = 'text';
  fLabelInput.placeholder = 'My AI';
  const fEndpointLabel = el('label', 'Endpoint URL (https, or http on localhost)');
  fEndpointLabel.htmlFor = 'rv-p-endpoint';
  const fEndpoint = doc.createElement('input');
  fEndpoint.id = 'rv-p-endpoint';
  fEndpoint.type = 'url';
  fEndpoint.placeholder = 'https://api.example.com/v1/chat/completions';
  const fModelLabel = el('label', 'Model id (from your provider)');
  fModelLabel.htmlFor = 'rv-p-model';
  const fModel = doc.createElement('input');
  fModel.id = 'rv-p-model';
  fModel.type = 'text';
  fModel.placeholder = 'gpt-4o-mini, claude-…, your-server-model…';
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
  fHeader.parentElement?.classList.toggle('hidden', true);
  const fCredentialLabel = el('label', 'API key — stored only on this computer, never shown again');
  fCredentialLabel.htmlFor = 'rv-p-credential';
  const fCredential = doc.createElement('input');
  fCredential.id = 'rv-p-credential';
  fCredential.type = 'password';
  fCredential.autocomplete = 'off';
  const saveProfileBtn = el('button', 'Save provider');
  saveProfileBtn.type = 'button';
  saveProfileBtn.className = 'primary';
  const profileStatus = el('p');
  profileStatus.className = 'muted';
  profileStatus.id = 'rv-profile-status';
  const protocolNote = el('p', 'Works with any OpenAI-compatible or Anthropic-compatible endpoint (openai-chat or anthropic-messages).');
  protocolNote.className = 'muted';
  const fProtocol = doc.createElement('input');
  fProtocol.type = 'hidden';
  fProtocol.id = 'rv-p-protocol';
  fProtocol.value = 'openai-chat';
  providerForm.append(providerLegend, fLabel, fLabelInput, fEndpointLabel, fEndpoint, fModelLabel, fModel, fAuthLabel, fAuth, fHeaderLabel, fHeader, fCredentialLabel, fCredential, saveProfileBtn, protocolNote, fProtocol, profileStatus);
  settingsView.append(backFromSettings, settingsHeading, profileField, providerForm);

  const aiField = el('fieldset');
  const aiLegend = el('legend', 'AI on/off');
  const aiToggleLabel = el('label');
  const aiToggle = doc.createElement('input');
  aiToggle.type = 'checkbox';
  aiToggle.id = 'rv-ai-toggle';
  aiToggleLabel.append(aiToggle, doc.createTextNode(' Let Revueon use the AI provider to plan changes'));
  aiField.append(aiLegend, aiToggleLabel);

  const consentBox = el('fieldset');
  const consentLegend = el('legend', 'Privacy acknowledgement');
  consentBox.append(consentLegend);

  const openTabNote = el('p', 'Prefer a full window? ');
  openTabNote.className = 'muted';
  const openTabBtn = el('button', 'Open this workspace in a tab');
  openTabBtn.type = 'button';
  openTabBtn.title = 'Side panel unavailable? The same workspace runs as an extension tab.';
  openTabNote.append(openTabBtn);

  const diagnostics = doc.createElement('details');
  const diagSummary = el('summary', 'Diagnostics (technical)');
  const diagBody = el('div');
  diagnostics.append(diagSummary, diagBody);

  settingsView.append(aiField, consentBox, openTabNote, diagnostics);

  // Changes view (separate page)
  const changesView = el('section');
  changesView.className = 'rv-view';
  changesView.id = 'rv-changes-view';
  changesView.hidden = true;
  const backFromChanges = el('button', '← Back');
  backFromChanges.type = 'button';
  backFromChanges.setAttribute('aria-label', 'Back to chat');
  const changesHeading = el('h2', 'My changes on this site');
  const custNote = el('p');
  custNote.className = 'muted';
  const custList = el('ul');
  custList.className = 'plain';
  changesView.append(backFromChanges, changesHeading, custNote, custList);

  main.append(header, chatView, settingsView, changesView, statusLive);
  root.textContent = '';
  root.append(style, main);

  // ── view switching ──────────────────────────────────────────────────
  let view: 'chat' | 'settings' | 'changes' = 'chat';
  const showView = (next: typeof view): void => {
    view = next;
    chatView.hidden = view !== 'chat';
    settingsView.hidden = view !== 'settings';
    changesView.hidden = view !== 'changes';
  };
  changesBtn.addEventListener('click', () => { showView('changes'); render(core.state()); });
  settingsBtn.addEventListener('click', () => { showView('settings'); render(core.state()); });
  backFromSettings.addEventListener('click', () => { showView('chat'); render(core.state()); });
  backFromChanges.addEventListener('click', () => { showView('chat'); render(core.state()); });

  // ── chat log ─────────────────────────────────────────────────────────
  const chat: ChatMessage[] = [];
  const say = (m: ChatMessage): void => { chat.push(m); };
  let lastSign: string | null = null;

  const send = (): void => {
    const goal = goalInput.value.trim();
    if (goal !== '') {
      say({ role: 'user', text: goal });
      goalInput.value = '';
    }
    void core.start(goal);
  };
  sendBtn.addEventListener('click', send);
  goalInput.addEventListener('keydown', (ev) => {
    if ((ev as KeyboardEvent).key === 'Enter' && !(ev as KeyboardEvent).shiftKey) {
      ev.preventDefault();
      send();
    }
  });
  stopBtn.addEventListener('click', () => void core.stop());

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
      case 'relocate': {
        const relocateBase = `move ${firstRef(op.target)} ${op.position} ${firstRef(op.destination)} — the same node with its listeners, new parent`;
        return op.structuralGrant === true
          ? `${relocateBase} — HIGH RISK: a framework replacement can break it; the site's position always wins and relocation suspends after two overrides`
          : relocateBase;
      }
      case 'float':
        return `float the existing surface at ${firstRef(op.target)} to the ${op.edge} corner (min: ${op.width ?? 'responsive 24rem'} × ${op.maxHeight ?? '50vh'}; minimize control included) — it is your page's own node, not a copy; undo returns it to normal flow`;
      case 'bindKey': {
        const base = `bind “${op.chord}” → ${op.actionIds.join(', ')} on ${firstRef(op.target)}`;
        const consequential = op.actionIds.some((a) => (CONSEQUENTIAL_BIND_ACTIONS as ReadonlySet<string>).has(a));
        return consequential
          ? `${base} — pressing it activates this page's own control; undo removes the shortcut, not any effect it causes`
          : base;
      }
      case 'collapse':
        return `add a disclosure toggle “${op.label}” ${op.placement ?? 'before'} ${firstRef(op.target)} (starts ${op.initialState ?? 'collapsed'}; you can always expand)`;
      case 'projectCollection': {
        const base = `project a linked ${op.view} of the items in ${op.sourceSetRef} (${op.fields.map((f) => f.sourceField).join(', ')}) next to ${firstRef(op.target)} — arranging it changes your local view only, never the site`;
        return op.showOriginal === false
          ? `${base}; the original list will be hidden on the open page (undo restores it)`
          : base;
      }
      case 'localRule': {
        const base = `rule: when a new matching element appears ${firstRef(op.target)}`;
        if (op.actionId === 'activateDisclosure') {
          return `${base}, click its own disclosure control automatically — undo removes the rule, not collapses it already caused`;
        }
        if (op.actionId === 'focus') return `${base}, focus it`;
        return `${base}, ${op.actionId}`;
      }
      default:
        return `${(op as import('../contracts.ts').Operation).kind} (no preview yet)`;
    }
  };

  const renderChat = (s: WorkspaceState): void => {
    // A phase/blocked transition becomes one chat message — never a spam
    // loop (the signature only changes when the meaning changes).
    const blockedText = s.blocked !== null && s.phase === 'idle' ? s.blocked.text : null;
    const phaseText = blockedText !== null ? blockedText : chatPhaseText(s.phase, {
      profileLabel: core.activeProfile()?.label,
      detail: s.statusDetail ?? undefined,
    });
    const sign = `${s.phase}|${blockedText ?? s.statusDetail ?? ''}`;
    if (sign !== lastSign && phaseText !== null) {
      const tone = s.phase === 'complete' ? 'ok' : s.phase === 'failed' || s.phase === 'applied-unsaved' ? 'error' : s.phase === 'conflicted' || s.phase === 'busy' ? 'warn' : undefined;
      say({ role: 'rev', text: phaseText, ...(tone ? { tone } : {}) });
    }
    lastSign = sign;

    chatLog.textContent = '';
    for (const m of chat) {
      const bubble = el('div', m.text);
      bubble.className = `msg ${m.role === 'user' ? 'user' : m.tone !== undefined ? `rev ${m.tone}` : 'rev'}`;
      chatLog.append(bubble);
    }
    chatLog.scrollTop = chatLog.scrollHeight;
  };

  let cardsSign: string | null = null;
  const renderCards = (s: WorkspaceState): void => {
    // Only rebuild when the card-relevant state changed: a state push (live
    // counters, seq bumps) must not recreate the Apply button mid-click.
    const sign = JSON.stringify([
      s.pendingQuestion?.questionId ?? null,
      s.pendingProposal !== null && s.phase === 'awaiting-approval' ? s.pendingProposal.summary : null,
      s.phase === 'applied-unsaved' && s.pendingSave !== null ? s.pendingSave.customizationId : null,
    ]);
    if (sign === cardsSign) return;
    cardsSign = sign;
    cards.textContent = '';
    if (s.pendingQuestion !== null) {
      const card = el('div');
      card.className = 'card';
      const q = el('h3', s.pendingQuestion.question.question);
      card.append(q);
      for (const option of s.pendingQuestion.question.options) {
        const b = el('button', option);
        b.type = 'button';
        b.addEventListener('click', () => { say({ role: 'user', text: option }); void core.answerQuestion(option); });
        card.append(b, doc.createTextNode(' '));
      }
      const answerLabel = el('label', 'Or type your own answer');
      answerLabel.htmlFor = 'rv-answer';
      const answerInput = doc.createElement('input');
      answerInput.id = 'rv-answer';
      answerInput.type = 'text';
      const sendBtn2 = el('button', 'Send answer');
      sendBtn2.type = 'button';
      sendBtn2.className = 'primary';
      const sendOwn = (): void => {
        const value = answerInput.value.trim();
        if (value !== '') { say({ role: 'user', text: value }); void core.answerQuestion(value); }
      };
      sendBtn2.addEventListener('click', sendOwn);
      answerInput.addEventListener('keydown', (ev) => { if ((ev as KeyboardEvent).key === 'Enter') sendOwn(); });
      card.append(answerLabel, answerInput, sendBtn2);
      cards.append(card);
    }
    if (s.pendingProposal !== null && s.phase === 'awaiting-approval') {
      const card = el('div');
      card.className = 'card';
      const head = el('h3', `Proposed: ${s.pendingProposal.summary}`);
      card.append(head);
      const ops = el('ul');
      ops.className = 'plain';
      for (const op of s.pendingProposal.operations.slice(0, 16)) {
        ops.append(el('li', `${op.kind} — ${describeOperation(op)}`));
      }
      card.append(ops);
      const scopeLabel = el('label', 'Keep it for');
      scopeLabel.htmlFor = 'rv-scope';
      const scopeSelect = doc.createElement('select');
      scopeSelect.id = 'rv-scope';
      let path = '/';
      try { path = s.targetDocument?.url ? new URL(s.targetDocument.url).pathname || '/' : '/'; } catch { path = '/'; }
      const modes: Array<{ mode: RouteScope['mode']; text: string }> = [
        { mode: 'exactPath', text: 'just this page' },
        { mode: 'pathPrefix', text: `pages under ${path}` },
        { mode: 'origin', text: 'the whole site' },
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
      const row = el('div');
      row.className = 'row';
      row.append(applyBtn, discardBtn);
      card.append(scopeLabel, scopeSelect, row);
      cards.append(card);
    }
    if (s.phase === 'applied-unsaved' && s.pendingSave !== null) {
      const card = el('div');
      card.className = 'card';
      const hint = el('p', 'Your change is applied in this tab only. Retry save writes it permanently; reloading the tab clears unsaved work.');
      hint.className = 'muted';
      const retryBtn = el('button', 'Retry save');
      retryBtn.type = 'button';
      retryBtn.className = 'primary';
      retryBtn.addEventListener('click', () => void core.retrySave());
      card.append(hint, retryBtn);
      cards.append(card);
    }
  };

  const renderHeader = (s: WorkspaceState): void => {
    if (s.targetDocument !== null) {
      const name = s.targetDocument.title ? s.targetDocument.title.slice(0, 60) : 'this page';
      chip.textContent = '';
      chip.append(doc.createTextNode('Working on: '), el('b', name), doc.createTextNode(` — ${s.targetDocument.origin ?? 'unknown origin'}`));
    } else {
      chip.textContent = 'No page yet — open a website, then come back here';
    }
    const count = s.record?.customizations.length ?? 0;
    changesBtn.textContent = `My changes${count > 0 ? ` (${count})` : ''}`;
  };

  // Keyed change entries: a state push updates text in place — the real
  // checkbox is never recreated mid-click (Playwright/humans both stay
  // stable while live state streams in).
  const custEls = new Map<string, { li: HTMLLIElement; title: HTMLElement; scope: HTMLElement; toggle: HTMLInputElement; liveText: HTMLElement; undoWrap: HTMLElement }>();
  const renderChanges = (s: WorkspaceState): void => {
    if (s.record === null || s.record.customizations.length === 0) {
      custNote.textContent = s.recordError ?? 'No saved changes for this site yet. Ask for a change in the chat, then press Apply.';
      custList.textContent = '';
      custEls.clear();
      return;
    }
    custNote.textContent = 'These changes apply automatically every time you visit this site — no AI needed after saving.';
    const liveKey = s.targetDocument !== null ? `${s.targetDocument.documentKey.tabId}:${s.targetDocument.documentKey.frameId}:${s.targetDocument.documentKey.browserDocumentId}` : null;
    const liveEntries = liveKey !== null ? (s.live[liveKey]?.customizations ?? []) : [];
    for (const [id, entry] of [...custEls]) {
      if (!s.record.customizations.some((c) => c.customizationId === id)) {
        entry.li.remove();
        custEls.delete(id);
      }
    }
    for (const cust of s.record.customizations) {
      const live = liveEntries.find((e) => e.customizationId === cust.customizationId);
      let entry = custEls.get(cust.customizationId);
      if (entry === undefined) {
        const li = el('li');
        const head = el('div');
        head.className = 'cust-head';
        const title = el('strong');
        head.append(title);
        const scope = el('span');
        scope.className = 'muted';
        head.append(scope);
        const toggleLabel = el('label');
        const toggle = doc.createElement('input');
        toggle.type = 'checkbox';
        toggle.addEventListener('change', () => void core.setEnabled(cust.customizationId, toggle.checked));
        toggleLabel.append(toggle, doc.createTextNode(' on'));
        const liveText = el('p');
        liveText.className = 'muted';
        const undoWrap = el('span');
        const undoBtn = el('button', 'Undo latest revision');
        undoBtn.type = 'button';
        undoBtn.addEventListener('click', () => void core.undoLatestRevision(cust.customizationId));
        undoWrap.append(undoBtn, doc.createTextNode(' '));
        const removeBtn = el('button', 'Remove');
        removeBtn.type = 'button';
        removeBtn.className = 'danger';
        removeBtn.addEventListener('click', () => void core.removeCustomization(cust.customizationId));
        li.append(head, toggleLabel, liveText, undoWrap, removeBtn);
        entry = { li: li as HTMLLIElement, title, scope, toggle, liveText, undoWrap };
        custEls.set(cust.customizationId, entry);
      }
      entry.title.textContent = cust.title;
      entry.scope.textContent = scopeText(cust.scope);
      entry.toggle.checked = cust.enabled;
      entry.liveText.textContent = liveStateText(live?.state, live?.detail, cust.enabled);
      const activeIdx = cust.revisions.findIndex((r) => r.revisionId === cust.activeRevisionId);
      entry.undoWrap.hidden = activeIdx <= 0;
      custList.append(entry.li);
    }
  };

  const renderSettingsView = (s: WorkspaceState): void => {
    profileSelect.textContent = '';
    if (s.settings.profiles.length === 0) {
      const o = doc.createElement('option');
      o.value = '';
      o.textContent = '(no providers yet — add one below)';
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

    consentBox.textContent = '';
    consentBox.append(el('legend', 'Privacy acknowledgement'));
    const profile = core.activeProfile();
    if (profile === null) {
      const p = el('p', 'Add and save a provider first — nothing is sent anywhere yet.');
      p.className = 'muted';
      consentBox.append(p);
    } else {
      const ack = s.settings.consentAcks.find((a) => a.endpoint === profile.endpoint);
      const consented = evaluateProviderConsent(ack, profile.endpoint).ok;
      const disclosure = el('p',
        `One-time OK: page details and your request are sent to ${profile.endpoint} so the AI can plan the change. That provider's own rules apply to what it receives. Saved changes stay on this computer.`);
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
    const add = (k: string, v: string): void => { dl.append(el('dt', k), el('dd', v)); };
    add('phase', s.phase);
    if (s.targetDocument !== null) {
      const key = `${s.targetDocument.documentKey.tabId}:${s.targetDocument.documentKey.frameId}:${s.targetDocument.documentKey.browserDocumentId}`;
      const liveState = s.live[key];
      add('target document', `tab ${s.targetDocument.tabId}, epoch ${liveState?.routeEpoch ?? s.targetDocument.routeEpoch}, runtime ${liveState?.lifecycle ?? 'unknown'}`);
      add('saved record revision', s.record !== null ? String(s.record.recordRevision) : (s.recordError ?? 'none'));
      add('live customizations on this page', String(liveState?.customizations.length ?? 0));
    } else {
      add('target document', 'none');
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

  // ── settings wiring (provider form) ─────────────────────────────────
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
      protocol: fProtocol.value === 'anthropic-messages' ? 'anthropic-messages' as const : 'openai-chat' as const,
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
      profileStatus.textContent = `The provider is not valid: ${issue.path}: ${issue.message}`;
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

  openTabBtn.addEventListener('click', () => {
    const url = typeof chrome !== 'undefined' && chrome.runtime?.getURL ? chrome.runtime.getURL('sidepanel.html') : '/sidepanel.html';
    void globalThis.open?.(url, '_blank');
  });

  const onVisibilityStop = (): void => {
    if (core.state().phase !== 'idle' && core.state().phase !== 'complete' && core.state().phase !== 'stopped' && core.state().phase !== 'failed') {
      void core.stop();
    }
  };
  globalThis.addEventListener?.('pagehide', onVisibilityStop);

  const render = (s: WorkspaceState): void => {
    renderHeader(s);
    if (view === 'chat') {
      renderChat(s);
      renderCards(s);
    }
    if (view === 'settings') {
      renderSettingsView(s);
      renderDiagnostics(s);
    }
    if (view === 'changes') {
      renderChanges(s);
    }
    // Input state + the stable status oracle.
    // 'busy' (another run owns the document) must offer Stop, else "Press
    // Stop first" is a dead-end with the button disabled (owner report).
    const inFlight = ['starting', 'observing', 'planning', 'awaiting-question', 'awaiting-approval', 'applying', 'saving', 'busy'].includes(s.phase);
    sendBtn.disabled = inFlight;
    stopBtn.disabled = !inFlight;
    const statusView = statusFor(s.phase, {
      profileLabel: core.activeProfile()?.label,
      elapsedMs: s.run?.startedAt != null ? deps.now() - s.run.startedAt : undefined,
      detail: s.statusDetail ?? undefined,
    });
    statusLive.textContent = s.blocked !== null && s.phase === 'idle' ? s.blocked.text : statusView.text;
  };

  const unsubscribe = core.subscribe(render);
  void core.init().then(() => render(core.state()));

  // The target follows the user: poll the browser's active tab. One run
  // keeps its own target while in flight.
  const poller = setInterval(() => { void core.refreshTarget(); }, 1500);

  return {
    core,
    unmount() {
      clearInterval(poller);
      globalThis.removeEventListener?.('pagehide', onVisibilityStop);
      unsubscribe();
      core.dispose();
      root.textContent = '';
    },
  };
}

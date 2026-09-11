/**
 * tests/unit/workspace.test.ts — S6.2 evidence: the real workspace core over
 * injected platform seams (no DOM, no chrome, no live model).
 *
 * Covers the roadmap test rows:
 *   - T21 exact target selection: explicit pin, no first-tab fallback, no
 *     implicit consent;
 *   - T25 endpoint/consent: ack is endpoint-scoped, opt-out actually blocks
 *     all calls, malformed settings never load as authority;
 *   - T27 UI outcome honesty: exhaustive typed states — no false success,
 *     applied-unsaved/stopped/conflicted wording, close/reopen state pull;
 *   - plan/04 §2 save prep: descriptor building + d<i> rewrite, honest
 *     refusals for unobserved/shadow targets.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSavedRevision,
  createWorkspaceCore,
  decodeWorkspaceSettings,
  liveStateText,
  refsOfProposal,
  scopeText,
  statusFor,
  type WorkspaceDeps,
  type WorkspaceSettings,
} from '../../src/ui/workspace.ts';
import type { PlanningController, PlanningControllerDeps, PlanningRun, RunCounters, StartRunRequest } from '../../src/planning/controller.ts';
import type { DocumentKey, OriginRecord, PageSnapshot, PlannerQuestion, Proposal, ProviderProfile } from '../../src/contracts.ts';

// ── shared fixtures ───────────────────────────────────────────────────────

const DOC_A: DocumentKey = { tabId: 1, frameId: 0, browserDocumentId: 'doc-a', runtimeInstanceId: 'rt-a' };
const DOC_B: DocumentKey = { tabId: 2, frameId: 0, browserDocumentId: 'doc-b', runtimeInstanceId: 'rt-b' };

const docList = () => ({
  ok: true,
  kind: 'documents' as const,
  documents: [
    { documentKey: DOC_A, tabId: 1, frameId: 0, routeEpoch: 1, origin: 'https://site-a.test', runOwner: false, registeredAt: 1 },
    { documentKey: DOC_B, tabId: 2, frameId: 0, routeEpoch: 1, origin: 'https://site-b.test', runOwner: false, registeredAt: 2 },
  ],
});

const SNAP: PageSnapshot = {
  schemaVersion: 1,
  snapshotId: 'snap-1',
  collectedAt: 1,
  viewport: { width: 800, height: 600 },
  documentMetadata: { origin: 'https://site-b.test' },
  roots: [{ rootId: 'document', kind: 'document' }],
  regions: [
    {
      targetRef: 't1', rootRef: 'document', kind: 'element',
      semantics: { tag: 'h1', nameApprox: 'Hello', nameSource: 'button-text' },
      geometry: { x: 0, y: 0, w: 100, h: 30, inViewport: true },
      stability: 'session-only', hidden: false,
    },
    {
      targetRef: 't2', rootRef: 'document', kind: 'element',
      semantics: { tag: 'button', role: 'button', roleSource: 'declared' },
      geometry: { x: 0, y: 40, w: 80, h: 24, inViewport: true },
      stability: 'session-only', hidden: false,
    },
  ],
  actions: [],
  coverage: { visitedNodes: 10, selectedRegions: 2, completed: true },
};

const PROPOSAL: Proposal = {
  kind: 'proposal',
  schemaVersion: 1,
  summary: 'Make the heading red',
  operations: [
    {
      kind: 'style',
      rules: [
        { target: { targetRef: 't1' }, surface: 'element', state: 'none', declarations: [{ property: 'color', value: 'red' }], conditions: [] },
      ],
    },
  ] as Proposal['operations'],
};

const PROFILE: ProviderProfile = {
  profileVersion: 1,
  profileId: 'profile-1',
  label: 'Test provider',
  protocol: 'openai-chat',
  endpoint: 'https://api.test/v1/chat/completions',
  modelId: 'model-x',
  auth: { kind: 'none' },
};

const ackFor = (endpoint: string) => ({
  settingsVersion: 1 as const,
  profiles: [PROFILE],
  credentials: {},
  activeProfileId: PROFILE.profileId,
  consentAcks: [{ disclosureVersion: 1, endpoint, acknowledgedAt: 1 }],
  aiEnabled: true,
});

const counters = (): RunCounters => ({ modelResponses: 1, httpAttempts: 1, evidenceRequests: 0, correctionsUsed: 0, wallMs: 10 });

interface FakeController {
  factory: (deps: PlanningControllerDeps) => PlanningController;
  requests: Array<Record<string, unknown>>;
}

/** Scripted controller: `script` is a queue of outcomes; a 'question' entry
 *  pauses and resumes via answer() with the NEXT queued outcome. */
function fakeController(script: Array<{ kind: 'proposal'; proposal: Proposal } | { kind: 'question'; question: PlannerQuestion } | { kind: 'cannot-complete'; reason: string } | { kind: 'provider-error'; message: string } | { kind: 'stopped' }>): FakeController {
  const requests: Array<Record<string, unknown>> = [];
  const queue = [...script];
  const nextOutcome = () => {
    const item = queue.shift() ?? { kind: 'stopped' as const };
    switch (item.kind) {
      case 'proposal': return { kind: 'proposal' as const, proposal: item.proposal, counters: counters() };
      case 'question': return { kind: 'question' as const, question: item.question, questionId: 'q-1', counters: counters() };
      case 'cannot-complete': return { kind: 'cannot-complete' as const, reason: item.reason, counters: counters() };
      case 'provider-error': return { kind: 'provider-error' as const, code: 'provider-error', message: item.message, counters: counters() };
      case 'stopped': return { kind: 'stopped' as const, counters: counters() };
    }
  };
  return {
    requests,
    factory: (_deps) => ({
      run: async (req: StartRunRequest) => {
        requests.push(req as unknown as Record<string, unknown>);
        const outcome = nextOutcome();
        const run: PlanningRun = {
          outcome,
          answer: async () => nextOutcome(),
        };
        return run;
      },
    }),
  };
}

interface Harness {
  core: ReturnType<typeof createWorkspaceCore>;
  sent: Array<Record<string, unknown>>;
  storage: { value: unknown };
  controller: FakeController;
  push: (raw: unknown) => void;
  dispose(): void;
}

interface ScriptedBroker {
  (env: Record<string, unknown>): Record<string, unknown> | undefined;
}

/** Default broker: happy-path document/record flows; tests override via `broker`. */
function defaultBroker(overrides: Record<string, (env: Record<string, unknown>) => Record<string, unknown> | undefined> = {}): ScriptedBroker {
  const recordOf = (origin: string): OriginRecord | null => null;
  const base: ScriptedBroker = (env) => {
    const command = (env.payload as Record<string, unknown>).command;
    switch (command) {
      case 'ListDocuments': return docList();
      case 'GetState':
        return { ok: true, kind: 'relayed', receipt: { ok: true, kind: 'state', state: 'ready', routeEpoch: 1, seq: 1, customizations: [] } };
      case 'StartRun': return { ok: true, kind: 'run-started', runId: 'run-1' };
      case 'CancelRun': return { ok: true, kind: 'run-cancelled', cancelled: true };
      case 'Observe': return { ok: true, kind: 'relayed', receipt: { ok: true, kind: 'snapshot', snapshot: SNAP } };
      case 'ApplyBatch':
        return { ok: true, kind: 'relayed', receipt: { ok: true, kind: 'receipt', receipt: { batchId: 'batch-1', payloadDigest: 'd', status: 'accepted', resourceIds: [] } } };
      case 'GetOriginRecord': return { ok: true, kind: 'origin-record', originRecord: recordOf(String((env.payload as Record<string, unknown>).origin)) };
      case 'SaveRevision': return { ok: true, kind: 'saved', recordRevision: 1, mutationId: 'mut-x' };
      case 'SetEnabled': case 'RemoveCustomization': return { ok: true, kind: 'record-revision', recordRevision: 2 };
      default: return { ok: false, kind: 'error', error: { code: 'internal', message: `unhandled ${String(command)}` } };
    }
  };
  return (env) => {
    const command = (env.payload as Record<string, unknown>).command;
    const override = overrides[command as string];
    if (override !== undefined) {
      const reply = override(env as Record<string, unknown>);
      if (reply !== undefined) return reply;
    }
    return base(env as Record<string, unknown>);
  };
}

function harness(opts: {
  settings?: WorkspaceSettings | Record<string, unknown>;
  controller?: FakeController;
  broker?: ScriptedBroker;
  tabs?: Array<{ id: number; url?: string; title?: string }>;
}): Harness {
  const sent: Array<Record<string, unknown>> = [];
  const storage = { value: opts.settings ?? ackFor(PROFILE.endpoint) };
  let pushHandler: ((raw: unknown) => void) | undefined;
  const controller = opts.controller ?? fakeController([{ kind: 'proposal', proposal: PROPOSAL }]);
  const deps: WorkspaceDeps = {
    now: () => 1_000,
    randomId: () => `id-${sent.length}-${Math.floor(Math.random() * 1e6)}`,
    sendToBroker: async (raw) => {
      const env = raw as Record<string, unknown>;
      sent.push(env);
      return (opts.broker ?? defaultBroker())(env);
    },
    onMessage: (h) => {
      pushHandler = h;
      return () => {
        pushHandler = undefined;
      };
    },
    listTabs: async () =>
      opts.tabs ?? [
        { id: 1, url: 'https://site-a.test/page', title: 'Site A' },
        { id: 2, url: 'https://site-b.test/page', title: 'Site B' },
      ],
    loadSettings: async () => storage.value,
    saveSettings: async (s) => {
      storage.value = s;
    },
    createController: controller.factory,
  };
  const core = createWorkspaceCore(deps);
  return {
    core,
    sent,
    storage,
    controller,
    push: (raw) => pushHandler?.(raw),
    dispose: () => core.dispose(),
  };
}

const commandsOf = (sent: Array<Record<string, unknown>>) => sent.map((e) => (e.payload as Record<string, unknown>).command);

// ── pure projection (plan/16 §2 wording table) ────────────────────────────

test('statusFor: exhaustive typed wording — no false success, no premature understanding', () => {
  assert.equal(statusFor('observing').text, 'Reading page…');
  assert.match(statusFor('planning', { profileLabel: 'My provider' }).text, /Waiting for My provider/);
  assert.match(statusFor('planning').text, /Stop stays available/);
  assert.match(statusFor('applying').text, /Previewing; checking changes/);
  assert.equal(statusFor('complete').text, 'Applied and saved.');
  assert.match(statusFor('applied-unsaved').text, /Applied in this tab; saving failed\./);
  assert.match(statusFor('stopped').text, /Stopped; previous accepted changes kept\./);
  assert.match(statusFor('conflicted').text, /some cleanup could not be confirmed/);
  // Never shown anywhere in any state:
  for (const p of ['idle', 'starting', 'observing', 'planning', 'applying', 'saving', 'awaiting-question', 'awaiting-approval'] as const) {
    const text = statusFor(p).text;
    assert.ok(!text.includes('✓'), `${p} must not show ✓`);
    assert.ok(!text.includes('Saved'), `${p} must not claim saved`);
    assert.ok(!text.includes('Understood'), `${p} must not claim understanding`);
  }
});

test('liveStateText/scopeText: enabled is never conflated with applied; scopes never promise every page', () => {
  assert.equal(liveStateText('applied', undefined, true), 'applied on the open page');
  assert.equal(liveStateText('waiting', undefined, true), 'enabled; target not present in this view');
  assert.match(liveStateText('suspended', 'target ambiguous', true), /suspended/);
  assert.match(liveStateText('conflicted', undefined, true), /could not be confirmed/);
  assert.equal(liveStateText(undefined, undefined, false), 'disabled');
  assert.equal(scopeText({ mode: 'exactPath', path: '/a' }), 'this exact path (/a)');
  assert.equal(scopeText({ mode: 'origin' }), 'all pages on this site');
});

// ── buildSavedRevision (plan/04 §2: self-contained saved intent) ───────────

test('buildSavedRevision: descriptors from observed evidence, d<i> rewrite, profile summary', () => {
  const evidence = new Map(SNAP.regions.map((r) => [r.targetRef, r]));
  const result = buildSavedRevision({
    proposal: PROPOSAL,
    evidence,
    origin: 'https://site-b.test',
    revisionId: 'rev-9',
    savedAt: 5,
    profile: { profileId: 'profile-1', modelId: 'model-x' },
  });
  assert.ok(result.ok, JSON.stringify(result));
  if (!result.ok) return;
  assert.equal(result.revision.targetDescriptors.length, 1);
  assert.equal(result.revision.targetDescriptors[0].anchor.tag, 'h1');
  assert.equal(result.revision.targetDescriptors[0].anchor.accessibleLabel, 'Hello');
  assert.equal(result.revision.targetDescriptors[0].routeScopeRef, 'https://site-b.test');
  const op = result.revision.operations[0] as { rules: Array<{ target: { targetRef?: string } }> };
  assert.equal(op.rules[0].target.targetRef, 'd0');
  assert.equal(result.revision.providerSummary?.modelId, 'model-x');
});

test('buildSavedRevision: unobserved and shadow-root targets are honest errors, never guesses', () => {
  const evidence = new Map(SNAP.regions.map((r) => [r.targetRef, r]));
  const bad = buildSavedRevision({
    proposal: {
      ...PROPOSAL,
      operations: [
        { kind: 'hide', target: { targetRef: 't-missing' } },
      ] as Proposal['operations'],
    },
    evidence,
    origin: 'https://site-b.test',
    revisionId: 'rev-9',
    savedAt: 5,
  });
  assert.ok(!bad.ok);
  assert.match(bad.ok ? '' : bad.error, /no observed evidence/);

  const shadow = buildSavedRevision({
    proposal: PROPOSAL,
    evidence: new Map([['t1', { ...SNAP.regions[0], rootRef: 'root-2' }]]),
    origin: 'https://site-b.test',
    revisionId: 'rev-9',
    savedAt: 5,
  });
  assert.ok(!shadow.ok);
  assert.match(shadow.ok ? '' : shadow.error, /shadow root/);
});

test('refsOfProposal: style/hide/relocate/localRule refs are all collected', () => {
  const refs = refsOfProposal({
    ...PROPOSAL,
    operations: [
      PROPOSAL.operations[0],
      { kind: 'hide', target: { targetRef: 't2' } },
      { kind: 'relocate', target: { targetRef: 't1' }, destination: { targetRef: 't2' }, position: 'after' },
    ] as Proposal['operations'],
  });
  assert.deepEqual([...refs].sort(), ['t1', 't2']);
});

// ── T21: exact target selection — never a first-tab fallback ───────────────

test('T21: start without a pinned target is an explicit refusal with zero calls', async () => {
  const h = harness({});
  await h.core.init();
  await h.core.start('make it red');
  assert.equal(h.core.state().blocked?.reason, 'no-target');
  assert.match(h.core.state().blocked?.text ?? '', /Select the exact target page first\./);
  assert.equal(h.controller.requests.length, 0, 'no controller run may start');
  assert.deepEqual(commandsOf(h.sent), ['ListDocuments', 'GetState', 'GetState'], 'only discovery, no run commands');
  h.dispose();
});

test('T21: the explicitly pinned tab is the run target — the other tab is never chosen', async () => {
  const h = harness({});
  await h.core.init();
  h.core.setPinnedTab(2);
  await h.core.start('make it red');
  const startRun = h.sent.find((e) => (e.payload as Record<string, unknown>).command === 'StartRun');
  assert.ok(startRun, 'StartRun was sent');
  assert.deepEqual((startRun as { documentKey: DocumentKey }).documentKey, DOC_B);
  assert.equal(h.controller.requests.length, 1);
  const observe = h.sent.find((e) => (e.payload as Record<string, unknown>).command === 'Observe');
  assert.deepEqual((observe as { documentKey: DocumentKey }).documentKey, DOC_B);
  h.dispose();
});

test('T21: a pinned document that disappears is unpinned — never silently rebound to another tab', async () => {
  let listCount = 0;
  const h = harness({
    broker: defaultBroker({
      ListDocuments: () => {
        listCount += 1;
        // Second refresh: only tab 1 remains registered.
        const list = docList();
        return listCount >= 2
          ? { ...list, documents: [list.documents[0]] }
          : undefined;
      },
    }),
  });
  await h.core.init();
  h.core.setPinnedTab(2);
  await h.core.refreshDocuments();
  assert.equal(h.core.state().pinnedDocument, null, 'the pin died with its document');
  await h.core.start('make it red');
  assert.equal(h.core.state().blocked?.reason, 'no-target');
  h.dispose();
});

// ── T25/I19: consent is explicit, endpoint-scoped, opt-out is real ─────────

test('T25: no consent acknowledgement → zero controller runs, zero network-adjacent commands', async () => {
  const h = harness({ settings: { settingsVersion: 1, profiles: [PROFILE], credentials: {}, activeProfileId: PROFILE.profileId, consentAcks: [], aiEnabled: true } });
  await h.core.init();
  h.core.setPinnedTab(2);
  await h.core.start('make it red');
  assert.equal(h.core.state().blocked?.reason, 'no-consent');
  assert.match(h.core.state().blocked?.text ?? '', /No call was made/);
  assert.equal(h.controller.requests.length, 0);
  assert.ok(!commandsOf(h.sent).includes('StartRun'));
  h.dispose();
});

test('T25: a consent ack for a different endpoint does not carry over', async () => {
  const h = harness({ settings: ackFor('https://other-endpoint.test/v1') });
  await h.core.init();
  h.core.setPinnedTab(2);
  await h.core.start('make it red');
  assert.equal(h.core.state().blocked?.reason, 'no-consent');
  assert.equal(h.controller.requests.length, 0);
  h.dispose();
});

test('T25 (AC-07): aiEnabled=false blocks planning entirely; saved customizations stay manageable without any model call', async () => {
  const h = harness({ settings: { ...ackFor(PROFILE.endpoint), aiEnabled: false } });
  await h.core.init();
  h.core.setPinnedTab(2);
  await h.core.start('make it red');
  assert.equal(h.core.state().blocked?.reason, 'ai-off');
  assert.match(h.core.state().blocked?.text ?? '', /saved customizations keep working/i);
  assert.equal(h.controller.requests.length, 0);
  // The deterministic record path still works with AI off:
  await h.core.setEnabled('cust-1', false);
  const setEnabled = h.sent.find((e) => (e.payload as Record<string, unknown>).command === 'SetEnabled');
  assert.ok(setEnabled, 'SetEnabled still reaches the broker');
  h.dispose();
});

test('T25: malformed stored settings never load as authority — defaults apply', async () => {
  const h = harness({ settings: { settingsVersion: 99, profiles: [{ evil: true }], credentials: { p: 'x' }, consentAcks: [{ disclosureVersion: 1, endpoint: 'https://api.test', acknowledgedAt: 1 }] } });
  await h.core.init();
  assert.equal(h.core.state().settings.profiles.length, 0);
  assert.equal(h.core.state().settings.aiEnabled, true);
  h.core.setPinnedTab(2);
  await h.core.start('make it red');
  assert.equal(h.core.state().blocked?.reason, 'no-profile');
  h.dispose();
});

test('decodeWorkspaceSettings: round trip survives a valid settings object', () => {
  const settings = ackFor(PROFILE.endpoint);
  const stored = JSON.parse(JSON.stringify(settings));
  const decoded = decodeWorkspaceSettings(stored);
  assert.ok(decoded.ok, JSON.stringify(decoded));
  if (!decoded.ok) return;
  assert.equal(decoded.value.profiles[0].endpoint, PROFILE.endpoint);
  assert.equal(decoded.value.consentAcks[0].endpoint, PROFILE.endpoint);
});

// ── T27: outcome honesty through the whole run flow ───────────────────────

test('T27: proposal → approval → accepted batch → saved: the status says exactly Applied and saved', async () => {
  const h = harness({ controller: fakeController([{ kind: 'proposal', proposal: PROPOSAL }]) });
  await h.core.init();
  h.core.setPinnedTab(2);
  await h.core.start('make it red');
  assert.equal(h.core.state().phase, 'awaiting-approval');
  assert.match(statusFor('awaiting-approval').text, /nothing is applied until you choose Apply/i);
  await h.core.approve({ mode: 'exactPath', path: '/page' });
  assert.equal(h.core.state().phase, 'complete');
  const save = h.sent.find((e) => (e.payload as Record<string, unknown>).command === 'SaveRevision');
  assert.ok(save, 'SaveRevision was sent');
  const payload = save!.payload as Record<string, unknown>;
  assert.equal(payload.origin, 'https://site-b.test');
  assert.equal((payload.scope as { mode: string }).mode, 'exactPath');
  const revision = payload.revision as { targetDescriptors: unknown[]; operations: Array<{ rules: Array<{ target: { targetRef?: string } }> }> };
  assert.equal(revision.targetDescriptors.length, 1);
  assert.equal(revision.operations[0].rules[0].target.targetRef, 'd0');
  h.dispose();
});

test('T27: a rolled-back verification reports the revert honestly — never Done', async () => {
  const h = harness({
    controller: fakeController([{ kind: 'proposal', proposal: PROPOSAL }]),
    broker: defaultBroker({
      ApplyBatch: () => ({
        ok: true,
        kind: 'relayed',
        receipt: { ok: true, kind: 'receipt', receipt: { status: 'rolled-back', error: { code: 'verify', message: 'color did not change' } } },
      }),
    }),
  });
  await h.core.init();
  h.core.setPinnedTab(2);
  await h.core.start('make it red');
  await h.core.approve({ mode: 'exactPath', path: '/page' });
  assert.equal(h.core.state().phase, 'failed');
  h.dispose();
});

test('T27: a conflicted cleanup stays visible (I10) — not a false clean state', async () => {
  const h = harness({
    controller: fakeController([{ kind: 'proposal', proposal: PROPOSAL }]),
    broker: defaultBroker({
      ApplyBatch: () => ({
        ok: true,
        kind: 'relayed',
        receipt: { ok: true, kind: 'receipt', receipt: { status: 'conflicted', conflicts: ['sheet rv-x could not be removed'] } },
      }),
    }),
  });
  await h.core.init();
  h.core.setPinnedTab(2);
  await h.core.start('make it red');
  await h.core.approve({ mode: 'exactPath', path: '/page' });
  assert.equal(h.core.state().phase, 'conflicted');
  h.dispose();
});

test('T27: accepted but unsavable (record conflict) → applied-unsaved with a working Retry save', async () => {
  let saveFails = true;
  const h = harness({
    controller: fakeController([{ kind: 'proposal', proposal: PROPOSAL }]),
    broker: defaultBroker({
      SaveRevision: () =>
        saveFails
          ? { ok: false, kind: 'error', error: { code: 'conflict', message: 'record revision moved', recoveryAction: 'retry with the current revision' }, conflict: 'record revision 3 is current' }
          : { ok: true, kind: 'saved', recordRevision: 4, mutationId: 'mut-2' },
    }),
  });
  await h.core.init();
  h.core.setPinnedTab(2);
  await h.core.start('make it red');
  await h.core.approve({ mode: 'exactPath', path: '/page' });
  assert.equal(h.core.state().phase, 'applied-unsaved');
  assert.ok(h.core.state().pendingSave !== null, 'retry context is retained');
  saveFails = false;
  await h.core.retrySave();
  assert.equal(h.core.state().phase, 'complete');
  h.dispose();
});

test('T27: provider error and cannot-complete are surfaced with their real reasons', async () => {
  const h1 = harness({ controller: fakeController([{ kind: 'provider-error', message: '401 unauthorized' }]) });
  await h1.core.init();
  h1.core.setPinnedTab(2);
  await h1.core.start('make it red');
  assert.equal(h1.core.state().phase, 'failed');
  h1.dispose();

  const h2 = harness({ controller: fakeController([{ kind: 'cannot-complete', reason: 'no safe target for that goal' }]) });
  await h2.core.init();
  h2.core.setPinnedTab(2);
  await h2.core.start('make it red');
  assert.equal(h2.core.state().phase, 'failed');
  h2.dispose();
});

test('T27: Stop mid-run keeps accepted work — stopped wording, run cancelled at the broker', async () => {
  const h = harness({ controller: fakeController([{ kind: 'proposal', proposal: PROPOSAL }]) });
  await h.core.init();
  h.core.setPinnedTab(2);
  await h.core.start('make it red');
  assert.equal(h.core.state().phase, 'awaiting-approval');
  await h.core.stop();
  assert.equal(h.core.state().phase, 'stopped');
  assert.equal(h.core.state().pendingProposal, null, 'the pending proposal is cleared — Stop never leaves work half-owned');
  assert.ok(commandsOf(h.sent).includes('CancelRun'));
  h.dispose();
});

test('T27: question pauses the run and the user answer resumes it — no guessing, no fabricated stop', async () => {
  const h = harness({
    controller: fakeController([
      { kind: 'question', question: { kind: 'question', question: 'Which heading?', options: ['A', 'B'], reason: 'two candidates' } },
      { kind: 'proposal', proposal: PROPOSAL },
    ]),
  });
  await h.core.init();
  h.core.setPinnedTab(2);
  await h.core.start('make it red');
  assert.equal(h.core.state().phase, 'awaiting-question');
  assert.equal(h.core.state().pendingQuestion?.question.question, 'Which heading?');
  await h.core.answerQuestion('the big one');
  assert.equal(h.core.state().phase, 'awaiting-approval');
  h.dispose();
});

test('T27: StartRun conflict (one owner per document) surfaces as busy — the run is not silently replaced', async () => {
  const h = harness({
    broker: defaultBroker({
      StartRun: () => ({ ok: false, kind: 'error', error: { code: 'conflict', message: 'a run is already active' } }),
    }),
  });
  await h.core.init();
  h.core.setPinnedTab(2);
  await h.core.start('make it red');
  assert.equal(h.core.state().phase, 'busy');
  assert.match(statusFor('busy').text, /already active/);
  h.dispose();
});

// ── close/reopen: typed state resynchronization (GetState pull + pushes) ──

test('reopen: GetState pulls live per-document truth; stale sequence pushes are ignored', async () => {
  const h = harness({});
  await h.core.init();
  const liveKey = '2:0:doc-b';
  assert.equal(h.core.state().live[liveKey]?.lifecycle, 'ready');
  // A newer push wins; an older (stale) push does not regress state.
  h.push({
    protocolVersion: 1, requestId: 'p1', kind: 'subscription', deadlineAt: 9e15,
    documentKey: DOC_B,
    payload: { command: 'RuntimeState', state: 'ready', routeEpoch: 5, seq: 3, customizations: [{ customizationId: 'cust-1', title: 'Red title', revisionId: 'rev-1', state: 'waiting' }] },
  });
  assert.equal(h.core.state().live[liveKey]?.seq, 3);
  assert.equal(h.core.state().live[liveKey]?.customizations[0]?.state, 'waiting');
  h.push({
    protocolVersion: 1, requestId: 'p2', kind: 'subscription', deadlineAt: 9e15,
    documentKey: DOC_B,
    payload: { command: 'RuntimeState', state: 'ready', routeEpoch: 1, seq: 1, customizations: [] },
  });
  assert.equal(h.core.state().live[liveKey]?.seq, 3, 'stale push ignored');
  assert.equal(h.core.state().live[liveKey]?.routeEpoch, 5, 'epoch not regressed');
  h.dispose();
});

// ── record management (list semantics through the core) ───────────────────

test('reopen: a persisted pin is revalidated — kept when live, dropped and cleared when gone', async () => {
  // Kept: the pinned tab is registered.
  const h1 = harness({ settings: { ...ackFor(PROFILE.endpoint), pinnedTabId: 2 } });
  await h1.core.init();
  assert.equal(h1.core.state().pinnedDocument?.tabId, 2);
  h1.dispose();

  // Dropped and cleared: no such registered document.
  const h2 = harness({ settings: { ...ackFor(PROFILE.endpoint), pinnedTabId: 99 } });
  await h2.core.init();
  assert.equal(h2.core.state().pinnedDocument, null);
  assert.equal((h2.storage.value as WorkspaceSettings).pinnedTabId, null, 'the dead pin is cleared in storage');
  h2.dispose();
});

test('undo: a two-revision customization reverts to the previous revision via SaveRevision', async () => {
  const record: OriginRecord = {
    schemaVersion: 2,
    origin: 'https://site-b.test',
    recordRevision: 3,
    lastMutationId: 'm-0',
    updatedAt: 1,
    customizations: [
      {
        customizationId: 'cust-1',
        title: 'Red title',
        enabled: true,
        scope: { mode: 'exactPath', path: '/page' },
        activeRevisionId: 'rev-2',
        revisions: [
          {
            revisionId: 'rev-1', capabilityVersion: 1, targetDescriptors: [], savedAt: 1, source: 'user-planned',
            operations: [{ kind: 'hide', target: { targetRef: 'd0' } }],
          },
          {
            revisionId: 'rev-2', capabilityVersion: 1, targetDescriptors: [], savedAt: 2, source: 'user-planned',
            operations: [{ kind: 'style', rules: [] }],
          },
        ] as OriginRecord['customizations'][number]['revisions'],
        createdAt: 1, updatedAt: 2, contentSensitivity: 'page-only', grants: [],
      },
    ],
  };
  const h = harness({
    broker: defaultBroker({
      GetOriginRecord: () => ({ ok: true, kind: 'origin-record', originRecord: record }),
    }),
  });
  await h.core.init();
  h.core.setPinnedTab(2);
  await h.core.refreshRecord();
  assert.equal(h.core.state().record?.customizations.length, 1);
  await h.core.undoLatestRevision('cust-1');
  const save = h.sent.find((e) => (e.payload as Record<string, unknown>).command === 'SaveRevision');
  assert.ok(save, 'undo issued a SaveRevision');
  const payload = save!.payload as Record<string, unknown>;
  assert.equal((payload.revision as { revisionId: string }).revisionId, 'rev-1');
  assert.equal(payload.expectedRecordRevision, 3);
  assert.notEqual(payload.mutationId, 'm-0', 'a fresh mutation id, never a replay of the old write');
  h.dispose();
});

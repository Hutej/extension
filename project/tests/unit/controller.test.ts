/**
 * S6.1 — planning/controller unit tests (plan/11 §5–§7, T20 slices).
 *
 * The real controller over a scripted fake provider client and a fake broker
 * DTO client (plan/20: no live model; the provider seam is a plain function).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createPlanningController, buildEvidenceBlock, type PlanningControllerDeps, type RunOutcome } from '../../src/planning/controller.ts';
import type { PageSnapshot, Region, ActionEntry } from '../../src/contracts.ts';
import type { ProviderProfile } from '../../src/contracts.ts';

// ── fixtures ─────────────────────────────────────────────────────────────

function region(ref: string, tag = 'button', name?: string): Region {
  return {
    targetRef: ref,
    rootRef: 'document',
    kind: 'element',
    semantics: { tag, ...(name !== undefined ? { nameApprox: name, nameSource: 'aria-label' as const } : {}) },
    geometry: { x: 0, y: 0, w: 10, h: 10, inViewport: true },
    stability: 'session-only',
    hidden: false,
  };
}

const SNAPSHOT: PageSnapshot = {
  schemaVersion: 1,
  snapshotId: 'snap-1',
  collectedAt: 1,
  viewport: { width: 1280, height: 800 },
  documentMetadata: { origin: 'https://site.test' },
  roots: [{ rootId: 'document', kind: 'document' }],
  regions: [region('t1', 'button', 'Save'), region('t2', 'main'), region('t3', 'p')],
  actions: [{ actionId: 'a1', kind: 'button', targetRef: 't1', disabled: false } as ActionEntry],
  coverage: { visitedNodes: 100, selectedRegions: 3, completed: true },
};

const PROFILE: ProviderProfile = {
  profileVersion: 1,
  profileId: 'p1',
  label: 'Test',
  protocol: 'openai-chat',
  endpoint: 'https://api.test/v1/chat/completions',
  modelId: 'any-model-id',
  auth: { kind: 'bearer' },
  capabilities: { jsonObjectMode: true },
};

const DOCUMENT_KEY = { tabId: 1, frameId: 0, browserDocumentId: 'doc-1', runtimeInstanceId: 'rt-1' };

const VALID_ACK = { disclosureVersion: 1, endpoint: PROFILE.endpoint, acknowledgedAt: 1 };

interface ScriptedReply {
  text: string;
  httpAttempts?: number;
  downgradedParameter?: string;
}

function fakeClient(replies: ScriptedReply[], log: string[]) {
  let i = 0;
  return {
    call: async (c: { user: string; signal?: AbortSignal }) => {
      const reply = replies[i];
      log.push(`call#${i}: ${c.user.slice(0, 500).replace(/\n/g, ' ')}`);
      i += 1;
      if (!reply) throw new Error('script exhausted');
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      return {
        ok: true,
        text: reply.text,
        httpAttempts: reply.httpAttempts ?? 1,
        ...(reply.downgradedParameter !== undefined ? { downgradedParameter: reply.downgradedParameter } : {}),
        wallMs: 5,
      };
    },
  } as unknown as PlanningControllerDeps['client'];
}

function makeDeps(replies: ScriptedReply[], log: string[] = [], overrides: Partial<PlanningControllerDeps> = {}) {
  return {
    client: fakeClient(replies, log),
    now: () => Date.now(),
    randomId: () => `id-${Math.random()}`,
    sleep: async () => {},
    observe: async () => SNAPSHOT,
    inspect: async (_dk: unknown, ref: string, fields: string[]) => ({ ok: true, detail: `details of ${ref}: ${fields.join(',')}` }),
    ...overrides,
  } as PlanningControllerDeps;
}

const PROPOSAL_JSON = JSON.stringify({
  kind: 'proposal',
  schemaVersion: 1,
  summary: 'Make the save button red',
  operations: [
    { kind: 'style', rules: [{ target: { targetRef: 't1' }, surface: 'element', state: 'none', declarations: [{ property: 'color', value: 'red', priority: 'important' }], conditions: [] }] },
  ],
});

async function start(deps: PlanningControllerDeps, overrides: Partial<Parameters<ReturnType<typeof createPlanningController>['run']>[0]> = {}) {
  const controller = createPlanningController(deps);
  return controller.run({
    goal: 'make the save button red',
    documentKey: DOCUMENT_KEY,
    snapshot: SNAPSHOT,
    profile: PROFILE,
    consentAck: VALID_ACK,
    ...overrides,
  });
}

const stateOf = (outcome: RunOutcome): string => outcome.kind;

// ── the one-call common path (AC-05) ─────────────────────────────────────

test('T20/AC-05: a valid first proposal returns in ONE model response — no verify/done calls', async () => {
  const log: string[] = [];
  const run = await start(makeDeps([{ text: PROPOSAL_JSON }], log));
  assert.equal(run.outcome.kind, 'proposal');
  if (run.outcome.kind === 'proposal') {
    assert.equal(run.outcome.proposal.operations.length, 1);
    assert.equal(run.outcome.proposal.operations[0].kind, 'style');
  }
  assert.equal(run.outcome.counters.modelResponses, 1);
  assert.equal(run.outcome.counters.httpAttempts, 1);
  assert.equal(log.length, 1);
});

// ── evidence continuations (plan/11 §5) ──────────────────────────────────

test('T20: a requestEvidence continuation gathers bounded evidence and continues — capped at 2', async () => {
  const log: string[] = [];
  const evidenceReply = { text: JSON.stringify({ kind: 'requestEvidence', queryKind: 'inspect-target', targetRef: 't1', fields: ['geometry'] }) };
  const run = await start(makeDeps([evidenceReply, evidenceReply, { text: PROPOSAL_JSON }], log));
  assert.equal(run.outcome.kind, 'proposal', JSON.stringify(run.outcome).slice(0, 300));
  assert.equal(run.outcome.counters.modelResponses, 3);
  assert.equal(run.outcome.counters.evidenceRequests, 2, 'continuations are honored within the cap');
  assert.match(log.find((l) => l.startsWith('call#2')) ?? '', /goal:/, 'the proposal call carries goal + evidence');

  // The cap is 4 continuations (owner-directed 2026-09-13 budget); a fifth
  // request is refused — the model is told to decide with current evidence.
  const greedy = { text: JSON.stringify({ kind: 'requestEvidence', queryKind: 'expand-regions' }) };
  const run2 = await start(makeDeps([greedy, greedy, greedy, { text: PROPOSAL_JSON }]));
  assert.equal(run2.outcome.kind, 'proposal', 'the capped model still gets its one final response');
  assert.equal(run2.outcome.counters.modelResponses, 4, 'never more than 8 model responses');
  assert.equal(run2.outcome.counters.evidenceRequests, 3, 'only 3 evidence requests were honored');

  // And if it keeps asking instead of deciding: honest budget exhaustion.
  const run3 = await start(makeDeps(Array(8).fill(greedy)));
  assert.equal(run3.outcome.kind, 'cannot-complete');
  assert.match((run3.outcome as { reason: string }).reason, /budget was exhausted/);
  assert.equal(run3.outcome.counters.modelResponses, 8);
});

// ── the shared correction budget (plan/11 §7) ────────────────────────────

test('T02/T20: malformed responses get budgeted repairs (owner-directed budget of 3); the fourth failure is terminal', async () => {
  const log: string[] = [];
  const run = await start(makeDeps([{ text: 'I would love to help, but let me explain first: no JSON here.' }, { text: PROPOSAL_JSON }], log));
  assert.equal(run.outcome.kind, 'proposal');
  assert.equal(run.outcome.counters.correctionsUsed, 1);
  assert.match(log[1] ?? '', /not a valid planning response/, 'the repair prompt names the failure');

  const malformed = { text: '{"kind":"proposal"' };
  const log2: string[] = [];
  const run2 = await start(makeDeps([malformed, malformed, malformed, malformed], log2));
  assert.equal(run2.outcome.kind, 'cannot-complete');
  assert.match((run2.outcome as { reason: string }).reason, /cannot-produce-valid-proposal/);
  assert.equal(run2.outcome.counters.correctionsUsed, 3, 'the repair budget of 3 is really spent');
  assert.equal(run2.outcome.counters.modelResponses, 4, 'one initial + three repairs, then honest termination');

  // Every budgeted repair really happens — the failure rides the loop (the
  // old code terminated after one repair regardless of the budget).
  const log3: string[] = [];
  const ok3 = await start(makeDeps([malformed, malformed, malformed, { text: PROPOSAL_JSON }], log3));
  assert.equal(ok3.outcome.kind, 'proposal', 'the third repair can still land the proposal');
  assert.equal(ok3.outcome.counters.modelResponses, 4);
});

test('T02: a response containing TWO candidate objects is ambiguous — rejected, never first-plausible', async () => {
  const two = '{"kind":"proposal","schemaVersion":1,"summary":"a","operations":[]} {"kind":"cannotComplete","reason":"b"}';
  const run = await start(makeDeps([{ text: two }, { text: PROPOSAL_JSON }]));
  assert.equal(run.outcome.kind, 'proposal', 'the repair path recovers');
  assert.equal(run.outcome.counters.correctionsUsed, 1);
});

// ── question pause + resume ──────────────────────────────────────────────

test('T20: a question pauses the run; the answer resumes with the answer appended', async () => {
  const log: string[] = [];
  const question = { text: JSON.stringify({ kind: 'question', question: 'Which element?', options: ['the save button', 'the cancel button'], reason: 'ambiguous' }) };
  const run = await start(makeDeps([question, { text: PROPOSAL_JSON }], log));
  assert.equal(run.outcome.kind, 'question');
  const resumed = await run.answer('the save button');
  assert.equal(resumed.kind, 'proposal');
  assert.match(log.find((l) => l.startsWith('call#1')) ?? '', /user answer to "Which element\?": the save button/);
});

// ── honest terminals ─────────────────────────────────────────────────────

test('T20: cannotComplete passes through with the model reason; provider errors surface code+message', async () => {
  const run = await start(makeDeps([{ text: JSON.stringify({ kind: 'cannotComplete', reason: 'the goal needs a capability Revueon does not offer' }) }]));
  assert.equal(run.outcome.kind, 'cannot-complete');
  assert.match((run.outcome as { reason: string }).reason, /capability/);

  const failing = makeDeps([], []);
  (failing as { client: unknown }).client = {
    call: async () => ({ ok: false, code: 'denied', message: 'HTTP 401', httpAttempts: 1, wallMs: 1 }),
  } as unknown as PlanningControllerDeps['client'];
  const run2 = await start(failing);
  assert.equal(run2.outcome.kind, 'provider-error');
  assert.equal((run2.outcome as { code: string }).code, 'denied');
});

test('T20: Stop aborts — the outcome is stopped and no further provider calls happen', async () => {
  const controller = new AbortController();
  const log: string[] = [];
  const slow = makeDeps([{ text: PROPOSAL_JSON }], log);
  (slow as { client: unknown }).client = {
    call: async (c: { signal?: AbortSignal }) => {
      log.push('called');
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, 100);
        c.signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
      });
      return { ok: true, text: PROPOSAL_JSON, httpAttempts: 1, wallMs: 1 };
    },
  } as unknown as PlanningControllerDeps['client'];
  const pending = start(slow, { signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  const run = await pending;
  assert.equal(run.outcome.kind, 'stopped');
  assert.equal(log.filter((l) => l === 'called').length, 1, 'no further calls after Stop');
});

test('I19/I20: a missing or endpoint-mismatched consent never reaches the network', async () => {
  let calls = 0;
  const deps = makeDeps([{ text: PROPOSAL_JSON }], []);
  (deps as { client: unknown }).client = {
    call: async () => {
      calls += 1;
      return { ok: true, text: PROPOSAL_JSON, httpAttempts: 1, wallMs: 1 };
    },
  } as unknown as PlanningControllerDeps['client'];
  const noAck = await start(deps, { consentAck: undefined });
  assert.equal(noAck.outcome.kind, 'cannot-complete');
  assert.match((noAck.outcome as { reason: string }).reason, /consent/);
  const wrongEndpoint = await start(deps, { consentAck: { disclosureVersion: 1, endpoint: 'https://other.test/v1', acknowledgedAt: 1 } });
  assert.equal(wrongEndpoint.outcome.kind, 'cannot-complete');
  assert.equal(calls, 0, 'zero provider calls without valid consent');
});

test('T19: a recorded parameter downgrade is surfaced on the outcome, never hidden', async () => {
  const run = await start(makeDeps([{ text: PROPOSAL_JSON, downgradedParameter: 'max_completion_tokens' }]));
  assert.equal(run.outcome.kind, 'proposal');
  assert.equal((run.outcome as { downgradedParameter?: string }).downgradedParameter, 'max_completion_tokens');
});

// ── context bounds (plan/11 §6) ──────────────────────────────────────────

test('T20: the evidence block is bounded and names its omissions honestly', () => {
  const many: PageSnapshot = {
    ...SNAPSHOT,
    regions: Array.from({ length: 400 }, (_, i) => region(`t${i}`, 'div', i % 2 ? `name ${i} ${'x'.repeat(80)}` : undefined)),
  };
  const block = buildEvidenceBlock(many, 3000);
  assert.ok(block.length < 4000, `the block respects the budget (${block.length})`);
  assert.match(block, /older regions omitted \(evidence budget\)/, 'omissions are disclosed, never silent');
  assert.match(block, /partial|complete/, 'coverage is stated');
});

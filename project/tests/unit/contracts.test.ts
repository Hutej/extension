/**
 * T02 — contract decoders (S1.1). Every case asserts PATH-SPECIFIC rejection
 * with zero effects: decoding never executes anything, coerces model strings
 * into numbers/booleans, or accepts unknown fields (v1 has no extensions
 * field). The named T02 negatives are covered: unknown fields, wrong types,
 * NaN-like strings, deep/oversized structures, nested group/DAG fields,
 * duplicate/forward owned-node refs, missing targets, versions, bounds.
 * (Multiple/truncated JSON OBJECTS are the extract-layer contract, S6.1;
 * the schema layer receives exactly one candidate object.)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIMITS,
  decodePlannerResponse,
  decodeOperationBatch,
  decodeEnvelope,
  decodeCommandReceipt,
  decodeOriginRecord,
  decodeProviderProfile,
  decodeUserGrant,
  decodeTargetDescriptor,
  retryClassFor,
  countDeclarations,
  type Operation,
  type PlannerResponse,
} from '../../src/contracts.ts';

const codes = (r: { ok: false; issues: { path: string; code: string; message: string }[] } | { ok: true }): string[] =>
  r.ok ? [] : r.issues.map((i) => `${i.code}@${i.path}`);
const issueAt = (r: ReturnType<typeof codes>, codeAndPath: string): boolean => {
  const at = codeAndPath.indexOf('@');
  const code = codeAndPath.slice(0, at);
  const suffix = codeAndPath.slice(at + 1);
  return r.some((c) => c.startsWith(`${code}@`) && c.endsWith(suffix));
};

const styleOn = (ref: string, local = false): Operation => ({
  kind: 'style',
  rules: [{ target: local ? { localRef: ref } : { targetRef: ref }, declarations: [{ property: 'color', value: 'red' }] }],
} as Operation);

const insertPanel = (id = 'panel'): Operation => ({
  kind: 'insertUI',
  target: { targetRef: 'anchor-1' },
  position: 'after',
  nodes: [{ localId: id, tag: 'div', text: 'hello' }],
} as Operation);

const validProposal = (operations: Operation[]): Record<string, unknown> => ({
  kind: 'proposal',
  schemaVersion: 1,
  summary: 'make the header red',
  operations,
});

// ── valid baselines ──────────────────────────────────────────────────────

test('T02 ok: a same-batch insertUI + style-on-localRef proposal decodes', () => {
  const r = decodePlannerResponse(validProposal([insertPanel('panel'), styleOn('panel', true)]));
  assert.ok(r.ok, JSON.stringify(r.ok ? [] : r.issues));
  if (r.ok && r.value.kind === 'proposal') {
    assert.equal(r.value.operations.length, 2);
    assert.equal(countDeclarations(r.value.operations), 1);
  }
});

test('T02 ok: every v1 operation kind decodes with its defaults', () => {
  const ops: unknown[] = [
    styleOn('t1'),
    { kind: 'hide', target: { targetRef: 't1' } },
    { kind: 'collapse', target: { targetRef: 't1' }, label: 'Comments' },
    { kind: 'float', target: { targetRef: 't1' }, edge: 'bottom-end' },
    { kind: 'replaceText', target: { targetRef: 't1' }, text: 'New text' },
    insertPanel('panel'),
    { kind: 'bindKey', chord: 'g then h', actionIds: ['focus-main'] },
    { kind: 'localRule', target: { targetRef: 't1' }, trigger: 'target-appeared', actionId: 'collapse-once' },
    { kind: 'projectCollection', target: { targetRef: 't1' }, sourceSetRef: 'set-1', view: 'board', fields: [{ sourceField: 'title', label: 'Title' }] },
    { kind: 'relocate', target: { targetRef: 't1' }, destination: { targetRef: 't2' }, position: 'last-child', structuralGrant: true },
  ];
  const r = decodeOperationBatch(ops);
  assert.ok(r.ok, JSON.stringify(r.ok ? [] : r.issues));
});

test('T02 ok: the full response union decodes (question, requestEvidence, cannotComplete)', () => {
  const q = decodePlannerResponse({ kind: 'question', question: 'Which header?', options: ['Sticky bar', 'Article header'], reason: 'two plausible targets' });
  assert.ok(q.ok && (q.value as PlannerResponse).kind === 'question');
  const e = decodePlannerResponse({ kind: 'requestEvidence', queryKind: 'inspect-target', targetRef: 't1' });
  assert.ok(e.ok && (e.value as PlannerResponse).kind === 'requestEvidence');
  const c = decodePlannerResponse({ kind: 'cannotComplete', reason: 'no kanban source set observed', missingCapability: 'projection' });
  assert.ok(c.ok && (c.value as PlannerResponse).kind === 'cannotComplete');
});

test('T02 ok: envelope, receipt and records decode; retryClassFor maps and defaults', () => {
  const env = decodeEnvelope({
    protocolVersion: 1, requestId: 'req-1', kind: 'style-delivery', deadlineAt: 123,
    documentKey: { tabId: 1, frameId: 0, browserDocumentId: 'D1', runtimeInstanceId: 'R1' },
    payload: { operationId: 'op-1' },
  });
  assert.ok(env.ok);
  const receipt = decodeCommandReceipt({
    requestId: 'req-1', operationId: 'op-1', payloadDigest: 'abc', status: 'applied-provisional',
    resourceIds: ['r1'],
  }, 'receipt');
  assert.ok(receipt.ok);
  assert.equal(retryClassFor('timeout-unknown'), 'retryable-same-id');
  assert.equal(retryClassFor('provider-unavailable'), 'retryable-backoff');
  assert.equal(retryClassFor('stale-document'), 'non-retryable');
  assert.equal(retryClassFor('definitely-not-a-code'), 'non-retryable'); // unknown errors never retryable
});

test('T02 ok: a valid OriginRecord with descriptor and revision decodes', () => {
  const rec = decodeOriginRecord({
    schemaVersion: 2,
    origin: 'https://example.com',
    recordRevision: 3,
    lastMutationId: 'mut-3',
    updatedAt: 1000,
    customizations: [{
      customizationId: 'c1', title: 'Calm header', enabled: true,
      scope: { mode: 'exactPath', path: '/inbox' },
      activeRevisionId: 'rev-1',
      revisions: [{
        revisionId: 'rev-1', capabilityVersion: 1, savedAt: 999, source: 'user-planned',
        targetDescriptors: [{
          descriptorVersion: 1, rootPath: [], selection: 'single',
          anchor: { tag: 'header', stableId: 'masthead' }, relation: 'self',
          matchBounds: { min: 1, max: 1 }, routeScopeRef: 'route-1', continuityPolicy: 'stable-single',
        }],
        operations: [styleOn('t1')],
      }],
      createdAt: 900, updatedAt: 1000, contentSensitivity: 'page-only', grants: ['g1'],
    }],
  });
  assert.ok(rec.ok, JSON.stringify(rec.ok ? [] : rec.issues));
  const grant = decodeUserGrant({
    grantVersion: 1, grantId: 'g1', origin: 'https://example.com',
    routeScope: { mode: 'pathPrefix', path: '/docs' },
    capabilityCategories: ['style', 'text'], disclosureVersion: 1, approvedAt: 500,
  });
  assert.ok(grant.ok);
});

// ── T02 negative controls ────────────────────────────────────────────────

test('T02: unknown fields and DAG/group fields are rejected with field paths', () => {
  const dag = decodePlannerResponse(validProposal([
    { kind: 'hide', target: { targetRef: 't1' }, dependsOnLabels: ['a'], required: true } as unknown as Operation,
  ]));
  assert.ok(!dag.ok, 'nested-group/dependency fields must not decode');
  assert.ok(issueAt(codes(dag as never), 'unknown-field@operations[0].dependsOnLabels'));
  assert.ok(issueAt(codes(dag as never), 'unknown-field@operations[0].required'));
});

test('T02: unknown top-level field on the response union is rejected', () => {
  const r = decodePlannerResponse({ ...validProposal([styleOn('t1')]), targetSelector: '.header' });
  assert.ok(!r.ok);
  assert.ok(issueAt(codes(r as never), 'unknown-field@response.targetSelector'));
});

test('T02: wrong types are rejected without coercion', () => {
  const r = decodePlannerResponse(validProposal([{ kind: 'hide', target: { targetRef: 42 } } as unknown as Operation]));
  assert.ok(!r.ok);
  assert.ok(issueAt(codes(r as never), 'type@operations[0].target.targetRef'));
});

test('T02: NaN-like and stringified numbers/booleans never coerce', () => {
  const num = decodePlannerResponse(validProposal([{ kind: 'replaceText', target: { targetRef: 't1' }, text: 'x' }, styleOn('t1')]));
  assert.ok(num.ok);
  const boolStr = decodeOperationBatch([{ kind: 'collapse', target: { targetRef: 't1' }, label: 'x', userOverride: 'true' } as unknown as Operation]);
  assert.ok(!boolStr.ok);
  assert.ok(issueAt(codes(boolStr as never), 'type@operations[0].userOverride'));
});

test('T02: missing target (neither targetRef nor localRef) is a path-specific missing field', () => {
  const r = decodeOperationBatch([{ kind: 'hide', target: {} } as unknown as Operation]);
  assert.ok(!r.ok);
  assert.ok(issueAt(codes(r as never), 'missing@operations[0].target.targetRef'));
});

test('T02: both targetRef and localRef is a conflict — namespaces stay explicit', () => {
  const r = decodeOperationBatch([{ kind: 'hide', target: { targetRef: 't1', localRef: 'panel' } } as unknown as Operation]);
  assert.ok(!r.ok);
  assert.ok(issueAt(codes(r as never), 'conflict@operations[0].target'));
});

test('T02: duplicate localIds are rejected across nodes and operations', () => {
  const dupInTree = decodeOperationBatch([
    { kind: 'insertUI', target: { targetRef: 'a' }, position: 'after', nodes: [
      { localId: 'x', tag: 'div', children: [{ localId: 'x', tag: 'span' }] },
    ] } as unknown as Operation,
  ]);
  assert.ok(!dupInTree.ok);
  assert.ok(issueAt(codes(dupInTree as never), 'duplicate@operations[0]'));

  const dupAcross = decodeOperationBatch([
    insertPanel('panel'),
    { kind: 'insertUI', target: { targetRef: 'b' }, position: 'after', nodes: [{ localId: 'panel', tag: 'div' }] } as unknown as Operation,
  ]);
  assert.ok(!dupAcross.ok);
  assert.ok(issueAt(codes(dupAcross as never), 'duplicate@operations[1]'));
});

test('T02: forward localRefs (later or unknown creators) are rejected', () => {
  const forward = decodeOperationBatch([styleOn('later', true), insertPanel('later')]);
  assert.ok(!forward.ok);
  assert.ok(issueAt(codes(forward as never), 'forward-reference@operations[0]'));

  const unknownRef = decodeOperationBatch([styleOn('never-declared', true)]);
  assert.ok(!unknownRef.ok);
  assert.ok(issueAt(codes(unknownRef as never), 'forward-reference@operations[0]'));
});

test('T02: unknown operation kind and unknown version fail closed', () => {
  const kind = decodeOperationBatch([{ kind: 'recomposePage', target: { targetRef: 't1' } } as unknown as Operation]);
  assert.ok(!kind.ok);
  assert.ok(issueAt(codes(kind as never), 'unknown-value@operations[0].kind'));

  const version = decodePlannerResponse({ ...validProposal([styleOn('t1')]), schemaVersion: 2 });
  assert.ok(!version.ok);
  assert.ok(issueAt(codes(version as never), 'out-of-bounds@response.schemaVersion'));
});

test('T02: bounds — 0 and 65 operations, oversized replaceText, oversized insert tree', () => {
  const empty = decodeOperationBatch([]);
  assert.ok(!empty.ok);
  assert.ok(issueAt(codes(empty as never), 'out-of-bounds@operations'));

  const tooMany = decodeOperationBatch(Array.from({ length: LIMITS.maxOperations + 1 }, () => styleOn('t1')));
  assert.ok(!tooMany.ok);
  assert.ok(issueAt(codes(tooMany as never), 'out-of-bounds@operations'));

  const bigText = decodeOperationBatch([
    { kind: 'replaceText', target: { targetRef: 't1' }, text: 'x'.repeat(LIMITS.maxReplaceTextBytes + 1) } as unknown as Operation,
  ]);
  assert.ok(!bigText.ok);
  assert.ok(issueAt(codes(bigText as never), 'out-of-bounds@operations[0].text'));

  const tooDeep = decodeOperationBatch([
    { kind: 'insertUI', target: { targetRef: 'a' }, position: 'after', nodes: [deepNode(LIMITS.maxInsertDepth + 1)] } as unknown as Operation,
  ]);
  assert.ok(!tooDeep.ok);
  assert.ok(issueAt(codes(tooDeep as never), 'too-deep@'));
});

function deepNode(levels: number): unknown {
  let node: unknown = { tag: 'span', text: 'leaf' };
  for (let i = 0; i < levels; i++) node = { tag: 'div', children: [node] };
  return node;
}

test('T02: oversized JSON depth and forbidden prototype keys are rejected', () => {
  let deep: unknown = { a: 1 };
  for (let i = 0; i < LIMITS.maxJsonDepth + 2; i++) deep = { nested: deep };
  const r = decodeEnvelope({ protocolVersion: 1, requestId: 'r', kind: 'control', deadlineAt: 1, payload: deep });
  assert.ok(!r.ok);
  assert.ok(issueAt(codes(r as never), 'too-deep@envelope') || issueAt(codes(r as never), 'too-deep@'));

  const proto = decodePlannerResponse(JSON.parse('{"kind":"proposal","schemaVersion":1,"summary":"s","__proto__":{"polluted":true},"operations":[]}'));
  assert.ok(!proto.ok);
  assert.ok(issueAt(codes(proto as never), 'unknown-field@response.__proto__'));
});

test('T02: question bounds (options 2..4, custom answer always allowed)', () => {
  const one = decodePlannerResponse({ kind: 'question', question: 'q', options: ['only'], reason: 'r' });
  assert.ok(!one.ok);
  assert.ok(issueAt(codes(one as never), 'out-of-bounds@response.options'));
  const five = decodePlannerResponse({ kind: 'question', question: 'q', options: ['1', '2', '3', '4', '5'], reason: 'r' });
  assert.ok(!five.ok);
});

test('T02: descriptor invariants — single=exactly1, future-set needs a set, min<=max', () => {
  const single = decodeTargetDescriptor(descriptor({ selection: 'single', matchBounds: { min: 1, max: 2 } }));
  assert.ok(!single.ok);
  assert.ok(issueAt(codes(single as never), 'conflict@descriptor.matchBounds.max'));

  const futureSingle = decodeTargetDescriptor(descriptor({ selection: 'single', continuityPolicy: 'future-set' }));
  assert.ok(!futureSingle.ok);

  const inverted = decodeTargetDescriptor(descriptor({ selection: 'set', matchBounds: { min: 5, max: 2 } }));
  assert.ok(!inverted.ok);
});

function descriptor(overrides: Record<string, unknown>): unknown {
  return {
    descriptorVersion: 1, rootPath: [], selection: 'single',
    anchor: { tag: 'header' }, relation: 'self',
    matchBounds: { min: 1, max: 1 }, routeScopeRef: 'route-1', continuityPolicy: 'stable-single',
    ...overrides,
  };
}

test('T02: endpoint policy — https ok, loopback http ok, LAN http and non-http denied', () => {
  const https = decodeProviderProfile(profile('https://api.example.com/v1'));
  assert.ok(https.ok, JSON.stringify(https.ok ? [] : https.issues));
  const loop = decodeProviderProfile(profile('http://127.0.0.1:11434/v1'));
  assert.ok(loop.ok);
  const lan = decodeProviderProfile(profile('http://10.0.0.5:8080/v1'));
  assert.ok(!lan.ok);
  assert.ok(issueAt(codes(lan as never), 'denied@profile.endpoint'));
  const ftp = decodeProviderProfile(profile('ftp://api.example.com'));
  assert.ok(!ftp.ok);
});

test('T02: browser-owned auth headers cannot be overridden; api-key-header needs a name', () => {
  const authz = decodeProviderProfile(profile('https://api.example.com/v1', { auth: { kind: 'api-key-header', headerName: 'Authorization' } }));
  assert.ok(!authz.ok);
  assert.ok(issueAt(codes(authz as never), 'denied@profile.auth.headerName'));
  const noName = decodeProviderProfile(profile('https://api.example.com/v1', { auth: { kind: 'api-key-header' } }));
  assert.ok(!noName.ok);
  assert.ok(issueAt(codes(noName as never), 'missing@profile.auth.headerName'));
});

function profile(endpoint: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    profileVersion: 1, profileId: 'p1', label: 'Local',
    protocol: 'openai-chat', endpoint, modelId: 'test-model',
    auth: { kind: 'none' },
    ...overrides,
  };
}

test('T02: insertUI grammar — unknown tags/attrs, credential input types, submit buttons, style attr', () => {
  const cases: unknown[] = [
    insertPanelWith({ tag: 'custom-element' }),
    insertPanelWith({ tag: 'script' }),
    insertPanelWith({ tag: 'iframe' }),
    insertPanelWith({ tag: 'div', attributes: { style: 'color:red' } }),
    insertPanelWith({ tag: 'div', attributes: { onclick: 'alert(1)' } }),
    insertPanelWith({ tag: 'input', attributes: { type: 'password' } }),
    insertPanelWith({ tag: 'input', attributes: { type: 'file' } }),
    insertPanelWith({ tag: 'button', attributes: { type: 'submit' } }),
  ];
  for (const [i, op] of cases.entries()) {
    const r = decodeOperationBatch([op as Operation]);
    assert.ok(!r.ok, `case ${i} must be rejected`);
  }
  // Allowed local input types still pass.
  const okInput = decodeOperationBatch([insertPanelWith({ tag: 'input', attributes: { type: 'search', placeholder: 'filter' } }) as unknown as Operation]);
  assert.ok(okInput.ok, JSON.stringify(okInput.ok ? [] : okInput.issues));
});

function insertPanelWith(node: Record<string, unknown>): unknown {
  return { kind: 'insertUI', target: { targetRef: 'a' }, position: 'after', nodes: [node] };
}

test('T02: style rule bounds — empty rules/declarations, pseudo-element + state conflict', () => {
  const noRules = decodeOperationBatch([{ kind: 'style', rules: [] } as unknown as Operation]);
  assert.ok(!noRules.ok);
  const noDecl = decodeOperationBatch([{ kind: 'style', rules: [{ target: { targetRef: 't1' }, declarations: [] }] } as unknown as Operation]);
  assert.ok(!noDecl.ok);
  const conflict = decodeOperationBatch([{
    kind: 'style',
    rules: [{ target: { targetRef: 't1' }, surface: 'before', state: 'hover', declarations: [{ property: 'color', value: 'red' }] }],
  } as unknown as Operation]);
  assert.ok(!conflict.ok);
  assert.ok(issueAt(codes(conflict as never), 'conflict@operations[0].rules[0]'));
});

test('T02: expectations must reference declared local nodes; declaration group budget enforced', () => {
  const badRef = decodePlannerResponse({
    ...validProposal([insertPanel('panel')]),
    expectations: [{ effect: 'ui-inserted', localRef: 'other' }],
  });
  assert.ok(!badRef.ok);
  assert.ok(issueAt(codes(badRef as never), 'forward-reference@response.expectations'));

  const goodRef = decodePlannerResponse({
    ...validProposal([insertPanel('panel')]),
    expectations: [{ effect: 'ui-inserted', localRef: 'panel' }],
  });
  assert.ok(goodRef.ok);

  const wide = decodePlannerResponse(validProposal(
    Array.from({ length: 40 }, () => styleOn('t1')).concat(Array.from({ length: 24 }, () => styleOn('t2'))),
  ));
  assert.ok(wide.ok);
  if (wide.ok && wide.value.kind === 'proposal') {
    assert.equal(countDeclarations(wide.value.operations), 64);
  }
  const overBudget: unknown[] = Array.from({ length: LIMITS.maxOperations }, (_, i) => ({
    kind: 'style',
    rules: [{ target: { targetRef: `t${i}` }, declarations: Array.from({ length: 65 }, () => ({ property: 'margin', value: '1px' })) }],
  }));
  const perRule = decodePlannerResponse(validProposal(overBudget as Operation[]));
  assert.ok(!perRule.ok, '65 declarations in one rule must be rejected');
});

test('T02: OriginRecord integrity — activeRevisionId must name a stored revision', () => {
  const base = {
    schemaVersion: 2, origin: 'https://example.com', recordRevision: 1, lastMutationId: 'm1', updatedAt: 1,
    customizations: [{
      customizationId: 'c1', title: 't', enabled: true, scope: { mode: 'origin' },
      activeRevisionId: 'missing-rev',
      revisions: [{
        revisionId: 'rev-1', capabilityVersion: 1, savedAt: 1, source: 'user-planned',
        targetDescriptors: [], operations: [styleOn('t1')],
      }],
      createdAt: 1, updatedAt: 1, contentSensitivity: 'page-only', grants: [],
    }],
  };
  const bad = decodeOriginRecord(base);
  assert.ok(!bad.ok);
  assert.ok(issueAt(codes(bad as never), 'unknown-value@record.customizations'));
  const good = decodeOriginRecord({ ...base, customizations: [{ ...(base.customizations as Record<string, unknown>[])[0], activeRevisionId: 'rev-1' }] });
  assert.ok(good.ok);
});

test('T02: receipts accept only the documented status vocabulary', () => {
  const bad = decodeCommandReceipt({ requestId: 'r', operationId: 'o', payloadDigest: 'd', status: 'ok' }, 'receipt');
  assert.ok(!bad.ok);
  assert.ok(issueAt(codes(bad as never), 'unknown-value@receipt.status'));
  // A timeout is outcome-unknown, never not-applied — both statuses exist and differ.
  const statuses = new Set(['outcome-unknown', 'not-applied']);
  for (const status of statuses) {
    const r = decodeCommandReceipt({ requestId: 'r', operationId: 'o', payloadDigest: 'd', status }, 'receipt');
    assert.ok(r.ok, `status "${status}" must decode`);
  }
});

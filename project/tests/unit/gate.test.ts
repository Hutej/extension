/**
 * T01/T29 — the gates themselves are under test (negative controls):
 *   - test-gate summary parsing and inventory checking (T01);
 *   - audit-imports boundary/cycle detection on a deliberately forbidden
 *     fixture (T29), the type-only exemption, and the real src graph being
 *     clean. If enforcement disappears, these tests fail.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { parseTapSummary, parseTapFailures, classifyFailures, missingFromInventory, EXPECTED_UNIT_SUITES } from '../../scripts/test-gate.ts';
import { buildGraph, auditGraph } from '../../scripts/audit-imports.ts';

const REPO = fileURLToPath(new URL('../..', import.meta.url));

// ── T01: the zero-test / missing-suite gate ──────────────────────────────

test('T01: TAP summary parsing counts tests/pass/fail', () => {
  const tap = [
    'TAP version 13',
    'ok 1 - one',
    'not ok 2 - two',
    'ok 3 - three',
    '# tests 3',
    '# pass 2',
    '# fail 1',
  ].join('\n');
  assert.deepEqual(parseTapSummary(tap), { tests: 3, pass: 2, fail: 1 });
});

test('T01: a zero-discovery run parses as 0 tests', () => {
  const tap = ['TAP version 13', '# tests 0', '# pass 0', '# fail 0'].join('\n');
  assert.equal(parseTapSummary(tap).tests, 0);
});

test('T01: missing suites are detected against the checked-in inventory', () => {
  assert.deepEqual(missingFromInventory(['color.test.ts'], EXPECTED_UNIT_SUITES),
    EXPECTED_UNIT_SUITES.filter((f) => f !== 'color.test.ts'));
  assert.deepEqual(missingFromInventory(EXPECTED_UNIT_SUITES, EXPECTED_UNIT_SUITES), []);
});

test('T01: failure names parse from TAP and split against the known-red list', () => {
  const tap = [
    'TAP version 13',
    'ok 1 - fine',
    'not ok 2 - F05: a failed post-repair verification must never count as repaired',
    'not ok 3 - surprise regression',
    '# tests 3',
    '# pass 1',
    '# fail 2',
  ].join('\n');
  assert.deepEqual(parseTapFailures(tap), [
    'F05: a failed post-repair verification must never count as repaired',
    'surprise regression',
  ]);
  const { unexpected, nowPassing } = classifyFailures(parseTapFailures(tap), [
    'F05: a failed post-repair verification must never count as repaired',
  ]);
  assert.deepEqual(unexpected, ['surprise regression']);
  assert.deepEqual(nowPassing, []);
});

test('T01: a known-red test that starts passing fails the gate classification', () => {
  const { unexpected, nowPassing } = classifyFailures([], ['F05: a failed post-repair verification must never count as repaired']);
  assert.deepEqual(unexpected, []);
  assert.deepEqual(nowPassing, ['F05: a failed post-repair verification must never count as repaired']);
});

// ── T29: the resolved import gate ────────────────────────────────────────

test('T29: the forbidden fixture fails boundary and cycle checks', () => {
  const graph = buildGraph(`${REPO}tests/fixtures/import-gate`);
  const messages = auditGraph(graph).map((v) => `[${v.kind}] ${v.message}`);
  const has = (kind: string, needle: string): boolean =>
    messages.some((m) => m.startsWith(`[${kind}]`) && m.includes(needle));

  assert.ok(has('boundary', 'shared/pure.ts imports core/plain.ts'), 'shared must be a pure leaf');
  assert.ok(has('boundary', 'core/leak.ts imports tools/impl.ts'), 'core must not import tools');
  assert.ok(has('boundary', 'tools/impl.ts imports agent/host.ts'), 'tools must not import agent');
  assert.ok(has('boundary', 'agent/host.ts imports entrypoints/root.ts'), 'agent must not import entrypoints');
  assert.ok(has('boundary', 'runtime/leak.ts imports background/host.ts'), 'runtime must not import the broker');
  assert.ok(has('boundary', 'background/host.ts imports runtime/host.ts'), 'broker must not import DOM executors');
  assert.ok(has('cycle', 'cycle/a.ts'), 'runtime cycle must be flagged');
  assert.equal(messages.length, 7, `unexpected violation set: ${JSON.stringify(messages)}`);
});

test('T29: type-only imports are exempt from boundary and cycle rules', () => {
  const graph = buildGraph(`${REPO}tests/fixtures/import-gate`);
  const messages = auditGraph(graph).map((v) => `[${v.kind}] ${v.message}`);
  assert.ok(!messages.some((m) => m.includes('typeonly')), `type-only cycle was flagged: ${JSON.stringify(messages)}`);
  assert.ok(graph.edges.some((e) => e.typeOnly && e.from.startsWith('typeonly/')), 'type-only edges must be recorded');
});

test('T29: the real src graph is clean (boundaries respected, no runtime cycles)', () => {
  const graph = buildGraph(`${REPO}src`);
  // S6.3 cutover floor + S7.1/S7.2/S8.1 additions (runtime/behavior.ts,
  // runtime/projection.ts): the v2 source inventory (plan/19 §4 ledger). A
  // drop below this count means v2 source was lost, not legacy code deleted.
  assert.ok(graph.files.length >= 23, `unexpectedly small src graph: ${graph.files.length}`);
  const violations = auditGraph(graph);
  assert.deepEqual(violations, [], `src graph violations: ${JSON.stringify(violations)}`);
});

test('T29: unresolvable relative specifiers are reported, bare specifiers are not', () => {
  const graph = buildGraph(`${REPO}src`);
  assert.equal(graph.unresolved.length, 0);
});

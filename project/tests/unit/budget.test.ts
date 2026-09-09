/**
 * Unit baseline — src/agent/budget.ts pure policies (terminal disposition,
 * transport breaker, convergence guard, issue diff, resize-proof classifier)
 * plus the Budget accounting class. All browser-free by design.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Budget,
  disposeTerminalRun,
  transportStreakAfter,
  transportBreakerNotice,
  MAX_TRANSPORT_FAILURES,
  convergenceRefusal,
  MAX_NO_VISIBLE_ACTS,
  diffNewIssues,
  classifyResizeProof,
} from '../../src/agent/budget.ts';
import { AI_CONFIG } from '../../src/core/config/index.ts';

test('disposeTerminalRun: keep only when nothing acted or the state was verified clean', () => {
  assert.equal(disposeTerminalRun(false, false), 'keep'); // nothing to destroy
  assert.equal(disposeTerminalRun(false, true), 'keep');
  assert.equal(disposeTerminalRun(true, false), 'rollback'); // unverified acts must not survive
  assert.equal(disposeTerminalRun(true, true), 'keep'); // verified work survives budget failure
});

test('transport breaker: only chrome connection-level errors accumulate', () => {
  assert.equal(MAX_TRANSPORT_FAILURES, 2);
  const dead = 'Could not establish connection. Receiving end does not exist.';
  assert.equal(transportStreakAfter(0, dead), 1);
  assert.equal(transportStreakAfter(1, dead), 2);
  assert.equal(transportStreakAfter(2, 'The message port closed before a response was received.'), 3);
  // Tool-authored errors / timeouts / successes prove the bridge is alive.
  assert.equal(transportStreakAfter(1, 'the applyCss tool refused the sheet'), 0);
  assert.equal(transportStreakAfter(3, undefined), 0);
});

test('transport breaker notice names the recovery action and claims no page state', () => {
  const notice = transportBreakerNotice(2, 'port closed');
  assert.match(notice, /transport .* unavailable/);
  assert.match(notice, /Reload the page/);
  assert.doesNotMatch(notice, /rolled back|restored/i); // no claim about page state
});

test('convergenceRefusal: re-check of an unchanged page and blind re-authoring are refused', () => {
  assert.match(
    convergenceRefusal({ toolName: 'checkLayout', noVisibleStreak: 0, pageMutatedSinceCheck: false }) ?? '',
    /checkLayout already measured/,
  );
  assert.equal(convergenceRefusal({ toolName: 'checkLayout', noVisibleStreak: 0, pageMutatedSinceCheck: true }), null);
  assert.match(
    convergenceRefusal({ toolName: 'applyCss', noVisibleStreak: MAX_NO_VISIBLE_ACTS, pageMutatedSinceCheck: true }) ?? '',
    /NO VISIBLE CHANGE/,
  );
  assert.equal(convergenceRefusal({ toolName: 'applyCss', noVisibleStreak: MAX_NO_VISIBLE_ACTS - 1, pageMutatedSinceCheck: true }), null);
  assert.equal(convergenceRefusal({ toolName: 'applyCss', noVisibleStreak: 0, pageMutatedSinceCheck: true }), null);
});

test('diffNewIssues: exact strings plus the normalized-key fallback', () => {
  assert.deepEqual(diffNewIssues(['a', 'b'], ['x']), ['a', 'b']);
  assert.deepEqual(diffNewIssues(['a', 'b'], ['a']), ['b']);
  // Same element, ratio drift — the issue label shifted a few chars but is the
  // same pre-existing failure, not a new one.
  const before = 'invisible text: <p> "Hello world my dear friend" (ratio 1.9)';
  const after = 'invisible text: <p> "Hello world my dear foe!!!" (ratio 2.1)';
  assert.deepEqual(diffNewIssues([after], [before]), []);
  // Different element text prefix — genuinely new.
  const other = 'invisible text: <p> "Greeting cosmos friend" (ratio 1.9)';
  assert.deepEqual(diffNewIssues([other], [before]), [other]);
});

test('classifyResizeProof: unknown measurement is error, never clean', () => {
  const baseline = { allIssues: [] };
  assert.deepEqual(classifyResizeProof(null, baseline), { outcome: 'error', newIssues: [] });
  assert.deepEqual(classifyResizeProof({ error: 'dispatch failed' }, baseline), { outcome: 'error', newIssues: [] });
  assert.deepEqual(classifyResizeProof({}, baseline), { outcome: 'error', newIssues: [] });
  assert.deepEqual(classifyResizeProof({ result: { allIssues: ['overflow'] } }, baseline), { outcome: 'issues', newIssues: ['overflow'] });
  assert.deepEqual(classifyResizeProof({ result: { allIssues: [] } }, baseline), { outcome: 'clean', newIssues: [] });
  // A skipped proof (null baseline) never destroys work.
  assert.deepEqual(classifyResizeProof(null, null), { outcome: 'clean', newIssues: [] });
});

test('Budget: step accounting, exhaustion and the observation act-reserve', () => {
  const b = new Budget({ maxSteps: 2, maxWallMs: 10_000 });
  assert.equal(b.exhausted(), false);
  b.recordStep(5);
  assert.equal(b.remaining().steps, 1);
  assert.equal(b.totalCostMs, 5);
  b.recordStep();
  assert.equal(b.exhausted(), true);

  // Wall-cap arithmetic with a synthetic far-deadline budget (±50ms tolerance
  // for the milliseconds already elapsed at assertion time).
  const far = new Budget({ maxSteps: 100, maxWallMs: 1_000_000 });
  assert.equal(far.reserveIntact(4_000), true);
  const cap = far.observationCap(4_000, 1_000);
  assert.ok(Math.abs(cap - (1_000_000 - 4_000)) < 50, `observation cap ${cap}`);
  // When the act reserve exceeds the remaining wall, the cap floors at minTurnMs.
  const tight = new Budget({ maxSteps: 100, maxWallMs: 4_000 });
  assert.equal(tight.observationCap(50_000, 1_000), 1_000);
  assert.equal(tight.reserveIntact(50_000), false);
});

test('Budget defaults come from config, not dead class constants', () => {
  const b = new Budget();
  assert.equal(b.maxSteps, AI_CONFIG.maxSteps);
  assert.equal(b.maxWallMs, AI_CONFIG.maxWallMs);
});

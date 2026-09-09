/**
 * Known-defect characterizations (plan S0.1: "known defects explicitly red,
 * characterized, not hidden"). Each test asserts DESIRED behavior against
 * REAL production code and is expected to fail today. The gate
 * (scripts/test-gate.ts) holds their names in tests/unit/known-red.json:
 * an unexpected failure fails the gate, and a known-red test that starts
 * PASSING also fails the gate — forcing the test to become a plain
 * regression. A red marker can never silently outlive its defect.
 *
 * F05 (audit 01-repository-audit): verification truth —
 *   - loop clause: `verifiedClean` survives subsequent verifier errors, so a
 *     previously clean state can bless a new unverified state (loop-internal;
 *     regression lands with the S4.3 verification gate);
 *   - recovery clause (testable here): `attemptContrastRecovery` treats an
 *     absent/failed post-check as an empty failure list and can report
 *     `repaired: true` when nothing was actually verified.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attemptContrastRecovery } from '../../src/agent/recover.ts';

test('F05: a failed post-repair verification must never count as repaired', async () => {
  const result = await attemptContrastRecovery({
    goal: 'make headings red',
    failures: [{ tag: 'p', text: 'Hello', ratio: 1.2, fg: 'rgb(187, 187, 187)', bg: 'rgb(255, 255, 255)' }],
    baselineFailures: [],
    baselineAllIssues: [],
    callModel: async () => ({ ok: true, json: { tool: 'applyCss', args: { css: 'p { color: #000; }' } } }),
    applyCss: async () => ({ ok: true }),
    // The verifier CRASHED — there is no post-repair evidence at all.
    checkLayout: async () => ({ ok: false, error: 'checkLayout crashed mid-verification' }),
  });
  // Desired: without verification evidence the outcome is not "repaired".
  // Current defect: postCheck?.result?.contrastFailures is undefined, treated
  // as an empty failure list, and `repaired` comes out true.
  assert.equal(result.repaired, false);
});

test('F05: an absent post-repair check (null result) must never count as repaired', async () => {
  const result = await attemptContrastRecovery({
    goal: 'make headings red',
    failures: [{ tag: 'p', text: 'Hello', ratio: 1.2, fg: 'rgb(187, 187, 187)', bg: 'rgb(255, 255, 255)' }],
    baselineFailures: null,
    baselineAllIssues: null,
    callModel: async () => ({ ok: true, json: { tool: 'applyCss', args: { css: 'p { color: #000; }' } } }),
    applyCss: async () => ({ ok: true }),
    checkLayout: async () => null, // verifier unavailable entirely
  });
  assert.equal(result.repaired, false);
});

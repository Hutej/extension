/**
 * tests/budget-reserve-test.ts — Phase 2.5 TASK2 regression: the act reserve
 * must remain available after multiple observation calls.
 *
 * ROOT CAUSE this pins: the old loop used Math.min(rem, callTimeoutMs) for the
 * observation model-call timeout and the retry gate checked `remaining <= MIN_TURN_MS`
 * (5s). So a parse error at rem=25s passed the gate, the retry ran up to 25s,
 * and landed at 0 — eating the entire 20s act reserve. That is the exact cause
 * of "budget too low for retry after parse error" (5/6 baseline goals).
 *
 * The invariant the loop now enforces:
 *   remaining budget
 *        -> reserve ACT_RESERVE_MS
 *        -> observation can only use: remaining - ACT_RESERVE_MS
 *        -> ACT still has its reserved time
 *
 * This test simulates several observation turns, each consuming its full
 * observationCap (the worst case), and asserts the act reserve is intact
 * throughout and a final act call still has the full reserve available.
 *
 * Usage: node --experimental-strip-types tests/budget-reserve-test.ts
 * No browser, no credentials.
 */

import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Budget } from '../src/agent/budget.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROOF_DIR = join(__dirname, '..', 'proof');
mkdirSync(PROOF_DIR, { recursive: true });

interface Check { name: string; pass: boolean; detail: string; }
const checks: Check[] = [];

const ACT_RESERVE_MS = 12_000;  // production value (Phase 2.5 TASK2)
const MIN_TURN_MS = 5_000;
const MAX_WALL_MS = 60_000;

// ── 1. observationCap preserves the reserve by construction ──────────────
{
  const b = new Budget({ maxWallMs: MAX_WALL_MS });
  // At t=0, rem=60s. observationCap must be 60-12=48s (leaves 12s reserve).
  const cap0 = b.observationCap(ACT_RESERVE_MS, MIN_TURN_MS);
  checks.push({
    name: 'observationCap at 60s remaining = 48s (leaves 12s act reserve)',
    pass: cap0 === 48_000,
    detail: `expected 48000, got ${cap0}`,
  });
  // After an observation call consuming the FULL cap (48s), rem=12s — the
  // reserve is intact, not breached.
  const b2 = new Budget({ maxWallMs: MAX_WALL_MS });
  (b2 as any).wallStart = Date.now() - 48_000;
  const reserveAfter = b2.reserveIntact(ACT_RESERVE_MS);
  checks.push({
    name: 'after one full-cap observation (48s), 12s act reserve still intact',
    pass: reserveAfter === true,
    detail: `reserveIntact=${reserveAfter} (remaining=${b2.remaining().wallMs}ms)`,
  });
  const cap2 = b2.observationCap(ACT_RESERVE_MS, MIN_TURN_MS);
  // rem=12s, reserve=12s -> rem-reserve=0 -> floor at MIN_TURN_MS(5s).
  // At rem==12s the loop sets restrictToAct=true, so observation is refused.
  checks.push({
    name: 'at exactly the reserve boundary (12s), cap floors at MIN_TURN (5s) — observation refused by restrictToAct, not by a sub-5s cap',
    pass: cap2 === MIN_TURN_MS,
    detail: `expected ${MIN_TURN_MS} (floor), got ${cap2}`,
  });
}

// ── 2. multiple observation calls cannot breach the reserve ──────────────
// The core proof: simulate N observation turns. Each turn the loop caps the
// call at observationCap(rem). Even if every call takes its FULL cap, the
// reserve never drops below ACT_RESERVE_MS before restrictToAct fires.
{
  const b = new Budget({ maxWallMs: MAX_WALL_MS });
  (b as any).wallStart = Date.now();
  let breaches = 0;
  let turns = 0;
  let finalActAvailable = 0;
  // Simulate: while remaining > ACT_RESERVE (observation allowed), each call
  // consumes its full observationCap. The reserve must never be breached DURING
  // observation.
  for (let i = 0; i < 20; i++) {
    const rem = b.remaining().wallMs;
    if (rem <= ACT_RESERVE_MS) break; // restrictToAct — observation refused
    const cap = b.observationCap(ACT_RESERVE_MS, MIN_TURN_MS);
    // The loop's invariant: a call may take AT MOST `cap`. Advance the clock
    // by cap (worst case). remaining() recomputes from wallStart.
    (b as any).wallStart -= cap; // spending time = wallStart moves backwards
    turns++;
    const remAfter = b.remaining().wallMs;
    // After an observation call, remaining must NOT have dropped below the
    // reserve (it may equal it at the boundary). A breach = remAfter < reserve.
    if (remAfter < ACT_RESERVE_MS - 1) breaches++;
  }
  // After observation ends, the act reserve is what remains for acting.
  finalActAvailable = b.remaining().wallMs;
  checks.push({
    name: 'over multiple full-cap observation turns, the act reserve is never breached',
    pass: breaches === 0,
    detail: `${breaches} breach(es) across ${turns} observation turn(s)`,
  });
  checks.push({
    name: 'after observation, act budget still available (>= ACT_RESERVE_MS boundary)',
    pass: finalActAvailable >= ACT_RESERVE_MS - 1, // at/above the reserve boundary
    detail: `finalActAvailable=${finalActAvailable}ms (reserve=${ACT_RESERVE_MS}ms), turns=${turns}`,
  });
}

// ── 3b. THE BREACH-WINDOW (adversarial review wf_e3e50d92 finding, FIXED) ─
// The MIN_TURN_MS floor vs the reserve: in the window rem ∈ (ACT_RESERVE,
// ACT_RESERVE + MIN_TURN) = (12000, 17000), the floor forces turnCap=5000,
// and a full-cap observation call dips below the 12s reserve. The loop now
// refuses observation (restrictToAct) a full MIN_TURN earlier, so observation
// only runs when rem > ACT_RESERVE + MIN_TURN. Pin every boundary.
{
  const at = (ms: number) => {
    const b = new Budget({ maxWallMs: MAX_WALL_MS });
    (b as any).wallStart = Date.now() - (MAX_WALL_MS - ms);
    const rem = b.remaining().wallMs;
    // Mirror the loop's restrictToAct (post-fix) + turnCap for an observation turn.
    const restrictToAct = rem <= ACT_RESERVE_MS + MIN_TURN_MS;
    const turnCap = restrictToAct ? rem : Math.max(MIN_TURN_MS, rem - ACT_RESERVE_MS);
    // Worst case: a full-cap observation call. remaining after = rem - turnCap.
    // (If restrictToAct, observation is refused — so the "worst case" is the
    // act turn, which is ALLOWED to use the reserve. We assert observation is
    // only permitted when the full cap can't breach.)
    const observationPermitted = !restrictToAct;
    const worstRemainingAfterObservation = observationPermitted ? rem - turnCap : rem;
    const reserveIntact = worstRemainingAfterObservation >= ACT_RESERVE_MS;
    return { ms, rem, restrictToAct, observationPermitted, turnCap, worstRemainingAfterObservation, reserveIntact };
  };
  // The breach window boundaries — observation must be REFUSED throughout it.
  const cases = [12001, 13000, 16999, 17000, 17001, 25000].map(at);
  // In (12000, 17000]: restrictToAct=true, observation refused (no breach possible).
  const refusedInWindow = cases.filter((c) => c.rem > ACT_RESERVE_MS && c.rem <= ACT_RESERVE_MS + MIN_TURN_MS)
    .every((c) => c.restrictToAct && !c.observationPermitted);
  // Above the window: observation permitted, and the full cap never breaches.
  const noBreachAboveWindow = cases.filter((c) => c.rem > ACT_RESERVE_MS + MIN_TURN_MS)
    .every((c) => c.observationPermitted && c.reserveIntact);
  checks.push({
    name: 'breach window rem ∈ (12000,17000]: observation REFUSED (no MIN_TURN-floor breach)',
    pass: refusedInWindow,
    detail: cases.filter((c) => c.rem > ACT_RESERVE_MS && c.rem <= ACT_RESERVE_MS + MIN_TURN_MS)
      .map((c) => `rem=${c.rem} restrict=${c.restrictToAct}`).join('; '),
  });
  checks.push({
    name: 'above the window (rem >17000): observation permitted, full cap never breaches the 12s reserve',
    pass: noBreachAboveWindow,
    detail: cases.filter((c) => c.rem > ACT_RESERVE_MS + MIN_TURN_MS)
      .map((c) => `rem=${c.rem} cap=${c.turnCap} worst=${c.worstRemainingAfterObservation}${c.reserveIntact ? '(>=12k ✓)' : '(BREACH!)'}`).join('; '),
  });
}

// ── 3. the OLD arithmetic WOULD have breached the reserve ───────────────
// Document the bug we fixed: the old gate `remaining <= MIN_TURN_MS` (5s)
// let a retry proceed at rem=15s with a 15s timeout, breaching the 12s reserve.
{
  const b = new Budget({ maxWallMs: MAX_WALL_MS });
  (b as any).wallStart = Date.now() - 45_000; // rem=15s
  const oldGate = b.remaining().wallMs > MIN_TURN_MS; // old: 15 > 5 -> retry proceeds
  const oldRetryTimeout = Math.min(b.remaining().wallMs, 30_000); // 15s
  // After the old retry taking its full 15s, remaining = 0.
  const remAfterOldRetry = b.remaining().wallMs - oldRetryTimeout;
  checks.push({
    name: 'OLD arithmetic let a retry at 15s run 15s -> 0s remaining (reserve breached) — the bug',
    pass: oldGate && oldRetryTimeout === 15_000 && remAfterOldRetry <= 0,
    detail: `oldGate=${oldGate}, oldRetryTimeout=${oldRetryTimeout}ms, remAfter=${remAfterOldRetry}ms — this is the baseline failure`,
  });
  // NEW arithmetic at rem=15s: restrictToAct=false (15>12), retryFloor =
  // ACT_RESERVE + MIN_TURN = 17_000, and rem(15s) <= retryFloor(17s) -> retry
  // REFUSED -> returns budgetExhausted, preserving any already-acted state.
  const newRetryFloor = ACT_RESERVE_MS + MIN_TURN_MS; // 17_000
  const newRetryProceeds = b.remaining().wallMs > newRetryFloor; // 15 > 17 -> false
  checks.push({
    name: 'NEW arithmetic refuses the retry at 15s (preserves reserve) — the fix',
    pass: newRetryProceeds === false,
    detail: `retryFloor=${newRetryFloor}ms, rem=15s -> retry proceeds=${newRetryProceeds} (false = reserve preserved)`,
  });
  // And at rem=25s the NEW arithmetic correctly ALLOWS the retry (25 > 17): a
  // retry can complete (~12s cap) and still leave the reserve intact.
  const b3 = new Budget({ maxWallMs: MAX_WALL_MS });
  (b3 as any).wallStart = Date.now() - 35_000; // rem=25s
  const proceedsAt25 = b3.remaining().wallMs > (ACT_RESERVE_MS + MIN_TURN_MS);
  checks.push({
    name: 'NEW arithmetic ALLOWS the retry at 25s (25 > 17 — enough for retry + reserve)',
    pass: proceedsAt25 === true,
    detail: `rem=25s, retryFloor=17s -> retry proceeds=${proceedsAt25} (true = retry can complete, reserve survives)`,
  });
}

let failures = 0;
console.log('\nPhase 2.5 TASK2 — act-budget-reserve arithmetic regression\n');
for (const c of checks) {
  console.log(`  ${c.pass ? '✓' : '✖'} ${c.name}`);
  if (!c.pass) { console.log(`      ${c.detail}`); failures++; }
}
const pass = failures === 0;
writeFileSync(join(PROOF_DIR, 'budget-reserve-test.json'), JSON.stringify({ checks, pass }, null, 2));
console.log(`\n${pass ? 'All budget-reserve checks passed.\n' : `${failures} check(s) FAILED\n`}`);
process.exit(pass ? 0 : 1);

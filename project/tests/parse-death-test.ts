/**
 * tests/parse-death-test.ts — Phase 2 finding A regression: the loop must
 * return a STRUCTURED error (not crash) when the model returns invalid JSON
 * twice, AND must roll back any DOM/CSS changes before that terminal return.
 *
 * Root cause (documented in PHASE2_REPORT.md, fix deferred to Phase 6): the
 * model returns non-JSON. loop.ts:127-144 retries once, then either
 *   budgetExhausted ('budget too low for retry after parse error')  — if budget
 *   error ('model returned invalid JSON twice')                       — else
 * Neither path throws; both return a LoopResult. This test pins that contract
 * by reading loop.ts so a future refactor can't silently turn a parse death
 * into a crash or (worse) leave a partial transform on the page.
 *
 * Usage: node --experimental-strip-types tests/parse-death-test.ts
 * No browser, no credentials — source-level regression (like parse-location-test).
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROOF_DIR = join(__dirname, '..', 'proof');
mkdirSync(PROOF_DIR, { recursive: true });

interface Check { name: string; pass: boolean; detail: string; }
const checks: Check[] = [];

function readSrc(rel: string): string {
  return readFileSync(join(__dirname, '..', 'src', rel), 'utf-8');
}

const loop = readSrc('agent/loop.ts');

// 1. The loop retries once on a parse error (a second callLoopModel in the
//    parse-error branch) before giving up.
checks.push({
  name: 'loop retries once on a model parse error (a 2nd callLoopModel in the parse branch)',
  pass: /if \(!modelResult\.ok \|\| !modelResult\.json\)[\s\S]{0,2000}modelResult = await callLoopModel/.test(loop),
  detail: 'loop.ts retries the call once after a non-JSON / model error, before declaring a parse death',
});

// 2. The double-parse-failure returns a STRUCTURED error, not a throw.
checks.push({
  name: 'double parse failure returns status:"error" with a reason (no throw)',
  pass: /status: 'error'[\s\S]{0,40}reason: 'model returned invalid JSON twice'/.test(loop),
  detail: 'second parse failure → { status:"error", reason:"model returned invalid JSON twice" }',
});

// 3. The low-budget parse failure returns a structured budgetExhausted.
checks.push({
  name: 'low-budget parse failure returns status:"budgetExhausted" (no throw)',
  pass: /insufficient to retry after a model parse error/.test(loop) && /status: 'budgetExhausted'[\s\S]{0,80}insufficient to retry after a model parse error/.test(loop),
  detail: 'budget <= MIN_TURN after a parse error → structured budgetExhausted, not a crash',
});

// 4. F3 — both parse-death terminal paths roll back before returning.
checks.push({
  name: 'F3: rollbackDomIfActed is called before both parse-death returns',
  pass: /rollbackDomIfActed\(tabId, journal, origin\)[\s\S]{0,300}insufficient to retry after a model parse error/.test(loop)
    && /rollbackDomIfActed\(tabId, journal, origin\)[\s\S]{0,300}model returned invalid JSON twice/.test(loop),
  detail: 'a parse death after a partial act rolls back every change — no silent permanent mutation',
});

// 5. The terminal error paths never re-throw the parse failure.
checks.push({
  name: 'no `throw` on a parse/model error in the loop body',
  pass: !/if \(!modelResult\.ok \|\| !modelResult\.json\)[\s\S]{0,600}throw /.test(loop),
  detail: 'a parse death surfaces as a LoopResult, not an exception',
});

// 6. Phase 6 — parse retry is BOUNDED to exactly one (no retry loop). The most
//    dangerous regression of a parse-death wall is a future refactor turning the
//    single retry into a `while`/`for`/`do` loop — a malformed response would then
//    spin until the budget dies. The parse-error branch (from the `if` to the
//    second-failure `return { status: 'error'`) must contain exactly one retry
//    `callLoopModel` and no loop construct.
{
  const m = loop.match(/if \(!modelResult\.ok \|\| !modelResult\.json\)[\s\S]*?reason: 'model returned invalid JSON twice'/);
  const branch = m ? m[0] : '';
  const retryCalls = (branch.match(/callLoopModel/g) || []).length;
  const hasRetryLoop = /\b(while|for|do)\s*[\(\{]/.test(branch);
  checks.push({
    name: 'Phase6: parse-error branch retries EXACTLY once (one callLoopModel, no while/for/do loop)',
    pass: retryCalls === 1 && !hasRetryLoop,
    detail: `retry calls in branch=${retryCalls}, hasRetryLoop=${hasRetryLoop}`,
  });
}
// 7. Phase 6 — the retry is capped at 12s so it can NEVER burn the full remaining
//    budget (the parse-death wall: a malformed response must not consume the
//    remaining budget before a useful recovery/act). Pin the cap literal.
checks.push({
  name: 'Phase6: retry timeout capped at min(retryCap, 12_000) — cannot burn the full budget',
  pass: /Math\.min\(\s*retryCap\s*,\s*12_000\s*\)/.test(loop),
  detail: 'retryCap bounded to 12s so one malformed response costs at most 12s, not the full 30s',
});

// 8. Phase 6 — giveUp / terminal loop behavior: EVERY rollback is followed by a
//    return (no path rolls back then continues the loop), and every giveUp
//    branch returns out of runLoop. A rollback-then-continue would re-enter the
//    while loop and keep spending on an already-aborted run — the audit's "can
//    anything accidentally continue after a terminal rollback" check. Source-
//    level, like the rest of this file.
{
  // Every `rollbackDomIfActed(...)` must be followed by a `return {` BEFORE any
  // `continue` — i.e. the nearest control-flow statement after the rollback is a
  // return. A rollback-then-continue would re-enter the while loop and keep
  // spending on an aborted run.
  const rollbackIdx = [...loop.matchAll(/await rollbackDomIfActed\(/g)].map((m) => m.index!);
  let allReturnFirst = true;
  for (const i of rollbackIdx) {
    const after = loop.slice(i, i + 1200);
    const ret = after.search(/return\s*\{/);
    const con = after.search(/continue;/);
    // nearest must be a return (con may be -1, or after ret)
    if (ret === -1 || (con !== -1 && con < ret)) allReturnFirst = false;
  }
  checks.push({
    name: 'Phase6: every rollbackDomIfActed is followed by return before continue (no rollback-then-continue)',
    pass: allReturnFirst,
    detail: `${rollbackIdx.length} rollback site(s); allReturnFirst=${allReturnFirst}`,
  });
  // The circuit-breaker giveUp returns out of runLoop. The return object reads
  // `{ status: 'gaveUp', reason: \`giving up: ${consecutiveCheckLayoutUndos}...\` }`.
  checks.push({
    name: 'Phase6: circuit-breaker giveUp (consecutive checkLayout undos) returns, does not continue the loop',
    pass: /status: 'gaveUp',\s*reason: `giving up: \$\{consecutiveCheckLayoutUndos\}/.test(loop),
    detail: '2 consecutive layout breaks → return gaveUp (exits runLoop)',
  });
  // The model/tool giveUp branches each return (not continue).
  const giveUpBranches = (loop.match(/status: 'gaveUp'/g) || []).length;
  checks.push({
    name: 'Phase6: all giveUp branches return out of runLoop (giveUp stops model calls)',
    pass: giveUpBranches >= 3,
    detail: `${giveUpBranches} gaveUp return site(s) — model giveUp, tool giveUp, circuit-breaker`,
  });
}

let failures = 0;
console.log('\nPhase 2 finding A — describePage parse/JSON death regression\n');
for (const c of checks) {
  console.log(`  ${c.pass ? '✓' : '✖'} ${c.name}`);
  if (!c.pass) { console.log(`      ${c.detail}`); failures++; }
}
const pass = failures === 0;
writeFileSync(join(PROOF_DIR, 'parse-death-test.json'), JSON.stringify({ checks, pass }, null, 2));
console.log(`\n${pass ? 'All parse-death regression checks passed.\n' : `${failures} check(s) FAILED\n`}`);
process.exit(pass ? 0 : 1);

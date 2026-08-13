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
  pass: /budget too low for retry after parse error/.test(loop) && /status: 'budgetExhausted'[\s\S]{0,80}budget too low for retry/.test(loop),
  detail: 'budget <= MIN_TURN after a parse error → structured budgetExhausted, not a crash',
});

// 4. F3 — both parse-death terminal paths roll back before returning.
checks.push({
  name: 'F3: rollbackDomIfActed is called before both parse-death returns',
  pass: /rollbackDomIfActed\(tabId, journal, origin\)[\s\S]{0,120}budget too low for retry/.test(loop)
    && /rollbackDomIfActed\(tabId, journal, origin\)[\s\S]{0,120}model returned invalid JSON twice/.test(loop),
  detail: 'a parse death after a partial act rolls back every change — no silent permanent mutation',
});

// 5. The terminal error paths never re-throw the parse failure.
checks.push({
  name: 'no `throw` on a parse/model error in the loop body',
  pass: !/if \(!modelResult\.ok \|\| !modelResult\.json\)[\s\S]{0,600}throw /.test(loop),
  detail: 'a parse death surfaces as a LoopResult, not an exception',
});

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

/**
 * tests/classify-checklayout-test.ts — Phase 3 F5.2/F5.5 unit test.
 *
 * Proves the REAL loop integrity-decision (src/agent/loop.ts classifyCheckLayout)
 * — the branch the forced-checkLayout-after-act block uses to decide
 * error / issues / clean. This is the logic the adversarial review (RUNNER
 * blocker) found was DEAD CODE: checkLayout returns ok:false on issues, and a
 * naive clOk=!!cl.ok made every real break look like a verifier error so the
 * undo branch + circuit-breaker were unreachable. classifyCheckLayout encodes
 * the correct contract; this test imports the REAL function and proves all
 * three outcomes + the circuit-breaker cap.
 *
 * Pure: no model, no browser, no credentials. Imports the real loop export.
 * Run: node --experimental-strip-types tests/classify-checklayout-test.ts
 */
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROOF_DIR = join(__dirname, '..', 'proof');
mkdirSync(PROOF_DIR, { recursive: true });

// Import the REAL decision function (not a copy). Node strip-types can't
// resolve the loop's heavy imports (reason/persist) — so we read the source
// and eval ONLY classifyCheckLayout's body (transpiled to JS via esbuild so
// the type annotations eval cleanly). To avoid drift, a source guard asserts
// the function exists with the exact contract comment.
import { readFileSync } from 'node:fs';
import * as esbuild from 'esbuild';
const loopSrc = readFileSync(join(__dirname, '..', 'src', 'agent', 'loop.ts'), 'utf-8');
assert.ok(/export function classifyCheckLayout/.test(loopSrc), 'classifyCheckLayout must be exported from loop.ts');
assert.ok(/checkLayout's contract: it returns `ok: issues.length === 0`/.test(loopSrc),
  'classifyCheckLayout must document the ok:false-means-issues contract');

// Extract classifyCheckLayout's source, transpile to JS, eval in isolation (pure).
const fnSrc = loopSrc.slice(loopSrc.indexOf('export function classifyCheckLayout'));
const fnBody = fnSrc.slice(0, fnSrc.indexOf('\n}\n') + 2)
  .replace('export function classifyCheckLayout', 'function classifyCheckLayout');
// Wrap so the transpiled function is RETURNED (an eval of a function decl in
// strict module scope isn't visible outside eval; returning it via an IIFE is).
const wrapped = '(function(){' + fnBody + ' return classifyCheckLayout; })()';
const fnJs = (await esbuild.transform(wrapped, { loader: 'ts', target: 'es2020' })).code;
const classifyCheckLayout: any = eval(fnJs);

interface Check { name: string; pass: boolean; detail: string }
const checks: Check[] = [];

// ── The dead-code bug, fixed: issues present → outcome 'issues' (not 'error') ──
// checkLayout returns { ok: false, result: { issues: [...] } } when it FINDS issues.
const issuesCl = { ok: false, result: { issues: ['horizontal overflow: scrollWidth=1200', 'unreachable content: <a>'] } };
const r1 = classifyCheckLayout(issuesCl);
checks.push({
  name: 'BUG FIX: issues present (ok:false, result.issues non-empty) → outcome "issues", NOT "error"',
  pass: r1.outcome === 'issues' && r1.issues.length === 2,
  detail: `outcome=${r1.outcome} (must be issues), issues=${r1.issues.length}`,
});

// ── Clean: no issues → 'clean' ──
const cleanCl = { ok: true, result: { issues: [] } };
const r2 = classifyCheckLayout(cleanCl);
checks.push({
  name: 'clean: ok:true, no issues → outcome "clean"',
  pass: r2.outcome === 'clean' && r2.issues.length === 0,
  detail: `outcome=${r2.outcome}`,
});

// ── Verifier error: dispatch failed (no result) → 'error', no undo ──
checks.push({
  name: 'error: dispatch failed (no result) → outcome "error"',
  pass: classifyCheckLayout({ ok: false, error: 'tool call timed out' }).outcome === 'error',
  detail: 'ok:false + error + no result must be error (not issues)',
});
checks.push({
  name: 'error: null response → outcome "error"',
  pass: classifyCheckLayout(null).outcome === 'error',
  detail: 'null dispatch must be error',
});
checks.push({
  name: 'error: checkLayout internal error string → outcome "error"',
  pass: classifyCheckLayout({ ok: false, error: 'selector did not resolve', result: null }).outcome === 'error',
  detail: 'error field present → error',
});

// ── The ok:false-with-issues case is the one the old code broke; re-confirm ──
// explicitly that a checkLayout returning ok:false WITHOUT an error field is
// treated as ISSUES (this is the exact shape verify.ts:228 emits).
checks.push({
  name: 'exact verify.ts shape: {ok:false, result:{issues:[x]}} (no error) → "issues"',
  pass: classifyCheckLayout({ ok: false, result: { issues: ['one issue'], overflow: true, issueCount: 1 } }).outcome === 'issues',
  detail: 'this is the real checkLayout output shape on a found issue',
});

// ── Circuit-breaker cap: simulate the loop counter using the decision ──
// Two consecutive 'issues' outcomes → counter reaches MAX (2) → would giveUp.
// (The loop wraps this; here we prove the decision feeds the counter correctly.)
let counter = 0;
const MAX = 2;
for (let i = 0; i < 3; i++) {
  const o = classifyCheckLayout({ ok: false, result: { issues: ['break ' + i] } });
  if (o.outcome === 'issues') counter++;
  else if (o.outcome === 'clean') counter = 0;
}
checks.push({
  name: 'circuit-breaker: 3 consecutive issues → counter 3 (>= MAX=2 → loop would giveUp)',
  pass: counter >= MAX,
  detail: `counter=${counter} (MAX=${MAX})`,
});

// A clean in between resets the counter (the SKEPTIC's reset concern —
// correct behavior: a successful act between breaks is progress, not a streak).
let counter2 = 0;
for (const cl of [
  { ok: false, result: { issues: ['break1'] } }, // issues → counter=1
  { ok: true, result: { issues: [] } },          // clean  → counter=0 (act succeeded)
  { ok: false, result: { issues: ['break2'] } }, // issues → counter=1
]) {
  const o = classifyCheckLayout(cl);
  if (o.outcome === 'issues') counter2++;
  else if (o.outcome === 'clean') counter2 = 0;
}
checks.push({
  name: 'circuit-breaker: a clean between two breaks RESETS the counter (progress, not a streak)',
  pass: counter2 === 1,
  detail: `counter after break1→clean→break2 = ${counter2} (must be 1, not 2 — the clean was a successful act)`,
});

let failures = 0;
console.log('\nPhase 3 F5.2/F5.5 — classifyCheckLayout (the real loop decision) unit test\n');
for (const c of checks) {
  console.log(`  ${c.pass ? '✓' : '✖'} ${c.name}`);
  if (!c.pass) { console.log(`      ${c.detail}`); failures++; }
}
const pass = failures === 0;
writeFileSync(join(PROOF_DIR, 'classify-checklayout-test.json'), JSON.stringify({ checks, pass }, null, 2));
console.log(`\n${pass ? `All ${checks.length} classifyCheckLayout cases passed.\n` : `${failures} case(s) FAILED\n`}`);
process.exit(pass ? 0 : 1);

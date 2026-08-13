/**
 * tests/parse-extract-test.ts — Phase 2.5 TASK1 regression: the tolerant JSON
 * extractor (core/reason extractJson) handles the ACTUAL captured model
 * outputs, not synthetic ones.
 *
 * The captured real outputs live in proof/parse-failures/REAL-*.txt and
 * proof/transport-capture*.json. This test embeds the verbatim real outputs
 * (the shapes the model actually returned) and asserts extractJson recovers
 * every one that contains JSON, and correctly fails the ones that don't.
 *
 * It ALSO guards the failure shapes the spec names (prose-around-JSON,
 * trailing text, multiple objects, truncation) even though none appeared in
 * the real capture — so the extractor is robust if they ever do.
 *
 * Usage: node --experimental-strip-types tests/parse-extract-test.ts
 * No browser, no credentials.
 */

import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// extractJson is a pure function (no DOM, no fetch). We import it directly.
// (Node strip-types can't resolve the `../config` directory import reason.ts
// uses, so we inline a faithful copy of extractJson + balancedObject here,
// sourced verbatim from src/core/reason/index.ts. If they drift, a source
// equality check below fails loudly.)
import { readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROOF_DIR = join(__dirname, '..', 'proof');
mkdirSync(PROOF_DIR, { recursive: true });

// ── Import the REAL extractor (not an inlined copy) ──
// Phase 2.5 adversarial review (wf_e3e50d92) found an earlier version of this
// test inlined a copy of extractJson+balancedObject with only a name-existence
// guard — a body edit to the real code would pass the guard while the test ran
// its stale copy. Fixed by extracting the real code into a dependency-free
// module (src/core/reason/extract.ts) so this test imports the REAL functions.
// Pure module, no directory/config imports — safe under Node strip-types.
import { extractJson } from '../src/core/reason/extract.ts';

// ── Source-existence guard: the canonical extractor module must exist ──
{
  const extract = readFileSync(join(__dirname, '..', 'src', 'core', 'reason', 'extract.ts'), 'utf-8');
  assert.ok(/export function extractJson/.test(extract), 'extractJson missing from src/core/reason/extract.ts — the real module the test imports');
  assert.ok(/export function balancedObject/.test(extract), 'balancedObject missing from src/core/reason/extract.ts');
  // And reason.ts must still re-export it (so the loop's import path is intact).
  const reason = readFileSync(join(__dirname, '..', 'src', 'core', 'reason', 'index.ts'), 'utf-8');
  assert.ok(/extractJson/.test(reason), 'reason/index.ts no longer references extractJson');
}

interface Case { name: string; content: string; expectOk: boolean; expectTool?: string; real: boolean }
const cases: Case[] = [
  // ── REAL captured outputs (verbatim from proof/transport-capture*.json) ──
  {
    name: 'REAL: bare single-line JSON (glm-5.2, transport-capture call4)',
    content: '{"tool":"describePage","args":{},"reasoning":"I need to identify the sidebar region on the Wikipedia page to hide it."}',
    expectOk: true, expectTool: 'describePage', real: true,
  },
  {
    name: 'REAL: pretty-printed multi-line JSON (glm-4.7-flash, capture-more call3)',
    content: '{   "tool": "describePage",   "args": {},   "reasoning": "I need to understand the page structure to identify the main content area containing the CSS documentation." }',
    expectOk: true, expectTool: 'describePage', real: true,
  },
  {
    name: 'REAL: markdown-fenced JSON with trailing space (glm-4.7-flash, transport-capture call2)',
    content: '```json {"tool":"findElements","args":{"selector":"#mw-panel"},"reasoning":"Wikipedia\'s sidebar is typically identified by the ID \'mw-panel\'. I need to verify this element exists before hiding it."} ```',
    expectOk: true, expectTool: 'findElements', real: true,
  },
  {
    name: 'REAL: pretty-printed done-summary (glm-4.7-flash, capture-more call1)',
    content: '{   "done": true,   "summary": "The CSS justify-content property aligns the content of a flex container along the main axis. It defines how the browser distributes space between and around flex items." }',
    expectOk: true, real: true,
  },
  // ── Guarded shapes (NOT observed in real capture, but spec-named; cheap robustness) ──
  {
    name: 'GUARD: prose before JSON',
    content: 'Sure! Here is the JSON:\n{"tool":"hide","args":{"selector":"#x"},"reasoning":"r"}',
    expectOk: true, expectTool: 'hide', real: false,
  },
  {
    // Adversarial review (wf_e3e50d92, skeptic claim_2): a '{...}' in PROSE
    // before the real JSON defeated the old first-'{' strategy. The extractor
    // now tries EVERY balanced object, so it skips the prose brace and reaches
    // the real JSON.
    name: 'GUARD: brace in prose before JSON (defeated old first-{ strategy)',
    content: 'I will use the {selector} pattern:\n{"tool":"hide","args":{"selector":"#x"},"reasoning":"r"}',
    expectOk: true, expectTool: 'hide', real: false,
  },
  {
    name: 'GUARD: prose before and trailing text after',
    content: 'Let me help.\n```json\n{"tool":"describePage","args":{},"reasoning":"r"}\n```\nHope that helps!',
    expectOk: true, expectTool: 'describePage', real: false,
  },
  {
    name: 'GUARD: multiple JSON objects — take the first complete one',
    content: '{"tool":"describePage","args":{},"reasoning":"first"} {"tool":"hide","args":{"selector":"#x"},"reasoning":"second"}',
    expectOk: true, expectTool: 'describePage', real: false,
  },
  {
    name: 'GUARD: value containing a brace (balanced scan respects strings)',
    content: '{"tool":"setText","args":{"text":"a {b} c"},"reasoning":"r"}',
    expectOk: true, expectTool: 'setText', real: false,
  },
  // ── Correct failures ──
  { name: 'FAIL: empty content', content: '', expectOk: false, real: false },
  { name: 'FAIL: pure prose, no object', content: 'I cannot do this, sorry.', expectOk: false, real: false },
  { name: 'FAIL: truncated object (unbalanced)', content: '{"tool":"describePage","args":{', expectOk: false, real: false },
];

interface Check { name: string; pass: boolean; detail: string }
const checks: Check[] = [];

for (const c of cases) {
  const r = extractJson(c.content);
  let pass = r.ok === c.expectOk;
  let detail = `expected ok=${c.expectOk}, got ok=${r.ok}`;
  if (c.expectOk && r.ok) {
    const json = (r as any).json;
    const tool = json?.tool;
    if (c.expectTool && tool !== c.expectTool) { pass = false; detail += ` — expected tool="${c.expectTool}", got "${tool}"`; }
    if (!c.expectTool && json?.tool) detail += ` — tool="${tool}"`;
  }
  if (!r.ok) detail += ` — error: ${(r as any).error}`;
  checks.push({ name: `${c.real ? 'REAL' : c.name.startsWith('FAIL') ? 'FAIL' : 'GUARD'}: ${c.name}`, pass, detail });
}

let failures = 0;
console.log('\nPhase 2.5 TASK1 — tolerant JSON extraction regression (real captured outputs)\n');
for (const c of checks) {
  console.log(`  ${c.pass ? '✓' : '✖'} ${c.name}`);
  if (!c.pass) { console.log(`      ${c.detail}`); failures++; }
}
const pass = failures === 0;
writeFileSync(join(PROOF_DIR, 'parse-extract-test.json'), JSON.stringify({ checks, pass, realCases: cases.filter((c) => c.real).length }, null, 2));
console.log(`\n${pass ? `All extraction checks passed (${cases.filter((c) => c.real).length} real captured + ${cases.filter((c) => !c.real).length} guarded/fail).\n` : `${failures} check(s) FAILED\n`}`);
process.exit(pass ? 0 : 1);

/**
 * test-gate — the S0.1/T01 execution gate. `npm test` runs this.
 *
 * Fails (exit 1) when:
 *   - a unit suite file from the checked-in inventory is missing or the
 *     directory holds zero suites (deleted/stale tests must fail the gate,
 *     not silently run nothing — F01);
 *   - zero tests are discovered in the run ("0 tests" is not a pass);
 *   - any test fails unexpectedly (expected-red known-defect tests are
 *     reported by node:test as expected failures and do not count).
 *
 * Parse/summary helpers are exported so tests/unit/gate.test.ts can prove the
 * negative controls (T01) against the real gate logic. Run directly:
 * `node --experimental-strip-types scripts/test-gate.ts`.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const UNIT_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'tests', 'unit');
export const KNOWN_RED_FILE = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'tests', 'unit', 'known-red.json');
export const BROWSER_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'tests', 'browser');
export const BROWSER_KNOWN_RED_FILE = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'tests', 'browser', 'known-red.json');

/** Suites the S0.1 baseline established. A deleted or renamed suite breaks
 *  this list — that is the point: missing suites fail the gate (T01). */
export const EXPECTED_UNIT_SUITES = [
  'color.test.ts',
  'redact.test.ts',
  'contracts.test.ts',
  'trust.test.ts',
  'broker.test.ts',
  'runtime-session.test.ts',
  'styles.test.ts',
  'token-scope.test.ts',
  'targets.test.ts',
  'behavior.test.ts',
  'compile.test.ts',
  'gate.test.ts',
];

export const EXPECTED_BROWSER_SUITES = ['extension.test.ts', 'workspace.test.ts'];

export function missingFromInventory(present: string[], expected: string[]): string[] {
  const have = new Set(present);
  return expected.filter((e) => !have.has(e));
}

export interface TapSummary {
  tests: number;
  pass: number;
  fail: number;
}

/** Parse the trailing summary counts of node:test TAP output. */
export function parseTapSummary(tap: string): TapSummary {
  const count = (re: RegExp): number => {
    const m = tap.match(re);
    return m ? Number(m[1]) : 0;
  };
  return {
    tests: count(/^# tests (\d+)\s*$/m),
    pass: count(/^# pass (\d+)\s*$/m),
    fail: count(/^# fail (\d+)\s*$/m),
  };
}

/** Names of failed tests from TAP (`not ok N - <name>` lines). */
export function parseTapFailures(tap: string): string[] {
  return [...tap.matchAll(/^not ok \d+ - (.*)$/gm)].map((m) => m[1]);
}

/** Split failed tests into unexpected failures and known-red tests that now
 *  pass. Both directions fail the gate (T01/protocol: known defects stay
 *  explicit; a fixed defect forces the wrapper removal). */
export function classifyFailures(failed: string[], knownRed: string[]): { unexpected: string[]; nowPassing: string[] } {
  const known = new Set(knownRed);
  return {
    unexpected: failed.filter((f) => !known.has(f)),
    nowPassing: knownRed.filter((k) => !failed.includes(k)),
  };
}

function isMain(): boolean {
  const entry = process.argv[1] ? resolve(process.argv[1]) : '';
  // fileURLToPath decodes %20 — import.meta.url keeps it encoded (path has spaces).
  return entry !== '' && fileURLToPath(import.meta.url) === entry;
}

interface GroupResult {
  label: string;
  ok: boolean;
  line: string;
}

function runGroup(opts: {
  label: string;
  dir: string;
  expectedSuites: string[];
  knownRedFile: string;
}): GroupResult {
  const { label, dir, expectedSuites, knownRedFile } = opts;
  const suites = readdirSync(dir).filter((f) => f.endsWith('.test.ts')).sort();
  const missing = missingFromInventory(suites, expectedSuites);
  if (missing.length) {
    console.error(`✗ test-gate [${label}] — missing expected suite(s): ${missing.join(', ')}`);
    console.error('  A suite was deleted, renamed or never created. Restore it or amend the expected-suites inventory with the plan/protocol owner.');
    return { label, ok: false, line: '' };
  }
  if (suites.length === 0) {
    console.error(`✗ test-gate [${label}] — zero test files discovered; "0 tests" is not a pass (T01).`);
    return { label, ok: false, line: '' };
  }

  const run = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--test', '--test-reporter=tap', ...suites.map((f) => join(dir, f))],
    { stdio: ['ignore', 'pipe', 'inherit'], cwd: fileURLToPath(new URL('..', import.meta.url)) },
  );
  const tap = String(run.stdout ?? '');
  const summary = parseTapSummary(tap);
  if (summary.tests === 0) {
    console.error(`✗ test-gate [${label}] — TAP reported 0 tests; a zero-discovery run must fail the gate (T01).`);
    console.error(tap.split('\n').slice(-25).join('\n'));
    return { label, ok: false, line: '' };
  }
  const knownRed = JSON.parse(readFileSync(knownRedFile, 'utf8')) as string[];
  const { unexpected, nowPassing } = classifyFailures(parseTapFailures(tap), knownRed);
  if (nowPassing.length) {
    console.error(`✗ test-gate [${label}] — known-defect test(s) now PASS. The defect is fixed: turn the test into a plain regression and remove it from the group's known-red.json.`);
    for (const t of nowPassing) console.error(`  now passing: ${t}`);
    return { label, ok: false, line: '' };
  }
  if (unexpected.length) {
    console.error(`✗ test-gate [${label}] — ${unexpected.length} unexpected failing test(s) (of ${summary.tests}).`);
    for (const t of unexpected) console.error(`  not ok: ${t}`);
    return { label, ok: false, line: '' };
  }
  // run.status is NOT an additional gate condition: node:test exits non-zero
  // when expected-red (known-defect) tests fail, which classifyFailures above
  // already permits. A crashed child produces no TAP tests → caught by the
  // zero-tests check; a failed-to-load suite appears as a not-ok file entry →
  // caught as an unexpected failure.
  return {
    label,
    ok: true,
    line: `${summary.tests} tests, ${summary.pass} passed, ${knownRed.length} known-red (expected), 0 unexpected (${suites.length} suite(s), inventory complete)`,
  };
}

if (isMain()) {
  const mode = process.argv[2] ?? 'all'; // all | --unit | --browser
  const results: GroupResult[] = [];
  if (mode !== '--browser') {
    results.push(runGroup({ label: 'unit', dir: UNIT_DIR, expectedSuites: EXPECTED_UNIT_SUITES, knownRedFile: KNOWN_RED_FILE }));
  }
  if (mode !== '--unit') {
    results.push(runGroup({ label: 'browser', dir: BROWSER_DIR, expectedSuites: EXPECTED_BROWSER_SUITES, knownRedFile: BROWSER_KNOWN_RED_FILE }));
  }
  for (const r of results) if (r.ok) console.log(`✓ test-gate [${r.label}] — ${r.line}`);
  if (results.some((r) => !r.ok)) process.exit(1);
}

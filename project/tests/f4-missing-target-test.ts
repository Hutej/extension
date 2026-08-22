/**
 * tests/f4-missing-target-test.ts — Phase 5 F4 CONTINUITY (Step 3, requirement 5).
 *
 * A target that no longer exists after reload MUST be reported as
 * `missing-target`, NOT silently skipped. The old code console.warn'd and
 * swallowed it; the model/user never knew replay couldn't re-apply a mod.
 *
 * Proves:
 *   1. A setText is persisted on #target with a real digest.
 *   2. The fixture is reloaded WITHOUT #target (it's gone — a re-render removed it).
 *   3. Replay reports `missing-target` for #target (status in the replay report).
 *   4. NO mutation happened (no element was textContent'd) — refusal doesn't touch the page.
 *   5. The outcome is surfaced to storage (revueonReplayReport), not console-only.
 *
 * Rule 15: FAILING CASE — if missing targets were console-warned only (not
 * surfaced to storage as missing-target), the test fails (requirement 5).
 *
 * No model/creds. Built extension + Playwright.
 * Run: node --experimental-strip-types tests/f4-missing-target-test.ts
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createContext, sendToolCall, openFixture, persistActEntry, readReplayReport } from './f4-helpers.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROOF_DIR = join(__dirname, '..', 'proof');
mkdirSync(PROOF_DIR, { recursive: true });

interface Check { name: string; pass: boolean; detail: string }
const checks: Check[] = [];
function ck(n: string, pass: boolean, d: string) { checks.push({ name: n, pass, detail: d }); }

// Fixture WITH the target, and a variant WITHOUT it (target removed by a re-render).
const FIXTURE_WITH = `<!doctype html><html><head><meta charset=utf-8><style>body{margin:0;font:14px/1.4 sans-serif}#main{padding:12px}#target{border:1px solid #ccc;padding:8px}</style></head><body><main id="main"><h1>x</h1><p id="target">Original text here.</p></main></body></html>`;
const FIXTURE_WITHOUT = `<!doctype html><html><head><meta charset=utf-8><style>body{margin:0;font:14px/1.4 sans-serif}#main{padding:12px}</style></head><body><main id="main"><h1>x</h1><p>Some other content, no #target.</p></main></body></html>`;

const context = await createContext('f4-missing-target');

try {
  const page = await openFixture(context, 'https://f4.test/missing', FIXTURE_WITH);
  await sendToolCall(context, page, 'describePage', {});

  // Persist a setText on #target with a real digest.
  const res = await persistActEntry(context, page, {
    tool: 'setText', args: { selector: '#target', text: 'New text from the user.', reason: 'summarise' },
    inverse: { kind: 'restoreText', selector: '#target' }, goal: 'f4-missing',
    prevHtml: 'Original text here.',
  });
  ck('1 setText persisted with a real digest', !!res?.ok && !!res?.identityDigest, `ok=${res?.ok} digest=${res?.identityDigest?.slice(0, 8)}`);

  // Re-serve the fixture WITHOUT #target, then reload — replay must find #target gone.
  await page.route('https://f4.test/missing', (route) => route.fulfill({ contentType: 'text/html', body: FIXTURE_WITHOUT }));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);

  // The target is gone.
  const gone = await page.evaluate(() => document.querySelector('#target') == null);
  ck('2 #target is absent after reload (re-render removed it)', gone === true, `gone=${gone}`);

  // The replay report must surface missing-target (NOT silent console.warn).
  const report = await readReplayReport(context);
  const missingOutcome = report.find((o) => o.selector === '#target' && o.status === 'missing-target');
  ck('3 replay report surfaced missing-target for #target (requirement 5)', !!missingOutcome, JSON.stringify(report).slice(0, 200));
  ck('4 missing-target is NOT treated as a success (status != replayed)', !!missingOutcome && missingOutcome.status !== 'replayed' && missingOutcome.status !== 'already-applied', `status=${missingOutcome?.status}`);

  // NO mutation happened: the page's other content is intact (refusal doesn't touch the page).
  const otherIntact = await page.evaluate(() => (document.querySelector('p') as HTMLElement)?.textContent);
  ck('5 refusal mutated nothing (the other <p> is untouched)', otherIntact === 'Some other content, no #target.', `text="${otherIntact}"`);

  // FAILING CASE: prove that a console-warn-only path would FAIL this. We assert
  // the report array is non-empty AND contains the missing-target status — a
  // silent-skip implementation leaves revueonReplayReport empty → this fails.
  ck('FAILING CASE: the report is non-empty (a silent console-warn would be empty)', report.length > 0, `report.length=${report.length}`);

  await page.close();
} catch (e) {
  ck('test threw', false, (e as Error).message);
}

const pass = checks.filter((c) => c.pass).length;
const fail = checks.length - pass;
writeFileSync(join(PROOF_DIR, 'f4-missing-target-test.json'), JSON.stringify({ pass, fail, checks }, null, 2));
console.log(`\npass=${pass} fail=${fail}`);
for (const c of checks) console.log(`  ${c.pass ? '✓' : '✖'} ${c.name} — ${c.detail}`);
if (fail > 0) process.exit(1);
console.log('ALL PASS');
await context.close();

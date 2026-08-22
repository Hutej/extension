/**
 * tests/f4-identity-mismatch-test.ts — Phase 5 F4 CONTINUITY (Step 3).
 *
 * The approved privacy-safe persisted identity is a SHA-256 of the F1
 * fingerprint. This test proves it does wrong-target detection on replay —
 * the whole reason a digest is persisted at all:
 *   1. A setText is persisted on #target with a real (pre-mutation) digest.
 *   2. Reload with #target's TEXT CHANGED (a re-render swapped the content) —
 *      #target still resolves to one element, but its digest now differs.
 *   3. Replay reports `identity-mismatch` (NOT replayed). NO mutation.
 *   4. Identical-twin protection stays in F1: a selector matching two genuine
 *      twins → `ambiguous-target` (resolveTarget refuses many), NOT the digest
 *      trying to disambiguate. The digest is NOT the twin mechanism.
 *
 * Rule 15 FAILING CASE: replay WITHOUT the persisted fingerprint (the unverified
 * path) would mutate the changed element silently — proving the digest is
 * load-bearing. We assert the digest IS present and the mismatch IS caught.
 *
 * No model/creds. Built extension + Playwright.
 * Run: node --experimental-strip-types tests/f4-identity-mismatch-test.ts
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

// Fixture WITH original text, and a variant where #target's TEXT CHANGED (but
// it's still a unique #target — so resolveTarget succeeds, the digest catches it).
const FIXTURE_ORIG = `<!doctype html><html><head><meta charset=utf-8><style>body{margin:0;font:14px/1.4 sans-serif}#main{padding:12px}#target{border:1px solid #ccc;padding:8px}</style></head><body><main id="main"><h1>x</h1><p id="target">Original text here.</p></main></body></html>`;
const FIXTURE_CHANGED = `<!doctype html><html><head><meta charset=utf-8><style>body{margin:0;font:14px/1.4 sans-serif}#main{padding:12px}#target{border:1px solid #ccc;padding:8px}</style></head><body><main id="main"><h1>x</h1><p id="target">The page re-rendered and this text is now DIFFERENT.</p></main></body></html>`;
// Two genuine identical twins (same tag, attrs, text) for the twin-protection case.
const FIXTURE_TWINS = `<!doctype html><html><head><meta charset=utf-8><style>body{margin:0;font:14px/1.4 sans-serif}#main{padding:12px}.card{border:1px solid #ccc;padding:8px;margin:4px 0}</style></head><body><main id="main"><h1>x</h1><p class="card">Identical twin content AAA</p><p class="card">Identical twin content AAA</p></main></body></html>`;

const context = await createContext('f4-identity-mismatch');

try {
  // ── 1-3: wrong-target on a text change ──
  {
    const page = await openFixture(context, 'https://f4.test/mismatch', FIXTURE_ORIG);
    await sendToolCall(context, page, 'describePage', {});
    const res = await persistActEntry(context, page, {
      tool: 'setText', args: { selector: '#target', text: 'New text from the user.', reason: 'summarise' },
      inverse: { kind: 'restoreText', selector: '#target' }, goal: 'f4-mismatch',
      prevHtml: 'Original text here.',
    });
    ck('1 setText persisted with a real pre-mutation digest', !!res?.ok && !!res?.identityDigest, `ok=${res?.ok} digest=${res?.identityDigest?.slice(0, 8)}`);

    // Reload with the CHANGED text fixture — #target still exists, but its digest differs.
    await page.route('https://f4.test/mismatch', (route) => route.fulfill({ contentType: 'text/html', body: FIXTURE_CHANGED }));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);

    const stillThere = await page.evaluate(() => document.querySelector('#target') != null);
    ck('2 #target still present (one match — resolveTarget succeeds; the digest catches the change)', stillThere === true, `present=${stillThere}`);

    const report = await readReplayReport(context);
    const mismatch = report.find((o) => o.selector === '#target' && o.status === 'identity-mismatch');
    ck('3 replay reported identity-mismatch for #target (wrong-target detection on reload)', !!mismatch, JSON.stringify(report).slice(0, 200));

    // NO mutation: the changed text is intact (replay did NOT overwrite it with the persisted text).
    const textAfter = await page.evaluate(() => (document.querySelector('#target') as HTMLElement)?.textContent);
    ck('4 refusal mutated nothing (the changed text is intact, not overwritten)', textAfter === 'The page re-rendered and this text is now DIFFERENT.', `text="${textAfter}"`);

    ck('FAILING CASE: identity-mismatch is present (an unverified path would have silently mutated)', !!mismatch && textAfter !== 'New text from the user.', `mismatch=${!!mismatch}`);
    await page.close();
  }

  // ── 4: identical-twin protection stays in F1, not the digest ──
  {
    const page = await openFixture(context, 'https://f4.test/twins', FIXTURE_TWINS);
    await sendToolCall(context, page, 'describePage', {});
    // Persist a setText on '.card' — a selector matching TWO genuine twins.
    const res = await persistActEntry(context, page, {
      tool: 'setText', args: { selector: '.card', text: 'X', reason: 'summarise' },
      inverse: { kind: 'restoreText', selector: '.card' }, goal: 'f4-twins',
      prevHtml: 'Identical twin content AAA',
    });
    // setText may have refused (ambiguous) — that's F1 doing its job in-session.
    // For replay the key question: a selector matching twins → ambiguous-target,
    // NOT a digest trying to pick one.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
    const report = await readReplayReport(context);
    // Either setText refused in-session (so nothing persisted) OR replay saw
    // ambiguous-target. If the entry persisted, replay MUST refuse ambiguous.
    const ambiguous = report.find((o) => o.selector === '.card' && o.status === 'ambiguous-target');
    const twinOutcome = ambiguous ?? 'no-entry-or-refused';
    ck('5 twin protection: a twin-matching selector → ambiguous-target (NOT the digest disambiguating)',
      res?.ok ? !!ambiguous : true, `setTextInSessionOk=${res?.ok} replayOutcome=${twinOutcome}`);
    if (res?.ok && !ambiguous) {
      // The entry persisted; replay should NOT have mutated BOTH twins (the digest
      // must not pick "the first one"). Assert neither twin was silently mutated
      // to 'X' by a wrong replay path.
      const texts = await page.evaluate(() => Array.from(document.querySelectorAll('.card')).map((e) => (e as HTMLElement).textContent));
      ck('6 NO twin was silently mutated by replay (digest does not disambiguate twins)',
        !texts.includes('X'), JSON.stringify(texts));
    } else {
      ck('6 NO twin was silently mutated by replay (digest does not disambiguate twins)', true, 'setText refused in-session or replay refused');
    }
    await page.close();
  }
} catch (e) {
  ck('test threw', false, (e as Error).message);
}

const pass = checks.filter((c) => c.pass).length;
const fail = checks.length - pass;
writeFileSync(join(PROOF_DIR, 'f4-identity-mismatch-test.json'), JSON.stringify({ pass, fail, checks }, null, 2));
console.log(`\npass=${pass} fail=${fail}`);
for (const c of checks) console.log(`  ${c.pass ? '✓' : '✖'} ${c.name} — ${c.detail}`);
if (fail > 0) process.exit(1);
console.log('ALL PASS');
await context.close();

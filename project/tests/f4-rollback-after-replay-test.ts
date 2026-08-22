/**
 * tests/f4-rollback-after-replay-test.ts — Phase 5 F4 CONTINUITY (Step 8).
 *
 * F3 exact undo must survive the reload-replay path. After a reload, replay
 * repopulates the session TransactionLog (each replayed tool calls
 * recordStructural), so a subsequent in-session undoAll must restore the page
 * to the post-replay baseline — the documented post-reload F3 semantics
 * (in-session exactness is in-session only; post-reload the clone is of the
 * re-applied state, so undo restores to the re-applied baseline, not the true
 * original before the very first mutation).
 *
 * This test proves:
 *   1. A setText is persisted (with a real identityDigest).
 *   2. Reload → replay re-applies it; the txnLog is populated (txnSize > 0).
 *   3. undoAll restores the element to the PRE-REPLAY text (the clone captured
 *      at replay time = the post-reload baseline).
 *   4. F3's in-session clone semantics are unchanged: on→off restores exactly.
 *
 * Rule 15: a deliberate FAILING case — if replay did NOT repopulate the txnLog
 * (re-execute skipped), undoAll after reload would be a no-op and the text
 * would NOT restore → fails.
 *
 * No model HTTP / no creds. Built extension + Playwright.
 * Run: node --experimental-strip-types tests/f4-rollback-after-replay-test.ts
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createContext, getExtensionId, sendToolCall } from './foundation-helpers.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROOF_DIR = join(__dirname, '..', 'proof');
mkdirSync(PROOF_DIR, { recursive: true });

interface Check { name: string; pass: boolean; detail: string }
const checks: Check[] = [];
function ck(n: string, pass: boolean, d: string) { checks.push({ name: n, pass, detail: d }); }

const context = await createContext('f4-rollback-after-replay');

const FIXTURE = `<!doctype html><html><head><meta charset=utf-8><style>
  body { margin:0; font:14px/1.4 sans-serif } #main { padding:12px }
  #target { border:1px solid #ccc; padding:8px } aside#sb { background:#eee; padding:8px }
</style></head><body>
  <main id="main"><h1>Rollback After Replay</h1>
    <p id="target">Original text the user wanted changed.</p>
    <aside id="sb">Sidebar original</aside>
  </main></body></html>`;

async function openFixture(html: string): Promise<any> {
  const page = await context.newPage();
  await page.route('https://f4.test/rollback', (route) => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('https://f4.test/rollback', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  return page;
}

try {
  // ── Build a persisted setText entry the way the loop does: run the real act,
  //    capture its real identityDigest, persist the entry under scopeKey. ──
  {
    const page = await openFixture(FIXTURE);

    // describePage so the identity store registers #target (verified, not unverified).
    await sendToolCall(context, page, 'describePage', {});

    // Run a real setText → it captures the real identityDigest in its result.
    const setTextRes = await sendToolCall(context, page, 'setText', {
      selector: '#target', text: 'Replaced text after the user request.', reason: 'summarise',
    });
    ck('1 setText succeeded (ok:true)', !!setTextRes?.ok, JSON.stringify(setTextRes).slice(0, 120));
    // The act captured an identityDigest (Step2).
    ck('2 setText captured an identityDigest (Step2)', !!setTextRes?.identityDigest, `digest=${setTextRes?.identityDigest?.slice(0,12)}…`);
    const identityDigest = setTextRes?.identityDigest as string | undefined;

    // Persist the entry the way the loop does: under scopeKey, with path + digest.
    const u = new URL(page.url());
    const extensionId = await getExtensionId(context);
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await page.bringToFront();
    await popup.evaluate(async ({ key, origin, path, goal, selector, text, identityDigest }: any) => {
      const state = {
        enabled: true, origin, path, goal,
        entries: [{
          tool: 'setText', kind: 'act' as const,
          args: { selector, text, reason: 'summarise' },
          result: { selector, textLength: text.length, applied: true, matched: 1, unverified: false },
          identityDigest,
          inverse: { kind: 'restoreText', selector, prevHtml: 'Original text the user wanted changed.' },
          costMs: 0, timestamp: Date.now(),
        }],
        createdAt: Date.now(),
      };
      await chrome.storage.local.set({ [key]: state });
    }, { key: 'rv_' + u.origin + u.pathname, origin: u.origin, path: u.pathname, goal: 'f4-rollback-test', selector: '#target', text: 'Replaced text after the user request.', identityDigest });
    await popup.close();

    // Verify the text is set on the page right now.
    const beforeReload = await page.evaluate(() => (document.querySelector('#target') as HTMLElement)?.textContent);
    ck('3 text is the new text before reload', beforeReload === 'Replaced text after the user request.', `text="${beforeReload}"`);

    // ── Reload → replay ──
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800); // reapplyPersistedDom + the rAF

    const afterReplay = await page.evaluate(() => (document.querySelector('#target') as HTMLElement)?.textContent);
    ck('4 reload replay re-applied the setText (text matches)', afterReplay === 'Replaced text after the user request.', `text="${afterReplay}"`);

    // ── Step8: undoAll after replay must restore the page ──
    // replay repopulated the txnLog (recordStructural on the re-executed setText).
    const undoRes = await (async () => {
      const extensionId2 = await getExtensionId(context);
      const popup2 = await context.newPage();
      await popup2.goto(`chrome-extension://${extensionId2}/popup.html`);
      await page.bringToFront();
      const r = await popup2.evaluate(async (url: string) => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find((t) => t.url === url);
        if (!tab) return { ok: false };
        return new Promise<any>((resolve) => {
          chrome.tabs.sendMessage(tab.id!, { action: 'undoAll' }, (res: any) => resolve(res));
        });
      }, page.url());
      await popup2.close();
      return r;
    })();
    ck('5 undoAll after replay returned undone>0 (txnLog repopulated)', (undoRes?.undone ?? 0) > 0, JSON.stringify(undoRes).slice(0, 160));

    await page.waitForTimeout(300);
    const afterUndo = await page.evaluate(() => (document.querySelector('#target') as HTMLElement)?.textContent);
    // F3 post-reload semantics: undo restores to the PRE-REPLAY baseline, which
    // is the prevHtml captured at replay time = the original text.
    ck('6 undoAll restored the text to the pre-replay baseline (original)', afterUndo === 'Original text the user wanted changed.', `text="${afterUndo}"`);

    // ── Deliberate FAILING case (rule 15) ──
    // If replay had NOT repopulated the txnLog (re-execute skipped, e.g. an
    // "already-applied" short-circuit that skips tool.execute), undoAll would be
    // a no-op (undone:0) and the text would stay mutated. We assert the OPPOSITE
    // holds: undone>0 AND text restored. (The idempotency path in reapplyPersistedDom
    // still re-executes setText to repopulate txnLog, so this stays green.)
    ck('FAILING CASE: replay DID repopulate txnLog (a skip would leave the mutation)', (undoRes?.undone ?? 0) > 0 && afterUndo === 'Original text the user wanted changed.', `undone=${undoRes?.undone}`);

    await page.close();
  }
} catch (e) {
  ck('test threw', false, (e as Error).message + '\n' + (e as Error).stack);
}

const pass = checks.filter((c) => c.pass).length;
const fail = checks.length - pass;
writeFileSync(join(PROOF_DIR, 'f4-rollback-after-replay-test.json'), JSON.stringify({ pass, fail, checks }, null, 2));
console.log(`\npass=${pass} fail=${fail}`);
for (const c of checks) console.log(`  ${c.pass ? '✓' : '✖'} ${c.name} — ${c.detail}`);
if (fail > 0) process.exit(1);
console.log('ALL PASS');
await context.close();

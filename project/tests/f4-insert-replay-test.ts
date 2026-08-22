/**
 * tests/f4-insert-replay-test.ts — Phase 5 F4 CONTINUITY (insert replay).
 *
 * Added after the adversarial review found that the insert identityDigest was
 * captured AFTER the insert — for an INSIDE insert (where:'top'/'bottom') the
 * inserted node becomes a CHILD of the anchor, changing its childCount (part of
 * the fingerprint), so the persisted digest never matched the pre-insert anchor
 * on reload → the insert was silently lost (identity-mismatch) on every reload.
 * Fixed by capturing the anchor digest BEFORE the insert (same timing rule as
 * setText). This test proves the fix and pins the regression.
 *
 * Proves:
 *   1. An inside insert (where:'top') is persisted with a real anchor digest.
 *   2. Reload → replay re-applies the insert (the inserted node reappears).
 *   3. The inserted node appears exactly ONCE (no duplication) on reload.
 *   4. An outside insert (where:'before') also replays (the anchor is unchanged
 *      by a sibling insert, so this case always worked — covered for parity).
 *
 * Rule 15 FAILING CASE: if the digest were captured AFTER the insert again,
 *   step 2 would report identity-mismatch and the insert would NOT reappear →
 *   fails. (This is the exact bug the review found; the test pins it.)
 *
 * No model/creds. Built extension + Playwright.
 * Run: node --experimental-strip-types tests/f4-insert-replay-test.ts
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createContext, sendToolCall, getExtensionId } from './foundation-helpers.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROOF_DIR = join(__dirname, '..', 'proof');
mkdirSync(PROOF_DIR, { recursive: true });

interface Check { name: string; pass: boolean; detail: string }
const checks: Check[] = [];
function ck(n: string, pass: boolean, d: string) { checks.push({ name: n, pass, detail: d }); }

const FIXTURE = `<!doctype html><html><head><meta charset=utf-8><style>body{margin:0;font:14px/1.4 sans-serif}#main{padding:12px}#anchor{border:1px solid #ccc;padding:8px}</style></head><body><main id="main"><h1>Insert Replay</h1><div id="anchor">Original anchor content.</div></main></body></html>`;

const context = await createContext('f4-insert-replay');

/** Persist a single insert act entry under the scope key with the real digest
 *  captured by running the insert. Mirrors what the loop persists. */
async function persistInsertEntry(page: any, where: 'top' | 'before', html: string, goal: string): Promise<any> {
  const res = await sendToolCall(context, page, 'insert', { selector: '#anchor', html, where });
  const u = new URL(page.url());
  const extensionId = await getExtensionId(context);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.bringToFront();
  await popup.evaluate(async ({ key, origin, path, goal, where, html, identityDigest, prevHtml }: any) => {
    const state = {
      enabled: true, origin, path, goal,
      entries: [{
        tool: 'insert', kind: 'act' as const,
        args: { selector: '#anchor', html, where },
        result: { selector: '#anchor', where, applied: true, matched: 1, unverified: false },
        identityDigest,
        inverse: { kind: 'restoreHtml', selector: '#anchor', prevHtml, isInside: where === 'top' || where === 'bottom' },
        costMs: 0, timestamp: Date.now(),
      }],
      createdAt: Date.now(),
    };
    await chrome.storage.local.set({ [key]: state });
  }, { key: 'rv_' + u.origin + u.pathname, origin: u.origin, path: u.pathname, goal, where, html, identityDigest: res?.identityDigest, prevHtml: where === 'top' ? 'Original anchor content.' : '' });
  await popup.close();
  return res;
}

function countInserted(page: any): Promise<number> {
  return page.evaluate(() => document.querySelectorAll('[data-revueon-inserted="true"]').length);
}

try {
  // ── INSIDE insert (where:'top') — the bug case ──
  {
    const page = await context.newPage();
    await page.route('https://f4.test/inside', (route) => route.fulfill({ contentType: 'text/html', body: FIXTURE }));
    await page.goto('https://f4.test/inside', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);
    await sendToolCall(context, page, 'describePage', {});

    const res = await persistInsertEntry(page, 'top', '<p>Inserted summary inside the anchor.</p>', 'f4-insert-inside');
    ck('1 inside insert succeeded + captured a real anchor digest', !!res?.ok && !!res?.identityDigest, `ok=${res?.ok} digest=${res?.identityDigest?.slice(0, 8)}`);
    ck('2 inside insert present once before reload', await countInserted(page) === 1, `count=${await countInserted(page)}`);

    // Remove the in-session insert so the page is back to baseline, then reload.
    // (reapplyPersistedDom removes [data-revueon-inserted] on load, then replays.)
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(900);

    const afterReload = await countInserted(page);
    ck('3 inside insert REPLAYED after reload (inserted node reappeared)', afterReload === 1, `count=${afterReload}`);
    const insideStillInAnchor = await page.evaluate(() => {
      const a = document.querySelector('#anchor');
      const ins = a?.querySelector('[data-revueon-inserted="true"]');
      return !!ins && a?.contains(ins);
    });
    ck('4 the replayed inside insert is a CHILD of #anchor (positioned top)', insideStillInAnchor, `inside=${insideStillInAnchor}`);

    // FAILING CASE: the bug (digest after insert) would make step3 fail (count=0
    // because identity-mismatch refused the replay). We assert count===1.
    ck('FAILING CASE: exactly one inserted node (the post-insert-digest bug left zero)', afterReload === 1, `count=${afterReload}`);
    await page.close();
  }

  // ── OUTSIDE insert (where:'before') — parity (always worked) ──
  {
    const page = await context.newPage();
    await page.route('https://f4.test/outside', (route) => route.fulfill({ contentType: 'text/html', body: FIXTURE }));
    await page.goto('https://f4.test/outside', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);
    await sendToolCall(context, page, 'describePage', {});
    const res = await persistInsertEntry(page, 'before', '<p>Inserted before the anchor.</p>', 'f4-insert-outside');
    ck('5 outside insert succeeded + captured a real anchor digest', !!res?.ok && !!res?.identityDigest, `ok=${res?.ok}`);
    ck('6 outside insert present once before reload', await countInserted(page) === 1, `count=${await countInserted(page)}`);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(900);
    ck('7 outside insert REPLAYED after reload', await countInserted(page) === 1, `count=${await countInserted(page)}`);
    await page.close();
  }
} catch (e) {
  ck('test threw', false, (e as Error).message + '\n' + (e as Error).stack);
}

const pass = checks.filter((c) => c.pass).length;
const fail = checks.length - pass;
writeFileSync(join(PROOF_DIR, 'f4-insert-replay-test.json'), JSON.stringify({ pass, fail, checks }, null, 2));
console.log(`\npass=${pass} fail=${fail}`);
for (const c of checks) console.log(`  ${c.pass ? '✓' : '✖'} ${c.name} — ${c.detail}`);
if (fail > 0) process.exit(1);
console.log('ALL PASS');
await context.close();

/**
 * tests/consent-gate-test.ts — Phase 6 Task6: the consent gate blocks a run
 * when consent is not acknowledged, and the check lives in the background's
 * runLoop handler (the single entry point) so a direct runtime.sendMessage
 * cannot bypass it. Consent granted → the run proceeds past the consent check.
 *
 * Proves:
 *   1. No consent + direct runLoop message → consent error, no agent run.
 *      (This is the bypass the UI-only gate would have allowed.)
 *   2. Consent granted → runLoop proceeds PAST the consent check (it then fails
 *      on missing credentials, which proves consent was satisfied — a credential
 *      error means we got past consent).
 *   3. Consent persists in chrome.storage.local across a popup reopen.
 *
 * No model call, no credentials needed. Built extension only.
 * Run: node --experimental-strip-types tests/consent-gate-test.ts
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createContext, getExtensionId } from './foundation-helpers.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROOF_DIR = join(__dirname, '..', 'proof');
mkdirSync(PROOF_DIR, { recursive: true });

interface Check { name: string; pass: boolean; detail: string }
const checks: Check[] = [];
function ck(n: string, pass: boolean, d: string) { checks.push({ name: n, pass, detail: d }); }

const ctx = await createContext('consent-gate');
try {
  const extensionId = await getExtensionId(ctx);
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);

  // A page on http so the content script (and thus a tab) exists; runLoop needs a tabId.
  const page = await ctx.newPage();
  await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);

  // Ensure NO consent + NO creds at start (clean slate).
  await popup.evaluate(async () => {
    await chrome.storage.local.remove(['revueonConsentShown', 'cloudflare_account_id', 'cloudflare_api_token']);
  });

  // ── 1. No consent → runLoop refuses BEFORE any agent run (the bypass attempt) ──
  // Send a DIRECT runtime.sendMessage({action:'runLoop'}) — exactly what a
  // non-popup caller would do. The background must block it.
  const noConsent = await popup.evaluate(async ({ tabId }: { tabId: number }) => {
    return new Promise<any>((resolve) => {
      const t = setTimeout(() => resolve({ ok: false, error: 'runLoop timed out' }), 15_000);
      chrome.runtime.sendMessage({ action: 'runLoop', goal: 'hide the sidebar', tabId }, (res: any) => {
        clearTimeout(t); resolve(res);
      });
    });
  }, { tabId: (await popup.evaluate(async (url: string) => {
    const tabs = await chrome.tabs.query({}); return tabs.find((t) => t.url === url)?.id;
  }, page.url())) });

  const blocked = !noConsent?.ok && /consent/i.test(noConsent?.error ?? '');
  ck('no consent + direct runLoop message → consent error, no agent run (bypass blocked)',
    blocked, `ok=${noConsent?.ok} error="${noConsent?.error ?? ''}"`);

  // ── 2. Consent granted → runLoop proceeds PAST the consent check ──
  // With consent set but NO credentials, the handler passes consent and hits the
  // credential check. A credential error (not a consent error) proves consent
  // was satisfied.
  await popup.evaluate(async () => {
    await chrome.storage.local.set({ revueonConsentShown: true });
  });
  const withConsent = await popup.evaluate(async ({ tabId }: { tabId: number }) => {
    return new Promise<any>((resolve) => {
      const t = setTimeout(() => resolve({ ok: false, error: 'runLoop timed out' }), 15_000);
      chrome.runtime.sendMessage({ action: 'runLoop', goal: 'hide the sidebar', tabId }, (res: any) => {
        clearTimeout(t); resolve(res);
      });
    });
  }, { tabId: (await popup.evaluate(async (url: string) => {
    const tabs = await chrome.tabs.query({}); return tabs.find((t) => t.url === url)?.id;
  }, page.url())) });

  const passedConsent = /credential/i.test(withConsent?.error ?? '') && !/consent/i.test(withConsent?.error ?? '');
  ck('consent granted → runLoop proceeds past consent (fails on credentials, not consent)',
    passedConsent, `ok=${withConsent?.ok} error="${withConsent?.error ?? ''}"`);

  // ── 3. Consent persists in storage across a popup reopen ──
  await popup.close();
  const popup2 = await ctx.newPage();
  await popup2.goto(`chrome-extension://${extensionId}/popup.html`);
  const persisted = await popup2.evaluate(async () => {
    const r = await chrome.storage.local.get(['revueonConsentShown']);
    return r.revueonConsentShown === true;
  });
  ck('consent persists in chrome.storage.local across a popup reopen',
    persisted, `revueonConsentShown after reopen=${persisted}`);
  await popup2.close();
  await page.close();
} finally {
  await ctx.close();
}

let failures = 0;
console.log('\nPhase 6 Task6 — consent gate regression\n');
for (const c of checks) {
  console.log(`  ${c.pass ? '✓' : '✖'} ${c.name}`);
  if (!c.pass) { console.log(`      ${c.detail}`); failures++; }
}
const pass = failures === 0;
writeFileSync(join(PROOF_DIR, 'consent-gate-test.json'), JSON.stringify({ checks, pass }, null, 2));
console.log(`\n${pass ? 'All consent-gate checks passed.\n' : `${failures} check(s) FAILED\n`}`);
process.exit(pass ? 0 : 1);

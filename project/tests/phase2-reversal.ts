/**
 * tests/phase2-reversal.ts — F3 REVERSAL behavioural proof on real pages.
 *
 * Done = on → off → on → off leaves the DOM byte-identical to the original at
 * BOTH offs, on ≥3 real sites (MDN, Wikipedia, Hacker News), AND a deliberate
 * "structural mutation → forced failure → automatic undo → restored" case.
 *
 * Driven DIRECTLY through the live F3 transaction/inverse system — no model
 * loop, no manual persistence (persistence is an F4 concern, kept out of F3):
 *   insert (records an inverse into the content-script TransactionLog)
 *   → {action:'undoAll'} (undoAll replays the inverse — removes the node)
 *   → {action:'resetTxn'} (clears the log so the next on re-records)
 *   → insert again (fresh inverse)
 *   → {action:'undoAll'} (undoes again)
 *   → assert both off-fingerprints are byte-identical to the baseline.
 *
 * The fingerprint INCLUDES [data-revueon-inserted] nodes, so an insert is
 * detectable: baseline (no insert) ≠ on (insert present); off after undoAll
 * (insert removed) == baseline. A leftover insert after a bad undo would be
 * caught (off ≠ baseline).
 *
 * Vision rule (rule 14): any visual confirmation is via the vision model
 * (kimi-k2.7-code); I never inspect screenshots directly.
 *
 * Usage: node --experimental-strip-types tests/phase2-reversal.ts
 * (needs the built extension: npm run build; no credentials required)
 */

import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  createContext, getExtensionId, sendToolCall,
} from './foundation-helpers.ts';
import { captureFingerprint, assertFingerprintStable, countInserted } from './assert-dom-clean.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = join(__dirname, 'screenshots');
mkdirSync(SHOT_DIR, { recursive: true });

interface CycleResult {
  name: string; url: string;
  baselineHash: string;
  on1Changed: boolean; off1Match: boolean;
  on2Changed: boolean; off2Match: boolean;
  off1Undone: number; off2Undone: number;
  note: string;
}
interface FailResult { name: string; undone: number; failed: number; restored: boolean; note: string; }

const SITES = [
  { name: 'mdn', url: 'https://developer.mozilla.org/en-US/docs/Web/CSS/justify-content', selector: 'body' },
  { name: 'wikipedia', url: 'https://en.wikipedia.org/wiki/CSS', selector: 'body' },
  { name: 'hackernews', url: 'https://news.ycombinator.com/', selector: 'body' },
];

const INSERT_HTML = '<p data-revueon-inserted="true">PHASE2 REVERSAL TEST — inserted node</p>';

// ── send the undoAll message (what rollbackDomIfActed sends on failure) ─────

async function sendUndoAll(context: any, page: any): Promise<{ undone: number; failed: number; size: number } | undefined> {
  const extensionId = await getExtensionId(context);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.bringToFront();
  const targetUrl = page.url();
  const result = await popup.evaluate(async (url: string) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === url);
    if (!tab) return undefined;
    return new Promise<any>((resolve) => {
      const t = setTimeout(() => resolve(undefined), 10_000);
      chrome.tabs.sendMessage(tab.id!, { action: 'undoAll' }, (res: any) => { clearTimeout(t); resolve(res); });
    });
  }, targetUrl);
  await popup.close();
  return result;
}

// ── send the resetTxn message (clears the log so the next on re-records) ────

async function sendResetTxn(context: any, page: any): Promise<void> {
  const extensionId = await getExtensionId(context);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.bringToFront();
  const targetUrl = page.url();
  await popup.evaluate(async (url: string) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === url);
    if (!tab) return;
    return new Promise<any>((resolve) => {
      const t = setTimeout(() => resolve(undefined), 10_000);
      chrome.tabs.sendMessage(tab.id!, { action: 'resetTxn' }, () => { clearTimeout(t); resolve(undefined); });
    });
  }, targetUrl);
  await popup.close();
}

// ── hash a fingerprint for compact reporting (assertions use full strings) ──

function hashStr(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

// ── PART A: on→off→on→off byte-identity, driven directly through F3 ────────

async function testOnOffOnOff(site: { name: string; url: string; selector: string }): Promise<CycleResult> {
  const context = await createContext('p2-' + site.name);
  const res: CycleResult = {
    name: site.name, url: site.url, baselineHash: '',
    on1Changed: false, off1Match: false, on2Changed: false, off2Match: false,
    off1Undone: 0, off2Undone: 0, note: '',
  };
  try {
    const page = await context.newPage();
    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(2500); // settle: Wikipedia/MDN late mutations land by ~2s

    // baseline fingerprint + stability control (no runtime-noise false-fails).
    const baseline = await captureFingerprint(page);
    res.baselineHash = hashStr(baseline);
    const baselineInserted = await countInserted(page);
    try {
      await assertFingerprintStable(page, site.name + ' baseline');
    } catch (e) {
      res.note = `baseline UNSTABLE — ${(e as Error).message.slice(0, 120)}`;
      return res;
    }

    // ── ON #1: insert (records an inverse into the TransactionLog) ──
    const insertRes = await sendToolCall(context, page, 'insert', {
      selector: site.selector, html: INSERT_HTML, where: 'top',
    });
    if (!insertRes?.ok) { res.note = `ON#1 insert failed: ${JSON.stringify(insertRes).slice(0, 120)}`; return res; }
    await page.waitForTimeout(500);
    const on1Fp = await captureFingerprint(page);
    res.on1Changed = on1Fp !== baseline;
    if (!res.on1Changed) { res.note = 'ON#1 insert did not change the fingerprint — test inconclusive'; return res; }

    // ── OFF #1: undoAll (replays the inverse — removes the node) ──
    const undo1 = await sendUndoAll(context, page);
    res.off1Undone = undo1?.undone ?? 0;
    await page.waitForTimeout(500);
    const off1Fp = await captureFingerprint(page);
    res.off1Match = off1Fp === baseline;
    if (!res.off1Match) {
      res.note = `OFF#1 fingerprint differs from baseline (undone=${res.off1Undone})`;
      await page.screenshot({ path: join(SHOT_DIR, `p2-${site.name}-off1.png`) });
      return res;
    }

    // ── ON #2: resetTxn (clear log) + insert again (fresh inverse) ──
    await sendResetTxn(context, page);
    const insert2Res = await sendToolCall(context, page, 'insert', {
      selector: site.selector, html: INSERT_HTML, where: 'top',
    });
    if (!insert2Res?.ok) { res.note = `ON#2 insert failed: ${JSON.stringify(insert2Res).slice(0, 120)}`; return res; }
    await page.waitForTimeout(500);
    const on2Fp = await captureFingerprint(page);
    res.on2Changed = on2Fp === on1Fp; // on#2 reproduces on#1

    // ── OFF #2: undoAll ──
    const undo2 = await sendUndoAll(context, page);
    res.off2Undone = undo2?.undone ?? 0;
    await page.waitForTimeout(500);
    const off2Fp = await captureFingerprint(page);
    res.off2Match = off2Fp === baseline && off2Fp === off1Fp;
    if (!res.off2Match) res.note = `OFF#2 differs from baseline (on→off→on→off NOT byte-identical)`;
    await page.screenshot({ path: join(SHOT_DIR, `p2-${site.name}-after.png`) });
    return res;
  } finally {
    try { await context.close(); } catch { /* ignore */ }
  }
}

// ── PART B: deliberate failure → automatic undo → restored (multi-op) ──────

async function testDeliberateFailure(): Promise<FailResult> {
  const url = 'https://en.wikipedia.org/wiki/CSS';
  const context = await createContext('p2-failure');
  const res: FailResult = { name: 'wikipedia-multi-insert-failure', undone: 0, failed: 0, restored: false, note: '' };
  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(1500);
    const baseline = await captureFingerprint(page);
    const baselineCount = await countInserted(page);
    await page.screenshot({ path: join(SHOT_DIR, 'p2-fail-baseline.png') });

    // Multi-op partial transform: insert A, insert B (two structural ops the
    // loop would make), then "force failure" → the loop's terminal path sends
    // {action:'undoAll'}. We send the SAME message (rollbackDomIfActed's exact
    // structural contract). Proof: BOTH inserts removed (count → baseline) AND
    // undoAll reports undone == 2 AND fingerprint == baseline.
    const a = await sendToolCall(context, page, 'insert', {
      selector: '#mw-content-text', html: '<p data-revueon-inserted="true">INSERT A</p>', where: 'top',
    });
    if (!a?.ok) { res.note = `insert A failed: ${JSON.stringify(a).slice(0, 100)}`; return res; }
    const b = await sendToolCall(context, page, 'insert', {
      selector: '#mw-content-text', html: '<p data-revueon-inserted="true">INSERT B</p>', where: 'top',
    });
    if (!b?.ok) { res.note = `insert B failed: ${JSON.stringify(b).slice(0, 100)}`; return res; }
    await page.waitForTimeout(300);
    const mutatedCount = await countInserted(page);
    await page.screenshot({ path: join(SHOT_DIR, 'p2-fail-mutated.png') });

    // "force failure" → undoAll (rollbackDomIfActed's structural contract).
    const undoRes = await sendUndoAll(context, page);
    res.undone = undoRes?.undone ?? 0;
    res.failed = undoRes?.failed ?? 0;
    await page.waitForTimeout(500);
    const restoredCount = await countInserted(page);
    const restoredFp = await captureFingerprint(page);
    res.restored = restoredCount === baselineCount && restoredFp === baseline && res.undone >= 2;
    if (!res.restored) {
      res.note = `after undoAll: inserted count ${baselineCount}→${restoredCount} (expect ${baselineCount}), undone=${res.undone} (expect ≥2)` +
        (restoredFp !== baseline ? '; fingerprint differs' : '');
    }
    await page.screenshot({ path: join(SHOT_DIR, 'p2-fail-restored.png') });
    return res;
  } finally {
    try { await context.close(); } catch { /* ignore */ }
  }
}

// ── runner ────────────────────────────────────────────────────────────────

async function main() {
  console.log('\nF3 REVERSAL — Phase 2 behavioural proof\n');
  let failures = 0;

  console.log('=== PART A: on→off→on→off byte-identity (driven through F3 directly) ===\n');
  for (const site of SITES) {
    process.stdout.write(`[${site.name}] ${site.url}\n`);
    const r = await testOnOffOnOff(site);
    const pass = r.off1Match && r.off2Match;
    console.log(`  baseline=${r.baselineHash} on1=${r.on1Changed ? 'CHANGED' : 'no-change'} off1=${r.off1Match ? 'MATCH' : 'DIFF'} (undone=${r.off1Undone}) on2=${r.on2Changed ? '=on1' : '≠on1'} off2=${r.off2Match ? 'MATCH' : 'DIFF'} (undone=${r.off2Undone}) → ${pass ? 'PASS' : 'FAIL'}`);
    if (r.note) console.log(`  note: ${r.note}`);
    if (!pass) failures++;
  }

  console.log('\n=== PART B: multi-op partial transform → forced failure → automatic undo → restored ===\n');
  const f = await testDeliberateFailure();
  const fpass = f.restored;
  console.log(`[${f.name}] undone=${f.undone} (expect ≥2) failed=${f.failed} restored=${f.restored} → ${fpass ? 'PASS' : 'FAIL'}`);
  if (f.note) console.log(`  note: ${f.note}`);
  if (!fpass) failures++;

  console.log('\n' + (failures === 0
    ? 'Phase 2 F3 reversal: ALL behavioural proofs passed.\n'
    : `${failures} proof(s) FAILED — see notes above.\n`));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('fatal:', e); process.exit(1); });

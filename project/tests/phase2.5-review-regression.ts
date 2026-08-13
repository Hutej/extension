/**
 * tests/phase2.5-review-regression.ts — Phase 2.5 TASK5: three targeted
 * regression tests for holes found in the Phase-2 review. Does NOT reopen
 * Phase 2; only pins specific concerns on the REAL sites + REAL transaction
 * system (sendToolCall → content-script act tools → TransactionLog).
 *
 *   A. Real-site setText on MDN / Wikipedia / Hacker News: on→off→on→off,
 *      verify the original DOM structure returns (fingerprint == baseline).
 *   B. Real CSS cycle on the USER-origin path: applyCss → off → applyCss → off,
 *      verify the computed value returns to baseline at BOTH offs. Tests
 *      whether CSS serialization differences can make removeCSS silently fail.
 *   C. on → on → off: reset() runs on each "on". Determine whether the second
 *      transformation can accidentally make the first permanent. If it does,
 *      that's a real F3 bug → report it (do not paper over it here).
 *
 * Driven directly through the live transaction system — no model loop. The
 * toggle off/on is the content-script toggle path (undoAllStructural /
 * resetTxn + removeCSS/insertCSS), same as phase2-reversal.ts.
 *
 * Usage: node --experimental-strip-types tests/phase2.5-review-regression.ts
 * (needs the built extension: npm run build; no credentials required)
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createContext, getExtensionId, sendToolCall, sendToggle, persistJournalEntry } from './foundation-helpers.ts';
import { captureFingerprint, assertFingerprintStable, countInserted } from './assert-dom-clean.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROOF_DIR = join(__dirname, '..', 'proof');
mkdirSync(PROOF_DIR, { recursive: true });

interface Check { name: string; pass: boolean; detail: string }
const checks: Check[] = [];

const SITES = [
  { name: 'mdn', url: 'https://developer.mozilla.org/en-US/docs/Web/CSS/justify-content' },
  { name: 'wikipedia', url: 'https://en.wikipedia.org/wiki/CSS' },
  { name: 'hackernews', url: 'https://news.ycombinator.com/' },
];

// ── A. Real-site setText: on→off→on→off, DOM structure returns ──────────
// setText requires a text-only element (no element children). Find one on
// each page: MDN/HN have text-only <p>/<span>; Wikipedia headings are text-only.
async function testA_setText(): Promise<void> {
  for (const site of SITES) {
    const name = `A:setText ${site.name}`;
    try {
      const context = await createContext(`p25-settext-${site.name}`);
      const page = await context.newPage();
      await page.goto(site.url, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);

      // Find a text-only element: a short <p> with no element children.
      const target = await page.evaluate(() => {
        const ps = Array.from(document.querySelectorAll('p, span, h1, h2, h3, h4'));
        for (const el of ps) {
          if (el.children.length === 0 && el.textContent && el.textContent.trim().length > 3 && el.textContent.trim().length < 200) {
            // Give it a stable selector handle. Prefix with 'rva' so the id is a
            // valid CSS identifier (a leading digit would be invalid after '#').
            if (!el.id) el.id = `rva${Math.random().toString(36).slice(2, 8)}`;
            return { selector: `#${el.id}`, originalText: el.textContent.trim() };
          }
        }
        return null;
      });
      if (!target) {
        checks.push({ name, pass: false, detail: 'no text-only element found on page' });
        await context.close();
        continue;
      }

      // assertFingerprintStable throws if the page isn't stable without action
      // (runtime noise); captureFingerprint gives the baseline. HN/MDN can be
      // noisy — tolerate by retrying the stability check once.
      let baseline = '';
      try {
        await assertFingerprintStable(page, `${name}-baseline`, 1500);
        baseline = await captureFingerprint(page);
      } catch (err) {
        // Retry once after a longer settle; if still unstable, skip this site.
        await page.waitForTimeout(1500);
        try {
          await assertFingerprintStable(page, `${name}-baseline-retry`, 1500);
          baseline = await captureFingerprint(page);
        } catch {
          checks.push({ name, pass: false, detail: `baseline not stable (runtime noise): ${(err as Error).message.slice(0, 80)}` });
          await context.close();
          continue;
        }
      }
      const baselineInserted = await countInserted(page);

      // on: setText
      const on1 = await sendToolCall(context, page, 'setText', {
        selector: target.selector, text: 'REVUEON TEST TEXT', reason: 'summarise',
      });
      const on1Applied = on1?.result?.applied ?? on1?.ok;

      // off: toggle off (undoAllStructural + removeCSS). 2.5s settle per
      // PHASE2_REPORT.md — Wikipedia/MDN late mutations land by ~2s; a short
      // wait reads mid-churn as a false fingerprint diff (not an F3 bug).
      await sendToggle(context, page);
      await page.waitForTimeout(2500);
      const off1Fp = await captureFingerprint(page);
      const off1Inserted = await countInserted(page);

      // on again: setText (resetTxn runs on toggle-on, fresh inverse)
      // Re-assert baseline stability first (page should match baseline after off).
      await sendToggle(context, page); // back on
      await page.waitForTimeout(2500);
      const on2 = await sendToolCall(context, page, 'setText', {
        selector: target.selector, text: 'REVUEON TEST TEXT 2', reason: 'summarise',
      });
      const on2Applied = on2?.result?.applied ?? on2?.ok;

      // off again
      await sendToggle(context, page);
      await page.waitForTimeout(2500);
      const off2Fp = await captureFingerprint(page);
      const off2Inserted = await countInserted(page);

      // A fingerprint diff with inserted==baseline is runtime noise, not a leak;
      // the load-bearing F3 guarantee is inserted==baseline (no node leak) AND
      // fingerprint match. Report both honestly.
      const off1Match = off1Fp === baseline && off1Inserted === baselineInserted;
      const off2Match = off2Fp === baseline && off2Inserted === baselineInserted;

      checks.push({
        name,
        pass: !!on1Applied && off1Match && !!on2Applied && off2Match,
        detail: `target=${target.selector} on1.applied=${on1Applied} off1=${off1Match ? 'MATCH' : 'DIFF'} on2.applied=${on2Applied} off2=${off2Match ? 'MATCH' : 'DIFF'}`,
      });
      await context.close();
    } catch (err) {
      checks.push({ name, pass: false, detail: `error: ${(err as Error).message}` });
    }
  }
}

// ── B. Real CSS cycle: applyCss → off → applyCss → off, computed returns ──
// Tests whether CSS serialization differences cause removeCSS to silently
// fail (the value stays changed after off instead of returning to baseline).
// CRITICAL: the loop persists the EXACT emitter-serialized css as the
// inverse, so removeCSS matches what insertCSS applied. sendToolCall (a direct
// act) does NOT persist, so we persist the returned result.css (the exact
// inserted string) before toggling — mirroring what the loop does on `done`.
async function testB_cssCycle(): Promise<void> {
  for (const site of SITES) {
    const name = `B:cssCycle ${site.name}`;
    try {
      const context = await createContext(`p25-csscycle-${site.name}`);
      const page = await context.newPage();
      await page.goto(site.url, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);

      // Target a text element; apply a CSS rule that changes its color.
      const target = await page.evaluate(() => {
        const el = document.querySelector('h1, h2, p, .athing, .titleline') as HTMLElement | null;
        if (!el) return null;
        // Always assign a fresh valid id (HN story ids are numeric → '#<digits>'
        // is an invalid CSS selector). Overwrite any existing numeric id.
        el.id = `rvb${Math.random().toString(36).slice(2, 8)}`;
        return { selector: `#${el.id}` };
      });
      if (!target) { checks.push({ name, pass: false, detail: 'no target element' }); await context.close(); continue; }

      const readColor = () => page.evaluate((sel: string) => getComputedStyle(document.querySelector(sel)!).color, target.selector);

      const baselineColor = await readColor();
      // color + background shorthand to stress serialization (shorthand expands
      // in CSSOM; removeCSS must match the EXACT emitted string).
      const css = `${target.selector} { color: rgb(255, 0, 0) !important; background: rgb(0, 255, 0) !important; }`;

      // on1: applyCss returns result.css = the EMITTER-SERIALIZED inserted string.
      const on1 = await sendToolCall(context, page, 'applyCss', { css });
      const insertedCss1: string = on1?.result?.css ?? css;
      await page.waitForTimeout(400);
      const on1Color = await readColor();

      // Persist the EXACT inserted css so toggle-off (which reads storage) can
      // remove it — this is what the loop does on `done`. (sendToolCall bypasses
      // the loop, so without this the journal is empty and removeCSS no-ops.)
      await persistJournalEntry(context, page, insertedCss1, 'p25-csscycle');

      // off1: toggle off — removeCSS with the persisted (exact) string.
      await sendToggle(context, page);
      await page.waitForTimeout(600);
      const off1Color = await readColor();

      // on2: re-apply (toggle on re-inserts from the persisted journal).
      await sendToggle(context, page);
      await page.waitForTimeout(600);
      const on2Color = await readColor();

      // off2
      await sendToggle(context, page);
      await page.waitForTimeout(600);
      const off2Color = await readColor();

      // The computed color must: change on (red), return to baseline at BOTH offs.
      const changedOn1 = on1Color !== baselineColor;
      const off1Returned = off1Color === baselineColor;
      const changedOn2 = on2Color !== baselineColor;
      const off2Returned = off2Color === baselineColor;
      const removeCssSilentFail = !off1Returned || !off2Returned;

      checks.push({
        name,
        pass: changedOn1 && off1Returned && changedOn2 && off2Returned && !removeCssSilentFail,
        detail: `baseline=${baselineColor} on1=${on1Color}${changedOn1 ? '(changed)' : '(unchanged!)'} off1=${off1Color}${off1Returned ? '(==base ✓)' : '(STAYED CHANGED — removeCSS silent fail!)'} on2=${on2Color} off2=${off2Color}${off2Returned ? '(==base ✓)' : '(STAYED!)'} on1.ok=${on1?.ok}`,
      });
      await context.close();
    } catch (err) {
      checks.push({ name, pass: false, detail: `error: ${(err as Error).message}` });
    }
  }
}

// ── C. on → on → off: reset() on each on — does on2 make on1 permanent? ──
// reset() clears the TransactionLog on each toggle-on. If on1 inserts X, on2
// inserts Y (reset clears the log, so X's inverse is gone), then off (undoAll)
// only undoes Y → X remains → permanent mutation. This is the F3 hole.
async function testC_onOnOff(): Promise<void> {
  for (const site of SITES) {
    const name = `C:onOnOff ${site.name}`;
    try {
      const context = await createContext(`p25-ononoff-${site.name}`);
      const page = await context.newPage();
      await page.goto(site.url, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);

      // Baseline stability (with retry for noisy pages).
      let baseline = '';
      try {
        await assertFingerprintStable(page, `${name}-baseline`, 1500);
        baseline = await captureFingerprint(page);
      } catch (err) {
        await page.waitForTimeout(1500);
        try {
          await assertFingerprintStable(page, `${name}-baseline-retry`, 1500);
          baseline = await captureFingerprint(page);
        } catch {
          checks.push({ name, pass: false, detail: `baseline not stable (runtime noise): ${(err as Error).message.slice(0, 80)}` });
          await context.close();
          continue;
        }
      }
      const baselineInserted = await countInserted(page);

      // Find two distinct insert anchors. Use a selector that already exists
      // WITHOUT injecting an id (an injected id would pollute the fingerprint
      // and look like a leak). body is always present and needs no id.
      const anchor = await page.evaluate(() => {
        const el = document.querySelector('main, #content, .mw-body, #main, body') as HTMLElement | null;
        if (!el) return null;
        // Only use an id if the element ALREADY has one; else fall back to the
        // tag selector (body/main are unique enough for insert).
        if (el.id) return { selector: `#${el.id}` };
        return { selector: el.tagName.toLowerCase() };
      });
      if (!anchor) { checks.push({ name, pass: false, detail: 'no anchor' }); await context.close(); continue; }

      // on1: insert A
      const on1 = await sendToolCall(context, page, 'insert', {
        selector: anchor.selector, html: '<div data-revueon-inserted="1" id="rv-c-a">A</div>', where: 'top',
      });
      const afterOn1 = await countInserted(page);

      // on2: insert B (resetTxn runs on toggle-on; per Phase-2 design reset clears the log)
      await sendToggle(context, page); // toggling on triggers resetTxn + reapplyPersistedDom
      await page.waitForTimeout(400);
      await sendToggle(context, page); // ensure on
      await page.waitForTimeout(400);
      const on2 = await sendToolCall(context, page, 'insert', {
        selector: anchor.selector, html: '<div data-revueon-inserted="1" id="rv-c-b">B</div>', where: 'top',
      });
      const afterOn2 = await countInserted(page);

      // off: undoAll — should remove everything inserted this session
      await sendToggle(context, page);
      await page.waitForTimeout(500);
      const offFp = await captureFingerprint(page);
      const offInserted = await countInserted(page);

      // PASS = off returns to baseline (no permanent mutation). FAIL = X or Y leaked.
      const offMatch = offFp === baseline && offInserted === baselineInserted;
      checks.push({
        name,
        pass: offMatch,
        detail: `afterOn1=${afterOn1} afterOn2=${afterOn2} off.inserted=${offInserted}${offInserted === baselineInserted ? '(==base)' : '(LEAKED!)'} offFp=${offMatch ? 'MATCH' : 'DIFF'} on1.ok=${on1?.ok} on2.ok=${on2?.ok}`,
      });
      await context.close();
    } catch (err) {
      checks.push({ name, pass: false, detail: `error: ${(err as Error).message}` });
    }
  }
}

async function main() {
  console.log('\nPhase 2.5 TASK5 — Phase-2 review regression (real sites, real transaction system)\n');
  await testA_setText();
  await testB_cssCycle();
  await testC_onOnOff();

  let failures = 0;
  console.log('');
  for (const c of checks) {
    console.log(`  ${c.pass ? '✓' : '✖'} ${c.name}`);
    if (!c.pass) { console.log(`      ${c.detail}`); failures++; }
  }
  const pass = failures === 0;
  writeFileSync(join(PROOF_DIR, 'phase2.5-review-regression.json'), JSON.stringify({ checks, pass }, null, 2));
  console.log(`\n${pass ? `All ${checks.length} review-regression checks passed.\n` : `${failures}/${checks.length} FAILED\n`}`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });

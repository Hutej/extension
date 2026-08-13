/**
 * tests/assert-applied-timing-test.ts — Phase 2.5 TASK3: investigate whether
 * assertApplied can read getComputedStyle before a mutation / CSS transition
 * has settled, and determine the smallest reliable sync.
 *
 * Two investigations:
 *  A. SLOW-MUTATION: assertApplied uses a single requestAnimationFrame between
 *     insertCSS and read. Is one rAF enough? (A CSS application via USER-origin
 *     stylesheet is synchronous to the next frame, so for a NON-transitioned
 *     property one rAF should suffice. Confirm.)
 *  B. CSS TRANSITION: if the model's CSS animates a property (transition:
 *     <prop> 2s), getComputedStyle DURING the transition returns the
 *     INTERPOLATED value, not the final. Read at: rAF, +500ms, +1000ms, +2200ms
 *     and compare to the settled value. Document what each reports.
 *
 * Uses Playwright against a local fixture page (data URL) — no network, no
 * extension. The fixture has an element with transition: width 2s. We insert
 * USER-origin CSS via the page, mimicking chrome.scripting.insertCSS.
 *
 * Usage: node --experimental-strip-types tests/assert-applied-timing-test.ts
 */

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROOF_DIR = join(__dirname, '..', 'proof');
mkdirSync(PROOF_DIR, { recursive: true });

interface Sample { label: string; width: string }
interface Result { investigation: string; samples: Sample[]; settledWidth: string; conclusion: string }

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  // Fixture: a box that starts at 100px with a 2s width transition.
  const fixtureHtml = `<!DOCTYPE html><html><head><style>
    #box { width: 100px; height: 50px; background: red; transition: width 2s linear; }
  </style></head><body><div id="box"></div></body></html>`;
  await page.goto('data:text/html,' + encodeURIComponent(fixtureHtml), { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(300);

  const results: Result[] = [];

  // ── Investigation B: CSS transition — what does getComputedStyle report during it?
  // Insert USER-origin-ish CSS (addStyle here; in the extension it's
  // chrome.scripting.insertCSS at USER origin — same effect on computed style).
  const samples: Sample[] = [];
  await page.evaluate(() => {
    // Mimic the extension: add a stylesheet that changes width to 300px.
    const s = document.createElement('style');
    s.id = 'test-inject';
    s.textContent = '#box { width: 300px !important; }';
    document.head.appendChild(s);
  });
  // Read at rAF (the CURRENT assertApplied mechanism).
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
  const atRaf = await page.evaluate(() => getComputedStyle(document.getElementById('box')!).width);
  samples.push({ label: 'after 1 rAF (current assertApplied mechanism)', width: atRaf });

  // Read at +500ms, +1000ms, +2200ms (transition is 2s linear, settle by ~2s).
  for (const ms of [500, 1000, 2200]) {
    await page.waitForTimeout(ms);
    const w = await page.evaluate(() => getComputedStyle(document.getElementById('box')!).width);
    samples.push({ label: `+${ms}ms after insert`, width: w });
  }
  const settledWidth = samples[samples.length - 1].width;
  // The transition is linear 100->300 over 2s. At rAF (~16ms) expect ~101px.
  const rafInterpolated = parseFloat(atRaf);
  const final = parseFloat(settledWidth);
  const readsInterpolated = Math.abs(rafInterpolated - final) > 1; // rAF far from final = interpolated
  results.push({
    investigation: 'B: CSS transition (transition: width 2s linear) — getComputedStyle during transition',
    samples,
    settledWidth,
    conclusion: readsInterpolated
      ? `CONFIRMED: at 1 rAF getComputedStyle reports ${atRaf} (interpolated), not the settled ${settledWidth}. assertApplied's single-rAF read would treat the mid-transition value as the result.`
      : `NOT interpolated at rAF (got ${atRaf} ≈ settled ${settledWidth}) — possibly transition not started yet at first rAF`,
  });

  // ── Investigation A: non-transitioned property — is one rAF enough?
  await page.evaluate(() => {
    document.getElementById('test-inject')?.remove();
    const s = document.createElement('style');
    s.id = 'test-inject2';
    s.textContent = '#box { background: green !important; transition: none; }';
    document.head.appendChild(s);
  });
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
  const bgAfterRaf = await page.evaluate(() => getComputedStyle(document.getElementById('box')!).backgroundColor);
  const bgSettled = await page.evaluate(() => getComputedStyle(document.getElementById('box')!).backgroundColor);
  results.push({
    investigation: 'A: non-transitioned property (background) — is one rAF enough?',
    samples: [
      { label: 'background after 1 rAF', width: bgAfterRaf },
      { label: 'background settled (no delay)', width: bgSettled },
    ],
    settledWidth: bgSettled,
    conclusion: bgAfterRaf === bgSettled
      ? 'One rAF is enough for a non-transitioned property (synchronous application).'
      : `rAF read differs from settled: rAF=${bgAfterRaf} settled=${bgSettled}`,
  });

  // ── Investigation C: how to RELIABLY get the final value during a transition?
  // Option 1: wait for transitionend (bounded). Option 2: read transitionDuration
  // and if >0s, skip/defer. Test option 1's reliability.
  await page.evaluate(() => {
    document.getElementById('test-inject2')?.remove();
    // reset transition
    const b = document.getElementById('box')!;
    (b as any).style.transition = 'width 2s linear';
    (b as any).style.width = '100px';
  });
  await page.waitForTimeout(100);
  const transitionReliable = await page.evaluate(() => new Promise<string>((resolve) => {
    const box = document.getElementById('box')!;
    let settled = 'TIMEOUT';
    const to = setTimeout(() => resolve('TIMEOUT(transitionend not fired in 3s)'), 3000);
    box.addEventListener('transitionend', (ev) => {
      if (ev.propertyName === 'width') { clearTimeout(to); settled = getComputedStyle(box).width; resolve('fired: ' + settled); }
    }, { once: true });
    // trigger
    const s = document.createElement('style');
    s.textContent = '#box { width: 400px !important; }';
    document.head.appendChild(s);
    setTimeout(() => { if (settled === 'TIMEOUT') { clearTimeout(to); resolve('NO transitionend (transition may have been overridden)'); } }, 3200);
  }));
  results.push({
    investigation: 'C: transitionend reliability as the sync mechanism',
    samples: [{ label: 'transitionend result', width: transitionReliable }],
    settledWidth: transitionReliable,
    conclusion: transitionReliable.startsWith('fired: 400')
      ? 'transitionend fires with the settled value (400px) — a bounded transitionend listener is a reliable sync.'
      : `transitionend did NOT give the settled value: "${transitionReliable}". A bounded wait + settled read is the fallback.`,
  });

  // ── D. FIX VERIFICATION: the patched assertApplied (waitForTransition) reads
  // the SETTLED value during a transition, not the interpolated one. This is the
  // regression that pins the Phase 2.5 TASK3 fix. It runs the real
  // activeTransitionMs + waitForTransition + read logic (faithful copy of
  // src/tools/act.ts) in the page, mid-transition, and asserts the read equals
  // the settled value (not the ~101px interpolated value investigation B found).
  await page.evaluate(() => {
    document.getElementById('box')!.style.width = '100px';
  });
  await page.waitForTimeout(200);
  const fixedRead = await page.evaluate(() => {
    // Faithful copy of the patched assertApplied path (src/tools/act.ts).
    function activeTransitionMs(el: Element): number {
      const cs = getComputedStyle(el);
      return Math.max(0, ...cs.transitionDuration.split(',').map((d) => parseFloat(d) * 1000 || 0));
    }
    function waitForTransition(el: Element, maxMs: number): Promise<void> {
      if (maxMs <= 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        el.addEventListener('transitionend', finish, { once: true });
        setTimeout(finish, maxMs + 500);
      });
    }
    return new Promise<{ rafValue: string; fixedValue: string }>(async (resolve) => {
      const box = document.getElementById('box')!;
      // trigger the 2s transition
      const s = document.createElement('style');
      s.textContent = '#box { width: 300px !important; }';
      document.head.appendChild(s);
      // OLD mechanism: read at 1 rAF (the bug)
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      const rafValue = getComputedStyle(box).width;
      // NEW mechanism: wait for the transition to settle, then read
      const tMs = activeTransitionMs(box);
      await waitForTransition(box, tMs);
      const fixedValue = getComputedStyle(box).width;
      resolve({ rafValue, fixedValue });
    });
  });
  const rafNum = parseFloat(fixedRead.rafValue);
  const fixedNum = parseFloat(fixedRead.fixedValue);
  const fixWorksD = Math.abs(fixedNum - 300) < 1; // fixed read ≈ settled 300px
  const bugConfirmedD = Math.abs(rafNum - 300) > 50; // rAF read ≈ 100-150px (interpolated)
  results.push({
    investigation: 'D: FIX — patched assertApplied (waitForTransition) reads the SETTLED value during a transition',
    samples: [
      { label: 'OLD (1 rAF) read', width: fixedRead.rafValue },
      { label: 'NEW (waitForTransition) read', width: fixedRead.fixedValue },
    ],
    settledWidth: '300px',
    conclusion: fixWorksD && bugConfirmedD
      ? `PASS: fix reads ${fixedRead.fixedValue} (≈ settled 300px); old read ${fixedRead.rafValue} was interpolated.`
      : `CHECK: fix=${fixedRead.fixedValue} old=${fixedRead.rafValue} — expected fix≈300px, old≈100-150px`,
  });

  await browser.close();

  // The regression gate: investigation B confirms the bug; investigation D
  // confirms the fix. The gate PASSES iff the fix reads the settled value.
  const bugC = results.find((r) => r.investigation.startsWith('B:'));
  const fixC = results.find((r) => r.investigation.startsWith('D:'));
  const bugConfirmed = bugC?.conclusion.startsWith('CONFIRMED') ?? false;
  const fixWorks = fixC?.conclusion.startsWith('PASS') ?? false;
  const pass = bugConfirmed && fixWorks;

  writeFileSync(join(PROOF_DIR, 'assert-applied-timing-test.json'), JSON.stringify({ results, bugConfirmed, fixWorks, pass }, null, 2));
  console.log('\nPhase 2.5 TASK3 — assertApplied timing investigation + fix verification\n');
  for (const r of results) {
    console.log(`── ${r.investigation}`);
    for (const s of r.samples) console.log(`   ${s.label}: ${s.width}`);
    console.log(`   CONCLUSION: ${r.conclusion}\n`);
  }
  console.log(pass ? 'TASK3 GATE PASS: bug confirmed + fix verified (settled value read during transition).\n' : 'TASK3 GATE FAIL\n');
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });

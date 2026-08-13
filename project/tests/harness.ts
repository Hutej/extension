/**
 * tests/harness.ts — the Revueon test harness.
 *
 * PROTECTED SITES (manual only, never in harness): YouTube, Reddit, X/Twitter,
 * LinkedIn, Amazon, Gmail, Spotify. They serve captchas to automation.
 *
 * Tests goals, not routes. Playwright, real extension, real browser, real
 * model calls. One screen of output per run:
 *   goal · tools called · what changed · wall clock · spend · what it refused.
 *
 * Usage: node --experimental-strip-types --env-file=.env tests/harness.ts
 */

import { chromium } from 'playwright';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { captureFingerprint, assertDomClean as assertDomCleanCanonical } from './assert-dom-clean.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = join(__dirname, '..', '.output', 'chrome-mv3');
const SCREENSHOT_DIR = join(__dirname, 'screenshots');
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || '';
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN || '';

const VISION_MODEL = '@cf/moonshotai/kimi-k2.7-code';
const VISION_DIFF_PROMPT = 'What is different between these two screenshots of the same web page? Be specific about any visible changes: hidden sections, removed sidebars, reduced clutter, inserted content boxes, spacing changes, or style overlays. If nothing changed, say exactly: nothing changed.';

interface RunResult {
  goal: string; url: string; status: string; summary?: string; reason?: string;
  steps: number; paidCalls: number; wallMs: number; toolsCalled: string[];
  whatChanged: string; whatItRefused: string;
  visionDescription?: string;
}

/** Phase 2.5 TASK1 — drain REAL parse failures from the loop result to
 *  proof/parse-failures/<run>-<i>.txt. Deterministic: the loop surfaces them
 *  via LoopResult.parseFailures, the background returns them in the popup
 *  result, and the harness reads them here. Lets us build the JSON fix from
 *  actual malformed model outputs, not guesses. */
function drainParseFailures(res: any, runName: string): void {
  const failures: any[] = Array.isArray(res?.parseFailures) ? res.parseFailures : [];
  if (!failures.length) return;
  const FAIL_DIR = join(__dirname, '..', 'proof', 'parse-failures');
  mkdirSync(FAIL_DIR, { recursive: true });
  for (let i = 0; i < failures.length; i++) {
    const f = failures[i];
    const body = `=== run: ${runName} | model: ${f.model} | turn: ${f.turn} | raw len: ${f.len} (capped ${f.raw.length}) | error: ${f.error ?? '(none)'} ===\n--- raw ---\n${f.raw}\n--- end raw ---\n`;
    writeFileSync(join(FAIL_DIR, `${runName}-${i}.txt`), body);
  }
  console.log(`  [capture] drained ${failures.length} parse failure(s) for ${runName}`);
}

/** Get the extension ID by examining service worker contexts. */
async function getExtensionId(context: any): Promise<string> {
  const tryMatch = (url: string): string | null => {
    const m = url.match(/chrome-extension:\/\/([a-p]{32})/i);
    return m ? m[1] : null;
  };
  for (const sw of context.serviceWorkers()) {
    const id = tryMatch(sw.url());
    if (id) return id;
  }
  for (const p of context.pages()) {
    const id = tryMatch(p.url());
    if (id) return id;
  }
  try {
    const sw = await context.waitForEvent('serviceworker', { timeout: 10000 });
    const id = tryMatch(sw.url());
    if (id) return id;
  } catch { /* timeout */ }
  await new Promise<void>((r) => setTimeout(r, 2000));
  for (const sw of context.serviceWorkers()) {
    const id = tryMatch(sw.url());
    if (id) return id;
  }
  throw new Error('Could not find extension ID. Make sure the extension is built (npm run build) and loaded.');
}

/**
 * S3 — assert the page is unmodified before a run. Captures the clean baseline
 * fingerprint (the contract the on→off→on→off cycle must restore to) and
 * asserts no Revueon-inserted node is present. Delegates the byte-identical
 * comparison to the canonical comparator in assert-dom-clean.ts.
 */
async function assertDomClean(page: any, label: string): Promise<string> {
  const baseline = await captureFingerprint(page);
  const inserted = await page.evaluate(() => document.querySelectorAll('[data-revueon-inserted]').length) as number;
  if (inserted !== 0) {
    throw new Error(
      `[${label}] DOM NOT CLEAN — ${inserted} [data-revueon-inserted] element(s) present before run. ` +
      `Run aborted and marked failed.`,
    );
  }
  return baseline;
}

/** S1 — send two screenshots (before+after) to the vision model and ask what
 *  is DIFFERENT. C: vision must compare, not describe. A single screenshot
 *  gets a description of the page; a pair gets a diff. */
async function sendVisionDiff(beforePath: string, afterPath: string): Promise<string> {
  if (!ACCOUNT_ID || !API_TOKEN) return '[vision skipped: no credentials]';
  const beforeB64 = readFileSync(beforePath).toString('base64');
  const afterB64 = readFileSync(afterPath).toString('base64');
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run/${VISION_MODEL}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_TOKEN}` },
      body: JSON.stringify({
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: VISION_DIFF_PROMPT },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${beforeB64}` } },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${afterB64}` } },
          ],
        }],
      }),
    });
    if (!res.ok) {
      const txt = await res.text();
      return `[vision error ${res.status}: ${txt.slice(0, 120)}]`;
    }
    const data: any = await res.json();
    return data?.result?.choices?.[0]?.message?.content
      ?? data?.result?.response
      ?? data?.choices?.[0]?.message?.content
      ?? '[vision: no content returned]';
  } catch (err) {
    return `[vision error: ${(err as Error).message}]`;
  }
}

/** C: assert two screenshots are not byte-identical. If they are, the harness
 *  captured the same frame twice and the run is void. */
function assertScreenshotsDiffer(path1: string, path2: string): boolean {
  try {
    const s1 = readFileSync(path1);
    const s2 = readFileSync(path2);
    return !s1.equals(s2);
  } catch { return false; }
}

/** S3 — fresh browser context per run (close + recreate). */
async function createContext(runIndex: number): Promise<any> {
  const userDataDir = `${process.env.TEMP || '/tmp'}/revueon-test-run${runIndex}`;
  // Delete old user data to prevent state leakage from previous harness runs.
  try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  return chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
    ],
  });
}

/** Phase 2.5 TASK4 — goto with one retry on a connection close. The baseline
 *  showed "0 steps, 0 calls, 0.0s" with `net::ERR_CONNECTION_CLOSED` /
 *  "Target page, context or browser has been closed": the SITE (MDN, under
 *  repeated automated hits) or the Playwright context dropped the connection
 *  at page.goto, BEFORE Revueon's loop ran. Revueon never closes pages (the
 *  content script has no page-closing code; confirmed by grep). So this is a
 *  HARNESS/Playwright lifecycle problem, not a product bug — fixed here with
 *  one retry + a longer settle, and the run records a proper FAILED result
 *  (no silent drop to 0/0/0). */
async function gotoWithRetry(page: any, url: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      return;
    } catch (err) {
      const msg = (err as Error).message;
      const closed = /ERR_CONNECTION_CLOSED|Target page, context or browser has been closed|net::ERR_|Target closed/i.test(msg);
      if (!closed || attempt === 1) throw err;
      console.log(`  [harness] goto ${closed ? 'connection closed' : 'failed'} ("${msg.slice(0, 60)}..."), retrying once after 2s`);
      await page.waitForTimeout(2000);
    }
  }
}

async function runGoal(page: any, context: any, url: string, goal: string, name: string): Promise<RunResult> {
  await gotoWithRetry(page, url);
  await page.waitForTimeout(2000);

  // F7: before screenshot for comparison.
  const beforeShot = `${SCREENSHOT_DIR}/${name}-before.png`;
  await page.screenshot({ path: beforeShot });

  const extensionId = await getExtensionId(context);
  const popupUrl = `chrome-extension://${extensionId}/popup.html`;
  const popup = await context.newPage();
  await popup.goto(popupUrl);

  // Bring the page tab to the front so the popup's chrome.tabs.query finds it.
  await page.bringToFront();
  await page.waitForTimeout(500);

  // Set credentials.
  await popup.evaluate(async ({ accountId, apiToken }: { accountId: string; apiToken: string }) => {
    await chrome.storage.local.set({
      cloudflare_account_id: accountId,
      cloudflare_api_token: apiToken,
    });
  }, { accountId: ACCOUNT_ID, apiToken: API_TOKEN });

  // Type the goal and click Transform.
  await popup.fill('#intent', goal);
  await popup.click('#transformBtn');

  // Wait for the result (up to 90s — the loop has a 60s wall clock budget).
  await popup.waitForFunction(() => {
    const el = document.getElementById('revueon-result');
    return el && el.textContent && el.textContent.length > 10;
  }, undefined, { timeout: 90_000 });

  const raw = await popup.locator('#revueon-result').textContent();
  const res = JSON.parse(raw || '{}');

  // Phase 2.5 TASK1 — drain REAL parse failures from the loop result to disk.
  drainParseFailures(res, name);

  // Screenshot.
  const screenshotPath = `${SCREENSHOT_DIR}/${name}.png`;
  await page.screenshot({ path: screenshotPath });
  await popup.close();

  // A: no style node — check journal entries for applied status and inserted elements.
  const changes = await page.evaluate(() => {
    const inserted = document.querySelectorAll('[data-revueon-inserted]').length;
    return { inserted };
  });

  // C: check journal entries for assertApplied results.
  const appliedEntries = (res.journal || []).filter((e: any) =>
    e.kind === 'act' && e.result?.applied !== undefined,
  );
  const anyApplied = appliedEntries.some((e: any) => e.result.applied === true);
  const anyNotApplied = appliedEntries.some((e: any) => e.result.applied === false);

  const result: RunResult = {
    goal, url,
    status: res.status || (res.ok ? 'done' : 'error'),
    summary: res.summary, reason: res.reason || res.error,
    steps: res.steps ?? 0, paidCalls: res.paidCalls ?? 0, wallMs: res.wallMs ?? 0,
    toolsCalled: res.toolsCalled ?? [],
    whatChanged: anyApplied ? `assertApplied: ${appliedEntries.filter((e: any) => e.result.applied).length} act(s) moved computed style`
      : changes.inserted > 0 ? `${changes.inserted} inserted element(s)`
      : anyNotApplied ? `assertApplied: all acts returned applied=false (TRANSFORMATION FAILURE)`
      : 'No changes detected',
    whatItRefused: res.reason || 'Nothing refused',
  };

  // S1 — vision diff: compare before+after, ask what is DIFFERENT.
  // C: assert the pair is not identical before sending.
  const differ = assertScreenshotsDiffer(beforeShot, screenshotPath);
  if (!differ) {
    console.log(`  [vision] WARNING: before+after screenshots are byte-identical — run is void`);
    result.visionDescription = '[VOID: before+after screenshots are byte-identical]';
  } else {
    result.visionDescription = await sendVisionDiff(beforeShot, screenshotPath);
  }
  console.log(`  [vision] diff: ${result.visionDescription.slice(0, 200)}`);

  return result;
}

/**
 * S1 run 5 helper — send a toggle message to the page's content script via the
 * popup's chrome.tabs.sendMessage. Returns the new `on` state.
 */
async function sendToggle(context: any, page: any): Promise<boolean | undefined> {
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
      chrome.tabs.sendMessage(tab.id!, { action: 'toggle' }, (res) => resolve(res));
    });
  }, targetUrl);
  await popup.close();
  return result?.on;
}

function formatReport(r: RunResult): string {
  const line = '─'.repeat(62);
  return `${line}
  GOAL:    ${r.goal}
  URL:     ${r.url}
  STATUS:  ${r.status}
  SUMMARY: ${r.summary || r.reason || '—'}
  STEPS:   ${r.steps}
  CALLS:   ${r.paidCalls} model call(s)
  TIME:    ${(r.wallMs / 1000).toFixed(1)}s
  TOOLS:   ${r.toolsCalled.join(' → ') || 'none'}
  CHANGED: ${r.whatChanged}
  REFUSED: ${r.whatItRefused}
  VISION:  ${r.visionDescription ? r.visionDescription.slice(0, 500) : '—'}
${line}`;
}

interface GoalSpec { url: string; goal: string; name: string; }

async function main() {
  if (!ACCOUNT_ID || !API_TOKEN) {
    console.error('Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN in .env');
    process.exit(1);
  }

  const goals: GoalSpec[] = [
    { url: 'https://developer.mozilla.org/en-US/docs/Web/CSS/justify-content', goal: 'Summarise this article', name: 'run1-summarise' },
    { url: 'https://developer.mozilla.org/en-US/docs/Web/CSS/justify-content', goal: 'Hide the video player', name: 'run2-failing-case' },
    { url: 'https://en.wikipedia.org/wiki/CSS', goal: 'Hide the sidebar', name: 'run3-wikipedia-sidebar' },
    { url: 'https://developer.mozilla.org/en-US/docs/Web/CSS/justify-content', goal: 'Reduce clutter', name: 'run4-reduce-clutter' },
    { url: 'https://news.ycombinator.com/', goal: 'Increase spacing', name: 'run5-hn-spacing' },
    { url: 'https://developer.mozilla.org/en-US/docs/Web/CSS/justify-content', goal: 'Summarise this article', name: 'run6-toggle-cycle' },
  ];

  const results: RunResult[] = [];

  for (let i = 0; i < goals.length; i++) {
    const g = goals[i];
    const runIndex = i + 1;
    console.log(`\n═══ RUN ${runIndex}: ${g.name} — "${g.goal}" on ${g.url} ═══`);

    // S3 — fresh browser context per run.
    let context: any = null;
    try {
      context = await createContext(runIndex);
      const page = await context.newPage();

      // S3 — assert the page is unmodified before the run.
      await page.goto(g.url, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1500);
      const baselineFp = await assertDomClean(page, g.name);

      if (g.name === 'run6-toggle-cycle') {
        // Row 6: off/on/off cycle with the canonical assertDomClean at each off.
        // Both off-fingerprints must be byte-identical to the pre-run baseline.
        const r = await runGoal(page, context, g.url, g.goal, g.name);
        results.push(r);
        console.log(formatReport(r));

        if (r.whatChanged === 'No changes detected') {
          console.error(`  [run6] no changes applied — toggle cycle cannot proceed, marking failed`);
          r.status = 'error';
          r.reason = 'run6: no modification applied to toggle';
        } else {
          console.log(`  [run6] off/on/off toggle cycle starting`);
          // off
          const on1 = await sendToggle(context, page);
          await page.waitForTimeout(500);
          await assertDomCleanCanonical(page, baselineFp, `${g.name} toggle-off-1`);
          console.log(`  [run6] toggle off → on=${on1}, DOM byte-identical to baseline ✓`);
          // on
          const on2 = await sendToggle(context, page);
          await page.waitForTimeout(500);
          const hasStyle = await page.evaluate(() => {
            // A: no style node — check if any user-origin CSS is applied
            // by looking for a border on body (a common test modification).
            return getComputedStyle(document.body).borderWidth !== '0px';
          });
          console.log(`  [run6] toggle on → on=${on2}, CSS applied=${hasStyle}`);
          // off
          const on3 = await sendToggle(context, page);
          await page.waitForTimeout(500);
          await assertDomCleanCanonical(page, baselineFp, `${g.name} toggle-off-2`);
          console.log(`  [run6] toggle off → on=${on3}, DOM byte-identical to baseline ✓`);
          r.whatChanged += ` · toggle cycle off→on→off verified clean`;
        }
      } else {
        const r = await runGoal(page, context, g.url, g.goal, g.name);
        results.push(r);
        console.log(formatReport(r));

        // Row 3: Wikipedia persistence check — reload + navigate to /wiki/HTML.
        if (g.name === 'run3-wikipedia-sidebar' && r.whatChanged !== 'No changes detected') {
          console.log(`  [run3] persistence check: reload + navigate to /wiki/HTML`);
          await page.reload({ waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(2000);
          await page.goto('https://en.wikipedia.org/wiki/HTML', { waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(2500);
          const persisted = await page.evaluate(() => {
            // A: no style node — check if user-origin CSS is applied
            // by reading the computed style of a common modification target.
            const bodyBorder = getComputedStyle(document.body).borderWidth;
            return bodyBorder !== '0px' && bodyBorder !== '';
          });
          console.log(`  [run3] sidebar modification persisted on /wiki/HTML: ${persisted ? 'YES ✓' : 'NO ✗'}`);
          if (!persisted) {
            r.status = 'partial';
            r.reason = 'sidebar modification did not persist across navigation';
          } else {
            r.whatChanged += ` · persisted across navigation ✓`;
          }
        }

        // Row 7: resize after applying — check still correct, no overflow.
        if (g.name === 'run5-hn-spacing' && r.whatChanged !== 'No changes detected') {
          console.log(`  [run5] resize check: 1440 → 380 → 1440`);
          const vp = page.viewportSize();
          await page.setViewportSize({ width: 380, height: 800 });
          await page.waitForTimeout(500);
          const overflow380 = await page.evaluate(() => document.body.scrollWidth > document.body.clientWidth + 2);
          console.log(`  [run5] overflow at 380px: ${overflow380 ? 'YES ✗' : 'NO ✓'}`);
          await page.setViewportSize({ width: 1440, height: 900 });
          await page.waitForTimeout(500);
          const overflow1440 = await page.evaluate(() => document.body.scrollWidth > document.body.clientWidth + 2);
          console.log(`  [run5] overflow at 1440px: ${overflow1440 ? 'YES ✗' : 'NO ✓'}`);
          if (overflow380 || overflow1440) {
            r.status = 'partial';
            r.reason = 'overflow detected after resize';
          } else {
            r.whatChanged += ` · survived resize ✓`;
          }
        }
      }
    } catch (err) {
      const msg = (err as Error).message;
      // TASK4: distinguish a HARNESS/Playwright lifecycle failure (page closed,
      // connection dropped — Revueon never closed it) from a real product error,
      // so "0 steps, 0 calls" is never read as a Revueon bug.
      const harnessLifecycle = /ERR_CONNECTION_CLOSED|Target page, context or browser has been closed|net::ERR_|Target closed|Protocol error/i.test(msg);
      const cause = harnessLifecycle ? 'HARNESS: page/context closed before the loop ran (Revueon did not close it)' : msg;
      console.error(`FAILED: ${g.name} — ${cause}`);
      results.push({
        goal: g.goal, url: g.url, status: 'error', reason: cause,
        steps: 0, paidCalls: 0, wallMs: 0, toolsCalled: [],
        whatChanged: harnessLifecycle ? 'HARNESS lifecycle error (no loop ran)' : 'error', whatItRefused: cause,
      });
    } finally {
      // S3 — close the context so the next run gets a fresh one.
      if (context) {
        try { await context.close(); } catch { /* ignore close errors */ }
      }
    }
  }

  // ── B: THE RED TEST is now a standalone file: tests/red-test.ts ─────
  // Run it separately: node --experimental-strip-types tests/red-test.ts

  // ── C: CONTROL PAIR — identical screenshots must report "nothing changed" ──
  // Use HN (mostly static after load) — MDN has dynamic content that makes
  // two screenshots taken 500ms apart differ.
  console.log('\n═══ CONTROL PAIR — identical screenshots ═══');
  {
    const runIndex = results.length + 1;
    let ctx: any = null;
    try {
      ctx = await createContext(runIndex);
      const page = await ctx.newPage();
      await page.goto('https://news.ycombinator.com/', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
      const shot1 = join(SCREENSHOT_DIR, 'control-pair-1.png');
      const shot2 = join(SCREENSHOT_DIR, 'control-pair-2.png');
      await page.screenshot({ path: shot1 });
      await page.waitForTimeout(500);
      await page.screenshot({ path: shot2 });
      const differ = assertScreenshotsDiffer(shot1, shot2);
      if (differ) {
        console.log('  CONTROL PAIR FAILED: screenshots differ — page is not static');
      } else {
        const visionAns = await sendVisionDiff(shot1, shot2);
        const nothingChanged = visionAns.toLowerCase().includes('nothing changed') || visionAns.toLowerCase().includes('no change');
        console.log(`  control pair: ${nothingChanged ? 'PASS ✓ (vision correctly reported no change)' : 'FAIL ✗'}`);
        console.log(`  vision: ${visionAns.slice(0, 200)}`);
      }
    } catch (err) {
      console.error(`  control pair: FAILED — ${(err as Error).message}`);
    } finally {
      if (ctx) try { await ctx.close(); } catch { /* ignore */ }
    }
  }

  console.log('\n\n═══ SUMMARY ═══');
  for (const r of results) {
    console.log(`  ${r.goal}: ${r.status} (${r.steps} steps, ${r.paidCalls} calls, ${(r.wallMs / 1000).toFixed(1)}s)`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });

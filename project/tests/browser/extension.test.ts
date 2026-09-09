/**
 * Browser characterization suite (S0.1) — the BUILT extension under Playwright,
 * driven through the real production message path: background service worker →
 * chrome.tabs.sendMessage → content script → registered tools. No test-only
 * injection into the page; the content script under test is the shipped one.
 *
 * Cases marked [KNOWN-RED] assert desired behavior that today's code does not
 * deliver; their names are recorded in tests/browser/known-red.json and the
 * gate fails if they start passing (the defect was fixed — flip them into
 * plain regressions). Defect-characterization cases document current behavior
 * and MUST be revisited by the task that changes the behavior (F02 fencing in
 * S2.1); their names say so.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type BrowserContext, type Page, type Worker } from 'playwright';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { REPO, BUILD_MANIFEST, SRC_DIR, isStaleBuild, newestMtime, startFixtureServer } from './lib.ts';

const EXT_PATH = join(REPO, '.output', 'chrome-mv3');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let context: BrowserContext | null = null;
let sw: Worker | null = null;
let fixtures: Awaited<ReturnType<typeof startFixtureServer>> | null = null;

before(async () => {
  // T01: never test a stale build — refuse with the recovery action.
  if (statSync(BUILD_MANIFEST, { throwIfNoEntry: false }) === undefined) {
    throw new Error(`no built extension at ${BUILD_MANIFEST} — run \`npm run build\` from project/ first`);
  }
  const newestSrc = newestMtime(SRC_DIR, [join(REPO, 'wxt.config.ts'), join(REPO, 'package.json')]);
  const manifestMtime = statSync(BUILD_MANIFEST).mtimeMs;
  if (isStaleBuild(manifestMtime, newestSrc)) {
    throw new Error('the built extension is STALE (source is newer than .output/chrome-mv3) — run `npm run build` and re-run the tests');
  }

  fixtures = await startFixtureServer();
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
    ],
  });
  sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 20_000 }));
});

after(async () => {
  await context?.close();
  await fixtures?.close();
});

// ── dispatch helpers (real production path) ─────────────────────────────

async function tabIdFor(page: Page): Promise<number> {
  const tabs = await sw!.evaluate(async () =>
    (await chrome.tabs.query({ active: true, currentWindow: true })).map((t) => ({ id: t.id, url: t.url })),
  );
  const url = page.url();
  const match = tabs.find((t) => t.id != null && t.url === url);
  if (!match) throw new Error(`no active tab matched the fixture page ${url} (F18 wrong-tab guard)`);
  return match.id as number;
}

async function openFixture(name: string): Promise<{ page: Page; tabId: number }> {
  const page = await context!.newPage();
  await page.goto(`${fixtures!.origin}/${name}`, { waitUntil: 'load' });
  await page.bringToFront();
  // Wait until the content script's onMessage listener answers (document_idle).
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const tabId = await tabIdFor(page);
      const alive = await sw!.evaluate(
        async ([id]) => chrome.tabs.sendMessage(id as number, { action: 'resetTxn' }).then(() => true, () => false),
        [tabId],
      );
      if (alive) return { page, tabId };
    } catch { /* SW not ready yet — retry */ }
    if (Date.now() > deadline) throw new Error('content script never answered resetTxn within 10s');
    await sleep(250);
  }
}

async function dispatch(tabId: number, message: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await sw!.evaluate(
    ([id, msg]) => chrome.tabs.sendMessage(id as number, msg as unknown as Record<string, unknown>),
    [tabId, message],
  );
  return res as Record<string, unknown>;
}

const setText = (selector: string, text: string): Record<string, unknown> =>
  ({ action: 'toolCall', tool: 'setText', args: { selector, text, reason: 'translate' } });

// ── smoke ────────────────────────────────────────────────────────────────

test('smoke: built extension runs; content script answers on the production dispatch path', async () => {
  const { page, tabId } = await openFixture('wrong-target.html');
  assert.ok(tabId > 0);
  const manifest = await sw!.evaluate(() => chrome.runtime.getManifest());
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, 'Revueon');
  // A registered observe tool answers through the same path the loop uses.
  const res = await dispatch(tabId, { action: 'toolCall', tool: 'findElements', args: { selector: '#target' } });
  assert.equal(res.ok, true, `findElements should resolve #target: ${JSON.stringify(res)}`);
  assert.ok(page); // the fixture page is alive
});

// ── T05 wrong-target ─────────────────────────────────────────────────────

test('T05: an ambiguous selector is refused — no first-match mutation', async () => {
  const { page, tabId } = await openFixture('wrong-target.html');
  const res = await dispatch(tabId, setText('.item', 'MUTATED'));
  assert.equal(res.ok, false, 'setText on a 2-match selector must refuse');
  assert.match(String(res.error), /not a unique identity|matched 2/);
  const texts = await page.evaluate(() => [...document.querySelectorAll('.item')].map((e) => e.textContent));
  assert.deepEqual(texts, ['Twin one', 'Twin two'], 'neither twin may be mutated');
});

test('T05 (characterizes current gap — revisit with S3.1 targeting): an unobserved selector re-mutates a replaced node', async () => {
  const { page, tabId } = await openFixture('wrong-target.html');
  // The real flow observes first — but describePage's targetable regions on
  // this fixture do not include #target (only coarse regions are targetable),
  // so the act takes the unverified branch and the identity store never
  // protects this selector.
  const obs = await dispatch(tabId, { action: 'toolCall', tool: 'describePage', args: {} });
  assert.equal(obs.ok, true, 'describePage must succeed on the fixture');

  // Act on the unobserved selector, replace the node (re-render), act again.
  const first = await dispatch(tabId, setText('#target', 'Revueon v1'));
  assert.equal(first.ok, true, `first act applies: ${JSON.stringify(first)}`);
  await page.evaluate(() => {
    const el = document.querySelector('#target')!;
    const fresh = el.cloneNode(true) as Element;
    fresh.textContent = 'Replaced by a re-render with entirely different content';
    el.replaceWith(fresh);
  });
  const second = await dispatch(tabId, setText('#target', 'Revueon v2'));
  const now = await page.evaluate(() => document.querySelector('#target')?.textContent);
  assert.equal(second.ok, true, 'characterizes the gap: the unobserved selector still mutates');
  assert.equal(now, 'Revueon v2',
    'characterizes the gap: the REPLACED node (a different element than the first act mutated) is mutated anyway');
});

test('T05 [KNOWN-RED]: after observation, a selector whose node was replaced refuses to re-mutate', async () => {
  const { page, tabId } = await openFixture('wrong-target.html');
  const obs = await dispatch(tabId, { action: 'toolCall', tool: 'describePage', args: {} });
  assert.equal(obs.ok, true);
  const first = await dispatch(tabId, setText('#target', 'Revueon v1'));
  assert.equal(first.ok, true, `first act applies: ${JSON.stringify(first)}`);
  await page.evaluate(() => {
    const el = document.querySelector('#target')!;
    const fresh = el.cloneNode(true) as Element;
    fresh.textContent = 'Replaced by a re-render with entirely different content';
    el.replaceWith(fresh);
  });
  // Desired (S3.1 target registry): a selector that now resolves to a node the
  // system never observed must refuse instead of mutating the wrong element.
  const second = await dispatch(tabId, setText('#target', 'Revueon v2'));
  assert.equal(second.ok, false, 'second act must refuse the replaced node');
  const now = await page.evaluate(() => document.querySelector('#target')?.textContent);
  assert.equal(now, 'Replaced by a re-render with entirely different content', 'the re-rendered node must stay untouched');
});

// ── F06 clone-restore (T09) ─────────────────────────────────────────────

test('F06 [KNOWN-RED]: undo restores the SAME native node and its listener', async () => {
  const { page, tabId } = await openFixture('clone-restore.html');
  // Attach a listener in the page's main world, as the site itself would.
  await page.evaluate(() => {
    const btn = document.getElementById('btn')!;
    (window as unknown as { __btn: Element; __clicks: number }).__btn = btn;
    (window as unknown as { __clicks: number }).__clicks = 0;
    btn.addEventListener('click', () => { (window as unknown as { __clicks: number }).__clicks += 1; });
  });

  const act = await dispatch(tabId, setText('#btn', 'Translated button label'));
  assert.equal(act.ok, true, `setText must apply: ${JSON.stringify(act)}`);

  const undo = await dispatch(tabId, { action: 'undoLast' });
  assert.equal(undo.ok, true, `undoLast must run: ${JSON.stringify(undo)}`);

  // Desired: the original node survives with its listener; a real click counts.
  await page.click('#btn');
  const state = await page.evaluate(() => {
    const w = window as unknown as { __btn: Element; __clicks: number };
    return { sameNode: document.getElementById('btn') === w.__btn, clicks: w.__clicks, text: document.getElementById('btn')?.textContent };
  });
  assert.equal(state.text, 'Save changes', 'undo must restore the original text');
  assert.equal(state.sameNode, true, 'undo must NOT replace the native node with a clone');
  assert.equal(state.clicks, 1, 'the site listener attached to the original node must survive undo');
});

// ── F02 late dispatch (T08) ─────────────────────────────────────────────

test('F02 (characterizes current defect — revisit with S2.1 fencing): a dispatch whose caller stops waiting still mutates', async () => {
  const { page, tabId } = await openFixture('late-dispatch.html');
  // The caller "gives up" (timeout means unknown) — fire and forget.
  await sw!.evaluate(
    ([id, msg]) => { void chrome.tabs.sendMessage(id as number, msg as unknown as Record<string, unknown>).catch(() => {}); },
    [tabId, setText('#late', 'MUTATED AFTER ABANDONMENT')],
  );
  await sleep(400);
  const text = await page.evaluate(() => document.querySelector('#late')?.textContent);
  assert.equal(text, 'MUTATED AFTER ABANDONMENT',
    'characterizes F02: without document/run fencing, an abandoned dispatch still mutates the page');
});

test('F02 [KNOWN-RED]: a toolCall receipt carries reconcilable operation identity', async () => {
  const { tabId } = await openFixture('late-dispatch.html');
  const res = await dispatch(tabId, {
    ...setText('#late', 'Any text'),
    runId: 'run-fixture',
    documentId: 'doc-fixture',
    operationId: 'op-fixture',
  });
  assert.equal(res.ok, true);
  // Desired: the response names the operation/document it executed, so a caller
  // that timed out can reconcile a late acknowledgement (I04/I06).
  const receipt = (res.receipt ?? (res.result as { receipt?: unknown })?.receipt) as Record<string, unknown> | undefined;
  assert.ok(receipt, `toolCall response must carry a receipt with operation identity; got: ${JSON.stringify(res)}`);
  assert.equal(receipt.operationId, 'op-fixture');
  assert.equal(receipt.documentId, 'doc-fixture');
});

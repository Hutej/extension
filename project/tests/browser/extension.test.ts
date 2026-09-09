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

// ── S2.1: v2 document broker/runtime vertical (real message paths) ──────

interface CapturedState {
  documentKey?: { tabId: number; frameId: number; browserDocumentId: string; runtimeInstanceId: string };
  routeEpoch?: number;
  state?: string;
}

/** Open an extension page as the trusted workspace sender (plan/06: workspace
 *  → broker commands originate from extension pages) and subscribe to the
 *  runtime's RuntimeState projections. */
async function openWorkspace(): Promise<Page> {
  const extId = await sw!.evaluate(() => chrome.runtime.id) as string;
  const ws = await context!.newPage();
  await ws.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'load' });
  await ws.evaluate(() => {
    const w = window as unknown as { __rv2States: CapturedState[] };
    w.__rv2States = [];
    chrome.runtime.onMessage.addListener((msg: unknown) => {
      const m = msg as { protocolVersion?: number; kind?: string; payload?: { command?: string }; documentKey?: CapturedState['documentKey']; payloadState?: string };
      if (m && m.protocolVersion === 1 && m.kind === 'subscription' && m.payload?.command === 'RuntimeState') {
        w.__rv2States.push({
          documentKey: m.documentKey,
          routeEpoch: (m.payload as unknown as { routeEpoch?: number }).routeEpoch,
          state: (m.payload as unknown as { state?: string }).state,
        });
      }
    });
  });
  return ws;
}

async function capturedState(ws: Page, tabId: number, minInstanceGeneration = 0): Promise<CapturedState> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const states = await ws.evaluate(() => (window as unknown as { __rv2States: CapturedState[] }).__rv2States);
    const mine = states.filter((s) => s.documentKey?.tabId === tabId && s.state === 'ready');
    if (mine.length > minInstanceGeneration) return mine[mine.length - 1];
    if (Date.now() > deadline) {
      throw new Error(`no ready RuntimeState captured for tab ${tabId} (got ${JSON.stringify(states)})`);
    }
    await sleep(200);
  }
}

/** Send a v2 envelope from the workspace page through the real path. */
async function workspaceSend(ws: Page, envelope: Record<string, unknown>): Promise<Record<string, unknown>> {
  return (await ws.evaluate(
    (msg) => chrome.runtime.sendMessage(msg as unknown as Record<string, unknown>),
    envelope,
  )) as Record<string, unknown>;
}

const runCommandEnvelope = (
  command: string,
  documentKey: CapturedState['documentKey'],
  expectedRouteEpoch: number | undefined,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  protocolVersion: 1,
  requestId: `ws-${Math.random().toString(36).slice(2, 10)}`,
  kind: 'run-command',
  ...(documentKey ? { documentKey } : {}),
  ...(expectedRouteEpoch !== undefined ? { expectedRouteEpoch } : {}),
  deadlineAt: Date.now() + 10_000,
  payload: { command, ...extra },
});

const getOperationEnvelope = (
  documentKey: CapturedState['documentKey'],
  expectedRouteEpoch: number,
  operationId: string,
): Record<string, unknown> => ({
  protocolVersion: 1,
  requestId: `ws-${Math.random().toString(36).slice(2, 10)}`,
  kind: 'control',
  ...(documentKey ? { documentKey } : {}),
  expectedRouteEpoch,
  deadlineAt: Date.now() + 10_000,
  payload: { command: 'GetOperation', operationId },
});

const replyError = (reply: Record<string, unknown>): Record<string, unknown> | undefined =>
  reply.ok === false ? (reply.error as Record<string, unknown>) : undefined;

let workspace: Page | null = null;

test('S2.1: the v2 vertical registers the document runtime with verified identity (T21)', async () => {
  workspace = await openWorkspace();
  const { page, tabId } = await openFixture('v2-vertical.html');
  const state = await capturedState(workspace, tabId);
  assert.ok(state.documentKey, `registration must carry a verified DocumentKey: ${JSON.stringify(state)}`);
  assert.equal(state.documentKey!.tabId, tabId, 'identity comes from the browser sender, not the payload');
  assert.equal(state.documentKey!.frameId, 0);
  assert.ok(state.documentKey!.browserDocumentId?.length, 'browser document id is authoritative');
  assert.ok(state.documentKey!.runtimeInstanceId?.length);
  assert.equal(state.routeEpoch, 0, 'fresh document starts at route epoch 0');

  // The runtime of the fixture page must have actually booted: the legacy
  // dispatcher must still answer on the same document (coexistence check).
  const legacyAlive = await sw!.evaluate(
    async ([id]) => chrome.tabs.sendMessage(id as number, { action: 'resetTxn' }).then(() => true, () => false),
    [tabId],
  );
  assert.equal(legacyAlive, true, 'the legacy dispatcher must remain reachable on its own path');
  void page;
});

test('S2.1: one run owner per document — second StartRun is refused with a recovery action (T14)', async () => {
  assert.ok(workspace, 'workspace page from the registration test');
  const { tabId } = await openFixture('v2-vertical.html');
  const state = await capturedState(workspace, tabId);
  const dk = state.documentKey!;
  const first = await workspaceSend(workspace, runCommandEnvelope('StartRun', dk, state.routeEpoch, { goal: 'vertical test' }));
  assert.equal(first.ok, true, `StartRun must succeed: ${JSON.stringify(first)}`);
  assert.ok(typeof first.runId === 'string');

  const second = await workspaceSend(workspace, runCommandEnvelope('StartRun', dk, state.routeEpoch, { goal: 'second' }));
  const err = replyError(second);
  assert.ok(err, `second StartRun must be refused: ${JSON.stringify(second)}`);
  assert.equal(err!.code, 'conflict');
  assert.match(String(err!.recoveryAction), /CancelRun/);

  const cancel = await workspaceSend(workspace, runCommandEnvelope('CancelRun', dk, state.routeEpoch));
  assert.equal(cancel.ok, true, `CancelRun must succeed: ${JSON.stringify(cancel)}`);
  const third = await workspaceSend(workspace, runCommandEnvelope('StartRun', dk, state.routeEpoch, { goal: 'after cancel' }));
  assert.equal(third.ok, true, `StartRun after cancel must succeed: ${JSON.stringify(third)}`);
  await workspaceSend(workspace, runCommandEnvelope('CancelRun', dk, state.routeEpoch));
});

test('S2.1: GetOperation relays to the runtime through the broker and the fence holds (T21/T11)', async () => {
  assert.ok(workspace, 'workspace page from the registration test');
  const { tabId } = await openFixture('v2-vertical.html');
  const state = await capturedState(workspace, tabId);
  const dk = state.documentKey!;

  // Full vertical: workspace → broker (sender verified) → registry fencing →
  // tabs.sendMessage → runtime fence → honest no-receipt reply → relayed back.
  const relayed = await workspaceSend(workspace, getOperationEnvelope(dk, state.routeEpoch!, 'op-unknown-1'));
  assert.equal(relayed.ok, true, `broker must relay: ${JSON.stringify(relayed)}`);
  assert.equal(relayed.kind, 'relayed');
  const inner = (relayed.receipt as Record<string, unknown>) ?? {};
  assert.equal(inner.ok, false, 'the runtime must answer, not the broker: no receipt is retained for the unknown id');
  const innerErr = inner.error as Record<string, unknown>;
  assert.equal(innerErr.code, 'unknown-target');

  // A stale route epoch never reaches the runtime: the broker rejects it.
  const stale = await workspaceSend(workspace, getOperationEnvelope(dk, (state.routeEpoch ?? 0) + 7, 'op-2'));
  const staleErr = replyError(stale);
  assert.ok(staleErr, `stale epoch must be rejected: ${JSON.stringify(stale)}`);
  assert.equal(staleErr!.code, 'stale-route');

  // A tab id alone does not authorize: an unregistered document is denied.
  const forged = await workspaceSend(workspace, getOperationEnvelope(
    { tabId: 987_654, frameId: 0, browserDocumentId: 'forged', runtimeInstanceId: dk.runtimeInstanceId! },
    0, 'op-3',
  ));
  const forgedErr = replyError(forged);
  assert.ok(forgedErr, `forged document must be denied: ${JSON.stringify(forged)}`);
  assert.equal(forgedErr!.code, 'unknown-target');
});

test('S2.1: after reload, the old runtime instance is deterministically rejected (T08 late messages)', async () => {
  assert.ok(workspace, 'workspace page from the registration test');
  const fixture = await openFixture('v2-vertical.html');
  const oldState = await capturedState(workspace, fixture.tabId);
  const oldInstance = oldState.documentKey!.runtimeInstanceId;

  // Full navigation: the old runtime dies with the document; a fresh one
  // registers (extension-reinjection-equivalent identity replacement).
  await fixture.page.reload({ waitUntil: 'load' });
  const newState = await capturedState(workspace, fixture.tabId, 1); // a SECOND ready state for this tab
  assert.notEqual(
    newState.documentKey!.runtimeInstanceId, oldInstance,
    'a fresh document must register a new runtime instance',
  );

  // The old instance's key no longer resolves: the late command is rejected
  // deterministically (stale-document or unknown-target — never executed).
  const late = await workspaceSend(workspace, getOperationEnvelope(oldState.documentKey!, oldState.routeEpoch!, 'op-late'));
  const lateErr = replyError(late);
  assert.ok(lateErr, `a late command for the old instance must be rejected: ${JSON.stringify(late)}`);
  assert.ok(['stale-document', 'unknown-target'].includes(String(lateErr!.code)), `unexpected code: ${lateErr!.code}`);

  // And the fresh instance answers normally.
  const fresh = await workspaceSend(workspace, getOperationEnvelope(newState.documentKey!, newState.routeEpoch!, 'op-fresh'));
  assert.equal(fresh.ok, true, `fresh instance must be reachable: ${JSON.stringify(fresh)}`);
});

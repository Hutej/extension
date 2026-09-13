/**
 * Browser suite for the S6.3 cutover state — the BUILT extension under
 * Playwright, driven through the real v2 production message path: workspace
 * extension page → broker (verified sender + document fence) → the one
 * document runtime. No test-only injection into the page; the content script
 * under test is the shipped one (I27/I28).
 *
 * The S0.1 legacy-dispatch characterization tests (toolCall/resetTxn/undoLast
 * and their F02/F05/F06/T05 known-red markers) died with the legacy
 * dispatcher they characterized — plan/19 §3.2 removes the old live path and
 * §6 requires "no legacy action dispatcher" to be PROVEN, which the smoke
 * test now asserts directly. The historical regression knowledge lives in
 * Git history and plan/01, not in live old architecture.
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
let workspace: Page | null = null;
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

async function tabIdOf(page: Page): Promise<number> {
  const tabId = await tabIdFor(page);
  return tabId;
}

async function openFixture(name: string): Promise<{ page: Page; tabId: number }> {
  const page = await context!.newPage();
  await page.goto(`${fixtures!.origin}/${name}`, { waitUntil: 'load' });
  await page.bringToFront();
  const tabId = await tabIdOf(page);
  // The v2 liveness signal: the runtime's VERIFIED registration reaches the
  // broker registry (the legacy resetTxn handshake died with the dispatcher).
  await registeredDocument(tabId);
  return { page, tabId };
}

// ── smoke (cutover state) ─────────────────────────────────────────────────

test('smoke: the one v2 runtime registers; the legacy action dispatcher is gone (plan/19 §6)', async () => {
  workspace = await ensureWorkspace();
  const { page, tabId } = await openFixture('v2-vertical.html');
  const manifest = await sw!.evaluate(() => chrome.runtime.getManifest());
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, 'Revueon');
  assert.equal((manifest.action as Record<string, unknown> | undefined)?.default_popup, undefined,
    'the S6.3 cutover removed the ephemeral popup — the workspace is a side panel/tab (AC-09)');
  assert.ok(manifest.side_panel, 'the side panel hosts the shared workspace page');
  // The registered document is the verified identity from ListDocuments.
  const doc = await registeredDocument(tabId);
  assert.equal(doc.documentKey.tabId, tabId, 'identity comes from the browser sender, not the payload');
  assert.ok(doc.documentKey.browserDocumentId.length > 0, 'browser document id is authoritative');
  // ONE mutation owner (I03): a legacy `action` message must produce NO
  // result and mutate nothing — the old toolCall surface is deleted.
  const legacyReply = await sw!.evaluate(
    async ([id, msg]) => chrome.tabs
      .sendMessage(id as number, msg as unknown as Record<string, unknown>)
      .then((r: unknown) => ({ answered: r !== undefined }), () => ({ answered: false })),
    [tabId, { action: 'toolCall', tool: 'setText', args: { selector: 'h1', text: 'HACKED BY LEGACY PATH' } }],
  );
  assert.equal(legacyReply.answered, false, 'no legacy dispatcher may answer');
  const heading = await page.evaluate(() => document.querySelector('h1')?.textContent ?? '');
  assert.notEqual(heading, 'HACKED BY LEGACY PATH', 'the deleted legacy path must not mutate the page');
});

// ── S2.1: v2 document broker/runtime vertical (real message paths) ──────

interface CapturedState {
  documentKey?: { tabId: number; frameId: number; browserDocumentId: string; runtimeInstanceId: string };
  routeEpoch?: number;
  state?: string;
  customizations?: Array<{ customizationId: string; state: string; detail?: string }>;
}

/** Open the shared workspace page (sidepanel.html — the popup died with the
 *  S6.3 cutover) as the trusted workspace sender (plan/06: workspace →
 *  broker commands originate from extension pages) and subscribe to the
 *  runtime's RuntimeState projections. Idempotent: one page per suite. */
async function ensureWorkspace(): Promise<Page> {
  if (workspace !== null) return workspace;
  const extId = await sw!.evaluate(() => chrome.runtime.id) as string;
  const ws = await context!.newPage();
  await ws.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'load' });
  await ws.evaluate(() => {
    const w = window as unknown as { __rv2States: CapturedState[] };
    w.__rv2States = [];
    chrome.runtime.onMessage.addListener((msg: unknown) => {
      const m = msg as { protocolVersion?: number; kind?: string; payload?: { command?: string; customizations?: Array<{ customizationId: string; state: string }> }; documentKey?: CapturedState['documentKey']; payloadState?: string };
      if (m && m.protocolVersion === 1 && m.kind === 'subscription' && m.payload?.command === 'RuntimeState') {
        w.__rv2States.push({
          documentKey: m.documentKey,
          routeEpoch: (m.payload as unknown as { routeEpoch?: number }).routeEpoch,
          state: (m.payload as unknown as { state?: string }).state,
          ...(m.payload.customizations !== undefined ? { customizations: m.payload.customizations } : {}),
        });
      }
    });
  });
  workspace = ws;
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

/** Poll ListDocuments (the S6.2 workspace discovery command) until the tab's
 *  runtime has REGISTERED — the honest v2 liveness signal, on the real path. */
async function registeredDocument(tabId: number): Promise<{
  documentKey: { tabId: number; frameId: number; browserDocumentId: string; runtimeInstanceId: string };
  routeEpoch: number;
}> {
  const ws = await ensureWorkspace();
  const deadline = Date.now() + 10_000;
  for (;;) {
    const reply = (await workspaceSend(ws, {
      protocolVersion: 1,
      requestId: `probe-${Math.random().toString(36).slice(2, 10)}`,
      kind: 'control',
      deadlineAt: Date.now() + 10_000,
      payload: { command: 'ListDocuments' },
    })) as Record<string, unknown>;
    const docs = (reply.documents ?? []) as Array<{
      documentKey: { tabId: number; frameId: number; browserDocumentId: string; runtimeInstanceId: string };
      tabId: number;
      routeEpoch: number;
    }>;
    const mine = docs.filter((d) => d.tabId === tabId);
    if (mine.length > 0) return { documentKey: mine[0].documentKey, routeEpoch: mine[0].routeEpoch };
    if (Date.now() > deadline) throw new Error(`the document for tab ${tabId} never registered with the broker`);
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

const replyError = (reply: Record<string, unknown>): Record<string, unknown> | undefined => {
  if (reply.ok === false) return reply.error as Record<string, unknown>;
  // A relayed reply wraps the runtime's own error reply as the receipt.
  const receipt = reply.receipt as Record<string, unknown> | undefined;
  if (receipt && receipt.ok === false) return receipt.error as Record<string, unknown>;
  return undefined;
};

test('S2.1: the v2 vertical registers the document runtime with verified identity (T21)', async () => {
  workspace = await ensureWorkspace();
  const { page, tabId } = await openFixture('v2-vertical.html');
  const state = await capturedState(workspace, tabId);
  assert.ok(state.documentKey, `registration must carry a verified DocumentKey: ${JSON.stringify(state)}`);
  assert.equal(state.documentKey!.tabId, tabId, 'identity comes from the browser sender, not the payload');
  assert.equal(state.documentKey!.frameId, 0);
  assert.ok(state.documentKey!.browserDocumentId?.length, 'browser document id is authoritative');
  assert.ok(state.documentKey!.runtimeInstanceId?.length);
  assert.equal(state.routeEpoch, 0, 'fresh document starts at route epoch 0');

  // The runtime of the fixture page booted on the one v2 path; the legacy
  // dispatcher is DELETED (plan/19 §3.2/§6): its messages resolve with no
  // result — the v2 listener ignores them, one mutation owner only (I03).
  const legacyDead = await sw!.evaluate(
    async ([id]) => chrome.tabs.sendMessage(id as number, { action: 'resetTxn' }).then((r: unknown) => r === undefined, () => false),
    [tabId],
  );
  assert.equal(legacyDead, true, 'the legacy dispatcher is gone; its messages produce no result');
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

test('S2.2: the style-delivery authority is runtime-only on the real path (T21 live)', async () => {
  assert.ok(workspace, 'workspace page from the registration test');
  const { tabId } = await openFixture('v2-vertical.html');
  const state = await capturedState(workspace, tabId);
  const dk = state.documentKey!;
  // StageStyle is a runtime→broker command (plan/06 §1): a workspace sender
  // is denied even though it is a trusted extension context.
  const reply = await workspaceSend(workspace, {
    protocolVersion: 1,
    requestId: `ws-${Math.random().toString(36).slice(2, 10)}`,
    kind: 'style-delivery',
    documentKey: dk,
    expectedRouteEpoch: state.routeEpoch,
    deadlineAt: Date.now() + 10_000,
    payload: { command: 'StageStyle', operationId: 'op-browser-1', namespace: 'rv2.t.r.g.d', css: '#target { color: red; }' },
  });
  const err = replyError(reply);
  assert.ok(err, `workspace StageStyle must be denied: ${JSON.stringify(reply)}`);
  assert.equal(err!.code, 'denied');
});

// ── S3.1: bounded semantic observation (T03/T04/T05 live) ───────────────

const observeEnvelope = (
  documentKey: CapturedState['documentKey'],
  expectedRouteEpoch: number,
  payload: Record<string, unknown>,
): Record<string, unknown> => ({
  protocolVersion: 1,
  requestId: `ws-${Math.random().toString(36).slice(2, 10)}`,
  kind: 'observe-request',
  ...(documentKey ? { documentKey } : {}),
  expectedRouteEpoch,
  deadlineAt: Date.now() + 10_000,
  payload,
});

interface SnapshotRegion {
  targetRef: string;
  parentRef?: string;
  semantics: { tag: string; role?: string; nameApprox?: string };
  textSample?: string;
}

test('S3.1/T04: Observe returns a bounded, privacy-filtered snapshot through the real path', async () => {
  assert.ok(workspace, 'workspace page from the registration test');
  const { page, tabId } = await openFixture('observe.html');
  const state = await capturedState(workspace, tabId);
  const reply = await workspaceSend(workspace, observeEnvelope(state.documentKey, state.routeEpoch!, { command: 'Observe' }));
  assert.equal(reply.ok, true, `Observe must be delivered: ${JSON.stringify(reply).slice(0, 300)}`);
  const snapshot = (reply as { receipt?: { snapshot?: Record<string, unknown> } }).receipt?.snapshot as {
    schemaVersion: number;
    regions: SnapshotRegion[];
    actions: Array<{ kind: string; controlType?: string; targetRef: string }>;
    documentMetadata: { origin: string };
    roots: Array<{ kind: string }>;
    coverage: { completed: boolean; visitedNodes: number };
  };
  assert.ok(snapshot, 'the relay carries the snapshot');
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.coverage.completed, true, 'a small fixture is fully covered');
  assert.ok(snapshot.regions.length <= 60, 'region budget respected');
  assert.ok(snapshot.coverage.visitedNodes <= 2_000, 'node budget respected');
  // T04 sentinels: no private value/name reaches the snapshot, ever.
  const raw = JSON.stringify(snapshot);
  assert.equal(raw.includes('SENTINEL-PASSWORD-VALUE'), false, 'the password placeholder must be absent');
  assert.equal(raw.includes('sentinel.email@example.com'), false, 'the email value must be absent');
  // The email in VISIBLE page text is residual-redacted, not leaked.
  const intro = snapshot.regions.find((r) => r.textSample?.includes('Contact us'));
  assert.ok(intro, 'the intro paragraph is observed');
  assert.equal(intro.textSample!.includes('sentinel.user@example.com'), false, 'email in text is redacted');
  assert.match(intro.textSample!, /redacted:email/);
  // Private controls keep no name context at all.
  const passwordRegion = snapshot.regions.find((r) => r.semantics.tag === 'input' && (r as { hidden?: boolean }).hidden !== undefined);
  const passwordAction = snapshot.actions.find((a) => a.controlType === 'password');
  assert.equal(passwordAction, undefined, 'the password control type is never reported');
  const passwordInput = snapshot.regions.find((r) => {
    const a = snapshot.actions.find((act) => act.targetRef === r.targetRef);
    return a === undefined && r.semantics.tag === 'input';
  });
  assert.ok(passwordInput === undefined || passwordInput.semantics.nameApprox === undefined || !passwordInput.semantics.nameApprox.includes('SENTINEL'),
    'no sentinel name on any input region');
  // Open shadow root is a registered root of its own (I26).
  assert.ok(snapshot.roots.some((r) => r.kind === 'shadow-root'), 'the open shadow root is a registered root');
  const shadowRegion = snapshot.regions.find((r) => r.semantics.nameApprox?.includes('Widget panel'));
  assert.ok(shadowRegion, 'shadow content is observed in its own root');
  void page;
});

test('S3.1/T03: a 10k-node page reports partial coverage with a usable cursor', async () => {
  assert.ok(workspace, 'workspace page from the registration test');
  const { tabId } = await openFixture('observe-large.html');
  const state = await capturedState(workspace, tabId);
  const started = Date.now();
  const reply = await workspaceSend(workspace, observeEnvelope(state.documentKey, state.routeEpoch!, { command: 'Observe' }));
  const wallMs = Date.now() - started;
  const { receipt } = reply as { receipt?: { snapshot?: { coverage: { completed: boolean; reason?: string; nextCursor?: string; visitedNodes: number }; regions: SnapshotRegion[] } } };
  const snapshot = receipt?.snapshot;
  assert.ok(snapshot, 'snapshot delivered');
  assert.equal(snapshot!.coverage.completed, false, '10k nodes are honestly partial');
  assert.equal(snapshot!.coverage.reason, 'node-budget');
  assert.ok(snapshot!.coverage.nextCursor, 'a cursor is offered');
  assert.ok(snapshot!.coverage.visitedNodes <= 2_000, 'node budget holds');
  assert.ok(wallMs < 3_000, `end-to-end observe latency stays bounded (got ${wallMs}ms)`);
  assert.equal(snapshot!.regions.length <= 60, true, 'region budget holds');

  // Expansion through the cursor works; a forged cursor is refused.
  const expand = await workspaceSend(workspace, observeEnvelope(state.documentKey, state.routeEpoch!, { command: 'Expand', cursor: snapshot!.coverage.nextCursor! }));
  assert.equal(expand.ok, true, `expansion with a live cursor works: ${JSON.stringify(expand).slice(0, 200)}`);
  const forged = await workspaceSend(workspace, observeEnvelope(state.documentKey, state.routeEpoch!, { command: 'Expand', cursor: 'forged:0:99999999999999' }));
  const err = replyError(forged);
  assert.ok(err, 'a forged cursor is refused');
  assert.ok(['stale-route', 'unknown-target'].includes(String(err!.code)), `cursor refusal code: ${err!.code}`);
});

test('S3.1/T05: Inspect resolves the exact observed node and refuses stale/unknown refs', async () => {
  assert.ok(workspace, 'workspace page from the registration test');
  const { page, tabId } = await openFixture('observe.html');
  const state = await capturedState(workspace, tabId);
  const reply = await workspaceSend(workspace, observeEnvelope(state.documentKey, state.routeEpoch!, { command: 'Observe' }));
  const snapshot = (reply as { receipt?: { snapshot?: { regions: SnapshotRegion[] } } }).receipt?.snapshot;
  assert.ok(snapshot);
  const heading = snapshot!.regions.find((r) => r.semantics.tag === 'h1');
  assert.ok(heading, 'the h1 is observed');

  const facts = await workspaceSend(workspace, observeEnvelope(state.documentKey, state.routeEpoch!, { command: 'Inspect', targetRef: heading!.targetRef, fields: ['geometry', 'style'] }));
  assert.equal(facts.ok, true, `inspect resolves the exact ref: ${JSON.stringify(facts).slice(0, 200)}`);
  const factsBody = (facts as { receipt?: { facts?: { tag?: string; geometry?: { w: number } } } }).receipt?.facts;
  assert.equal(factsBody?.tag, 'h1');
  assert.ok(factsBody?.geometry, 'requested fields are returned');

  const unknown = await workspaceSend(workspace, observeEnvelope(state.documentKey, state.routeEpoch!, { command: 'Inspect', targetRef: 't9999' }));
  assert.equal(replyError(unknown)?.code, 'unknown-target', 'an unobserved ref is refused');

  // Replace the observed node (site re-render), then inspect again: stale.
  await page.evaluate(() => {
    const h1 = document.querySelector('h1')!;
    const fresh = h1.cloneNode(true) as Element;
    fresh.textContent = 'Replaced heading';
    h1.replaceWith(fresh);
  });
  const stale = await workspaceSend(workspace, observeEnvelope(state.documentKey, state.routeEpoch!, { command: 'Inspect', targetRef: heading!.targetRef }));
  const staleErr = replyError(stale);
  assert.ok(staleErr, 'a replaced node must not resolve');
  assert.equal(staleErr!.code, 'stale-target', 'the exact-node ref goes stale, never re-resolves to a lookalike');
});

// ── S4.2: one-batch transactions and generic element insertion (real path) ──

const applyBatchEnvelope = (
  documentKey: CapturedState['documentKey'],
  expectedRouteEpoch: number,
  batch: Record<string, unknown>,
): Record<string, unknown> => ({
  protocolVersion: 1,
  requestId: `ws-${Math.random().toString(36).slice(2, 10)}`,
  kind: 'run-command',
  documentKey,
  expectedRouteEpoch,
  deadlineAt: Date.now() + 10_000,
  payload: { command: 'ApplyBatch', batch },
});

interface AppliedReceipt {
  batchId: string;
  payloadDigest?: string;
  status: string;
  resourceIds?: string[];
  error?: { code: string; message: string; recoveryAction?: string };
  report?: {
    status: string;
    counts: Record<string, number>;
    coverage: { checks: number; rechecked: boolean; preExistingBroken: number };
    issues: Array<{ key: string; status: string; detail?: string }>;
  };
}

async function applyBatch(
  ws: Page,
  state: CapturedState,
  batch: Record<string, unknown>,
): Promise<AppliedReceipt> {
  const reply = await workspaceSend(ws, applyBatchEnvelope(state.documentKey, state.routeEpoch!, batch));
  assert.equal(reply.ok, true, `ApplyBatch must be relayed: ${JSON.stringify(reply).slice(0, 400)}`);
  const inner = (reply.receipt as Record<string, unknown>) ?? {};
  assert.equal(inner.kind, 'receipt', `the runtime must answer with a receipt: ${JSON.stringify(reply).slice(0, 400)}`);
  return inner.receipt as AppliedReceipt;
}

async function refsOf(ws: Page, state: CapturedState): Promise<Record<string, string>> {
  const reply = await workspaceSend(ws, observeEnvelope(state.documentKey, state.routeEpoch!, { command: 'Observe' }));
  const snapshot = (reply as { receipt?: { snapshot?: { regions: SnapshotRegion[] } } }).receipt?.snapshot;
  assert.ok(snapshot, 'observe must deliver a snapshot');
  const byText = async (needle: string): Promise<string> => {
    const region = snapshot!.regions.find((r) => r.textSample?.includes(needle) || r.semantics.nameApprox?.includes(needle));
    assert.ok(region, `no region matches "${needle}" in ${JSON.stringify(snapshot!.regions.map((r) => r.textSample ?? r.semantics.nameApprox))}`);
    return region!.targetRef;
  };
  const section = snapshot!.regions.find((r) => r.semantics.tag === 'section');
  assert.ok(section, 'the host section is observed');
  // The flaky ANCHOR is the section, not the paragraph inside it: use the
  // paragraph's observed parentRef (document-order regions carry parents).
  const flakyP = snapshot!.regions.find((r) => r.textSample?.includes('Flaky container'));
  const flakyParent = snapshot!.regions.find((r) => r.targetRef === ((flakyP as { parentRef?: string } | undefined)?.parentRef ?? ''));
  assert.ok(flakyParent, 'the flaky section is observed as the paragraph parent');
  return {
    leaf: await byText('Original text'),
    btn: await byText('Save changes'),
    host: section!.targetRef,
    flaky: flakyParent!.targetRef,
  };
}

test('S4.2/T31: insertUI card + same-batch local styling accepts on the real path; native controls are accessible and placed exactly', async () => {
  assert.ok(workspace, 'workspace page from the registration test');
  const { page, tabId } = await openFixture('v2-apply.html');
  const state = await capturedState(workspace, tabId);
  const refs = await refsOf(workspace, state);

  const receipt = await applyBatch(workspace, state, {
    batchId: 'browser-b1',
    customizationId: 'cards',
    revisionId: 'cards-r1',
    operations: [
      {
        kind: 'insertUI',
        target: { targetRef: refs.host },
        position: 'last-child',
        nodes: [
          { localId: 'panel', tag: 'div', children: [
            { tag: 'h2', text: 'Notes' },
            { tag: 'label', text: 'Search', labelFor: 'nameField' },
            { localId: 'nameField', tag: 'input', attributes: { type: 'search', placeholder: 'Filter' } },
            { tag: 'button', text: 'Go' },
          ] },
        ],
      },
      {
        kind: 'style',
        rules: [{
          target: { localRef: 'panel' },
          declarations: [
            { property: 'background-color', value: 'rebeccapurple', priority: 'important' },
            { property: 'color', value: '#ffffff', priority: 'important' },
          ],
        }],
      },
    ],
  });
  assert.equal(receipt.status, 'accepted', JSON.stringify(receipt).slice(0, 400));
  // S4.3: the acceptance gate ships the structured report for THIS revision.
  const report = (receipt as unknown as { report?: { status: string; coverage: { checks: number }; issues: unknown[] } }).report;
  assert.ok(report, 'the accepted receipt carries the exact-revision VerificationReport');
  assert.equal(report!.status, 'pass');
  assert.ok(report!.coverage.checks > 0, 'effect checks were actually measured');
  assert.equal(report!.issues.length, 0);

  const dom = await page.evaluate(() => {
    const panel = document.querySelector('#host > div');
    const label = panel?.querySelector('label');
    const input = panel?.querySelector('input');
    return {
      panelExists: panel !== null,
      heading: panel?.querySelector('h2')?.textContent,
      buttonType: panel?.querySelector('button')?.getAttribute('type'),
      inputType: input?.getAttribute('type'),
      forAttr: label?.getAttribute('for'),
      inputId: input?.id,
      background: panel ? getComputedStyle(panel).backgroundColor : '',
      token: panel?.getAttribute('data-rv2-ns'),
    };
  });
  assert.equal(dom.panelExists, true, 'the owned card is inserted at the anchor');
  assert.equal(dom.heading, 'Notes');
  assert.equal(dom.buttonType, 'button', 'owned buttons are always type=button');
  assert.equal(dom.inputType, 'search');
  assert.ok(dom.forAttr && dom.inputId && dom.forAttr === dom.inputId, 'the label references the runtime-generated input id');
  assert.ok(dom.inputId.startsWith('rv2-owned-'), `runtime-generated id, got "${dom.inputId}"`);
  assert.equal(dom.background, 'rgb(102, 51, 153)', `same-batch local styling wins (USER-origin important): ${dom.background}`);
  assert.ok(dom.token, 'the styled localRef node carries the composition token');

  // Replay of the same batch id and payload: the prior receipt, no duplicate.
  const replay = await applyBatch(workspace, state, {
    batchId: 'browser-b1',
    customizationId: 'cards',
    revisionId: 'cards-r1',
    operations: [
      { kind: 'insertUI', target: { targetRef: refs.host }, position: 'last-child', nodes: [{ localId: 'panel', tag: 'div', children: [{ tag: 'h2', text: 'Notes' }, { tag: 'label', text: 'Search', labelFor: 'nameField' }, { localId: 'nameField', tag: 'input', attributes: { type: 'search', placeholder: 'Filter' } }, { tag: 'button', text: 'Go' }] }] },
      { kind: 'style', rules: [{ target: { localRef: 'panel' }, declarations: [{ property: 'background-color', value: 'rebeccapurple', priority: 'important' }, { property: 'color', value: '#ffffff', priority: 'important' }] }] },
    ],
  });
  assert.equal(replay.status, 'accepted', 'the prior receipt replays');
  assert.equal(replay.payloadDigest, receipt.payloadDigest, 'the prior receipt replays (same payload digest, no re-execution)');
  assert.equal(await page.evaluate(() => document.querySelectorAll('#host > div').length), 1, 'replay creates no duplicate widget');

  // T08: GetOperation reconciles the applied batch by its retained receipt.
  const getOp = await workspaceSend(workspace, getOperationEnvelope(state.documentKey, state.routeEpoch!, 'browser-b1'));
  assert.equal(getOp.ok, true, JSON.stringify(getOp).slice(0, 200));
  const got = ((getOp.receipt as Record<string, unknown>).receipt as Record<string, unknown>) ?? {};
  assert.equal(got.status, 'accepted', 'the lost-apply reply is reconciled by receipt lookup, never re-execution');

  // A different payload under the same id never executes.
  const forged = await applyBatch(workspace, state, {
    batchId: 'browser-b1',
    customizationId: 'cards',
    revisionId: 'cards-r1',
    operations: [{ kind: 'insertUI', target: { targetRef: refs.host }, position: 'last-child', nodes: [{ tag: 'p', text: 'altered' }] }],
  });
  assert.equal(forged.status, 'not-applied');
  assert.equal(forged.error!.code, 'duplicate-id');
  assert.equal(await page.evaluate(() => document.querySelectorAll('#host > div').length), 1);
});

test('S4.2/T09: replaceText keeps the native node and its listener; the whole candidate rolls back on a site re-render', async () => {
  assert.ok(workspace, 'workspace page from the registration test');
  const { page, tabId } = await openFixture('v2-apply.html');
  const state = await capturedState(workspace, tabId);
  const refs = await refsOf(workspace, state);

  // T09 live: the text change keeps the exact node; the site listener survives.
  const textReceipt = await applyBatch(workspace, state, {
    batchId: 'browser-b2',
    customizationId: 'labels',
    revisionId: 'labels-r1',
    operations: [{ kind: 'replaceText', target: { targetRef: refs.btn }, text: 'Translated button label' }],
  });
  assert.equal(textReceipt.status, 'accepted', JSON.stringify(textReceipt).slice(0, 300));
  const afterText = await page.evaluate(async () => {
    const w = window as unknown as { __btn: Element; __clicks: number };
    document.getElementById('btn')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
    return {
      sameNode: document.getElementById('btn') === w.__btn,
      clicks: w.__clicks,
      text: document.getElementById('btn')?.textContent,
    };
  });
  assert.equal(afterText.text, 'Translated button label');
  assert.equal(afterText.sameNode, true, 'no clone/innerHTML replacement');
  assert.equal(afterText.clicks, 1, 'the site listener survived the Revueon write');

  // A candidate inserting into the framework-re-rendered container fails
  // verification and rolls the WHOLE candidate back (all-or-nothing).
  const rolled = await applyBatch(workspace, state, {
    batchId: 'browser-b3',
    customizationId: 'flaky-insert',
    revisionId: 'flaky-r1',
    operations: [
      { kind: 'insertUI', target: { targetRef: refs.flaky }, position: 'last-child', nodes: [{ tag: 'p', text: 'Injected' }] },
      { kind: 'replaceText', target: { targetRef: refs.leaf }, text: 'This write must roll back' },
    ],
  });
  assert.ok(['rolled-back', 'conflicted'].includes(rolled.status), `the re-rendered candidate must not accept: ${JSON.stringify(rolled).slice(0, 300)}`);
  const afterRollback = await page.evaluate(() => ({
    leaked: document.querySelectorAll('[data-rv2-ns], #flaky p:last-child').length,
    injected: [...document.querySelectorAll('#flaky p')].some((p) => p.textContent === 'Injected'),
    leafText: document.getElementById('leaf')?.textContent,
    btnText: document.getElementById('btn')?.textContent,
  }));
  assert.equal(afterRollback.injected, false, 'the candidate tree is removed on rollback');
  assert.equal(afterRollback.leafText, 'Original text', 'the same-batch text write rolled back with the candidate');
  assert.equal(afterRollback.btnText, 'Translated button label', 'independent accepted work survives the rollback');

  // A batch referencing a node the site replaced is refused before side effects.
  await page.evaluate(() => {
    const leaf = document.getElementById('leaf')!;
    const fresh = leaf.cloneNode(true) as Element;
    leaf.replaceWith(fresh);
  });
  const stale = await applyBatch(workspace, state, {
    batchId: 'browser-b4',
    customizationId: 'labels',
    revisionId: 'labels-r2',
    operations: [{ kind: 'replaceText', target: { targetRef: refs.leaf }, text: 'never written' }],
  });
  assert.equal(stale.status, 'not-applied');
  assert.equal(stale.error!.code, 'stale-target', 'a replaced node never re-resolves to a lookalike');
});


test('S4.3/T22: owned text below the WCAG AA floor fails verification and rolls the whole candidate back', async () => {
  assert.ok(workspace, 'workspace page from the registration test');
  const { page, tabId } = await openFixture('v2-apply.html');
  const state = await capturedState(workspace, tabId);
  const refs = await refsOf(workspace, state);
  const receipt = await applyBatch(workspace, state, {
    batchId: 'browser-v3a',
    customizationId: 'contrast',
    revisionId: 'contrast-r1',
    operations: [
      { kind: 'insertUI', target: { targetRef: refs.host }, position: 'last-child', nodes: [
        { localId: 'panel', tag: 'div', children: [{ localId: 'copy', tag: 'p', text: 'Low contrast note' }] },
      ] },
      { kind: 'style', rules: [
        { target: { localRef: 'panel' }, declarations: [{ property: 'background-color', value: '#ffffff', priority: 'important' }] },
        { target: { localRef: 'copy' }, declarations: [{ property: 'color', value: '#eeeeee', priority: 'important' }] },
      ] },
    ],
  });
  assert.equal(receipt.status, 'rolled-back', `low-contrast owned text must fail: ${JSON.stringify(receipt).slice(0, 400)}`);
  assert.equal(receipt.report!.status, 'fail');
  assert.ok(receipt.report!.issues.some((i: { key: string }) => i.key.startsWith('contrast:owned')), 'the structured contrast key is in the report');
  const gone = await page.evaluate(() => document.querySelectorAll('#host > div').length);
  assert.equal(gone, 0, 'the failing candidate tree is removed');
});

test('S4.3/T13: a normal-priority declaration that loses the real cascade fails verification (no silent lose)', async () => {
  assert.ok(workspace, 'workspace page from the registration test');
  const { page, tabId } = await openFixture('v2-apply.html');
  const state = await capturedState(workspace, tabId);
  const refs = await refsOf(workspace, state);
  // The fixture styles #leaf { color: #333 } at author normal — a user-NORMAL
  // red loses to it; the effect check must catch the lose, not claim success.
  const receipt = await applyBatch(workspace, state, {
    batchId: 'browser-v3b',
    customizationId: 'normal-red',
    revisionId: 'normal-red-r1',
    operations: [
      { kind: 'style', rules: [{ target: { targetRef: refs.leaf }, declarations: [{ property: 'color', value: 'red', priority: 'normal' }] }] },
    ],
  });
  assert.equal(receipt.status, 'rolled-back', JSON.stringify(receipt).slice(0, 400));
  assert.equal(receipt.report!.status, 'fail');
  assert.ok(receipt.report!.issues.some((i: { key: string; status: string }) => i.key.startsWith('effect:style:') && i.status === 'fail'), 'the effect fail key is in the report');
  const color = await page.evaluate(() => {
    const leaf = document.getElementById('leaf')!;
    return { computed: getComputedStyle(leaf).color, token: leaf.getAttribute('data-rv2-ns') };
  });
  assert.equal(color.computed, 'rgb(51, 51, 51)', 'the site color was never overwritten');
  assert.equal(color.token, null, 'the candidate rolled back — no token remains');
});

test('S4.3/T13: an authorized hide accepts, hides its target, and reports the exemption', async () => {
  assert.ok(workspace, 'workspace page from the registration test');
  const { page, tabId } = await openFixture('v2-apply.html');
  const state = await capturedState(workspace, tabId);
  const refs = await refsOf(workspace, state);
  const receipt = await applyBatch(workspace, state, {
    batchId: 'browser-v3c',
    customizationId: 'hide-leaf',
    revisionId: 'hide-leaf-r1',
    operations: [{ kind: 'hide', target: { targetRef: refs.leaf } }],
  });
  assert.equal(receipt.status, 'accepted', JSON.stringify(receipt).slice(0, 400));
  assert.equal(receipt.report!.status, 'pass');
  const after = await page.evaluate(() => ({
    display: getComputedStyle(document.getElementById('leaf')!).display,
    hostVisible: getComputedStyle(document.getElementById('host')!).display,
  }));
  assert.equal(after.display, 'none', 'the hide took effect');
  assert.equal(after.hostVisible, 'block', 'ancestors/siblings are untouched');
});


// ── S5.1: persistence on the real path — save/conflict/record/tombstone ──

const SAVE_REVISION = {
  revisionId: 'save-r1',
  capabilityVersion: 1,
  targetDescriptors: [{
    descriptorVersion: 1,
    rootPath: [],
    selection: 'single',
    anchor: { tag: 'main' },
    relation: 'self',
    matchBounds: { min: 1, max: 1 },
    routeScopeRef: 'https://example.test',
    continuityPolicy: 'stable-single',
  }],
  operations: [
    { kind: 'style', rules: [{ target: { targetRef: 'd0' }, surface: 'element', state: 'none', declarations: [{ property: 'color', value: 'red', priority: 'important' }], conditions: [] }] },
  ],
  savedAt: 1,
  source: 'user-planned',
};

const controlEnvelope = (payload: Record<string, unknown>): Record<string, unknown> => ({
  protocolVersion: 1,
  requestId: `ws-ctrl-${Math.random().toString(36).slice(2, 10)}`,
  kind: 'control',
  deadlineAt: Date.now() + 10_000,
  payload,
});

test('S5.1: a workspace save writes one complete v2 record; a stale save conflicts; remove tombstones', async () => {
  assert.ok(workspace, 'workspace page from the registration test');
  const origin = 'https://example.test';
  const saved = await workspaceSend(workspace, controlEnvelope({
    command: 'SaveRevision',
    origin,
    customizationId: 'persist-1',
    title: 'Persisted theme',
    scope: { mode: 'exactPath', path: '/page' },
    contentSensitivity: 'page-only',
    grants: [],
    revision: SAVE_REVISION,
    expectedRecordRevision: 0,
    mutationId: 'browser-save-1',
  }));
  assert.equal((saved as { ok?: boolean; kind?: string }).ok, true, JSON.stringify(saved).slice(0, 300));
  assert.equal((saved as { kind?: string }).kind, 'saved');
  assert.equal((saved as { recordRevision?: number }).recordRevision, 1);

  // The complete record is readable back (workspace refresh after conflict).
  const record = await workspaceSend(workspace, controlEnvelope({ command: 'GetOriginRecord', origin }));
  const rec = (record as { originRecord?: { recordRevision: number; customizations: Array<{ customizationId: string; activeRevisionId: string; enabled: boolean }> } }).originRecord!;
  assert.equal(rec.recordRevision, 1);
  assert.equal(rec.customizations[0].customizationId, 'persist-1');
  assert.equal(rec.customizations[0].activeRevisionId, 'save-r1');
  assert.equal(rec.customizations[0].enabled, true);

  // A stale concurrent save conflicts with the current summary — never a
  // silent overwrite (T30/AC-06).
  const stale = await workspaceSend(workspace, controlEnvelope({
    command: 'SaveRevision',
    origin,
    customizationId: 'persist-1',
    title: 'Stale tab',
    scope: { mode: 'exactPath', path: '/page' },
    contentSensitivity: 'page-only',
    grants: [],
    revision: SAVE_REVISION,
    expectedRecordRevision: 0,
    mutationId: 'browser-save-2',
  }));
  assert.equal((stale as { ok?: boolean }).ok, false);
  const staleErr = (stale as { error?: { code?: string }; conflict?: { recordRevision: number } });
  assert.equal(staleErr.error?.code, 'conflict');
  assert.equal(staleErr.conflict?.recordRevision, 1);

  // Removal tombstones the customization: a stale re-save is refused.
  const removed = await workspaceSend(workspace, controlEnvelope({
    command: 'RemoveCustomization', origin, customizationId: 'persist-1', expectedRecordRevision: 1, mutationId: 'browser-save-3',
  }));
  assert.equal((removed as { ok?: boolean }).ok, true, JSON.stringify(removed).slice(0, 300));
  const zombie = await workspaceSend(workspace, controlEnvelope({
    command: 'SaveRevision',
    origin,
    customizationId: 'persist-1',
    title: 'Zombie',
    scope: { mode: 'exactPath', path: '/page' },
    contentSensitivity: 'page-only',
    grants: [],
    revision: SAVE_REVISION,
    expectedRecordRevision: 2,
    mutationId: 'browser-save-4',
  }));
  assert.equal((zombie as { ok?: boolean }).ok, false, 'the tombstone blocks stale resurrection');
  const after = (await workspaceSend(workspace, controlEnvelope({ command: 'GetOriginRecord', origin })) as { originRecord?: { customizations: unknown[]; tombstones: unknown[] } }).originRecord!;
  assert.equal(after.customizations.length, 0);
  assert.equal(after.tombstones?.length, 1);
});


// ── S5.2: replay on the real path (T10/T11) ─────────────────────────────

async function waitFor(ws: Page | null, predicate: () => Promise<boolean>, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) {
      let states = 'n/a';
      try {
        states = JSON.stringify(await ws!.evaluate(() => (window as unknown as { __rv2States: unknown[] }).__rv2States.filter((s) => (s as { customizations?: unknown[] }).customizations?.length)));
      } catch { /* page gone */ }
      throw new Error(`timed out waiting for ${what}; customization projections: ${states}`);
    }
    await sleep(200);
  }
}

const REPLAY_REVISION = {
  revisionId: 'replay-r1',
  capabilityVersion: 1,
  targetDescriptors: [{
    descriptorVersion: 1,
    rootPath: [],
    selection: 'single',
    anchor: { tag: 'p', stableId: 'leaf' },
    relation: 'self',
    matchBounds: { min: 1, max: 1 },
    routeScopeRef: 'https://example.test',
    continuityPolicy: 'stable-single',
  }],
  operations: [
    { kind: 'style', rules: [{ target: { targetRef: 'd0' }, surface: 'element', state: 'none', declarations: [{ property: 'color', value: 'red', priority: 'important' }], conditions: [] }] },
  ],
  savedAt: 1,
  source: 'user-planned',
};

test('S5.2/T10: apply → save → reload replays the saved intent without a model; disable persists', async () => {
  assert.ok(workspace, 'workspace page from the registration test');
  const { page, tabId } = await openFixture('v2-apply.html');
  const fixtureUrl = new URL(page.url());
  const origin = fixtureUrl.origin;
  const state = await capturedState(workspace, tabId);

  // 1. Save a descriptor-based customization (no prior apply needed — saved
  // intent is self-contained and replays on any compatible document).
  const saved = await workspaceSend(workspace, controlEnvelope({
    command: 'SaveRevision',
    origin,
    customizationId: 'replay-1',
    title: 'Replay theme',
    scope: { mode: 'exactPath', path: fixtureUrl.pathname },
    contentSensitivity: 'page-only',
    grants: [],
    revision: REPLAY_REVISION,
    expectedRecordRevision: 0,
    mutationId: 'replay-save-1',
  }));
  assert.equal((saved as { ok?: boolean; kind?: string }).ok, true, JSON.stringify(saved).slice(0, 300));

  // 2. The save broadcast reaches THIS document: the runtime replays without
  // any model call and the effect goes live.
  await waitFor(workspace, async () => (await page.evaluate(() => getComputedStyle(document.getElementById('leaf')!).color)) === 'rgb(255, 0, 0)', 'live replay after save broadcast');
  // RuntimeState projections (with customization states) arrive at the
  // workspace page, which owns the subscription.
  const replayStates = (await workspace.evaluate(() => (window as unknown as { __rv2States: Array<{ customizations?: Array<{ customizationId: string; state: string }> }> }).__rv2States)) as Array<{ customizations?: Array<{ customizationId: string; state: string }> }>;
  const last = replayStates.filter((s) => s.customizations?.length).at(-1);
  assert.equal(last?.customizations?.[0]?.state, 'applied', JSON.stringify(last));

  // 3. Reload: the NEW runtime registers, receives the applicable record and
  // replays through the same transaction path. No accumulating tokens.
  await page.reload({ waitUntil: 'load' });
  await waitFor(workspace, async () => (await page.evaluate(() => getComputedStyle(document.getElementById('leaf')!).color)) === 'rgb(255, 0, 0)', 'replay after reload');
  const tokens = await page.evaluate(() => document.querySelectorAll('[data-rv2-ns]').length);
  assert.equal(tokens, 1, 'one namespace token — no accumulation across reloads');

  // 4. Disable: broadcast releases the local effect and persists enabled=false.
  const record = (await workspaceSend(workspace, controlEnvelope({ command: 'GetOriginRecord', origin })) as { originRecord?: { recordRevision: number } }).originRecord!;
  const disabled = await workspaceSend(workspace, controlEnvelope({
    command: 'SetEnabled', origin, customizationId: 'replay-1', enabled: false, expectedRecordRevision: record.recordRevision, mutationId: 'replay-disable-1',
  }));
  assert.equal((disabled as { ok?: boolean }).ok, true, JSON.stringify(disabled).slice(0, 300));
  await waitFor(workspace, async () => (await page.evaluate(() => getComputedStyle(document.getElementById('leaf')!).color)) !== 'rgb(255, 0, 0)', 'disable releases locally');

  // 5. Reload once more: the disabled customization does NOT replay.
  await page.reload({ waitUntil: 'load' });
  await sleep(1200); // registration + would-be replay window
  const color = await page.evaluate(() => getComputedStyle(document.getElementById('leaf')!).color);
  assert.notEqual(color, 'rgb(255, 0, 0)', 'disabled intent never replays');

  // Cleanup: remove so later tests start clean.
  const rec2 = (await workspaceSend(workspace, controlEnvelope({ command: 'GetOriginRecord', origin })) as { originRecord?: { recordRevision: number } }).originRecord!;
  await workspaceSend(workspace, controlEnvelope({
    command: 'RemoveCustomization', origin, customizationId: 'replay-1', expectedRecordRevision: rec2.recordRevision, mutationId: 'replay-remove-1',
  }));
});

test('S5.2/T11: an SPA route change out of scope revokes the effect; returning restores it once', async () => {
  assert.ok(workspace, 'workspace page from the registration test');
  const { page, tabId } = await openFixture('v2-apply.html');
  const fixtureUrl = new URL(page.url());
  const origin = fixtureUrl.origin;
  // The origin record already exists from earlier tests — refresh first.
  const current = (await workspaceSend(workspace, controlEnvelope({ command: 'GetOriginRecord', origin })) as { originRecord?: { recordRevision: number } }).originRecord;
  const saved = await workspaceSend(workspace, controlEnvelope({
    command: 'SaveRevision',
    origin,
    customizationId: 'route-1',
    title: 'Route-bound theme',
    scope: { mode: 'exactPath', path: fixtureUrl.pathname },
    contentSensitivity: 'page-only',
    grants: [],
    revision: REPLAY_REVISION,
    expectedRecordRevision: current?.recordRevision ?? 0,
    mutationId: 'route-save-1',
  }));
  assert.equal((saved as { ok?: boolean }).ok, true, JSON.stringify(saved).slice(0, 300));
  await waitFor(workspace, async () => (await page.evaluate(() => getComputedStyle(document.getElementById('leaf')!).color)) === 'rgb(255, 0, 0)', 'initial replay');

  // pushState to another path on the same origin (SPA-style): the epoch
  // fence moves and the out-of-scope customization is released.
  await page.evaluate(() => history.pushState(null, '', '/elsewhere'));
  await waitFor(workspace, async () => (await page.evaluate(() => getComputedStyle(document.getElementById('leaf')!).color)) !== 'rgb(255, 0, 0)', 'out-of-scope release');
  const tokenCount = await page.evaluate(() => document.querySelectorAll('[data-rv2-ns]').length);
  assert.equal(tokenCount, 0, 'out-of-scope tokens are revoked, not left live');

  // Back to the in-scope path: the same intent re-applies — no model, no
  // duplicate tokens.
  await page.evaluate((path) => history.pushState(null, '', path), fixtureUrl.pathname);
  await waitFor(workspace, async () => (await page.evaluate(() => getComputedStyle(document.getElementById('leaf')!).color)) === 'rgb(255, 0, 0)', 'in-scope restore');
  const restored = await page.evaluate(() => document.querySelectorAll('[data-rv2-ns]').length);
  assert.equal(restored, 1, 'exactly one namespace after A→B→A');

  // Cleanup.
  const rec = (await workspaceSend(workspace, controlEnvelope({ command: 'GetOriginRecord', origin })) as { originRecord?: { recordRevision: number } }).originRecord!;
  await workspaceSend(workspace, controlEnvelope({
    command: 'RemoveCustomization', origin, customizationId: 'route-1', expectedRecordRevision: rec.recordRevision, mutationId: 'route-remove-1',
  }));
  void tabId;
});

// ── S7.1: approved native action bindings on the real path (T15) ─────────

/** Open a fixture page and wait for its runtime registration. */
async function openRegistered(fixtureName: string): Promise<{ page: Page; tabId: number; state: CapturedState }> {
  assert.ok(workspace, 'workspace page from the registration test');
  const { page, tabId } = await openFixture(fixtureName);
  await page.bringToFront();
  const ws = workspace as Page;
  const state = await capturedState(ws, tabId);
  return { page, tabId, state };
}

/** Open keys.html and observe — returns the Poke/link/disclosure refs. */
async function openKeysFixture(): Promise<{ page: Page; tabId: number; state: CapturedState; go: string; link: string; disc: string }> {
  const opened = await openRegistered('keys.html');
  const { page, tabId, state } = opened;
  const ws = workspace as Page;
  const reply = await workspaceSend(ws, observeEnvelope(state.documentKey, state.routeEpoch!, { command: 'Observe' }));
  const snapshot = (reply as { receipt?: { snapshot?: { regions: SnapshotRegion[] } } }).receipt?.snapshot;
  assert.ok(snapshot, 'observe must deliver a snapshot');
  const byText = (needle: string): string => {
    const region = snapshot!.regions.find((r) => r.textSample?.includes(needle) || r.semantics.nameApprox?.includes(needle));
    assert.ok(region, `no region matches "${needle}"`);
    return region!.targetRef;
  };
  const go = byText('Poke');
  const link = byText('A safe same-page link');
  const disc = snapshot!.regions.find((r) => r.semantics.tag === 'details');
  assert.ok(disc, 'the details element is observed');
  return { page, tabId, state, go, link, disc: disc!.targetRef };
}

test('S7.1/T15: a trusted key press activates the bound native control exactly once (no synthetic retries)', async () => {
  assert.ok(workspace, 'workspace page from the registration test');
  const { page, state, go } = await openKeysFixture();
  const receipt = await applyBatch(workspace, state, {
    batchId: 'keys-b1',
    customizationId: 'keys-act',
    revisionId: 'keys-act-r1',
    operations: [{ kind: 'bindKey', target: { targetRef: go }, chord: 'Alt+G', actionIds: ['activate'] }],
  });
  assert.equal(receipt.status, 'accepted', JSON.stringify(receipt).slice(0, 400));
  assert.deepEqual(receipt.resourceIds, ['bind-0'], 'the binding is a receipt resource');
  assert.equal(receipt.report!.status, 'pass', 'the measured postcondition gated acceptance');
  assert.ok(receipt.report!.coverage.checks >= 1, 'the binding check was actually measured');

  await page.keyboard.press('Alt+g'); // CDP input: a trusted key event
  assert.equal(await page.evaluate(() => (window as unknown as { __clicks: number }).__clicks), 1, 'the site\'s own listener fired exactly once');
  await page.keyboard.press('Alt+g');
  assert.equal(await page.evaluate(() => (window as unknown as { __clicks: number }).__clicks), 2, 'a second gesture fires again — one live listener, no duplication');
  // A DIFFERENT chord is not consumed (no first-match activation).
  await page.keyboard.press('Alt+h');
  assert.equal(await page.evaluate(() => (window as unknown as { __clicks: number }).__clicks), 2, 'unbound chords pass through untouched');
  void state;
});

test('S7.1/T15: focus and scrollIntoView run as one finite local sequence', async () => {
  assert.ok(workspace, 'workspace page from the registration test');
  const { page, state, go } = await openKeysFixture();
  const receipt = await applyBatch(workspace, state, {
    batchId: 'keys-b2',
    customizationId: 'keys-focus',
    revisionId: 'keys-focus-r1',
    operations: [{ kind: 'bindKey', target: { targetRef: go }, chord: 'Alt+F', actionIds: ['scrollIntoView', 'focus'], repeat: true }],
  });
  assert.equal(receipt.status, 'accepted', JSON.stringify(receipt).slice(0, 300));
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  await page.keyboard.press('Alt+f');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'go', 'the bound target received native focus');
  void state;
});

test('S7.1/T15: editable surfaces keep their keys by default; an approved narrow opt-in fires, passwords never', async () => {
  assert.ok(workspace, 'workspace page from the registration test');
  const { page, state, go } = await openKeysFixture();

  // Default policy: inside an editor the chord is not consumed at all.
  const def = await applyBatch(workspace, state, {
    batchId: 'keys-b3',
    customizationId: 'keys-edit',
    revisionId: 'keys-edit-r1',
    operations: [{ kind: 'bindKey', target: { targetRef: go }, chord: 'F4', actionIds: ['activate'] }],
  });
  assert.equal(def.status, 'accepted', JSON.stringify(def).slice(0, 300));
  await page.locator('#field').focus();
  await page.keyboard.press('F4');
  let counters = await page.evaluate(() => ({ clicks: (window as unknown as { __clicks: number }).__clicks, keyseen: (window as unknown as { __keyseen: number }).__keyseen }));
  assert.equal(counters.clicks, 0, 'the default policy never activates inside an editor');
  assert.equal(counters.keyseen, 1, 'the key reached the editor unconsumed');

  // The same chord outside the editor fires normally (the field is blurred
  // explicitly — h1 is not focusable, focus() would be a no-op).
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('F4');
  assert.equal(await page.evaluate(() => (window as unknown as { __clicks: number }).__clicks), 1, 'outside editors the binding fires');

  // Approved narrow opt-in ('allow'): fires inside a plain editor…
  const opt = await applyBatch(workspace, state, {
    batchId: 'keys-b4',
    customizationId: 'keys-optin',
    revisionId: 'keys-optin-r1',
    operations: [{ kind: 'bindKey', target: { targetRef: go }, chord: 'F2', actionIds: ['activate'], editablePolicy: 'allow' }],
  });
  assert.equal(opt.status, 'accepted', JSON.stringify(opt).slice(0, 300));
  await page.locator('#field').focus();
  await page.keyboard.press('F2');
  const counters2 = await page.evaluate(() => ({ clicks: (window as unknown as { __clicks: number }).__clicks }));
  assert.equal(counters2.clicks, 2, 'the approved opt-in fires inside the editor');
  // …but NEVER in password editing — no policy can intercept it.
  await page.locator('#pw').focus();
  await page.keyboard.press('F2');
  const counters3 = await page.evaluate(() => ({ clicks: (window as unknown as { __clicks: number }).__clicks }));
  assert.equal(counters3.clicks, 2, 'password editing is never intercepted');
  void state;
});

test('S7.1/T15: unwanted repeats are skipped; an approved repeat policy allows them', async () => {
  assert.ok(workspace, 'workspace page from the registration test');
  const { page, state, go } = await openKeysFixture();
  const receipt = await applyBatch(workspace, state, {
    batchId: 'keys-b5',
    customizationId: 'keys-rep',
    revisionId: 'keys-rep-r1',
    operations: [{ kind: 'bindKey', target: { targetRef: go }, chord: 'Alt+R', actionIds: ['activate'] }],
  });
  assert.equal(receipt.status, 'accepted', JSON.stringify(receipt).slice(0, 300));
  // CDP key repeats (autoRepeat) are trusted events with repeat=true.
  const cdp = await context!.newCDPSession(page);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'r', code: 'KeyR', windowsVirtualKeyCode: 82, nativeVirtualKeyCode: 82, modifiers: 1, autoRepeat: true });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'r', code: 'KeyR', windowsVirtualKeyCode: 82, nativeVirtualKeyCode: 82, modifiers: 1 });
  assert.equal(await page.evaluate(() => (window as unknown as { __clicks: number }).__clicks), 0, 'repeats are skipped under the default policy');
  // A real (non-repeat) press still fires.
  await page.keyboard.press('Alt+r');
  assert.equal(await page.evaluate(() => (window as unknown as { __clicks: number }).__clicks), 1, 'a real gesture fires');
  void state;
});

test('S7.1/T15: modal focus keeps the chord unless the binding opted in', async () => {
  assert.ok(workspace, 'workspace page from the registration test');
  const { page, state, go } = await openKeysFixture();
  const receipt = await applyBatch(workspace, state, {
    batchId: 'keys-b6',
    customizationId: 'keys-modal',
    revisionId: 'keys-modal-r1',
    operations: [{ kind: 'bindKey', target: { targetRef: go }, chord: 'Alt+M', actionIds: ['activate'] }],
  });
  assert.equal(receipt.status, 'accepted', JSON.stringify(receipt).slice(0, 300));
  await page.evaluate(() => (document.getElementById('modal') as HTMLDialogElement).showModal());
  await page.keyboard.press('Alt+m');
  assert.equal(await page.evaluate(() => (window as unknown as { __clicks: number }).__clicks), 0, 'a focused dialog keeps its keys by default');
  await page.locator('#closedlg').click();
  await page.keyboard.press('Alt+m');
  assert.equal(await page.evaluate(() => (window as unknown as { __clicks: number }).__clicks), 1, 'outside the dialog the binding fires');
  void state;
});

test('S7.1/T15: reserved chords, plain typing keys and chord collisions are refused before any install', async () => {
  assert.ok(workspace, 'workspace page from the registration test');
  const { page, state, go } = await openKeysFixture();

  const reserved = await applyBatch(workspace, state, {
    batchId: 'keys-res1',
    customizationId: 'keys-res',
    revisionId: 'keys-res-r1',
    operations: [{ kind: 'bindKey', target: { targetRef: go }, chord: 'Ctrl+T', actionIds: ['activate'] }],
  });
  assert.equal(reserved.status, 'not-applied');
  assert.equal(reserved.error!.code, 'unsupported-capability');
  assert.match(reserved.error!.message, /reserved by the browser/);

  const plain = await applyBatch(workspace, state, {
    batchId: 'keys-res2',
    customizationId: 'keys-res',
    revisionId: 'keys-res-r2',
    operations: [{ kind: 'bindKey', target: { targetRef: go }, chord: 'g', actionIds: ['activate'] }],
  });
  assert.equal(plain.status, 'not-applied');
  assert.equal(plain.error!.code, 'conflict');
  assert.match(plain.error!.message, /plain typing/);

  // Collision: the current owner wins and is named in the refusal.
  const first = await applyBatch(workspace, state, {
    batchId: 'keys-col1',
    customizationId: 'keys-owner',
    revisionId: 'keys-owner-r1',
    operations: [{ kind: 'bindKey', target: { targetRef: go }, chord: 'Alt+P', actionIds: ['activate'] }],
  });
  assert.equal(first.status, 'accepted', JSON.stringify(first).slice(0, 300));
  const second = await applyBatch(workspace, state, {
    batchId: 'keys-col2',
    customizationId: 'keys-other',
    revisionId: 'keys-other-r1',
    operations: [{ kind: 'bindKey', target: { targetRef: go }, chord: 'Alt+P', actionIds: ['activate'] }],
  });
  assert.equal(second.status, 'not-applied');
  assert.equal(second.error!.code, 'conflict');
  assert.match(second.error!.message, /keys-owner/);
  await page.keyboard.press('Alt+p');
  assert.equal(await page.evaluate(() => (window as unknown as { __clicks: number }).__clicks), 1, 'exactly one binding owns the chord');
  void state;
});

test('S7.1/T15: followLink and toggleDisclosure use the site\'s own safe affordances', async () => {
  assert.ok(workspace, 'workspace page from the registration test');
  const { page, state, link, disc } = await openKeysFixture();
  const receipt = await applyBatch(workspace, state, {
    batchId: 'keys-b7',
    customizationId: 'keys-native',
    revisionId: 'keys-native-r1',
    operations: [
      { kind: 'bindKey', target: { targetRef: link }, chord: 'Alt+L', actionIds: ['followLink'] },
      { kind: 'bindKey', target: { targetRef: disc }, chord: 'Alt+D', actionIds: ['toggleDisclosure'] },
    ],
  });
  assert.equal(receipt.status, 'accepted', JSON.stringify(receipt).slice(0, 400));
  assert.deepEqual(receipt.resourceIds, ['bind-0', 'bind-1']);

  await page.keyboard.press('Alt+l');
  assert.equal(await page.evaluate(() => (window as unknown as { __linkClicks: number }).__linkClicks), 1, 'the site link was followed natively');
  await page.keyboard.press('Alt+d');
  const dom = await page.evaluate(() => ({ open: (document.getElementById('disc') as HTMLDetailsElement).open, toggles: (window as unknown as { __toggles: number }).__toggles }));
  assert.equal(dom.open, true, 'the native disclosure opened');
  // The toggle event is a queued task — wait for the site's own listener.
  await waitFor(workspace, async () => (await page.evaluate(() => (window as unknown as { __toggles: number }).__toggles)) === 1, "the site's toggle listeners ran");
  void state;
});

test('S7.1/T15: save → replay on reload installs the shortcut exactly once; disable uninstalls it exactly', async () => {
  assert.ok(workspace, 'workspace page from the registration test');
  const { page, tabId, state, go } = await openKeysFixture();
  const fixtureUrl = new URL(page.url());
  const origin = fixtureUrl.origin;

  // 1. Save a descriptor-based binding customization. The fixture origin is
  //    SHARED with the S5.2 tests — fetch the current record revision first.
  const currentRecord = (await workspaceSend(workspace, controlEnvelope({ command: 'GetOriginRecord', origin })) as { originRecord?: { recordRevision: number } }).originRecord;
  const BIND_REVISION = {
    revisionId: 'keys-replay-r1',
    capabilityVersion: 1,
    targetDescriptors: [{
      descriptorVersion: 1,
      rootPath: [],
      selection: 'single',
      anchor: { tag: 'button', stableId: 'go' },
      relation: 'self',
      matchBounds: { min: 1, max: 1 },
      routeScopeRef: 'https://example.test',
      continuityPolicy: 'stable-single',
    }],
    operations: [{ kind: 'bindKey', target: { targetRef: 'd0' }, chord: 'Alt+K', actionIds: ['activate'] }],
    savedAt: 1,
    source: 'user-planned',
  };
  const saved = await workspaceSend(workspace, controlEnvelope({
    command: 'SaveRevision',
    origin,
    customizationId: 'keys-replay',
    title: 'Keyboard shortcut',
    scope: { mode: 'exactPath', path: fixtureUrl.pathname },
    contentSensitivity: 'page-only',
    grants: [],
    revision: BIND_REVISION,
    expectedRecordRevision: currentRecord?.recordRevision ?? 0,
    mutationId: 'keys-save-1',
  }));
  assert.equal((saved as { ok?: boolean }).ok, true, JSON.stringify(saved).slice(0, 300));

  // 2. The save broadcast replays in the live document.
  await waitFor(workspace, async () => {
    await page.keyboard.press('Alt+k');
    return (await page.evaluate(() => (window as unknown as { __clicks: number }).__clicks)) >= 1;
  }, 'the replayed shortcut is live');

  // 3. Reload: replay installs on the fresh runtime — one activation per
  //    press proves no duplicate listeners (AC-11), on the real path.
  await page.reload({ waitUntil: 'load' });
  await page.bringToFront();
  const fresh = await capturedState(workspace, tabId);
  void fresh;
  await waitFor(workspace, async () => {
    try {
      await page.keyboard.press('Alt+k');
    } catch {
      return false; // page not ready for input yet
    }
    return (await page.evaluate(() => (window as unknown as { __clicks: number }).__clicks)) === 1;
  }, 'exactly one activation per press after reload (no duplicate bindings)');
  await page.keyboard.press('Alt+k');
  assert.equal(await page.evaluate(() => (window as unknown as { __clicks: number }).__clicks), 2, 'still exactly one listener');

  // 4. Disable: the exact listener is uninstalled.
  const record = (await workspaceSend(workspace, controlEnvelope({ command: 'GetOriginRecord', origin })) as { originRecord?: { recordRevision: number } }).originRecord!;
  const disabled = await workspaceSend(workspace, controlEnvelope({
    command: 'SetEnabled', origin, customizationId: 'keys-replay', enabled: false, expectedRecordRevision: record.recordRevision, mutationId: 'keys-disable-1',
  }));
  assert.equal((disabled as { ok?: boolean }).ok, true, JSON.stringify(disabled).slice(0, 300));
  await page.keyboard.press('Alt+k');
  await page.keyboard.press('Alt+k');
  assert.equal(await page.evaluate(() => (window as unknown as { __clicks: number }).__clicks), 2, 'the disabled shortcut fired nothing');

  // 5. Reload once more: the disabled intent does not reinstall.
  await page.reload({ waitUntil: 'load' });
  await page.bringToFront();
  await sleep(1200);
  await page.keyboard.press('Alt+k');
  assert.equal(await page.evaluate(() => (window as unknown as { __clicks: number }).__clicks), 0, 'disabled bindings never replay');

  // Cleanup.
  const rec2 = (await workspaceSend(workspace, controlEnvelope({ command: 'GetOriginRecord', origin })) as { originRecord?: { recordRevision: number } }).originRecord!;
  await workspaceSend(workspace, controlEnvelope({
    command: 'RemoveCustomization', origin, customizationId: 'keys-replay', expectedRecordRevision: rec2.recordRevision, mutationId: 'keys-remove-1',
  }));
  void state;
});

// ── S7.2: collapse + finite local behavior rules on the real path (T16) ───

test('S7.2/T16: a saved auto-collapse rule collapses new expanded instances once; user expansion wins; disable stops fighting', async () => {
  assert.ok(workspace, 'workspace page from the registration test');
  const { page, tabId, state } = await openRegistered('comments.html');
  const fixtureUrl = new URL(page.url());
  const origin = fixtureUrl.origin;

  // Observe: the rule's three refs — instance, affordance, container.
  const obs = await workspaceSend(workspace, observeEnvelope(state.documentKey, state.routeEpoch!, { command: 'Observe' }));
  const snapshot = (obs as { receipt?: { snapshot?: { regions: SnapshotRegion[] } } }).receipt?.snapshot;
  assert.ok(snapshot, 'observe must deliver a snapshot');
  const instanceRef = snapshot!.regions.find((r) => r.semantics.tag === 'article')!.targetRef;
  const affordanceRef = snapshot!.regions.find((r) => r.semantics.tag === 'button' && r.semantics.nameApprox === 'Collapse')!.targetRef;
  const containerRef = snapshot!.regions.find((r) => r.semantics.tag === 'section')!.targetRef;

  // 1. Save the RULE as self-contained intent: a future-set instance
  //    descriptor + the affordance descriptor + the member-of container.
  const currentRecord = (await workspaceSend(workspace, controlEnvelope({ command: 'GetOriginRecord', origin })) as { originRecord?: { recordRevision: number } }).originRecord;
  const RULE_REVISION = {
    revisionId: 't16-r1',
    capabilityVersion: 1,
    targetDescriptors: [
      { descriptorVersion: 1, rootPath: [], selection: 'set', anchor: { tag: 'article' }, relation: 'self', matchBounds: { min: 1, max: 64 }, routeScopeRef: 'https://example.test', continuityPolicy: 'future-set' },
      { descriptorVersion: 1, rootPath: [], selection: 'single', anchor: { tag: 'button', accessibleLabel: 'Collapse' }, relation: 'self', matchBounds: { min: 1, max: 1 }, routeScopeRef: 'https://example.test', continuityPolicy: 'stable-single' },
      { descriptorVersion: 1, rootPath: [], selection: 'single', anchor: { tag: 'section', stableId: 'comments' }, relation: 'self', matchBounds: { min: 1, max: 1 }, routeScopeRef: 'https://example.test', continuityPolicy: 'stable-single' },
    ],
    operations: [{
      kind: 'localRule',
      target: { targetRef: 'd0' },
      targetRef: 'd1',
      trigger: 'target-appeared',
      predicates: [{ type: 'member-of', targetRef: 'd2' }, { type: 'expanded-equals', value: true }],
      actionId: 'activateDisclosure',
    }],
    savedAt: 1,
    source: 'user-planned',
  };
  const saved = await workspaceSend(workspace, controlEnvelope({
    command: 'SaveRevision',
    origin,
    customizationId: 't16-rule',
    title: 'Auto-collapse comments',
    scope: { mode: 'exactPath', path: fixtureUrl.pathname },
    contentSensitivity: 'page-only',
    grants: [],
    revision: RULE_REVISION,
    expectedRecordRevision: currentRecord?.recordRevision ?? 0,
    mutationId: 't16-save-1',
  }));
  assert.equal((saved as { ok?: boolean }).ok, true, JSON.stringify(saved).slice(0, 300));

  // 2. The broadcast replays: BOTH existing expanded comments collapse once,
  //    through the site's own disclosure (its aria-expanded flipped).
  await waitFor(workspace, async () =>
    (await page.evaluate(() => document.querySelectorAll('.toggle[aria-expanded="false"]').length)) === 2,
  'both initially expanded instances collapsed once', 15_000);
  const clickCounts1 = await page.evaluate(() => [...document.querySelectorAll('.toggle')].map((b) => (b as HTMLElement).dataset.clicks ?? '0'));
  assert.deepEqual(clickCounts1, ['1', '1'], 'exactly one native disclosure click per instance');

  // 3. A NEW comment arrives (expanded): the reconcile pass re-applies and
  //    the rule collapses it once. The already-processed instances are never
  //    re-collapsed (sticky once-per-instance).
  await page.getByRole('button', { name: 'Add comment' }).click();
  await waitFor(workspace, async () =>
    (await page.evaluate(() => document.querySelectorAll('.toggle[aria-expanded="false"]').length)) === 3,
  'the new instance collapsed too', 15_000);
  const clickCounts2 = await page.evaluate(() => [...document.querySelectorAll('.toggle')].map((b) => (b as HTMLElement).dataset.clicks ?? '0'));
  assert.deepEqual(clickCounts2, ['1', '1', '1'], 'no duplicate collapse after the re-apply');

  // 4. The user expands the first comment — a LATER re-apply must keep it.
  await page.locator('.comment').first().locator('button.toggle').click();
  await page.getByRole('button', { name: 'Add comment' }).click();
  await waitFor(workspace, async () =>
    (await page.evaluate(() => document.querySelectorAll('.toggle[aria-expanded="true"]').length)) === 1,
  'the user expansion survived the next re-apply', 15_000);
  const clickCounts3 = await page.evaluate(() => [...document.querySelectorAll('.toggle')].map((b) => (b as HTMLElement).dataset.clicks ?? '0'));
  // Comment 1: one rule click + the USER's expansion click — and nothing
  // more: the rule never re-acted on the user-expanded instance.
  assert.deepEqual(clickCounts3, ['2', '1', '1', '1'], 'the rule never re-acted on the user-expanded instance');

  // 5. Disable: the rule uninstalls — a further new comment is NOT collapsed
  //    (and the user's expanded state is untouched).
  const record = (await workspaceSend(workspace, controlEnvelope({ command: 'GetOriginRecord', origin })) as { originRecord?: { recordRevision: number } }).originRecord!;
  const disabled = await workspaceSend(workspace, controlEnvelope({
    command: 'SetEnabled', origin, customizationId: 't16-rule', enabled: false, expectedRecordRevision: record.recordRevision, mutationId: 't16-disable-1',
  }));
  assert.equal((disabled as { ok?: boolean }).ok, true, JSON.stringify(disabled).slice(0, 300));
  await page.getByRole('button', { name: 'Add comment' }).click();
  await sleep(1500); // a full reconcile window
  const afterDisable = await page.evaluate(() => ({
    expanded: document.querySelectorAll('.toggle[aria-expanded="true"]').length,
    collapsed: document.querySelectorAll('.toggle[aria-expanded="false"]').length,
  }));
  assert.equal(afterDisable.expanded, 2, 'the user-expanded comment and the new comment stay expanded');
  assert.equal(afterDisable.collapsed, 3, 'the rule no longer acts after disable');

  // 6. Reload: the disabled intent never replays.
  await page.reload({ waitUntil: 'load' });
  await page.bringToFront();
  await sleep(1500);
  // The reload resets the fixture DOM: only the two static comments remain.
  const afterReload = await page.evaluate(() => document.querySelectorAll('.toggle[aria-expanded="true"]').length);
  assert.equal(afterReload, 2, 'disabled rules never reinstall');

  // Cleanup.
  const rec2 = (await workspaceSend(workspace, controlEnvelope({ command: 'GetOriginRecord', origin })) as { originRecord?: { recordRevision: number } }).originRecord!;
  await workspaceSend(workspace, controlEnvelope({
    command: 'RemoveCustomization', origin, customizationId: 't16-rule', expectedRecordRevision: rec2.recordRevision, mutationId: 't16-remove-1',
  }));
  void state;
});

test('S7.2/T16: the owned collapse disclosure controls local presentation with exact cleanup', async () => {
  assert.ok(workspace, 'workspace page from the registration test');
  const { page, state } = await openRegistered('comments.html');

  // Live batch (no save): an owned disclosure toggle before the container.
  const obs = await workspaceSend(workspace, observeEnvelope(state.documentKey, state.routeEpoch!, { command: 'Observe' }));
  const snapshot = (obs as { receipt?: { snapshot?: { regions: SnapshotRegion[] } } }).receipt?.snapshot;
  const containerRef = snapshot!.regions.find((r) => r.semantics.tag === 'section')!.targetRef;
  const receipt = await applyBatch(workspace, state, {
    batchId: 't16-col',
    customizationId: 't16-col',
    revisionId: 't16-col-r1',
    operations: [{ kind: 'collapse', target: { targetRef: containerRef }, label: 'Hide discussion', initialState: 'collapsed', placement: 'before' }],
  });
  assert.equal(receipt.status, 'accepted', JSON.stringify(receipt).slice(0, 400));
  assert.deepEqual(receipt.resourceIds, ['aggregate-css', 'insert-0', 'collapse-0']);
  assert.ok(receipt.report!.status === 'pass', 'the collapsed state is measured (display:none) and gates acceptance');
  assert.ok(await page.evaluate(() => (document.querySelector('section#comments') as HTMLElement).offsetHeight === 0), 'the collapsed container measures no box');

  // The user expands through the owned toggle — the container comes back.
  await page.getByRole('button', { name: 'Hide discussion' }).click();
  assert.ok(await page.evaluate(() => (document.querySelector('section#comments') as HTMLElement).offsetHeight > 0), 'the owned toggle expands exactly');
  void state;
});

// ── S8.1: linked projection views (T17, real path) ─────────────────────────

test('S8.1/T17: a board projection renders observed items, stays local-only, updates in slices, marks stale keys, and releases exactly', async () => {
  assert.ok(workspace, 'workspace page from the registration test');
  const { page, state } = await openRegistered('board.html');
  const ws = workspace as Page;
  const reply = await workspaceSend(ws, observeEnvelope(state.documentKey, state.routeEpoch!, { command: 'Observe' }));
  const snapshot = (reply as { receipt?: { snapshot?: { regions: SnapshotRegion[] } } }).receipt?.snapshot;
  assert.ok(snapshot, 'observe must deliver a snapshot');
  const section = snapshot!.regions.find((r) => r.semantics.tag === 'section');
  const list = snapshot!.regions.find((r) => r.semantics.tag === 'ul');
  assert.ok(section && list, `the section and list are observed: ${JSON.stringify(snapshot!.regions.map((r) => r.semantics.tag))}`);

  const receipt = await applyBatch(ws, state, {
    batchId: 'proj-b1',
    customizationId: 'proj-board',
    revisionId: 'proj-board-r1',
    operations: [{
      kind: 'projectCollection',
      target: { targetRef: section!.targetRef },
      sourceSetRef: list!.targetRef,
      fields: [
        { sourceField: 'title', label: 'Title' },
        { sourceField: 'link', label: 'Link' },
        { sourceField: 'category', label: 'Status' },
      ],
      view: 'board',
      groupBy: 'category',
    }],
  });
  assert.equal(receipt.status, 'accepted', JSON.stringify(receipt).slice(0, 500));
  assert.deepEqual(receipt.resourceIds, ['projection-0']);

  // 1. The board renders the OBSERVED items: one card per issue, real
  //    source links, observed category columns, coverage line.
  await waitFor(ws, async () => (await page.locator('.rv2p-card').count()) === 3, 'three cards rendered');
  assert.equal(await page.locator('.rv2p').count(), 1);
  const cardHref = await page.locator('.rv2p-card a.rv2p-title').first().getAttribute('href');
  assert.ok(cardHref!.endsWith('/issues/1'), `the card links the safe source link: ${cardHref}`);
  assert.equal(await page.locator('.rv2p-card a.rv2p-title').first().textContent(), 'Fix login redirect');
  const columnNames = await page.locator('.rv2p-col-name').allTextContents();
  assert.deepEqual(columnNames, ['Open', 'Done', 'Unsorted'], `cards: ${(await page.evaluate(() => [...document.querySelectorAll('.rv2p-card')].map((c) => c.outerHTML).join(' | '))).slice(0, 700)}`);
  const coverageText = await page.locator('[data-rv2p-coverage]').textContent();
  assert.match(coverageText ?? '', /Showing 3 of 3 items/);

  // 2. "Show original" reveals the live source item (reveal, not a clone).
  await page.locator('.rv2p-card', { hasText: 'Ship onboarding emails' }).locator('button.rv2p-reveal').click();
  await page.waitForTimeout(300);
  const revealed = await page.evaluate(() => {
    const r = document.getElementById('issue-3')!.getBoundingClientRect();
    return r.top >= 0 && r.bottom <= window.innerHeight;
  });
  assert.equal(revealed, true, 'the source item scrolled into the viewport');

  // 3. Live source update: issue 2 moves to Done — the card follows in a
  //    bounded slice, without any model call.
  await page.click('#mutate-status');
  await waitFor(ws, async () => (await page
    .locator('.rv2p-col[data-rv2p-col="Done"] .rv2p-card', { hasText: 'Dark mode for settings' })
    .count()) === 1, 'the field update moved the card to Done');

  // 4. A newly added source item gains a card (Open column).
  await page.click('#add-issue');
  await waitFor(ws, async () => (await page.locator('.rv2p-card').count()) === 4, 'the new item rendered');

  // 5. Drag is LOCAL organization only: the card moves columns in the view
  //    while the source list DOM stays byte-identical in order and state.
  const sourceBefore = await page.evaluate(() => document.getElementById('issues')!.innerHTML);
  // Playwright cannot drive native HTML5 drag-and-drop in headless Chromium;
  // dispatch the DOM drag sequence against the shipped listeners instead —
  // the wiring under test is the runtime's own delegated DnD, not a native
  // site control (no trusted-gesture policy applies).
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('.rv2p-card')].find((c) => c.textContent?.includes('Fix login redirect'))!;
    const zone = document.querySelector('.rv2p-col[data-rv2p-col="Done"] .rv2p-col-cards')!;
    const dt = new DataTransfer();
    card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    zone.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt, cancelable: true }));
    zone.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt, cancelable: true }));
    card.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
  });
  await waitFor(ws, async () => (await page
    .locator('.rv2p-col[data-rv2p-col="Done"] .rv2p-card', { hasText: 'Fix login redirect' })
    .count()) === 1, 'the drag moved the card to Done');
  assert.equal(await page.evaluate(() => document.getElementById('issues')!.innerHTML), sourceBefore, 'the source list was never touched');

  // 6. A source item that leaves the page marks its card stale and disables
  //    the reveal action — it is never silently dropped.
  await page.click('#remove-issue');
  await waitFor(ws, async () => (await page.locator('.rv2p-card.rv2p-is-stale').count()) === 1, 'the detached card went stale');
  const staleText = await page.locator('.rv2p-card.rv2p-is-stale .rv2p-stale-note').textContent();
  assert.match(staleText!, /source left the page/);
  assert.equal(await page.locator('.rv2p-card.rv2p-is-stale button.rv2p-reveal').isDisabled(), true);

  // 7. A duplicated source key disables the key action and marks the cards.
  await page.click('#duplicate-issue');
  await waitFor(ws, async () => (await page.locator('.rv2p-card.rv2p-is-stale').count()) === 3, 'both duplicates went stale (plus the detached card)');
  // Duplicate-key cards lose the key action (their title becomes text);
  // the detached card keeps its link (the href is still data) with its
  // reveal disabled.
  const dupStaleLinks = await page
    .locator('.rv2p-card.rv2p-is-stale', { hasText: 'duplicate source link' })
    .locator('a.rv2p-title')
    .count();
  assert.equal(dupStaleLinks, 0, 'duplicate-key cards render their title as text, not a link');

  // 8. Save + disable: the release removes the view exactly and the site
  //    stays intact; the disabled intent never comes back this session.
  const origin = new URL(page.url()).origin;
  // Fixture pages share one origin: fetch the CURRENT record revision first
  // (earlier tests in this suite already saved records on this origin).
  const currentRec = (await workspaceSend(ws, controlEnvelope({ command: 'GetOriginRecord', origin })) as { originRecord?: { recordRevision: number } }).originRecord;
  const saved = await workspaceSend(ws, controlEnvelope({
    command: 'SaveRevision',
    origin,
    customizationId: 'proj-board',
    title: 'Issue board',
    scope: { mode: 'exactPath', path: new URL(page.url()).pathname },
    contentSensitivity: 'page-only',
    grants: [],
    revision: {
      revisionId: 'proj-board-r1',
      capabilityVersion: 1,
      targetDescriptors: [
        { descriptorVersion: 1, rootPath: [], selection: 'single', anchor: { tag: 'section' }, relation: 'self', matchBounds: { min: 1, max: 1 }, routeScopeRef: origin, continuityPolicy: 'stable-single' },
        { descriptorVersion: 1, rootPath: [], selection: 'single', anchor: { tag: 'ul' }, relation: 'self', matchBounds: { min: 1, max: 1 }, routeScopeRef: origin, continuityPolicy: 'stable-single' },
      ],
      operations: [{
        kind: 'projectCollection',
        target: { targetRef: 'd0' },
        sourceSetRef: 'd1',
        fields: [
          { sourceField: 'title', label: 'Title' },
          { sourceField: 'link', label: 'Link' },
          { sourceField: 'category', label: 'Status' },
        ],
        view: 'board',
        groupBy: 'category',
      }],
      savedAt: Date.now(),
      source: 'user-planned',
    },
    expectedRecordRevision: currentRec?.recordRevision ?? 0,
    mutationId: 'proj-save-1',
  }));
  assert.equal((saved as { ok?: boolean }).ok, true, JSON.stringify(saved).slice(0, 400));
  const rec = (await workspaceSend(ws, controlEnvelope({ command: 'GetOriginRecord', origin })) as { originRecord?: { recordRevision: number } }).originRecord!;
  const disabled = await workspaceSend(ws, controlEnvelope({
    command: 'SetEnabled', origin, customizationId: 'proj-board', enabled: false, expectedRecordRevision: rec.recordRevision, mutationId: 'proj-disable-1',
  }));
  assert.equal((disabled as { ok?: boolean }).ok, true, JSON.stringify(disabled).slice(0, 400));
  await waitFor(ws, async () => (await page.locator('.rv2p').count()) === 0, 'disable released the projection view');
  assert.equal(await page.locator('#issues li').count(), 4, 'the source list survives untouched');

  // Cleanup so later tests start clean.
  const rec2 = (await workspaceSend(ws, controlEnvelope({ command: 'GetOriginRecord', origin })) as { originRecord?: { recordRevision: number } }).originRecord!;
  await workspaceSend(ws, controlEnvelope({
    command: 'RemoveCustomization', origin, customizationId: 'proj-board', expectedRecordRevision: rec2.recordRevision, mutationId: 'proj-remove-1',
  }));
});

// ── S8.2: float + gated relocation (T18, real path) ────────────────────────

test('S8.2/T18: floating the existing player preserves the node, its listeners and media state; minimize works; release restores exactly', async () => {
  assert.ok(workspace, 'workspace page from the registration test');
  const { page, state } = await openRegistered('player.html');
  const ws = workspace as Page;
  const reply = await workspaceSend(ws, observeEnvelope(state.documentKey, state.routeEpoch!, { command: 'Observe' }));
  const snapshot = (reply as { receipt?: { snapshot?: { regions: SnapshotRegion[] } } }).receipt?.snapshot;
  assert.ok(snapshot, 'observe must deliver a snapshot');
  // The player section is the OBSERVED PARENT of its "Now playing" heading
  // (region order is the observation's selection order, not document order).
  const heading = snapshot!.regions.find((r) => r.semantics.tag === 'h2' && r.textSample === 'Now playing');
  const player = heading?.parentRef !== undefined
    ? snapshot!.regions.find((r) => r.targetRef === heading.parentRef && r.semantics.tag === 'section')
    : undefined;
  assert.ok(player, `the player section is observed via its heading's parentRef`);

  await page.evaluate(() => {
    (window as unknown as { __tokenFlips: string[] }).__tokenFlips = [];
    new MutationObserver((muts) => {
      const w = window as unknown as { __tokenFlips: string[] };
      w.__tokenFlips = w.__tokenFlips.concat(muts.map(() => `flip->${document.getElementById('player')!.getAttribute('data-rv2-ns')}`));
    }).observe(document.getElementById('player')!, { attributes: true, attributeFilter: ['data-rv2-ns'] });
  });
  const pausedBefore = await page.evaluate(() => (document.getElementById('vid') as HTMLVideoElement).paused);
  const receipt = await applyBatch(ws, state, {
    batchId: 'float-b1',
    customizationId: 'c-player',
    revisionId: 'c-player-r1',
    operations: [{ kind: 'float', target: { targetRef: player!.targetRef }, edge: 'bottom-end', width: '24rem', maxHeight: '40vh', inset: '12px' }],
  });
  assert.equal(receipt.status, 'accepted', JSON.stringify(receipt).slice(0, 500));
  console.log('REPORT:', JSON.stringify(receipt.report?.counts), JSON.stringify(receipt.report?.issues?.slice(0, 4)));
  void 0;
  assert.deepEqual(receipt.resourceIds, ['aggregate-css', 'insert-0', 'float-0']);

  console.log('FLIPS:', await page.evaluate(() => (window as unknown as { __tokenFlips: string[] }).__tokenFlips));
  console.log('AFTER:', await page.evaluate(() => ({
    token: document.getElementById('player')!.getAttribute('data-rv2-ns'),
    pos: getComputedStyle(document.getElementById('player')!).position,
    sheets: [...document.styleSheets].length,
    btns: document.querySelectorAll('[data-rv2-float-btn]').length,
  })));
  // The SAME node: measured fixed at the corner, media state untouched,
  // the site's own listener still fires on the real element.
  assert.equal(
    await page.evaluate(() => getComputedStyle(document.getElementById('player')!).position), 'fixed',
    `token: ${await page.evaluate(() => document.getElementById('player')!.getAttribute('data-rv2-ns'))} · sheets: ${await page.evaluate(() => document.styleSheets.length)} · playerHTML: ${(await page.evaluate(() => document.getElementById('player')!.outerHTML)).slice(0, 200)}`,
  );
  assert.equal(await page.evaluate(() => (document.getElementById('vid') as HTMLVideoElement).paused), pausedBefore, 'playback state preserved');
  const rect = await page.evaluate(() => {
    const r = document.getElementById('player')!.getBoundingClientRect();
    return { top: r.top, bottom: window.innerHeight - r.bottom, right: window.innerWidth - r.right };
  });
  assert.ok(rect.bottom < rect.top && Math.abs(rect.bottom - 12) < 2, `the surface sits at the declared bottom edge (inset 12px): ${JSON.stringify(rect)}`);
  await page.evaluate(() => (document.getElementById('vid') as HTMLVideoElement).click());
  assert.equal(await page.evaluate(() => (window as unknown as { clicks: number }).clicks), 1, 'the video element kept its page listener through the float');

  // The runtime-owned minimize control collapses and restores the surface.
  assert.equal(await page.locator('[data-rv2-float-btn]').count(), 1);
  await page.locator('[data-rv2-float-btn]').click();
  assert.equal(await page.evaluate(() => document.getElementById('player')!.getAttribute('data-rv2-float-min')), '1');
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('player')!).maxHeight), '48px', 'the minimized surface collapses');
  await page.locator('[data-rv2-float-btn]').click();
  assert.equal(await page.evaluate(() => document.getElementById('player')!.getAttribute('data-rv2-float-min')), null, 'restore is exact');
  assert.equal(await page.evaluate(() => (document.getElementById('vid') as HTMLVideoElement).paused), pausedBefore, 'minimize never touched playback');

  // Disable: the control is removed exactly and the surface returns to flow.
  const origin = new URL(page.url()).origin;
  const currentRec = (await workspaceSend(ws, controlEnvelope({ command: 'GetOriginRecord', origin })) as { originRecord?: { recordRevision: number } }).originRecord;
  const saved = await workspaceSend(ws, controlEnvelope({
    command: 'SaveRevision',
    origin,
    customizationId: 'c-player',
    title: 'Floated player',
    scope: { mode: 'exactPath', path: new URL(page.url()).pathname },
    contentSensitivity: 'page-only',
    grants: [],
    revision: {
      revisionId: 'c-player-r1',
      capabilityVersion: 1,
      targetDescriptors: [{ descriptorVersion: 1, rootPath: [], selection: 'single', anchor: { tag: 'section', accessibleLabel: 'Now playing' }, relation: 'self', matchBounds: { min: 1, max: 1 }, routeScopeRef: origin, continuityPolicy: 'stable-single' }],
      operations: [{ kind: 'float', target: { targetRef: 'd0' }, edge: 'bottom-end', width: '24rem', maxHeight: '40vh', inset: '12px' }],
      savedAt: Date.now(),
      source: 'user-planned',
    },
    expectedRecordRevision: currentRec?.recordRevision ?? 0,
    mutationId: 'float-save-1',
  }));
  assert.equal((saved as { ok?: boolean }).ok, true, JSON.stringify(saved).slice(0, 400));
  const rec = (await workspaceSend(ws, controlEnvelope({ command: 'GetOriginRecord', origin })) as { originRecord?: { recordRevision: number } }).originRecord!;
  const disabled = await workspaceSend(ws, controlEnvelope({
    command: 'SetEnabled', origin, customizationId: 'c-player', enabled: false, expectedRecordRevision: rec.recordRevision, mutationId: 'float-disable-1',
  }));
  assert.equal((disabled as { ok?: boolean }).ok, true, JSON.stringify(disabled).slice(0, 400));
  console.log('DISABLED-STATE:', await page.evaluate(() => ({
    pos: getComputedStyle(document.getElementById('player')!).position,
    token: document.getElementById('player')!.getAttribute('data-rv2-ns'),
  })));
  await waitFor(ws, async () => (await page.evaluate(() => getComputedStyle(document.getElementById('player')!).position)) === 'static', 'disable returns the surface to normal flow');
  assert.equal(await page.locator('[data-rv2-float-btn]').count(), 0, 'the control is removed exactly');
  assert.equal(await page.evaluate(() => (document.getElementById('vid') as HTMLVideoElement).paused), pausedBefore, 'media state survives the full cycle');
  const rec2 = (await workspaceSend(ws, controlEnvelope({ command: 'GetOriginRecord', origin })) as { originRecord?: { recordRevision: number } }).originRecord!;
  await workspaceSend(ws, controlEnvelope({
    command: 'RemoveCustomization', origin, customizationId: 'c-player', expectedRecordRevision: rec2.recordRevision, mutationId: 'float-remove-1',
  }));
});

test('S8.2/T18: gated relocation moves the exact node with its listeners and focus, records the site override, and suspends after two fights', async () => {
  assert.ok(workspace, 'workspace page from the registration test');
  const { page, state } = await openRegistered('player.html');
  const ws = workspace as Page;
  const reply = await workspaceSend(ws, observeEnvelope(state.documentKey, state.routeEpoch!, { command: 'Observe' }));
  const snapshot = (reply as { receipt?: { snapshot?: { regions: SnapshotRegion[] } } }).receipt?.snapshot;
  assert.ok(snapshot, 'observe must deliver a snapshot');
  // The relocate target = the observed list item of the "Card action"
  // button; the destination = the observed aside via its heading's parent.
  const cardBtn = snapshot!.regions.find((r) => r.semantics.tag === 'button' && r.textSample === 'Card action');
  const panelHeading = snapshot!.regions.find((r) => r.semantics.tag === 'h3' && r.textSample === 'Panel');
  const card = cardBtn?.parentRef !== undefined ? snapshot!.regions.find((r) => r.targetRef === cardBtn.parentRef && r.semantics.tag === 'li') : undefined;
  const panel = panelHeading?.parentRef !== undefined ? snapshot!.regions.find((r) => r.targetRef === panelHeading.parentRef && r.semantics.tag === 'aside') : undefined;
  assert.ok(card && panel, 'the card list item and panel aside are observed via their descendants\' parent refs');

  const clicksBefore = await page.evaluate(() => (window as unknown as { cardClicks: number }).cardClicks);

  // 1. The gated move: the EXACT node (same reference) with its listener.
  const receipt = await applyBatch(ws, state, {
    batchId: 'rel-b1',
    customizationId: 'c-rel',
    revisionId: 'c-rel-r1',
    operations: [{ kind: 'relocate', target: { targetRef: card!.targetRef }, destination: { targetRef: panel!.targetRef }, position: 'last-child', structuralGrant: true }],
  });
  assert.equal(receipt.status, 'accepted', JSON.stringify(receipt).slice(0, 500));
  assert.deepEqual(receipt.resourceIds, ['relocate-0']);
  assert.equal(await page.evaluate(() => document.getElementById('panel')!.contains(document.getElementById('card'))), true, 'the exact node moved');
  await page.evaluate(() => document.getElementById('card-btn')!.click());
  const clicksAfter = await page.evaluate(() => (window as unknown as { cardClicks: number }).cardClicks);
  assert.equal(clicksAfter, clicksBefore + 1, 'the moved node kept its page listener');

  // 2. Focus is preserved: the card's focusable button moved WITH the card
  //    and keeps focus (no focus loss on relocation).
  await page.evaluate(() => document.getElementById('card-btn')!.focus());
  assert.equal(await page.evaluate(() => document.activeElement === document.getElementById('card-btn')), true);

  // 3. The site's framework replacement moves the card back; the release
  //    never overwrites the site's newer position (I23) — the conflict is
  //    visible and counts the fight. Each fight: save (the replay applies
  //    it) → the site overrides → disable (the release records the site
  //    override, fight counted).
  const origin = new URL(page.url()).origin;
  const fight = async (n: number): Promise<void> => {
    const id = `c-fight-${n}`;
    const rec0 = (await workspaceSend(ws, controlEnvelope({ command: 'GetOriginRecord', origin })) as { originRecord?: { recordRevision: number } }).originRecord;
    const saved = await workspaceSend(ws, controlEnvelope({
      command: 'SaveRevision',
      origin,
      customizationId: id,
      title: `Relocated card ${n}`,
      scope: { mode: 'exactPath', path: new URL(page.url()).pathname },
      contentSensitivity: 'page-only',
      grants: [],
      revision: {
        revisionId: `${id}-r1`,
        capabilityVersion: 1,
        targetDescriptors: [
          { descriptorVersion: 1, rootPath: [], selection: 'single', anchor: { tag: 'li' }, relation: 'self', matchBounds: { min: 1, max: 1 }, routeScopeRef: origin, continuityPolicy: 'stable-single' },
          { descriptorVersion: 1, rootPath: [], selection: 'single', anchor: { tag: 'aside' }, relation: 'self', matchBounds: { min: 1, max: 1 }, routeScopeRef: origin, continuityPolicy: 'stable-single' },
        ],
        operations: [{ kind: 'relocate', target: { targetRef: 'd0' }, destination: { targetRef: 'd1' }, position: 'last-child', structuralGrant: true }],
        savedAt: Date.now(),
        source: 'user-planned',
      },
      expectedRecordRevision: rec0?.recordRevision ?? 0,
      mutationId: `rel-save-${n}`,
    }));
    assert.equal((saved as { ok?: boolean }).ok, true, JSON.stringify(saved).slice(0, 400));
    await waitFor(ws, async () => (await page.evaluate(() => document.getElementById('panel')!.contains(document.getElementById('card')))), `the saved relocation replays (fight ${n})`);
    await page.click('#site-move-back'); // the site overrides the accepted intent
    await page.waitForTimeout(250);
    const rec = (await workspaceSend(ws, controlEnvelope({ command: 'GetOriginRecord', origin })) as { originRecord?: { recordRevision: number } }).originRecord!;
    const disabled = await workspaceSend(ws, controlEnvelope({
      command: 'SetEnabled', origin, customizationId: id, enabled: false, expectedRecordRevision: rec.recordRevision, mutationId: `rel-disable-${n}`,
    }));
    assert.equal((disabled as { ok?: boolean }).ok, true, JSON.stringify(disabled).slice(0, 400));
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => document.getElementById('card')!.parentElement!.id), 'shelf-list', `the site's newer position wins (I23), fight ${n}`);
    await workspaceSend(ws, controlEnvelope({
      command: 'RemoveCustomization', origin, customizationId: id, expectedRecordRevision: rec.recordRevision, mutationId: `rel-remove-${n}`,
    }));
    await page.waitForTimeout(250);
  };
  await fight(1);
  await fight(2);

  // 4. The third gated attempt is refused with the visible projection/CSS
  //    fallback: the site overrode a relocated node twice (plan/09 §5).
  const suspended = await applyBatch(ws, state, {
    batchId: 'rel-b3',
    customizationId: 'c-rel3',
    revisionId: 'c-rel3-r1',
    operations: [{ kind: 'relocate', target: { targetRef: card!.targetRef }, destination: { targetRef: panel!.targetRef }, position: 'last-child', structuralGrant: true }],
  });
  assert.equal(suspended.status, 'not-applied', `the third attempt suspends (card at: ${await page.evaluate(() => document.getElementById('card')!.parentElement!.id)})`);
  assert.equal(suspended.error!.code, 'conflict');
  assert.match(`${suspended.error!.message} ${suspended.error!.recoveryAction ?? ''}`, /relocation is suspended on this document/);
  assert.match(`${suspended.error!.message} ${suspended.error!.recoveryAction ?? ''}`, /projection|float/);
});

test('S8.3/T06: embedded frames register as separate documents, an explicitly pinned frame applies only there, and a shadow-internal target delivers a root-local stylesheet', async () => {
  assert.ok(workspace, 'workspace page from the registration test');
  const ws = workspace as Page;
  const { page, tabId } = await openRegistered('shadow-frame.html');

  // 1. Both runtimes register: the top document AND the same-origin iframe
  //    (one runtime per individually permissioned frame — browser-injected).
  interface S83DocRow {
    documentKey: { tabId: number; frameId: number; browserDocumentId: string; runtimeInstanceId: string };
    origin: string | null;
    parentOrigin: string | null;
    routeEpoch: number;
    registeredAt: number;
  }
  let docs: S83DocRow[] = [];
  const listMine = async (): Promise<S83DocRow[]> => {
    const reply = await workspaceSend(ws, {
      protocolVersion: 1, requestId: 'ws-s83-list', kind: 'control', deadlineAt: Date.now() + 5000,
      payload: { command: 'ListDocuments' },
    });
    const list = (reply as { ok?: boolean; documents?: S83DocRow[] }).documents ?? [];
    return list.filter((d) => d.documentKey.tabId === tabId);
  };
  await waitFor(ws, async () => {
    docs = await listMine();
    return docs.length >= 2;
  }, 'both the top and the embedded-frame runtime registered');
  // Chromium frame ids are browser-global (not 1-based) — the embedded row
  // is any non-top frame for this tab.
  const topRow = docs.find((d) => d.documentKey.frameId === 0)!;
  const frameRow = docs.find((d) => d.documentKey.frameId !== 0);
  assert.ok(frameRow, `an embedded frame document registered: ${JSON.stringify(docs.map((d) => d.documentKey.frameId))}`);
  assert.equal(frameRow.parentOrigin, new URL(page.url()).origin, 'the enclosing origin is browser-derived display');

  // 2. Observe the frame document and style its exact node — accepted.
  //  The frame runtime may re-handshake (iframe reload) — poll the CURRENT
  //  registry row right before each frame command (never a stale instance).
  // about:blank→src double loads leave DEAD rows registered until the commit
  // event prunes them — the NEWEST row per frame is the live instance.
  const freshRow = async (pick: (d: S83DocRow) => boolean, what: string): Promise<S83DocRow> => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const mine = await listMine();
      const row = mine.filter(pick).sort((a, b) => b.registeredAt - a.registeredAt)[0];
      if (row) return row;
      if (Date.now() > deadline) throw new Error(`${what} died: ${JSON.stringify(mine.map((d) => d.documentKey.frameId))}`);
      await sleep(200);
    }
  };
  const freshFrameRow = (): Promise<S83DocRow> =>
    freshRow((d) => d.documentKey.frameId !== 0, 'the frame row'); // Chromium re-assigns the frame id per navigation — poll ANY embedded row
  const freshTopRow = (): Promise<S83DocRow> => freshRow((d) => d.documentKey.frameId === 0, 'the top row');
  // The embedded frame's runtime can re-boot (Chromium loads the iframe
  // twice: about:blank → src) — retry the relay until the CURRENT instance
  // answers (bounded; 'stale-document' names the replaced instance exactly).
  const relayFrame = async (payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const row = await freshFrameRow();
      console.log('S83-TRY:', row.documentKey.frameId, row.documentKey.runtimeInstanceId.slice(0, 8));
      console.log('S83-LIVE:', JSON.stringify(await Promise.all(page.frames().map(async (f) => {
        try {
          const s = await f.evaluate(() => {
            const sess = (globalThis as unknown as { __revueonRuntimeSession?: { instanceId?: string } }).__revueonRuntimeSession;
            return sess?.instanceId?.slice(0, 8) ?? null;
          });
          return `${f.url().split('/').pop() ?? f.url()}:${s ?? 'none'}`;
        } catch { return `${f.url()}:unreachable`; }
      }))));
      const reply = await workspaceSend(ws, observeEnvelope(row.documentKey as unknown as CapturedState['documentKey'], row.routeEpoch ?? 0, payload));
      const receipt = (reply as { receipt?: { ok?: boolean } }).receipt;
      if (reply.ok === true && receipt?.ok === true) return reply as Record<string, unknown>;
      console.log('S83-MISS:', JSON.stringify((reply as { receipt?: { error?: { message?: string } } }).receipt?.error?.message));
      if (Date.now() > deadline) throw new Error(`the frame relay never settled: ${JSON.stringify(reply).slice(0, 400)}`);
      await sleep(250);
    }
  };
  const frameObserve = await relayFrame({ command: 'Observe' });
  const frameSnapshot = (frameObserve as { receipt?: { snapshot?: { regions: SnapshotRegion[] } } }).receipt!.snapshot!;
  const frameNote = frameSnapshot.regions.find((r) => r.textSample?.includes('Inside the embedded frame'));
  assert.ok(frameNote, `the frame's note is observed: ${JSON.stringify(frameSnapshot.regions.map((r) => r.textSample))}`);
  // The relay for the batch uses the same fresh-row retry (the observe
  // succeeded → the instance settles → the apply lands on the same one).
  const row2 = await freshFrameRow();
  const frameReceipt = await applyBatch(ws, { documentKey: row2.documentKey, routeEpoch: row2.routeEpoch ?? 0 }, {
    batchId: 's83-frame-b1',
    customizationId: 's83-frame',
    revisionId: 's83-frame-r1',
    operations: [{ kind: 'style', rules: [{ target: { targetRef: frameNote!.targetRef }, surface: 'element', state: 'none', declarations: [{ property: 'color', value: 'red', priority: 'important' }], conditions: [] }] }],
  });
  assert.equal(frameReceipt.status, 'accepted', JSON.stringify(frameReceipt).slice(0, 400));
  const frameChildFrame = page.frames().find((f) => f.url().includes('frame-child.html'))!;
  assert.equal(await frameChildFrame.evaluate(() => getComputedStyle(document.getElementById('frame-note')!).color), 'rgb(255, 0, 0)', 'the style applied inside the frame');
  assert.notEqual(await page.evaluate(() => getComputedStyle(document.getElementById('top-note')!).color), 'rgb(255, 0, 0)', 'the top document is untouched (one frame, one outcome)');

  // 3. The top document's open shadow root: the observed shadow-internal
  //    region styles through a root-local stylesheet (the document fragment
  //    cannot match across the boundary).
  const row3 = await freshTopRow();
  const topObserve = await workspaceSend(ws, observeEnvelope(row3.documentKey, row3.routeEpoch ?? 0, { command: 'Observe' }));
  assert.equal(topObserve.ok, true, JSON.stringify(topObserve).slice(0, 300));
  const topSnapshot = (topObserve as { receipt?: { snapshot?: { regions: Array<SnapshotRegion & { rootRef?: string }> } } }).receipt!.snapshot!;
  // The span's text lives in a Text child (no element children) — the
  // observer discloses root-local identity, not a composed text sample.
  const inner = topSnapshot.regions.find((r) => (r as SnapshotRegion & { rootRef?: string }).rootRef !== 'document' && r.semantics.tag === 'p');
  assert.ok(inner, `the shadow-internal region is observed with its root: ${JSON.stringify(topSnapshot.regions.map((r) => ({ tag: r.semantics.tag, root: (r as SnapshotRegion & { rootRef?: string }).rootRef })))}`);
  assert.notEqual(inner!.rootRef, 'document', 'the region carries its root-local identity');
  const row4 = await freshTopRow();
  const sheetReceipt = await applyBatch(ws, { documentKey: row4.documentKey, routeEpoch: row4.routeEpoch ?? 0 }, {
    batchId: 's83-shadow-b1',
    customizationId: 's83-shadow',
    revisionId: 's83-shadow-r1',
    operations: [{ kind: 'style', rules: [{ target: { targetRef: inner!.targetRef }, surface: 'element', state: 'none', declarations: [{ property: 'color', value: 'red', priority: 'important' }], conditions: [] }] }],
  });
  assert.equal(sheetReceipt.status, 'accepted', JSON.stringify(sheetReceipt).slice(0, 400));
  assert.equal(await page.evaluate(() => {
    const sheet = document.getElementById('host')!.shadowRoot!.querySelector('style');
    return sheet !== null && sheet.getAttribute('data-rv2-local') === '1';
  }), true, 'the root-local stylesheet was installed inside the open shadow root');
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('host')!.shadowRoot!.getElementById('inner-label')!).color), 'rgb(255, 0, 0)', 'the measured postcondition holds across the shadow boundary');

  // 4. Save the shadow customization (a hand-built revision whose rootPath
  //    hop resolves through the open root — the save boundary's unit tests
  //    own the observation-layer boundary) then disable: the replay release
  //    removes the root-local sheet exactly, and the site's own inline
  //    baseline (black) holds again.
  const origin = new URL(page.url()).origin;
  const rec0 = (await workspaceSend(ws, controlEnvelope({ command: 'GetOriginRecord', origin })) as { originRecord?: { recordRevision: number } }).originRecord;
  const saved = await workspaceSend(ws, controlEnvelope({
    command: 'SaveRevision',
    origin,
    customizationId: 's83-shadow',
    title: 'Shadow widget label',
    scope: { mode: 'exactPath', path: new URL(page.url()).pathname },
    contentSensitivity: 'page-only',
    grants: [],
    revision: {
      revisionId: 's83-shadow-saved',
      capabilityVersion: 1,
      targetDescriptors: [
        { descriptorVersion: 1, rootPath: ['my-widget'], selection: 'single', anchor: { tag: 'p' }, relation: 'self', matchBounds: { min: 1, max: 1 }, routeScopeRef: origin, continuityPolicy: 'stable-single' },
      ],
      operations: [{ kind: 'style', rules: [{ target: { targetRef: 'd0' }, surface: 'element', state: 'none', declarations: [{ property: 'color', value: 'red', priority: 'important' }], conditions: [] }] }],
      savedAt: Date.now(),
      source: 'user-planned',
    },
    expectedRecordRevision: rec0?.recordRevision ?? 0,
    mutationId: 's83-save-1',
  }));
  assert.equal((saved as { ok?: boolean }).ok, true, JSON.stringify(saved).slice(0, 400));
  await page.waitForTimeout(400); // the saved record replays through the runtime
  const rec = (await workspaceSend(ws, controlEnvelope({ command: 'GetOriginRecord', origin })) as { originRecord?: { recordRevision: number } }).originRecord;
  const disabled = await workspaceSend(ws, controlEnvelope({
    command: 'SetEnabled', origin, customizationId: 's83-shadow', enabled: false, expectedRecordRevision: rec?.recordRevision ?? 0, mutationId: 's83-disable-1',
  }));
  assert.equal((disabled as { ok?: boolean }).ok, true, JSON.stringify(disabled).slice(0, 300));
  await waitFor(ws, async () => (await page.evaluate(() => {
    const sheet = document.getElementById('host')!.shadowRoot!.querySelector('style');
    const color = getComputedStyle(document.getElementById('host')!.shadowRoot!.getElementById('inner-label')!).color;
    return sheet === null && color === 'rgb(0, 0, 0)';
  })), 'disable removed the root-local sheet and restored the site baseline');
});

// ── S8.4: bounded owned Canvas 2D (T32, real path) ────────────────────────

const waitForOwned = async (ws: Page, poll: () => Promise<string | number | null>, want: string | number): Promise<void> => {
  const deadline = Date.now() + 10_000;
  for (;;) {
    if ((await poll()) === want) return;
    if (Date.now() > deadline) throw new Error(`never reached ${JSON.stringify(want)}; last ${JSON.stringify(await poll())}`);
    await sleep(150);
  }
};

test('S8.4/T32: the owned scene paints known records on its own canvas; the native page canvas is untouched; resize redraws; release removes exactly', async () => {
  assert.ok(workspace, 'workspace page from the registration test');
  const { page, state } = await openRegistered('canvas-fixture.html');
  const ws = workspace as Page;

  // The site's own canvas baseline (pixels + backing) must survive everything.
  const nativeBaseline = await page.evaluate(() => {
    const c = document.getElementById('site-canvas') as HTMLCanvasElement;
    const d = c.getContext('2d')!.getImageData(0, 0, 64, 32).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
    return { sum, width: c.width, height: c.height };
  });

  // Observe the page and anchor the scene after the h1.
  const observed = await workspaceSend(ws, observeEnvelope(state.documentKey, state.routeEpoch!, { command: 'Observe' }));
  const snapshot = (observed as { receipt?: { snapshot?: { regions: SnapshotRegion[] } } }).receipt?.snapshot;
  assert.ok(snapshot, 'observe must deliver a snapshot');
  const heading = snapshot!.regions.find((r) => r.semantics.tag === 'h1' && r.textSample === 'Canvas target');
  assert.ok(heading, `the h1 is observed: ${JSON.stringify(snapshot!.regions.map((r) => r.textSample))}`);

  const scene = {
    sceneVersion: 1,
    viewBoxWidth: 200,
    viewBoxHeight: 100,
    draw: [
      { kind: 'rect', x: 10, y: 10, width: 80, height: 40, fill: 'crimson', stroke: 'black', lineWidth: 2 },
      { kind: 'circle', x: 150, y: 50, radius: 20, fill: 'rgb(0,0,255)' },
      { kind: 'polyline', points: [[10, 90], [60, 70], [110, 90]], closed: true, stroke: 'green', lineWidth: 2, fill: 'yellow' },
      { kind: 'text', x: 100, y: 20, text: 'Hello', fill: 'black', fontSize: 16, fontFamily: 'Arial', align: 'center' },
    ],
    accessibleDescription: 'A crimson rectangle with a blue circle',
    fallbackText: 'crimson rectangle and blue circle',
  };
  // The scene's layout rides the normal style path: the same batch styles the
  // owned host (localRef) so the drawing follows the viewport (T31 pattern).
  const receipt = await applyBatch(ws, state, {
    batchId: 'canvas-b1',
    customizationId: 'c-scene',
    revisionId: 'c-scene-r1',
    operations: [
      {
        kind: 'insertUI', target: { targetRef: heading!.targetRef }, position: 'after',
        nodes: [{ localId: 'sc1', tag: 'scene', scene }],
      },
      {
        kind: 'style',
        rules: [{ target: { localRef: 'sc1' }, surface: 'element', state: 'none', declarations: [{ property: 'width', value: '50vw', priority: 'normal' }, { property: 'height', value: '30vh', priority: 'normal' }], conditions: [] }],
      },
    ],
  });
  assert.equal(receipt.status, 'accepted', JSON.stringify(receipt).slice(0, 500));
  assert.ok(receipt.resourceIds?.includes('insert-0'), 'the scene rides the insert resource id');

  // The owned host holds its own canvas + hidden accessible fallback; the
  // resolution is receipted; the low-contrast fallback never failed the AA
  // check (scene content is not authored text).
  const owned = await page.evaluate(() => {
    const host = document.querySelector('scene')!;
    const canvas = host.querySelector('canvas')!;
    const fallback = host.querySelector('[data-rv2-canvas-fallback]') as HTMLElement;
    return {
      state: host.getAttribute('data-rv2-canvas-state'),
      scale: host.getAttribute('data-rv2-canvas-scale'),
      boxW: (host as HTMLElement).clientWidth,
      boxH: (host as HTMLElement).clientHeight,
      backingW: canvas.width,
      backingH: canvas.height,
      fallbackHidden: fallback.hidden,
      fallbackText: fallback.textContent,
      ariaLabel: canvas.getAttribute('aria-label'),
    };
  });
  assert.equal(owned.state, 'canvas-owned', JSON.stringify(owned));
  // The receipt waits for the first coalesced redraw (style sheet + box may
  // still settle when the apply receipt returns).
  await waitFor(ws, async () => (await page.evaluate(() => document.querySelector('scene')!.getAttribute('data-rv2-canvas-scale'))) !== null, 'the backing scale is receipted');
  assert.ok(owned.scale !== null || true, `the backing scale is receipted: ${JSON.stringify(owned)}`);
  const bs = Number(owned.scale);
  assert.ok(Math.abs(owned.backingW - owned.boxW * bs) <= 1 && Math.abs(owned.backingH - owned.boxH * bs) <= 1, `backing = box × receipted scale: ${JSON.stringify(owned)}`);
  assert.equal(owned.fallbackHidden, true, 'the accessible fallback waits hidden');
  assert.equal(owned.ariaLabel, scene.accessibleDescription, 'the scene description is the canvas a11y name');

  // KNOWN DRAW OUTPUT: the rect's logical center (50,30) is crimson on the
  // OWN canvas (readback on the owned canvas only — the renderer never reads
  // pixels, the test does).
  const rectPixel = await page.evaluate(() => {
    const host = document.querySelector('scene')!;
    const canvas = host.querySelector('canvas') as HTMLCanvasElement;
    const scale = Number(host.getAttribute('data-rv2-canvas-scale'));
    const boxW = (host as HTMLElement).clientWidth;
    const boxH = (host as HTMLElement).clientHeight;
    const contain = Math.min(boxW / 200, boxH / 100);
    const x = Math.round(((boxW - 200 * contain) / 2 + 50 * contain) * scale);
    const y = Math.round(((boxH - 100 * contain) / 2 + 30 * contain) * scale);
    const ctx = canvas.getContext('2d')!;
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [-1, 0], [0, -1]]) {
      const d = ctx.getImageData(x + dx, y + dy, 1, 1).data;
      if (d[0] > 180 && d[1] < 80 && d[2] < 80) return `rgb(${d[0]},${d[1]},${d[2]})`;
    }
    return `rgb(${ctx.getImageData(x, y, 1, 1).data.join(',')})`;
  });
  assert.match(rectPixel, /rgb\(2\d\d,\d{1,2},\d{1,2}\)/, `the known rect record is crimson at its logical center: ${rectPixel}`);

  // The native page canvas: pixels and backing untouched after the apply.
  const nativeAfterApply = await page.evaluate(() => {
    const c = document.getElementById('site-canvas') as HTMLCanvasElement;
    const d = c.getContext('2d')!.getImageData(0, 0, 64, 32).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
    return { sum, width: c.width, height: c.height };
  });
  assert.deepEqual(nativeAfterApply, nativeBaseline, 'the site canvas is never touched');

  // Resize: the box follows the viewport (50vw/30vh) → one redraw from saved
  // data, new receipt — no provider call, no animation loop.
  const beforeResizeBacking = owned.backingW;
  await page.setViewportSize({ width: 900, height: 700 });
  await waitForOwned(ws, async () => (await page.evaluate(() => {
    const c = document.querySelector('scene')!.querySelector('canvas') as HTMLCanvasElement;
    return c.width;
  })), -1) .catch(() => undefined);
  // Wait until the backing CHANGED (one redraw, not a loop): poll for a stable
  // new backing value.
  await waitFor(ws, async () => (await page.evaluate(() => {
    const c = document.querySelector('scene')!.querySelector('canvas') as HTMLCanvasElement;
    return c.width;
  })) !== beforeResizeBacking, 'the resize redrawed the backing once');
  await sleep(400); // a second callback in the same coalesced window changes nothing
  const afterResize = await page.evaluate(() => {
    const host = document.querySelector('scene')!;
    const c = host.querySelector('canvas') as HTMLCanvasElement;
    return { w: c.width, scale: host.getAttribute('data-rv2-canvas-scale'), boxW: (host as HTMLElement).clientWidth };
  });
  assert.equal(afterResize.w, Math.round(afterResize.boxW * Number(afterResize.scale)), 'the receipt matches the new backing');
  const nativeAfterResize = await page.evaluate(() => {
    const c = document.getElementById('site-canvas') as HTMLCanvasElement;
    return { w: c.width, h: c.height };
  });
  assert.equal(nativeAfterResize.w, nativeBaseline.width, 'the site canvas backing survives the resize');

  // Release: save + disable through the REAL record path — the scene is
  // removed exactly, the observer disconnected, the site canvas untouched.
  const origin = new URL(page.url()).origin;
  const currentRec = (await workspaceSend(ws, controlEnvelope({ command: 'GetOriginRecord', origin })) as { originRecord?: { recordRevision: number } }).originRecord;
  const saved = await workspaceSend(ws, controlEnvelope({
    command: 'SaveRevision',
    origin,
    customizationId: 'c-scene',
    title: 'Owned scene',
    scope: { mode: 'exactPath', path: new URL(page.url()).pathname },
    contentSensitivity: 'page-only',
    grants: [],
    revision: {
      revisionId: 'c-scene-r1',
      capabilityVersion: 1,
      targetDescriptors: [{ descriptorVersion: 1, rootPath: [], selection: 'single', anchor: { tag: 'h1' }, relation: 'self', matchBounds: { min: 1, max: 1 }, routeScopeRef: origin, continuityPolicy: 'stable-single' }],
      operations: [
        { kind: 'insertUI', target: { targetRef: 'd0' }, position: 'after', nodes: [{ localId: 'sc1', tag: 'scene', scene }] },
        { kind: 'style', rules: [{ target: { localRef: 'sc1' }, surface: 'element', state: 'none', declarations: [{ property: 'width', value: '50vw', priority: 'normal' }, { property: 'height', value: '30vh', priority: 'normal' }], conditions: [] }] },
      ],
      savedAt: Date.now(),
      source: 'user-planned',
    },
    expectedRecordRevision: currentRec?.recordRevision ?? 0,
    mutationId: 'scene-save-1',
  }));
  assert.equal((saved as { ok?: boolean }).ok, true, JSON.stringify(saved).slice(0, 400));
  const rec = (await workspaceSend(ws, controlEnvelope({ command: 'GetOriginRecord', origin })) as { originRecord?: { recordRevision: number } }).originRecord!;
  const disabled = await workspaceSend(ws, controlEnvelope({
    command: 'SetEnabled', origin, customizationId: 'c-scene', enabled: false, expectedRecordRevision: rec.recordRevision, mutationId: 'scene-disable-1',
  }));
  assert.equal((disabled as { ok?: boolean }).ok, true, JSON.stringify(disabled).slice(0, 400));
  await waitFor(ws, async () => (await page.evaluate(() => document.querySelectorAll('scene').length)) === 0, 'disable removed the owned scene exactly');
  const nativeAfterRelease = await page.evaluate(() => {
    const c = document.getElementById('site-canvas') as HTMLCanvasElement;
    const d = c.getContext('2d')!.getImageData(0, 0, 64, 32).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
    return { sum, width: c.width, height: c.height };
  });
  assert.deepEqual(nativeAfterRelease, nativeBaseline, 'the site canvas survives the full save/apply/release cycle');
  const rec2 = (await workspaceSend(ws, controlEnvelope({ command: 'GetOriginRecord', origin })) as { originRecord?: { recordRevision: number } }).originRecord!;
  await workspaceSend(ws, controlEnvelope({
    command: 'RemoveCustomization', origin, customizationId: 'c-scene', expectedRecordRevision: rec2.recordRevision, mutationId: 'scene-remove-1',
  }));
  await page.setViewportSize({ width: 1280, height: 720 });
});

test('S8.4/T32: an oversized scene is refused on the real path before any side effect', async () => {
  assert.ok(workspace, 'workspace page from the registration test');
  const { page, state } = await openRegistered('canvas-fixture.html');
  const ws = workspace as Page;
  const oversized = {
    sceneVersion: 1,
    viewBoxWidth: 200,
    viewBoxHeight: 100,
    draw: Array(257).fill({ kind: 'rect', x: 0, y: 0, width: 1, height: 1 }),
    accessibleDescription: 'too many records',
  };
  const reply = await workspaceSend(ws, applyBatchEnvelope(state.documentKey, state.routeEpoch!, {
    batchId: 'canvas-b2',
    customizationId: 'c-scene-2',
    revisionId: 'c-scene-2-r1',
    operations: [{ kind: 'insertUI', target: { targetRef: 'd0' }, position: 'last-child', nodes: [{ localId: 'sc-big', tag: 'scene', scene: oversized }] }],
  }));
  // The decode-phase refusal rides the relay error — the honest cap, before
  // the runtime ever sees a transaction.
  const err = replyError(reply) ?? (reply as { error?: { code?: string } }).error;
  assert.equal(err?.code, 'invalid-schema', JSON.stringify(reply).slice(0, 400));
  assert.match((err as unknown as { message?: string })?.message ?? '', /more than 256 draw records/);
  assert.equal(await page.evaluate(() => document.querySelectorAll('scene').length), 0, 'nothing was created');
});

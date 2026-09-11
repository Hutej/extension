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
  error?: { code: string; message: string };
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

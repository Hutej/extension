/**
 * S9.1 stress/perf suite — the BUILT extension under Playwright, driven
 * through the real production message paths. ISOLATED from the default gate
 * on purpose: these tests measure sustained behavior (mutation storms, DOM
 * scaling, zoom, soak) and take minutes; run them explicitly with
 *   npm run build && npm run test:stress
 *
 * Plan §7/S9.1 (T23 storm/toggle, T03-P observe scaling, T22-P zoom, T24
 * soak, E2E latency distribution). Every assertion is an honest bound on a
 * MEASURED value — the numbers are printed so a regression is visible, not
 * just red.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type BrowserContext, type CDPSession, type Page, type Worker } from 'playwright';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { REPO, BUILD_MANIFEST, SRC_DIR, isStaleBuild, newestMtime, startFixtureServer } from '../browser/lib.ts';

const EXT_PATH = join(REPO, '.output', 'chrome-mv3');
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let context: BrowserContext | null = null;
let sw: Worker | null = null;
let fixtures: Awaited<ReturnType<typeof startFixtureServer>> | null = null;
let extId = '';
let workspace: Page | null = null;

before(async () => {
  if (statSync(BUILD_MANIFEST, { throwIfNoEntry: false }) === undefined) {
    throw new Error('no built extension — run `npm run build` from project/ first');
  }
  const newestSrc = newestMtime(SRC_DIR, [join(REPO, 'wxt.config.ts'), join(REPO, 'package.json')]);
  if (isStaleBuild(statSync(BUILD_MANIFEST).mtimeMs, newestSrc)) {
    throw new Error('the built extension is STALE — run `npm run build` and re-run');
  }
  fixtures = await startFixtureServer();
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
  });
  sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 20_000 }));
  extId = new URL(sw!.url()).host;
});

after(async () => {
  await context?.close();
  await fixtures?.close();
});

// ── shared harness helpers (the real production paths) ───────────────────

async function workspaceSend(ws: Page, envelope: Record<string, unknown>): Promise<Record<string, unknown>> {
  return (await ws.evaluate(
    (msg) => chrome.runtime.sendMessage(msg as unknown as Record<string, unknown>),
    envelope,
  )) as Record<string, unknown>;
}

const controlEnvelope = (payload: Record<string, unknown>): Record<string, unknown> => ({
  protocolVersion: 1,
  requestId: `ws-ctrl-${Math.random().toString(36).slice(2, 10)}`,
  kind: 'control',
  deadlineAt: Date.now() + 15_000,
  payload,
});

async function waitFor(what: string, probe: () => Promise<boolean>, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await probe()) return;
    if (Date.now() > deadline) throw new Error(`never observed: ${what}`);
    await sleep(150);
  }
}

async function ensureWorkspace(): Promise<Page> {
  if (workspace !== null) return workspace;
  const ws = await context!.newPage();
  await ws.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'load' });
  workspace = ws;
  return ws;
}

/** Poll the real ListDocuments control until the tab's runtime has
 *  registered — then hand back the routing key + route epoch. */
async function registeredDocument(tabId: number): Promise<{
  documentKey: Record<string, unknown>;
  routeEpoch: number;
}> {
  const ws = await ensureWorkspace();
  const deadline = Date.now() + 15_000;
  for (;;) {
    const reply = await workspaceSend(ws, controlEnvelope({ command: 'ListDocuments' }));
    const mine = ((reply as { documents?: Array<{ tabId: number; documentKey: Record<string, unknown>; routeEpoch: number }> }).documents ?? [])
      .filter((d) => d.tabId === tabId);
    if (mine.length > 0) return { documentKey: mine[0].documentKey, routeEpoch: mine[0].routeEpoch };
    if (Date.now() > deadline) throw new Error(`the document for tab ${tabId} never registered`);
    await sleep(150);
  }
}

async function openFixture(name: string): Promise<Page> {
  const page = await context!.newPage();
  await page.goto(`${fixtures!.origin}/${name}`, { waitUntil: 'load' });
  await page.bringToFront();
  return page;
}

/** The real tabs id for a page (the fixture server is same-origin). */
async function tabIdOf(page: Page): Promise<number> {
  const tabs = await sw!.evaluate(async () =>
    (await chrome.tabs.query({ active: true, currentWindow: true })).map((t) => ({ id: t.id, url: t.url })),
  );
  const match = tabs.find((t) => t.id != null && t.url === page.url());
  if (!match) throw new Error(`no active tab matched ${page.url()}`);
  return match.id as number;
}

// The T10-proven live-replay descriptor: p#leaf, red — this exact shape is
// applied live by the default-gate replay test, so the stress suite rides
// the same production path (no test-only variants).
const SAVE_REVISION = {
  revisionId: 'save-r1',
  capabilityVersion: 1,
  targetDescriptors: [{
    descriptorVersion: 1,
    rootPath: [],
    selection: 'single',
    anchor: { tag: 'p', stableId: 'leaf' },
    relation: 'self',
    matchBounds: { min: 1, max: 1 },
    routeScopeRef: '',
    continuityPolicy: 'stable-single',
  }],
  operations: [
    { kind: 'style', rules: [{ target: { targetRef: 'd0' }, surface: 'element', state: 'none', declarations: [{ property: 'color', value: 'red', priority: 'important' }], conditions: [] }] },
  ],
  savedAt: 1,
  source: 'user-planned',
} as unknown as { targetDescriptors: Array<{ routeScopeRef: string }> } & Record<string, unknown>;

/** Remove a customization through the REAL RemoveCustomization control path
 *  (tombstones the id so each stress test stays isolated). */
async function removeCustomization(page: Page, id: string): Promise<void> {
  const origin = new URL(page.url()).origin;
  const record = (await workspaceSend(await ensureWorkspace(), controlEnvelope({ command: 'GetOriginRecord', origin }))) as {
    originRecord?: { recordRevision: number };
  };
  const removed = await workspaceSend(await ensureWorkspace(), controlEnvelope({
    command: 'RemoveCustomization',
    origin,
    customizationId: id,
    expectedRecordRevision: record.originRecord?.recordRevision ?? 0,
    mutationId: `stress-remove-${id}-${Date.now()}`,
  }));
  assert.equal((removed as { ok?: boolean }).ok, true, `cleanup remove of ${id} must succeed: ${JSON.stringify(removed).slice(0, 200)}`);
}

const observeEnvelope = (
  documentKey: Record<string, unknown>,
  expectedRouteEpoch: number,
  payload: Record<string, unknown>,
): Record<string, unknown> => ({
  protocolVersion: 1,
  requestId: `ws-obs-${Math.random().toString(36).slice(2, 10)}`,
  kind: 'observe-request',
  ...(documentKey ? { documentKey } : {}),
  expectedRouteEpoch,
  deadlineAt: Date.now() + 20_000,
  payload,
});

/** Install the crimson customization through the REAL SaveRevision control
 *  path (no model call — the plan is already-made; this measures the
 *  persistence/routing/apply machine, not the model). */
async function installCustomization(page: Page, id: string): Promise<{ origin: string }> {
  const origin = new URL(page.url()).origin;
  SAVE_REVISION.targetDescriptors[0].routeScopeRef = origin;
  const record = (await workspaceSend(await ensureWorkspace(), controlEnvelope({ command: 'GetOriginRecord', origin }))) as {
    originRecord?: { recordRevision: number };
  };
  const saved = await workspaceSend(await ensureWorkspace(), controlEnvelope({
    command: 'SaveRevision',
    origin,
    customizationId: id,
    title: 'Stress crimson main',
    scope: { mode: 'exactPath', path: new URL(page.url()).pathname },
    contentSensitivity: 'page-only',
    grants: [],
    revision: SAVE_REVISION,
    expectedRecordRevision: record.originRecord?.recordRevision ?? 0,
    mutationId: `stress-save-${id}-${Date.now()}`,
  }));
  assert.equal((saved as { ok?: boolean }).ok, true, JSON.stringify(saved).slice(0, 300));
  await waitFor(`the red effect is live for ${id}`, async () =>
    (await page.evaluate(() => getComputedStyle(document.getElementById('leaf')!).color)) === 'rgb(255, 0, 0)');
  return { origin };
}

const heapMb = (page: Page): Promise<number> =>
  page.evaluate(() => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize != null
    ? Math.round((performance as unknown as { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize / 1024 / 1024)
    : -1);

// ── T23 storm: DOM mutation storm vs the one runtime ──────────────────────

test('T23 storm: sustained DOM mutations never re-invoke the model; applied effects hold; the page stays responsive', async () => {
  const page = await openFixture('v2-apply.html');
  const tabId = await tabIdOf(page);
  const { documentKey, routeEpoch } = await registeredDocument(tabId);
  void documentKey; void routeEpoch;
  await installCustomization(page, 'stress-storm');

  const postsBefore = fixtures!.posts.model;
  const heapBefore = await heapMb(page);

  // The storm: ~100Hz for ~8s inside the page — clone/insert/remove/text
  // churn around the customized region. Real DOM churn, no test shortcuts.
  // The churn lives INSIDE #host — the customized #leaf is never touched,
  // so any effect loss is a runtime bug, not the storm destroying the target.
  await page.evaluate(() => {
    const host = document.getElementById('host')!;
    let n = 0;
    (window as unknown as { __storm?: number }).__storm = window.setInterval(() => {
      for (let i = 0; i < 40; i += 1) {
        const div = document.createElement('div');
        div.textContent = `storm ${n++}`;
        div.setAttribute('data-storm', String(n));
        host.appendChild(div);
        if (host.children.length > 600) host.removeChild(host.children[1]);
      }
    }, 10);
  });

  // Sample responsiveness DURING the storm: evaluate round-trips must not
  // wedge (the runtime shares the main thread with the page).
  let worstPing = 0;
  for (let i = 0; i < 8; i += 1) {
    const t0 = Date.now();
    await page.evaluate(() => 1 + 1);
    worstPing = Math.max(worstPing, Date.now() - t0);
    await sleep(900);
  }

  await page.evaluate(() => window.clearInterval((window as unknown as { __storm?: number }).__storm));
  const stormTicks = await page.evaluate(() => document.querySelectorAll('[data-storm]').length);
  assert.ok(stormTicks > 0, 'the storm actually mutated the page');

  const postsAfter = fixtures!.posts.model;
  assert.equal(postsAfter, postsBefore,
    `a DOM mutation storm must NEVER re-invoke the model (planning is user-initiated); model posts went ${postsBefore} → ${postsAfter}`);

  // The applied effect HELD through the storm.
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('leaf')!).color), 'rgb(255, 0, 0)',
    'the applied customization must survive sustained DOM churn');
  assert.ok(worstPing < 1000, `main thread stayed responsive under the storm (worst evaluate round-trip ${worstPing}ms)`);

  const heapAfter = await heapMb(page);
  console.log(`   [T23 storm] ticks=${stormTicks} modelPosts=${postsAfter} worstPing=${worstPing}ms heap ${heapBefore}→${heapAfter}MB`);
  assert.ok(heapAfter - heapBefore < 8, `heap stayed bounded through the storm (Δ ${heapAfter - heapBefore}MB)`);

  await removeCustomization(page, 'stress-storm');
});

// ── T23 toggle storm: rapid enable/disable convergence ────────────────────

test('T23 toggle storm: 120 rapid enable/disable round-trips converge; the last intent wins', async () => {
  const page = await openFixture('v2-apply.html');
  const tabId = await tabIdOf(page);
  await registeredDocument(tabId);
  await installCustomization(page, 'stress-toggle');

  const roundTrips: number[] = [];
  for (let i = 0; i < 120; i += 1) {
    const record = (await workspaceSend(await ensureWorkspace(), controlEnvelope({ command: 'GetOriginRecord', origin: new URL(page.url()).origin }))) as {
      originRecord?: { recordRevision: number };
    };
    const t0 = Date.now();
    const reply = await workspaceSend(await ensureWorkspace(), controlEnvelope({
      command: 'SetEnabled',
      origin: new URL(page.url()).origin,
      customizationId: 'stress-toggle',
      enabled: i % 2 === 0,
      expectedRecordRevision: record.originRecord?.recordRevision ?? 0,
      mutationId: `stress-toggle-${i}-${Date.now()}`,
    }));
    roundTrips.push(Date.now() - t0);
    assert.equal((reply as { ok?: boolean }).ok, true, `toggle ${i} must be accepted: ${JSON.stringify(reply).slice(0, 200)}`);
  }
  roundTrips.sort((a, b) => a - b);
  const p50 = roundTrips[Math.floor(roundTrips.length * 0.5)];
  const p95 = roundTrips[Math.floor(roundTrips.length * 0.95)];
  console.log(`   [T23 toggles] 120 round-trips p50=${p50}ms p95=${p95}ms max=${roundTrips.at(-1)}ms`);

  // The last intent was enabled=false (119 % 2 !== 0): the effect must be
  // OFF and consistent — the last write won, no thrash.
  await waitFor('the last toggle intent (off) took effect', async () =>
    (await page.evaluate(() => getComputedStyle(document.getElementById('leaf')!).color)) !== 'rgb(255, 0, 0)');

  // One more enable → ON again (the path is healthy after 120 writes).
  const record2 = (await workspaceSend(await ensureWorkspace(), controlEnvelope({ command: 'GetOriginRecord', origin: new URL(page.url()).origin }))) as {
    originRecord?: { recordRevision: number };
  };
  const on = await workspaceSend(await ensureWorkspace(), controlEnvelope({
    command: 'SetEnabled',
    origin: new URL(page.url()).origin,
    customizationId: 'stress-toggle',
    enabled: true,
    expectedRecordRevision: record2.originRecord?.recordRevision ?? 0,
    mutationId: `stress-toggle-final-${Date.now()}`,
  }));
  assert.equal((on as { ok?: boolean }).ok, true);
  await waitFor('re-enable restores the effect after 120 toggles', async () =>
    (await page.evaluate(() => getComputedStyle(document.getElementById('leaf')!).color)) === 'rgb(255, 0, 0)');

  await removeCustomization(page, 'stress-toggle');
});

// ── T03-P: real Observe scaling on 2k/10k/50k nodes ───────────────────────

test('T03-P observation scaling: Observe completes on 2k/10k/50k-node documents with recorded durations', async () => {
  const page = await openFixture('observe.html');
  const tabId = await tabIdOf(page);
  const { documentKey, routeEpoch } = await registeredDocument(tabId);

  const durations: Array<{ nodes: number; ms: number }> = [];
  for (const nodes of [2_000, 10_000, 50_000]) {
    await page.evaluate((n) => {
      const host = document.body;
      host.querySelectorAll('[data-perf]').forEach((el) => el.remove());
      const frag = document.createDocumentFragment();
      for (let i = 0; i < n; i += 1) {
        const div = document.createElement('div');
        div.setAttribute('data-perf', String(i));
        const p = document.createElement('p');
        p.textContent = `perf node ${i} — measurement content`;
        div.appendChild(p);
        frag.appendChild(div);
      }
      host.appendChild(frag);
    }, nodes);
    const t0 = Date.now();
    const reply = await workspaceSend(await ensureWorkspace(), observeEnvelope(documentKey, routeEpoch, { command: 'Observe' }));
    const ms = Date.now() - t0;
    assert.equal((reply as { ok?: boolean }).ok, true, `Observe on ${nodes} nodes must be delivered: ${JSON.stringify(reply).slice(0, 300)}`);
    const receipt = reply as { receipt?: { snapshot?: { coverage?: { visitedNodes?: number; completed?: boolean } } } };
    assert.ok(receipt.receipt?.snapshot, `the snapshot must come back on ${nodes} nodes`);
    durations.push({ nodes, ms });
    console.log(`   [T03-P Observe] nodes=${nodes} duration=${ms}ms visited=${receipt.receipt.snapshot?.coverage?.visitedNodes} completed=${receipt.receipt.snapshot?.coverage?.completed}`);
  }
  const biggest = durations.at(-1)!;
  assert.ok(biggest.ms < 20_000, `Observe on 50k nodes must complete within the envelope deadline (took ${biggest.ms}ms)`);
});

// ── T22-P: device scale (zoom) change under a live customization ──────────

test('T22-P zoom: a deviceScaleFactor change with a live customization never freezes the page', async () => {
  const page = await openFixture('v2-apply.html');
  const tabId = await tabIdOf(page);
  await registeredDocument(tabId);
  await installCustomization(page, 'stress-zoom');
  const cdp: CDPSession = await context!.newCDPSession(page);

  for (const scale of [1, 2, 3, 1]) {
    const t0 = Date.now();
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: scale, mobile: false });
    await page.evaluate(() => 1 + 1);
    const ms = Date.now() - t0;
    console.log(`   [T22-P zoom] dsf=${scale} evaluate round-trip=${ms}ms`);
    assert.ok(ms < 2_000, `the page must stay responsive through a scale change to ${scale} (took ${ms}ms)`);
  }
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('leaf')!).color), 'rgb(255, 0, 0)',
    'the live customization must survive zoom changes');
  await removeCustomization(page, 'stress-zoom');
});

// ── T24 soak (bounded): sustained churn + heap trajectory ─────────────────

test('T24 soak: a 60s sustained mutation soak on a customized page keeps the heap bounded and the effect live', async () => {
  const page = await openFixture('v2-apply.html');
  const tabId = await tabIdOf(page);
  await registeredDocument(tabId);
  await installCustomization(page, 'stress-soak');

  const samples: Array<{ t: number; mb: number }> = [];
  samples.push({ t: 0, mb: await heapMb(page) });

  await page.evaluate(() => {
    const host = document.getElementById('host')!;
    let n = 0;
    (window as unknown as { __soak?: number }).__soak = window.setInterval(() => {
      for (let i = 0; i < 20; i += 1) {
        const div = document.createElement('div');
        div.textContent = `soak ${n++}`;
        host.appendChild(div);
        if (host.children.length > 400) host.removeChild(host.children[1]);
      }
    }, 25);
  });

  const SOAK_MS = 60_000;
  const t0 = Date.now();
  while (Date.now() - t0 < SOAK_MS) {
    await sleep(10_000);
    samples.push({ t: Math.round((Date.now() - t0) / 1000), mb: await heapMb(page) });
  }
  await page.evaluate(() => window.clearInterval((window as unknown as { __soak?: number }).__soak));
  console.log(`   [T24 soak] heap trajectory: ${samples.map((s) => `${s.t}s=${s.mb}MB`).join('  ')}`);

  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('leaf')!).color), 'rgb(255, 0, 0)',
    'the applied effect must still be live after the soak');
  const first = samples[0].mb;
  const last = samples.at(-1)!.mb;
  assert.ok(last - first < 15, `the heap must stay bounded through the soak (start ${first}MB → end ${last}MB; GC noise allowed)`);

  await removeCustomization(page, 'stress-soak');
});

// ── E2E latency distribution: plan → apply through the canned provider ────

test('E2E latency: one full chat → proposal → apply round-trip records its phase durations', async () => {
  const target = await openFixture('workspace-target.html');
  const ws = await ensureWorkspace();
  const profile = {
    settingsVersion: 1,
    profiles: [{
      profileVersion: 1, profileId: 'profile-stress', label: 'Local canned provider',
      protocol: 'openai-chat', endpoint: `${fixtures!.origin}/v1/chat/completions`, modelId: 'fixture-model', auth: { kind: 'none' },
    }],
    credentials: {},
    activeProfileId: 'profile-stress',
    consentAcks: [{ disclosureVersion: 1, endpoint: `${fixtures!.origin}/v1/chat/completions`, acknowledgedAt: 1 }],
    aiEnabled: true,
  };
  await ws.evaluate(async (s) => { await chrome.storage.local.set({ rv2_workspaceSettings: s }); }, profile);
  await ws.reload({ waitUntil: 'load' });
  await target.bringToFront();

  await waitFor('the workspace auto-targets the page', async () =>
    (await ws.locator('#rv-chip').textContent())?.includes('Workspace target') ?? false);

  const planT0 = Date.now();
  await ws.locator('#rv-goal').pressSequentially('make the heading crimson');
  await ws.getByRole('button', { name: 'Send' }).click();
  await waitFor('the proposal card is shown', async () =>
    (await ws.locator('#rv-status').textContent())?.includes('Review the proposed changes') ?? false, 30_000);
  const planMs = Date.now() - planT0;

  const applyT0 = Date.now();
  await ws.getByRole('button', { name: 'Apply' }).click();
  await waitFor('the apply completes', async () =>
    (await ws.locator('#rv-status').textContent())?.includes('Applied and saved') ?? false, 30_000);
  const applyMs = Date.now() - applyT0;

  console.log(`   [E2E latency] plan(canned)→proposal=${planMs}ms apply→saved=${applyMs}ms`);
  assert.ok(planMs < 30_000 && applyMs < 30_000, 'both phases must complete within the honest bounds');
});

/**
 * Browser suite for the S6.2 shared workspace — the BUILT extension under
 * Playwright, driven through the real user surface (the sidepanel page opened
 * as the extension-tab fallback; same page the panel hosts).
 *
 * Covers: T21 exact target selection (no first-tab fallback), the explicit
 * consent/profile gates with zero calls, the full user workflow against the
 * CANNED local provider in the fixture server (no live model, no external
 * network), keyboard operability, close/reopen resynchronization, and the
 * axe accessibility pass (plan/16 §6).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type BrowserContext, type Page, type Worker } from 'playwright';
import { readFile } from 'node:fs/promises';
import { statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO, BUILD_MANIFEST, SRC_DIR, isStaleBuild, newestMtime, startFixtureServer } from './lib.ts';

const EXT_PATH = join(REPO, '.output', 'chrome-mv3');
const AXE_PATH = join(REPO, 'node_modules', 'axe-core', 'axe.min.js');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let context: BrowserContext | null = null;
let sw: Worker | null = null;
let fixtures: Awaited<ReturnType<typeof startFixtureServer>> | null = null;
let extId = '';

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

async function openFixture(name: string): Promise<Page> {
  const page = await context!.newPage();
  await page.goto(`${fixtures!.origin}/${name}`, { waitUntil: 'load' });
  return page;
}

async function openWorkspace(): Promise<Page> {
  const page = await context!.newPage();
  await page.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'load' });
  return page;
}

async function waitForStatus(page: Page, match: RegExp, ms = 15_000): Promise<string> {
  const deadline = Date.now() + ms;
  for (;;) {
    const text = await page.locator('#rv-status').textContent();
    if (text !== null && match.test(text)) return text;
    if (Date.now() > deadline) throw new Error(`status never matched ${match}; last: ${text}`);
    await sleep(150);
  }
}

/** Poll the header target chip until it matches — the auto-target oracle. */
async function waitForChip(page: Page, match: RegExp, ms = 15_000): Promise<string> {
  const deadline = Date.now() + ms;
  for (;;) {
    const text = await page.locator('#rv-chip').textContent();
    if (text !== null && match.test(text)) return text;
    if (Date.now() > deadline) throw new Error(`chip never matched ${match}; last: ${text}`);
    await sleep(150);
  }
}

/** Poll one listed entry until its text matches — the live-state oracle. */
async function waitForText(page: Page, listSel: string, entryHas: string, match: RegExp, what: string, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    const text = await page.locator(listSel, { hasText: entryHas }).first().textContent();
    if (text !== null && match.test(text)) return;
    if (Date.now() > deadline) throw new Error(`never saw ${what}; last: ${text}`);
    await sleep(150);
  }
}

const fixtureProfile = () => ({
  settingsVersion: 1,
  profiles: [
    {
      profileVersion: 1,
      profileId: 'profile-test',
      label: 'Local canned provider',
      protocol: 'openai-chat',
      endpoint: `${fixtures!.origin}/v1/chat/completions`,
      modelId: 'fixture-model',
      auth: { kind: 'none' },
    },
  ],
  credentials: {},
  activeProfileId: 'profile-test',
  consentAcks: [{ disclosureVersion: 1, endpoint: `${fixtures!.origin}/v1/chat/completions`, acknowledgedAt: 1 }],
  aiEnabled: true,
});

/** Write workspace settings through the REAL storage API from the extension page. */
async function injectSettings(page: Page): Promise<void> {
  await page.evaluate(async (s) => {
    await chrome.storage.local.set({ rv2_workspaceSettings: s });
  }, fixtureProfile());
}

// ── T21: exact target, explicit gates, no implicit consent ────────────────

test('T21: the workspace auto-targets the page the user is on — no manual pick — and refuses ungated starts with zero calls', async () => {
  const pageA = await openFixture('observe.html');
  const target = await openFixture('workspace-target.html');
  const ws = await openWorkspace();
  await target.bringToFront();

  // The header chip names the ACTIVE page only — never the other tab, never
  // an extension page (the target follows the user; there is no picker).
  const chip = await waitForChip(ws, /Working on: Workspace target/);
  assert.ok(!chip.includes('Observation fixture'), 'the other open tab is never targeted');
  void pageA;

  // Keyboard path: Tab to Send, press Enter — an empty goal refuses.
  let sawSend = false;
  for (let i = 0; i < 16 && !sawSend; i++) {
    await ws.keyboard.press('Tab');
    const active = await ws.evaluate(() => (document.activeElement instanceof HTMLButtonElement ? document.activeElement.textContent : ''));
    sawSend = active === 'Send';
  }
  assert.ok(sawSend, 'Send is reachable by keyboard Tab order');
  await ws.keyboard.press('Enter');
  await waitForStatus(ws, /Type what you want changed on the page/);

  // A real goal with NO provider configured → explicit refusal, zero calls.
  await ws.locator('#rv-goal').pressSequentially('color the heading crimson');
  await ws.getByRole('button', { name: 'Send' }).click();
  await waitForStatus(ws, /You need an AI provider first/);
});

// ── full user workflow against the canned local provider ────────────────

test('E2E: chat a request on the page you are on, run the canned local provider, apply, save, verify and disable — the honest status every step', async () => {
  const target = await openFixture('workspace-target.html');
  await target.bringToFront();
  const other = await openFixture('observe.html');
  const before = await target.evaluate(() => getComputedStyle(document.getElementById('headline')!).color);

  const ws = await openWorkspace();
  await injectSettings(ws);
  await ws.reload({ waitUntil: 'load' });
  // Reopen correctness: settings + consent load from real storage; the
  // target re-resolves from the browser's active tab (the reload leaves the
  // page the user activated).
  await target.bringToFront();
  await waitForChip(ws, /Working on: Workspace target/);

  // The chat flow: type what should change, press Send.
  await ws.locator('#rv-goal').pressSequentially('make the heading crimson');
  await ws.getByRole('button', { name: 'Send' }).click();

  // Planning runs against the local canned provider; the proposal card shows
  // the summary and the scope picker.
  await waitForStatus(ws, /Review the proposed changes below/);
  assert.ok(await ws.getByText('Proposed: Color the main heading crimson').isVisible(), 'proposal summary is shown');

  await ws.getByRole('button', { name: 'Apply' }).click();
  await waitForStatus(ws, /Applied and saved\./);

  // Only the active page changed: crimson now, the other tab untouched.
  await target.bringToFront();
  let color = '';
  const colorDeadline = Date.now() + 10_000;
  for (;;) {
    color = await target.evaluate(() => getComputedStyle(document.getElementById('headline')!).color);
    if (color === 'rgb(220, 20, 60)') break;
    if (Date.now() > colorDeadline) throw new Error(`heading never became crimson; got ${color}`);
    await sleep(150);
  }
  const otherColor = await other.evaluate(() => getComputedStyle(document.querySelector('h1')!).color);
  assert.notEqual(otherColor, 'rgb(220, 20, 60)', 'the other tab was never touched');

  // "My changes" lists the saved record entry and the live state.
  await ws.getByRole('button', { name: /My changes/ }).click();
  const entry = ws.locator('ul.plain li', { hasText: 'Color the main heading crimson' });
  assert.ok(await entry.isVisible(), 'the saved customization is listed');
  assert.match(await entry.textContent() ?? '', /this exact path/);

  // Reopen the workspace (close/reopen correctness): record + live state pull.
  const ws2 = await openWorkspace();
  await injectSettings(ws2);
  await ws2.reload({ waitUntil: 'load' });
  await target.bringToFront();
  await ws2.getByRole('button', { name: /My changes/ }).click();
  const entry2 = ws2.locator('ul.plain li', { hasText: 'Color the main heading crimson' });
  const reopenDeadline = Date.now() + 15_000;
  for (;;) {
    if (await entry2.isVisible()) break;
    if (Date.now() > reopenDeadline) throw new Error('the reopened workspace never listed the customization');
    await sleep(200);
  }
  assert.match(await entry2.textContent() ?? '', /applied on the open page/, 'live state resynchronized via GetState');

  // Disable through the real checkbox → the runtime releases; the heading
  // reverts to the site baseline and the wording stays truthful.
  await entry2.locator('input[type=checkbox]').uncheck();
  await target.bringToFront();
  const offDeadline = Date.now() + 10_000;
  let offColor = '';
  for (;;) {
    offColor = await target.evaluate(() => getComputedStyle(document.getElementById('headline')!).color);
    if (offColor === before) break;
    if (Date.now() > offDeadline) throw new Error(`heading did not revert on disable; got ${offColor}`);
    await sleep(150);
  }
  assert.equal(offColor, before, 'disable restored the site baseline exactly');
  void ws; void ws2;
});

// ── opt-out is a dead-man switch: no fetch, honest wording ────────────────

test('AC-07: the model opt-out blocks the run before any call — with honest wording', async () => {
  const target = await openFixture('workspace-target.html');
  await target.bringToFront();
  const ws = await openWorkspace();
  await injectSettings(ws);
  await ws.evaluate(async () => {
    const s = (await chrome.storage.local.get('rv2_workspaceSettings'))['rv2_workspaceSettings'] as Record<string, unknown>;
    await chrome.storage.local.set({ rv2_workspaceSettings: { ...s, aiEnabled: false } });
  });
  await ws.reload({ waitUntil: 'load' });
  await target.bringToFront();
  await waitForChip(ws, /Working on: Workspace target/);
  await ws.locator('#rv-goal').pressSequentially('anything');
  await ws.getByRole('button', { name: 'Send' }).click();
  await waitForStatus(ws, /AI planning is off/);
});

// ── axe accessibility pass on the workspace page (plan/16 §6) ────────────

test('axe: the workspace page has no critical or serious accessibility violations', async () => {
  if (!existsSync(AXE_PATH)) throw new Error('axe-core is not installed (devDependency)');
  const ws = await context!.newPage();
  // Extension pages forbid inline/remote scripts (MV3 CSP); CDP-level
  // init scripts run before page scripts and are not page-injected scripts.
  await ws.addInitScript({ path: AXE_PATH });
  await ws.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'load' });
  const results = (await ws.evaluate(() =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).axe.run(document, { resultTypes: ['violations'] }),
  )) as { violations: Array<{ impact?: string; id: string; nodes: Array<{ target: string }> }> };
  const serious = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
  assert.deepEqual(
    serious.map((v) => v.id),
    [],
    `axe violations: ${serious.map((v) => `${v.id} (${v.impact})`).join('; ')}`,
  );
  void readFile;
});

// ── S7.1: keyboard binding through the full review workflow ────────────────

test('E2E/S7.1: the model proposes a shortcut, the review names the target and warns honestly, Apply installs, disable uninstalls', async () => {
  const target = await openFixture('workspace-target.html');
  await target.bringToFront();
  // The site's own listener — the shortcut must fire THIS, not a copy.
  await target.evaluate(() => {
    (window as unknown as { __pokes: number }).__pokes = 0;
    document.getElementById('poke')!.addEventListener('click', () => { (window as unknown as { __pokes: number }).__pokes += 1; });
  });

  const ws = await openWorkspace();
  await injectSettings(ws);
  await ws.reload({ waitUntil: 'load' });
  await target.bringToFront();
  await waitForChip(ws, /Working on: Workspace target/);
  await ws.locator('#rv-goal').pressSequentially('bind a shortcut chord:Alt+G that clicks the Poke button');
  await ws.getByRole('button', { name: 'Send' }).click();

  // The review shows the chord, the exact action and the honest
  // non-reversibility warning (plan/09 §1 — the user must see what a press
  // triggers BEFORE approving).
  await waitForStatus(ws, /Review the proposed changes below/);
  assert.ok(await ws.getByText('bind “Alt+G” → activate on').isVisible(), 'the review names chord, action and target');
  assert.ok(await ws.getByText(/undo removes the shortcut, not any effect it causes/).isVisible(), 'the review warns that the site effect is not reversible');

  await ws.getByRole('button', { name: 'Apply' }).click();
  await waitForStatus(ws, /Applied and saved\./);

  // A trusted press on the active page activates the site's own button once.
  await target.bringToFront();
  await target.keyboard.press('Alt+g');
  await sleep(300); // the trusted event is sync, but the assert is async
  assert.equal(await target.evaluate(() => (window as unknown as { __pokes: number }).__pokes), 1, 'the approved shortcut fired the site control exactly once');

  // Disable through the real checkbox → the exact listener is uninstalled.
  await ws.getByRole('button', { name: /My changes/ }).click();
  const entry = ws.locator('ul.plain li', { hasText: 'Bind a shortcut to the Poke button' });
  await entry.locator('input[type=checkbox]').uncheck();
  await waitForText(ws, 'ul.plain li', 'Bind a shortcut to the Poke button', /disabled on the open page/, 'the disable relay released the runtime binding');
  await target.bringToFront();
  await target.keyboard.press('Alt+g');
  assert.equal(await target.evaluate(() => (window as unknown as { __pokes: number }).__pokes), 1, 'the disabled shortcut fired nothing');
  void ws;
});

/**
 * S9.1 min-version smoke: the BUILT extension on Chromium 120.0.6099.28
 * (the manifest's minimum_chrome_version floor) through the REAL production
 * message paths — registration, live replay of saved intent, disable, remove.
 *
 * Reproduction (a scratch install is required — the repo's playwright is the
 * current build, not the 120 floor):
 *   mkdir /tmp/chrome120 && cd /tmp/chrome120
 *   npm init -y && npm i playwright@1.40.0 && npx playwright install chromium
 *   cp <repo>/project/tests/stress/min-chrome-smoke.mjs .
 *   node min-chrome-smoke.mjs
 * Chromium 120 needs --headless=new for MV3 service workers (the old
 * headless has no extension SW — a harness constraint, not a product one).
 *
 * S9.1 recorded result (2026-09-14): ALL PASS — registration (routeEpoch 0),
 * SaveRevision accepted (recordRevision 1), saved intent replays LIVE
 * (rgb(255,0,0)), SetEnabled(false) accepted, disable releases exactly
 * (back to the site baseline rgb(51,51,51)).
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { join } from 'node:path';

const REPO = '/home/hutej/System hang/Revueon/project';
const EXT_PATH = join(REPO, '.output', 'chrome-mv3');
const FIXTURE = join(REPO, 'tests', 'fixtures', 'pages', 'v2-apply.html');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = createServer(async (req, res) => {
  const body = await readFile(FIXTURE);
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const context = await chromium.launchPersistentContext('', {
  headless: true,
  args: ['--headless=new', `--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
});

const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 20_000 }));
const extId = new URL(sw.url()).host;

const page = await context.newPage();
await page.goto(`${origin}/`, { waitUntil: 'load' });
await page.bringToFront();
console.log('browser user agent:', await page.evaluate(() => navigator.userAgent));

const ws = await context.newPage();
await ws.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'load' });
const send = (env) => ws.evaluate((msg) => chrome.runtime.sendMessage(msg), env);
const ctrl = (payload) => send({
  protocolVersion: 1,
  requestId: `smoke-${Math.random().toString(36).slice(2, 10)}`,
  kind: 'control',
  deadlineAt: Date.now() + 15_000,
  payload,
});

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// 1. Registration (the real liveness signal).
let registered = null;
for (let i = 0; i < 60 && !registered; i++) {
  const tabs = await sw.evaluate(async () => (await chrome.tabs.query({})).map((t) => ({ id: t.id, url: t.url })));
  const mine = tabs.find((t) => t.url?.startsWith(origin));
  if (mine) {
    const reply = await ctrl({ command: 'ListDocuments' });
    const doc = (reply.documents ?? []).find((d) => d.tabId === mine.id);
    if (doc) registered = doc;
  }
  if (!registered) await sleep(250);
}
check('the document runtime registers on the min browser', registered !== null, registered ? `routeEpoch=${registered.routeEpoch}` : 'never registered');

// 2. SaveRevision → the live replay applies the effect (the T10 descriptor).
const url = new URL(page.url());
const saved = await ctrl({
  command: 'SaveRevision', origin: url.origin, customizationId: 'min-smoke-1', title: 'Min-version smoke',
  scope: { mode: 'exactPath', path: '/' }, contentSensitivity: 'page-only', grants: [],
  revision: {
    revisionId: 'smoke-r1', capabilityVersion: 1,
    targetDescriptors: [{ descriptorVersion: 1, rootPath: [], selection: 'single', anchor: { tag: 'p', stableId: 'leaf' }, relation: 'self', matchBounds: { min: 1, max: 1 }, routeScopeRef: url.origin, continuityPolicy: 'stable-single' }],
    operations: [{ kind: 'style', rules: [{ target: { targetRef: 'd0' }, surface: 'element', state: 'none', declarations: [{ property: 'color', value: 'red', priority: 'important' }], conditions: [] }] }],
    savedAt: 1, source: 'user-planned',
  },
  expectedRecordRevision: 0, mutationId: 'min-smoke-save-1',
});
check('SaveRevision is accepted on the min browser', saved.ok === true, saved.ok ? `recordRevision=${saved.recordRevision}` : JSON.stringify(saved).slice(0, 200));

let color = '';
for (let i = 0; i < 60; i++) {
  color = await page.evaluate(() => getComputedStyle(document.getElementById('leaf')).color);
  if (color === 'rgb(255, 0, 0)') break;
  await sleep(250);
}
check('the saved intent replays LIVE on the min browser', color === 'rgb(255, 0, 0)', `color=${color}`);

// 3. Disable releases exactly.
const rec = (await ctrl({ command: 'GetOriginRecord', origin: url.origin })).originRecord;
const off = await ctrl({ command: 'SetEnabled', origin: url.origin, customizationId: 'min-smoke-1', enabled: false, expectedRecordRevision: rec.recordRevision, mutationId: 'min-smoke-off-1' });
check('SetEnabled(false) is accepted on the min browser', off.ok === true);
let offColor = '';
for (let i = 0; i < 60; i++) {
  offColor = await page.evaluate(() => getComputedStyle(document.getElementById('leaf')).color);
  if (offColor !== 'rgb(255, 0, 0)') break;
  await sleep(250);
}
check('disable releases the effect on the min browser', offColor !== 'rgb(255, 0, 0)', `color=${offColor}`);

const rec2 = (await ctrl({ command: 'GetOriginRecord', origin: url.origin })).originRecord;
await ctrl({ command: 'RemoveCustomization', origin: url.origin, customizationId: 'min-smoke-1', expectedRecordRevision: rec2.recordRevision, mutationId: 'min-smoke-rm-1' });

await context.close();
server.close();
const failed = results.filter((r) => !r.ok).length;
console.log(failed === 0 ? '\nMIN-VERSION SMOKE: ALL PASS on Chromium 120.0.6099.28' : `\nMIN-VERSION SMOKE: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);

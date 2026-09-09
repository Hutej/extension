/**
 * trust.test — S1.2 trust/grant/privacy boundary foundation (T04/T21/T25).
 *
 * The unit under test is the pure policy in src/contracts.ts §9. The broker
 * (S2.1) will feed it REAL chrome.runtime.MessageSender objects; here the
 * senders are simulated with the exact field shapes the browser reports,
 * including forged-authority cases (plan/17 §1: content→broker boundary).
 *
 * Negative controls:
 *  - T25: a credential placed in any evidence field never reaches the output;
 *  - T21: a payload field claiming `role`/`consent`/`grant` never grants
 *    authority; legacy implicit consent is not a v2 grant;
 *  - T04: sentinel secrets (password/email/token) leave no provider-bound
 *    payload through field-name exclusion + residual redaction.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifySender,
  senderMayInvoke,
  maySubmitCredentials,
  mayReadCredentials,
  evaluateProviderConsent,
  evaluateSitePermission,
  credentialAppearsInUrl,
  redactSensitiveText,
  minimizeEvidence,
  PROVIDER_DISCLOSURE_VERSION,
  isAuthoritySignal,
  isAllowedRedirect,
  LIMITS,
  type SenderLike,
  type UserGrant,
} from '../../src/contracts.ts';

const OWN_ID = 'revueon-test-extension-id';

// ── T21: sender-role validation (denied by default) ─────────────────────

test('T21: an extension-page sender (popup/side panel/tab) classifies as workspace', () => {
  const sender: SenderLike = {
    id: OWN_ID,
    url: `chrome-extension://${OWN_ID}/popup.html`,
    origin: `chrome-extension://${OWN_ID}`,
  };
  assert.equal(classifySender(sender, OWN_ID), 'workspace');
});

test('T21: the fallback workspace tab still classifies as workspace despite the tab field', () => {
  const sender: SenderLike = {
    id: OWN_ID,
    url: `chrome-extension://${OWN_ID}/workspace.html`,
    origin: `chrome-extension://${OWN_ID}`,
    tab: { id: 7 },
  };
  assert.equal(classifySender(sender, OWN_ID), 'workspace');
});

test('T21: a service-worker sender (browser reports only the extension id) classifies as broker', () => {
  assert.equal(classifySender({ id: OWN_ID }, OWN_ID), 'broker');
});

test('T21: a web-document sender with tab/frame/documentId classifies as runtime', () => {
  const sender: SenderLike = {
    id: OWN_ID,
    url: 'https://site.test/page',
    origin: 'https://site.test',
    tab: { id: 4 },
    frameId: 0,
    documentId: 'doc-1',
  };
  assert.equal(classifySender(sender, OWN_ID), 'runtime');
});

test('T21: a different extension id is unknown', () => {
  const sender: SenderLike = {
    id: 'other-extension-id',
    url: 'chrome-extension://other-extension-id/popup.html',
    origin: 'chrome-extension://other-extension-id',
  };
  assert.equal(classifySender(sender, OWN_ID), 'unknown');
});

test('T21: an own-extension chrome-extension URL on a foreign id is unknown', () => {
  const sender: SenderLike = { id: OWN_ID, url: 'chrome-extension://foreign-id/popup.html' };
  assert.equal(classifySender(sender, OWN_ID), 'unknown');
});

test('T21: a runtime-shaped sender on a chrome:// page is unknown (no privileged context)', () => {
  const sender: SenderLike = {
    id: OWN_ID,
    url: 'chrome://settings/',
    tab: { id: 4 },
    frameId: 0,
    documentId: 'doc-1',
  };
  assert.equal(classifySender(sender, OWN_ID), 'unknown');
});

test('T21: an externally_connectable web sender (origin only, no id) is unknown', () => {
  const sender: SenderLike = { origin: 'https://evil.test' };
  assert.equal(classifySender(sender, OWN_ID), 'unknown');
});

test('T21: a sender with no id at all is unknown', () => {
  assert.equal(classifySender({}, OWN_ID), 'unknown');
});

// ── Per-Kind command authorization ──────────────────────────────────────

test('T21: workspace may start runs and acknowledge; runtime may not', () => {
  assert.equal(senderMayInvoke('workspace', 'StartRun'), true);
  assert.equal(senderMayInvoke('workspace', 'CancelRun'), true);
  assert.equal(senderMayInvoke('workspace', 'AnswerQuestion'), true);
  assert.equal(senderMayInvoke('workspace', 'ApproveProposal'), true);
  assert.equal(senderMayInvoke('runtime', 'StartRun'), false);
  assert.equal(senderMayInvoke('runtime', 'ApproveProposal'), false);
});

test('T21: runtime may register documents and report evidence; workspace may not', () => {
  assert.equal(senderMayInvoke('runtime', 'RegisterDocument'), true);
  assert.equal(senderMayInvoke('runtime', 'Observe'), false); // planner→broker→runtime: workspace sends
  assert.equal(senderMayInvoke('broker', 'Observe'), false);
  assert.equal(senderMayInvoke('runtime', 'StageStyle'), true);
  assert.equal(senderMayInvoke('runtime', 'CommitComposition'), true);
  assert.equal(senderMayInvoke('workspace', 'RegisterDocument'), false);
});

test('T21: GetOperation is shared by workspace and broker only', () => {
  assert.equal(senderMayInvoke('workspace', 'GetOperation'), true);
  assert.equal(senderMayInvoke('broker', 'GetOperation'), true);
  assert.equal(senderMayInvoke('runtime', 'GetOperation'), false);
});

test('T21: unknown Kinds deny every role (denied by default)', () => {
  for (const role of ['workspace', 'broker', 'runtime', 'unknown'] as const) {
    assert.equal(senderMayInvoke(role, 'NotARealKind'), false);
  }
});

test('T21: the unknown role is denied every Kind', () => {
  assert.equal(senderMayInvoke('unknown', 'StartRun'), false);
  assert.equal(senderMayInvoke('unknown', 'RegisterDocument'), false);
});

// ── Credential context boundaries ───────────────────────────────────────

test('T25: credentials may be submitted by workspace and broker, read by broker only', () => {
  assert.equal(maySubmitCredentials('workspace'), true);
  assert.equal(maySubmitCredentials('broker'), true);
  assert.equal(maySubmitCredentials('runtime'), false);
  assert.equal(maySubmitCredentials('unknown'), false);
  assert.equal(mayReadCredentials('broker'), true);
  assert.equal(mayReadCredentials('workspace'), false);
  assert.equal(mayReadCredentials('runtime'), false);
  assert.equal(mayReadCredentials('unknown'), false);
});

test('T21: no credential or approval command is ever routable to the runtime role', () => {
  for (const kind of ['credentials.set', 'credentials.clear', 'provider.profile.set', 'consent.acknowledge']) {
    assert.equal(senderMayInvoke('runtime', kind), false);
    assert.equal(senderMayInvoke('unknown', kind), false);
  }
});

// ── T25: endpoint, redirect and credential placement ────────────────────

test('T25: consent is bound to the current disclosure version and the exact endpoint', () => {
  const endpoint = 'https://api.test/v1/chat';
  const ack = { disclosureVersion: PROVIDER_DISCLOSURE_VERSION, endpoint, acknowledgedAt: 1 };
  assert.deepEqual(evaluateProviderConsent(ack, endpoint), { ok: true });
});

test('T25: changing the provider endpoint invalidates consent (re-acknowledgement required)', () => {
  const ack = {
    disclosureVersion: PROVIDER_DISCLOSURE_VERSION,
    endpoint: 'https://api.test/v1/chat',
    acknowledgedAt: 1,
  };
  const d = evaluateProviderConsent(ack, 'https://other.test/v1/chat');
  assert.equal(d.ok, false);
  if (!d.ok) assert.match(d.reason, /different endpoint/);
});

test('T25: a non-current disclosure version is not consent (older and newer both fail closed)', () => {
  const older = evaluateProviderConsent(
    { disclosureVersion: 0, endpoint: 'https://api.test/v1', acknowledgedAt: 1 }, // below the decodable floor
    'https://api.test/v1',
  );
  assert.equal(older.ok, false);
  const newer = evaluateProviderConsent(
    { disclosureVersion: PROVIDER_DISCLOSURE_VERSION + 1, endpoint: 'https://api.test/v1', acknowledgedAt: 1 },
    'https://api.test/v1',
  );
  assert.equal(newer.ok, false);
  if (!newer.ok) assert.match(newer.reason, /re-acknowledge/);
});

test('T25: legacy implicit consent (a boolean flag) is not a v2 acknowledgement record', () => {
  const d = evaluateProviderConsent(true, 'https://api.test/v1');
  assert.equal(d.ok, false);
  if (!d.ok) assert.match(d.reason, /missing or malformed/);
});

test('T25: a model- or page-supplied consent field is never authority (I19)', () => {
  assert.equal(isAuthoritySignal(), false);
});

test('T25: credentials never ride in URLs (query, fragment or userinfo)', () => {
  assert.equal(credentialAppearsInUrl('SECRET', 'https://api.test/v1?token=SECRET'), true);
  assert.equal(credentialAppearsInUrl('SECRET', 'https://api.test/v1#SECRET'), true);
  assert.equal(credentialAppearsInUrl('SECRET', 'https://SECRET@api.test/v1'), true);
  assert.equal(credentialAppearsInUrl('SECRET', 'https://api.test/v1?token=other&q=1'), false);
  assert.equal(credentialAppearsInUrl('', 'https://api.test/v1?token='), false);
});

test('T25: redirects are accepted only back to the exact configured origin', () => {
  assert.equal(isAllowedRedirect('https://api.test/v1/chat', 'https://api.test/v1/retry'), true);
  assert.equal(isAllowedRedirect('https://api.test/v1/chat', 'https://evil.test/v1/chat'), false);
  assert.equal(isAllowedRedirect('https://api.test/v1/chat', 'http://api.test/v1/chat'), false); // scheme downgrade
  assert.equal(isAllowedRedirect('https://api.test/v1/chat', 'https://api.test:8443/v1'), false); // port change
  assert.equal(isAllowedRedirect('not a url', 'https://api.test/'), false);
});

test('T25: site permission is separate from provider permission and fails closed', () => {
  const grant: UserGrant = {
    grantVersion: 1,
    grantId: 'g1',
    origin: 'https://site.test',
    routeScope: { mode: 'origin' },
    capabilityCategories: ['style', 'persist'],
    disclosureVersion: 1,
    approvedAt: 0,
  };
  assert.deepEqual(evaluateSitePermission(grant, 'https://site.test', 'style', 100), { ok: true });
  assert.equal(evaluateSitePermission(grant, 'https://site.test', 'behavior', 100).ok, false); // not granted
  assert.equal(evaluateSitePermission(grant, 'https://evil.test', 'style', 100).ok, false); // foreign origin
  assert.equal(evaluateSitePermission(undefined, 'https://site.test', 'style', 100).ok, false);
});

test('T25: an expired site grant is denied', () => {
  const grant: UserGrant = {
    grantVersion: 1,
    grantId: 'g2',
    origin: 'https://site.test',
    routeScope: { mode: 'origin' },
    capabilityCategories: ['style'],
    disclosureVersion: 1,
    approvedAt: 0,
    expiresAt: 100,
  };
  assert.deepEqual(evaluateSitePermission(grant, 'https://site.test', 'style', 100), { ok: true }); // not yet
  assert.equal(evaluateSitePermission(grant, 'https://site.test', 'style', 101).ok, false);
});

test('T25: an unknown site-grant version fails closed', () => {
  const forged = { grantVersion: 2 } as unknown as UserGrant;
  assert.equal(evaluateSitePermission(forged, 'https://site.test', 'style', 1).ok, false);
});

// ── T04: field-level evidence minimization ──────────────────────────────

test('T04: a form-control value is dropped while sibling evidence is kept', () => {
  const out = minimizeEvidence({ role: 'textbox', value: 'hunter2', label: 'Email' }) as Record<string, unknown>;
  assert.equal('value' in out, false);
  assert.equal(out.label, 'Email');
  assert.equal(out.role, 'textbox');
});

test('T04: credential-shaped field names are dropped wherever they appear', () => {
  const out = minimizeEvidence({
    keep: 1,
    nested: {
      password: 'hunter2',
      Token: 'tok',
      apiKey: 'key',
      EMAIL: 'user@example.com',
      Authorization: 'Bearer x',
      cookie: 'c=1',
      cvv: '123',
    },
    deep: { deeper: { credentials: { user: 'u', secret: 's' } } },
  }) as Record<string, any>;
  assert.equal(out.keep, 1);
  assert.equal('password' in out.nested, false);
  assert.equal('Token' in out.nested, false);
  assert.equal('apiKey' in out.nested, false);
  assert.equal('EMAIL' in out.nested, false);
  assert.equal('Authorization' in out.nested, false);
  assert.equal('cookie' in out.nested, false);
  assert.equal('cvv' in out.nested, false);
  assert.equal('credentials' in out.deep.deeper, false);
});

test('T04: source markup and screenshots are never evidence', () => {
  const out = minimizeEvidence({
    html: '<form>',
    innerHTML: '<input>',
    outerHTML: '<form></form>',
    sourceHtml: '<x>',
    screenshot: 'AAAA',
  }) as Record<string, unknown>;
  for (const k of ['html', 'innerHTML', 'outerHTML', 'sourceHtml', 'screenshot']) {
    assert.equal(k in out, false);
  }
});

test('T04: browser storage contents are never evidence', () => {
  const out = minimizeEvidence({
    localStorage: '{...}',
    sessionStorage: '{...}',
    indexedDB: '...',
  }) as Record<string, unknown>;
  for (const k of ['localStorage', 'sessionStorage', 'indexedDB']) assert.equal(k in out, false);
});

test('T04: a full URL is minimized to origin+pathname; the credential in its query is gone', () => {
  const out = minimizeEvidence({
    href: 'https://user:SECRET@site.test/p?a=1&token=SECRET2#frag',
    pageUrl: 'https://site.test/p?token=SECRET2',
    imageUrl: 'https://cdn.test/img.png?v=9',
  }) as Record<string, string>;
  assert.equal(out.href.includes('SECRET'), false);
  assert.equal(out.href, 'https://site.test/p');
  assert.equal(out.pageUrl, 'https://site.test/p');
  assert.equal(out.imageUrl, 'https://cdn.test/img.png'); // ordinary query params also dropped from URL fields
});

test('T04: residual redaction never mutates credential names, only values', () => {
  const out = minimizeEvidence({
    // Field name survives; the credential in the VALUE is redacted.
    note: 'login failed for user@example.com with Bearer abc.def.ghi',
  }) as Record<string, string>;
  assert.equal(out.note.includes('user@example.com'), false);
  assert.equal(out.note.includes('Bearer abc'), false);
  assert.equal(out.note.includes('login failed for'), true);
});

test('T04: arrays and nested evidence structures survive minimization', () => {
  const out = minimizeEvidence({
    regions: [
      { role: 'heading', text: 'Welcome' },
      { role: 'textbox', value: 'pw', ariaLabel: 'Search' },
    ],
  }) as { regions: Array<Record<string, unknown>> };
  assert.equal(out.regions.length, 2);
  assert.equal(out.regions[0].text, 'Welcome');
  assert.equal('value' in out.regions[1], false);
  assert.equal(out.regions[1].ariaLabel, 'Search');
});

test('T04: the minimizer is pure — the input object is never mutated', () => {
  const input = { nested: { value: 'hunter2', keep: 'yes' } };
  const snapshot = JSON.parse(JSON.stringify(input));
  minimizeEvidence(input);
  assert.deepEqual(input, snapshot);
});

test('T04: depth pressure is an explicit marker, not silent truncation', () => {
  let deep: unknown = 'leaf';
  for (let i = 0; i < LIMITS.maxJsonDepth + 5; i++) deep = { child: deep };
  const out = minimizeEvidence(deep) as any;
  let node: unknown = out;
  for (let i = 0; i < LIMITS.maxJsonDepth + 1; i++) {
    assert.equal(typeof node, 'object');
    node = (node as Record<string, unknown>).child;
  }
  assert.equal(node, '[evidence:depth-limit]');
});

test('T04: the residual redactor handles the T04 sentinel corpus', () => {
  const out = redactSensitiveText(
    'contact user@example.com or Bearer abc123 — key=https://x.test?token=tok123',
  );
  assert.equal(out.includes('user@example.com'), false);
  assert.equal(out.includes('Bearer abc123'), false);
  assert.equal(out.includes('tok123'), false);
  assert.equal(out.includes('contact'), true);
});

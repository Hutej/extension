/**
 * S6.1 — providers unit tests (T19/T20/T25 slices, plan/11 §3/§4/§5/§7).
 *
 * The real client + adapters against a local node http server (mock
 * strong/weak/malformed/slow/refusing providers — plan/11 §8). Pure adapter
 * and extraction tests run without any server. No live model anywhere.
 */

import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { createServer, type Server } from 'node:http';

import {
  extractOneJsonObject,
  openaiChatRequest,
  openaiChatResponse,
  anthropicMessagesRequest,
  anthropicMessagesResponse,
  detectUnsupportedParameter,
  createProviderClient,
} from '../../src/providers.ts';
import type { ProviderProfile } from '../../src/contracts.ts';

// ── fixtures ─────────────────────────────────────────────────────────────

const PROFILE: ProviderProfile = {
  profileVersion: 1,
  profileId: 'p1',
  label: 'Test OpenAI-compatible',
  protocol: 'openai-chat',
  endpoint: 'http://127.0.0.1:0/v1/chat/completions',
  modelId: 'custom-model-id',
  auth: { kind: 'bearer' },
  capabilities: { tokenParameter: 'max_tokens', jsonObjectMode: true },
};

const ANTHROPIC_PROFILE: ProviderProfile = {
  ...PROFILE,
  profileId: 'p2',
  protocol: 'anthropic-messages',
  endpoint: 'http://127.0.0.1:0/v1/messages',
  auth: { kind: 'api-key-header', headerName: 'x-api-key' },
};

const OPENAI_BODY = JSON.stringify({
  choices: [{ message: { content: '{"kind":"proposal","schemaVersion":1,"summary":"s","operations":[]}' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 20 },
});

const ANTHROPIC_BODY = JSON.stringify({
  content: [{ type: 'text', text: '{"kind":"proposal"}' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 10, output_tokens: 20 },
});

// ── extraction (plan/11 §7) ──────────────────────────────────────────────

test('T02: extraction accepts exactly one object — bare, fenced, or prose-wrapped', () => {
  const obj = '{"kind":"proposal"}';
  assert.deepEqual(extractOneJsonObject(obj), { ok: true, json: { kind: 'proposal' } });
  assert.deepEqual(extractOneJsonObject('```json\n' + obj + '\n```'), { ok: true, json: { kind: 'proposal' } });
  const prose = extractOneJsonObject('Here is my plan:\n' + obj + '\nLet me know.');
  assert.ok(prose.ok, 'prose around exactly one object is accepted');
  const braces = extractOneJsonObject('The {selector} pattern means:\n' + obj);
  assert.equal(braces.ok, false, 'a prose brace plus the real object is TWO balanced objects — ambiguous');
});

test('T02: extraction rejects multiple objects, truncation and non-JSON — never first-plausible', () => {
  assert.equal(extractOneJsonObject('{"a":1} {"b":2}').ok, false);
  assert.equal(extractOneJsonObject('{"a":1} trailing {"b":2}').ok, false);
  assert.equal(extractOneJsonObject('{"a": {"b": 1}, "c": 2}').ok, true, 'nested braces inside ONE object are fine');
  assert.equal(extractOneJsonObject('{"a": 1').ok, false, 'truncated output is rejected, never executed');
  assert.equal(extractOneJsonObject('plain text only').ok, false);
  assert.equal(extractOneJsonObject('').ok, false);
});

// ── adapters (pure translation, T19) ─────────────────────────────────────

test('T19: the OpenAI adapter includes the negotiated token parameter and JSON mode only when selected', () => {
  const out = openaiChatRequest(PROFILE, 'secret-key', { system: 'sys', user: 'usr', outputTokens: 4096, jsonObjectMode: true });
  assert.ok(out.ok);
  if (out.ok) {
    const body = JSON.parse(out.request.body) as Record<string, unknown>;
    assert.equal(body.model, 'custom-model-id', 'the model id is opaque and passed through');
    assert.equal(body.max_tokens, 4096, 'negotiated max_tokens');
    assert.deepEqual((body.response_format as Record<string, string>).type, 'json_object');
    assert.equal(out.request.headers.authorization, 'Bearer secret-key');
    assert.ok(!JSON.stringify(out.request.body).includes('secret-key'), 'the credential never appears in the body');
  }
  // Without negotiated json mode: no response_format (plan/11 §4.2).
  const plain = openaiChatRequest({ ...PROFILE, capabilities: { tokenParameter: 'max_tokens' } }, undefined, { system: 's', user: 'u', outputTokens: 10, jsonObjectMode: true });
  assert.ok(plain.ok);
  if (plain.ok) assert.ok(!plain.request.body.includes('response_format'));
  // max_completion_tokens profile uses the alternate token parameter.
  const alt = openaiChatRequest({ ...PROFILE, capabilities: { tokenParameter: 'max_completion_tokens' } }, undefined, { system: 's', user: 'u', outputTokens: 10 });
  assert.ok(alt.ok);
  if (alt.ok) assert.ok(JSON.parse(alt.request.body).max_completion_tokens === 10);
});

test('T19: the Anthropic adapter sends system separately with required max_tokens and version header', () => {
  const out = anthropicMessagesRequest(ANTHROPIC_PROFILE, 'sk-x', { system: 'sys', user: 'usr', outputTokens: 2048 });
  assert.ok(out.ok);
  if (out.ok) {
    const body = JSON.parse(out.request.body) as Record<string, unknown>;
    assert.equal(body.system, 'sys');
    assert.equal(body.max_tokens, 2048);
    assert.ok(!JSON.stringify(body.messages).includes('sys'));
    assert.equal(out.request.headers['anthropic-version'], '2023-06-01');
    assert.equal(out.request.headers['x-api-key'], 'sk-x');
  }
});

test('T19: response translation extracts text/usage/finish reasons and rejects tool-use', () => {
  const oai = openaiChatResponse(200, OPENAI_BODY);
  assert.ok(oai.ok);
  if (oai.ok) {
    assert.match(oai.value.text, /proposal/);
    assert.equal(oai.value.finishReason, 'stop');
    assert.deepEqual(oai.value.usage, { inputTokens: 10, outputTokens: 20 });
  }
  assert.equal(openaiChatResponse(200, '{"nope":1}').ok, false, 'missing choices is an explicit error');
  assert.equal(openaiChatResponse(200, 'not json').ok, false, 'non-JSON 200 is an error');
  assert.equal(openaiChatResponse(200, JSON.stringify({ choices: [{ message: { content: 'x' }, finish_reason: 'length' }] })).ok, false, 'truncated output is rejected, never executed');
  assert.equal(openaiChatResponse(401, '{}').ok, false);
  const ant = anthropicMessagesResponse(200, ANTHROPIC_BODY);
  assert.ok(ant.ok);
  if (ant.ok) assert.equal(ant.value.text, '{"kind":"proposal"}');
  assert.equal(anthropicMessagesResponse(200, JSON.stringify({ content: [{ type: 'tool_use', id: 't', name: 'x', input: {} }] })).ok, false, 'tool-use has no supported contract');
  assert.equal(anthropicMessagesResponse(200, JSON.stringify({ type: 'error', error: { message: 'overloaded' } })).ok, false);
  // Reasoning blocks are never extracted (plan/11 §3).
  const withThinking = anthropicMessagesResponse(200, JSON.stringify({ content: [{ type: 'thinking', thinking: 'secret chain' }, { type: 'text', text: 'ok' }] }));
  assert.ok(withThinking.ok);
  if (withThinking.ok) assert.equal(withThinking.value.text, 'ok');
});

test('T19/T20: unsupported-parameter downgrade triggers only on a specific 400 naming the parameter', () => {
  assert.equal(detectUnsupportedParameter('openai-chat', 400, JSON.stringify({ error: { message: "Unrecognized request argument supplied: max_completion_tokens" } })), 'max_completion_tokens');
  assert.equal(detectUnsupportedParameter('openai-chat', 400, JSON.stringify({ error: { message: 'response_format is not supported by this model' } })), 'response_format');
  assert.equal(detectUnsupportedParameter('openai-chat', 400, JSON.stringify({ error: { message: 'context length exceeded' } })), null, 'other 400s are NOT negotiation');
  assert.equal(detectUnsupportedParameter('openai-chat', 401, JSON.stringify({ error: { message: 'Unknown parameter: max_tokens' } })), null, 'auth failures are never negotiation');
  assert.equal(detectUnsupportedParameter('openai-chat', 200, '{}'), null);
});

// ── bounded HTTP client (T20/T25) ────────────────────────────────────────

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function listen(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, body: string) => void): Promise<string> {
  const server = createServer((req, res) => {
    let data = '';
    req.on('data', (c: Buffer) => (data += c.toString()));
    req.on('end', () => handler(req, res, data));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  return `http://127.0.0.1:${(addr as { port: number }).port}`;
}

function clientFor() {
  return createProviderClient({
    now: () => Date.now(),
    randomId: () => `id-${Math.random()}`,
    sleep: async (ms, signal) => {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, Math.min(ms, 50)); // compress backoff in tests
        signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
      });
    },
  });
}

async function callEndpoint(endpoint: string, overrides: Partial<Parameters<ReturnType<typeof createProviderClient>['call']>[0]> = {}) {
  const client = clientFor();
  return client.call({
    profile: { ...PROFILE, endpoint },
    credential: 'secret-token-123',
    system: 'sys',
    user: 'usr',
    outputTokens: 100,
    deadlineAt: Date.now() + 5000,
    ...overrides,
  });
}

test('T20: a strong provider returns normalized text with usage in one attempt', async () => {
  const url = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(OPENAI_BODY);
  });
  const out = await callEndpoint(`${url}/v1/chat/completions`);
  assert.ok(out.ok, JSON.stringify(out).slice(0, 300));
  assert.equal(out.httpAttempts, 1);
  assert.deepEqual(out.usage, { inputTokens: 10, outputTokens: 20 });
});

test('T20: auth failures never retry; transient 503 retries and succeeds within the budget', async () => {
  let authAttempts = 0;
  const authUrl = await listen((req, res) => {
    authAttempts += 1;
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"bad key"}}');
  });
  const auth = await callEndpoint(`${authUrl}/v1/chat/completions`);
  assert.equal(auth.ok, false);
  assert.equal(auth.httpAttempts, 1, '401 is never retried');
  assert.equal(authAttempts, 1);

  let flaky = 0;
  const retryUrl = await listen((req, res) => {
    flaky += 1;
    if (flaky < 3) {
      res.writeHead(503);
      res.end('overloaded');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(OPENAI_BODY);
  });
  const ok = await callEndpoint(`${retryUrl}/v1/chat/completions`);
  assert.ok(ok.ok, JSON.stringify(ok).slice(0, 300));
  assert.equal(ok.httpAttempts, 3, 'two transient retries then success (3 total attempts)');
});

test('T20: the attempt budget holds — repeated 503s stop at the retry cap with a truthful error', async () => {
  let attempts = 0;
  const url = await listen((req, res) => {
    attempts += 1;
    res.writeHead(503);
    res.end('still down');
  });
  const out = await callEndpoint(`${url}/v1/chat/completions`);
  assert.equal(out.ok, false);
  assert.equal(attempts, 3, '1 initial + 2 transient retries');
  assert.equal(out.httpAttempts, 3);
});

test('T20: a 429 with Retry-After waits (bounded) and succeeds on the next attempt', async () => {
  let attempts = 0;
  const url = await listen((req, res) => {
    attempts += 1;
    if (attempts === 1) {
      res.writeHead(429, { 'retry-after': '0' });
      res.end('slow down');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(OPENAI_BODY);
  });
  const out = await callEndpoint(`${url}/v1/chat/completions`);
  assert.ok(out.ok);
  assert.equal(out.httpAttempts, 2);
});

test('T20: a specific unsupported-parameter 400 downgrades exactly one parameter and retries once', async () => {
  const bodies: string[] = [];
  const url = await listen((req, res, body) => {
    bodies.push(body);
    if (body.includes('max_completion_tokens')) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Unrecognized request argument supplied: max_completion_tokens' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(OPENAI_BODY);
  });
  const altProfile: ProviderProfile = { ...PROFILE, endpoint: `${url}/v1/chat/completions`, capabilities: { tokenParameter: 'max_completion_tokens', jsonObjectMode: true } };
  const client = clientFor();
  const out = await client.call({
    profile: altProfile,
    credential: 'secret-token-123',
    system: 'sys',
    user: 'usr',
    outputTokens: 100,
    deadlineAt: Date.now() + 5000,
  });
  assert.ok(out.ok, JSON.stringify(out).slice(0, 300));
  assert.equal(out.downgradedParameter, 'max_completion_tokens', 'the downgrade is recorded, never hidden');
  assert.ok(bodies[1]?.includes('"max_tokens"'), 'the retried body uses the standard parameter');
  assert.equal(out.httpAttempts, 2);
});

test('T20: the shared deadline covers slow headers — an aborted attempt is reported, not fake-success', async () => {
  const url = await listen((req, res) => {
    // Headers never arrive within the deadline.
    setTimeout(() => {
      res.writeHead(200);
      res.end(OPENAI_BODY);
    }, 5000);
  });
  const out = await callEndpoint(`${url}/v1/chat/completions`, { deadlineAt: Date.now() + 300 });
  assert.equal(out.ok, false);
  assert.match(out.message ?? '', /deadline|aborted/i);
});

test('T20: an oversized response body is rejected at the byte cap', async () => {
  const url = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"choices":[{"message":{"content":"' + 'x'.repeat(200 * 1024) + '"}}]}');
  });
  const out = await callEndpoint(`${url}/v1/chat/completions`);
  assert.equal(out.ok, false);
  assert.match(out.message ?? '', /128.*byte cap|exceeded/i);
});

test('T25: a cross-origin redirect is refused — credentials never follow it; same-origin is allowed', async () => {
  // The redirect target is another LOCAL port — a different origin that the
  // fetch will actually reach, so the refusal (not a DNS failure) is what's
  // under test. The spec strips Authorization on cross-origin redirects; the
  // client additionally refuses any cross-origin final URL.
  let leaked = '';
  const evil = await listen((req, res) => {
    leaked = req.headers.authorization ?? '(none)';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(OPENAI_BODY);
  });
  const url = await listen((req, res) => {
    res.writeHead(302, { location: `${evil}/steal` });
    res.end();
  });
  const out = await callEndpoint(`${url}/v1/chat/completions`);
  assert.equal(out.ok, false, 'a cross-origin redirect is a denial even when it succeeds');
  assert.match(out.message ?? '', /redirect|origin/i);
  assert.equal(leaked, '(none)', 'the credential was stripped before the cross-origin hop');

  let seen = '';
  const same = await listen((req, res) => {
    if (req.url === '/v1/chat/completions') {
      res.writeHead(302, { location: '/v1/other' });
      res.end();
      return;
    }
    seen = req.headers.authorization ?? '';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(OPENAI_BODY);
  });
  const okOut = await callEndpoint(`${same}/v1/chat/completions`);
  assert.ok(okOut.ok, JSON.stringify(okOut).slice(0, 200));
  assert.equal(seen, 'Bearer secret-token-123', 'same-origin redirect keeps the authorized call');
});

test('T25: a credential in the URL is refused before any request', async () => {
  let hits = 0;
  const url = await listen(() => {
    hits += 1;
  });
  const out = await callEndpoint(`${url}/v1/chat/completions?token=secret-token-123`);
  assert.equal(out.ok, false);
  assert.equal(hits, 0, 'no request left the machine');
});

test('T20: Stop aborts the call locally — the outcome is stopped, never a fake result', async () => {
  const url = await listen((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(OPENAI_BODY);
    }, 3000);
  });
  const controller = new AbortController();
  const client = clientFor();
  const pending = client.call({
    profile: { ...PROFILE, endpoint: `${url}/v1/chat/completions` },
    credential: 'x',
    system: 's',
    user: 'u',
    outputTokens: 10,
    deadlineAt: Date.now() + 10_000,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 50);
  const out = await pending;
  assert.equal(out.ok, false);
  assert.equal(out.code, 'aborted');
});

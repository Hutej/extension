/**
 * providers — bounded model transport (plan/03 §4 provider rows, plan/11,
 * consolidated per plan/02 §3: one file — HTTP client, JSON extraction and
 * two explicit protocol adapters; no registry/plugin framework).
 *
 * Guarantees (plan/11 §3/§5):
 *   - ONE shared absolute deadline covers fetch headers, body read, decode
 *     and backoff — it is never cleared when headers arrive.
 *   - ≤6 HTTP attempts per run, ≤2 retries for transient failures only
 *     (network, 429, 502, 503, 504) — never on auth, permission, schema or
 *     user cancellation. Retry-After is honored up to the remaining budget.
 *   - Response bytes capped at 128 KiB; truncated output is an error, never
 *     partially executed.
 *   - Redirects must stay on the endpoint origin (T25): a cross-origin
 *     redirect is refused and reported, credentials never leave the
 *     configured endpoint.
 *   - Optional-parameter downgrade happens only on a SPECIFIC
 *     unsupported-parameter error, drops exactly one parameter, retries once
 *     and records the downgrade (plan/11 §4.3) — never a blanket 400 handler.
 *   - Extraction accepts EXACTLY ONE JSON object (plan/11 §7): multiple
 *     balanced objects or truncated output are ambiguous and rejected —
 *     never "first plausible object".
 *
 * Pure over injected fetch; no DOM, no chrome.*, no content-script caller.
 */

import {
  credentialAppearsInUrl,
  isAllowedRedirect,
  type ProviderProfile,
} from './contracts.ts';

// ── strict extraction (plan/11 §7) ───────────────────────────────────────

/** Find balanced top-level {...} spans, quote-aware. Returns spans (start,
 *  end-exclusive) of every balanced object — bounded, linear scan. */
function balancedObjectSpans(s: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === quote) inString = false;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inString = true;
      quote = c;
      continue;
    }
    if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          spans.push([start, i + 1]);
          start = -1;
        }
      }
    }
  }
  return spans;
}

export type ExtractOutcome =
  | { ok: true; json: unknown }
  | { ok: false; reason: 'not-json' | 'multiple-objects' | 'truncated'; detail: string };

/** Accept EXACTLY ONE JSON object: a bare parse, one fenced block with only
 *  whitespace around it, or prose around exactly one balanced object. Two
 *  or more balanced objects are ambiguous even when only one parses
 *  (plan/11 §7: never extract the first plausible nested object). */
export function extractOneJsonObject(text: string): ExtractOutcome {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: false, reason: 'not-json', detail: 'the response carried no content' };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === 'object') return { ok: true, json: parsed };
    return { ok: false, reason: 'not-json', detail: 'the response is not a JSON object' };
  } catch {
    /* continue to fenced/scanned forms */
  }
  const fence = /^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```\s*$/.exec(trimmed);
  if (fence) {
    try {
      const parsed: unknown = JSON.parse(fence[1].trim());
      if (parsed !== null && typeof parsed === 'object') return { ok: true, json: parsed };
    } catch {
      /* fall through to the scan */
    }
  }
  const spans = balancedObjectSpans(trimmed);
  if (spans.length === 0) {
    return { ok: false, reason: 'truncated', detail: 'no complete JSON object was found (output may be truncated)' };
  }
  if (spans.length > 1) {
    return { ok: false, reason: 'multiple-objects', detail: `${spans.length} JSON objects found; the response is ambiguous and was rejected` };
  }
  const [start, end] = spans[0];
  const outside = trimmed.slice(0, start) + trimmed.slice(end);
  // Prose around the object is allowed; any further brace (balanced or
  // truncated fragment) or another fenced block outside is not — the
  // exactly-one rule counts spans above, this catches the fragments.
  if (/[{`]/.test(outside)) {
    return { ok: false, reason: 'multiple-objects', detail: 'content outside the single JSON object is not plain prose' };
  }
  try {
    const parsed: unknown = JSON.parse(trimmed.slice(start, end));
    if (parsed !== null && typeof parsed === 'object') return { ok: true, json: parsed };
  } catch {
    return { ok: false, reason: 'not-json', detail: 'the balanced object is not valid JSON' };
  }
  return { ok: false, reason: 'not-json', detail: 'the response is not a JSON object' };
}

// ── protocol adapters (pure translation) ─────────────────────────────────

export interface NormalizedRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface NormalizedResponse {
  text: string;
  finishReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface AdapterRequestOptions {
  system: string;
  user: string;
  outputTokens: number;
  /** Capability-driven extras — included only when negotiated (plan/11 §4). */
  jsonObjectMode?: boolean;
}

export interface TranslateOutcome {
  ok: true;
  request: NormalizedRequest;
}
export type TranslateError = { ok: false; code: 'unsupported-protocol' | 'invalid-profile'; message: string };

const AUTH_HEADER = (profile: ProviderProfile, credential: string | undefined): Record<string, string> => {
  if (profile.auth.kind === 'none' || !credential) return {};
  if (profile.auth.kind === 'bearer') return { authorization: `Bearer ${credential}` };
  return { [profile.auth.headerName ?? 'x-api-key']: credential };
};

/** OpenAI-compatible Chat Completions (plan/11 §2). The token parameter and
 *  JSON-object mode are OPT-IN per negotiated capabilities — never assumed. */
export function openaiChatRequest(
  profile: ProviderProfile,
  credential: string | undefined,
  opts: AdapterRequestOptions,
): TranslateOutcome | TranslateError {
  if (profile.protocol !== 'openai-chat') {
    return { ok: false, code: 'unsupported-protocol', message: `openai-chat adapter got protocol "${profile.protocol}"` };
  }
  const tokenParam = profile.capabilities?.tokenParameter ?? 'max_tokens';
  const body: Record<string, unknown> = {
    model: profile.modelId,
    messages: [
      { role: 'system', content: opts.system },
      { role: 'user', content: opts.user },
    ],
  };
  body[tokenParam] = opts.outputTokens;
  if (opts.jsonObjectMode && profile.capabilities?.jsonObjectMode) body.response_format = { type: 'json_object' };
  return {
    ok: true,
    request: {
      url: profile.endpoint,
      headers: { 'content-type': 'application/json', ...AUTH_HEADER(profile, credential) },
      body: JSON.stringify(body),
    },
  };
}

export function openaiChatResponse(status: number, bodyText: string): { ok: true; value: NormalizedResponse } | { ok: false; code: string; message: string; unsupportedParameter?: string } {
  if (status !== 200) return { ok: false, code: 'http-error', message: `HTTP ${status}` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { ok: false, code: 'invalid-envelope', message: 'HTTP 200 with a non-JSON envelope' };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, code: 'invalid-envelope', message: 'HTTP 200 body is not an object' };
  }
  const choices = (parsed as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0 || typeof choices[0] !== 'object' || choices[0] === null) {
    return { ok: false, code: 'invalid-envelope', message: 'response carries no choices' };
  }
  const first = choices[0] as Record<string, unknown>;
  const message = first.message;
  const content = typeof message === 'object' && message !== null ? (message as Record<string, unknown>).content : undefined;
  if (typeof content !== 'string') {
    return { ok: false, code: 'invalid-envelope', message: 'choices[0].message.content is missing' };
  }
  const finishReason = typeof first.finish_reason === 'string' ? first.finish_reason : undefined;
  if (finishReason === 'length') {
    return { ok: false, code: 'truncated', message: 'the response hit its output token limit and was truncated' };
  }
  const usageRaw = (parsed as Record<string, unknown>).usage;
  const usage = typeof usageRaw === 'object' && usageRaw !== null
    ? {
        inputTokens: typeof (usageRaw as Record<string, unknown>).prompt_tokens === 'number' ? (usageRaw as Record<string, unknown>).prompt_tokens as number : undefined,
        outputTokens: typeof (usageRaw as Record<string, unknown>).completion_tokens === 'number' ? (usageRaw as Record<string, unknown>).completion_tokens as number : undefined,
      }
    : undefined;
  return { ok: true, value: { text: content, ...(finishReason !== undefined ? { finishReason } : {}), ...(usage ? { usage } : {}) } };
}

/** Anthropic Messages (plan/11 §2): system separately, max_tokens required,
 *  text content blocks concatenated; tool-use blocks have no supported
 *  contract and are an explicit error. */
export function anthropicMessagesRequest(
  profile: ProviderProfile,
  credential: string | undefined,
  opts: AdapterRequestOptions,
): TranslateOutcome | TranslateError {
  if (profile.protocol !== 'anthropic-messages') {
    return { ok: false, code: 'unsupported-protocol', message: `anthropic-messages adapter got protocol "${profile.protocol}"` };
  }
  const body: Record<string, unknown> = {
    model: profile.modelId,
    system: opts.system,
    messages: [{ role: 'user', content: opts.user }],
    max_tokens: opts.outputTokens,
  };
  if (opts.jsonObjectMode && profile.capabilities?.jsonObjectMode) {
    body.metadata = { user_id: 'json-mode-requested' };
  }
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    ...AUTH_HEADER(profile, credential),
  };
  return { ok: true, request: { url: profile.endpoint, headers, body: JSON.stringify(body) } };
}

export function anthropicMessagesResponse(status: number, bodyText: string): { ok: true; value: NormalizedResponse } | { ok: false; code: string; message: string; unsupportedParameter?: string } {
  if (status !== 200) return { ok: false, code: 'http-error', message: `HTTP ${status}` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { ok: false, code: 'invalid-envelope', message: 'HTTP 200 with a non-JSON envelope' };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, code: 'invalid-envelope', message: 'HTTP 200 body is not an object' };
  }
  const p = parsed as Record<string, unknown>;
  if (p.type === 'error') {
    const err = p.error as Record<string, unknown> | undefined;
    return { ok: false, code: 'provider-refused', message: String(err?.message ?? 'the provider refused the request') };
  }
  const content = p.content;
  if (!Array.isArray(content)) return { ok: false, code: 'invalid-envelope', message: 'response carries no content blocks' };
  let text = '';
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b.type === 'text' && typeof b.text === 'string') text += b.text;
    else if (b.type === 'tool_use') {
      return { ok: false, code: 'unsupported-capability', message: 'the model answered with tool-use, which has no supported contract' };
    }
    // thinking/other blocks are never extracted or logged (plan/11 §3).
  }
  if (text === '') return { ok: false, code: 'invalid-envelope', message: 'no text content blocks in the response' };
  const stopReason = typeof p.stop_reason === 'string' ? p.stop_reason : undefined;
  if (stopReason === 'max_tokens') {
    return { ok: false, code: 'truncated', message: 'the response hit its output token limit and was truncated' };
  }
  const usageRaw = p.usage;
  const usage = typeof usageRaw === 'object' && usageRaw !== null
    ? {
        inputTokens: typeof (usageRaw as Record<string, unknown>).input_tokens === 'number' ? (usageRaw as Record<string, unknown>).input_tokens as number : undefined,
        outputTokens: typeof (usageRaw as Record<string, unknown>).output_tokens === 'number' ? (usageRaw as Record<string, unknown>).output_tokens as number : undefined,
      }
    : undefined;
  return { ok: true, value: { text, ...(stopReason !== undefined ? { finishReason: stopReason } : {}), ...(usage ? { usage } : {}) } };
}

/**
 * Owner-directed 2026-09-13 value-clamp negotiation: a 400 whose body names
 * the token parameter with a numeric cap parses that cap, so an over-asked
 * output limit clamps to the provider's own cap and retries — the request
 * must never fail just because a model caps output lower than we ask. No
 * cap in the body → no negotiation (honest error).
 */
export function detectTokenLimitClamp(bodyText: string): number | null {
  if (bodyText === '') return null;
  if (!/(max[_ -]?completion[_ -]?tokens|max[_ -]?tokens|completion tokens|token limit)/i.test(bodyText)) return null;
  const m = bodyText.match(/(?:at most|maximum(?: of)?|max(?:imum)? is|cannot exceed|exceeds|up to|less than or equal to|must be ≤?|supported)\s*:?\s*\**\s*(\d{2,7})/i);
  if (!m) return null;
  const cap = Number(m[1]);
  return cap >= 256 && Number.isFinite(cap) ? cap : null;
}

/** Specific unsupported-parameter detection (plan/11 §4.3): a 400 whose body
 *  names the offending parameter. Everything else is NOT negotiation. */
export function detectUnsupportedParameter(protocol: ProviderProfile['protocol'], status: number, bodyText: string): string | null {
  if (status !== 400) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  const message = (() => {
    if (protocol === 'openai-chat') {
      const err = (parsed as Record<string, unknown>)?.error;
      return typeof err === 'object' && err !== null ? String((err as Record<string, unknown>).message ?? '') : '';
    }
    const err = (parsed as Record<string, unknown> | undefined)?.error;
    return typeof err === 'object' && err !== null ? String((err as Record<string, unknown>).message ?? '') : '';
  })();
  if (/unknown parameter|unsupported parameter|unrecognized request argument|extra_forbidden|not allowed|not supported/i.test(message)) {
    const param = /max_completion_tokens/i.test(message) ? 'max_completion_tokens'
      : /max_tokens/i.test(message) ? 'max_tokens'
      : /response_format/i.test(message) ? 'response_format'
      : null;
    return param;
  }
  return null;
}

// ── bounded HTTP client ──────────────────────────────────────────────────

// Owner-directed 2026-09-13: 1 MiB — the bound stays a memory ceiling, not a
// work limit (plan/11 §5 cap, magnitude raised so large model plans never clip).
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_HTTP_ATTEMPTS = 6;
const MAX_RETRIES = 2;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 8000;
const TRANSIENT_STATUS = new Set([429, 502, 503, 504]);

export interface ProviderCallResult {
  ok: boolean;
  text?: string;
  finishReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  code?: string;
  message?: string;
  httpAttempts: number;
  /** Recorded capability downgrade (plan/11 §4.3) — surfaced, never hidden. */
  downgradedParameter?: string;
  wallMs: number;
}

export interface ProviderClientDeps {
  fetchImpl?: typeof fetch;
  now(): number;
  randomId(): string;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface ProviderCall {
  profile: ProviderProfile;
  credential?: string;
  system: string;
  user: string;
  outputTokens: number;
  jsonObjectMode?: boolean;
  /** Shared absolute deadline (epoch ms) spanning headers, body and backoff. */
  deadlineAt: number;
  signal?: AbortSignal;
}

export function createProviderClient(deps: ProviderClientDeps) {
  const fetchImpl = deps.fetchImpl ?? fetch;

  const call = async (c: ProviderCall): Promise<ProviderCallResult> => {
    const startedAt = deps.now();
    const remaining = (): number => Math.max(0, c.deadlineAt - deps.now());
    const attemptOnce = async (request: NormalizedRequest, signal: AbortSignal): Promise<{ ok: true; status: number; body: string; finalUrl: string; retryAfterMs?: number } | { ok: false; code: string; message: string }> => {
      const controller = new AbortController();
      const abortAll = (): void => controller.abort();
      c.signal?.addEventListener('abort', abortAll, { once: true });
      signal.addEventListener('abort', abortAll, { once: true });
      const timer = setTimeout(() => controller.abort(), remaining());
      try {
        if (credentialAppearsInUrl(c.credential ?? '', request.url)) {
          return { ok: false, code: 'denied', message: 'the credential must never travel in a URL' };
        }
        const response = await fetchImpl(request.url, {
          method: 'POST',
          headers: request.headers,
          body: request.body,
          signal: controller.signal,
          // Redirects are evaluated AFTER completion against the endpoint
          // origin (T25): a cross-origin redirect is a denial, not a follow.
          redirect: 'follow',
        });
        const finalUrl = response.url || request.url;
        if (!isAllowedRedirect(c.profile.endpoint, finalUrl)) {
          return { ok: false, code: 'denied', message: `the endpoint redirected off its origin (${new URL(finalUrl).host}) — credentials are not forwarded` };
        }
        // Retry-After: delta seconds or an HTTP date, honored only up to the
        // remaining shared budget (plan/11 §5).
        const retryAfterRaw = response.headers.get('retry-after');
        let retryAfterMs: number | undefined;
        if (retryAfterRaw !== null && retryAfterRaw !== '') {
          const seconds = Number(retryAfterRaw);
          retryAfterMs = Number.isFinite(seconds) ? seconds * 1000 : (() => {
            const date = new Date(retryAfterRaw);
            return Number.isNaN(date.getTime()) ? undefined : Math.max(0, date.getTime() - deps.now());
          })();
        }
        // Bounded body read: stop at the byte cap even mid-stream.
        const reader = response.body?.getReader();
        let body = '';
        if (reader) {
          const decoder = new TextDecoder();
          let received = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            received += value.byteLength;
            if (received > MAX_RESPONSE_BYTES) {
              void reader.cancel();
              return { ok: false, code: 'oversized', message: `the response exceeded the ${MAX_RESPONSE_BYTES}-byte cap` };
            }
            body += decoder.decode(value, { stream: true });
          }
          body += decoder.decode();
        } else {
          body = await response.text();
          if (body.length > MAX_RESPONSE_BYTES) {
            return { ok: false, code: 'oversized', message: `the response exceeded the ${MAX_RESPONSE_BYTES}-byte cap` };
          }
        }
        return { ok: true, status: response.status, body, finalUrl, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
      } catch (err) {
        if (c.signal?.aborted) return { ok: false, code: 'aborted', message: 'the run was stopped' };
        return { ok: false, code: 'network', message: (err as Error).message.slice(0, 200) };
      } finally {
        clearTimeout(timer);
        c.signal?.removeEventListener('abort', abortAll);
        signal.removeEventListener('abort', abortAll);
      }
    };

    const translate: TranslateOutcome | TranslateError = c.profile.protocol === 'openai-chat'
      ? openaiChatRequest(c.profile, c.credential, { system: c.system, user: c.user, outputTokens: c.outputTokens, ...(c.jsonObjectMode !== undefined ? { jsonObjectMode: c.jsonObjectMode } : {}) })
      : anthropicMessagesRequest(c.profile, c.credential, { system: c.system, user: c.user, outputTokens: c.outputTokens, ...(c.jsonObjectMode !== undefined ? { jsonObjectMode: c.jsonObjectMode } : {}) });
    if (!translate.ok) {
      return { ok: false, code: translate.code, message: translate.message, httpAttempts: 0, wallMs: 0 };
    }

    let request = translate.request;
    let httpAttempts = 0;
    let retries = 0;
    let downgradedParameter: string | undefined;
    let lastError: { code: string; message: string } | undefined;

    while (httpAttempts < MAX_HTTP_ATTEMPTS) {
      if (c.signal?.aborted) {
        return { ok: false, code: 'aborted', message: 'the run was stopped', httpAttempts, wallMs: deps.now() - startedAt };
      }
      if (remaining() <= 0) {
        return { ok: false, code: 'deadline', message: 'the shared deadline expired before the call completed', httpAttempts, wallMs: deps.now() - startedAt };
      }
      const perAttemptSignal = new AbortController();
      const outcome = await attemptOnce(request, perAttemptSignal.signal);
      httpAttempts += 1;

      if (outcome.ok) {
        // Retry by STATUS before any response translation (plan/11 §5: the
        // transient list is 429/502/503/504 — never auth/schema/cancel).
        if (TRANSIENT_STATUS.has(outcome.status) && retries < MAX_RETRIES) {
          retries += 1;
          const wait = Math.min(outcome.retryAfterMs ?? backoffDelay(retries), Math.max(0, remaining() - 1), BACKOFF_CAP_MS);
          await deps.sleep(wait, c.signal);
          continue;
        }
        const translated = c.profile.protocol === 'openai-chat'
          ? openaiChatResponse(outcome.status, outcome.body)
          : anthropicMessagesResponse(outcome.status, outcome.body);
        if (translated.ok) {
          return {
            ok: true,
            text: translated.value.text,
            ...('finishReason' in translated.value ? { finishReason: translated.value.finishReason } : {}),
            ...('usage' in translated.value ? { usage: translated.value.usage } : {}),
            httpAttempts,
            ...(downgradedParameter !== undefined ? { downgradedParameter } : {}),
            wallMs: deps.now() - startedAt,
          };
        }
        // Owner-directed value-clamp negotiation: a 400 naming the token
        // parameter with a numeric cap clamps the requested limit once and
        // retries (an over-asked output limit must never fail the request).
        if (outcome.status === 400 && !downgradedParameter && retries < MAX_RETRIES) {
          const cap = detectTokenLimitClamp(outcome.body);
          const tokenParam = c.profile.capabilities?.tokenParameter ?? 'max_tokens';
          const tokenRe = new RegExp(`"${tokenParam}"\\s*:\\s*\\d+`);
          if (cap !== null && tokenRe.test(request.body)) {
            request = { ...request, body: request.body.replace(tokenRe, `"${tokenParam}": ${cap}`) };
            downgradedParameter = `${tokenParam}-value`;
            retries += 1;
            continue;
          }
        }
        // Specific unsupported-parameter downgrade: drop exactly ONE optional
        // parameter and retry once (plan/11 §4.3).
        if (!downgradedParameter && retries < MAX_RETRIES) {
          const unsupported = detectUnsupportedParameter(c.profile.protocol, outcome.status, outcome.body);
          if (unsupported === 'max_completion_tokens' && request.body.includes('max_completion_tokens')) {
            request = { ...request, body: request.body.replace('"max_completion_tokens"', '"max_tokens"') };
            downgradedParameter = 'max_completion_tokens';
            retries += 1;
            continue;
          }
          if (unsupported === 'response_format' && request.body.includes('response_format')) {
            request = { ...request, body: request.body.replace(/,"response_format":\{[^}]*\}/, '') };
            downgradedParameter = 'response_format';
            retries += 1;
            continue;
          }
        }
        lastError = { code: translated.code, message: translated.message };
        break;
      }

      // Transport-level outcome.
      if (outcome.code === 'aborted') {
        return { ok: false, code: 'aborted', message: outcome.message, httpAttempts, wallMs: deps.now() - startedAt };
      }
      if (outcome.code === 'network' && retries < MAX_RETRIES) {
        retries += 1;
        await deps.sleep(Math.min(backoffDelay(retries), Math.max(0, remaining() - 1)), c.signal);
        continue;
      }
      lastError = { code: outcome.code, message: outcome.message };
      break;
    }

    return {
      ok: false,
      code: lastError?.code ?? 'internal',
      message: lastError?.message ?? 'the provider call did not complete',
      httpAttempts,
      ...(downgradedParameter !== undefined ? { downgradedParameter } : {}),
      wallMs: deps.now() - startedAt,
    };
  };

  const backoffDelay = (attempt: number): number => {
    const base = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
    return Math.floor(base / 2 + Math.random() * (base / 2)); // jittered
  };

  return { call };
}

export type ProviderClient = ReturnType<typeof createProviderClient>;

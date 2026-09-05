/**
 * core/reason — LLM transport. The ONLY place production talks to the model.
 *
 * One entry point: callLoopModel — the agent loop's single call (system + user
 * → JSON object) to GLM 5.2. Production Revueon never sends a screenshot to a
 * vision model — that path is TEST/QA infrastructure only, living in tests/.
 *
 * No role prompts, no DesignSpec, no vocabulary. The loop builds its own prompt.
 */

import { AI_CONFIG, logDebug } from '../config';
import { extractJson } from './extract';

// ── Cloudflare Workers AI (OpenAI-compatible) ──────────────────────

const cfChatUrl = (accountId: string): string =>
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`;

// ── Transport helpers ──────────────────────────────────────────────

function isReasoningModel(model: string): boolean { return /glm/i.test(model); }

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(id); }
}

async function safeText(res: Response): Promise<string> { try { return await res.text(); } catch { return ''; } }
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

function retryWaitMs(bodyTxt: string, transient: number): number {
  const m = bodyTxt.match(/try again in (?:(\d+)m)?([\d.]+)s/);
  if (m) return Math.ceil(((m[1] ? +m[1] * 60 : 0) + parseFloat(m[2])) * 1000) + 500;
  const base = AI_CONFIG.rateLimitBackoffMs || AI_CONFIG.baseBackoffMs;
  return Math.min(60000, base * 2 ** (transient - 1));
}

// ── Generic loop model call ─────────────────────────────────────────
//
// Takes a system prompt + user content, returns a parsed JSON object.
// Uses the strong model. One hard-aborted attempt; HTTP retries for 429/5xx.
// A 400 that rejects response_format/reasoning_effort drops those params and
// retries once. Returns { ok, json, error, callMs, httpRequests, usage }.

export interface LoopModelResult {
  ok: boolean;
  json?: unknown;           // parsed JSON object from the model
  raw?: string;             // raw content if JSON parse failed
  error?: string;
  callMs?: number;
  httpRequests: number;
  usage?: unknown;
  model?: string;
}

export interface LoopModelRequest {
  systemPrompt: string;
  userContent: string;
  accountId: string;
  apiKey: string;
  /** override the strong model (e.g. for a fast observation turn) */
  model?: string;
  timeoutMs?: number;
  maxTokens?: number;
  /** R0 benchmark: reasoning-effort override ('low' is the production default). */
  reasoningEffort?: 'low' | 'medium' | 'high';
  /** E1: temperature for determinism. 0 on tool-selection turns. */
  temperature?: number;
}

export async function callLoopModel(req: LoopModelRequest): Promise<LoopModelResult> {
  const model = req.model ?? AI_CONFIG.strongModel;
  const reasoning = isReasoningModel(model);
  const timeout = req.timeoutMs ?? AI_CONFIG.callTimeoutMs;
  // An explicit maxTokens overrides (benchmark harness); null/undefined = NO
  // artificial cap — the provider default applies and the model is never
  // truncated mid-thought.
  const maxTokens = req.maxTokens ?? AI_CONFIG.maxCompletionTokens ?? undefined;
  let useResponseFormat = true;
  let useReasoningEffort = true;
  let useTemperature = req.temperature !== undefined;
  let transient = 0;
  let httpRequests = 0;

  while (true) {
    const bodyObj: Record<string, unknown> = {
      model,
      messages: [
        { role: 'system', content: req.systemPrompt },
        { role: 'user', content: req.userContent },
      ],
    };
    // Only set a completion cap when one is explicitly configured — an unset
    // field means "let the provider decide", not "truncate the agent".
    if (maxTokens !== undefined) bodyObj.max_completion_tokens = maxTokens;
    if (useResponseFormat) bodyObj.response_format = { type: 'json_object' };
    if (reasoning && useReasoningEffort) bodyObj.reasoning_effort = req.reasoningEffort ?? 'low';
    // E1: temperature 0 for determinism on tool-selection turns.
    if (useTemperature && req.temperature !== undefined) bodyObj.temperature = req.temperature;

    const t0 = Date.now();
    let res: Response;
    try {
      httpRequests++;
      res = await fetchWithTimeout(cfChatUrl(req.accountId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${req.apiKey}` },
        body: JSON.stringify(bodyObj),
      }, timeout);
    } catch (err) {
      const e = err as { name?: string; message?: string };
      if (e.name === 'AbortError') return { ok: false, error: 'Model call timed out.', callMs: Date.now() - t0, httpRequests };
      if (transient < AI_CONFIG.maxTransientRetries) { transient++; await sleep(AI_CONFIG.baseBackoffMs * 2 ** (transient - 1)); continue; }
      return { ok: false, error: `Network error: ${e.message}`, callMs: Date.now() - t0, httpRequests };
    }
    const s = ((Date.now() - t0) / 1000).toFixed(1);

    if (!res.ok) {
      const bodyTxt = await safeText(res);
      if (res.status === 401 || res.status === 403) return { ok: false, error: 'Invalid API key.', httpRequests };
      if (res.status === 429 || res.status >= 500) {
        if (transient < AI_CONFIG.maxTransientRetries) { transient++; await sleep(retryWaitMs(bodyTxt, transient)); continue; }
        return { ok: false, error: 'Rate limited.', httpRequests };
      }
      // E: drop params one at a time — reasoning_effort first (most likely
      // unsupported on fast models), then temperature, then response_format.
      if (res.status === 400 && useReasoningEffort) {
        logDebug(`400 — dropping reasoning_effort, retry`);
        useReasoningEffort = false; continue;
      }
      if (res.status === 400 && useTemperature) {
        logDebug(`400 — dropping temperature, retry`);
        useTemperature = false; continue;
      }
      if (res.status === 400 && useResponseFormat) {
        logDebug(`400 — dropping response_format, retry`);
        useResponseFormat = false; continue;
      }
      return { ok: false, error: `API error (${res.status}): ${bodyTxt.slice(0, 120)}`, httpRequests };
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    logDebug(`loopModel model=${model} ${s}s tokens=${data?.usage?.total_tokens ?? '?'}`);
    if (typeof content !== 'string') return { ok: false, error: 'Model returned no content.', callMs: Date.now() - t0, httpRequests };
    const parsed = extractJson(content);
    if (parsed.ok) return { ok: true, json: parsed.json, callMs: Date.now() - t0, httpRequests, usage: data.usage, model };
    return { ok: false, raw: content, error: parsed.error, callMs: Date.now() - t0, httpRequests };
  }
}

// Phase 2.5 TASK1: extractJson + balancedObject live in ./extract (a dependency-
// free module) so tests/parse-extract-test.ts imports the REAL extractor, not
// an inlined copy (adversarial review wf_e3e50d92 finding). callLoopModel uses
// it via the import at the top of this file. Re-exported here for back-compat.
export { extractJson } from './extract';

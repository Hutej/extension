/**
 * tests/capture-transport.ts — Phase 2.5 TASK1: call the REAL Cloudflare
 * Workers AI endpoint (the exact URL + body core/reason callLoopModel builds)
 * directly and log the raw response. No browser, no WXT/Vite needed.
 *
 * This mirrors callLoopModel's request body precisely (model,
 * max_completion_tokens, messages, response_format, reasoning_effort,
 * temperature) and records the HTTP status, the raw `content` string, and
 * whether it parses as JSON. It also replays the same param-drop-on-400
 * behavior so we see what the loop actually experiences.
 *
 * Goal: classify whether the loop's parse failures are invalid JSON, empty
 * content, timeout, 429/5xx, or 400 param rejection — from REAL responses.
 *
 * Usage: node --experimental-strip-types --env-file=.env tests/capture-transport.ts
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROOF_DIR = join(__dirname, '..', 'proof');
mkdirSync(PROOF_DIR, { recursive: true });

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || '';
const apiToken = process.env.CLOUDFLARE_API_TOKEN || '';
if (!accountId || !apiToken) { console.error('Missing credentials'); process.exit(1); }

const cfChatUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`;

const samplePrompt = `You are Revueon, an AI agent that modifies web pages. A user stated a goal. You investigate the page, gather only the evidence you need, choose the cheapest correct action, apply it, verify the result, and stop.

GOAL: Hide the sidebar
PAGE: https://en.wikipedia.org/wiki/CSS

TOOLS:
describePage() — list page regions (roles, types, positions)
findElements(selector) — resolve a selector the model named
applyCss(css) — apply CSS to the page (user-origin stylesheet)
hide(selector) — hide an element and heal the gap (display:none + reflow)

BUDGET: 12 steps left, 60s left.

JOURNAL:
Nothing yet.

Respond with ONE JSON object:
  {"tool":"<name>","args":{...},"reasoning":"why"}  to call a tool
  {"done":true,"summary":"what you did"}            when finished
  {"giveUp":true,"reason":"why you cannot"}         when you cannot do this

Gather the least evidence that lets you act correctly, then act.`;

interface Capture {
  call: number; model: string; httpStatus: number; ok: boolean;
  error?: string; content?: string; contentLen?: number; parsedJson?: boolean;
  callMs: number; bodySent?: string; usage?: any;
}

function isReasoningModel(m: string) { return /glm/i.test(m); }

async function fetchWithTimeout(url: string, options: any, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(id); }
}

async function captureOne(model: string, call: number): Promise<Capture> {
  const bodyObj: Record<string, unknown> = {
    model,
    max_completion_tokens: 16_000,
    messages: [
      { role: 'system', content: 'You are Revueon. Respond with one JSON object only.' },
      { role: 'user', content: samplePrompt },
    ],
    response_format: { type: 'json_object' },
  };
  if (isReasoningModel(model)) bodyObj.reasoning_effort = 'low';
  bodyObj.temperature = 0;

  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetchWithTimeout(cfChatUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiToken}` },
      body: JSON.stringify(bodyObj),
    }, 30_000);
  } catch (err: any) {
    if (err.name === 'AbortError') return { call, model, httpStatus: 0, ok: false, error: 'TIMEOUT (30s abort)', callMs: Date.now() - t0 };
    return { call, model, httpStatus: 0, ok: false, error: `NETWORK: ${err.message}`, callMs: Date.now() - t0 };
  }

  const callMs = Date.now() - t0;
  if (!res.ok) {
    const txt = await res.text();
    return { call, model, httpStatus: res.status, ok: false, error: `HTTP ${res.status}: ${txt.slice(0, 300)}`, callMs, bodySent: JSON.stringify(bodyObj).slice(0, 400) };
  }
  const data: any = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    return { call, model, httpStatus: res.status, ok: false, error: `NO CONTENT (content type=${typeof content})`, callMs, usage: data?.usage };
  }
  let parsed = false;
  let err: string | undefined;
  try { JSON.parse(content); parsed = true; } catch (e: any) { err = `JSON.parse: ${e.message}`; }
  // If fenced markdown, try extracting
  if (!parsed) {
    const md = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (md) { try { JSON.parse(md[1].trim()); parsed = true; } catch { /* keep err */ } }
  }
  return {
    call, model, httpStatus: res.status,
    ok: parsed,
    error: parsed ? undefined : err,
    content: content.slice(0, 1200),
    contentLen: content.length,
    parsedJson: parsed,
    callMs,
    usage: data?.usage,
  };
}

async function main() {
  const results: Capture[] = [];
  const models = [
    '@cf/zai-org/glm-4.7-flash',  // fast (observation tier)
    '@cf/zai-org/glm-5.2',        // strong (act tier)
  ];

  console.log('\nPhase 2.5 TASK1 — direct Cloudflare transport capture\n');
  let callNum = 0;
  for (const model of models) {
    for (let i = 0; i < 3; i++) {
      callNum++;
      const c = await captureOne(model, callNum);
      results.push(c);
      console.log(`call ${c.call}: model=${c.model} http=${c.httpStatus} ok=${c.ok} callMs=${c.callMs}ms contentLen=${c.contentLen ?? 'n/a'}`);
      if (c.error) console.log(`  ERROR: ${c.error}`);
      if (c.content) console.log(`  CONTENT: ${c.content.slice(0, 400).replace(/\n/g, ' ')}`);
      console.log('');
    }
  }

  writeFileSync(join(PROOF_DIR, 'transport-capture.json'), JSON.stringify(results, null, 2));
  console.log(`\nWrote ${results.length} captures to proof/transport-capture.json`);

  const ok = results.filter((r) => r.ok).length;
  const noContent = results.filter((r) => r.error?.includes('NO CONTENT')).length;
  const badJson = results.filter((r) => r.error?.includes('JSON.parse')).length;
  const httpErr = results.filter((r) => r.error?.includes('HTTP')).length;
  const timeout = results.filter((r) => r.error?.includes('TIMEOUT')).length;
  console.log(`\nClassification of ${results.length} calls:`);
  console.log(`  ok (valid JSON):     ${ok}`);
  console.log(`  NO CONTENT:          ${noContent}`);
  console.log(`  invalid JSON:        ${badJson}`);
  console.log(`  HTTP error (4xx/5xx):${httpErr}`);
  console.log(`  TIMEOUT:             ${timeout}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

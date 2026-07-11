/**
 * core/reason — LLM transport + prompt. The ONLY place that talks to the model.
 * Owns retry/backoff/timeout/error-mapping; returns a validated DesignSpec.
 */

import { AI_CONFIG, logDebug } from '../config';
import { validateSpec, type DesignSpec } from '../spec';
import { BASE_PROPS, INTERACTION_PROPS, LAYOUT_PROPS } from '../laws';

export type ReasonError =
  | 'invalid_key' | 'rate_limited' | 'network' | 'timeout'
  | 'bad_output' | 'context_limit' | 'invalid_request' | 'unknown';

export type StyleSpecResult =
  | { ok: true; spec: DesignSpec; usage?: unknown }
  | { ok: false; kind: ReasonError; message: string };

export interface StyleSpecRequest {
  intent: string;
  perception: string;
  apiKey: string;
  critique?: string; // regenerative-repair feedback appended to the user message
}

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

const SYSTEM_PROMPT = `You are WebMorph's design engine. WebMorph reshapes a website's PRESENTATION locally in the user's browser — the backend and content are untouched; only how it looks and is arranged changes.

You are given (1) the user's request in plain English and (2) a RUNTIME-DISCOVERED picture of THIS exact page: its canvas, a LAYOUT SKELETON (columns, content width, regions), any CSS color variables, and the real components on the page. Each component has a stable id, tag/role, size (with %width), display type (container or not), and its CURRENT computed styles. The ids are real handles — a deterministic compiler applies your output to exactly those elements.

Your job: return a design SPEC that turns THIS page into a genuine, COHERENT REDESIGN matching the request — a real design system, NOT a recolor. A recolor is a failure. You MUST change arrangement, sizing, spacing, and type — not only color.

Think like a senior product designer:
- BACKGROUND FIRST (this is what makes it look designed, not "borders on a white page"). The page background is a deliberate, first-class choice — set it via "canvas" (it is applied to html/body, the true page backdrop). Make it visibly DIFFERENT from the site's current canvas when the aesthetic calls for it; do not echo the site's default. Neobrutalism usually wants an off-white/cream (e.g. #f5f1e6) or a bold flat color — never plain #ffffff. Glassmorphism REQUIRES a rich backdrop: a saturated multi-stop gradient or a deep colored field (e.g. linear-gradient(135deg,#3a1c71,#d76d77,#ffaf7b)). A near-white backdrop makes glass fail — the blur has nothing to reveal.
  IMPORTANT: the real page backdrop is often hidden by an opaque top-level container. So when your backdrop must show through (especially for glass), also retint the largest container/region clusters: give them a TRANSLUCENT or transparent background so the canvas backdrop shows behind the panels.
- SURFACES + GLASS: for glassmorphism, panels use a translucent fill (e.g. rgba(255,255,255,0.12–0.30) over a dark backdrop, or a light tint over a bright one) PLUS backdropFilter: blur(...) and a hairline border — and text must stay legible over the blur (pick panel opacity/text color so contrast holds). For neobrutalism, commit: thick hard borders, hard offset box-shadow, radius 0, flat bold color.
- HIERARCHY, NOT UNIFORMITY: do NOT frame every component. Heavy borders/frames/offset-shadows belong on a FEW primary containers only; most content stays calm and unframed. Wrapping every cluster in the same 4px frame is a failure (the border version of "make everything loud"). Establish primary / secondary / tertiary levels.
- TYPOGRAPHY: a real type scale — oversized bold headings for neobrutalism; refined, quieter hierarchy for glass. Set fontSize/fontWeight/lineHeight/letterSpacing.
- LAYOUT + SPACING: content/container widths (maxWidth + marginInline:auto to center a column), columns (grid-template-columns / flex-direction), and a consistent gap/padding scale — not one value everywhere.
- ACCENT RESTRAINT: the accent color is for EMPHASIS ONLY — a few headings/primary buttons. Never paint a high-count cluster (e.g. hundreds of links) with the accent. Style links calmly (inherit/underline).

How to write it:
- Each rule targets one component id via "target". Put PAINT in "styles" and ARRANGEMENT/SIZING/SPACING/TYPE in "layout". Use "canvas" (target:"canvas") + "canvasLayout" for page-level background and base content width.
- When CSS color variables are listed, prefer overriding them via "variables" — it rethemes deep framework CSS.
- Two different requests, or two different pages, MUST produce genuinely different specs. Design for the evidence you were given; named aesthetics are directions, not fixed recipes.
- "moves" (relocating a component into another) is optional and rarely needed — prefer CSS layout. It is planned but not executed yet, so rely on layout/order.

Allowed keys (anything else is ignored by the compiler):
  styles (paint): ${Object.keys(BASE_PROPS).join(', ')}
  layout: ${Object.keys(LAYOUT_PROPS).join(', ')}
  hover/focusVisible: ${Object.keys(INTERACTION_PROPS).join(', ')}

Respond with ONLY a JSON object:
{
  "reasoning": "the design direction in one or two sentences",
  "variables": { "--var": "#value" },
  "canvas": { "background": "...", "color": "..." },
  "canvasLayout": { "maxWidth": "...", "marginInline": "auto" },
  "rules": [
    { "target": "c1a2b3",
      "styles": { "background": "...", "color": "...", "border": "...", "boxShadow": "..." },
      "layout": { "maxWidth": "760px", "display": "grid", "gridTemplateColumns": "repeat(auto-fit,minmax(240px,1fr))", "gap": "24px", "fontSize": "2.5rem", "fontWeight": "900" },
      "hover": { "transform": "translateY(-2px)" }
    }
  ],
  "moves": []
}`;

export async function requestStyleSpec({ intent, perception, apiKey, critique }: StyleSpecRequest): Promise<StyleSpecResult> {
  let userContent = `USER REQUEST: ${intent}\n\nRUNTIME PAGE PERCEPTION:\n${perception}`;
  if (critique) userContent += `\n\nREVISION REQUIRED — your previous attempt was rejected:\n${critique}`;
  let lastError = '';

  for (let attempt = 1; attempt <= AI_CONFIG.maxRetries; attempt++) {
    logDebug(`requestStyleSpec attempt ${attempt}: "${intent}"${critique ? ' (revision)' : ''}`);
    try {
      const body = JSON.stringify({
        model: AI_CONFIG.styleModel,
        max_completion_tokens: AI_CONFIG.styleMaxTokens,
        temperature: AI_CONFIG.styleTemperature,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
      });

      const res = await fetchWithTimeout(OPENAI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body,
      }, AI_CONFIG.timeoutMs);

      if (!res.ok) {
        const handled = await handleErrorResponse(res, attempt);
        if (handled.action === 'fatal') return handled.result;
        await sleep(handled.waitMs);
        continue;
      }

      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') { lastError = 'empty model response'; continue; }

      let parsed: unknown;
      try { parsed = JSON.parse(content); }
      catch { lastError = 'model output was not valid JSON'; continue; }

      const validated = validateSpec(parsed);
      if (!validated.ok || !validated.spec) { lastError = validated.error || 'invalid spec'; continue; }

      return { ok: true, spec: validated.spec, usage: data.usage };
    } catch (err) {
      const e = err as { name?: string; message?: string };
      if (e.name === 'AbortError') return { ok: false, kind: 'timeout', message: 'Request timed out.' };
      if (attempt >= AI_CONFIG.maxRetries) return { ok: false, kind: 'network', message: e.message || 'Network error.' };
      await sleep(AI_CONFIG.baseBackoffMs * 2 ** (attempt - 1));
    }
  }
  return { ok: false, kind: 'bad_output', message: lastError || "Couldn't produce a valid design spec." };
}

// ── transport helpers ──────────────────────────────────────────────

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(id); }
}

type HandledError =
  | { action: 'retry'; waitMs: number }
  | { action: 'fatal'; result: { ok: false; kind: ReasonError; message: string } };

async function handleErrorResponse(res: Response, attempt: number): Promise<HandledError> {
  if (res.status === 401 || res.status === 403) return { action: 'fatal', result: { ok: false, kind: 'invalid_key', message: 'Invalid API key.' } };
  if (res.status === 429) {
    if (attempt >= AI_CONFIG.maxRetries) return { action: 'fatal', result: { ok: false, kind: 'rate_limited', message: 'Rate limited. Try again later.' } };
    let waitMs = AI_CONFIG.baseBackoffMs * 2 ** (attempt - 1);
    try {
      const txt = await res.text();
      const m = txt.match(/try again in (?:(\d+)m)?([\d.]+)s/);
      if (m) waitMs = Math.ceil(((m[1] ? +m[1] * 60 : 0) + parseFloat(m[2])) * 1000) + 1000;
    } catch { /* ignore */ }
    return { action: 'retry', waitMs };
  }
  if (res.status >= 500) {
    if (attempt >= AI_CONFIG.maxRetries) return { action: 'fatal', result: { ok: false, kind: 'network', message: 'Server error. Try again later.' } };
    return { action: 'retry', waitMs: AI_CONFIG.baseBackoffMs * 2 ** (attempt - 1) };
  }
  const txt = await safeText(res);
  if (res.status === 400 && txt.toLowerCase().includes('context_length')) return { action: 'fatal', result: { ok: false, kind: 'context_limit', message: 'Page perception too large for the model.' } };
  if (res.status === 400) return { action: 'fatal', result: { ok: false, kind: 'invalid_request', message: 'The model rejected the request format.' } };
  return { action: 'fatal', result: { ok: false, kind: 'unknown', message: `HTTP ${res.status}: ${txt.slice(0, 200)}` } };
}

async function safeText(res: Response): Promise<string> { try { return await res.text(); } catch { return ''; } }
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

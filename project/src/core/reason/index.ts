/**
 * core/reason — LLM transport + prompt. The ONLY place that talks to the model.
 * Owns retry/backoff/timeout/error-mapping; returns a validated DesignSpec.
 *
 * Simplified system prompt (12 directives). Removed the gpt-4o fallback (a known
 * recolorer — honest error is better than a recolor). No fallback chain: the
 * primary model gets one shot.
 */

import { AI_CONFIG, logDebug } from '../config';
import { validateSpec, type DesignSpec } from '../spec';
import { BASE_PROPS, INTERACTION_PROPS, LAYOUT_PROPS } from '../laws';

export type ReasonError =
  | 'invalid_key' | 'rate_limited' | 'network' | 'timeout'
  | 'bad_output' | 'context_limit' | 'invalid_request' | 'unknown';

export type StyleSpecResult =
  | { ok: true; spec: DesignSpec; usage?: unknown; model?: string; callMs?: number }
  | { ok: false; kind: ReasonError; message: string; callMs?: number };

export interface StyleSpecRequest {
  intent: string;
  perception: string;
  apiKey: string;
  critique?: string; // regenerative-repair feedback appended to the user message
  timeoutMs?: number; // per-call override (used to cap a reReason so total stays < budget)
}

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

const SYSTEM_PROMPT = `You are WebMorph's design engine. Translate a plain-English request into a JSON design system that remakes a website's presentation — layout, surface, typography, hierarchy — without touching content or backend. A recolor is a failure. You get one generation; make it count.

You receive: the user's request + the site's identity (domain + page title) + a runtime picture of the page — canvas, layout skeleton, scrollable containers, components with stable ids (indented by nesting depth), sizes, current styles, and CSS variables. A deterministic compiler applies your JSON spec and enforces safety laws (overflow-safe widths, contrast floors, image protection). Clusters you DON'T style are base-coated: their background is adjusted to match your canvas if it clashes. Base-coat is a safety net, not a design — actively style the major clusters.

## Directives

1. USE THE ROOM. Compose the FULL viewport deliberately. A narrow squeezed column with giant dead margins is a failure. Match content width to the page's purpose: portals, feeds, dashboards, grids → use the full width; only long-form articles take a reading measure. The page's real geometry and viewport width are shown — design within them, don't shrink from them. Choose a deliberate canvas background; if using translucency/blur, make the backdrop rich enough to reveal, and make opaque wrappers (marked [opaque]) transparent so the canvas shows through. A design that narrows the main content to a band with giant dead margins is a failure EVEN IF it changed the layout — a portal/feed/app at 600px on a 1280px viewport with 680px of dead margins is broken; the content width must USE the page's available width.

2. RESHAPE, DON'T RECOLOR. Every aesthetic implies arrangement. A color swap on stock layout is a FAILURE. Change container/content widths, column arrangement, spacing scale, AND set a deliberate canvas background distinct from the site default. Rearrange columns via grid/flex, set widths with maxWidth + marginInline. A spec with only paint and no layout is a recolor — it will fail. Rearrange means MOVE columns and regions — change grid-template-columns count, region order, content maxWidth. A width tweak on unchanged columns with new paint is still a recolor.

3. FLUID, NOT FROZEN. Prefer relative units — %, vw, clamp(), fr, min()/max() — over fixed px. Never freeze a width at the viewport measured at transform time; a wider or narrower window must still look intended. The compiler wraps fixed px in min(X, 100%) as a floor, but YOU choose the responsive value.

4. TYPOGRAPHY IS HALF THE DESIGN. Craft a type scale: explicit fontSize + fontWeight per heading level, a body size, line-height for measure, letter-spacing for voice. Hierarchy is the contrast between sizes and weights, not just color. Set type in the layout bag.

5. SURFACE HIERARCHY. Primary (a few loud containers) / secondary (calm structure) / background (canvas). Most surfaces are calm; loud treatment on a handful. Treat element families consistently — restyle every cluster of a family in the same visual language.

6. ACCENT IS RARE. Never paint the same accent on every member of a repeated cluster (every list row, every card) — it collapses into noise. Reserve accent for singular, prominent regions. Links are content: style calmly, never as accents. Declare paletteMode: "restrained" (default) or "vivid".

7. LEGIBILITY HOLDS. Couple every background with a readable text color — the compiler enforces a contrast floor, but YOU pick colors that contrast. On translucent panels, text stays legible regardless of what shows through. If you paint a DARK surface its text MUST be light; if LIGHT, dark. Never emit a background and text of the same luminance — the contrast floor fixes text color, not a wrong background.

8. IMAGES ARE MATERIAL. Shape, frame, fit, and grade prominent images (marked [image]) — don't leave them untouched. Use borderRadius, border, boxShadow, width/maxWidth/aspectRatio/objectFit, and filter (grayscale/sepia/contrast/brightness). NEVER set a solid background or backgroundImage on a thumbnail — the compiler REFUSES it (it paints over the image). Style around images, not over them.

9. THE CANVAS OBEYS THE VISION. Theme polarity is a design decision: if the aesthetic lives in light, the canvas goes light — even on a dark site or a dark system theme. And vice versa. The canvas serves the design, not the site's current theme.

10. CONTAIN THE CONTENT. Content must not escape its painted background — a child spilling past its parent's surface is broken. Don't narrow a text container below a readable measure: the compiler no longer force-breaks words, so a too-narrow column wraps every word and fails. Dense content (feeds, lists, tables, multi-column grids) must STAY dense — never collapse a multi-column region into one narrow column or hide rows to 'clean up'. Contain = FIT content in its surface, not shrink the surface away.

11. PRUNE CHROME. Set "hide": true on clusters that fight the aesthetic (utility sidebars, promo boxes, banners, appearance widgets). Never hide primary content or navigation people need.

12. COVER THE PAGE. Style the major clusters actively. Leave minor clusters unstyled (base-coat handles them). Every cluster you DO style must join the design system — no original-looking patches among styled regions. Enough of the inventory must be in your rules (at least 15% of the handles).

## Non-negotiables
1. A canvas (background + color) AND canvasLayout (content-width / arrangement decision).
2. Layout on major skeleton regions — widths, spacing, arrangement.
3. A type scale: headings get explicit fontSize/fontWeight; body gets line-height.
4. Image treatment where [image] clusters exist.
5. paletteMode: "restrained" or "vivid".
6. Enough rules to cover the major clusters (at least 15% of the inventory).

## Rules
- Target component ids from the perception. "styles" for paint, "layout" for arrangement/sizing/type. "canvas" + "canvasLayout" for page-level. "composition" for region-level proportions (compiled first).
- The PAGE line gives the site's domain + title — use that context to judge the page's purpose (article vs portal vs app) and pick the right content width. Never hardcode to a domain; reason from what the page IS.
- A page may have several scrollable containers (noted in the perception) — your design applies inside all of them.
- "hide": true removes a cluster (guarded, reversible). Never hide primary content.
- Override CSS variables via "variables" to retheme framework CSS without fighting specificity.
- Named aesthetics are a direction, not a recipe — reason to specific values from the request's intent and the page you see.

Allowed keys:
  styles: ${Object.keys(BASE_PROPS).join(', ')}
  layout: ${Object.keys(LAYOUT_PROPS).join(', ')}
  hover/focusVisible: ${Object.keys(INTERACTION_PROPS).join(', ')}

Respond with exactly this JSON:
{
  "reasoning": "1-2 sentences on direction + key choices",
  "paletteMode": "restrained",
  "variables": { "--var": "value" },
  "canvas": { "background": "...", "color": "..." },
  "canvasLayout": { "maxWidth": "min(100%, 1400px)", "marginInline": "auto" },
  "composition": [
    { "target": "c1a2b3", "layout": { "gridTemplateColumns": "repeat(2, minmax(0,1fr))", "gap": "2rem" } }
  ],
  "rules": [
    { "target": "c1a2b3", "styles": { "background": "...", "color": "..." },
      "layout": { "fontSize": "clamp(2rem, 5vw, 3.5rem)", "fontWeight": "700", "lineHeight": "1.1", "letterSpacing": "-0.02em" },
      "hover": { "transform": "translateY(-2px)" } },
    { "target": "c9z8y7", "hide": true }
  ]
}`;

/**
 * Transport economy (one-shot mandate). The primary reasoning designer gets
 * exactly ONE hard-aborted generation attempt (~120s). No fallback chain —
 * a recolor from a weaker model is a worse failure than an honest error.
 * HTTP retries are reserved for TRANSIENT faults (429/5xx). A 400 that rejects
 * response_format/reasoning_effort drops those params and retries once.
 */
export async function requestStyleSpec({ intent, perception, apiKey, critique, timeoutMs: callTimeout }: StyleSpecRequest): Promise<StyleSpecResult> {
  let userContent = `USER REQUEST: ${intent}\n\nRUNTIME PAGE PERCEPTION:\n${perception}`;
  if (critique) userContent += `\n\nREVISION REQUIRED — your previous attempt was rejected:\n${critique}`;

  const model = AI_CONFIG.styleModel;
  const reasoning = isReasoningModel(model);
  // A reReason passes a reduced timeout so the 2nd call can't push total past the
  // ~120s budget (the long first-call timeout root cause: an unbounded 2nd call after a ~50s 1st).
  const timeout = callTimeout ?? (reasoning ? AI_CONFIG.timeoutMs : AI_CONFIG.fallbackTimeoutMs);
  let useResponseFormat = true;
  let useReasoningEffort = true;
  let transient = 0;

  while (true) {
    const effort = reasoning && useReasoningEffort ? AI_CONFIG.styleReasoningEffort : undefined;
    const bodyObj: Record<string, unknown> = {
      model,
      max_completion_tokens: AI_CONFIG.styleMaxTokens,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: userContent }],
    };
    if (useResponseFormat) bodyObj.response_format = { type: 'json_object' };
    if (effort !== undefined) bodyObj.reasoning_effort = effort;

    logDebug(`call model=${model} effort=${effort ?? '-'} response_format=${useResponseFormat}${critique ? ' (revision)' : ''}`);
    const t0 = Date.now();
    let res: Response;
    try {
      res = await fetchWithTimeout(OPENAI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(bodyObj),
      }, timeout);
    } catch (err) {
      const e = err as { name?: string; message?: string };
      const s = ((Date.now() - t0) / 1000).toFixed(1);
      if (e.name === 'AbortError') { logDebug(`model=${model} TIMEOUT after ${s}s`); return { ok: false, kind: 'timeout', message: `Design engine timed out after ${s}s. Try again.`, callMs: Date.now() - t0 }; }
      if (transient < AI_CONFIG.maxTransientRetries) { transient++; logDebug(`model=${model} network error after ${s}s (${e.message}) — transient retry ${transient}`); await sleep(AI_CONFIG.baseBackoffMs * 2 ** (transient - 1)); continue; }
      return { ok: false, kind: 'network', message: `Network error: ${e.message}`, callMs: Date.now() - t0 };
    }
    const s = ((Date.now() - t0) / 1000).toFixed(1);

    if (!res.ok) {
      const bodyTxt = await safeText(res);
      logDebug(`model=${model} HTTP ${res.status} after ${s}s: ${bodyTxt.slice(0, 300)}`);
      if (res.status === 401 || res.status === 403) return { ok: false, kind: 'invalid_key', message: 'Invalid API key. Check your key in the WebMorph settings.' };
      if (res.status === 400 && bodyTxt.toLowerCase().includes('context_length')) return { ok: false, kind: 'context_limit', message: 'Page is too large for the model. Try a simpler page.' };
      if (res.status === 429 || res.status >= 500) {
        if (transient < AI_CONFIG.maxTransientRetries) { transient++; await sleep(retryWaitMs(bodyTxt, transient)); continue; }
        return { ok: false, kind: 'rate_limited', message: 'Rate limited. Wait a moment and try again.' };
      }
      if (res.status === 400 && (useResponseFormat || useReasoningEffort)) {
        logDebug(`model=${model} 400 — dropping response_format + reasoning_effort, one retry`);
        useResponseFormat = false; useReasoningEffort = false; continue;
      }
      return { ok: false, kind: 'invalid_request', message: `API error (${res.status}): ${bodyTxt.slice(0, 120)}` };
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    logDebug(`model=${model} OK ${s}s tokens=${fmtUsage(data?.usage)}`);
    if (typeof content !== 'string') return { ok: false, kind: 'bad_output', message: 'Model returned no content.' };
    let parsed: unknown;
    try { parsed = JSON.parse(content); } catch { return { ok: false, kind: 'bad_output', message: 'Model output was not valid JSON.' }; }
    const validated = validateSpec(parsed);
    if (!validated.ok || !validated.spec) { logDebug(`model=${model} invalid spec: ${validated.error}`); return { ok: false, kind: 'bad_output', message: `Invalid design spec: ${validated.error}` }; }
    logDebug(`spec produced by ${model}: ${validated.spec.rules.length} rules`);
    return { ok: true, spec: validated.spec, usage: data.usage, model, callMs: Date.now() - t0 };
  }
}

/** Compact token-usage string incl. reasoning tokens when the API reports them. */
function fmtUsage(u: unknown): string {
  const usage = u as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } } | undefined;
  if (!usage) return 'n/a';
  const r = usage.completion_tokens_details?.reasoning_tokens;
  return `prompt=${usage.prompt_tokens ?? '?'} completion=${usage.completion_tokens ?? '?'}${r != null ? ` reasoning=${r}` : ''} total=${usage.total_tokens ?? '?'}`;
}

/** 429 wait: honor the server's "try again in Xs" if present, else exponential backoff. */
function retryWaitMs(bodyTxt: string, transient: number): number {
  const m = bodyTxt.match(/try again in (?:(\d+)m)?([\d.]+)s/);
  if (m) return Math.ceil(((m[1] ? +m[1] * 60 : 0) + parseFloat(m[2])) * 1000) + 500;
  return AI_CONFIG.baseBackoffMs * 2 ** (transient - 1);
}

// ── transport helpers ──────────────────────────────────────────────

/** Reasoning-family models: reasoning_effort supported, temperature rejected. */
function isReasoningModel(model: string): boolean { return /^(gpt-5|o\d)/i.test(model); }

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(id); }
}

async function safeText(res: Response): Promise<string> { try { return await res.text(); } catch { return ''; } }
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

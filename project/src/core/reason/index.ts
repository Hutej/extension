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
  | { ok: true; spec: DesignSpec; usage?: unknown; model?: string }
  | { ok: false; kind: ReasonError; message: string };

export interface StyleSpecRequest {
  intent: string;
  perception: string;
  apiKey: string;
  critique?: string; // regenerative-repair feedback appended to the user message
}

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

const SYSTEM_PROMPT = `You are WebMorph's design engine. You translate a user's plain-English request into a design system that remakes a website's presentation locally in their browser — layout, surface, typography, and hierarchy — without touching the site's content or backend.

You receive: (1) the user's request, and (2) a runtime-discovered picture of the actual page — its current canvas background, layout skeleton, real components with stable ids, their sizes and current computed styles, and any CSS custom properties. A deterministic compiler will apply your JSON spec to exactly those elements.

The goal is a genuine redesign that embodies the request. A recolor is a failure.

## How to think

**Start with the canvas.** The background is never a throwaway. Ask: what surface does this request call for? A warm amber, a cool slate, a void black, a paper white — the canvas sets the whole mood. If you're using translucency or blur on panels, the backdrop you put behind them is the most important thing you'll specify — transparent panels over a near-white background produce nothing. A backdrop only works if it's rich enough to be worth revealing.

**Build a surface system, not a color swap.** Decide which surfaces are primary (the few containers that carry the aesthetic loudly), secondary (supporting structure, calmer), and background (the canvas). Most surfaces should be calm. Loud treatment belongs on a handful of elements — section headers, key cards, a primary CTA — not everything. Applying the same heavy border or accent to every cluster is the same mistake as making every link red: it destroys hierarchy.

**An accent is powerful because it is rare.** "Strong color blocking" means a FEW large, deliberate blocks — a section header, one hero band, a single feature panel — not a colored background on every row of a list or every card in a grid. The moment an accent repeats across a cluster's many members it stops being an accent and becomes the new background: the eye has nothing to land on and the design collapses into noise. When the perception shows a cluster with a high member count (x24, x50…), never give that cluster a loud accent background — treat repeated items as calm secondary surfaces and reserve the accent for the one or two singular, prominent regions. Hierarchy is created by contrast between the loud few and the calm many.

**Declare your palette intent.** Choose "paletteMode": "restrained" or "vivid" from the user's words. "restrained" means a calm palette with accent used sparingly (a few primary elements) — this is the default for most requests. "vivid" means large saturated fields are welcome — "playful primary colors", "bold color blocking", "bright and saturated" all signal vivid. Either way, one law is absolute: NEVER paint the same accent color on every member of a repeated cluster (every row of a list, every card in a grid). That collapses the accent into a new background and destroys the eye's landing point. In vivid mode you may paint large singular fields boldly, but repeated items stay calm.

**Links are content, not accents.** A page may have hundreds of links. Never paint them with your accent color. Style links calmly — inherit the text color, use underline for affordance.

**Treat element families consistently.** If you restyle one cluster of a given family (e.g. one group of links), restyle every cluster of that family in the same visual language. A design where identical elements look different in different places is broken — a link cluster styled as a pill while an identical link cluster stays plain blue is an inconsistent design, not a creative choice. The family is whatever shares the same role and visual weight; consistency is a principle, not a recipe.

**Typography is half the aesthetic.** Weight, scale, tracking, and line-height express a mood as directly as color. A tight grid of oversized black type reads completely differently from light condensed capitals, which reads differently from warm serifed body text. Make deliberate choices across the type scale, not just one font-size.

**Legibility holds on every surface.** When you set a background, couple it with a text color that maintains contrast. On a translucent panel, the panel's own text color must remain legible regardless of what shows through the blur — aim for sufficient opacity or explicitly set the text color.

**Layout is not optional — reshape the page.** Every aesthetic implies an arrangement: a reading column has a width; a terminal is narrow and dense; a newspaper is multi-column; "spacious" literally means more space. Set real content widths (maxWidth + marginInline:auto), a spacing scale (gap, padding, margin), a deliberate type scale across the heading levels, and rearrange columns when the request implies it. A spec whose rules carry only "styles" and no "layout" is a recolor — it will fail verification and come back to you.

**Decide the page COMPOSITION first.** The PAGE COMPOSITION section gives you the skeleton regions with their real geometry — widths, heights, and viewport fractions. Decide which regions exist and their proportions BEFORE designing inside them. Use "composition" rules to rewrite the page's macro layout: widen the article, narrow or stack the sidebar, center a single column, set a grid. The compiler applies composition rules first so component rules can refine within them. Keeping the original skeleton must be a deliberate, declared choice, never a default — a redesign that merely redecorates inside the original proportions is a recolor.

**Design WITH the geometry you're given.** Every region's real width and height is in the brief. A 150px column cannot hold 2 text columns — columnCount:2 there produces one character per line. A "3fr 2fr" grid on a 1280px viewport must fit within 1280px. Read the numbers and design within them. The compiler will clamp what it can (columnCount that doesn't fit is reduced, grid tracks wider than the container are capped, oversized type scales down), but treat that as a safety net — design for the geometry, don't rely on the clamp.

**Design within the viewport.** You are told the viewport width. Every column, grid, and block of display type must fit inside it — a content column wider than the viewport, or type so large it spills past its block, is a broken result that wastes your single design pass. Prefer fluid widths (maxWidth with %, min(), or vw) and a type scale that leaves room. The compiler will clamp anything that still doesn't fit (fixed widths become min(X, 100%); oversized type scales down), but treat that as a safety net, not a plan.

**Images are design material.** Prominent images must be pulled into the design, never left untouched: shape them (borderRadius), frame them (border, boxShadow), fit them (width/maxWidth/aspectRatio/objectFit in "layout"), and grade them with filter (grayscale/sepia/contrast/brightness) when the mood calls for it — phosphor-terminal media wants desaturation, aged newsprint wants grayscale, glass wants rounded translucent frames.

**Remove what does not serve the design.** Real pages carry chrome that fights the aesthetic — utility sidebars, settings panels, banners, promo boxes, appearance widgets. A redesign is also an edit: set "hide": true on clusters that add nothing to the requested experience. Removal is a design decision, not a shortcut — hide peripheral chrome, never the primary content or the navigation people need to use the site. Every region you keep must join the design; if it cannot, hide it.

**Account for EVERY cluster.** The COMPONENTS list is your complete inventory. Every handle in it MUST appear in your rules — restyled (styles/layout), hidden ("hide": true), or explicitly kept ("keep": true). "keep": true means "I examined this cluster and its original design already serves the new aesthetic" — it is rare and must be justifiable; it is NOT a way to skip thinking. A spec that leaves clusters unaccounted is incomplete and will be rejected with the names of the clusters you missed. The all-or-nothing contract: every corner of the page either joins the design or is deliberately kept with justification — no region left looking original by accident.

## Non-negotiables — a spec missing any of these is an invalid submission
1. A deliberate canvas: "canvas" (background + color) AND "canvasLayout" (a real content-width decision).
2. Layout declarations on the major skeleton regions — widths, spacing, arrangement — not paint alone.
3. A deliberate type scale: primary headings get explicit fontSize/fontWeight that express the aesthetic.
4. Image treatment wherever the perception shows [image] clusters — shape, frame, fit, or grade them.
5. A "paletteMode" declaration: "restrained" or "vivid", chosen from the user's words.
6. Cover the page: EVERY cluster handle in the COMPONENTS list is addressed — restyled into the new design system, visibly restructured, deliberately hidden, or explicitly kept ("keep": true). A cluster left unaccounted is a hole in the design and the spec will be rejected.

## Rules
- Target only the component ids in the perception. Use "styles" for paint and "layout" for arrangement/sizing/spacing/type. Use target:"canvas" + "canvasLayout" for the page-level background and base column.
- "hide": true on a rule removes that cluster from the page (reversible, guarded). Use it to prune chrome that fights the design. The compiler refuses hides on primary content and page-scale containers; a blanked page is rolled back.
- When CSS color variables are listed, prefer overriding them via "variables" — it rethemes deep framework CSS without fighting specificity.
- Named aesthetics in the user's request are a direction, not a recipe. Reason your way to the specific values from the request's intent and the page you see — never copy-paste a palette from a template.
- Different prompts must produce visibly different results. Two different pages must also differ. Design for the evidence in front of you.
- Opaque wrappers: the perception marks which clusters are [opaque-wrapper] — large containers covering the full viewport background with a solid opaque background that would hide your canvas. If you set a deliberate canvas background, also make those wrappers transparent (background: transparent) so the canvas shows through.

Allowed keys (anything else is silently dropped by the compiler):
  styles: ${Object.keys(BASE_PROPS).join(', ')}
  layout: ${Object.keys(LAYOUT_PROPS).join(', ')}
  hover/focusVisible: ${Object.keys(INTERACTION_PROPS).join(', ')}

Respond with exactly this JSON shape:
{
  "reasoning": "one or two sentences on the design direction and key choices",
  "paletteMode": "restrained",
  "variables": { "--var": "value" },
  "canvas": { "background": "...", "color": "..." },
  "canvasLayout": { "maxWidth": "...", "marginInline": "auto" },
  "composition": [
    { "target": "c1a2b3", "layout": { "maxWidth": "760px", "marginInline": "auto", "display": "grid", "gridTemplateColumns": "1fr" } },
    { "target": "c4e5f6", "layout": { "width": "100%", "order": "2" } }
  ],
  "rules": [
    { "target": "c1a2b3",
      "styles": { "background": "...", "color": "...", "border": "...", "boxShadow": "..." },
      "layout": { "maxWidth": "760px", "gap": "24px", "fontSize": "2rem", "fontWeight": "700" },
      "hover": { "transform": "translateY(-2px)" }
    },
    { "target": "c9z8y7", "hide": true },
    { "target": "c3d4e5", "keep": true }
  ],
  "moves": []
}`;

/**
 * Transport economy (one-shot mandate). Walk a short model chain: the primary
 * reasoning designer gets exactly ONE hard-aborted generation attempt (~120s);
 * on timeout we fall to the fast model immediately — never wait or retry a timed-
 * out model. HTTP retries are reserved for TRANSIENT faults (429/5xx). A 400 that
 * rejects response_format/reasoning_effort drops those params and retries the
 * SAME model once (the 400 returns instantly). Every attempt logs its params,
 * elapsed time, outcome, and token usage so real cost per run is visible.
 */
export async function requestStyleSpec({ intent, perception, apiKey, critique }: StyleSpecRequest): Promise<StyleSpecResult> {
  let userContent = `USER REQUEST: ${intent}\n\nRUNTIME PAGE PERCEPTION:\n${perception}`;
  if (critique) userContent += `\n\nREVISION REQUIRED — your previous attempt was rejected:\n${critique}`;

  const chain = [AI_CONFIG.styleModel, AI_CONFIG.styleFallbackModel].filter(Boolean);

  for (let mi = 0; mi < chain.length; mi++) {
    const model = chain[mi];
    const reasoning = isReasoningModel(model);
    const timeout = reasoning ? AI_CONFIG.timeoutMs : AI_CONFIG.fallbackTimeoutMs;
    let useResponseFormat = true;
    let useReasoningEffort = true;
    let transient = 0; // 429/5xx retries for THIS model only

    // One model: one real generation attempt (+ at most one param-drop retry,
    // + bounded transient retries). `break` from this loop = fall to next model.
    while (true) {
      const effort = reasoning && useReasoningEffort ? AI_CONFIG.styleReasoningEffort : undefined;
      const temp = reasoning ? undefined : AI_CONFIG.styleFallbackTemperature;
      const bodyObj: Record<string, unknown> = {
        model,
        max_completion_tokens: AI_CONFIG.styleMaxTokens,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: userContent }],
      };
      if (useResponseFormat) bodyObj.response_format = { type: 'json_object' };
      if (effort !== undefined) bodyObj.reasoning_effort = effort;
      if (temp !== undefined) bodyObj.temperature = temp;

      logDebug(`call model=${model} effort=${effort ?? '-'} response_format=${useResponseFormat} temp=${temp ?? '-'}${critique ? ' (revision)' : ''}`);
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
        if (e.name === 'AbortError') { logDebug(`model=${model} TIMEOUT after ${s}s — abort fired, falling through chain`); break; }
        if (transient < AI_CONFIG.maxTransientRetries) { transient++; logDebug(`model=${model} network error after ${s}s (${e.message}) — transient retry ${transient}`); await sleep(AI_CONFIG.baseBackoffMs * 2 ** (transient - 1)); continue; }
        logDebug(`model=${model} network error after ${s}s: ${e.message} — falling through chain`); break;
      }
      const s = ((Date.now() - t0) / 1000).toFixed(1);

      if (!res.ok) {
        const bodyTxt = await safeText(res);
        logDebug(`model=${model} HTTP ${res.status} after ${s}s: ${bodyTxt.slice(0, 300)}`);
        if (res.status === 401 || res.status === 403) return { ok: false, kind: 'invalid_key', message: 'Invalid API key.' };
        if (res.status === 400 && bodyTxt.toLowerCase().includes('context_length')) return { ok: false, kind: 'context_limit', message: 'Page perception too large for the model.' };
        // Transient server faults: retry the SAME model, bounded.
        if (res.status === 429 || res.status >= 500) {
          if (transient < AI_CONFIG.maxTransientRetries) { transient++; await sleep(retryWaitMs(bodyTxt, transient)); continue; }
          break; // exhausted -> next model
        }
        // Param rejected (e.g. reasoning_effort/response_format unsupported): drop
        // them and retry the SAME model once — the 400 came back instantly.
        if (res.status === 400 && (useResponseFormat || useReasoningEffort)) {
          logDebug(`model=${model} 400 — dropping response_format + reasoning_effort, one retry`);
          useResponseFormat = false; useReasoningEffort = false; continue;
        }
        break; // 404 / other -> next model
      }

      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      logDebug(`model=${model} OK ${s}s tokens=${fmtUsage(data?.usage)}`);
      if (typeof content !== 'string') break;
      let parsed: unknown;
      try { parsed = JSON.parse(content); } catch { logDebug(`model=${model} output was not valid JSON — falling through`); break; }
      const validated = validateSpec(parsed);
      if (!validated.ok || !validated.spec) { logDebug(`model=${model} invalid spec: ${validated.error} — falling through`); break; }
      logDebug(`spec produced by ${model}: ${validated.spec.rules.length} rules`);
      return { ok: true, spec: validated.spec, usage: data.usage, model };
    }
    if (mi < chain.length - 1) logDebug(`falling back to ${chain[mi + 1]}`);
  }
  return { ok: false, kind: 'timeout', message: 'All models in the chain failed or timed out.' };
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

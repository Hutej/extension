/**
 * core/reason — LLM transport + role prompts. The ONLY place that talks to the model.
 *
 * The monolithic system prompt is SPLIT into three role prompts so each call is
 * smaller (faster, cheaper, better-focused) and runs on the model that fits it:
 *   - ARCHITECT — composition only: regions, grid, ordering, spacing, width
 *     fractions (in %, never px — the geometry law is baked into the contract).
 *     No colors. Runs on the strongest model (composition is the hard part).
 *   - PAINTER   — palette + typography only: canvas bg/color, CSS variables,
 *     paletteMode, per-cluster surface/onSurface pairs + a type scale. No layout.
 *     Every pair is contrast-verified by OUR code at compile (a failing pair is
 *     deterministically corrected before it ships). Runs on a mid model.
 *   - CRITIC    — repair only: takes the bundled failure critique + a compact
 *     perception diff, returns a minimal correction spec. Small + fast, on the
 *     fastest model.
 *
 * Architect and Painter run in PARALLEL (independent inputs); compile joins them.
 * No fallback chain — the primary models get one shot each; honest error > recolor.
 * HTTP retries are reserved for TRANSIENT faults (429/5xx).
 */

import { AI_CONFIG, logDebug } from '../config';
import { validateSpec, type DesignSpec } from '../spec';
import { BASE_PROPS, INTERACTION_PROPS, LAYOUT_PROPS } from '../laws';

export type ReasonError =
  | 'invalid_key' | 'rate_limited' | 'network' | 'timeout'
  | 'bad_output' | 'context_limit' | 'invalid_request' | 'unknown';

export type Role = 'architect' | 'painter' | 'critic' | 'design';

export type StyleSpecResult =
  | { ok: true; spec: DesignSpec; usage?: unknown; model?: string; callMs?: number }
  | { ok: false; kind: ReasonError; message: string; callMs?: number };

export interface StyleSpecRequest {
  intent: string;
  perception: string;
  apiKey: string;
  critique?: string; // regenerative-repair feedback appended to the user message
  timeoutMs?: number; // per-call override (used to cap a Critic round so total stays < budget)
}

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

// ── Role prompts ────────────────────────────────────────────────────

/** ARCHITECT — composition only. Regions, grid, ordering, spacing, width
 *  fractions IN PERCENT (never px — the geometry law). No colors. */
const ARCHITECT_PROMPT = `You are WebMorph's ARCHITECT. You reshape a website's STRUCTURE — layout, arrangement, proportions, type scale — without touching color or content. A recolor-without-rearrangement is a failure.

You receive: the user's request + the site's identity (domain + page title) + a runtime picture of the page — canvas, layout skeleton, scrollable containers, components with stable ids (indented by nesting depth), sizes, widths (both % of viewport and % of parent), and CSS variables. A deterministic compiler applies your JSON spec and enforces safety laws (overflow-safe widths, zoom-proof percentages, contrast floors). Your job is the BONES; a Painter colors them next.

## Directives

1. USE THE ROOM. Compose the FULL viewport deliberately. A narrow squeezed column with giant dead margins is a failure. Match content width to the page's purpose: portals, feeds, dashboards, grids → use the full width; only long-form articles take a reading measure. The page's real geometry and viewport width are shown — design within them, don't shrink from them.

2. RESHAPE, DON'T RECOLOR. Every aesthetic implies arrangement. Change container/content widths, column arrangement, spacing scale. Rearrange columns via grid/flex, set widths with maxWidth + marginInline. A spec with no layout change is a failure. Rearrange means MOVE columns and regions — change grid-template-columns count, region order, content maxWidth.

3. WIDTHS IN PERCENT, NEVER PX. Every width, maxWidth, minWidth, and grid track you emit must be a PERCENTAGE (or fr/minmax/min()/clamp()). The compiler converts any fixed px to a percentage of the measured parent automatically, but YOU choose the responsive value directly. A fixed px width freezes the design at one viewport and shifts its proportion under browser zoom — a percentage tracks the viewport at every size. The perception gives each cluster's % of parent; design within those fractions.

4. TYPOGRAPHY IS HALF THE DESIGN. Craft a type scale: explicit fontSize + fontWeight per heading level, a body size, line-height for measure, letter-spacing for voice. Hierarchy is the contrast between sizes and weights. Set type in the layout bag.

5. SURFACE HIERARCHY (structure). Primary (a few loud containers) / secondary (calm structure) / background (canvas). Most surfaces are calm; loud treatment on a handful. Treat element families consistently — restyle every cluster of a family in the same structural language.

6. CONTAIN THE CONTENT. Content must not escape its container — a child spilling past its parent's surface is broken. Don't narrow a text container below a readable measure: the compiler no longer force-breaks words, so a too-narrow column wraps every word and fails. Dense content (feeds, lists, tables, multi-column grids) must STAY dense — never collapse a multi-column region into one narrow column.

7. PRUNE CHROME. Set "hide": true on clusters that fight the aesthetic (utility sidebars, promo boxes, banners, appearance widgets). Never hide primary content or navigation people need.

8. OPS — WHEN CSS IS NOT ENOUGH. You also have structural DOM operations for the cases CSS cannot solve. Use them SPARINGLY — CSS layout is your default; reach for an op ONLY where CSS truly can't do the job:
   - "remove": collapse an EMPTY or decorative container so its space is RECLAIMED by the layout (CSS display:none can leave a dead band; remove reflows the parent). Target a cluster marked emptyN (near-empty). Never remove content; the compiler refuses non-empty clusters.
   - "reorder": a TRUE source-order change — moving a region to the top/bottom of its parent. Use this when a flex/grid 'order' hack isn't a real reorder (order leaves the DOM source for screen readers + SEO in the old order).
   - "move": reparent a region into another, or "to":"floating" for a position:fixed mini-player (a video that stays visible while scrolling). The cluster's move-safety is shown (forbid-move / risky-move); risky targets need "consent":true — a second thought, not a reflex.
   - "wrap": group a set of regions under one new container for layout (a flex/grid wrapper CSS can't target because the parent isn't a cluster you own).
   An empty region is REMOVED, not decorated. A sidebar that fights the composition is RELOCATED, not repainted. A true source-order change uses "reorder". A floating mini-player uses "move" with "to":"floating". Default to CSS; ops are rare and deliberate.

## Non-negotiables
1. canvasLayout (content-width / arrangement decision).
2. Layout on major skeleton regions — widths, spacing, arrangement.
3. A type scale: headings get explicit fontSize/fontWeight; body gets line-height.
4. Enough rules to cover the major clusters (at least 15% of the inventory).

## Rules
- Target component ids from the perception. "layout" for arrangement/sizing/type. "canvasLayout" for page-level. "composition" for region-level proportions (compiled first). "hide": true to remove a cluster (guarded, reversible). "ops" for the structural DOM operations above (validated by the compiler, executed reversibly — refusals logged).
- The PAGE line gives the site's domain + title — use that context to judge the page's purpose (article vs portal vs app) and pick the right content width. Never hardcode to a domain; reason from what the page IS.
- A page may have several scrollable containers (noted in the perception) — your design applies inside all of them.

Allowed layout keys:
  ${Object.keys(LAYOUT_PROPS).join(', ')}

Respond with exactly this JSON (NO colors — only layout/composition/canvasLayout/hide + ops):
{
  "reasoning": "1-2 sentences on the structural direction + key choices",
  "canvasLayout": { "maxWidth": "92%", "marginInline": "auto" },
  "composition": [
    { "target": "c1a2b3", "layout": { "gridTemplateColumns": "repeat(2, minmax(0,1fr))", "gap": "2rem" } }
  ],
  "ops": [
    { "kind": "remove", "target": "c9z8y7" },
    { "kind": "move", "target": "c4b5a6", "to": "floating", "consent": true }
  ],
  "rules": [
    { "target": "c1a2b3", "layout": { "fontSize": "clamp(2rem, 5vw, 3.5rem)", "fontWeight": "700", "lineHeight": "1.1" } },
    { "target": "c8d7e6", "hide": true }
  ]
}`;

/** PAINTER — palette + typography only. Canvas bg/color, CSS variables, paletteMode,
 *  per-cluster surface/onSurface pairs + type. No layout. Every color pair is
 *  contrast-verified by our code at compile (≥4.5); a failing pair is corrected
 *  deterministically before it ships. */
const PAINTER_PROMPT = `You are WebMorph's PAINTER. You choose the COLOR and TYPOGRAPHY that remake a website's surface — the palette, the canvas, the text — without touching layout or content. You receive the user's request, the site's identity, and a runtime picture of the page (components with stable ids, their current colors/fonts, CSS variables). The ARCHITECT has already set the structure; you paint it.

## Directives

1. THE CANVAS OBEYS THE VISION. Theme polarity is a design decision: if the aesthetic lives in light, the canvas goes light — even on a dark site or a dark system theme. And vice versa. The canvas serves the design, not the site's current theme. Choose a deliberate canvas background; if using translucency/blur, make the backdrop rich enough to reveal.

2. ACCENT IS RARE. Never paint the same accent on every member of a repeated cluster (every list row, every card) — it collapses into noise. Reserve accent for singular, prominent regions. Links are content: style calmly, never as accents. Declare paletteMode: "restrained" (default) or "vivid".

3. LEGIBILITY HOLDS. Couple every background with a readable text color — the compiler enforces a contrast floor (≥4.5), but YOU pick colors that contrast. On translucent panels, text stays legible regardless of what shows through. If you paint a DARK surface its text MUST be light; if LIGHT, dark. Never emit a background and text of the same luminance. Text placed over a GRADIENT must contrast against EVERY stop of the gradient.

4. TYPOGRAPHY IS HALF THE DESIGN. Craft a type scale: explicit fontSize + fontWeight per heading level, a body size, line-height for measure, letter-spacing for voice. Hierarchy is the contrast between sizes and weights, not just color.

5. IMAGES ARE MATERIAL. Shape, frame, fit, and grade prominent images (marked [image]) — don't leave them untouched. Use borderRadius, border, boxShadow, filter (grayscale/sepia/contrast/brightness). NEVER set a solid background or backgroundImage on a thumbnail — the compiler REFUSES it (it paints over the image).

6. COVER THE PAGE. Style the major clusters actively. Leave minor clusters unstyled (a base-coat handles them). Every cluster you DO style must join the palette — no original-looking patches among styled regions. Enough of the inventory must be in your rules (at least 15% of the handles).

## Non-negotiables
1. A canvas (background + color).
2. paletteMode: "restrained" or "vivid".
3. A type scale: headings get explicit fontSize/fontWeight; body gets line-height.
4. Image treatment where [image] clusters exist.
5. Enough rules to cover the major clusters (at least 15% of the inventory).

## Rules
- Target component ids from the perception. "styles" for paint, "hover"/"focusVisible" for interaction paint. "canvas" for the page background + base text. "variables" to retheme framework CSS (overrides :root vars).
- Named aesthetics are a direction, not a recipe — reason to specific values from the request's intent and the page you see.

Allowed style keys:
  ${Object.keys(BASE_PROPS).join(', ')}
  hover/focusVisible: ${Object.keys(INTERACTION_PROPS).join(', ')}

Respond with exactly this JSON (NO layout — only color/canvas/variables/paletteMode + type):
{
  "reasoning": "1-2 sentences on the palette + type direction",
  "paletteMode": "restrained",
  "variables": { "--var": "value" },
  "canvas": { "background": "...", "color": "..." },
  "rules": [
    { "target": "c1a2b3", "styles": { "background": "...", "color": "..." }, "hover": { "transform": "translateY(-2px)" } }
  ]
}`;

/** CRITIC — repair only. Takes the bundled failure critique + a compact perception
 *  diff, returns a minimal correction spec (a patch to the merged spec). Small,
 *  fast, on the fastest model. */
const CRITIC_PROMPT = `You are WebMorph's CRITIC. A previous design attempt FAILED verification. You receive the user's request, the page perception, and a list of SPECIFIC failures. Return a MINIMAL correction spec — only the rules that fix the named failures, not a full redesign.

Fix each failure with the smallest change that resolves it:
- INVISIBLE TEXT / low contrast → change the background or text color of the named cluster so the text is readable against its surface (≥4.5 contrast). Over a gradient, contrast against every stop.
- VOID (blanked surface) → restore the cluster's background so its content is visible.
- SQUEEZE (text too narrow) → widen the cluster (maxWidth/width in %, or drop the columnCount).
- RECOLOR / no-reshape / dead-margin band → change the structure: column count, content/region widths (in %), arrangement. A color swap on stock layout is a failure.
- COVERAGE gaps → restyle or hide the named unaddressed clusters.
- OVER-ACCENT → strip the accent background from the repeated/over-prominent clusters.

Allowed layout keys: ${Object.keys(LAYOUT_PROPS).join(', ')}
Allowed style keys: ${Object.keys(BASE_PROPS).join(', ')} (hover/focusVisible: ${Object.keys(INTERACTION_PROPS).join(', ')})

Respond with exactly this JSON — ONLY the corrections, targeted at the failing clusters' ids:
{
  "reasoning": "1-2 sentences on the fixes",
  "rules": [
    { "target": "c1a2b3", "styles": { "color": "..." }, "layout": { "maxWidth": "92%" } }
  ]
}`;

// Backward-compat: the full (monolithic) prompt is retained for the restyle-only
// Painter-alone path's non-palette fallback and as a reference. Not used by the
// parallel Architect+Painter design path.
const SYSTEM_PROMPT = PAINTER_PROMPT;

// ── Transport ───────────────────────────────────────────────────────

/** Pick the model for a role. The design path runs Architect + Painter in parallel
 *  on their per-role models; Critic repair runs on the fastest model. The
 *  restyle-only path uses the Painter model alone. Env-overridable (WM_MODEL_*). */
function modelForRole(role: Role): string {
  switch (role) {
    case 'architect': return AI_CONFIG.architectModel;
    case 'painter': return AI_CONFIG.painterModel;
    case 'critic': return AI_CONFIG.criticModel;
    default: return AI_CONFIG.styleModel;
  }
}

/** Pick the system prompt for a role. */
function promptForRole(role: Role): string {
  switch (role) {
    case 'architect': return ARCHITECT_PROMPT;
    case 'painter': return PAINTER_PROMPT;
    case 'critic': return CRITIC_PROMPT;
    default: return SYSTEM_PROMPT;
  }
}

/** Shared model call. One hard-aborted attempt per call; HTTP retries for TRANSIENT
 *  faults (429/5xx) only. A 400 that rejects response_format/reasoning_effort drops
 *  those params and retries once. Returns a validated DesignSpec (role prompts emit
 *  partial specs — validateSpec accepts layout-only and styles-only rules). */
async function callModel(role: Role, intent: string, perception: string, apiKey: string, critique: string | undefined, timeoutMs: number | undefined): Promise<StyleSpecResult> {
  let userContent = `USER REQUEST: ${intent}\n\nRUNTIME PAGE PERCEPTION:\n${perception}`;
  if (critique) userContent += `\n\nREVISION REQUIRED — the previous attempt was rejected:\n${critique}`;

  const model = modelForRole(role);
  const prompt = promptForRole(role);
  const reasoning = isReasoningModel(model);
  // Per-role timeout: the Architect (composition) on a large page can run long;
  // cap it SHORT of the absolute budget so the parallel design stage doesn't hang
  // and push the whole transform past the hard abort. The Painter gets the full
  // budget (palette is the long part). The Critic is capped by the caller (remaining).
  const roleDefault = role === 'architect' ? AI_CONFIG.architectTimeoutMs : role === 'painter' ? AI_CONFIG.painterTimeoutMs : role === 'critic' ? AI_CONFIG.criticTimeoutMs : AI_CONFIG.timeoutMs;
  const timeout = timeoutMs ?? (reasoning ? roleDefault : AI_CONFIG.fallbackTimeoutMs);
  let useResponseFormat = true;
  let useReasoningEffort = true;
  let transient = 0;

  while (true) {
    const effort = reasoning && useReasoningEffort ? AI_CONFIG.styleReasoningEffort : undefined;
    const bodyObj: Record<string, unknown> = {
      model,
      max_completion_tokens: AI_CONFIG.styleMaxTokens,
      messages: [{ role: 'system', content: prompt }, { role: 'user', content: userContent }],
    };
    if (useResponseFormat) bodyObj.response_format = { type: 'json_object' };
    if (effort !== undefined) bodyObj.reasoning_effort = effort;

    logDebug(`call role=${role} model=${model} effort=${effort ?? '-'} response_format=${useResponseFormat}${critique ? ' (revision)' : ''}`);
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
      if (e.name === 'AbortError') { logDebug(`role=${role} model=${model} TIMEOUT after ${s}s`); return { ok: false, kind: 'timeout', message: `Design engine timed out after ${s}s. Try again.`, callMs: Date.now() - t0 }; }
      if (transient < AI_CONFIG.maxTransientRetries) { transient++; logDebug(`role=${role} model=${model} network error after ${s}s (${e.message}) — transient retry ${transient}`); await sleep(AI_CONFIG.baseBackoffMs * 2 ** (transient - 1)); continue; }
      return { ok: false, kind: 'network', message: `Network error: ${e.message}`, callMs: Date.now() - t0 };
    }
    const s = ((Date.now() - t0) / 1000).toFixed(1);

    if (!res.ok) {
      const bodyTxt = await safeText(res);
      logDebug(`role=${role} model=${model} HTTP ${res.status} after ${s}s: ${bodyTxt.slice(0, 300)}`);
      if (res.status === 401 || res.status === 403) return { ok: false, kind: 'invalid_key', message: 'Invalid API key. Check your key in the WebMorph settings.' };
      if (res.status === 400 && bodyTxt.toLowerCase().includes('context_length')) return { ok: false, kind: 'context_limit', message: 'Page is too large for the model. Try a simpler page.' };
      if (res.status === 429 || res.status >= 500) {
        if (transient < AI_CONFIG.maxTransientRetries) { transient++; await sleep(retryWaitMs(bodyTxt, transient)); continue; }
        return { ok: false, kind: 'rate_limited', message: 'Rate limited. Wait a moment and try again.' };
      }
      if (res.status === 400 && (useResponseFormat || useReasoningEffort)) {
        logDebug(`role=${role} model=${model} 400 — dropping response_format + reasoning_effort, one retry`);
        useResponseFormat = false; useReasoningEffort = false; continue;
      }
      return { ok: false, kind: 'invalid_request', message: `API error (${res.status}): ${bodyTxt.slice(0, 120)}` };
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    logDebug(`role=${role} model=${model} OK ${s}s tokens=${fmtUsage(data?.usage)}`);
    if (typeof content !== 'string') return { ok: false, kind: 'bad_output', message: 'Model returned no content.' };
    let parsed: unknown;
    try { parsed = JSON.parse(content); } catch { return { ok: false, kind: 'bad_output', message: 'Model output was not valid JSON.' }; }
    const validated = validateSpec(parsed);
    if (!validated.ok || !validated.spec) { logDebug(`role=${role} model=${model} invalid spec: ${validated.error}`); return { ok: false, kind: 'bad_output', message: `Invalid design spec: ${validated.error}` }; }
    logDebug(`role=${role} spec produced by ${model}: ${validated.spec.rules.length} rules`);
    return { ok: true, spec: validated.spec, usage: data.usage, model, callMs: Date.now() - t0 };
  }
}

/** ARCHITECT call — composition only. Returns a partial spec (layout/composition/
 *  canvasLayout/hide). The caller merges this with the Painter's spec. */
export function requestArchitectSpec(req: StyleSpecRequest): Promise<StyleSpecResult> {
  return callModel('architect', req.intent, req.perception, req.apiKey, req.critique, req.timeoutMs);
}

/** PAINTER call — palette + typography only. Returns a partial spec (canvas/
 *  variables/paletteMode/styles). The caller merges this with the Architect's spec. */
export function requestPainterSpec(req: StyleSpecRequest): Promise<StyleSpecResult> {
  return callModel('painter', req.intent, req.perception, req.apiKey, req.critique, req.timeoutMs);
}

/** CRITIC call — repair only. Takes the bundled failure critique, returns a minimal
 *  correction spec (a patch). Runs on the fastest model within the time budget. */
export function requestCriticCorrection(req: StyleSpecRequest): Promise<StyleSpecResult> {
  return callModel('critic', req.intent, req.perception, req.apiKey, req.critique, req.timeoutMs);
}

/** Single-call path (restyle-only / fallback). One model, one prompt, one spec. */
export async function requestStyleSpec({ intent, perception, apiKey, critique, timeoutMs: callTimeout }: StyleSpecRequest): Promise<StyleSpecResult> {
  return callModel('design', intent, perception, apiKey, critique, callTimeout);
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

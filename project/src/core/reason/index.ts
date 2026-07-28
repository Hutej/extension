/**
 * core/reason — LLM transport + role prompts. The ONLY place that talks to the model.
 *
 * The monolithic system prompt is SPLIT into three role prompts so each call is
 * smaller (faster, cheaper, better-focused) and runs on the model that fits it:
 *   - ARCHITECT — the structure: per-role INTENTS (emphasis/density/placement/
 *     measure) + the pack choice. No raw px, no colors. The expander derives
 *     the composition/ops from the placement intents.
 *   - PAINTER   — the surface: the aesthetic layer in TOKEN GRAMMAR (named
 *     accents, scale steps, surface tiers, type-ramp roles) + the canvas +
 *     paletteMode + pack overrides. No raw px/hex. The expander resolves the
 *     tokens against the pack.
 *   - CRITIC    — repair only: intent corrections (preferred) or a raw
 *     escape-hatch rule for a failure the intents can't fix.
 *
 * Phase 2: the PRIMARY model output is per-role design INTENTS, not raw
 * declarations. The raw `rules` path is a BOUNDED escape hatch — the model may
 * emit a raw rule on a specific handle when the intent vocabulary can't express
 * the design; every escape-hatch use is logged loudly (the count + the FRACTION
 * of targets = the vocabulary-gap metric). Intents target roles/groups/handles,
 * so identical families can no longer be half-styled (family consistency by
 * construction).
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
  accountId: string;   // Cloudflare account id — builds the Workers AI endpoint URL
  apiKey: string;      // bearer token — Cloudflare API token (OPENAI key disabled, kept for revert)
  critique?: string; // regenerative-repair feedback appended to the user message
  timeoutMs?: number; // per-call override (used to cap a Critic round so total stays < budget)
}

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
// OPENAI — disabled in favor of Cloudflare Workers AI, kept for easy revert.
// Cloudflare Workers AI exposes an OpenAI-COMPATIBLE chat-completions endpoint:
// identical request body (messages/response_format/reasoning_effort/max_completion_tokens)
// and identical response shape (choices[0].message.content + usage), so the existing
// request builder + response parser are reused — no forked adapter. Only the URL +
// the bearer token source differ (token + account id come from chrome.storage.local,
// injected by the harness, mirroring the old OpenAI key injection).
const cfChatUrl = (accountId: string): string =>
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`;

// ── Role prompts (Phase 2 — the role-intent DSL) ───────────────────
//
// The PRIMARY model output is per-role design INTENTS + a design-language pack
// choice. The model does NOT emit raw px spacing values, raw px type sizes, or
// raw colors — it emits TOKEN GRAMMAR (spacing steps, type-ramp roles, named
// accents, surface tiers) the deterministic expander resolves against the pack.
// The raw `rules` path is a BOUNDED escape hatch: the model MAY emit a raw rule
// on a specific handle when the intent vocabulary can't express the design;
// every escape-hatch use is logged loudly (the count + the FRACTION of targets =
// the vocabulary-gap metric; > 20% on a grid run = a loud pivot-failure flag).
//
// Intents target a role ("listing"), a group ("g4x2y1"), or a single handle
// ("c1a2b3"); role/group targets fan out to every member, so identical families
// can no longer be half-styled (family consistency by construction).

/** ARCHITECT — the structure: per-role INTENTS (emphasis / density / placement /
 *  measure) + the pack choice. No raw px, no colors. The expander derives the
 *  composition/ops from placement intents, so the Architect stops hand-writing
 *  composition/ops for the reflow cases the intents cover. */
const ARCHITECT_PROMPT = `You are WebMorph's ARCHITECT. You reshape a website's STRUCTURE by emitting per-role DESIGN INTENTS — not raw CSS. A deterministic expander maps your intents + a design-language pack to the concrete CSS the compiler emits. You choose the BONES; a Painter chooses the surface.

You receive: the user's request + the site's identity + a runtime picture of the page — the COMPOSITION (the page's macro shape up front), the design-language PACKS library, components with stable ids each led by its DESIGN ROLE (page-title/article-body/nav-primary/...), dominance, and group ids. The expander enforces the safety laws (overflow-safe widths, zoom-proof percentages, contrast floors). Your job: decide WHAT each region is (its emphasis, density, placement, measure), not the raw CSS.

## The intent vocabulary (your PRIMARY output) — CLOSED ENUMS, exact values

Emit "intents": a SMALL set — at MOST 6 entries, one per MAJOR ROLE. Target a ROLE ("page-title", "article-body", "nav-primary", "listing", "sidebar", "footer-chrome") to fan out to every cluster of that role in one intent. Target a GROUP ("g4x2y1") for a specific sibling group. Do NOT emit one intent per handle — role-level intents cover the page in a few entries; reasoning over per-handle rules is slow and wastes the budget. Role/group targets give family consistency by construction. Keep the output small and fast (≤6 intents — the expander fans each out, so one role intent styles every member).

CRITICAL — the intent fields are CLOSED ENUMS. Each field takes EXACTLY ONE of the listed string values — nothing else. A free-text description, a sentence, a px value, or a made-up word is INVALID and the whole intent is dropped. Put any descriptive reasoning in "reasoning", NOT in the intent fields. The descriptive SURFACE (colors, textures, type styling, gradients) is the PAINTER's aesthetic layer — NOT these structural fields.

Each intent (only the fields you need; each value MUST be one of the listed strings):
- emphasis: EXACTLY one of "hero" | "normal" | "de-emphasized" | "hidden". Hero = display type + a loud surface; normal = body type; de-emphasized = small type + muted color; hidden = removed (guarded — the expander REFUSES hidden on a role the classifier is < 0.5 sure about; never hide primary content).
- density: EXACTLY one of "compact" | "comfortable" | "spacious". The expander maps this to spacing-scale steps + line-height from the pack.
- placement: EXACTLY one of "keep" | "topbar" | "collapse" | "relocate", OR {kind:"relocate", to:"<handle>"}. "topbar" turns a sidebar into a full-width top bar (the expander emits the reorder + the grid change); "collapse" removes a high-confidence void (gated — refused on low-confidence roles); "relocate" moves it. The expander derives the structural ops from these, so you STOP hand-writing "composition"/"ops" for reflow.
- measure: EXACTLY one of "prose" | "full" | "compact". The expander maps this to the pack's measure, percentified (zoom-proof).

A correct intent looks like: {"target": "page-title", "emphasis": "hero"} or {"target": "nav-local", "placement": "topbar"} or {"target": "article-body", "emphasis": "normal", "density": "comfortable", "measure": "prose"}. NEVER {"target": "c1a2b3", "emphasis": "explosive magenta banner"} — that is invalid (emphasis is not a free-text field).

## Pick a pack

Emit "pack": one of the pack ids from the DESIGN PACKS block. The pack is the design SYSTEM (its spacing scale, type ramp, surface system, color relationships). Pick the pack whose archetype fits the user's aesthetic; the Painter adapts it further. Never hardcode to a site — pick by archetype.

## The escape hatch (rare, logged)

You MAY emit a raw "rules" entry (styles/layout on a specific handle) ONLY when the intent vocabulary genuinely can't express the design. This is the exception, not the default — every escape-hatch use is logged and counted (a high fraction = the vocabulary has a gap). Prefer an intent + a pack override. Do NOT emit per-handle escape-hatch rules for regions a role intent already covers — that is redundant and slow.

## Non-negotiables
1. A pack choice.
2. canvasLayout (the page-level content-width / arrangement decision).
3. intents covering the major roles (at least 15% of the inventory) — hero the page title, body the article, de-emphasize or hide chrome, reflow warranted side-rails. ≤6 intents — one per major role, role/group targets only.
4. Address EVERY warranted reflow (the perception's REFLOW line names the side-rail handles) — a "topbar"/"collapse"/"relocate" placement on each, OR a measure that reflows it. Leaving a warranted reflow untouched is a failure. BUT: a rail marked "forbid-move"/"risky-move" CANNOT be reordered (the guard refuses) — on those, do NOT use "topbar" (its width change alone widens the rail in place → overflow). Reclaim its space with emphasis "hidden" on the rail's role (the user wants it gone), or "collapse" if it's a high-confidence void.

## Directives
1. USE THE ROOM. Compose the full viewport; match the measure to the page's purpose (portals/feeds/grids -> "full"; long-form articles -> "prose").
2. RESHAPE, DON'T RECOLOR. Every aesthetic implies arrangement. A spec with no structural intent is a failure.
3. TREAT FAMILIES CONSISTENTLY. Target a role or a group so every member gets the same intent — never half-style a family.
4. PRUNE CHROME. "hidden" or "collapse" on peripheral chrome; the expander guards primary content and low-confidence roles.
5. The PAGE line gives the site's domain + title — reason to the page's purpose; never hardcode to a domain.

Respond with exactly this JSON (NO raw colors; structural intents + the pack choice + canvasLayout; the escape-hatch rules only when the vocabulary can't express it):
{
  "reasoning": "1-2 sentences on the structural direction + the pack choice",
  "pack": "minimal-editorial",
  "canvasLayout": { "maxWidth": "92%", "marginInline": "auto" },
  "intents": [
    { "target": "page-title", "emphasis": "hero" },
    { "target": "article-body", "emphasis": "normal", "measure": "prose", "density": "comfortable" },
    { "target": "nav-local", "placement": "topbar" },
    { "target": "c9z8y7", "placement": "collapse" },
    { "target": "footer-chrome", "emphasis": "de-emphasized" }
  ]
}`;

/** PAINTER — the surface: the aesthetic layer (in token grammar) + the canvas +
 *  paletteMode + pack overrides. No raw px type sizes (a type-ramp role), no raw
 *  hex accents (a named accent), no raw px radii/borders/shadows (scale steps).
 *  The expander resolves the tokens against the pack. */
const PAINTER_PROMPT = `You are WebMorph's PAINTER. You choose the SURFACE that remakes a website — the aesthetic layer — by emitting per-role aesthetic INTENTS in TOKEN GRAMMAR + the canvas + paletteMode + pack overrides. The ARCHITECT chose the structure + the pack; you adapt the pack's surface to the user's aesthetic.

You receive the user's request, the site identity, the DESIGN PACKS library, and the runtime page picture (components led by their DESIGN ROLE + current colors/fonts). The expander resolves your tokens against the pack + your packOverrides; the compiler enforces contrast (>=4.5). Your job: the surface language, not raw CSS.

## The aesthetic intent (in TOKEN GRAMMAR — never raw px/hex)

Emit "intents" with the "aesthetic" field per role/group/handle. The expander resolves each against the pack. CRITICAL — the values are CLOSED:
- accent: a pack accent NAME — the string "primary" or "muted" (or a name you ADD to packOverrides.colors.accents, then reference it by that name here). NEVER a raw hex, never a sentence. The expander looks the name up; a hex here does nothing.
- surface: EXACTLY one of "flat" | "raised" | "overlay".
- radiusStep: a NUMBER — a step index into the pack's radiusScale (0-based). NEVER a raw px string.
- borderStep: a NUMBER — a step index into the pack's borderScale.
- shadowStep: a NUMBER — a step index into the pack's shadowScale.
- texture: EXACTLY one of "none" | "grain" | "glass" (glass adds a backdrop-blur).
- typeRamp: EXACTLY one of "display" | "heading" | "body" | "small".

A correct aesthetic intent: {"target": "page-title", "aesthetic": {"accent": "primary", "surface": "raised", "radiusStep": 2, "shadowStep": 2, "typeRamp": "display"}}. Put descriptive reasoning (a carnival magenta gradient, a feathered border) in "reasoning" or packOverrides — NOT in these fields.

## Pack overrides (blend for a novel prompt)

Emit "packOverrides" to adapt any pack field to the user's aesthetic — every pack field is model-overridable. The expander overlays your overrides on the chosen pack; packs floor quality, they must not cap creativity (a novel prompt overrides the pack). Use the EXACT field names from the DESIGN PACKS block:
- colors: { canvas: "#hex", text: "#hex", subtle: "#hex", accents: { primary: "#hex", ... } } — add named accents here, then reference them by name in an aesthetic intent's "accent".
- canvas: the page background (also set in "canvas", not just here).
- typeRamp: { display: 52, heading: 34, body: 17, small: 13 } — px per type role.
- measurePx: { prose: 620, full: 1100, compact: 300 } — the width intents.
- spacingScale: [0,4,8,12,16,24,32,48,64] — the density steps.
- radiusScale: [0,4,8,16,24,999] — the radiusStep index source.
- surfaces: { flat: {bg}, raised: {bg,border,shadow}, overlay: {bg,border,shadow} }.
Do NOT use short names ("type", "radius", "measure", "spacing") — those don't match the pack fields and are silently ignored.

## The canvas + palette

Emit "canvas" (the page background + base text color) + "paletteMode" ("restrained" | "vivid"). The canvas obeys the vision: if the aesthetic lives in light, the canvas goes light — even on a dark site. The compiler enforces a contrast floor (>=4.5) on every pair; pick colors that contrast. "variables" rethemes framework CSS (:root var overrides).

PICK ONE COLOR STRATEGY (not both): EITHER a vivid/saturated canvas with QUIET clusters (neutral pack surfaces, near-zero accent — the canvas IS the color), OR a quiet canvas with 1-2 vivid accents on singular focal regions. A vivid canvas AND vivid clusters = confetti noise. Set paletteMode "vivid" only when the canvas itself is saturated; otherwise "restrained".

## Directives
1. ACCENT IS RARE — A HARD BUDGET. Emit "accent" on AT MOST 1-2 SINGULAR regions in the WHOLE page. Never emit accent on a role/group that fans out to >3 clusters (it paints every member the same loud color = confetti). The dominant/hero region may take ONE accent; everything else uses neutral pack surfaces (flat/raised on the canvas tone). Links are content: style calmly, never as accents. When the canvas is vivid, accent count is ZERO — the canvas carries the color, clusters stay quiet.
2. LEGIBILITY HOLDS. A dark surface gets light text; a light surface gets dark text. Over a gradient, contrast against every stop. Never put a light accent bg behind light text or a dark accent behind dark text — pickReadableText only fixes the text, not a low-contrast hue pair.
3. IMAGES ARE MATERIAL. For [image] clusters, set radiusStep/borderStep/shadowStep + a texture — never a solid background (the compiler refuses it; it paints over the image).
4. COVER THE PAGE — NO ORIGINAL PATCHES. Every major region gets a deliberate NON-ORIGINAL surface. A region that keeps the site's original background reads as an unstyled white strip — the worst by-eye failure (all-or-nothing). Lower/secondary regions (footer, sister-sections, language lists, sub-nav) MUST get a surface tier on the canvas tone — never left to inherit the original. The role inventory lists every cluster; emit an aesthetic intent for every major role/group, not just the top 3.
5. FAMILY CONSISTENCY. Target a role or group so every member gets the same aesthetic — never half-style a family.

## The escape hatch (rare, logged)
You MAY emit a raw "rules" entry (styles on a specific handle) ONLY when the token vocabulary can't express the surface. This is the exception; every use is logged + counted. Prefer an aesthetic intent + a pack override.

Allowed style keys (escape hatch only): ${Object.keys(BASE_PROPS).join(', ')}
hover/focusVisible: ${Object.keys(INTERACTION_PROPS).join(', ')}

Respond with exactly this JSON (NO raw layout; the aesthetic intents + canvas + paletteMode + pack overrides; escape-hatch rules only when the vocabulary can't express it):
{
  "reasoning": "1-2 sentences on the palette + surface direction",
  "pack": "minimal-editorial",
  "paletteMode": "restrained",
  "packOverrides": { "colors": { "canvas": "#0f1420", "text": "#f3f5fa", "accents": { "primary": "#7c5cff" } } },
  "canvas": { "background": "#0f1420", "color": "#f3f5fa" },
  "intents": [
    { "target": "page-title", "aesthetic": { "accent": "primary", "surface": "raised", "radiusStep": 2, "shadowStep": 2, "typeRamp": "display" } },
    { "target": "article-body", "aesthetic": { "surface": "flat", "typeRamp": "body" } },
    { "target": "media", "aesthetic": { "radiusStep": 3, "borderStep": 1, "shadowStep": 2 } }
  ]
}`;

/** CRITIC — repair only. Takes the bundled failure critique, returns a MINIMAL
 *  correction: intent corrections (the preferred path) or a raw escape-hatch rule
 *  for a failure the intents can't fix. Small, fast, on the fastest model. */
const CRITIC_PROMPT = `You are WebMorph's CRITIC. A previous design attempt FAILED verification. You receive the user's request, the page perception (with DESIGN ROLES + groups + the DESIGN PACKS), and a list of SPECIFIC failures. Return a MINIMAL correction — intent corrections preferred, a raw escape-hatch rule only when an intent can't fix it.

Fix each failure with the smallest change:
- INVISIBLE TEXT / low contrast -> an aesthetic intent on the role/handle with a contrasting surface + accent, OR a raw escape-hatch rule (background/color) on the failing handle.
- VOID (blanked surface) -> an aesthetic intent restoring the surface (surface tier + accent).
- SQUEEZE (text too narrow) -> a measure intent ("full"/"prose") on the role, OR widen via a raw layout rule.
- RECOLOR / no-reshape -> a structural intent (emphasis/placement/measure) that changes the structure. A color swap on stock layout is a failure.
- REFLOW SKIPPED (a warranted side-rail left untouched) -> a placement intent ("topbar"/"collapse"/"relocate") on the named handle/role. Leaving it untouched is a failure.
- COVERAGE gaps -> an emphasis/aesthetic intent on the unaddressed role, OR a raw escape-hatch rule.
- OVER-ACCENT -> drop the accent from the repeated role's aesthetic intent.

The escape hatch (raw rules) is the EXCEPTION — prefer an intent. Every escape-hatch use is logged + counted (a high fraction = vocabulary gap).

Allowed layout keys (escape hatch): ${Object.keys(LAYOUT_PROPS).join(', ')}
Allowed style keys (escape hatch): ${Object.keys(BASE_PROPS).join(', ')} (hover/focusVisible: ${Object.keys(INTERACTION_PROPS).join(', ')})

Respond with exactly this JSON — ONLY the corrections:
{
  "reasoning": "1-2 sentences on the fixes",
  "intents": [
    { "target": "c1a2b3", "emphasis": "hero", "aesthetic": { "accent": "primary" } }
  ],
  "rules": [
    { "target": "c8d7e6", "styles": { "color": "#111" } }
  ]
}`;

// Backward-compat: the restyle-only (pure palette) path uses the Painter prompt
// alone — a palette change isn't claiming to be a redesign, so the Architect
// (structure) would only add latency. Not used by the parallel design path.
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
 *  partial specs — validateSpec accepts intents-only, layout-only, and styles-only). */
async function callModel(role: Role, intent: string, perception: string, accountId: string, apiKey: string, critique: string | undefined, timeoutMs: number | undefined): Promise<StyleSpecResult> {
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
      // OPENAI — disabled in favor of Cloudflare Workers AI, kept for easy revert:
      // res = await fetchWithTimeout(OPENAI_URL, {
      //   method: 'POST',
      //   headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      //   body: JSON.stringify(bodyObj),
      // }, timeout);
      // Cloudflare Workers AI (OpenAI-compatible endpoint — same body + response shape).
      // `apiKey` carries the Cloudflare API token; `accountId` builds the endpoint URL.
      res = await fetchWithTimeout(cfChatUrl(accountId), {
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
    logDebug(`role=${role} spec produced by ${model}: ${validated.spec.rules.length} rules + ${validated.spec.intents?.length ?? 0} intents (pack=${validated.spec.pack ?? 'default'})`);
    return { ok: true, spec: validated.spec, usage: data.usage, model, callMs: Date.now() - t0 };
  }
}

/** ARCHITECT call — the structure: intents + pack + canvasLayout. Returns a
 *  partial spec (intents/composition/canvasLayout/hide). The caller merges this
 *  with the Painter's spec. */
export function requestArchitectSpec(req: StyleSpecRequest): Promise<StyleSpecResult> {
  return callModel('architect', req.intent, req.perception, req.accountId, req.apiKey, req.critique, req.timeoutMs);
}

/** PAINTER call — the surface: aesthetic intents + canvas + paletteMode + pack
 *  overrides. Returns a partial spec. The caller merges this with the Architect's. */
export function requestPainterSpec(req: StyleSpecRequest): Promise<StyleSpecResult> {
  return callModel('painter', req.intent, req.perception, req.accountId, req.apiKey, req.critique, req.timeoutMs);
}

/** CRITIC call — repair only. Takes the bundled failure critique, returns a minimal
 *  correction spec (a patch). Runs on the fastest model within the time budget. */
export function requestCriticCorrection(req: StyleSpecRequest): Promise<StyleSpecResult> {
  return callModel('critic', req.intent, req.perception, req.accountId, req.apiKey, req.critique, req.timeoutMs);
}

/** Single-call path (restyle-only / fallback). One model, one prompt, one spec. */
export async function requestStyleSpec({ intent, perception, accountId, apiKey, critique, timeoutMs: callTimeout }: StyleSpecRequest): Promise<StyleSpecResult> {
  return callModel('design', intent, perception, accountId, apiKey, critique, callTimeout);
}

/** Compact token-usage string incl. reasoning tokens when the API reports them. */
function fmtUsage(u: unknown): string {
  const usage = u as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } } | undefined;
  if (!usage) return 'n/a';
  const r = usage.completion_tokens_details?.reasoning_tokens;
  return `prompt=${usage.prompt_tokens ?? '?'} completion=${usage.completion_tokens ?? '?'}${r != null ? ` reasoning=${r}` : ''} total=${usage.total_tokens ?? '?'}`;
}

/** 429 wait: honor the server's "try again in Xs" if present, else a generous
 *  429-specific backoff (rateLimitBackoffMs × 2^attempt) — the short exponential
 *  baseBackoffMs (1s,2s,4s) slammed back into a sustained rate limit and failed
 *  the grid; a 429 means "back off for real". The server's Retry-After always wins. */
function retryWaitMs(bodyTxt: string, transient: number): number {
  const m = bodyTxt.match(/try again in (?:(\d+)m)?([\d.]+)s/);
  if (m) return Math.ceil(((m[1] ? +m[1] * 60 : 0) + parseFloat(m[2])) * 1000) + 500;
  const base = AI_CONFIG.rateLimitBackoffMs || AI_CONFIG.baseBackoffMs;
  return Math.min(60000, base * 2 ** (transient - 1));
}

// ── transport helpers ──────────────────────────────────────────────

/** Reasoning-family models: reasoning_effort supported, temperature rejected.
 *  Matches OpenAI gpt-5/o-series (disabled, kept for revert) AND the Cloudflare
 *  Workers AI GLM family (glm-5.2 + glm-4.7-flash both support reasoning_effort). */
function isReasoningModel(model: string): boolean { return /^(gpt-5|o\d)/i.test(model) || /glm/i.test(model); }

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(id); }
}

async function safeText(res: Response): Promise<string> { try { return await res.text(); } catch { return ''; } }
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

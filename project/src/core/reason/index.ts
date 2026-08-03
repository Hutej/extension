/**
 * core/reason — LLM transport + role prompts. The ONLY place that talks to the model.
 *
 * The monolithic system prompt is SPLIT into three role prompts so each call is
 * smaller (faster, cheaper, better-focused) and runs on the model that fits it:
 *   - ARCHITECT — the structure: RELATIONAL STATEMENTS (size, rank, spacing,
 *     alignment, elevation, width, layout, structural ops) + the pack choice.
 *     No raw px, no colors. The engine resolves the relations against perception.
 *   - PAINTER   — the surface: RELATIONAL STATEMENTS for the aesthetic layer
 *     (surface tiers, accent roles, radius/border/elevation steps, typography
 *     ranks) + the canvas + paletteMode + pack overrides. No raw px/hex. The
 *     engine resolves the relations against the pack.
 *   - CRITIC    — repair only: relation corrections (preferred) or a raw
 *     escape-hatch rule for a failure the relations can't fix.
 *
 * The PRIMARY model output is RELATIONAL STATEMENTS (RelationStatement[]), not
 * raw declarations. The raw `rules` path is a BOUNDED escape hatch — the model may
 * emit a raw rule on a specific handle when the relational vocabulary can't express
 * the design; every escape-hatch use is logged loudly (the count + the FRACTION
 * of targets = the vocabulary-gap metric). Relations target roles/groups/handles,
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
  | { ok: true; spec: DesignSpec; usage?: unknown; model?: string; callMs?: number; httpRequests: number }
  | { ok: false; kind: ReasonError; message: string; callMs?: number; httpRequests: number };

export interface StyleSpecRequest {
  intent: string;
  perception: string;
  accountId: string;   // Cloudflare account id — builds the Workers AI endpoint URL
  apiKey: string;      // Cloudflare API token (bearer)
  critique?: string; // regenerative-repair feedback appended to the user message
  timeoutMs?: number; // per-call override (used to cap a Critic round so total stays < budget)
}

// Unified on Cloudflare Workers AI. The orphaned OpenAI path is deleted.
const cfChatUrl = (accountId: string): string =>
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`;

// ── Role prompts (the role-relation DSL) ───────────────────
//
// The PRIMARY model output is per-role design RELATIONS + a design-language pack
// choice. The model does NOT emit raw px spacing values, raw px type sizes, or
// raw colors — it emits TOKEN GRAMMAR (spacing steps, type-ramp roles, named
// accents, surface tiers) the deterministic engine resolves against the pack.
// The raw `rules` path is a BOUNDED escape hatch: the model MAY emit a raw rule
// on a specific handle when the relation vocabulary can't express the design;
// every escape-hatch use is logged loudly (the count + the FRACTION of targets =
// the vocabulary-gap metric; > 20% on a grid run = a loud pivot-failure flag).
//
// Relations target a role ("listing"), a group ("g4x2y1"), or a single handle
// ("c1a2b3"); role/group targets fan out to every member, so identical families
// can no longer be half-styled (family consistency by construction).

/** ARCHITECT — the structure: RELATIONAL STATEMENTS that express what should
 *  change about the page's structure + the pack choice. The model never emits
 *  raw CSS, never picks enum values, and never emits a pixel. It states
 *  RELATIONS: "this heading is 3× the body size", "this rail is 1/3 of the
 *  content", "this section outranks its neighbours". The deterministic engine
 *  resolves each relation against the page's measured reality. */
const ARCHITECT_PROMPT = `You are Revueon's ARCHITECT. You reshape a website's STRUCTURE by emitting RELATIONAL STATEMENTS — not raw CSS, not enum picks. A deterministic engine resolves your relations against the page's measured reality to produce the concrete CSS the compiler emits. You choose the BONES; a Painter chooses the surface.

You receive: the user's request + the site's identity + a runtime picture of the page — the COMPOSITION (the page's macro shape up front), the page-level MODELS (type ramp, spatial model, colour system, surface language, density profile), the design-language PACKS library (each pack carries structured PRINCIPLES the engine enforces), and components with stable ids each led by its DESIGN ROLE. The engine enforces the safety laws. Your job: decide WHAT should change, expressed as relations, not the raw CSS.

## The relational vocabulary (your PRIMARY output)

Emit "relations": a set of relational statements. Each statement names its subject by handle, role, or group; states a relation type; and carries a magnitude as a RATIO, a SCALE STEP, or an ORDINAL RANK — NEVER a pixel value. Ratios survive any viewport; pixels do not.

Target a ROLE ("page-title", "article-body", "nav-primary", "listing", "sidebar", "footer-chrome") to fan out to every cluster of that role. Target a GROUP ("g4x2y1") for a specific sibling group. Target a HANDLE ("c1a2b3") for one cluster. Role/group targets give family consistency by construction.

The closed set of relations (emit only these — no invented relation names):

SIZE & TYPE:
- {"relation":"sizeRatio","subject":"page-title","reference":"article-body","ratio":3} — subject font-size is ratio× the reference font-size
- {"relation":"typeRank","subject":"page-title","rank":0} — subject at rank N on the type ramp (0=display,1=heading,2=body,3=small)
- {"relation":"lineHeightStep","subject":"article-body","step":4} — line-height at scale step N
- {"relation":"lineHeightRatio","subject":"page-title","reference":"article-body","ratio":1.1} — line-height is ratio× reference
- {"relation":"letterSpacingStep","subject":"page-title","step":1} — letter-spacing at scale step N
- {"relation":"wordSpacingStep","subject":"article-body","step":0} — word-spacing at scale step N
- {"relation":"fontWeightRank","subject":"page-title","rank":4} — font-weight at rank 1-5 (light/normal/medium/bold/black)
- {"relation":"textTransform","subject":"nav-primary","transform":"uppercase"} — text-transform value

RANK & HIERARCHY:
- {"relation":"outranks","subject":"page-title","reference":"article-body"} — subject ranks above reference in emphasis
- {"relation":"emphasisRank","subject":"page-title","rank":0} — emphasis hierarchy (0=highest; bold for rank 0-1). Does NOT set type size — use typeRank for that.

SPACING:
- {"relation":"spacingStep","subject":"article-body","step":4} — padding at scale step N (clamped by pack's densityRange)
- {"relation":"spacingRatio","subject":"nav-primary","reference":"article-body","ratio":0.5} — padding is ratio× reference padding
- {"relation":"gapStep","subject":"listing","step":3} — child gap at scale step N
- {"relation":"gapRatio","subject":"listing","reference":"article-body","ratio":1.0} — child gap is ratio× reference gap
- {"relation":"marginStep","subject":"page-title","step":2} — margin at scale step N
- {"relation":"marginEquals","subject":"nav-primary","reference":"article-body"} — margin equals reference margin
- {"relation":"paddingSide","subject":"card","side":"top","step":3} — per-side padding at scale step N (side: top/right/bottom/left/all)

ALIGNMENT:
- {"relation":"alignsWith","subject":"card","reference":"article-body","edge":"start"} — subject aligns with reference on edge (start/center/end/stretch)

ELEVATION:
- {"relation":"elevationAbove","subject":"card","reference":"article-body","levels":1} — shadow is N levels above reference shadow
- {"relation":"elevationStep","subject":"card","step":2} — shadow at scale step N

COLOUR:
- {"relation":"accentRole","subject":"page-title","role":"primary","maxCount":2} — accent as background with role + page-wide budget (shorthand for accentOn target:background)
- {"relation":"accentOn","subject":"nav-primary","target":"border","role":"primary"} — accent on a specific target: text/border/background (full control)

WIDTH:
- {"relation":"widthFraction","subject":"sidebar","reference":"article-body","fraction":0.33} — subject takes a fraction of reference width

SURFACE:
- {"relation":"radiusCorner","subject":"card","corner":"all","step":3} — per-corner radius at scale step N (corner: tl/tr/br/bl/all)
- {"relation":"borderWeight","subject":"card","step":1} — border width at scale step N
- {"relation":"surfaceTier","subject":"card","tier":1} — surface treatment (0=flat,1=raised,2=overlay)

LAYOUT:
- {"relation":"columnCount","subject":"article-body","count":2} — column count within the region

GROUPING:
- {"relation":"groupWith","subject":"card","reference":"card2"} — subject grouped with reference

STRUCTURAL:
- {"relation":"hide","subject":"ad-or-void"} — remove the subject (guarded — the engine REFUSES hide on a low-confidence role)
- {"relation":"reorderBefore","subject":"sidebar","reference":"article-body"} — reorder subject before reference in DOM order
- {"relation":"moveTo","subject":"sidebar","reference":"main"} — relocate subject into reference

## Pick a pack

Emit "pack": one of the pack ids from the DESIGN PACKS block. The pack is the design SYSTEM (its spacing scale, type ramp, surface system, color relationships + its PRINCIPLES the engine enforces). Pick by archetype; never hardcode to a site.

## The escape hatch (rare, logged)

You MAY emit a raw "rules" entry (styles/layout on a specific handle) ONLY when the relational vocabulary genuinely can't express the design. This is the exception — every escape-hatch use is logged and counted. Prefer a relation + a pack override.

## Non-negotiables
1. A pack choice.
2. canvasLayout (the page-level content-width / arrangement decision).
3. relations covering the major roles — size the page title, set body density, reflow side-rails. A spec with no structural relation is a failure.
4. Address EVERY warranted reflow (the perception's REFLOW line names the side-rail handles) — a "widthFraction"/"reorderBefore"/"hide" on each, OR a widthFraction that reflows it. A rail marked "forbid-move"/"risky-move" CANNOT be reordered — use "hide" or "widthFraction" instead.

## Directives
1. USE THE ROOM. Compose the full viewport; match the measure to the page's purpose.
2. RESHAPE, DON'T RECOLOR. Every design implies structural change. A spec with only colour relations is a failure.
3. TREAT FAMILIES CONSISTENTLY. Target a role or group so every member gets the same relation.
4. PRUNE CHROME. "hide" on peripheral chrome; the engine guards primary content and low-confidence roles.
5. The PAGE line gives the site's domain + title — reason to the page's purpose; never hardcode to a domain.

Respond with exactly this JSON (NO raw colors; relational statements + the pack choice + canvasLayout; escape-hatch rules only when the vocabulary can't express it):
{
  "reasoning": "1-2 sentences on the structural direction + the pack choice",
  "pack": "minimal-editorial",
  "canvasLayout": { "maxWidth": "92%", "marginInline": "auto" },
  "relations": [
    { "relation": "typeRank", "subject": "page-title", "rank": 0 },
    { "relation": "emphasisRank", "subject": "page-title", "rank": 0 },
    { "relation": "spacingStep", "subject": "article-body", "step": 4 },
    { "relation": "widthFraction", "subject": "nav-local", "reference": "article-body", "fraction": 1.0 },
    { "relation": "reorderBefore", "subject": "nav-local", "reference": "article-body" },
    { "relation": "emphasisRank", "subject": "footer-chrome", "rank": 3 },
    { "relation": "hide", "subject": "c9z8y7" }
  ]
}`;

/** PAINTER — the surface: RELATIONAL STATEMENTS for the aesthetic layer +
 *  the canvas + paletteMode + pack overrides. No raw px type sizes (a
 *  typeRank), no raw hex accents (a named accent role), no raw px radii/borders
 *  /shadows (scale steps). The engine resolves the tokens against the pack. */
const PAINTER_PROMPT = `You are Revueon's PAINTER. You choose the SURFACE that remakes a website — the aesthetic layer — by emitting RELATIONAL STATEMENTS + the canvas + paletteMode + pack overrides. The ARCHITECT chose the structure + the pack; you adapt the pack's surface to the user's aesthetic.

You receive the user's request, the site identity, the DESIGN PACKS library (each pack carries structured PRINCIPLES the engine enforces — accent budget, surface definition, density range), and the runtime page picture (components led by their DESIGN ROLE + current colors/fonts). The engine resolves your relations against the pack + your packOverrides; the compiler enforces contrast (>=4.5). Your job: the surface language, not raw CSS.

## The relational vocabulary (your PRIMARY output) — SURFACE relations

Emit "relations": relational statements for the aesthetic layer. Each statement names its subject by handle, role, or group; states a relation type; and carries a magnitude as a SCALE STEP or ORDINAL RANK — NEVER a pixel. The engine resolves each against the pack + your overrides.

The surface-relevant relations (emit only these — no invented relation names):

SURFACE:
- {"relation":"surfaceTier","subject":"card","tier":1} — surface treatment (0=flat,1=raised,2=overlay)
- {"relation":"radiusCorner","subject":"card","corner":"all","step":3} — per-corner radius at scale step N (corner: tl/tr/br/bl/all)
- {"relation":"borderWeight","subject":"card","step":1} — border width at scale step N
- {"relation":"elevationStep","subject":"card","step":2} — shadow at scale step N
- {"relation":"elevationAbove","subject":"card","reference":"article-body","levels":1} — shadow N levels above reference

COLOUR:
- {"relation":"accentRole","subject":"page-title","role":"primary","maxCount":2} — assign accent role with page-wide budget maxCount (the engine REFUSES accents beyond the budget)
- {"relation":"accentOn","subject":"nav-primary","target":"border","role":"primary"} — accent on text/border/background

TYPOGRAPHY (surface):
- {"relation":"typeRank","subject":"page-title","rank":0} — subject at rank N on the type ramp (0=display,1=heading,2=body,3=small)
- {"relation":"fontWeightRank","subject":"page-title","rank":4} — font-weight at rank 1-5 (light/normal/medium/bold/black)
- {"relation":"letterSpacingStep","subject":"page-title","step":1} — letter-spacing at scale step N
- {"relation":"wordSpacingStep","subject":"article-body","step":0} — word-spacing at scale step N
- {"relation":"lineHeightStep","subject":"article-body","step":4} — line-height at scale step N
- {"relation":"lineHeightRatio","subject":"page-title","reference":"article-body","ratio":1.1} — line-height is ratio× reference
- {"relation":"textTransform","subject":"nav-primary","transform":"uppercase"} — text-transform value

Target a ROLE ("page-title", "article-body", "card", "media") to fan out to every cluster of that role. Target a GROUP for a specific sibling group. Target a HANDLE for one cluster.

## Pack overrides (blend for a novel prompt)

Emit "packOverrides" to adapt any pack field to the user's aesthetic — every pack field is model-overridable. The engine overlays your overrides on the chosen pack; packs floor quality, they must not cap creativity (a novel prompt overrides the pack). Use the EXACT field names from the DESIGN PACKS block:
- colors: { canvas: "#hex", text: "#hex", subtle: "#hex", accents: { primary: "#hex", ... } } — add named accents here, then reference them by name in an accentRole/accentOn relation.
- canvas: the page background (also set in "canvas", not just here).
- typeRamp: { display: 52, heading: 34, body: 17, small: 13 } — px per type role.
- measurePx: { prose: 620, full: 1100, compact: 300 } — the width measures.
- spacingScale: [0,4,8,12,16,24,32,48,64] — the density steps.
- radiusScale: [0,4,8,16,24,999] — the radiusStep index source.
- letterSpacingScale, wordSpacingScale, lineHeightScale, fontWeightScale — the typography scales.
- surfaces: { flat: {bg}, raised: {bg,border,shadow}, overlay: {bg,border,shadow} }.
- principles: { minTypeScaleRatio, maxAccentCount, raiseSurface, densityRange, surfaceDefinition } — the engine ENFORCES these.
Do NOT use short names ("type", "radius", "measure", "spacing") — those don't match the pack fields and are silently ignored.

## The canvas + palette

Emit "canvas" (the page background + base text color) + "paletteMode" ("restrained" | "vivid"). The canvas obeys the vision: if the aesthetic lives in light, the canvas goes light — even on a dark site. The compiler enforces a contrast floor (>=4.5) on every pair; pick colors that contrast. "variables" rethemes framework CSS (:root var overrides).

PICK ONE COLOR STRATEGY (not both): EITHER a vivid/saturated canvas with QUIET clusters (neutral pack surfaces, near-zero accent — the canvas IS the color), OR a quiet canvas with 1-2 vivid accents on singular focal regions. A vivid canvas AND vivid clusters = confetti noise. Set paletteMode "vivid" only when the canvas itself is saturated; otherwise "restrained".

## Directives
1. ACCENT IS RARE — A HARD BUDGET. The engine REFUSES accents beyond the pack's maxAccentCount. Emit accentRole on AT MOST 1-2 SINGULAR regions in the WHOLE page. Never emit accent on a role/group that fans out to >3 clusters (it paints every member the same loud color = confetti). The dominant/hero region may take ONE accent; everything else uses neutral pack surfaces (flat/raised on the canvas tone). Links are content: style calmly, never as accents. When the canvas is vivid, accent count is ZERO — the canvas carries the color, clusters stay quiet.
2. LEGIBILITY HOLDS. A dark surface gets light text; a light surface gets dark text. Over a gradient, contrast against every stop. Never put a light accent bg behind light text or a dark accent behind dark text — pickReadableText only fixes the text, not a low-contrast hue pair.
3. IMAGES ARE MATERIAL. For [image] clusters, set radiusCorner/borderWeight/elevationStep — never a solid background (the compiler refuses it; it paints over the image).
4. COVER THE PAGE — NO ORIGINAL PATCHES. Every major region gets a deliberate NON-ORIGINAL surface. A region that keeps the site's original background reads as an unstyled white strip — the worst by-eye failure (all-or-nothing). Lower/secondary regions (footer, sister-sections, language lists, sub-nav) MUST get a surface tier on the canvas tone — never left to inherit the original. The role inventory lists every cluster; emit a surface relation for every major role/group, not just the top 3.
5. FAMILY CONSISTENCY. Target a role or group so every member gets the same relation — never half-style a family.

## The escape hatch (rare, logged)
You MAY emit a raw "rules" entry (styles on a specific handle) ONLY when the relational vocabulary can't express the surface. This is the exception; every use is logged + counted. Prefer a relation + a pack override.

Allowed style keys (escape hatch only): ${Object.keys(BASE_PROPS).join(', ')}
hover/focusVisible: ${Object.keys(INTERACTION_PROPS).join(', ')}

Respond with exactly this JSON (NO raw layout; the surface relations + canvas + paletteMode + pack overrides; escape-hatch rules only when the vocabulary can't express it):
{
  "reasoning": "1-2 sentences on the palette + surface direction",
  "pack": "minimal-editorial",
  "paletteMode": "restrained",
  "packOverrides": { "colors": { "canvas": "#0f1420", "text": "#f3f5fa", "accents": { "primary": "#7c5cff" } } },
  "canvas": { "background": "#0f1420", "color": "#f3f5fa" },
  "relations": [
    { "relation": "accentRole", "subject": "page-title", "role": "primary", "maxCount": 2 },
    { "relation": "surfaceTier", "subject": "page-title", "tier": 1 },
    { "relation": "radiusCorner", "subject": "card", "corner": "all", "step": 3 },
    { "relation": "elevationStep", "subject": "card", "step": 2 },
    { "relation": "surfaceTier", "subject": "article-body", "tier": 0 },
    { "relation": "typeRank", "subject": "page-title", "rank": 0 },
    { "relation": "borderWeight", "subject": "media", "step": 1 },
    { "relation": "radiusCorner", "subject": "media", "corner": "all", "step": 3 }
  ]
}`;

/** CRITIC — repair only. Takes the bundled failure critique, returns a MINIMAL
 *  correction: relation corrections (the preferred path) or a raw escape-hatch rule
 *  for a failure the relations can't fix. Small, fast, on the fastest model. */
const CRITIC_PROMPT = `You are Revueon's CRITIC. A previous design attempt FAILED verification. You receive the user's request, the page perception (with DESIGN ROLES + groups + the DESIGN PACKS), and a list of SPECIFIC failures. Return a MINIMAL correction — relation corrections preferred, a raw escape-hatch rule only when a relation can't fix it.

Fix each failure with the smallest change:
- INVISIBLE TEXT / low contrast -> a surfaceTier + accentRole relation on the role/handle with a contrasting surface, OR a raw escape-hatch rule (background/color) on the failing handle.
- VOID (blanked surface) -> a surfaceTier relation restoring the surface + an accentRole if needed.
- SQUEEZE (text too narrow) -> a widthFraction relation on the role, OR widen via a raw layout rule.
- RECOLOR / no-reshape -> a structural relation (typeRank/emphasisRank/spacingStep/widthFraction) that changes the structure. A color swap on stock layout is a failure.
- REFLOW SKIPPED (a warranted side-rail left untouched) -> a widthFraction/reorderBefore/hide relation on the named handle/role. Leaving it untouched is a failure.
- COVERAGE gaps -> a surfaceTier/emphasisRank relation on the unaddressed role, OR a raw escape-hatch rule.
- OVER-ACCENT -> drop the accentRole relation from the repeated role.

The escape hatch (raw rules) is the EXCEPTION — prefer a relation. Every escape-hatch use is logged + counted (a high fraction = vocabulary gap).

Allowed layout keys (escape hatch): ${Object.keys(LAYOUT_PROPS).join(', ')}
Allowed style keys (escape hatch): ${Object.keys(BASE_PROPS).join(', ')} (hover/focusVisible: ${Object.keys(INTERACTION_PROPS).join(', ')})

Respond with exactly this JSON — ONLY the corrections:
{
  "reasoning": "1-2 sentences on the fixes",
  "relations": [
    { "relation": "emphasisRank", "subject": "c1a2b3", "rank": 0 },
    { "relation": "accentRole", "subject": "c1a2b3", "role": "primary", "maxCount": 2 }
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
 *  restyle-only path uses the Painter model alone. Env-overridable (RV_MODEL_*). */
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
 *  partial specs — validateSpec accepts relations-only, layout-only, and styles-only). */
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
  // track the true HTTP request count — retries re-bill up to 5 requests
  // per role while the UI reported 1 paid call. This is surfaced in the result.
  let httpRequests = 0;

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
      // Cloudflare Workers AI (OpenAI-compatible endpoint — same body + response shape).
      httpRequests++;
      res = await fetchWithTimeout(cfChatUrl(accountId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(bodyObj),
      }, timeout);
    } catch (err) {
      const e = err as { name?: string; message?: string };
      const s = ((Date.now() - t0) / 1000).toFixed(1);
      if (e.name === 'AbortError') { logDebug(`role=${role} model=${model} TIMEOUT after ${s}s`); return { ok: false, kind: 'timeout', message: `Design engine timed out after ${s}s. Try again.`, callMs: Date.now() - t0, httpRequests }; }
      if (transient < AI_CONFIG.maxTransientRetries) { transient++; logDebug(`role=${role} model=${model} network error after ${s}s (${e.message}) — transient retry ${transient}`); await sleep(AI_CONFIG.baseBackoffMs * 2 ** (transient - 1)); continue; }
      return { ok: false, kind: 'network', message: `Network error: ${e.message}`, callMs: Date.now() - t0, httpRequests };
    }
    const s = ((Date.now() - t0) / 1000).toFixed(1);

    if (!res.ok) {
      const bodyTxt = await safeText(res);
      logDebug(`role=${role} model=${model} HTTP ${res.status} after ${s}s: ${bodyTxt.slice(0, 300)}`);
      if (res.status === 401 || res.status === 403) return { ok: false, kind: 'invalid_key', message: 'Invalid API key. Check your key in the Revueon settings.', httpRequests };
      if (res.status === 400 && bodyTxt.toLowerCase().includes('context_length')) return { ok: false, kind: 'context_limit', message: 'Page is too large for the model. Try a simpler page.', httpRequests };
      if (res.status === 429 || res.status >= 500) {
        if (transient < AI_CONFIG.maxTransientRetries) { transient++; await sleep(retryWaitMs(bodyTxt, transient)); continue; }
        return { ok: false, kind: 'rate_limited', message: 'Rate limited. Wait a moment and try again.', httpRequests };
      }
      if (res.status === 400 && (useResponseFormat || useReasoningEffort)) {
        logDebug(`role=${role} model=${model} 400 — dropping response_format + reasoning_effort, one retry`);
        useResponseFormat = false; useReasoningEffort = false; continue;
      }
      return { ok: false, kind: 'invalid_request', message: `API error (${res.status}): ${bodyTxt.slice(0, 120)}`, httpRequests };
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    logDebug(`role=${role} model=${model} OK ${s}s tokens=${fmtUsage(data?.usage)}`);
    if (typeof content !== 'string') return { ok: false, kind: 'bad_output', message: 'Model returned no content.', httpRequests };
    let parsed: unknown;
    try { parsed = JSON.parse(content); } catch { return { ok: false, kind: 'bad_output', message: 'Model output was not valid JSON.', httpRequests }; }
    const validated = validateSpec(parsed);
    if (!validated.ok || !validated.spec) { logDebug(`role=${role} model=${model} invalid spec: ${validated.error}`); return { ok: false, kind: 'bad_output', message: `Invalid design spec: ${validated.error}`, httpRequests }; }
    logDebug(`role=${role} spec produced by ${model}: ${validated.spec.rules.length} rules + ${validated.spec.relations?.length ?? 0} relations (pack=${validated.spec.pack ?? 'default'})`);
    return { ok: true, spec: validated.spec, usage: data.usage, model, callMs: Date.now() - t0, httpRequests };
  }
}

/** ARCHITECT call — the structure: relations + pack + canvasLayout. Returns a
 *  partial spec (relations/composition/canvasLayout/hide). The caller merges this
 *  with the Painter's spec. */
export function requestArchitectSpec(req: StyleSpecRequest): Promise<StyleSpecResult> {
  return callModel('architect', req.intent, req.perception, req.accountId, req.apiKey, req.critique, req.timeoutMs);
}

/** PAINTER call — the surface: aesthetic relations + canvas + paletteMode + pack
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
 *  Matches the Cloudflare Workers AI GLM family (glm-5.2 + glm-4.7-flash both
 *  support reasoning_effort). */
function isReasoningModel(model: string): boolean { return /glm/i.test(model); }

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(id); }
}

async function safeText(res: Response): Promise<string> { try { return await res.text(); } catch { return ''; } }
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

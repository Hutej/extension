# WebMorph — Engine Architecture

*(Read this before touching `project/src/`. This file is loaded ON DEMAND, not in every prompt — it can afford detail. If any fact here disagrees with the code, THE CODE WINS: verify against the code and update this file.)*

## Stack & layout

- `project/` — WXT + TypeScript strict + MV3 extension. Source in `project/src/`, harness in `project/tests/`.
- Explore `project/src/` yourself before editing — do not trust a stale mental map. The pipeline below is the conceptual spine; file names/paths may evolve.

## Pipeline: perceive → reason → compile → verify → repair

**perceive/ (perception).** Walks the real visible DOM (including open shadow roots), clusters visually-similar elements with coarsened signature buckets (4px fontSize/radius, 8-step color quantization — merges 14px/15px buttons into one cluster), stamps stable hash handles as `[data-wm-c]`. No node cap — sees the WHOLE page (6s time budget). Hierarchical tree serialization (indent by depth, parent-child nesting visible). Two-tier: top 80 clusters get full detail, rest get compact one-liners. Pre-resolves CSS variables to rgb for pure compile/verify. Tracks open shadow roots for downstream CSS injection. No vision/screenshot input to the model (vetoed for cost/latency).

**reason (the ONE paid model call).** User prompt + hierarchical perception → open-ended DesignSpec: canvas decision, per-cluster rules split into style and layout bags, hides, composition rules (region proportions), palette intent (`paletteMode: "restrained" | "vivid"`). System prompt: 8 directives (~40 lines), no `keep` (removed — was a loophole), no `moves` (dead feature). Base-coat safety net: clusters not styled are auto-repainted if they clash with canvas. No fallback chain — primary model only, honest error on failure. The system prompt is a first-class engineering artifact — design quality problems are usually system-prompt problems.

**compile (deterministic, free).** DesignSpec → CSS in a single `<style id="webmorph-style">` element (+ per-shadow-root `<style>` elements). Composition rules compiled FIRST. Enforces laws BY CONSTRUCTION: viewport-safe sizes, container-aware font clamp, readable-color floors, overflow-wrap protection, columnCount clamp, grid normalization (including auto-fit/auto-fill). Base-coat harmonizer: ALL unaccounted clashing clusters get a safety-net repaint (not just ≤12 skeleton regions), grouped into one CSS rule. Contrast Lock resolves var() backgrounds via perception's cssVarMap.

**verify (measurement).** Delta overflow (flags only overflow WE introduce, not pre-existing). 50-sample contrast (≤2 fail, 0 in top-10 largest text). Split coverage: total (model+base-coat+hide) ≥0.85 AND model-only ≥0.40 (prevents base-coat-only escape). Per-region luminance-aware coverage. Repeated-accent detection. Alpha compositing for effectiveBackground (semi-transparent colors blended over parent).

**repair (deterministic and FREE wherever possible).** Word-break · targeted clamp · trimAccent · targeted forceContrast · dropLayout (LAST resort, logs loudly). `reReason` budget 1 per run. `bestNonBroken` prefers attempts passing ALL checks (not just notBroken) — prevents shipping partial redesigns. Multi-failure critique: all quality failures communicated, not just first.

## Laws / constants (in the laws module; verify names in code)

- MIN_CONTRAST_RATIO = 4.5
- MAX_OVERFLOW_RATIO = 1.02 (delta: after vs before scrollWidth)
- CONTRAST_SAMPLE_COUNT = 50 (CONTRAST_MAX_FAILURES = 2, CONTRAST_TOP_FAIL_COUNT = 10)
- MIN_CHANGE_SCORE = 0.25
- MAX_ACCENT_FRACTION = 0.15 (vivid = no cap)
- MAX_FRAMED_FRACTION = 0.45
- MIN_COVERAGE_FRACTION = 0.85 (total) + MIN_MODEL_COVERAGE_FRACTION = 0.40
- FONT_CONTAINER_RATIO = 0.15
- LUMINANCE_CLASH_THRESHOLD = 0.5
- NARROWING_KEYS = { width, maxWidth, minWidth, gridTemplateColumns, columnCount, flexBasis, flex }
- MIN_COLUMN_PX = 120
- MIN_CHARS_PER_LINE = 12
- STYLE_ELEMENT_ID = 'webmorph-style'

## Model transport

- Primary design model: `gpt-5.1`, `reasoning_effort: 'low'`, `styleMaxTokens: 24000`. No fallback — honest error on failure.
- One attempt, ≤120s hard abort (AbortController); retries ONLY on 429/5xx; token usage logged per run.
- Account models available: gpt-5, gpt-5.1, gpt-5.2, gpt-4o, gpt-4o-mini. Key in `project/.env` (`OPENAI_API_KEY`) — gitignored, NEVER commit.

## Persistence

- Per-URL storage: `origin + normalized pathname` (strip query/hash/trailing-slash). Origin-level fallback.
- Persists the ACTUALLY APPLIED CSS (with repair options) + spec + compileOptions.
- SPA navigation: hooks pushState/replaceState/popstate/hashchange. On route change: re-perceive + re-compile stored spec (free, no model call). Handles match for same-template routes; new content gets base-coat.
- Shadow DOM: injects + defends `<style>` per open shadow root. Closed shadow roots inaccessible.

## Harness & testing

- Run: `cd project && node --experimental-strip-types --env-file=.env tests/popup.test.ts`
- `WMGRID=smoke` — 1 site, 1 prompt, <3min (regression catch). `WMGRID=full` (default) — 5 sites.
- 5 sites: Wikipedia · MDN · BBC · GitHub (SPA proof) · YouTube (Shadow DOM proof). Novel prompts each run.
- Real assertions: applied ≥4/5, changeScore ≥0.25, coverage ≥0.85, no dropLayout, paidCalls ≤2. Exit non-zero on failure.
- Persistence test: reload page, verify design survives.
- **Gotcha:** `page.waitForFunction(fn, null, { timeout })` — options are the THIRD argument.
- Screenshots: before/after full-page. On timeout save `timeout_*.png`.
- Per-run report: paid calls · model · wall-clock · tokens · checks · coverage · changeScore.

## Hard-won lessons (do not relearn these expensively)

- A 3000-node cap amputates the page — below-fold content is never perceived and stays original. No node cap; see the whole page.
- `keep: true` is a loophole: the model can "keep" any cluster it doesn't redesign and completeness passes while the cluster stays original. Removed in Round 7; base-coat covers unaccounted clusters.
- Thresholds calibrated to "ship something" (50% coverage, 28% overflow, 12-sample contrast) produce partial redesigns that pass automated checks. Strict thresholds enforced.
- Persisting a re-compiled CSS (without repair options) means the design that FAILED verify is what persists on reload. Persist the applied CSS.
- A known-recolorer fallback model is a worse failure than an honest error. No fallback chain.
- Color parsing blind to hsl/oklch/var() lets the contrast gate false-pass illegible text. ParseColor handles hsl; var() resolved via perception's cssVarMap.
- Reasoning models spend heavily on thinking: keep reasoning effort low, bake ALL requirements into ONE system prompt, never rely on paid retry loops.
- `overflow-wrap: anywhere` (not `break-word`) for targeted repair — it breaks regardless of `overflow-x: visible`.

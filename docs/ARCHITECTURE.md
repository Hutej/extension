# WebMorph — Engine Architecture

*(Read this before touching `project/src/`. This file is loaded ON DEMAND, not in every prompt — it can afford detail. If any fact here disagrees with the code, THE CODE WINS: verify against the code and update this file.)*

## Stack & layout

- `project/` — WXT + TypeScript strict + MV3 extension. Source in `project/src/`, harness in `project/tests/`.
- Explore `project/src/` yourself before editing — do not trust a stale mental map. The pipeline below is the conceptual spine; file names/paths may evolve.

## Pipeline: observe → reason → compile → verify → repair

**observe/ (perception — DONE, do not rebuild).** Clusters the live page into semantic regions, tags handles as `[data-wm-c]`, measures rects, colors, text. Proven sufficient: it delivers ~65 clusters on dense pages; past failures were spec incompleteness, never blindness. No vision/screenshot input to the model (vetoed for cost/latency).

**reason (the ONE paid model call).** User prompt + clusters → open-ended DesignSpec: canvas decision, per-cluster rules split into structure/layout and style bags, hides, palette intent (`paletteMode: "restrained" | "vivid"`), explicit `keep` declarations for clusters whose original design serves the aesthetic. The system prompt enforces the completeness contract (every cluster accounted for) and family consistency (same-family clusters styled identically). The system prompt is a first-class engineering artifact — design quality problems are usually system-prompt problems, and the free fix (prompt) is always preferred over paid retries.

**compile (deterministic, free).** DesignSpec → CSS in a single `<style id="webmorph-style">` element. Composition rules compiled FIRST (macro proportions before component paint). Enforces laws BY CONSTRUCTION: viewport-safe sizes (min()/clamp()), container-aware display-font clamp, readable-color floors, overflow-wrap protection when narrowing text containers, columnCount clamp (containerWidth ÷ count ≥ MIN_COLUMN_PX), grid normalization (bare fr → minmax(0, Xfr), fixed px tracks → min(X, 100%)), base-coat harmonizer (unaddressed skeleton regions that clash with canvas get a neutral repaint). Targeted repairs: word-break (`overflow-wrap: anywhere` on bleeding clusters), squeeze (drop columnCount + relax width on squeezed clusters), clamp (strip growth-sizing on overflowing clusters).

**verify (measurement).** Change score, per-sample contrast, accent/framed fractions, overflow/bleed/squeeze detection (separate targets for geometric overflow, text bleeds, and squeezed text < MIN_CHARS_PER_LINE), coverage with per-region verdicts (luminance-aware), repeated-accent detection, palette-aware coherence.

**repair (deterministic and FREE wherever possible).** Word-break on bleeding clusters (free, before any structural repair) · targeted clamp on geometric overflow · trimAccent (strips accent from ALL repeated clusters always + area-budget trim for restrained; vivid skips the budget) · targeted forceContrast · dropLayout (LAST resort, logs loudly). `reReason` budget 1 per run: completeness-contract violations name the unaccounted clusters; repeated-accent violations get a targeted critique. Every paid reReason firing logged loudly as a system-prompt failure.

## Laws / constants (in the laws module; verify names in code)

- MIN_CONTRAST_RATIO = 4.5
- MIN_CHANGE_SCORE = 0.18
- MAX_ACCENT_FRACTION = 0.4 (subject to declared palette intent; vivid = no cap)
- MAX_FRAMED_FRACTION = 0.78
- MIN_COVERAGE_FRACTION = 0.5 (being superseded by the completeness contract)
- FONT_CONTAINER_RATIO = 0.15
- LUMINANCE_CLASH_THRESHOLD = 0.5 (Mech 2: text-only delta on clashing bg = not addressed)
- NARROWING_KEYS = { width, maxWidth, minWidth, gridTemplateColumns, columnCount, flexBasis } (Mech 3: narrowing emits overflow-wrap)
- MIN_COLUMN_PX = 120 (Fix 3: columnCount clamped if containerWidth ÷ count < this)
- MIN_CHARS_PER_LINE = 12 (Fix 3: squeeze detector flags text containers below this)
- STYLE_ELEMENT_ID = 'webmorph-style'

## Model transport

- Primary design model: `gpt-5.1`, `reasoning_effort: 'low'` (accepted; reasoning_tokens logged), `styleMaxTokens: 16000`. Fallback: `gpt-4o`.
- One attempt per model, ≤120s hard abort (AbortController); retries ONLY on 429/5xx; immediate fallback otherwise; token usage logged per run.
- Account models available: gpt-5, gpt-5.1, gpt-5.2, gpt-4o, gpt-4o-mini. Key in `project/.env` (`OPENAI_API_KEY`) — gitignored, NEVER commit.

## Harness & testing

- Run: `cd project && node --experimental-strip-types --env-file=.env tests/popup.test.ts` (grid selection via `WMGRID` env var).
- Drives the REAL popup→Transform flow in Chromium with the built extension. Never bypass it.
- **Gotcha:** `page.waitForFunction(fn, null, { timeout })` — options are the THIRD argument. A past bug passed options as the page-fn argument and silently got the 30s default.
- Screenshots: capture after-PNG only after the completion marker is observed; on timeout save `timeout_*.png`.
- Grid sites (rotate NOVEL prompts every run): en.wikipedia.org/wiki/Main_Page · developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties · bbc.com/news. YouTube deferred to Phase 1d (Shadow DOM).
- Per-run report must include: paid model calls (target 1) · model served · wall-clock · tokens · rules/layout/hides counts · every check verdict per iteration · coverage per-region verdicts · any dropLayout/reReason firings.

## Hard-won lessons (do not relearn these expensively)

- "Applied but unchanged/collapsed" is a failure: a repair ladder that strips the layout to pass checks = mechanized failure (the Round-2 dropLayout collapse).
- Coverage that counts text-color-only deltas as "addressed" produces half-implemented pages that pass checks (the Wikipedia white-strip false pass).
- Long unbreakable strings (code identifiers, nav labels) bleed out of narrowed cards — needs `overflow-wrap: anywhere` (not `break-word`, which doesn't break when `overflow-x: visible`), not font clamping.
- Colorful aesthetics legitimately paint large saturated areas — coherence guards must respect declared palette intent instead of assuming restraint.
- Reasoning models spend heavily on thinking: keep reasoning effort low, bake ALL requirements into ONE system prompt, never rely on paid retry loops.
- The completeness contract catches spec-level gaps (clusters the model forgot) but NOT perception gaps (elements below the prominence floor that were never clustered). Non-clustered elements (headers, breadcrumbs, ads) are invisible to completeness AND coverage — the by-eye bar can fail even when unaccounted-cluster count is 0 and coverage is 1.000.
- `overflow-wrap: break-word` on a narrowed container is inherited by text descendants, but children with their own `overflow-wrap` declaration override the inherited value. The targeted repair uses `overflow-wrap: anywhere` which is more aggressive (affects min-content size, breaks regardless of `overflow-x`).
- `columnCount` narrowing can cause text to wrap into single-character-per-line columns if the container is too narrow — this is NOT a bleed (text stays within the container) and is NOT caught by the bleed check. A Phase 1d issue.

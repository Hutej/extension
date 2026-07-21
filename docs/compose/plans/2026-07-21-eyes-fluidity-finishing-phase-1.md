# Round 10: Eyes, Fluidity, and Finishing Phase 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use compose:subagent (recommended) or compose:execute to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the engine eyes (pixel-rendered verification), make designs survive reality (fluidity + dynamic content), kill repair theater, root-cause latency, enforce design-quality laws, and finish Phase 1 product hygiene — so a design a human instantly fails is mechanically impossible to report as PASS.

**Architecture:** The Round 7 pipeline stands (perceive -> reason -> compile -> verify -> repair -> persist). This round adds organs, not a rebuild:
- **WS1 (EYES):** Pixel capture (harness via Playwright screenshots, product via `chrome.tabs.captureVisibleTab`) -> canvas-based detectors (void, invisible-text, squeeze, recolor) wired into the repair router. All Tier-1, zero model calls.
- **WS2 (FLUIDITY):** Fluid-first compiler law (no raw fixed-px widths in emitted CSS) + multi-viewport/zoom/resize verification in the harness + debounced runtime re-adaptation.
- **WS3 (LIVING PAGE):** Cluster-signature-level CSS selectors so scroll-loaded siblings inherit the design + detect/inject into new shadow roots + harness proofs.
- **WS4 (THEATER + LATENCY):** Max 2 visible paints (apply once -> verify -> batch all repairs -> one merged re-apply) + serialization budget + stage ledger that sums to wall-clock + model bake-off + structured JSON run report.
- **WS5 (DESIGN QUALITY):** Root-cause contrast on gradient/transparent panels (sample rendered pixel) + accent accounting that counts canvas-held color + theme polarity enforcement + typography laws in the compiler + use-the-room metric + background-contains-content law.
- **WS6 (PRODUCT HYGIENE):** Fast-path router beyond hide + vague-prompt grid axis + scrub all site-name comments + escape-hatch safety + persistence acceptance + honest docs.

**Tech Stack:** WXT + TypeScript strict + MV3 (Chrome), Playwright (harness), Canvas API (pixel analysis — native, no new dependency), chrome.tabs.captureVisibleTab (product pixel capture), gpt-5.1 (design model — one-shot mandate).

## Global Constraints

- **Tests first:** every new acceptance check is written BEFORE the workstream code it validates. Run against the current build, record failures. Those failing tests ARE the specification.
- **No new dependencies:** use Canvas API (native browser), Playwright (already installed), chrome.tabs.captureVisibleTab (already permitted via `activeTab`). No sharp, no pngjs, no image libraries.
- **One-shot mandate:** <=1 paid design call on the happy path; every reReason logged loudly as a system-prompt failure; <=120s hard abort per attempt; retries only on 429/5xx.
- **All or nothing:** any original-looking region after a redesign = FAILURE. The human eye is the final gate. No checkbox flipped to done on green automated checks alone.
- **Zero site-specific hardcoding:** no domain branching, no aesthetic lookup tables, no site-name comments. Grid uses NOVEL prompts.
- **Priority order:** WS1 -> WS2 -> WS3 -> WS4 -> WS5 -> WS6. Whatever gives is flagged-and-stopped, never silently dropped.
- **Ponytail:** YAGNI first, stdlib/native before new code, shortest working diff, no unrequested abstractions. Mark simplifications with `ponytail:` comments.
- **Commit hygiene:** small commits per task, honest messages, typecheck + unit tests green before every merge.

## Deviations from the architect's methodology (with reasoning)

1. **Pixel analysis in the browser, not Node-side.** The harness loads Playwright screenshots back into the page as data URLs and uses the browser's native Canvas API (`drawImage` + `getImageData`) for pixel analysis. Rationale: the browser already decodes PNGs; no `sharp`/`pngjs` dependency; `page.evaluate()` runs the same detector code the product uses (DRY). Native platform feature (rung 4 of the ladder).

2. **Product pixel capture via `captureVisibleTab` (1 position), harness via Playwright (3 positions).** The product captures the visible viewport once (no scrolling — would violate WS4's paint-count budget). The harness captures at 3 scroll positions (top/mid/deep) to catch the "blank void below the fold" bug. Rationale: the product can't scroll without visible theater; the harness can because it's not user-visible.

3. **Recolor detector stays DOM-based (layoutReshaped), not pixel-based.** The existing `layoutReshaped` check (column-count + content-width + region-width changes) already catches recolors mechanically and is calibrated from 3 grid runs. A pixel-based recolor detector adds complexity without proven benefit. Flag-and-stop if the DOM-based detector proves insufficient with data from the grid run. Rationale: ponytail — the existing check works; don't pre-build a pixel alternative until data proves it's needed.

4. **Fluid-first compiler law: extend the existing `min(X, 100%)` conversion, don't rewrite.** The compiler already wraps fixed-px widths in `min(X, 100%)` and clamps large fonts. The LAW extends this: ALL fixed-px values in layout width/min-width/max-width MUST be converted — verified by unit test. The system prompt already teaches the model to use relative units; the compiler is the enforcement backstop. Rationale: shortest working diff.

5. **Model bake-off: smoke grid (1 site) with 3 models, not the full 5-site grid with every model.** The full grid with every account model would be 25+ paid calls and >1 hour. The smoke grid (Wikipedia, 1 prompt) with 3 models (gpt-5.1 vs gpt-5 vs gpt-4o) gives a fair comparison at 1/8 the cost. The comparison table (model x quality x latency x tokens) is committed. Rationale: ponytail — the bar is "when we achieve within 30 sec I don't care which model"; a smoke bake-off gives the data.

---

## File Structure

### New files
- `project/src/core/pixels/index.ts` — pixel capture + detectors (void, invisible-text). The `analyzePixels` function is pure (takes ImageData + element rects, returns results) — unit-testable without a DOM.
- `project/tests/pixels.test.ts` — unit tests for the pixel detectors.
- `project/tests/bakeoff.test.ts` — model bake-off (smoke grid with 3 models).

### Modified files
- `project/src/entrypoints/content.ts` — wire pixel capture + detectors; paint counting; structured run report; batch repairs; extend fast-path router; root-cause instrumentation.
- `project/src/entrypoints/background.ts` — add `captureTab` handler (chrome.tabs.captureVisibleTab).
- `project/src/core/verify/index.ts` — pixel-grounded checks in VerifyResult; fix effective background on gradient/transparent panels; use-the-room metric; background-contains-content; typography checks.
- `project/src/core/compile/index.ts` — enforce fluid-first law; selector generalization; typography laws.
- `project/src/core/repair/index.ts` — wire pixel-grounded critiques into the repair router.
- `project/src/core/perceive/index.ts` — cluster-signature selectors; bound serialization payload.
- `project/src/core/reason/index.ts` — update system prompt for typography/polarity; log serialized chars.
- `project/src/core/laws/index.ts` — typography constants (measure floor/ceiling, line-height floor); background-contains-content law.
- `project/src/core/spec/index.ts` — audit that specs store intent, not measurements.
- `project/src/core/config/index.ts` — model configurable via env var for bake-off.
- `project/src/entrypoints/popup/main.ts` — display structured run report.
- `project/tests/popup.test.ts` — extend with ALL new acceptance checks.
- `project/tests/compile.test.ts` — fluid-first law, typography law, selector generalization tests.
- `.kiro/steering/product.md` — honest current-position update (by-eye gate stays the user's).

---

## Task Summary (by priority order)

### Phase A (T1.1): Tests-first — extend harness with ALL new acceptance checks
**Mechanism:** After each transform, the harness runs new post-apply checks: (1) pixel audit at 3 scroll positions — screenshot -> data URL -> page.evaluate -> canvas -> getImageData -> variance check per [data-wm-c] cluster rect; (2) multi-viewport resize to 800/1600px; (3) zoom 80%/125%; (4) devtools 30% shrink; (5) scroll-load on SPA/shadow sites; (6) visible-paint count (data attribute); (7) escape-hatch click; (8) reload + SPA persistence; (9) vague-prompt axis; (10) structured report JSON. Run against current build -> record failures -> commit.

### WS1 (T1.2): EYES — pixel-rendered verification
**Task 2 — Pixel capture + detectors (product):** New `core/pixels/index.ts`. `captureTab()` sends a message to background -> `chrome.tabs.captureVisibleTab(null, {format:'png'})` -> data URL. `auditPixels()` loads the data URL into an offscreen canvas, reads pixels at each [data-wm-c] element's rect. `analyzePixels(data, w, h)` is pure: for each cluster, sample pixel variance (min/max RGB range). Text clusters with variance < 15 = invisible text; large empty clusters with variance < 10 = void. Background gets a `captureTab` message handler.
**Task 3 — Wire detectors to repair router:** Add `voids` + `invisibleText` fields to VerifyResult. Repair router: invisible text -> forceContrast on flagged handles (deterministic, free); voids -> critique for reReason ("content vanished — restore or remove the layout that collapsed it"). The bar: if the human eye sees invisible text, the detector flags it. All Tier-1, zero model calls.

### WS2 (T1.3): FLUIDITY — designs survive reality
**Task 4 — Fluid-first compiler law:** Unit test: assert every LAYOUT_PROPS key producing a width/min-width/max-width CSS property converts fixed px to `min(X, 100%)`. The existing `isFixedLength` + conversion in `capabilities/structure` already covers this — the test verifies no gap.
**Task 5 — Multi-viewport/zoom/resize harness:** After apply, resize to 800/1600px, check no overflow. Set zoom to 80%/125% via CSS zoom property, re-check. Devtools: shrink 30%, re-check.
**Task 6 — Runtime re-adaptation:** The existing `startDynamicDefense` has a resize listener (debounced 600ms) that re-compiles + re-applies. Extend: also re-verify after re-apply; if broken, do deterministic repair (forceContrast, clamp). No paid calls on resize.
**Task 7 — Specs store intent audit:** Verify no perception geometry (viewport width, cluster rect) is frozen into stored spec CSS values. The spec's values are the model's intent; the compiler converts to fluid CSS.

### WS3 (T1.4): THE LIVING PAGE — dynamic content
**Task 8 — Selector generalization:** Scroll-loaded siblings get the SAME handle (signature-based clustering is deterministic) when the defender re-stamps. The issue is the 600ms debounce delay. Test: scroll YouTube post-apply, wait 2s, assert new cards are styled. If the defender works, done. If not, reduce debounce or emit broader tag-based selectors for high-count repeated families.
**Task 9 — New shadow roots:** In the dynamic defender's MutationObserver, detect if any added node has `shadowRoot` and inject the style element into it. Test: create a shadow root post-apply, assert style is injected.
**Task 10 — Multi-scrollable proof:** Test on a page with >=2 independent scroll regions; assert design applies inside all.

### WS4 (T1.5): THEATER + LATENCY
**Task 11 — Max 2 visible paints:** Instrument `applyStyleEverywhere` with a `data-webmorph-paint-count` counter. Batch all repair options into ONE compile + ONE re-apply (not per-iteration). Assert count <= 2.
**Task 12 — Serialization budget:** Cap `serializePerception` at ~8000 chars by trimming compact-tier one-liners. Log before/after char count per site.
**Task 13 — Root-cause overhead:** Add `serializeMs`, `sanitizeMs`, `persistMs`, `defenseMs` to the ledger. Assert the ledger sums to `totalMs` (±5%). The ~44s GitHub overhead will be explained.
**Task 14 — Model bake-off:** Run smoke grid with 3 models (gpt-5.1, gpt-5, gpt-4o). Commit comparison table (model x quality x latency x tokens). Make model configurable via `WM_MODEL` env var.
**Task 15 — Structured run report:** Every transform emits one JSON artifact: stage ledger, paid calls, tokens, serialized chars, per-check verdicts, paint count.

### WS5 (T1.6): DESIGN QUALITY
**Task 16 — Contrast on gradient/transparent:** The `effectiveBackground` walk falls back to white on gradients. Fix: if the computed bg is a gradient or transparent, sample the actual rendered pixel from the captured tab image (WS1's pixel capture) at the text element's position. Use that as the effective bg for contrast computation.
**Task 17 — Accent accounting:** The `measureAccentAreaFraction` only counts cluster backgrounds, not canvas-held color. Fix: also measure the canvas background's colorfulness; if the canvas itself is vivid, count that toward the accent fraction so "explosive" prompts can't pass while looking flat.
**Task 18 — Theme polarity:** The system prompt already says "the canvas obeys the vision" (directive 9). Prove with one grid run whose prompt implies opposite polarity to the site's default (e.g., light design on a dark site).
**Task 19 — Typography laws:** Add to `laws/index.ts`: `MIN_MEASURE_CH = 45`, `MAX_MEASURE_CH = 90`, `MIN_LINE_HEIGHT = 1.2`. Enforce in the compiler (clamp widths to the measure range) and check in verify (assert text containers fall within the measure range).
**Task 20 — Use-the-room metric:** From rendered pixels (WS1's capture), measure the content column width vs viewport width. If content uses < 40% of the viewport on a non-article page, flag it as "sleeps in the washroom."
**Task 21 — Background-contains-content:** Verify no text/content escapes its painted panel — check that child text elements' bounding rects are within their parent cluster's painted rect. Unit-test the law.

### WS6 (T1.7): PRODUCT HYGIENE
**Task 22 — Fast-path router beyond hide:** Extend `classifyIntent` to route "bigger text", "remove sidebar", "increase spacing" to a deterministic <=5s path (no model call). "Move this" routing in scope (execution stays Phase 2).
**Task 23 — Vague-prompt axis:** Add 2 fuzzy prompts to the grid ("make it feel calm and expensive", "I want it fun but not childish") on 2 sites, hold them to the same bars.
**Task 24 — Scrub site-name comments:** Search all source files for site names (Wikipedia, BBC, GitHub, YouTube, MDN) in comments. Rewrite regression stories generically ("a content-heavy wiki", "a news portal"). Zero site-specific anything.
**Task 25 — Escape-hatch safety:** Test Off/Remove at any moment: mid-transform, post-repair, after SPA navigation. Harness-asserted.
**Task 26 — Persistence acceptance:** Reload + SPA-navigate after transform; assert verified CSS re-applies (not a re-compile drift) and survives.
**Task 27 — Honest docs:** Update `product.md`'s current-position truthfully. No new markdown docs beyond that and this plan artifact.

---

## Execution approach

Inline execution (tasks are tightly coupled — each workstream's implementation depends on the tests-first phase and the prior workstream). The plan executes in priority order: Phase A (tests) -> WS1 -> WS2 -> WS3 -> WS4 -> WS5 -> WS6. Each task: write failing test -> run to verify fail -> implement -> run to verify pass -> commit. The smoke grid (`WMGRID=smoke`) is the primary verification; the full grid runs at the end.

## Self-review checklist (32 items)

The final report will check off every numbered task from the work order:
1. Capture (harness 3-position + product captureVisibleTab) — shipped/failed/stopped
2. Void detector — shipped/failed/stopped
3. Invisible-text detector — shipped/failed/stopped
4. Squeeze detector — shipped/failed/stopped (existing)
5. Recolor detector — shipped/failed/stopped (DOM-based, deviation #3)
6. Wiring to repair router — shipped/failed/stopped
7. Fluid-first compiler law — shipped/failed/stopped
8. Specs store intent — shipped/failed/stopped
9. Multi-viewport/zoom/resize verify — shipped/failed/stopped
10. Runtime re-adaptation — shipped/failed/stopped
11. Devtools simulation test — shipped/failed/stopped
12. Selector generalization — shipped/failed/stopped
13. New shadow roots — shipped/failed/stopped
14. Scroll-load proofs — shipped/failed/stopped
15. Multi-scrollable proof — shipped/failed/stopped
16. Max 2 visible paints — shipped/failed/stopped
17. Serialization budget — shipped/failed/stopped
18. Root-cause overhead — shipped/failed/stopped
19. Model bake-off — shipped/failed/stopped
20. Structured run report — shipped/failed/stopped
21. Contrast on gradient/transparent — shipped/failed/stopped
22. Accent accounting — shipped/failed/stopped
23. Theme polarity — shipped/failed/stopped
24. Typography laws — shipped/failed/stopped
25. Use-the-room metric — shipped/failed/stopped
26. Background-contains-content — shipped/failed/stopped
27. Fast-path router — shipped/failed/stopped
28. Vague-prompt axis — shipped/failed/stopped
29. Scrub site-name comments — shipped/failed/stopped
30. Escape-hatch safety — shipped/failed/stopped
31. Persistence acceptance — shipped/failed/stopped
32. Honest docs — shipped/failed/stopped

# 03 — Module Breakdown

> Every module: purpose, inputs, outputs, dependencies, callers, assumptions, failure modes.
> Written for a new engineer. Every claim cites `file:line` or function names.

Legend: **verified** = traced to source; **UNVERIFIED** = not traced to source.

---

## 1. `entrypoints/popup/main.ts` (+ `index.html`) — Popup UI

- **Purpose:** the only user-facing UI. Prompt textarea, Transform/Toggle/Remove buttons, a settings area with an "API key" field, a status strip showing wall-clock + paid calls + tokens.
- **Inputs:** user text; `tabId` from URL params or `browser.tabs.query`.
- **Outputs:** `chrome.tabs.sendMessage` to the active tab's content script.
- **Dependencies:** WXT `browser`/`chrome` APIs; `chrome.storage.local`.
- **Callers:** the user (click events).
- **Assumptions:** the content script is listening; the stored API key is the one the background reads.
- **Failure modes:**
  - **DEAD AUTH UI (verified):** `popup/main.ts:25` reads/writes `openai_api_key`; `background.ts:36` reads `cloudflare_account_id`/`cloudflare_api_token`. The saved key is **never read by anything** → every real user fails `invalid_key`. The "OpenAI" label and `sk-...` placeholder are stale (OpenAI disabled, `reason/index.ts:53`). Cloudflare creds only work because the test harness injects them (`background.ts:34`).
  - **`paidCalls ?? 1`** (`popup/main.ts:111`): counts *roles* not HTTP requests; a 5-retry run shows "1 call" while 5 were billed.
  - **`revueonRunInFlight` flag persists forever** after a tab crash (the `finally` never runs) → popup shows "⚠ A transform is in progress…" indefinitely (`popup/main.ts:148`).
  - Mixed `browser.*` and `chrome.*` APIs (`:25` vs `:91`) — works via WXT polyfill but is a maintenance trap.
  - `getTabId` from URL params can target a stale `tabId` if the popup was reopened for a different tab.

## 2. `entrypoints/content.ts` (1603 lines) — Page orchestrator

- **Purpose:** the heart. Message handling, the run pipeline, hard-gate decisions, undo, observers, persistence, v1/v2 fork.
- **Inputs:** `{action, intent}` messages; the live DOM.
- **Outputs:** `TransformOutcome` (`content.ts:75`); DOM markers `data-revueon-applied`/`data-revueon-failed` (`:133`).
- **Dependencies:** almost every `core/*` module.
- **Callers:** popup/background via `chrome.runtime.onMessage` (`:1557`).
- **Assumptions:** the DOM is stable during a run; `data-rv-c` survives re-renders; the background SW stays alive.
- **Failure modes:**
  - **Second `transform` dropped silently** (`:1559`) — no busy reply → popup hangs.
  - **Crash path zeroes telemetry** (`:1580` `.catch` returns `wallMs:0`).
  - **Fast paths bypass all gates** (`fastHidePath:1373`, `fastMovePath:1444`).
  - **`reapplyStored` does NOT re-run `applyInlineBackstop`** (`:1196`) → invisible text on reload.
  - **Double perceive on v2 reload** (`:1163` then `:1193`) — wasted work.
  - **Shadow observer loss** (`:1289` pushes a shadow root during scan, but `:1252` reassigns `activeShadowRoots` from fresh perception → dropped root → its observer orphaned → shadow styling lost after first dynamic restyle).
  - **`captureShotAt` destroys user scroll** (`:222` `scrollTo(0,0)` after captures, no save/restore) and **2-rAF is insufficient for `scroll-behavior:smooth`** → mid-scroll capture mis-aligns rects vs pixels.

## 3. `entrypoints/background.ts` (70 lines) — Service worker

- **Purpose:** thin AI transport + tab capture relay. Holds Cloudflare creds.
- **Inputs:** `styleSpec`/`captureVisibleTab` messages; `chrome.storage.local` creds.
- **Outputs:** AI responses; PNG data URLs.
- **Dependencies:** `core/reason` (`:9`); `chrome.storage.local`, `chrome.tabs`.
- **Callers:** content script via `chrome.runtime.sendMessage`/`onConnect`.
- **Assumptions:** creds are present in storage; the SW isn't killed mid-fetch.
- **Failure modes:**
  - **Cred mismatch (verified):** reads `cloudflare_*` but the popup saves `openai_api_key`.
  - **Keepalive is best-effort** (`:27` empty `onConnect`): the port prevents *idle* kill, not forced kill under memory pressure → SW dies mid-fetch → `sendMessage` callback never fires → 120s hang (`content.ts:1129`).
  - **`captureVisibleTab(undefined)`** (`:56`) captures the last-focused window if `sender.tab` is missing → wrong-page screenshot.
  - **No port auth** — any caller with the runtime id keeps the SW alive; no port-name/sender validation.

## 4. `core/perceive/index.ts` (1489 lines) — DOM perception

- **Purpose:** walk the live DOM, cluster boxes, stamp `data-rv-c`, derive identity handles, role-classify, serialize. The single source of structural identity.
- **Inputs:** none (reads `document`).
- **Outputs:** `Perception` (clusters, skeleton, canvas, cssVars, composition, shadowRoots).
- **Dependencies:** `core/laws`, `core/design/packs`, `shared/color`, `./semantic`.
- **Callers:** `content.ts` (perceive, captureLayoutFingerprint, extractLayoutIR, serialize*); `verify` (captureLayoutFingerprint, findPrimaryContentNode).
- **Assumptions:** the DOM tree is flat-resolvable; geometry is stable; shadow roots are open and reachable via `el.shadowRoot`.
- **Failure modes:**
  - **Shadow-DOM resolution gap (verified):** walks open shadow roots (`:253`) and stamps shadow children (`:523`), but `representativeFor` (`:692`), `findScrollables` (`:376`), `enrichSemantic` (`:815`) all use light-tree `document.querySelector` → shadow clusters return `null` → `if (!el)` at `:819` defaults to `ad-or-void`/0. **YouTube and all web-component sites classified as empty voids.**
  - **`clearRoleCache` has ZERO callers (verified):** `:466` exported, never called → role cache persists across SPA routes for the whole session.
  - **`structuralPath` truncates** at depth 10 / anchor-search 20 (`:412`,`:440`) → handle collisions and churn on deep custom-element trees.
  - **`MAX_DEPTH=30` / `MAX_TIME_MS=6000` silent truncation** (`:241`) — abandoned subtrees have no clusters, no `truncated` flag.
  - **Layout thrashing:** `getBoundingClientRect`+`getComputedStyle` per element; representative re-resolved 3× per cluster; `resolveVarMap` (`:1071`) does a forced reflow per exotic-color var (oklch/Tailwind v4 = dozens).
  - **Mutation race:** a re-render between `walk` and enrichment leaves detached refs → `getComputedStyle`/`getBoundingClientRect` return zeros silently, no try/catch.
  - **`directTextLength`** (`:1459`) counts only text-node children → a `<div><span>text</span></div>` has length 0 → may be invisible to clustering.
  - **`clearHandles`** (`:1115`) can't remove stamps from shadow trees → stale `data-rv-c` leaks across runs inside shadow roots.

## 5. `core/perceive/semantic.ts` (391 lines) — Role classifier

- **Purpose:** pure 14-role classifier from cluster signals; dominance ranking; sibling grouping; composition summary.
- **Inputs:** `ClusterSignals` + `PageContext`. **Outputs:** `RoleClassification`, dominance, group map, composition.
- **Dependencies:** none (pure). **Callers:** `perceive/index.ts:844` (classifyRole), `:850` (rankDominance), `:863` (detectGrouping), `:322` (summarizeComposition).
- **Assumptions:** viewport-relative geometry is meaningful; class tokens carry semantic meaning; widths are stable.
- **Failure modes:**
  - **Viewport-coupled position thresholds** (`:99-102`): `isTop/Bottom/Left/Right` use `getBoundingClientRect` (scroll-relative) → same cluster classifies differently depending on scroll position.
  - **`normWidth` still viewport-coupled for top-level regions** (`:98` + `perceive:762`): no parent cluster → falls back to `widthRatio` → resize flips roles for exactly the regions that need stability.
  - **Unfixed `.slice(-6)` hash (verified):** `:390` — the exact bug fixed in `perceive:1488` (modulo) is still live → group-id collisions for long handle lists.
  - `meta\b` regex (`:177`) does not match "metadata"; `voidToken` (`:239`) false-positives "sponsorship"/"promotional" → real content forced to `ad-or-void`.
  - `detectGrouping` (`:312`) sorts by viewport-coupled rect → sticky sidebar breaks group on scroll → group churn.
  - RTL: `hasRightRail/hasLeftRail` (`:363`) are physical → inverted for Arabic/Hebrew pages.

## 6. `core/layout/ir.ts` (227 lines) — Layout IR

- **Purpose:** pure projection of `Perception` into frozen 4-section nodes + current-arrangement constraints.
- **Inputs:** `Perception`. **Outputs:** frozen `LayoutIR` (nodes, byHandle).
- **Dependencies:** type-only on `perceive`. **Callers:** `extractLayoutIR` ← `content.ts:529`; `currentConstraints` ← `solve.ts:138`.
- **Assumptions:** perception is complete and stable; immutability is enforceable.
- **Failure modes:**
  - **`deepFreeze` doesn't freeze Maps (verified):** `:211-214` returns the `Map` instance without `Object.freeze` → `byHandle.set/delete/clear` all succeed → immutability contract runtime-false for the most-used structure.
  - **`sourceOrder` is prominence order, not document order (verified):** `perceive:515` sorts by prominence before assigning `sourceOrder` → the IR's `ordering` and the solver's "READING ORDER IS INVIOLABLE" trust a mislabeled value.
  - `widthRatio` bucketing (`:158`) moves the FillParent knife-edge (0.97→0.95→`partial`).
  - Phantom parents: a cluster whose `parentHandle` isn't in `nodes` is silently isolated with no error.

## 7. `core/layout/exclusions.ts` — Exclusion registry

- **Purpose:** detect JS-controlled subtrees, mark `relayout:false`.
- **Inputs:** `Cluster[]`. **Outputs:** `Map<handle, ExclusionReason>`.
- **Dependencies:** type-only. **Callers:** `detectExclusions` ← `content.ts:530`.
- **Assumptions:** detection signatures match modern libraries; shadow clusters are resolvable.
- **Failure modes:**
  - **`isMap` misses all modern maps (verified):** `:123` checks `el.onwheel`/`onpointerdown` (DOM0) and `hasAttribute`. Leaflet/MapLibre/Google Maps use `addEventListener` → none detected → maps relayouted → pan/zoom break.
  - **`isCarousel` misses `overflow:clip`** (`:68`) and variable-width slides.
  - **`isVirtualized` misses non-transform virtualizers** (`:97`): TanStack-Virtual (uses `top/left`), padding-spacer virtualizers.
  - **`isJsControlledLayout` massively over-excludes (verified):** `:116` regex matches `width:100%` → any React `style={{width:'100%'}}` excluded → valid relayout skipped.
  - Shadow clusters can't be resolved (`:31` `document.querySelector`) → never excluded.

## 8. `core/layout/assign.ts` + `languages/documentation.ts` — Slot assignment

- **Purpose:** map each IR node to exactly one slot; throw on invariant violation. `documentation.ts` is pure slot data.
- **Inputs:** `LayoutIRNode[]`, `excluded` Set. **Outputs:** `SlotAssignment`.
- **Dependencies:** `./languages/documentation.ts`. **Callers:** `assignSlots` ← `content.ts:533`.
- **Assumptions:** roles map cleanly to slots; the `excluded` set is used.
- **Failure modes:**
  - **`excluded` parameter is dead code (verified):** `:26` never referenced → excluded nodes pollute `slotToHandles`. Invariant guards (`:37-49`) are defensive dead code.
  - **`page-title`→masthead (verified):** `documentation.ts:38` first-match-wins `:125` → an in-article `<h1>` is ripped to the top grid row, out of the article.
  - `ad-or-void`→overflow slot → repositioned into a separate grid column.
  - `minWidth` floors not respected below ~900px viewport (solver's `min(180px, 20vw-…)` makes the min below 180).

## 9. `core/layout/solve.ts` — v1 solver + v2 grid placement

- **Purpose:** pure placement + DOM-grounded CSS emitter (grid, `display:contents`, grid-column, fluid tokens).
- **Inputs:** `SolveInput` (IR + assignment + excluded). **Outputs:** `SolveResult` (placement), `PlacementResult` (CSS).
- **Dependencies:** `./ir.ts`, `./assign.ts`, `./languages/documentation.ts`. **Callers:** `solve` ← `content.ts:550`; `computeGridPlacementCss` ← `content.ts:551`.
- **Assumptions:** CSS-only is safe; selectors are stable; DOM order is correct.
- **Failure modes:**
  - **"Zero DOM mutation" is false (verified):** 4 `setAttribute('data-rv-grid',…)` (`:491,:511,:529,:547`) → attribute-observing frameworks (Vue/lit/Svelte) may reconcile them → grid breaks.
  - **`mergeConstraints` validation is theater:** `impossibleNodes` computed but never read by `computeGridPlacementCss` → impossible constraints placed silently.
  - **`display:contents` content-loss** (`:515`): absolute children lose containing block; `<button>`/`<a>` lose click target; `overflow:hidden` clipping lost.
  - **`buildSelector` duplicates `structuralPath`** (`:241-286` vs `perceive:407-451`) with a different joiner → divergence → wrong element targeted.
  - **`aria-label^=` prefix collision** (`:262`, 20-char prefix).
  - **Grid rows auto-place in DOM order** (`:34-36` bans `order`/`grid-area`) → footer-first template renders footer-on-top, unfixable.
  - **`solve()` and `computeGridPlacementCss` disagree** (per-node vs per-proxy-BFS).
  - O(n²) scans; positional `f${indexOf}` attribute values break across reorders.

## 10. `core/reason/index.ts` — AI transport

- **Purpose:** build prompts, call Cloudflare Workers AI, validate/retry.
- **Inputs:** intent, perception, creds, role, critique, timeout. **Outputs:** `StyleSpec`/`DesignSpec`.
- **Dependencies:** `core/config`, `core/spec`. **Callers:** `background.ts:14-17` (dispatchRole).
- **Assumptions:** the model returns valid JSON matching the schema; the network is reliable; one call suffices.
- **Failure modes:** (full detail in `06_AI_PIPELINE.md`)
  - **One-shot mandate structurally impossible** (≥2 parallel calls + critic on fail).
  - **Retries silently re-bill** (up to 5×/role, counter never returned).
  - **Full page content egress with no consent** (`:265-307`).
  - **429 `Retry-After` header ignored** (`:383` parses OpenAI body-text format).
  - `isReasoningModel` regex over-matches any model id containing "glm" (`:394`).

## 11. `core/spec/index.ts` — Spec types & validation

- **Purpose:** `StyleSpec`/`DesignSpec` types, `validateSpec`, `mergeSpecs`.
- **Inputs:** model JSON. **Outputs:** validated spec or error.
- **Failure modes:**
  - **`packOverrides` bare `as` cast** (`:241`) — no shape/type validation → silent corruption or crash (see `design/packs.ts:189`).
  - **Hallucinated roles/handles pass validation** (`:197`): enum fields valid, just no matching clusters → backstop only at post-apply coverage gate.
  - `asDecls` coerces numbers to strings (`:463`) — unitless numbers may be dropped downstream.
  - `parsePlacement` accepts `relocate` with any `to` string (`:302`) — no existence check.

## 12. `core/compile/expand.ts` + `compile/index.ts` — Compile

- **Purpose:** expand model intents → CSS declarations; packs; laws.
- **Failure modes:**
  - **Raw px `fontSize`/`padding`** (`expand:199,:214,:286`) not covered by `fluidizeRawPxSizing` (`laws:442` covers only width/height) → zoom-hostile type/padding.
  - **Hallucinated roles silently no-op** (`expand:174`) → `escapeHatchFraction` denominator falls to 1 → metric gamed.
  - `relocate` with no `to` (`expand:249`) → op refused silently; `topbar` refused when `moveSafety !== 'safe'` (incl. `undefined`).
  - `hideRefusal`'s `rect.h > 300` (`compile:636`) is zoom-coupled.
  - `opaqueOr` rejects translucent model washes → repair paints canvas tone instead of the intended dark glass.

## 13. `core/design/packs.ts` — Design packs

- **Purpose:** visual packs (typeRamp, colors, spacing), role styles, per-primitive composition.
- **Failure modes:** `resolvePack` spreads overrides directly (`:189-202`) with no validation → a string `packOverrides.colors = "#fff"` adds spurious numeric keys; a number `spacingScale` silently no-ops density.

## 14. `core/verify/index.ts` + `pixel.ts` + `capture.ts` — Verify

- **Purpose:** post-apply hard gates + pixel detectors.
- **Failure modes:** (full detail in `10_PERFORMANCE_ANALYSIS.md`)
  - **Massive layout thrashing** — 8-10 full-tree scans + 3 forced reflows + `effectiveBackground` O(depth²) recursion, runs 2-3× per transform.
  - **`noOverflow` delta tolerance hides blow-out** (`:157`): `beforeRatio*1.02` lets a 1.5×-overflow page add 2% more and pass.
  - **Capture failure → PASS** (0-size → variance 765 → "no problems").
  - **DPI not normalized** → false invisible-text on high-DPI.
  - **`checkConformance` regex** (`:686`) breaks on `data:` URLs with semicolons and nested braces.
  - **`classifyInvisibleFailures`** (`pixel:250`) — both branches return `'cascade-loss'`; `byClass['no-handle']` always 0.
  - `contrastTargets` only populated for sampled reps → unsampled low-contrast clusters stay invisible.

## 15. `core/repair/index.ts` — Repair

- **Purpose:** route a verify+pixel failure to the cheapest fix.
- **Failure modes:**
  - **`bestNonBroken` dead code (verified):** imported `content.ts:20`, defined `:260`, never called → "keep best non-broken attempt" guarantee unenforced. The last-resort loop (`:278`) ignores `notBroken`/`contentIntact` → can return a fully broken attempt.
  - `keepBest` → redundant paint-2 (`content.ts:969`) → wasted paint.
  - `forceContrast` inline backstop hole: sets `color` on the cluster element, not the text-bearing child → a `<span style="color:#000">` inside a black-bg cluster survives.

## 16. `core/execute/index.ts` — Execute

- **Purpose:** inject `<style>`, defense MutationObserver, escape UI.
- **Failure modes:**
  - **No circuit breaker** (`:62-73`) → style-stripping site → unbounded re-insert loop (forced reflow each cycle) → CPU bomb.
  - **Shadow observer leaks** — removed shadow host's observer keeps running until next transform.
  - **Escape UI undefended** (`:125` appends to `documentElement`, observer watches only `<head>`) → a framework reconciling `<html>` children deletes the button.

## 17. `core/ops/index.ts` + `transaction.ts` — Ops & undo

- **Purpose:** validate ops, execute move/remove/reorder/wrap, record inverses, undo.
- **Failure modes:**
  - **Undo holds live `Node` refs** (`transaction:23-25`); `undoAll` (`:81`) **no try/catch** → one `insertBefore` `NotFoundError` after a re-render aborts the rest → half-undone page.
  - **`wmPrevCss` restore wipes site inline styles** (`transaction:95`) → site's `style.display='none'` toggle destroyed on undo.
  - `executeOps` no dependency resolution → a `reorder` whose `before` was removed earlier falls to "move to end" silently.
  - `move` consent (`ops:77`) is stale on re-derive — the original `consent:true` re-applies to a different cluster with the same handle.

## 18. `core/sanitize/index.ts` — Sanitize

- **Purpose:** strip dangerous CSS/HTML vectors.
- **Failure modes:**
  - **Regex-based, not a real parser** (`:73-124`): CSS hex escapes (`@\69 mport`) bypass `@import`.
  - **`data:` MIME-unrestricted** (`:112`): `data:image/svg+xml,<svg onload=…>` allowed.
  - No `@keyframes`/`@font-face`/`@media` block sanitization.
  - `sanitizeMarkup` is dead in the apply path (defined, never called).

## 19. `core/capabilities/{style,structure}/index.ts` — Capabilities

- **Purpose:** build safe `!important` declarations, contrast lock, viewport-safe widths.
- **Failure modes:**
  - **Contrast lock defeated by `var()` resolution failure** (`style:91-94`): unresolved var → `text = ''` → `color:  !important;` invalid declaration → no text color → contrast lock silently defeated.
  - `buildLayoutDeclarations` `min(X, 100%)` can shrink content vs `usesRoom`.

## 20. `core/persist/index.ts` — Persist

- **Purpose:** save spec+CSS+opts to `chrome.storage.local`.
- **Failure modes:** **UNVERIFIED** — `chrome.storage.local` quota (`QUOTA_BYTES`) on a large spec is untested; a quota throw could leave no saved state and no `markApplied`.

## 21. `core/config/index.ts` + `core/laws/index.ts` — Config & laws

- **Failure modes:**
  - **`DEBUG = true` hard-wired** (`config:86`) → page content in production console.
  - **No global 120s abort** (`config:52`) — per-call only → runs hit ~145s.
  - **`paidCalls` is observability, not a gate** (`config:47-50`).
  - `fluidizeRawPxSizing` (`laws:442`) doesn't cover `font-size`/`padding` (the expander reintroduces raw px).

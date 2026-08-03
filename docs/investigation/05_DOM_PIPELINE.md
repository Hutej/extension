# 05 — DOM Pipeline

> DOM capture, analysis, mutation, observer lifecycle, rollback, selection preservation.
> Every claim cites `file:line`. Speculation is marked **UNVERIFIED**.

## 1. DOM Capture — `perceive()`

`perceive/index.ts:230` `perceive()` is the capture stage. It is **synchronous** and reads the **live DOM**.

### Walk
- `walk(el, depth)` (`:240`) recurses children, **descends into open shadow roots** (`:253-256`):
  ```js
  if (el.shadowRoot) {
    shadowRoots.push(el.shadowRoot);
    for (const child of Array.from(el.shadowRoot.children)) if (child instanceof HTMLElement) walk(child, depth + 1);
  }
  ```
- **Caps:** `MAX_DEPTH = 30` (`:26`), `MAX_TIME_MS = 6000` (`:24`). At `:241`: `if (performance.now() - t0 > MAX_TIME_MS || depth > MAX_DEPTH) return;` → **silent truncation, no `truncated` flag.**
- **Skips:** `IGNORED_TAGS` (`:22`) — note `IFRAME`/`EMBED`/`OBJECT` are NOT in IGNORED_TAGS but their `.children` is empty (cross-origin contentDocument is null) → walked as bare elements, never entered.
- Per element: `getBoundingClientRect()` (`:246`) + `getComputedStyle(el)` (`:261`) → **layout reads on every element** (forced-layout-read cost, no writes interleave).

### Cluster + stamp
- `clusterAndStamp` (`:471`) groups candidates into clusters, picks a `representativeFor(cluster)` (`:692`), and **stamps `data-rv-c="<handle>"`** (`:523`).
- **The shadow-DOM resolution gap (verified):** `representativeFor` (`:692`), `findScrollables` (`:376`), `enrichSemantic` (`:815`) all resolve via light-tree `document.querySelector(cluster.selector)`. A shadow-stamped cluster returns `null` → `if (!el)` at `:819` → defaulted to **`ad-or-void`/0** (except pre/code → `article-body`). **YouTube and all web-component-heavy sites are systematically classified as empty voids.**
- **Closed shadow roots** invisible (`el.shadowRoot` null). **iframes** never entered.

### Identity handles — `structuralPath` (`:407`)
- Handle = `hash(structuralPath(rep.el))` — tag + nth-of-type chain from a stable ancestor (id/data-testid/role/aria-label/name), capped `searchDepth < 20` (`:412`), chain `d < 10` (`:440`).
- **Truncation causes collisions** on deep custom-element trees (YouTube `ytd-app`): two deep nodes sharing the same bottom-10 nth-of-type sequence → same `hash` → handle collision. Salt disambiguates within a run (`:493`) but a mutation shifts which node gets the salt across runs → identity churn.
- **`hash` (`perceive:1482`) is fixed** (modulo `2176782336`), but **`semantic.ts:390` `hash` still uses the unfixed `.slice(-6)`** (verified) → group-id collisions.

### Role classification — `semantic.ts`
- 14 roles; thresholds are **viewport-coupled** (`:99-102` `isTop/Bottom/Left/Right` via `getBoundingClientRect`). Same cluster classifies differently depending on scroll position.
- `normWidth` (`:98`) is parent-relative only when a parent cluster exists; top-level regions (nav/masthead) fall back to viewport-relative `widthRatio` → resize flips roles.

### Settlement
- `waitForSettle(quietMs, maxMs)` (`:1129`): a MutationObserver quiet window — proceed when no layout-affecting mutations for 500ms, 6000ms hard ceiling. Replaces the fixed `settleMs` stopwatch (S3.4). All sites settled quietly per the roadmap (not timeout).

### Serialization
- `serializePerception` (`:1219`) / `serializeV2Painter` (`:1371`) → compact text for the model. v2 painter trimmed to ~9K chars (no geometry).

## 2. DOM Analysis — `extractLayoutIR` / `assignSlots` / `solve`

- `extractLayoutIR` (`ir.ts`) is **pure** (no DOM — perception already captured styles). Projects `Perception` into frozen 4-section nodes.
- **`deepFreeze` doesn't freeze Maps (verified, `ir.ts:211-214`)** → `byHandle` mutable.
- `currentConstraints` (`ir.ts`) derives the page's current arrangement as constraints (seed for the Target IR).
- `detectExclusions` (`exclusions.ts`) marks `relayout:false` subtrees. **Misses modern maps, `overflow:clip` carousels, non-transform virtualizers; over-excludes `width:100%`.**
- `assignSlots` (`assign.ts`) maps each node to one slot. **`excluded` param is dead code.** `page-title`→masthead rips in-article h1 (verified).
- `solve` (`solve.ts`) builds placement; `computeGridPlacementCss` emits grid CSS. **"Zero DOM mutation" is false (verified, 4 `setAttribute` calls).** `display:contents` dissolves proxy boxes (containing-block/clipping/click-target loss).

## 3. DOM Mutation — `applyStyleEverywhere` + `executeOps`

### CSS injection
- `applyStyle` (`execute:19-28`): finds/creates `<style id=revueon-style>`, sets `textContent`, appends to `<head>` (re-appends existing to win cascade order). Also into every open shadow root via `observeShadowRoot`.
- `applyInlineBackstop` (`content.ts:509`): inline `!important` bg+text on contrast-failing clusters. **Not persisted, not re-applied on reload.**

### Structural ops (v1)
- `executeOps(validated, true)` (`content.ts:797`): move/remove/reorder/wrap, recorded in `txnLog`. **Runs BEFORE verify** → a gate failure leaves them applied (RC3).
- `executeOps` iterates in spec order, **no dependency resolution** → a `reorder` whose `before` was removed earlier falls to "move to end" silently.

### Identity attributes (v2)
- `setAttribute('data-rv-grid',…)` (`solve:491,511,529,547`) — DOM mutations despite the "CSS-only" claim.

## 4. Observer Lifecycle

### `startDefense` — style re-insertion (`execute:62-73`)
- MutationObserver watches `<head>` childList + the style node's parent. On removal: `stopDefense()` → `applyStyle(css)` (re-create) → `startDefense(css)` (re-arm).
- **No circuit breaker:** a site that strips unknown `<style>` on an interval → unbounded remove→re-insert loop (forced reflow each cycle) → CPU bomb.
- Re-appending our own style fires the observer with an `added` node, not removed → the callback only inspects `removedNodes` (`:64`) → safe from recursion for this observer.

### `startDynamicDefense` (`content.ts:1272`) — re-style on site mutations
- Re-styles on mutation bursts, re-perceives. **Shadow observer leak:** `activeShadowRoots.push(sr)` (`:1289`) mutates the array in the callback, but `:1252` reassigns `activeShadowRoots` from fresh perception → the pushed root (and its observer at `:1293`) is orphaned after the first dynamic restyle → shadow styling lost for scroll-loaded custom elements.

### `startDefenseEverywhere` / `stopDefenseEverywhere`
- Arms/disarms observers across `<head>` + shadow roots. `stopShadowDefense` (`execute:105`) disconnects all and resets `[]`. A **removed** shadow host's observer keeps running until the next stop (leak).

### Observer cleanup on SPA nav
- `handleRouteChange` calls `stopDynamicDefense()` (`:1332`) before `await reapplyStored()`. Between stop and re-arm, the page mutates unobserved → **guaranteed flash of unstyled content**.

## 5. Rollback

### On gate failure (the broken path)
- `content.ts:913` (hard gate fail), `:954` (paint2 broke), `:983` (repair broke), `:924` (time budget): all call `removeStyleEverywhere(...)` and mark failed. **None call `txnLog.undoAll`.** Structural DOM ops applied at `:797` are NOT undone → a failed transform that removed a sidebar leaves the sidebar gone, marked "failed". On reload, the page re-perceives a DOM already missing the sidebar → **permanent silent structural data loss (RC3).**

### On user Toggle/Remove (the correct path)
- `undoOpsAndCss` (`content.ts:1225`) is the ONLY caller of `txnLog.undoAll(liveDom)` — replays inverse ops backwards + removes style + removes escape UI. **Holds live `Node` refs** (`transaction:23-25`).
- `undoAll` (`transaction:81`) has **no try/catch** → one `insertBefore` `NotFoundError` after a framework re-render (recycled/detached nodes) aborts the rest → half-undone broken page.
- `wmPrevCss` restore (`transaction:95`): `html.style.cssText = snapshot` **replaces ALL inline styles** → a site's `style.display='none'` toggle or animation is destroyed on undo.

### `handleRouteChange` — re-apply on SPA nav
- Debounced 500ms; only hooks `pushState`/`replaceState`/`popstate`/`hashchange` (`content.ts:1546`). **Turbo `turbo:load` morphs reuse DOM nodes without `pushState`** → no re-perceive → `txnLog` inverses reference recycled nodes → undo replays against wrong nodes.

## 6. Selection Preservation

- **Text selection:** not explicitly preserved or restored. `captureShotAt` (`content.ts:187`) does `window.scrollTo(0,y)` to capture, then `scrollTo(0,0)` at `:222` — **destroys the user's scroll position** (no save/restore). Text selection is not touched by the extension but is not protected either.
- **Scroll position:** destroyed on every pixel-verify run (the 3-position sweep scrolls the page, then resets to top). **UNVERIFIED** whether this causes user-facing disruption in practice (the sweep is during the transform, before the user re-engages).
- **Focus:** not explicitly managed. Moving a focused element via `executeOps` may change `document.activeElement` behavior.
- **Form state:** `executeOps` moves nodes (DOM reparenting) — for v1, this can break React/Vue controlled-component state (the roadmap's S6.3 blocker). v2's CSS-only path avoids reparenting but uses `display:contents` which dissolves boxes.

## DOM edge cases (summary — full list in `09_BROWSER_COMPATIBILITY.md`)
- Shadow DOM (open): stamped but unresolvable → `ad-or-void`. Closed: invisible. Nested: same.
- iframes: never entered.
- `display:contents`: not a candidate; children orphaned (`parentHandle:null`).
- Virtual scroll / carousels / maps: exclusion heuristics miss modern implementations.
- High-DPI: `capture.ts` downscale + `Math.round` → false invisible-text and width-bucket flips.
- RTL: `hasRightRail/hasLeftRail` physical → inverted.

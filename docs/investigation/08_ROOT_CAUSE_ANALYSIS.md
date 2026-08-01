# 08 — Root Cause Analysis

> Every issue: Symptom · Evidence · Root cause · Why it exists · User impact · Reproduction · Recommended solution · Confidence.
> Confidence: HIGH = verified against source; MEDIUM = strong inference; LOW = speculation.

---

## RC1 — Web-component / YouTube sites get no redesign

- **Symptom:** YouTube (and any web-component-heavy site) clusters are classified as `ad-or-void`; the redesign does nothing visible to the feed.
- **Evidence:** `perceive/index.ts:253-256` walks open shadow roots and `:523` stamps `data-wm-c` on shadow children. But `representativeFor` (`:692`), `findScrollables` (`:376`), `enrichSemantic` (`:815`) all resolve via light-tree `document.querySelector(cluster.selector)` → shadow-stamped clusters return `null` → `if (!el)` at `:819` defaults to `ad-or-void`/0 (except pre/code). `solve.ts:380` and `exclusions.ts:31` also use `document.querySelector`. Re-verified by read.
- **Root cause:** The architecture never modeled the **composed tree**. The walk descends into shadow roots; every read-back is flat-tree only. One missing `composedPath`/`deepSelector` abstraction.
- **Why it exists:** The DOM walk was written for a flat document; shadow-DOM support was bolted onto `walk` (`:253`) without updating the resolvers. The roadmap's P5 (structural identity) fixed *handles* but not *resolution*.
- **User impact:** The product's headline target ("reshape ANY website") silently fails on the most popular web-component site and every lit/polymer/web-component app. No error signal — the user sees a "successful" transform that changed nothing.
- **Reproduction:** Open YouTube, run any transform, inspect: the feed clusters carry `designRole:'ad-or-void'`, never reach the solver's placement set.
- **Recommended solution:** Add a `deepQuerySelector`/`querySelectorAllDeep` that pierces open shadow roots (and a stamped-root index for closed). Use it in `representativeFor`, `solve.computeGridPlacementCss`, `exclusions`. Without this, all web-component sites are dead.
- **Confidence:** HIGH.

---

## RC2 — Roles flip on resize/scroll/zoom

- **Symptom:** The same cluster gets a different role depending on viewport size and scroll position. The roadmap's own probe (product.md table) shows Wikipedia/GitHub role-stab failing.
- **Evidence:** `semantic.ts:99-102` `isTop/Bottom/Left/Right` use `getBoundingClientRect()` (viewport-relative). `:98` `normWidth = normWidthFromParent ? widthFractionOfParent : widthRatio` — but `perceive:762` sets `normWidthFromParent` from `cluster.widthFractionOfParent < 1`, **false when no parent cluster** (`:612` defaults to 1). Top-level regions (nav/masthead) fall back to viewport-coupled `widthRatio`.
- **Root cause:** **Geometry was never decoupled from the viewport at the perception layer.** P5's structural identity fixed *handles* but not the *classifier inputs*.
- **Why it exists:** The classifier was written with viewport-relative thresholds for simplicity; the `normWidth` fix (1.5B) addressed parent-relative ratios but left a gap for top-level regions.
- **User impact:** A redesign that was correct at one window size becomes a different (possibly broken) redesign after a resize or scroll. Re-perceiving on SPA nav re-rolls roles.
- **Reproduction:** Transform a page, resize the window, re-perceive — observe role flips in the probe metrics.
- **Recommended solution:** Use parent-relative ratios everywhere (close the `normWidthFromParent` top-level gap); use `offsetTop`/logical position, not `getBoundingClientRect`, for position signals.
- **Confidence:** HIGH.

---

## RC3 — Failed transform leaves the page permanently half-broken

- **Symptom:** A transform that removed a sidebar (v1 `remove` op) then fails the hard gate leaves the sidebar **gone**, marked "failed", with no recovery. Reloading re-perceives a DOM already missing the sidebar.
- **Evidence:** `content.ts:797` `executeOps(validated, true)` runs structural ops **before** verify (`:873`). Failure paths `:913` (hard gate), `:954` (paint2 broke), `:983` (repair broke), `:924` (time budget) all call `removeStyleEverywhere(...)` **but never `txnLog.undoAll`**. `undoOpsAndCss` (`:1225`) — the only caller of `txnLog.undoAll` — is invoked only on user Toggle/Remove.
- **Root cause:** **The failure path and the undo path are different code paths.** The architecture treats "rollback CSS" and "rollback DOM" as separable, but v1 applies DOM ops before verify. The transaction log exists but is only consulted by the user-action handler.
- **Why it exists:** CSS rollback was the original design; structural ops were added later and the failure path was not updated to undo them.
- **User impact:** Silent permanent structural data loss of page content on any failed transform that used a `remove` op. The user has no way to know the DOM was mutated (only `markFailed` sets a dataset attr).
- **Reproduction:** Force a transform that emits a `remove` op on a cluster, then fail the hard gate (e.g. via an overflow). Observe: the removed element is gone, CSS is stripped, page marked failed.
- **Recommended solution:** Make the failure path call `txnLog.undoAll` before `removeStyleEverywhere`.
- **Confidence:** HIGH.

---

## RC4 — Sticky roles guaranteed but they churn (and stay stale)

- **Symptom:** The roadmap (product.md P5) claims "Sticky role cache: classify once per handle per session, reuse on every pass. Role stability 1.000." Yet roles churn on mutation and stay stale across SPA routes.
- **Evidence:** `clearRoleCache` (`perceive:466`) is exported but **has ZERO callers** (grep-confirmed). `structuralPath` (`perceive:407`) truncates at depth 10 (`:440`) and anchor-search 20 (`:412`) → handle collisions and churn on deep custom-element trees.
- **Root cause:** **Identity is derived from a bounded path, not a globally-unique structural fingerprint**, and the cache is never invalidated. The system is simultaneously too sticky (wrong role persists across SPA routes) and too churny (truncated path collides on mutation).
- **Why it exists:** The cache was built for stability (P5.2) but the invalidation hook was never wired; the path truncation was a perf optimization that undermined uniqueness.
- **User impact:** After an SPA route change, clusters carry the previous route's roles until a full reload. After a mutation, handles collide → wrong clusters styled.
- **Reproduction:** On an SPA, transform route A, navigate to route B (no reload), transform — observe route-A roles persist. Insert a sibling, re-perceive — observe handle churn.
- **Recommended solution:** Call `clearRoleCache` in `handleRouteChange`/`reapplyStored`. Lengthen or hash the structural path without truncation; or anchor identity on a globally-stable attribute set.
- **Resolution (S10.3b):** `clearRoleCache` is now called in `handleRouteChange` (line 1331) and `reapplyStored` (line 1163) in content.ts. Roles refresh on SPA navigation and stored-design reapplication.
- **Confidence:** HIGH → RESOLVED.

---

## RC5 — Hard gates go green but the page barely changed (DPI mismatch)

- **Symptom:** Step 7 of the roadmap placed only 2/29 nodes on MDN yet the gates went green. Step 8 retroactively invalidated every earlier pixel number (product.md S8).
- **Evidence:** `product.md` S8: "the Step-7 pixelAudit DPI diagnosis (device pixels vs CSS pixels) was excellent and retroactively INVALIDATES every earlier pixel-gate number." The class of bug recurs in `verify/capture.ts` — DPI is not normalized; `verify/pixel.ts:350` `variance` returns 765 for out-of-bounds rects.
- **Root cause:** **Two coordinate systems were never reconciled** — pixelAudit measured at device-pixel resolution but built in CSS pixels. `capture.ts` downscale + `Math.round` on sub-pixel rects compounds it.
- **Why it exists:** Pixel work was added without a coordinate-normalization step; the downscale-to-`window.innerWidth` was a partial fix.
- **User impact:** False-positive invisible-text on high-DPI screens; false-negative voids; gates that pass on a no-op redesign.
- **Reproduction:** Run a transform on a high-DPI display with small fonts; observe false invisible-text flags.
- **Recommended solution:** Normalize DPI in `capture.ts`; add a `captureFailed` flag so a broken capture can't report PASS.
- **Confidence:** HIGH (for the historical bug), MEDIUM (for the residual `capture.ts` DPI issue — needs a runtime test).

---

## RC6 — Undo crashes / half-undoes after a framework re-render

- **Symptom:** After an SPA re-render (React/Turbo/MediaWiki), the user hits Toggle to undo → a `NotFoundError` aborts mid-replay → half the ops reversed, half not.
- **Evidence:** `ops/transaction.ts:23-25` `OpInverse` holds live `Node` refs. `undoAll` (`:81`) calls `dom.insertBefore(inv.parent, inv.node, inv.nextSibling)` with **no try/catch**. If the original parent was removed by the framework, `insertBefore` throws `NotFoundError`.
- **Root cause:** **Undo assumes the DOM is stable between execute and undo.** Live node references are not valid across framework re-renders.
- **Why it exists:** The transaction log was designed for a static DOM; SPA re-render was a later realization.
- **User impact:** Undo leaves the page in a broken mixed state with no error feedback.
- **Reproduction:** On GitHub, transform, let Turbo re-render, hit Toggle — observe a `NotFoundError` and partial undo.
- **Recommended solution:** Wrap `undoAll` in try/catch; resolve inverses by handle (re-query) rather than live ref; or record a structural snapshot for re-resolution.
- **Confidence:** HIGH.

---

## RC7 — Retries silently re-bill, defeating the one-shot mandate

- **Symptom:** The user sees "1 call" while 5 HTTP requests were billed to Cloudflare.
- **Evidence:** `reason/index.ts:281` `while(true)`: 429/≥500 → up to `maxTransientRetries=4` (`config:69`) → 5 billed requests; `transient` never returned. `popup/main.ts:111` shows `paidCalls ?? 1` (counts *roles*, not requests).
- **Root cause:** **The retry loop and the cost counter measure different things** (HTTP requests vs roles); the retry budget is invisible.
- **Why it exists:** `paidCalls` was repurposed as "observability, not a gate" (`config:47-50`) when the one-shot mandate proved impossible (2 parallel calls + critic).
- **User impact:** Unexpected Cloudflare billing; misleading UI.
- **Reproduction:** Force a 429 (rate-limit the account), run a transform, observe the popup shows "1 call" while logs show 5 requests.
- **Recommended solution:** Surface HTTP-request count (including retries) to the popup; or enforce a true request budget.
- **Confidence:** HIGH.

---

## RC8 — The "Save key" UI is dead; no real user can authenticate

- **Symptom:** Every real user who sets a key via the popup gets `invalid_key` on Transform.
- **Evidence:** `popup/main.ts:25,30` read/write `openai_api_key`; `background.ts:36` reads `cloudflare_account_id`/`cloudflare_api_token`. The saved key is never read.
- **Root cause:** **The credential UI was not updated when the backend switched from OpenAI to Cloudflare.** The popup and background read different storage keys.
- **Why it exists:** `background.ts:31` comment: OpenAI "disabled in favor of Cloudflare Workers AI, kept for easy revert" — the popup was left on the old key.
- **User impact:** The product has no working credential path for a real user (only the test harness injects Cloudflare creds).
- **Reproduction:** Set a key in the popup, run a transform → `invalid_key`.
- **Recommended solution:** Wire the popup to the real Cloudflare keys (or add a settings UI for Cloudflare creds).
- **Confidence:** HIGH.

---

## RC9 — `display:contents` causes content loss on mixed proxies

- **Symptom:** Absolute children reposition; button click targets shrink; overflow clipping lost; contentIntact gate fails on all sites.
- **Evidence:** `solve.ts:515` emitted `display: contents` on mixed proxies. A proxy with `position:relative` → absolute children lose their containing block; a `<button>`/`<a>` → padding click-target gone; `overflow:hidden` → clipping lost. The `[data-wm-c]` region on the proxy vanished from the contentIntact fingerprint → false gate failures on all 3 sites (Step 9: 22/45/63 calls per site).
- **Root cause:** **`display:contents` dissolves the box** — it preserves the *children* but not the box's *positioning, clipping, and hit-testing* properties. The CSS-only grid approach needs to flatten intermediates; `display:contents` was chosen without modeling its box-dissolution side effects.
- **Why it exists:** The CSS-only grid approach needs to flatten intermediates; `display:contents` was chosen without modeling its box-dissolution side effects.
- **User impact:** Overlapping/repositioned absolute elements; unclickable padded areas; content spilling out of clipped containers; contentIntact gate false-positives on every mixed proxy.
- **Reproduction:** Transform a page with a positioned relative container holding absolute children that spans >1 slot.
- **Resolution (S10.1):** Replaced `display:contents` with CSS subgrid: `display: grid; grid-template-columns: subgrid; grid-column: 1 / -1; min-width: 0`. The box survives — background, border, padding, containing block, clipping and click targets all intact — and children participate in the NCA's column tracks. Fallback: if `CSS.supports('grid-template-columns', 'subgrid')` is false, the proxy is placed as a full-width grid item (`grid-column: 1 / -1`) without dissolving its box.
- **Measured result (S10.4):** contentIntact=**true** on ALL 3 sites (MDN, Wikipedia, GitHub) — was false on all 3 in Step 9. Subgrid proxy counts: MDN 22, Wikipedia 44, GitHub 63. MDN passes ALL 10 hard gates.
- **Confidence:** HIGH → RESOLVED.

---

## RC10 — Capture failure reports a PASS

- **Symptom:** If `captureVisibleTab` fails at all 3 scroll positions, the pixel gate reports `passed:true` with empty lists.
- **Evidence:** `verify/capture.ts` returns 0-size `PixelInput` on `img.onerror`. `verify/pixel.ts:350` `if (sampled === 0) return 765` (max variance) → `detectVoids` (variance<10) and `detectInvisibleText` (variance<15) both skip → no problems found.
- **Root cause:** **A failed capture is indistinguishable from a clean capture** — there is no `captureFailed` flag in `PixelVerifyResult`.
- **Why it exists:** The pixel detector treats "no samples" as "no problems" by defensive default.
- **User impact:** A redesign that breaks visuals passes the pixel gate if the screenshot fails (tab not focused, SW capture error).
- **Reproduction:** Unfocus the tab mid-transform (or force a capture error), observe the gate passes.
- **Resolution (S10.3a):** Added `captureFailed: boolean` to `PixelVerifyResult`. `pixelVerify` now detects 0-size captures and sets `captureFailed=true`; `passed` requires `!captureFailed`. content.ts treats `captureFailed` as a HARD gate — it appears in the v2HardGates expression, the regression guard (p1Gates/p2Gates), and the failure list.
- **Confidence:** HIGH → RESOLVED.

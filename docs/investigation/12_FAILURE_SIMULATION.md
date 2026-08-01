# 12 — Failure Simulation

> Hostile-environment scenarios. Each: What happens · Why · What breaks · Recovery · Root cause.
> Speculation is marked **UNVERIFIED**.

---

## F1 — Huge DOM (100K nodes, e.g. Gmail/Figma)
- **What happens:** `perceive()` walks the DOM; at `:241` `if (performance.now() - t0 > MAX_TIME_MS || depth > MAX_DEPTH) return;` triggers at the 6s cap (and/or depth 30).
- **Why:** `MAX_TIME_MS=6000`, `MAX_DEPTH=30` are silent caps with no `truncated` flag.
- **What breaks:** abandoned subtrees have no clusters/handles → the redesign applies only to the visited portion → silent partial redesign. `verifyStyle`'s 8-10 full-tree scans on the visited 200 clusters are still multi-hundred-ms of reflow.
- **Recovery:** none — the run proceeds as if perception was complete; the user sees a redesign of part of the page.
- **Root cause:** `perceive:241` caps without a `truncated` flag; no gate refuses a partial perception.

## F2 — Heavy animations / constant mutations
- **What happens:** `waitForSettle` (`perceive:1129`) waits for a 500ms quiet window (6000ms ceiling). A page that never stops animating → perception fires at the 6s ceiling on a still-mutating DOM.
- **Why:** the settle condition can't distinguish "still loading" from "perpetually animating".
- **What breaks:** `walk` captures `el` refs; a re-render during enrichment leaves detached refs → `getComputedStyle(detached)` returns empty defaults, `getBoundingClientRect` returns zeros → wrong layout facts propagate with no error (no try/catch, `perceive:566,811`). The `startDefense` observer may fire continuously on a mutating page → re-insert loop.
- **Recovery:** none mid-run; the hard gate may catch the resulting breakage and roll back CSS (but not DOM ops — RC3).
- **Root cause:** perception assumes a quiescent DOM; no handling for perpetual mutation.

## F3 — Rapid SPA navigation
- **What happens:** `handleRouteChange` (`content.ts:1330`) debounces 500ms, hooks `pushState`/`replaceState`/`popstate`/`hashchange`. It calls `stopDynamicDefense()` then `await reapplyStored()`.
- **Why:** between stop and re-arm, the page mutates unobserved.
- **What breaks:** guaranteed flash of unstyled content on every SPA nav. `clearRoleCache` is never called → stale roles from route A persist on route B (RC4). Fast nav may leave `inFlight` set → route change ignored (`:1331`).
- **Recovery:** `reapplyStored` re-perceives and re-applies — but with stale roles and a partial re-perceive.
- **Root cause:** `clearRoleCache` has no callers; the route hook doesn't cover all SPA nav styles (Turbo morphs).

## F4 — Turbo morph (GitHub) — no route event
- **What happens:** `turbo:load` reuses DOM nodes without `pushState` → no re-perceive.
- **Why:** only `pushState`/`replaceState`/`popstate`/`hashchange` are hooked (`content.ts:1546`).
- **What breaks:** `data-wm-c` stamps sit on recycled nodes; `txnLog` inverses reference recycled node objects → on undo, `insertBefore(inv.parent, inv.node, inv.nextSibling)` throws `NotFoundError` (RC6) → `undoAll` has no try/catch → half-undone broken page.
- **Recovery:** none — the user must reload the page (losing the transform).
- **Root cause:** undo holds live `Node` refs; Turbo morph invalidates them.

## F5 — Iframe nesting / cross-origin iframes
- **What happens:** `perceive:22` doesn't list IFRAME in IGNORED_TAGS, but `.children` is empty for cross-origin; same-origin `contentDocument` is not traversed.
- **Why:** no `contentDocument` traversal.
- **What breaks:** iframes are bare `<iframe>` clusters → `ad-or-void`. A container around an iframe isn't excluded → solver relayouts around it → can break iframe sizing.
- **Recovery:** the iframe content is untouched (good); the surrounding layout may break.
- **Root cause:** no composed-document traversal.

## F6 — Network failure / AI timeout
- **What happens:** `reason/index.ts` fetch fails or exceeds the per-call timeout (`architectTimeoutMs:70000`, `painterTimeoutMs:90000`).
- **Why:** no global 120s abort; per-call only.
- **What breaks:** a single role's failure → `Promise.all` rejects → `runStyle` catch → `{ok:false}`, `wallMs:0` (telemetry zeroed). If the SW is killed mid-fetch, the `sendMessage` callback never fires → 120s frozen spinner (`content.ts:1129`).
- **Recovery:** the user can retry (no cancel button). DOM ops already executed (if any) are NOT undone (RC3).
- **Root cause:** no global AbortController; keepalive is best-effort; no op rollback on failure.

## F7 — Partial AI response
- **What happens:** `reason:331` `JSON.parse(response)` succeeds but the JSON is incomplete (missing intents or malformed `packOverrides`).
- **Why:** `validateSpec` (`spec:197`) checks enums and "intents OR rules" but a spec of hallucinated roles passes.
- **What breaks:** hallucinated roles → empty rules (`expand:174`) → canvas-only CSS → the coverage gate (`MIN_MODEL_COVERAGE_FRACTION=0.40`) fails after a wasted paint+verify cycle.
- **Recovery:** the hard gate fails → CSS rolled back (DOM ops not — RC3).
- **Root cause:** no hallucination prevention at the spec layer.

## F8 — Extension reload mid-run
- **What happens:** the service worker restarts; the content script's port disconnects.
- **Why:** MV3 SW lifecycle.
- **What breaks:** the in-flight `sendMessage` never resolves → 120s hang. `chrome.storage.local` survives → on next interaction `reapplyStored` re-applies.
- **Recovery:** partial — stored state re-applies, but `applyInlineBackstop` is NOT re-run on reload (`reapplyStored:1196`) → invisible text on reload.
- **Root cause:** the reload path doesn't re-run the inline backstop.

## F9 — Permission revoked / host_permissions denied
- **What happens:** `chrome.runtime.sendMessage` to the content script fails ("Could not establish connection").
- **Why:** the content script isn't injected (permission denied for the origin).
- **What breaks:** the popup hangs (no listener) → harness 130s timeout (`wxt.config.ts:14-19` comment). No graceful "permission denied" message.
- **Recovery:** none in-product.
- **Root cause:** no permission-state check before messaging.

## F10 — Tab suspended (MV3 tab discarding)
- **What happens:** the content script is gone; the tab is discarded.
- **Why:** MV3 discards inactive tabs under memory pressure.
- **What breaks:** on revival, the page reloads; WebMorph's listener must re-register. **UNVERIFIED** whether suspended-then-revived tabs reliably re-inject the content script.
- **Recovery:** stored state re-applies on next user action — if the content script re-injects.
- **Root cause:** reliance on content-script lifecycle.

## F11 — Low memory / slow CPU
- **What happens:** `verifyStyle`'s reflow storms are amplified; `startDefense` re-insert loops starve the main thread.
- **Why:** no circuit breakers; no perf budgets.
- **What breaks:** the transform may exceed the ~145s worst case; the page janks; the user sees a frozen UI.
- **Recovery:** timeout → CSS rollback (DOM ops not — RC3).
- **Root cause:** no product-level breakers; `verifyStyle` is the hot path.

## F12 — Slow browser / browser restart
- **What happens:** the service worker cold-starts; Cloudflare creds must be re-read from storage.
- **Why:** MV3 SW is ephemeral.
- **What breaks:** if creds were never set (dead auth UI, RC8), the run fails `invalid_key` immediately.
- **Recovery:** none for a real user.
- **Root cause:** dead auth UI.

## F13 — A site strips `<style>` on an interval
- **What happens:** `startDefense` (`execute:62`) re-inserts the style on each removal → unbounded loop.
- **Why:** no debounce, no circuit breaker.
- **What breaks:** a forced reflow each cycle → CPU bomb; the page becomes unresponsive.
- **Recovery:** none — the loop runs until the tab is closed.
- **Root cause:** no re-insert cap.

## F14 — A capture failure at all 3 scroll positions
- **What happens:** `verify/capture.ts` returns 0-size `PixelInput`; `pixel.ts:350` returns variance 765.
- **Why:** a failed capture is indistinguishable from a clean capture.
- **What breaks:** `pixelVerify` returns `passed:true` with empty lists → a redesign that broke visuals passes the pixel gate (RC10).
- **Recovery:** the structural hard gate (`verifyStyle`) may still catch it; the pixel gate does not.
- **Root cause:** no `captureFailed` flag.

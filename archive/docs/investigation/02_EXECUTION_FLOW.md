# 02 — Execution Flow

> Complete execution flow from user click to DOM mutation, with message flow and ASCII sequence diagrams.
> Every step cites `file:line`. Speculation is marked **UNVERIFIED**.

## High-level sequence (happy path, v1)

```
USER                POPUP               CONTENT SCRIPT          BACKGROUND            AI (Cloudflare)
 │                   │                      │                      │                      │
 │─ type prompt ────►│                      │                      │                      │
 │─ click Transform ►│                      │                      │                      │
 │                   │── sendMessage ──────►│                      │                      │
 │                   │  {action:'transform' │                      │                      │
 │                   │   , intent}          │                      │                      │
 │                   │                      │─ if(inFlight) DROP   │                      │
 │                   │                      │  else runStyle()      │                      │
 │                   │                      │─ clearHandles()       │                      │
 │                   │                      │─ perceive() ─────────│─────────────────────►│ (DOM walk,
 │                   │                      │  (stamp data-rv-c,    │                      │  no network)
 │                   │                      │   role-classify)      │                      │
 │                   │                      │─ captureLayoutFinger │                      │
 │                   │                      │  print() [before]    │                      │
 │                   │                      │─ connect() keepalive ─►│                    │
 │                   │                      │─ askForSpec(architect)─►│── fetch ────────────►│
 │                   │                      │─ askForSpec(painter) ──►│── fetch (parallel) ─►│ ← PAID ×2
 │                   │                      │  ◄──── StyleSpec ──────│◄──── response ───────│
 │                   │                      │─ compileSpec()        │                      │
 │                   │                      │  (expand→packs→laws)  │                      │
 │                   │                      │─ applyStyleEverywhere │                      │
 │                   │                      │  + applyInlineBackstop│                      │
 │                   │                      │─ verifyStyle()        │                      │
 │                   │                      │  (hard gates)         │                      │
 │                   │                      │─ captureAndPixelVerify┼► captureVisibleTab ──►│
 │                   │                      │  ◄──── pixel result ──│                      │
 │                   │                      │─ planRepair()         │                      │
 │                   │                      │  (forceContrast or    │                      │
 │                   │                      │   critic reReason)    │── fetch ─────────────►│ ← PAID ×1 (on fail)
 │                   │                      │─ [gate FAIL?] ──────── │                      │
 │                   │                      │   yes→removeStyle    │                      │
 │                   │      (DOM ops NOT    │   (NO undoAll!)      │                      │
 │                   │       undone — RC3)  │                       │                      │
 │                   │                      │─ [pass] persist      │                      │
 │                   │                      │─ startDefense        │                      │
 │                   │◄──── outcome ─────────│                      │                      │
 │                   │  {ok, applied, ...}  │                      │                      │
 │◄─ show status ────│                      │                      │                      │
```

## Step-by-step (with file:line)

1. **User clicks Transform** — `popup/main.ts:129` `chrome.tabs.sendMessage(tabId, {action:'transform', intent})`.
2. **Content script receives** — `content.ts:1557` `chrome.runtime.onMessage`. **If a transform is already running (`inFlight`), the message is dropped silently** (`content.ts:1559` falls through with no `return`/`sendResponse`) → the popup's callback never fires → popup hangs. **No "busy" reply.**
3. **Run wrapper** — `content.ts:1580` `runner = runStyle(...)` with `.catch` (swallows stack, returns `wallMs:0` → telemetry zeroed on crash) and `.finally` (clears `inFlight`).
4. **In-flight flag + keepalive** — `content.ts:406` sets `revueonRunInFlight = Date.now()` (persists forever if the tab crashes — no TTL) and `chrome.runtime.connect()` to keep the service worker alive (`background.ts:27` empty `onConnect` handler).
5. **Clear + perceive** — `content.ts:446` `clearHandles()` then `perceive()` (`perceive/index.ts:230`). Walks the live DOM up to depth 30 / 6s (`perceive:241`), clusters boxes, stamps `data-rv-c` (`perceive:523`), enriches layout/semantic, role-classifies. **Shadow-DOM resolution gap here — see `05_DOM_PIPELINE.md`.**
6. **Before-fingerprint** — `content.ts:462` `captureLayoutFingerprint()` (`perceive:920`) — the baseline regions for delta gates (overflow/collapse).
7. **v2 layout path** (if `layoutCompiler==='v2'`) — `content.ts:529` `extractLayoutIR` → `:533` `assignSlots` → `:550` `solve` → `:551` `computeGridPlacementCss`. (v1 skips this.)
8. **AI calls (parallel, paid)** — `content.ts:738` `Promise.all([askForSpec('architect'), askForSpec('painter')])`. Each routes through `background.ts:29` → `chrome.storage.local.get(['cloudflare_account_id','cloudflare_api_token'])` (`background.ts:36`) → `reason/index.ts` POST to Cloudflare. **This is ≥2 paid calls, violating the "one-shot" mandate — see `06_AI_PIPELINE.md`.**
9. **Compile** — `content.ts:853` `compileSpec(spec)` → `expandIntents` (`compile/expand.ts`) → `resolvePack` (`design/packs.ts`) → `buildDeclarations` (`capabilities/style`) → laws (`core/laws`).
10. **Apply CSS** — `content.ts:858` `applyStyleEverywhere(css)` (`execute/index.ts:19`) injects/updates `<style id=revueon-style>` in `<head>` and every open shadow root; `applyInlineBackstop` sets inline `!important` bg+text on contrast-failing clusters.
11. **Verify** — `content.ts:873` `verifyStyle(...)` (`verify/index.ts:79`). **8-10 full-tree `querySelectorAll([data-rv-c])` scans + 3 forced reflows + per-sample parent-chain `getComputedStyle` walks — see `10_PERFORMANCE_ANALYSIS.md`.**
12. **Pixel verify** — `content.ts:223` `captureAndPixelVerify` → `background.ts:55` `captureVisibleTab` → `verify/capture.ts` decode → `verify/pixel.ts` void/invisible/squeeze detectors. **A capture failure at all 3 scroll positions returns `passed:true` (0-size → variance 765 → "no problems").**
13. **Repair decision** — `content.ts:910` `planRepair` (`repair/index.ts`). Routes to: `forceContrast`/`squeeze` (free deterministic), `reReason` critic (paid, only if `canReReason()`), or `keepBest`. **`bestNonBroken` is dead code — see `06_AI_PIPELINE.md`.**
14. **Failure → rollback CSS only** — `content.ts:913` (hard gate fail), `:954` (paint2 broke), `:983` (repair broke), `:924` (time budget): all call `removeStyleEverywhere(...)` **but never `txnLog.undoAll`** → structural DOM ops executed at step 10b (below) are NOT undone. **RC3 — silent permanent structural data loss.**
15. **Paint 2** — `content.ts:969` the `else` branch recomputes `batchedOpts` and calls `applyOnce` again. **A `keepBest` decision (options = prev) triggers a redundant paint-2 with identical options → wasted paint (H8).**
16. **Persist** — `content.ts:1039` reads live `<style>` textContent as authoritative CSS (racy — defense not armed yet), `:1042` saves spec+CSS+opts to `chrome.storage.local` via `persist/index.ts`.
17. **Arm defense** — `content.ts:1047` `startDefenseEverywhere` (`execute/index.ts:62`) arms a MutationObserver that re-inserts the `<style>` if the site removes it. **No circuit breaker — a style-stripping site causes an unbounded re-insert loop.**
18. **Dynamic defense** — `content.ts:1272` `startDynamicDefense` re-styles on site mutations, re-perceives on bursts. Shadow observers accumulate (`content.ts:1289`).
19. **Return outcome** — `content.ts` resolves `{ok, applied, changeScore, paidCalls, ...}` to the popup.

### v1 structural ops (when present)
Some v1 specs emit `ops` (move/remove/reorder/wrap). These execute **before** verify:
- `content.ts:797` `executeOps(validated, true)` — mutates live DOM, `txnLog` records inverses (`ops/transaction.ts:56`).
- Because ops run before verify, a gate failure leaves them applied (step 14 does not undo them).

## Undo / Toggle / Remove flow

```
USER ──click Toggle──► POPUP ──sendMessage({action:'toggle'})──► CONTENT
                                                                │
                                              ┌─────────────────▼──────────────────┐
                                              │ toggleSiteState() (content.ts)       │
                                              │  if applied → undoOpsAndCss()        │
                                              │   ├─ txnLog.undoAll(liveDom)         │  replays inverse ops BACKWARDS
                                              │   ├─ removeStyleEverywhere()         │  (holds live Node refs —
                                              │   └─ removeEscapeUI()                │   breaks after SPA re-render)
                                              │  else → reapplyStored()              │
                                              │   ├─ perceive()                      │
                                              │   ├─ validateOps + executeOps         │
                                              │   ├─ compile + applyStyle            │
                                              │   └─ startDefense                    │
                                              └──────────────────────────────────────┘
```
**Critical:** `undoOpsAndCss` (`content.ts:1225`) is the *only* caller of `txnLog.undoAll`. The **failure** path (step 14) does NOT call it. So failure and undo are two different code paths — see `08_ROOT_CAUSE_ANALYSIS.md` RC3.

## SPA navigation flow

```
SITE ──pushState/replaceState/popstate/hashchange──► content.ts handleRouteChange()
                                                       │
                                                       ├─ if(inFlight) return   (route change ignored mid-run)
                                                       ├─ stopDynamicDefense()  (clears restyleTimer)
                                                       ├─ debounce 500ms
                                                       └─ await reapplyStored()
                                                            ├─ perceive() (re-stamps handles)
                                                            ├─ validateOps + executeOps
                                                            ├─ compile + applyStyle
                                                            └─ startDynamicDefense()
```
**Gap:** only `pushState`/`replaceState`/`popstate`/`hashchange` are hooked (`content.ts:1546`). **Turbo `turbo:load` morphs reuse DOM nodes without `pushState`** → no re-perceive → `data-rv-c` stamps sit on recycled nodes → `txnLog` inverses reference recycled nodes → undo replays against wrong nodes (see `12_FAILURE_SIMULATION.md`).

## Fast paths (gate bypass)

`hide` / `move` / `restyle` intents short-circuit:
- `fastHidePath` (`content.ts:1373`) and `fastMovePath` (`content.ts:1444`) **never call `verifyStyle` or `pixelVerify`** — they apply CSS and persist directly. A `hide` that matches `main`/`article` is blocked only by `hideRefusal` inside `compileSpec`. A sticky header that introduces new region overlaps is never checked. **The "all-or-nothing" rule is unenforced on fast paths.**

## Lifecycle: extension reload / tab suspend

- **Extension reload:** the service worker restarts; `chrome.storage.local` survives (spec+CSS+opts). On next interaction, `reapplyStored` re-applies. But **`applyInlineBackstop` is NOT re-run on reload** (`reapplyStored:1196` never calls it) → clusters needing the inline `!important` bg/text pair revert to invisible text after a reload. *(verified)*
- **Tab suspend (MV3 tab discarding):** the content script is gone. On revival, the page reloads; Revueon's `onMessage` listener must re-register. Stored state is re-applied on the next user action. **UNVERIFIED:** whether suspended-then-revived tabs reliably re-inject the content script.
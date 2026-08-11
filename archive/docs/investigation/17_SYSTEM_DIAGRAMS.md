# 17 — System Diagrams

> ASCII diagrams: architecture, message flow, DOM pipeline, AI pipeline, extension lifecycle, module relationships.

## 1. Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          BROWSER (Chrome MV3)                            │
│                                                                          │
│  ┌────────────┐   ┌───────────────────────────────────────────────────┐  │
│  │   POPUP     │   │  CONTENT SCRIPT  (entrypoints/content.ts)         │  │
│  │ (popup/     │   │  ┌──────┐ ┌─────┐ ┌──────┐ ┌─────┐ ┌──────┐        │  │
│  │  main.ts)   │──►│  │perce-│→│lay- │→│reas- │→│comp-│→│verify│        │  │
│  │ prompt +   │   │  │ive  │ │out  │ │on(AI│ │ile  │ │gates │        │  │
│  │ Transform/  │   │  └──────┘ └─────┘ └──┬───┘ └─────┘ └──┬───┘        │  │
│  │ Toggle/Rem  │   │       │            │              │      │ repair │  │
│  └────────────┘   │  ┌────▼────┐  ┌─────▼────┐  ┌──────▼──┐ └───┬────┘  │  │
│                   │  │ execute │  │ backgrnd │  │ persist  │   ops       │  │
│                   │  │ (style) │  │ relay    │  │ storage  │  ┌──▼───┐    │  │
│                   │  └────┬────┘  └────┬─────┘  └──────────┘  │txnLog│    │  │
│                   │       │            │                     └──────┘    │  │
│                   └───────┼────────────┼─────────────────────────────────┘  │
│                           │            │                                    │
│                  ┌────────▼────────────▼────────────┐                       │
│                  │  BACKGROUND (service worker)      │                       │
│                  │  entrypoints/background.ts         │                       │
│                  │  - holds Cloudflare creds           │                       │
│                  │  - relays AI calls                  │                       │
│                  │  - captureVisibleTab                │                       │
│                  └────────────────────┬───────────────┘                       │
│                                       │                                       │
│                  ┌────────────────────▼──────────────┐                        │
│                  │  Cloudflare Workers AI             │                       │
│                  │  api.cloudflare.com (3rd party)     │                       │
│                  └────────────────────────────────────┘                       │
└──────────────────────────────────────────────────────────────────────────────┘
                          LIVE WEB PAGE (DOM)
```

## 2. Message flow

```
popup ──chrome.tabs.sendMessage({action:'transform',intent})──► content.ts onMessage
                                                                 │
                                       ┌─────────────────────────┴───┐
                                       │ if(inFlight) DROP silently  │ (no busy reply → popup hangs)
                                       │ else runStyle()              │
                                       └─────────────────────────┬───┘
                                                                 │
content ──chrome.runtime.connect()──────────────────────────────► background onConnect (keepalive)
content ──chrome.runtime.sendMessage({action:'styleSpec',role})─► background onMessage
                                       │ chrome.storage.local.get(cloudflare_*)
                                       │ reason/index.ts fetch ─────────► Cloudflare AI
                                       ◄──── StyleSpec ────────────────
content ──chrome.runtime.sendMessage({action:'captureVisibleTab'})► background
                                       │ chrome.tabs.captureVisibleTab
                                       ◄──── PNG dataUrl ──────────────
content ──(internal)──► undo/restore ──► {action:'toggle'} from popup
```

## 3. DOM pipeline (perceive → apply → verify → undo)

```
       LIVE DOM
          │
   ┌──────▼───────────────────────────────┐
   │ perceive()  (perceive/index.ts)       │
   │  walk(depth≤30, 6s cap)               │
   │   └─ descend open shadow roots        │  ◄── STAMPS shadow children
   │  cluster → stamp data-rv-c            │
   │  enrich(role/semantic/layout)         │
   │  serialize → text                     │
   └──────┬───────────────────────────────┘
          │  Perception
   ┌──────▼───────────┐  (v2 only)
   │ extractLayoutIR   │  → assignSlots → solve → computeGridPlacementCss
   └──────┬───────────┘
          │
   ┌──────▼───────────────────────────────┐
   │ compile (expand→packs→laws)           │
   │  CSS string keyed on data-rv-c        │  ◄── 100% of v1 CSS
   └──────┬───────────────────────────────┘
          │
   ┌──────▼───────────────────────────────┐
   │ execute/applyStyleEverywhere          │
   │  <style id=revueon-style>.textContent│  (head + shadow roots)
   │  applyInlineBackstop (inline !imp)    │  ◄── NOT re-applied on reload
   │  executeOps (v1: move/remove/reorder) │  ◄── BEFORE verify (RC3)
   │  txnLog records inverses              │
   └──────┬───────────────────────────────┘
          │
   ┌──────▼───────────────────────────────┐
   │ verifyStyle + pixelVerify             │  ◄── 8-10 scans + 3 reflows
   │  hard gates                           │
   └──────┬───────────────────────────────┘
          │
     ┌────┴────┐
   FAIL       PASS
     │          │
 removeStyle  persist + startDefense
 (DOM ops     (MutationObserver arms)
  NOT       startDynamicDefense
  undone!)  ──on SPA nav──► reapplyStored
     │
   [RC3: permanent structural data loss]
```

## 4. AI pipeline

```
   intent (user)  +  Perception (serialized page text)
          │                    │
          └─────────┬──────────┘
                    ▼
   ┌─────────────────────────────────────────────────┐
   │ reason/index.ts:265  prompt assembly             │
   │ "USER REQUEST: <intent>\n\nRUNTIME PAGE          │
   │  PERCEPTION:\n<perception>"                      │  ◄── page text leaves machine
   └────────────────┬────────────────────────────────┘
                    │  (roles: architect + painter PARALLEL)
   ┌────────────────▼────────────────────────────────┐
   │ background.ts → fetch api.cloudflare.com        │
   │  - retries 429/5xx up to 4× (5 billed, hidden)   │
   │  - 400 on response_format → drop + retry (billed)│
   │  - 429 Retry-After header IGNORED                │
   └────────────────┬────────────────────────────────┘
                    │  StyleSpec JSON
   ┌────────────────▼────────────────────────────────┐
   │ validateSpec  (hallucinated roles PASS)          │
   │ mergeSpecs (architect + painter)                 │
   └────────────────┬────────────────────────────────┘
                    │  (on paint-1 FAIL)
   ┌────────────────▼────────────────────────────────┐
   │ critic (reReason) — PAID  ◄── bestNonBroken DEAD │
   └────────────────┬────────────────────────────────┘
                    │
   ┌────────────────▼────────────────────────────────┐
   │ expandIntents → resolvePack → buildDeclarations │
   │  (packOverrides UNVALIDATED)                     │
   └─────────────────────────────────────────────────┘
```

## 5. Extension lifecycle

```
   Extension installed/loaded
            │
   ┌────────▼──────────────────────────────────────┐
   │ Service worker (background.ts) — EPHEMERAL     │
   │  onConnect (keepalive, empty handler)          │
   │  onMessage (styleSpec, captureVisibleTab)       │
   └────────┬──────────────────────────────────────┘
            │ (SW killed after ~30s idle, or on memory pressure
            │  even with a keepalive port — RC: 120s hang)
   ┌────────▼──────────────────────────────────────┐
   │ Content script injected per page (on match)    │
   │  onMessage listener registers                   │
   │  ──── RUN ────►                                  │
   │   revueonRunInFlight flag (persists if crash)  │
   │   perceive → reason → compile → verify → apply  │
   │   ──── persist (chrome.storage.local) ────►     │
   │   startDefense (MutationObserver)               │
   │   handleRouteChange (pushState/popstate/...)     │
   └────────────────────────────────────────────────┘
            │
   ┌────────▼──────────────────────────────────────┐
   │ RELOAD / SPA NAV                                │
   │  reapplyStored (re-perceive, re-apply)           │
   │  ⚠ applyInlineBackstop NOT re-run → invisible  │
   └────────────────────────────────────────────────┘
```

## 6. Module relationships

```
                    popup/main.ts
                         │ sendMessage
                         ▼
                 content.ts (orchestrator)
                  │  │  │  │  │  │
        ┌─────────┘  │  │  │  │  └──────────┐
        ▼            ▼  ▼  ▼  ▼             ▼
   perceive/      reason  layout/   verify/   repair/   execute/
   index.ts       index   solve.ts  index.ts  index.ts  index.ts
     │  └semantic  │        │  │       │  │      │        │
     │             │        │  │       │  └pixel │        │
     │             │        │  └assign │   └capture       │
     │             │        │     │     │                   │
     ▼             ▼        ▼     ▼     ▼                   ▼
   perceive/    spec/      ir.ts  documentation.ts      ops/
   semantic    index.ts                                  transaction.ts
                                                        sanitize/index.ts
                                                        capabilities/
                                                          style,structure
                                                        persist/index.ts
                                                        config/laws
                                                        design/packs
                                                        compile/expand
                                                        compile/index

   background.ts ◄── content (sendMessage) ──► Cloudflare AI
```

### Dependency edges (key)
- `content.ts` → `perceive`, `reason`(via background), `compile`, `verify`, `repair`, `execute`, `ops`, `transaction`, `persist`, `layout/*`.
- `perceive/index.ts` → `perceive/semantic.ts`, `laws`, `design/packs`, `shared/color`.
- `layout/solve.ts` → `layout/ir.ts`, `layout/assign.ts`, `languages/documentation.ts` (and **duplicates** `perceive`'s `structuralPath`).
- `reason/index.ts` → `spec/index.ts`, `config/index.ts`.
- `execute/index.ts` → `laws` (STYLE_ELEMENT_ID).
- `verify/index.ts` → `perceive` (captureLayoutFingerprint, findPrimaryContentNode), `laws`, `shared/color`, `compile/expand`.
- `repair/index.ts` → `laws`, types (`bestNonBroken` imported by `content.ts` but **never called**).
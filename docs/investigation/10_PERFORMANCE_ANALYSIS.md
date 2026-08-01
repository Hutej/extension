# 10 — Performance Analysis

> Bottlenecks: memory, DOM, layout, paint, AI, CPU, network.
> Every claim cites `file:line`. Speculation is marked **UNVERIFIED**.

## 1. The dominant cost: `verifyStyle` layout thrashing

`verify/index.ts:79` `verifyStyle` is the single biggest performance hazard. Per call, it triggers:

**From `captureLayoutFingerprint` (`perceive:920-959`):**
- `querySelectorAll([data-wm-c])` + `getBoundingClientRect` + `getComputedStyle` per region (cap 200, `:928`).
- `querySelectorAll('h1,h2,h3,h4,p,li,a,button')` + `getComputedStyle` (`:944-947`).
- A second full `querySelectorAll([data-wm-c])` + `getBoundingClientRect` for column detection (`:949-953`).
- `computeOverlapCount` (`perceive:1000`): a third `querySelectorAll` + `getBoundingClientRect` + **O(n²)** pairwise overlap (cap 18 regions → 153 comparisons, `:1010`).
- `countTextBleeds` (`perceive:987`): a fourth `querySelectorAll` + `getComputedStyle` + `scrollWidth` per element.
- `document.documentElement.scrollWidth` (`perceive:958`) — a forced reflow.

**From `verifyStyle` itself, after the fingerprint:**
- `findPrimaryContentNode` (`:84`) → `getBoundingClientRect` (`:87`).
- `querySelectorAll([data-wm-c])` + `getBoundingClientRect` + `getComputedStyle(.opacity)` for `contentVisible` (`:123-128`).
- `querySelectorAll([data-wm-c])` + `getComputedStyle` + `getBoundingClientRect` per moved handle (`:140-147`).
- `scrollWidth` read (`:153`) — a **second forced reflow**.
- `measureAccentAreaFraction` (`:206→504`): `querySelectorAll` + `getComputedStyle` + `getBoundingClientRect` per cluster.
- `measureFramedClusterFraction` (`:207→535`): `querySelectorAll` + `getComputedStyle` per cluster.
- `findOverflowTargets` (`:229→296`): `querySelectorAll` + `getBoundingClientRect` per cluster.
- `findBleedTargets` (`:230→317`): `querySelectorAll` + `getComputedStyle` + `clientWidth` + `scrollWidth` per cluster — `scrollWidth` **forces reflow per element**.
- `findSqueezeTargets` (`:231→341`): `querySelectorAll` + `getComputedStyle` + `clientWidth`/`clientHeight` per cluster.
- `checkContrast` (`:175→554`): `querySelectorAll` + `getComputedStyle(.fontSize)` per rep, then per sampled rep: `getBoundingClientRect` + `getComputedStyle(.color)` + `effectiveBackground` (`:613` — walks the parent chain calling `getComputedStyle` per ancestor, **unbounded depth**) + `gradientStopsInChain` (`:632` — walks up to 12 ancestors).

**Total per `verifyStyle` call:** ~8-10 full-tree `querySelectorAll([data-wm-c])` scans, ~3 forced reflows, and an **unbounded parent-chain `getComputedStyle` walk per contrast sample** with **O(depth²) recursion** (`effectiveBackground` recurses for every semi-transparent ancestor, no memoization). A pathological 20-deep transparent stack → 210 `getComputedStyle` calls for one sample × `CONTRAST_SAMPLE_COUNT`.

**Frequency:** runs **2-3× per transform** (paint1, paint2, regression guard). On a 200-cluster page this is multi-hundred-ms of reflow — it eats the 120s budget, not the model.

## 2. `perceive` forced reflows

- `getBoundingClientRect` + `getComputedStyle` on every visited element (`perceive:246,261`).
- The representative is re-resolved via `document.querySelector` **3× per cluster** (`findScrollables:376`, `enrichSemantic:815`, `detectGrouping:864`), each with fresh `getBoundingClientRect`.
- `resolveVarMap` (`:1071`): for each exotic-color var, `createElement` + `appendChild` + `getComputedStyle` + `remove` → a forced reflow per var. Tailwind v4 (oklch default) → dozens of reflows.

## 3. `computeGridPlacementCss` (v2)

- `nearestCommonAncestor` (`solve:310`): builds a `Set<HTMLElement>` per element by walking to null (`:312-317`), then `chains.every(c => c.has(n))` per ancestor (`:321`) → **O(N²×D)** for N placed elements at depth D. 200 × 20 = 800K set lookups, no early termination.
- `contentsEls.includes(candidate)` (`:436`) and `fullWidthEls.indexOf(el)` twice (`:529-530`) → O(n²) scans.

## 4. `startDefense` unbounded loop

`execute:62-73` — a site that strips unknown `<style>` on an interval → unbounded remove→re-insert loop, **forced reflow each cycle**, no debounce/circuit breaker → CPU bomb on a hostile site.

## 5. Double perceive (v2)

`content.ts:1163` perceive, then `:1193` perceive again after `executeOps` → wasted tax on every v2 reload.

## 6. AI / network

- **v1 painter payload ~30K+ chars** (S4.1 measured; v2 trimmed to ~9K, 70% reduction — v1 unchanged).
- **Retries silently multiply requests:** up to 5 per role (`reason:281`), plus a 400-retry path → billed but unaccounted.
- `DEBUG=true` (`config:86`) logs the full intents array as JSON (`content.ts:770`) → console spam in production.

## 7. Memory

- `txnLog` (`content.ts:127`) — module singleton; cleared at the start of a new transform. One transform's ops (could be 200+) hold live `Node` refs.
- `activeOps` reassigned each transform — old array GC'd if no closure holds it.
- **Shadow observers accumulate** (`content.ts:1289-1293`) — pushed during the dynamic scan, but `activeShadowRoots` is reassigned from fresh perception (`:1252`) → the pushed root's observer is orphaned → observer leak until the next stop.
- **`shadowDynamicObservers`** disconnected on `stopDynamicDefense`, but a removed shadow host's observer keeps running until the next transform.
- **UNVERIFIED:** long-term memory growth across many transforms on one tab (no explicit cap on cumulative observer/transaction state).

## 8. Paint

- `captureAndPixelVerify` does a **3-scroll-position sweep** (`content.ts:211`): `scrollTo(0, h*0)`, `scrollTo(0, h*0.5)`, `scrollTo(0, h*0.8)`, each with 2× `requestAnimationFrame` then `captureVisibleTab` → 3 PNG decodes + 3 canvas draws + 3 pixel sweeps. `scrollTo(0,0)` at `:222` resets scroll **without saving/restoring the user's position**.
- `detectRecolor` (`pixel:160`) downscales to `RECOLOR_W=64`; `variance` samples every 4th pixel → on a 1280px-wide canvas, ~320 samples/row.

## 9. Layout / reflow summary

| Operation | Location | Cost |
|---|---|---|
| Per-element rect+style | `perceive:246,261` | O(n) reads, no caching |
| Rep re-resolved 3×/cluster | `perceive:376,815,864` | 3× redundant querySelector |
| `resolveVarMap` per-var reflow | `perceive:1071` | dozens on Tailwind v4 |
| `verifyStyle` full-tree scans | `verify:79` | 8-10 × querySelectorAll |
| `verifyStyle` forced reflows | `verify:153` + `perceive:958` | 3× per call |
| `effectiveBackground` recursion | `verify:613` | O(depth²) getComputedStyle |
| `nearestCommonAncestor` | `solve:310` | O(N²×D) |
| `startDefense` re-insert loop | `execute:62` | unbounded on hostile site |

## 10. CPU vs model latency

- The roadmap reports Painter wall-clock of 17-90s for the **same** payload (`product.md` S5.2) — model latency is the dominant wall-clock variable and is **external** (not a code issue).
- `verifyStyle` reflow is the dominant **internal** CPU cost; on large pages it can exceed the per-call model timeout.
- `config:52` `designMaxMs:120_000` is documented as the hard abort but only `canReReason()` consumes it → worst case ~145s (RC: no global abort).

## UNVERIFIED
- Actual wall-clock breakdown on a 100K-node page (needs a profile run).
- `chrome.storage.local` write latency for large specs (persist path).

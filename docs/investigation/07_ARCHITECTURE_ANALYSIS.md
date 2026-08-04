# 07 — Architecture Analysis

> Architectural strengths, weaknesses, coupling, scalability, design flaws.
> Every claim cites `file:line`. Speculation is marked **UNVERIFIED**.

## The claimed rule (and how it leaks)

`docs/ARCHITECTURE.md:9-11` and `product.md:9-13` state the one architectural rule:
> The AI is responsible for design decisions, the Layout IR is responsible for expressing structure, the solver is responsible for satisfying constraints, and the compiler is responsible for generating CSS. No layer is allowed to take over another layer's responsibility.

**In practice the layers leak:**
- **AI → compiler leak:** the model emits `packOverrides` (a design decision) that `resolvePack` (`design/packs.ts:189`) spreads **unvalidated** → value corruption. The compiler's responsibility (CSS) is fed unvalidated design inputs.
- **Solver → compiler leak:** `mergeConstraints` (`solve.ts:137`) computes `impossibleNodes` (a constraint responsibility) but `computeGridPlacementCss` never reads it → impossible constraints are silently placed → last-by-specificity wins. The solver's validation is theater.
- **Verifier → redesign leak:** `checkConformance` (`verify/index.ts:712`) computes constructive scores but is **log-only** → the verifier "confirms" but also produces design feedback that nothing acts on.
- **Model assigns priority?** The rule says the model NEVER assigns priority; priority is `law > language > intent`. This holds in the constraint schema (`ir.ts` priority field), but `packOverrides` (model-emitted) silently overrides spacing/typography (a `language`/`preferred` concern) → a priority leak via the pack path.

## Architectural strengths

1. **The hard-gate *concept*** (`verify/index.ts:79`) — overflow, clipping, hidden content, overlap, reading-order — is sound. Measuring against a `before` fingerprint with deltas (so pre-existing floats never false-fail) is a good design.
2. **The deterministic expander/compile/laws layer** is well-disciplined: pure functions, allowlisted properties, contrast lock, fluidize, sanitize. The intent DSL (model emits intents, not raw CSS) is the right contract.
3. **The fluid-token set** (`ARCHITECTURE.md:123-130`) — `clamp()`-based viewport-relative type/spacing — is the correct approach to zoom-hostility.
4. **The exclusion-registry *idea*** (`exclusions.ts`) — principled detection (no hostnames) of JS-controlled subtrees — is right in principle, though the heuristics miss modern libraries.
5. **The v2 CSS-only-grid direction** (Step 7) is the correct escape from the SPA-re-render trap that killed v1 DOM reparenting. Moving from `applySlotWrappers` (DOM moves) to `display:grid` + `display:contents` (CSS only) avoids triggering framework MutationObservers. **(Caveat: it still calls `setAttribute`, and `display:contents` has its own content-loss issues.)**
6. **Record/replay fixtures** (`RV_FIXTURES`, `content.ts:1099`) — test-only, dead-branched in production — let layout code be tested without paying the model. Good testing architecture.

## Architectural weaknesses

### W1 — Identity = one injected attribute (single point of failure)
The whole product rests on `data-rv-c` (`perceive:503`) surviving framework re-renders. The MutationObserver defender (`execute:62`) is the only backstop. v2 swaps to `data-rv-grid`/`buildSelector` — **same class of dependency on an injected attribute**. If the defender misses a node (shadow timing, `display:none` subtree, attribute-observing framework), that node is permanently unstyled → the "all-or-nothing" rule fails.

### W2 — Perception is the source of truth but is partial, time-bounded, and flat-tree-resolved
- 6s/depth-30 cap silently truncates (`perceive:241`) with no `truncated` flag.
- Shadow content is stamped-then-unresolvable (`:819`).
- Geometry is viewport-coupled (`semantic:99-102`).
Every downstream stage trusts a perception that can be partial and wrong.

### W3 — No composed-tree model
The deepest root cause (RC1): the architecture never modeled shadow DOM / the composed tree. `walk` descends; read-back doesn't. **One missing `composedPath`/`deepSelector` abstraction breaks every web-component site** — the exact targets the roadmap names (YouTube).

### W4 — Two rollback paths
CSS rollback (failure, `content.ts:913`) vs DOM-ops undo (user action, `:1225`) are **different code paths** → failed transforms leave the DOM mutated (RC3).

### W5 — CSS-only relayout can't fix structural misorder
Grid auto-places rows in DOM order; `order`/`grid-area` are banned for a11y (`solve:34-36`). A footer-first DOM template renders the footer above main, and the redesign **cannot correct it**. A fundamental limitation of the "reading order inviolable + CSS-only" combination.

### W6 — v1/v2 fork is sprinkled, not separated
> **UPDATE (BUILD SWEEP 1F — convergence):** RESOLVED by deletion. The v1/v2 fork is gone; there is
> now ONE pipeline and the `layoutCompiler` flag is deleted. This weakness described the codebase at
> investigation time, not the current architecture.
`ARCHITECTURE.md:17` says "the pipeline forks once; no shared mutable state, no conditionals sprinkled through compile." But `content.ts` is full of `if (v2)`/`if (layoutCompiler==='v2')` branches. The two paths ARE intertwined in the orchestrator.

### W7 — No circuit breakers in product loops
`startDefense` re-insert loop (`execute:62`), retry re-billing (`reason:281`), and the fix-cycle cap (harness-only, `product.md` S9.6) have no product-level breakers. A hostile site can cause unbounded CPU/billing.

### W8 — Observability is honest for v1, fabricated for v2
`content.ts:716-722` the v2 ledger hardcodes `compileMs:0, pixelVerifyMs:0, persistMs:0, unaccountedMs:0`. v1 (`:1060-1074`) computes real stage times. **v2 perf regression hunting is blind.**

## Coupling

- **`content.ts` is a 1603-line god orchestrator** coupled to every `core/*` module. The v1/v2 fork, message handling, observers, undo, persistence, and capture relay all live here. High hidden coupling; hard to test in isolation.
- **`buildSelector` (solve) duplicates `structuralPath` (perceive)** — two copies of fragile identity logic with different joiners (` > ` vs `/`). Divergence is a silent targeting bug.
- **`hash` is duplicated** (`perceive:1482` fixed, `semantic:390` unfixed) — the same bug class fixed in one place, live in another.
- **Identity coupling:** the model emits handles; the expander/compile/solve all resolve them via `data-rv-c`/`data-rv-grid`. A change to the handle format touches the prompt, the validator, the expander, and the selector builder.

## Scalability

| Site class | Predicted outcome | Why |
|---|---|---|
| Gmail | partial redesign | 6s cap truncates dense DOM; `width:100%` over-exclusion skips flex items |
| Figma | partial + map misfire | canvas excluded; dense UI hits MAX_DEPTH/MAX_TIME; canvas wheel handlers misclassified |
| Notion | orphaned blocks | `contenteditable` excluded; block chrome isn't; nested trees exceed depth 30 |
| YouTube | **no redesign** | shadow-DOM resolution gap → feed = voids (verified) |
| Reddit | scroll breaks | infinite-scroll virtualization missed by `isVirtualized` |
| GitHub | undo breakage | Turbo morph re-renders → `data-rv-c` on recycled nodes → undo replays wrong nodes |
| Google Docs | partial | `contenteditable` excluded; dense UI → 6s cap |
| 100K-node page | silent partial redesign | 6s truncation, no flag |

## Design flaws

1. **`sourceOrder` is prominence order, mislabeled as document order** (`perceive:515` → `ir:165`). The "reading order inviolable" guarantee trusts a mislabeled value.
2. **`deepFreeze` doesn't freeze Maps** (`ir:211`) — the immutability contract is runtime-false for the primary lookup.
3. **`page-title`→masthead** (`documentation.ts:38`) — rips in-article h1 to the top row.
4. **`assignSlots` `excluded` param dead** (`assign.ts:26`) — misleading API.
5. **`isJsControlledLayout` over-excludes** (`exclusions.ts:116`) — `width:100%` excluded.
6. **`MIN_DEPTH`/`MAX_TIME` silent truncation** (`perceive:241`).
7. **`DEBUG=true` ships** (`config:86`) — page content in production console.

## UNVERIFIED
- Whether `checkConformance`'s log-only scores are ever read by the critic prompt (would need to trace `critiqueFor` inputs fully).
- Long-term memory growth across many transforms on one tab (observers + transaction log).

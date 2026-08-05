# 14 — Technical Debt

> Accumulated debt, dead code, drift, and untested invariants. Evidence cited as `file:line`.

## Dead code (verified)
- **`bestNonBroken`** (`repair:260`) — imported `content.ts:20`, never called. The "keep best non-broken attempt" guarantee is unenforced. S9.5 fixed the inverted condition (`if (a.contentIntact) continue;` → `if (!a.contentIntact) continue;`) but the function is DEAD CODE — it has zero callers. The fix had zero blast radius (no caller was affected). The import and function remain as dead code.
- **`sanitizeMarkup`** (`sanitize/index.ts`) — defined, never called in the apply path.
- **`clearRoleCache`** (`perceive:466`) — ✅ RESOLVED (S10.3b): now called in `handleRouteChange` and `reapplyStored` in content.ts. No longer dead code.
- **`assignSlots` `excluded` param** (`assign.ts:26`) — never referenced in the body; excluded nodes pollute `slotToHandles`.
- **`mergeConstraints` validation** (`solve.ts:137`) — `impossibleNodes` computed but `computeGridPlacementCss` never reads it.
- **Invariant guards** (`assign.ts:37-49`) — defensive dead code that cannot fire.
- **`openai_api_key` path** (`popup/main.ts:25`) — the popup reads/writes a key the background never reads.

## Duplicated logic (drift risk)
- **`buildSelector` (`solve:241-286`) duplicates `structuralPath` (`perceive:407-451`)** — two copies of fragile identity logic with different joiners (` > ` vs `/`). A change to one without the other silently targets the wrong element. **BUILD SWEEP 1E partially resolved**: `perceive/index.ts` now has `buildCssSelector` (CSS-valid version) stored as `cluster.structuralSelector`, used by both v1 compile and v2 solve. The structuralPath (for handle hashing) and buildSelector (in solve.ts) remain separate but share the same anchor logic.
- **`hash` is duplicated** — `perceive:1482` (fixed, modulo `2176782336`) vs `semantic:390` (unfixed `.slice(-6)`). The same bug class fixed in one place, live in another.

## Doc drift
- **`solve.ts:23`** claims "data-rv-c is a DEBUG label only; nothing in emitted CSS depends on it" — **BUILD SWEEP 1E RESOLVED for v1**: the compile path now uses `structuralSelector` as primary, with `[data-rv-c]` as a genuine fallback. The `selectorFallbackCount` in the compile result tracks how often the fallback fires. v2 already had this (buildSelector in solve.ts). The claim is now TRUE for both paths.
- **`expand.ts:104`** comment says 5-char handles; code uses 6 (`:108`, `spec:510`).
- **`ARCHITECTURE.md`** says hard gates = 6; `verify/index.ts` exposes 13 booleans; v2 uses 11 (`v2HardGates` since S9.4 added squeeze, S10.3a added captureFailed, S11.3 added planHonoured); the count was 6/7/9/10/11 across docs — now reconciled to 11 everywhere (S11.7).
- **`--rv-step-1`** deleted token referenced in docs.
- **`ir.ts` field comment** says `sourceOrder` is "DOM document-order index" — it is prominence order (`perceive:515`).

## Untested invariants
- **The `wxt.config.ts` env define-invariant** — every `process.env.RV_*` referenced in `config/index.ts` must be listed in `wxt.config.ts:21-30` or the content script bricks (`process is not defined` → no listener → "Cannot reach the page"). No compile-time test asserts this. A contributor adding `process.env.RV_MODEL_STYLE` silently bricks every build.
- **Gate semantics** — the hard-gate count and `v2HardGates` membership drift; no test pins the definition.
- **`chrome.storage.local` quota** on large specs (`persist`) — UNVERIFIED.
- **Fixture mode leak to production** (`content.ts:1099` `RV_FIXTURES`) — only build-time-gated; no runtime assertion that `FIXTURE_MODE==='off'` in a production build. A dev build accidentally promoted → stale canned designs, no model call.

## Architectural debt
- **~~v1 is still the default; v2 is behind a flag~~** — **BUILD SWEEP 1F RESOLVED**: the v1/v2 fork is DELETED; there is now ONE pipeline and the `layoutCompiler` flag is gone. This item described the codebase at investigation time.
- **Three "loosenings" were reverted in Step 9** (overflow-x:auto, contentsHandles exemption, overflow-wrap) — the codebase has a history of gaming gates.
- **~~v1/v2 fork is sprinkled through `content.ts`~~** — **BUILD SWEEP 1F RESOLVED**: the fork is deleted; the sprinkled `if (v2)` branches are gone with it. Historical only.
- **`content.ts` is a 1603-line god orchestrator** coupled to every `core/*` module. → **BUILD SWEEP 1G
  PARTIALLY RESOLVED**: content.ts split to 1218 lines (6 implementation blocks extracted to modules).
  Still above the ~800-line target — the remaining bulk is orchestration (runStyleImpl), fast-path
  runners, listeners, SPA navigation. The entrypoint is significantly thinner but not yet a pure
  wiring file.
- **`transform.ts` 742-line switch** — **BUILD SWEEP 1G RESOLVED**: split to 412 lines with 9
  relation-domain modules. The dispatcher iterates relations in original order (order-sensitive
  accent budget + style merge preserved).
- **131 orphan-export warnings** — **BUILD SWEEP 1G H3 target**: every one gets a verdict (wired
  up or deleted), no informational tier. After triage, the audit fails on any new orphan.
- **Two rollback paths** (CSS rollback on failure vs DOM-ops undo on user action) — the failure path doesn't undo ops (RC3).
- **No circuit breakers** in product loops (`startDefense` re-insert, retry re-billing); the fix-cycle cap exists only in the harness (`product.md` S9.6).

## Historical context (from `product.md`)
- The `bestNonBroken` inverted-condition bug (S9.5) "invalidates every repair fallback selection from Step 7 onward" — but the function is dead, so the blast radius is contained.
- Step 8 retroactively invalidated every earlier pixel-gate number (DPI mismatch).
- The gate count/semantics drift (6 vs 7 vs 9 vs 10) was only reconciled in S8.6 with `v2HardGates`.

## UNVERIFIED
- The Playwright harness (`project/tests/`) was not read deeply; the "fix-cycle cap = 3 across ALL gates" claim rests on `product.md`, not the harness source.

## BUILD SWEEP 1H — closed and opened

### Closed by 1H
- **One layout language (the over-perceive/under-transform root cause)** — the engine shipped exactly ONE language (documentation); every page landed in documentation slots; "make this a dashboard/bento/magazine" was inexpressible. 1H adds six languages as data + documentation as fallback; the model CHOOSES from a 3–5 candidate shortlist.
- **ConstraintPriority assigned in 7 places, read in NONE** — `droppedOptionals` was always `[]`; no relaxation logic existed. 1H adds `resolveNodeConstraints` (the `.priority` read site) in `solve.ts`: relaxes the lowest-priority on a width-axis conflict, records every relaxation, reports required-vs-required as unsatisfiable. Browser-free unit test in `tests/relaxation.test.ts`.
- **Colour-coverage invisible-text** — the coverage loop assigned `pack.colors.text` to every addressed cluster with no explicit colour, skipping only clusters that set a background; a cluster inheriting a LIGHT bg got a light pack text (invisible). 1H guards behind `contrastRatio(packText, cluster.background.effectiveColor) >= MIN_CONTRAST_RATIO` (the single law constant).
- **`!reflowSkipped` hard gate** — retired. Sidebar→topbar reflow is now expressible as language + archetype + assignSlot; archetype conformance carries it. Two mechanisms for one job was how the vocabulary drifted apart.
- **Architect fallback indistinguishable from a bad design** — 1G raised reasoning_effort to 'medium' (130s) but left ceilings at 70s/120s, so the Architect aborted on most runs. 1H reverts to 'low' and makes the fallback loud: `architectFallback: true` on `TransformOutcome` + the ledger.
- **Conformance zero-applicable = pass** — a restyle-only run with no relations passed all checks. 1H makes conformance three counts (applicable/not-applicable/pass); zero-applicable is "nothing was declared", `ok: false`.

### Opened by 1H (new debt)
- **`checkStructuralConformance` is browser-bound and not yet wired into the production pipeline.** It carries `applicable?` on each `ConformanceCheck` so the three counts are computable when it is called, but its consumer is the site-tested sweep (it needs `getComputedStyle` + `[data-rv-plan-slot]` proxies). The live three-count conformance today is `checkConformance` (CSS-parse-based, browser-free). Wiring the structural check is the next sweep's work.
- **The full 46-relation golden emission test was not built this sweep.** Constructing a faithful synthetic perception fixture + a valid spec statement for each of the 46 relations is a dedicated effort. The standing `audit:wiring` structural check (handler presence + composition emission-path) remains the coverage gate; it was not downgraded. A per-relation execution test against a synthetic fixture is the next sweep's work.
- **The 46 test-only-export verdicts were not individually triaged this sweep.** `audit:wiring` already FAILS on orphan runtime exports (no informational tier), so the standing gate holds. A dedicated per-export verdict (wired into production vs deleted) is deferred.
- **`resolveNodeConstraints` only detects width-axis conflicts** (`FillParent` vs `MaxWidth`). Other axis pairs (e.g. alignment vs stacking) are treated as non-conflicting and coexist. This is honest for the conflicts that actually arise today; extending the conflict catalogue is additive when a real conflict surface appears.

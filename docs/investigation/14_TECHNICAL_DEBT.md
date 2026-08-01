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
- **`buildSelector` (`solve:241-286`) duplicates `structuralPath` (`perceive:407-451`)** — two copies of fragile identity logic with different joiners (` > ` vs `/`). A change to one without the other silently targets the wrong element.
- **`hash` is duplicated** — `perceive:1482` (fixed, modulo `2176782336`) vs `semantic:390` (unfixed `.slice(-6)`). The same bug class fixed in one place, live in another.

## Doc drift
- **`solve.ts:23`** claims "data-wm-c is a DEBUG label only; nothing in emitted CSS depends on it" — **false for v1** (100% of v1 CSS is keyed on `data-wm-c`, `perceive:503`).
- **`expand.ts:104`** comment says 5-char handles; code uses 6 (`:108`, `spec:510`).
- **`ARCHITECTURE.md`** says hard gates = 6; `verify/index.ts` exposes 13 booleans; v2 uses 10 (`v2HardGates` since S9.4 added squeeze + S10.3a added captureFailed); the count was 6/7/9/10 across docs — now reconciled to 10 everywhere (S10.5).
- **`--wm-step-1`** deleted token referenced in docs.
- **`ir.ts` field comment** says `sourceOrder` is "DOM document-order index" — it is prominence order (`perceive:515`).

## Untested invariants
- **The `wxt.config.ts` env define-invariant** — every `process.env.WM_*` referenced in `config/index.ts` must be listed in `wxt.config.ts:21-30` or the content script bricks (`process is not defined` → no listener → "Cannot reach the page"). No compile-time test asserts this. A contributor adding `process.env.WM_MODEL_STYLE` silently bricks every build.
- **Gate semantics** — the hard-gate count and `v2HardGates` membership drift; no test pins the definition.
- **`chrome.storage.local` quota** on large specs (`persist`) — UNVERIFIED.
- **Fixture mode leak to production** (`content.ts:1099` `WM_FIXTURES`) — only build-time-gated; no runtime assertion that `FIXTURE_MODE==='off'` in a production build. A dev build accidentally promoted → stale canned designs, no model call.

## Architectural debt
- **v1 is still the default; v2 is behind a flag with fabricated telemetry** (`content.ts:716-722` zeros) → can't trust v2 metrics.
- **Three "loosenings" were reverted in Step 9** (overflow-x:auto, contentsHandles exemption, overflow-wrap) — the codebase has a history of gaming gates.
- **v1/v2 fork is sprinkled through `content.ts`** despite `ARCHITECTURE.md:17` claiming "the pipeline forks once; no conditionals sprinkled through compile." The two paths ARE intertwined in the orchestrator.
- **`content.ts` is a 1603-line god orchestrator** coupled to every `core/*` module.
- **Two rollback paths** (CSS rollback on failure vs DOM-ops undo on user action) — the failure path doesn't undo ops (RC3).
- **No circuit breakers** in product loops (`startDefense` re-insert, retry re-billing); the fix-cycle cap exists only in the harness (`product.md` S9.6).

## Historical context (from `product.md`)
- The `bestNonBroken` inverted-condition bug (S9.5) "invalidates every repair fallback selection from Step 7 onward" — but the function is dead, so the blast radius is contained.
- Step 8 retroactively invalidated every earlier pixel-gate number (DPI mismatch).
- The gate count/semantics drift (6 vs 7 vs 9 vs 10) was only reconciled in S8.6 with `v2HardGates`.

## UNVERIFIED
- The Playwright harness (`project/tests/`) was not read deeply; the "fix-cycle cap = 3 across ALL gates" claim rests on `product.md`, not the harness source.

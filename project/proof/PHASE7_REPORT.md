# PHASE 7 REPORT — Responsive-CSS Dominance Gate (Law 6 enforcement)

**Date:** 27 Aug 2026
**Phase:** 7 — the surviving hard law: *a transformation must survive a window resize.*
**Verification basis:** TEXT / CODE / terminal output only. No image input. (The configured model does not accept images; per project rules no screenshot was sent to a vision model.)

---

## What Phase 7 is

Law 6 / rule 6 is the one surviving hard law from the deleted pipeline: *"No length measured off the live page is ever written back into it. A transformation must survive a window resize."* For three months the project had no enforcement of it. Phase 7 ports the senior-advice CSS-count diagnostic into a **pre-mutation gate** on `applyCss`: if the CSS the model authored is *dominated* by fixed-pixel layout signals, refuse it before any mutation so the model retries with responsive CSS.

This is **not** a ban on `px`. `px` is legitimate for borders, spacing, typography, shadows, radii. The gate counts `px` only on the properties that fix **layout geometry** — width/height, the min/max sizing props, the four offsets, inset, and `position:absolute|fixed`. A colour/typography-only restyle has zero fixed-layout signals and passes.

---

## What shipped

| Artifact | Lines | Role |
|---|---|---|
| `project/src/core/responsive.ts` | 142 | Pure validator: `countResponsiveSignals` + `fixedPxDominates`. Counts fixed-px layout vs responsive signals; recurses into `@media`/`@supports`. |
| `project/src/tools/act.ts` | +19 | `applyCss` calls `fixedPxDominates(items)` **before** `emitAndInsert` — pre-mutation refuse (nothing to roll back). Error names the offending properties + the alternatives (rule 13). |
| `project/src/agent/prompt.ts` | +2 | Instructs the model to author responsive CSS (Flexbox/Grid/%/fr/auto/minmax/clamp/fit-content/aspect-ratio; px fine for borders/spacing/typography). |
| `project/tests/responsive-css-test.ts` | 216 | Pure counting-logic proof: 11 checks (deliberate FAIL + PASS + GUARD + 2 EDGE + CONTROL). |
| `project/tests/responsive-realsite-check.ts` | 97 | Static real-site check against baked-in MDN measurements. |
| `project/tests/resize-gate-test.ts` | 239 | Real-Playwright resize gate (1440→320, 7 widths) — the P4 invariance proof. (Predates Phase 7; re-run here as the behavioural backstop.) |

**Scope of the gate:** `applyCss` only. `hide` / `heal` / `insert` / `setText` do **not** author arbitrary restyle CSS (`display:none` / derived container style / sanitized HTML), so the gate does not apply to them. Confirmed: `fixedPxDominates` has exactly one call site (`act.ts:256`).

---

## What is proven — with real numbers

All numbers from fresh runs this session (27 Aug 2026), not from stored JSON.

### 1. `responsive-css-test.ts` — the counting logic (pure, no browser)
**11/11 pass. 0.10 s wall clock. exit 0.**

- ✓ **Deliberate FAIL:** a fixed-px layout (`position:absolute` + fixed `width`/`height`/`top`/`left`) **is refused** — fixed=11 > responsive=0. (P15: the failing case is demonstrated actually failing.)
- ✓ The refusal **names position AND a sizing/offset property** — an actionable error (rule 13), not a log line.
- ✓ Fixed genuinely **dominates** (fixedCount > responsiveCount, fixedCount ≥ 1).
- ✓ **PASS:** the responsive equivalent (flex + `%` + `max-width:60ch` + gap + `clamp()`) accepted — fixed=1, responsive=5.
- ✓ **GUARD:** px on borders/spacing/typography/shadows/radii only → **not refused**, fixedCount=0. (The instruction's "do NOT ban all px" is honoured.)
- ✓ **EDGE:** a responsive grid with one fixed `min-width:240px` track passes (responsive dominates fixed).
- ✓ **EDGE:** responsive signals inside `@media` are counted (recursion reaches inner declarations).
- ✓ **EDGE:** fixed px inside `@media` is counted as fixed (recursion does not skip at-rules).
- ✓ **CONTROL:** a colour-only restyle passes (no layout signals to dominate).

### 2. `responsive-realsite-check.ts` — MDN real-site, no false refusal
**3/3 pass. 0.08 s wall clock. exit 0.**

- ✓ A responsive readability restyle (`max-width:70ch`, `clamp()`, `line-height`, `em`) of MDN's `main.layout__content` is **accepted** — fixed=0, responsive=2. No false refusal on legitimate CSS.
- ✓ A fixed-px restyle (`width:1265px` measured off the live page) is **refused** — fixed=3 > responsive=0.
- ✓ The measured MDN page does not overflow (scrollWidth 1265 ≤ clientWidth 1280) — the restyle targets a genuinely responsive page, the case where a false refusal would be most damaging.

### 3. `resize-gate-test.ts` — real-Playwright resize (the behavioural backstop)
**4/4 pass. 14.18 s wall clock. exit 0.** Real Chromium, real `setViewportSize`, 7 widths (1440/1024/768/600/480/380/320).

- ✓ **CONTROL:** responsive page, no new violations on a no-op.
- ✓ **PASS:** a responsive (ratio/token) transform introduces no new breakage at any width.
- ✓ **Deliberate FAIL:** a fixed-px transform (`width:900px`) fine at 1440 **is caught** overflowing at 768/600/480/380/320.
- ✓ **Deliberate FAIL:** a collapse transform (`width:5px`) is caught (blank/squeeze) at every width.

### 4. Typecheck + adjacent drift
- `tsc --noEmit`: **exit 0** (wiring compiles; `responsive.ts` imports against the real `EmitItem` shape).
- `budget-reserve-test.ts` (adjacent file modified in this working tree): **9/9 pass** — the off-by-one drift in the JSON detail lines (`12000`→`11999`, added `12001` boundary) is cosmetic; the arithmetic the test asserts is intact.

---

## What failed

**Nothing failed.** All Phase 7 tests pass on fresh runs; typecheck is clean. No check went red this session.

---

## What I did NOT build / did NOT verify (named explicitly)

1. **No live agent run with the gate wired.** The real-site check uses **baked-in** MDN measurements (scrollWidth 1265 / clientWidth 1280) from a prior agent-browser probe. Those numbers were not re-measured live this session, and no end-to-end agent request ("increase spacing" etc.) was run against the production path with the gate active. The gate is proven at the unit + static-real-site + Playwright-resize level, not at the live-agent level.

2. **No image verification.** Two PNG artifacts exist in the working tree — `proof/phase7-qa/mdn-restyled-1280.png` and a stray `--full-page` (a 1280×577 PNG, apparently a `--full-page` screenshot flag whose output was redirected to a file named `--full-page`). Per project rules and the model's input limits, **no screenshot was sent to a vision model and none was inspected**. I cannot confirm what either image shows. They are **unverified artifacts**, not proof. (Per F7, an unverified run is a failed run — these two images do not count as visual verification of anything.)

3. **The MVP corpus (7 rows) was not re-run with the gate in place.** Rows 5 (HN "increase spacing") and 7 (resize after) are the ones most directly relevant to Law 6 and remain unverified against the wired gate this session.

4. **No new capability.** Phase 7 adds a gate + a prompt instruction, not a tool. Consistent with rule 2 (no module named after an operation) and the foundation-first order.

---

## Known ceiling (honest limitation of the gate)

The gate is a **dominance count**, not a per-declaration veto. The rule is "fixed *dominates* responsive → refuse," deliberately so that a fluid grid with one legitimate fixed `min-width` track passes (the `MIXED_RESPONSIVE` edge proves this). The ceiling: **a single catastrophic fixed-px declaration that does not dominate the count** — e.g. one `width:900px` amid many responsive declarations where the responsive count wins — would pass the gate and could still break on resize. The `resize-gate-test.ts` behavioural backstop exists precisely to catch that class at the harness level. Marked as a known heuristic ceiling, not a bug.

---

## Uncommitted state

None of Phase 7 is committed. Working-tree changes: `responsive.ts` (new), `responsive-css-test.ts` + `responsive-realsite-check.ts` (new), `act.ts` (+19), `prompt.ts` (+2), the three proof JSONs, plus unrelated drift in `CLAUDE.md` (+image-input rule), `budget-reserve-test.json`, `resize-gate-test.json`, `resize-gate-test.ts`, and the two unverified PNGs. A commit was not made — the project reports commits only when asked.

---

## Bottom line

Phase 7 is **verified at the unit, static-real-site, and Playwright-resize levels, all green on fresh runs** (11 + 3 + 4 checks; 0.10 s + 0.08 s + 14.18 s; tsc exit 0). The gate is real, wired, pre-mutation, scoped to `applyCss`, and honours "do not ban px." It is **not** verified at the live-agent level this session, and the two PNG artifacts in the tree are unverified and count for nothing.

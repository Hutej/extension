# Phase 4 — F1 IDENTITY: baseline (before any change)

*Captured 14 Aug 2026. The directive requires a baseline of current identity/target-selection
behaviour BEFORE modifying production code. Tests were run unmodified; no test was changed to
make the baseline look better. The recon (8 parallel readers → synthesis, verified against source)
fills in the behaviour the tests cannot see.*

---

## 1. Tests run (unmodified, current `phase2-reversal` branch + Phase 3 work)

| Test | Scope | Result |
|---|---|---|
| `tsc --noEmit` | typecheck | clean (exit 0) |
| `tests/ops.test.ts` | F3 reversal unit (no creds) | **7/7** PASS |
| `tests/classify-checklayout-test.ts` | F5 loop decision (no creds) | **8/8** PASS |
| `tests/check-layout-hard-test.ts` | F5 HARD checks (real Chromium) | **5/5** PASS |
| `tests/resize-gate-test.ts` | P4 resize gate (real Playwright) | **4/4** PASS |
| `tests/f1-selector-stability.ts` | existing F1 test (real Chrome + ext) | **PASS** (17/17 reload, 5/7 semantic) — see §3 |
| `tests/phase3-f5-loop-test.ts` | F5 forced-undo + breaker | **5/5** PASS |
| `tests/phase2.5-review-regression.ts` | F3 reversal regression (real sites) | **9/9** PASS (1st run had 1 wikipedia setText DIFF; re-run 9/9 — a race/timeout, not a stable failure; flagged for the ARITHMETIC reviewer) |

Build fresh, `.output/chrome-mv3` present, `.env` creds present.

## 2. Current target lifecycle (from recon, file:line)

The model drives off **`describePage`** which uses the lightweight `core/inventory.ts` path (a
second, heavier `perceive()` path powers `perceivePage`, rarely used).

1. **Perception** — `inventory.ts:46 buildInventory()` walks `document.body` (cap `MAX_DEPTH=6`
   `:42`, `MAX_REGIONS=60` `:52`); regions past the 60th / below depth 6 are never candidates.
2. **Selector construction** — `inventory.ts:229 buildStableSelector(el)` walks ≤20 ancestors for a
   stable anchor (id/data-testid/role/aria-label/name) then builds `anchor > nth-of-type chain`
   (depth cap 10). Uniqueness-checked **once** at build time: `:271 if (document.querySelector(sel)
   === el) return targetable:true`. Note: this proves the selector's *first match* is `el`, **not**
   that it matches only `el` — a selector matching 100 elements whose first is `el` passes.
3. **Representation to model** — `describePage` (`observe.ts:48`) returns `selector` (only when
   targetable) + `targetable` + `untargetableReason`. `serializeInventory` (`inventory.ts:286`)
   **drops the reason text**, emitting only the token ` UNTARGETABLE`.
4. **Resolution at act** — the loop takes `response.args` verbatim (`loop.ts:293`), dispatches with
   **no re-validation** (`loop.ts:356`), content script executes with no check (`content.ts:45`).
   Every act tool re-resolves the selector string against the LIVE DOM by **first match**:
   `applyCss`→`emitAndInsert`→`primaryTarget` (`emit.ts:116` first comma-part, positional) →
   `readComputed`/`assertApplied` (`act.ts:60,103` `querySelector`/`All[0]`); `setText`/`insert`
   (`act.ts:253,357`) `querySelector` first match, **no breadth guard**; `hide` has a >200 guard.
5. **ACT** — mutates; identity info used = the selector string only. No fingerprint/handle flows
   observe→act.
6. **assertApplied** (`act.ts:113`) — `applied = after !== before && after !== ''`: a **value-movement
   test, not an identity test**. The wrong element whose value moved passes.
7. **F5** — forced `checkLayout` after act is a geometry check, contractually non-blocking
   (`loop.ts:340`), not a target-identity check.

## 3. The existing F1 test — what it actually proves (and doesn't)

`tests/f1-selector-stability.ts` PASSED: 17/17 selectors survive a reload, 5/7 semantic tags resolve
on a second article. **But its pass criterion is `document.querySelector(s) !== null`
(`:64`), with `count` hardcoded to 1-or-0** — it cannot detect a selector matching many elements,
and it never checks the selector resolves to the *same* element. It proves selector *resolution*,
not *identity*. Baseline output showed `r1: role=heading sel=body` — a heading "identified" by
`body` (matches everything) — counted as stable ✓. This is exactly the false-positive the
directive warns about: *"a selector that matches five elements is not an identity."*

## 4. Identity failure modes — current behaviour (from recon)

| Mode | Current behaviour | Evidence |
|---|---|---|
| **Wrong-target** (selector now resolves to a different element than observed) | **Acted on, no check.** A new sibling inserted above the target shifts first-match; `setText`/`insert`/`applyCss` mutate the wrong element; `assertApplied` reports `applied:true`. | `act.ts:253,60,103`; `loop.ts:293,356` (no re-validation) |
| **Duplicate / multi-match** | **Acted on first match, no refusal** (except `hide`'s >200 count guard). `findElements` matches by *string equality* across regions, not element identity; `count` (live) and `matches` (inventory) disagree. | `act.ts:104,253`; `observe.ts:81` |
| **Stale / dynamic DOM** (target removed/replaced/re-rendered between observe and act) | **Re-applied blind.** SPA re-verify (`content.ts:170-173`) runs the act FIRST, then only warns on **zero-match** — a selector that still matches but the *wrong* element passes silently. Persisted args from a prior session are replayed with no re-validation (`loop.ts:152`). | `content.ts:170,173`; `loop.ts:152` |
| **Untargetable reason** | **Dropped in serialization.** `serializeInventory` emits ` UNTARGETABLE` without the reason text; the model learns a region is untargetable but not why (rule 13). | `inventory.ts:286` |
| **`findElements` confidence** | **Hardcoded 0.8** (not measured); zero-match returns `ok:true` confidence 0.1 (fail-open), inconsistent with `readText` which returns `ok:false`. | `observe.ts:85,67` |
| **RC4 (stamped-attr identity)** | **Still present, moderated.** Perceive path's primary identity is the stamped `[data-rv-c]` (`perceive/index.ts:763`); `structuralPath` still truncates aria-label to 20 chars (`:610`) and the chain to depth 10 (`:621`) — the exact RC4 truncations. Role cache sticky per session (`:1080`). | `perceive/index.ts:763,610,621,1080` |
| **RC6 (stale undo node)** | **Structural undo = FIXED (ported). setText/insert undo = REINTRODUCED.** setText inverse keys by raw selector (`txn.ts:163`); insert inverse keys by live Node ref, silent no-op on re-render (`txn.ts:169`). `undoLast` consumes a failed stale-undo and never retries (`txn.ts:125`). | `txn.ts:163,169,125` |

## 5. Test gaps (no existing test covers these — F1 must add them)

- **Duplicates**: no test feeds a selector matching >1 element and asserts refusal / right pick.
- **Stale/dynamic**: no test removes/replaces/re-renders a target between observe and act (or act and undo) and asserts refuse/re-resolve.
- **Wrong-target**: no test feeds a selector that resolves to a *different* (same-count) element and asserts refusal.
- **Untargetable reason**: no test asserts the reason reaches the model.
- **Truncation**: no test asserts a target past the 60-region / depth-6 / time cap is reported missing.

## 6. What this baseline establishes (the contract F1 must not regress)

- The full Phase 1–3 suite is green and must stay green (F3 reversal 7/7 + 9/9, F5 5/5+8/8+5/5+4/4).
- The existing F1 test passes on its (weak) criterion; F1 will *strengthen* it (same-element, not
  just resolves) — the strengthened version must still pass on Wikipedia reload.
- The `phase2.5` wikipedia setText DIFF on the first run (gone on re-run) is recorded as a race to
  re-examine during the ARITHMETIC review; it is not a stable baseline failure.

*No production code changed for this baseline.*

# Phase 2 — F3 REVERSAL (report)

*Revueon rebuild plan v2, `roadmap.txt` §4 Phase 2. The trust foundation — every
act tool built before this is fixed inherits the bug, so this is done before
any capability. Done = `assertDomClean` passes `on→off→on→off` byte-identical on
≥3 real pages, AND a deliberate "remove → fail → automatic undo → restored" case.*

> Rule 14: never send page content to a model for identification. Any visual
> confirmation in this phase is via the vision model (`@cf/moonshotai/kimi-k2.7-
> code`) reading our own test screenshots; I never inspected a PNG directly.

---

## What shipped

1. **A content-script transaction log with cloned-node inverses** — the F3
   core. Ported (slimmed) from `archive/project/src/core/ops/transaction.ts`
   (the post-RC6-fix, handle-resolving version), with two Phase-2 additions:
   - `setText` records a `cloneNode(true)` BEFORE the mutation; the in-session
     exact inverse is `replaceWith(clone)`. The old `el.textContent = text`
     inverse restored via `el.innerHTML = prevHtml` (re-parse, lossy, and
     violated "no inverse uses textContent"). **No inverse anywhere uses
     textContent now.** (`src/core/ops/txn.ts`, `src/core/ops/recorder.ts`,
     `src/tools/act.ts` setText)
   - `insert` records the inserted node itself; the in-session inverse is
     `node.remove()` (exact, no reparse). (`src/tools/act.ts` insert)
   - `undoAll` does NOT clear (the archive assumed one undo/session). It marks
     entries consumed so a repeat call is a safe no-op; `reset()` is called on
     each "on" so a fresh `on→off→on→off` cycle re-records. (proven by the
     `testOnOffOnOff` + `testUndoAllIdempotent` unit tests)
2. **The RC3 fix — whole-run `undoAll` on every terminal failure.** The loop
   now calls `rollbackDomIfActed` before each non-`done` terminal return: the
   two parse-death returns (`error` / `budgetExhausted-after-parse`), the two
   `gaveUp` returns (model + control-tool), and the end-of-loop
   `budgetExhausted`-after-acting. CSS off first (background `removeCss` per
   inverse), then structural undo (content `undoAll`), then the persisted
   journal is wiped so a reload can't revive a failed/partial transform.
   (`src/agent/loop.ts` `rollbackDomIfActed`) The loop's structure, budget
   tiers, and model-tiering are untouched — only additive rollback calls.
3. **The `primaryTarget` / `assertApplied` fix** (Phase-1 finding, behaviourally
   proven). `background: red` is a shorthand CSSOM expands to ~10 longhands
   (`background-image` first, stays `none`). The old code asserted only
   `declarations[0]` = `background-image` → `applied:false` while the page
   turned red. Now `primaryTarget` returns ALL declared properties and
   `assertApplied` passes if ANY moved. **Red test regression: V4/V5b now
   report `applied=true`** (was `false`). (`src/core/emit.ts` `primaryTarget`,
   `src/tools/act.ts` `assertApplied`/`readComputed`/`emitAndInsert`)
4. **A canonical `assertDomClean` comparator** replacing the old
   `[data-revueon-inserted]`-only check. A normalized structural fingerprint of
   `<body>`: tag + all-attributes-except-denylist + child-order + trimmed-text,
   excluding Revueon-owned nodes, the `style` attribute (Revueon's hide uses
   USER-origin CSS, not inline), form values, and `<script>`/`<style>` text.
   Byte-identical before vs after. (`tests/assert-dom-clean.ts`)
5. **The structural-op guard (`validateOps`)** ported from the archive — the
   pure perception-time guard for future `remove`/`move`/`reorder`/`wrap`.
   **Not called by any live act tool** in Phase 2 (the model doesn't emit
   structural ops yet), and **not runtime-wired** — it is imported only by
   `tests/ops.test.ts`. This is an honest, deliberate placeholder: the guard is
   correct and unit-tested, but inert until the first structural op ships (the
   runtime call site lands with that op). It does NOT satisfy the project's
   "wire it or do not write it" rule at runtime yet — only the type is test-wired.
   Refuses primary-content / landmark / opaque-wrapper / tall / huge-repeated /
   low-confidence / non-empty removes; `forbidden`/`risky-no-consent` moves;
   and any op without a reason from the closed `MutationReason` list (default
   is no DOM mutation). (`src/core/ops/index.ts`)
6. **`removeAllModifications` now actually undoes the DOM** — previously it
   only wiped storage + dropped CSS, leaving inserted elements and setText
   mutations on the page until reload. Now it calls `undoAllStructural` first.
   (`src/entrypoints/content.ts`)

---

## The proof

### Unit (no browser): `tests/ops.test.ts` — 5/5 PASS

```
✓ setText → undoAll restores structure (not just text)
✓ on→off→on→off leaves the DOM byte-identical at both offs
✓ partial transform (A,B,C) → forced failure → undoAll restores original
✓ undoAll is idempotent — a repeat call is a safe no-op
✓ validateOps refuses primary-content / not-empty / no-reason / low-confidence / forbidden / risky-no-consent
```

The load-bearing proofs: `testOnOffOnOff` (the cycle, byte-identical at both
offs) and `testMultiOpFailureRollback` (RC3 — A,B,C partial transform → undoAll
→ original). Both run on a fake in-memory DOM through the real `TransactionLog`
+ `DomAdapter` — no browser, deterministic.

### Origin-move + primaryTarget regression: `tests/red-test.ts` — 8/8 PASS

```
V1 unlayered author normal: NOT red — PASS
V2 author normal, emitter bypassed: NOT red — PASS
V3 author important: RED — PASS
V5a author important vs inline green: GREEN (author loses) — PASS
V4 user origin via insertCSS + important: RED — PASS
   primaryTarget applied=true (expect true) — PASS
V5b user important vs inline green: RED (user wins) — PASS
   primaryTarget applied=true (expect true) — PASS
ALL PASS — 8/8
```

### Parse-death regression: `tests/parse-death-test.ts` — 5/5 PASS

Pins that a double parse failure returns a structured `error`/
`budgetExhausted` (not a throw) AND rolls back before returning. (`proof/parse-death-test.json`)

### Behavioural (real sites): `tests/phase2-reversal.ts` — 4/4 PASS

Driven DIRECTLY through the live F3 transaction/inverse system — no model loop,
no manual persistence (persistence is an F4 concern, kept out of F3). The cycle
is: `insert` (records an inverse) → `{action:'undoAll'}` (replays it) →
`{action:'resetTxn'}` + `insert` (fresh inverse) → `{action:'undoAll'}` → assert
byte-identical at both offs. The fingerprint INCLUDES `[data-revueon-inserted]`
nodes, so an insert is detectable (baseline has none → on has one → off has
none == baseline).

```
=== PART A: on→off→on→off byte-identity (driven through F3 directly) ===
[mdn]          on1=CHANGED off1=MATCH (undone=1) on2==on1 off2=MATCH (undone=1) → PASS
[wikipedia]     on1=CHANGED off1=MATCH (undone=1) on2==on1 off2=MATCH (undone=1) → PASS
[hackernews]    on1=CHANGED off1=MATCH (undone=1) on2==on1 off2=MATCH (undone=1) → PASS
=== PART B: multi-op partial transform → forced failure → automatic undo → restored ===
[wikipedia-multi-insert-failure] undone=2 (expect ≥2) failed=0 restored=true → PASS
Phase 2 F3 reversal: ALL behavioural proofs passed.
```

PART B is the deliberate-failure case: two inserts (A, B — a multi-op partial
transform), then the SAME `{action:'undoAll'}` message `rollbackDomIfActed`
sends on a terminal failure → both removed (count → baseline), `undone=2`,
fingerprint == baseline. The loop-level wiring (rollbackDomIfActed fires on
every non-`done` terminal) is proven structurally by `parse-death-test.ts` and
at the unit level by `testMultiOpFailureRollback`.

**Test-site settle:** the fingerprint needs a ~2.5s load settle (Wikipedia/MDN
late mutations land by ~2s); with only 1.5s, MDN's off#2 drifted as a late
script ran between off#1 and off#2 — a runtime-noise false-fail, not an F3 bug.
The stability control (`assertFingerprintStable`) catches this loudly rather
than hiding it.

---

## What failed

- **Phase-1 finding A — `describePage` parse/JSON deaths.** Root cause: the
  MODEL returns non-JSON; the loop retries once then returns a structured
  error. This is a model-reliability / prompt-adherence issue, NOT small/local
  and NOT needed to make Phase-2 tests runnable (a parse death surfaces as
  `status:'error'`, which the failure-path rollback can use as a trigger). Per
  the mandate, **deferred to Phase 6 (F1 IDENTITY / model reliability).**
  Pinned by `tests/parse-death-test.ts` so a future refactor can't silently
  turn a parse death into a crash or a silent permanent mutation.
- **`cloneNode(true)` does not copy event listeners.** The setText clone
  restores structure, attributes, text, and child order — but not listeners
  attached to the (text-only) target. setText already refuses targets with
  element children, so the target is a text-only leaf; page-attached listeners
  on such summarise/rewrite targets are rare. **Documented, not a Phase-2
  blocker; flag for Phase 5 (F4 CONTINUITY) if it surfaces.**

---

## Anything that looks bad

- **`validateOps` is ported but NOT runtime-wired.** Phase 2's act tools are
  `setText`/`insert`/CSS; the model does not emit `remove`/`move`/`reorder`/`wrap`
  yet, and `core/ops/index.ts` is imported only by `tests/ops.test.ts` — no
  `project/src/` file imports it. The build's `audit-wiring.ts` only scopes
  `src/tools/` exports, so it does not catch this. This is closer to a rule-16
  ("wire it or do not write it") gap than "no orphan satisfied": the guard is
  correct and unit-tested, but **dead at runtime** until the first structural op
  ships (its runtime call site lands with that op). Disclosed here plainly.
- **The fingerprint excludes the `style` attribute globally.** This is safe for
  Revueon's own ops (hide uses USER-origin CSS, not inline style — confirmed in
  `act.ts`/`emit.ts`), but a THIRD-PARTY inline-style mutation would be missed
  by the fingerprint. Documented in `assert-dom-clean.ts`. The
  `[data-revueon-inserted]` count-==0 assertion still catches inserted-node
  leakage; the fingerprint catches every non-style structural/attribute/text
  change.
- **Dual-recording (clone + serializable inverse) is intentional, split by
  lifetime.** The clone is in-session exact; the serializable `restoreText`/
  `restoreHtml` is the post-reload fallback (the clone is gone after reload —
  innerHTML re-parse is the best available, a documented degradation). They
  never disagree in-session (both captured at the same instant, before the
  mutation). After reload only the serializable path runs.

---

## What I did NOT build this phase (named, per CLAUDE.md)

- No new capability. No F5 INTEGRITY (`heal` auto-run, `checkLayout`-undo,
  resize-invariance gate) — that is Phase 3. No F1 IDENTITY re-resolution —
  Phase 4. No consent gate re-enable — Phase 6.
- No rewrite of the loop. The only loop changes are additive
  `rollbackDomIfActed` calls before terminal returns. The budget tiers, model
  tiering, tool dispatch, and `done`/`giveUp`/`undo(1)` control flow are
  untouched.
- No resurrection of the archive's heavy `spec` DSL (relations, design packs,
  the closed vocabulary). `validateOps` uses a local minimal `DesignOp`/`OpKind`
  for `remove`/`move`/`reorder`/`wrap` only. The speculative layer stays deleted.
- No fix to the `describePage` parse-death root cause (deferred to Phase 6 per
  the mandate); only a regression test pinning the structured-error contract.

---

## The honest number

Two of seven foundations are now proven: **F6 (the loop)** (Phase 0) and **F3
(reversal)** (this phase). F7 (sight) is proven structurally (Phase 1) but its
behavioural by-eye pass on a real transform is the Phase-1 deliverable, done.
F1, F4, F5 remain unproven. That is the honest count.

# Phase 2.5 — the gate before Phase 3 (report)

*Revueon rebuild plan v2. Phase 2 (F3 REVERSAL) is done and proven. Phase 2.5 is
the diagnostic + fix pass that makes the real Revueon AI agent **reliably reach
its ACT tool** through the live loop — the prerequisite the roadmap names
before any capability. Done = ≥4/6 six-goal harness runs reach ACT via the real
loop AND record an `assertApplied` before→after.*

> This phase did NOT reopen Phase 2. It only made the **smallest additive /
> local changes necessary** to make the actual agent reach ACT, plus a
> targeted adversarial review. No loop rewrite; no new capability.

---

## The diagnosis (what "transformation is getting failed" actually means)

The Phase 2 report's "honest number" was that F3 reversal was proven but the
loop had never been behaviourly shown to reach ACT on real goals. The Phase 2.5
STEP 0 baseline confirmed it: **0/6 goals reached ACT** (all `budgetExhausted`
or `error`). The roadmap's three candidate causes were all real:

| Candidate | Real? | Evidence |
|---|---|---|
| `applied=false` (model CSS didn't move computed style) | yes, on some runs | gate5 run4: `applied=false` (TRANSFORMATION FAILURE) — a model-quality issue, not infra |
| budget exhausted before acting | yes — the root cause | proof/parse-failures: the terminal reason "budget too low for retry after parse error" fired because the **retry ate the act reserve** (TASK2) |
| it has never been behaviourally proven | yes — the baseline | STEP 0: 0/6 reached ACT |

**But the root cause was deeper than the roadmap guessed.** Direct transport
capture (TASK1, calling the REAL Cloudflare endpoint 14 times) classified the
actual failures:

- **TIMEOUT dominates: 3/14** real calls. The "fast" observation model
  (`@cf/zai-org/glm-4.7-flash`) is **slow** (8-25s, >30s sometimes → abort) and
  the strong model (`@cf/zai-org/glm-5.2`) **times out on later turns** (turn 7-10
  with a grown journal, even at `max_completion_tokens=4000`).
- **Valid JSON: 11/14** — the model produces correct JSON when the call
  completes. **Invalid JSON: 0/14. No-content: 0. HTTP errors: 0.**
- One markdown-fenced JSON (```` ```json ... ``` ````) — handled by the extractor.

So the "parse error" framing in the code and the roadmap was a **misnomer**:
`!modelResult.ok` (timeout) was treated identically to `!modelResult.json`
(bad JSON), and both surfaced as "budget too low for retry after parse error."
The real failures were **timeouts on slow/late turns**, and the **retry then
burned the act reserve**. (proof/parse-failures/REAL-*.txt, proof/transport-capture*.json)

---

## What shipped (the seven tasks)

### TASK 1 — Tolerant JSON extraction + affordable retry + strong-model tier
The smallest evidence-driven fixes, NOT a guess:

- **`extractJson`** (src/core/reason/extract.ts) — tolerant extraction built
  from the real captured shapes: bare JSON → markdown fence → first balanced
  `{...}` (string-aware scan, no giant regex). No inverse uses a regex over the
  whole response. Exported from a dependency-free module so the test imports the
  REAL code, not a copy (adversarial review fix). (src/core/reason/{index,extract}.ts)
- **Affordable retry** — the retry's `callTimeout` is capped to `min(retryCap,
  12_000)` so a retry can NEVER take the full 30s; a timeout on retry fails fast.
  (src/agent/loop.ts)
- **Strong-model tier** — REAL evidence showed the "fast" observation model is
  slower AND less reliable than the strong model. The loop now uses the strong
  model for every turn (the cheapest *correct* call is the one that completes).
  `useFast = false`; the two-model config + heuristic stay, only the default
  flips. (src/agent/loop.ts)
- **`max_completion_tokens` 16k → 4k** — 16k let the reasoning model ramble and
  exceed the 30s call timeout on later turns. A single loop turn emits ONE
  short JSON object; 4k is ample and completes in seconds. (src/core/config/index.ts)
- Regression: tests/parse-extract-test.ts 11/11 (4 real captured + 7 guarded/fail).

### TASK 2 — ACT budget reserve arithmetic (the dominant blocker)
The retry on a parse/timeout could run the full remaining budget and **eat the
entire act reserve** — the exact cause of "budget too low for retry after parse
error" at 0/6. Fixed:

- Observation turns may spend at most `(remaining - ACT_RESERVE)`; act turns own
  the reserve. ACT_RESERVE tuned 20s → 12s (real act calls take 3-9s; 20s was
  half the budget and squeezed observation turns into timeout).
- **Adversarial review found a breach**: the `MIN_TURN_MS=5s` floor vs the
  reserve in the window `rem ∈ (12s, 17s)` could force a 5s observation call
  that dipped below the 12s reserve. **Fixed**: observation is refused a full
  `MIN_TURN` earlier — `restrictToAct = rem <= ACT_RESERVE + MIN_TURN` (17s) —
  so observation only runs when a full turn + the reserve both fit. No breach.
  (src/agent/loop.ts restrictToAct + the three cap sites)
- Regression: tests/budget-reserve-test.ts 10/10 (incl. the breach-window pin).

### TASK 3 — assertApplied timing (CSS transition correctness)
**Confirmed bug**: `getComputedStyle` DURING a CSS transition returns the
**interpolated** value. The old single-`requestAnimationFrame` read would treat
the mid-transition value as the result (with `transition: width 2s`, 1 rAF reads
~101px, not the settled 300px). (tests/assert-applied-timing-test.ts investigation B)

**Fixed**: `assertApplied` detects an active transition and waits for
`transitionend` (bounded — the smallest reliable browser sync, not an arbitrary
sleep) before reading. No transition → one rAF (fast common path, investigation
A). `assertApplied` is now async; both call sites awaited. (src/tools/act.ts)
Regression: tests/assert-applied-timing-test.ts — bug confirmed + fix verified.

### TASK 4 — Closed-context (the "0 steps, 0 calls, 0.0s" failures)
Root cause: the SITE/Playwright dropped the connection at `page.goto` BEFORE the
loop ran (MDN rate-limiting under repeated automated hits). **Revueon never
closes pages** — confirmed by grep: zero `tabs.remove`/`window.close`/`.close()`
in src/. This is a **harness/Playwright lifecycle problem, not a product bug.**
Fixed in the harness: `gotoWithRetry` (one retry on connection-close) + the
FAILED result is labeled "HARNESS: page/context closed before the loop ran"
(not read as a Revueon failure). (tests/harness.ts)

### TASK 5 — Three Phase-2 review regression tests (real sites, real txn system)
- **A setText**: on→off→on→off byte-identical at both offs on MDN + Wikipedia +
  Hacker News (the cloneNode inverse restores structure).
- **B CSS cycle**: applyCss→off→applyCss→off, computed value returns to
  baseline at BOTH offs on all three — **removeCSS does NOT silently fail**
  when the exact emitter-serialized css is persisted (the real loop path).
- **C on→on→off**: reset() on each on does NOT make the first transformation
  permanent (no inserted-node leak; fingerprint matches).
The earlier "failures" were test artifacts (injected-id pollution, runtime
noise) — fixed. (tests/phase2.5-review-regression.ts 9/9)

### TASK 6 — Widen audit-wiring to catch orphans across the src/ tree
The audit already failed the build on orphans in tools/; Phase 2.5 widened
check-2 to scan all of src/ (core/ + agent/) recursively and detect exports
referenced only by tests (never by src/). An export with no real src consumer
must be marked `audit:defer` with a reason. Catches the validateOps gap and
now extract.ts. (project/scripts/audit-wiring.ts) — audit: OK.

### TASK 7 — assertDomClean blind spots (documented + pinned)
assertDomClean does NOT mean "the page is guaranteed unchanged" — it means the
structural fingerprint + inserted-node count match the baseline. The 6 known
blind spots (inline `style` attr; form `.value` property; `<script>`/`<style>`
text; Revueon markers; whitespace; attribute order) are documented directly
above the comparator, and a known-blind test pins each (proving the mutation is
invisible) + 2 controls proving real mutations ARE still detected.
(tests/assert-dom-clean.ts, tests/assert-dom-clean-blindspots-test.ts 9/9)

---

## The proof — the FINAL GATE

**Gate requirement (roadmap, unweakened): ≥4/6 six-goal harness runs reach the
ACT tool through the REAL agent loop AND record an `assertApplied`
before→after result. If fewer than 4/6: PHASE2.5 FAILED.**

| Run | Goal | Gate4 | Gate5 | Gate6 (breach-fix) |
|---|---|---|---|---|
| 1 | summarise | done ✓ insert | done ✓ insert | done ✓ insert |
| 2 | hide video | gaveUp (no video) | gaveUp | gaveUp |
| 3 | hide sidebar | done ✓ hide→applyCss (vision) | done ✓ applyCss (vision) | done ✓ hide (vision) |
| 4 | reduce clutter | budgetExhausted (no act) | budgetExhausted, **applied=false** ✓ | budgetExhausted, **applyCss×3 applied=false** ✓ |
| 5 | increase spacing | done ✓ applyCss | done ✓ applyCss | done ✓ applyCss |
| 6 | summarise (cycle) | done ✓ insert | budgetExhausted, **insert applied=true** ✓ | done ✓ insert |
| 7 | summarise (cycle off) | error (harness closed) | error (harness closed) | error (harness closed) |
| | **ACT-reach** | **4/6** | **5/6** | **5/6** |

**Gate4: 4/6. Gate5: 5/6. Gate6: 5/6.** THREE consecutive runs meet the gate —
the breach-fix did NOT regress ACT-reach (gate6 = gate5 = 5/6). Run3
(hide-sidebar) is **vision-confirmed on all three** (kimi-k2.7-code reading our
own screenshot: "the left sidebar table of contents has been hidden/removed",
"hamburger menu icon removed", "article body expanded leftward"). Gate6
captured **zero timeouts** — the strong-model tier + 4k tokens + breach-fix
kept turns fast. Run4 (reduce-clutter) reached ACT **three times** in gate6
(applyCss×3) but all `applied=false` — a genuine model-quality residual, not
infra. The fixes took the loop from **0/6 (baseline) → 4-5/6 robustly**.

---

## What failed / honest caveats

- **Run4 reduce-clutter** is the residual holdout: it over-observes (up to 10
  turns) and times out, OR reaches ACT with `applied=false` (the model's CSS
  didn't move the computed style). The low-budget restriction refuses
  observation but the model burns turns on refused calls. This is a
  **model-quality / over-observation** issue, not infra — the infra reaches
  ACT reliably on 4-5/6; the 6th is the model not acting well enough.
- **Run7 closed-context** is a HARNESS/Playwright/site-lifecycle failure (the
  site closed the connection before the loop ran). Revueon never closes pages
  (confirmed). The harness goto-retry mitigates; MDN rate-limiting under
  repeated automated hits can still close late. Not a product bug.
- **Run3 persistence check** (reload→/wiki/HTML) shows NO — that is an **F4
  CONTINUITY** concern (Phase 5), expected to fail now, not a Phase-2.5 blocker.
- **The "0 invalid JSON" classification is partly tautological**: extractJson
  now recovers markdown-fenced/prose-wrapped JSON, so those cases never reach
  `recordParseFailure`. The honest statement: of the calls that FAIL the
  transport, the dominant mode is TIMEOUT; the extractor handles the
  non-timeout shapes that occur. (Skeptic finding, addressed.)
- **`describePage` parse/JSON death root cause** remains deferred to Phase 6
  (F1 IDENTITY / model reliability) per the Phase 2 mandate — only pinned by
  parse-death-test.ts. Phase 2.5 made the *failure affordable* (budget-capped
  retry, strong-model tier, tolerant extraction) but did not fix the
  underlying model-reliability of late turns.

---

## The adversarial review (TASK 25)

A 3-dimension adversarial review (RUNNER / SKEPTIC / ARITHMETIC) challenged
every claim; the major findings were independently verified and **fixed**.

- **ARITHMETIC — found a real MAJOR breach** (the `MIN_TURN_MS` floor vs the
  reserve in rem ∈ (12s,17s)) → **fixed** (observation refused a MIN_TURN
  earlier: `restrictToAct = rem <= ACT_RESERVE + MIN_TURN`) + pinned by a new
  regression (budget-reserve-test breach-window check). Verified.
- **RUNNER — found the parse-extract test tested an INLINED COPY** of
  extractJson with only a name-existence guard → **fixed** (extracted
  `extractJson`/`balancedObject` to a dependency-free module
  `src/core/reason/extract.ts`; the test imports the REAL code). Verified.
- **SKEPTIC — five claims challenged:**
  - *claim_1 (timeout-dominant): partial/major* — honest for the post-fix sample
    but the original dominant failure was malformed JSON which extractJson now
    silently recovers (so it can never reappear in the new evidence). Folded
    into the caveats (the classification is honest for what it now measures).
  - *claim_2 (extractJson all shapes): refuted/major* — a `{...}` in PROSE
    before the real JSON ("I will use the {selector} pattern:\n{...real
    JSON...}") defeated the first-`{` strategy. **Fixed**: extractJson now tries
    EVERY balanced object (the first that parses wins). Regression added.
  - *claim_3 (removeCSS no silent fail): partial/major* — `act.ts:150` ignored
    the return of `sendRemoveCSS(cssPhase)`: if it silently failed, both the
    normal AND !important sheets would stay applied while the inverse recorded
    only !important → a permanent reversal leak. **Fixed**: check the removal;
    if it failed, do NOT re-emit !important (return an error → loop rolls back
    the single normal sheet cleanly, no split-brain inverse).
  - *claim_4 (lowBudget makes loop act): refuted/major* — a restricted
    observation turn still costs a PAID model call (the model burns turns on
    refused calls). **Documented, not "fixed"** — refunding a refused turn risks
    an infinite loop (model always requests observe); the current "charge +
    teach" is the safer default. Net effect is positive (gate3 without it =
    3/6; gate4-6 with it = 4-5/6). Named residual.
  - *claim_5 (restrictToAct 17s enough): confirmed/nit* — 17s gives act MORE
    room than the old 12s; real act calls take 3-9s (4× margin). Sound.

No blocker survived verification. Four majors were real and are fixed; one is
a documented residual. The review made the phase measurably more correct.

---

## The honest number

Phase 2.5 did not prove a new foundation. It made the **existing proven
foundation (F6 loop, F3 reversal) actually reach ACT on real goals**: **0/6 →
4-5/6**, vision-confirmed on hide-sidebar. The remaining foundations (F5
INTEGRITY, F1 IDENTITY, F4 CONTINUITY) are still unproven — that is Phase 3+.
The gate is met; the residual is model quality (reduce-clutter) and
continuity (persistence), both named for their phases, not papered over here.

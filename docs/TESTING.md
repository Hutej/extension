# Revueon — Testing

*The two-command system (rebuilt 6 Sep 2026, P1). The Session-0 cleanup
archived the pre-fresh suites to `archive/tests-pre-fresh/`; this document
describes the live suite. Zero src/ imports are mocked — the tests import the
real production modules.*

## Commands

```
npm test             # tests/unit/ (node --test, pure Node) + tests/browser/
                     # (one Playwright launch, local fixtures, built extension).
                     # No model, no external network, < 60s. Run before every commit.
npm run typecheck    # tsc --noEmit — covers src/ AND tests/.
npm run build        # audit-env + audit-wiring + wxt build.
npm run bench        # tests/bench/wiki-bench.ts — the P2 brain-matrix instrument
                     # AND the product-path truth instrument: real popup → real
                     # loop → live tab on the R3 article. Paid, isolated.
                     # --goal <id> | --all | --list; --run N rotates wording;
                     # --model/--effort/--max-tokens are the P2 variant overrides.
```

All browser tests need `npm run build` first — they drive the built extension
through Playwright persistent contexts. Wikipedia is the only external site
the bench touches (rule 18 list).

## tests/unit/ — pure Node (62 checks, ~0.2s)

| file | proves |
|---|---|
| emit.test.ts | serializer flag-only `!important`; assert surfaces (primaryTarget/allRuleTargets/allSelectors); responsive dominance classifier (border-px and intrinsic sizes NOT counted — the failing cases); motion gate exact tokens; strip gate debris reasons; sanitizer allowlist + the hex-escape `javascript:` bypass case |
| journal.test.ts | done-gate matrix; the effect truth actually REACHES the model (NO-VISIBLE-CHANGE names findElements; strip/selector reports; undo FAILED + NO ASSUMPTION OF REVERSAL); 8k cap sets the truncation marker; undo splice-vs-keep; `toPersistableState` carries NO cleartext page content (the naive `toState()` provably does) |
| policy.test.ts | terminal disposition (always-rollback would destroy verified work — the failing case); transport breaker counts only chrome connection errors; convergence guard both classes; `diffNewIssues` normalized-key drift; resize-proof classification; budget defaults/caps |
| persist.test.ts | scope keys strip query+hash (origin-only merges articles — the failing case); act identity dedupe; merge accumulates, trim removes exactly the rolled-back acts; sha256 known vector |
| extract.test.ts | the model-response parser: bare/fenced/prose/decoy-brace/braces-in-strings; truncated and empty responses fail honestly |

## tests/browser/ — one launch, local fixtures (32 checks, ~30s)

| file | proves |
|---|---|
| reversal.ts | THE LAW TEST: real dispatch of one authored stylesheet + one insert + one setText → toggle off → outerHTML byte-identical → on → byte-identical (through the real replay path, digests seeded the way a loop run persists them) → second off. The deliberate failing case — a textContent inverse — must FAIL the byte-compare |
| noop.ts | the paint-shadow no-op reports `visibleChange:false` + names findElements; the done-gate would refuse that run |
| resize.ts | the fixed-px `width:900px` sheet is REFUSED by the dominance gate (the failing case ships inside the check); the clamp()+fr sheet passes; the proof mechanism really narrows the OS window and checkLayout measures it |
| tokens.ts | the DESIGN snapshot lists the site's custom properties RESOLVED; overriding one token with `!important` repaints every consumer |
| emit-cascade.ts | the CSSOM half of emit (parseCss needs a real CSSStyleSheet): @media round-trip; user origin beats author-normal via the whole-sheet retry; shorthand→longhand expansion; **@keyframes + animation sheet — KNOWN RED on the current build** (`primaryTarget` recurses into @keyframes and hands the keyText to `querySelector` — src bug, reported 6 Sep 2026, P3 fuel; the check stays per rule 15) |

## tests/bench/wiki-bench.ts — the benchmark harness

Ten R3 goals (`tests/bench/goals.json`, 3 fresh wordings each, deterministic
rotation per run index — never the identical string on consecutive runs of the
same goal). Isolation: fresh profile per invocation, all `rv_*` keys wiped and
verified absent before the goal fires. Per run: 5 PNGs (before / after /
toggle-off / reload / remove-all) + complete metrics (status, wallMs,
paidCalls, acts applied/authored, selectorRefusals, noopCount, parseFailures,
timeouts, resizeProof, toggleOffRestored, removeAllRestored, reloadSurvived,
replay status counts). The goal-10 sequence runs the r3-benchmark product
path: seed theme + spacing → remove-all → redo items 1 and 3 → final reload.
Reversal failures are MEASURED and reported honestly — R10 says they will
fail on the current build; that is P3's fuel, not a harness bug to work
around. Results table: `project/proof/p1-smoke/results-table.md`.
Optional `--vision` post-pass (kimi, TEST-ONLY) — skipped, never blocking,
when not requested.

## The standing laws

1. **Green is not done.** npm test proves mechanics; anything claiming to LOOK
   right needs bench screenshots + a human eye (or vision QA in words).
2. **A test may never be edited to make it pass.** Every behavioral check ships
   with its deliberate failing case (marked FAILING-CASE in the unit files;
   the textContent anti-fixture and the width:900px refusal in the browser
   files). If the check goes red, the extension is wrong.
3. **Never run Playwright against YouTube, Reddit, X, LinkedIn, Amazon,
   Gmail** — captchas hang the harness. MDN, Wikipedia, HN, docs.python.org
   only; protected sites are manual by-eye.
4. **Benchmarks run in isolation** — no concurrent browsers, no concurrent
   builds, and the launcher command must exit immediately. Launch plain.
5. **Novel wording every paid run** — the goals file rotates 3 wordings per
   goal by run index; never reuse a prompt verbatim.
6. **Production code paths are testable without a model** — the unit files
   import the real src modules; the browser suite dispatches real tool calls
   through the content script with the popup as the driver. Only the model's
   JUDGMENT needs paid runs.

## History

The pre-fresh suites (fast.ts, r3-bench.ts, r3-benchmark.ts, paid-bench.ts,
protocol-experiment.ts, live-smoke.ts, bounded-recovery.ts, diag-tabid.ts,
reversal-probe.ts, the experiments/ DSL-era harnesses, playwright.config.ts,
prove.ts) were archived verbatim to `archive/tests-pre-fresh/` on 4 Sep 2026
(Session 0) and deleted from the tree. The phase reports in
`project/proof/*.md` remain the historical record.

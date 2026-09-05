# Revueon — Testing

*The two-command system (rebuilt 31 Aug 2026). The old approach — 22
network-bound suites, minutes each — was deleted; its invariants moved into
one deterministic suite that runs in ~1.5 seconds.*

## Commands

```
npm test             # tests/fast.ts — deterministic, no model, no external
                     # sites, one browser launch, ~1.5s. Run before every commit.
npm run test:paid    # tests/paid-bench.ts — real model, real sites
                     # (HN/MDN/Wikipedia/docs.python.org). On demand.
                     # RV_ONLY=run1,run2 filters; RV_MODEL/RV_EFFORT/
                     # RV_MAXTOKS swap the model via storage override.
node --experimental-strip-types --env-file=.env tests/r3-bench.ts
                     # R3: the one-site (Wikipedia) 10-request MVP benchmark
                     # with before/after screenshots + vision QA in words.
```

All browser tests need `npm run build` first — they drive the built extension
through Playwright persistent contexts.

## fast.ts — the deterministic suite (35 checks)

One browser launch, one local fixture server (no network), one session:

| section | proves |
|---|---|
| pure: disposition + budgets | keep/rollback policy; config is the single source (no dead class defaults) |
| pure: journal wiring | the effect lines actually REACH the model (the T5/T6 churn root cause was this wiring missing); askUser answers serialize; R2 done-gate semantics (no-op run, visible run, refused-only, hide-only, empty) |
| tools | USER origin beats page CSS; visualEffect truth — the deliberate paint-shadow no-op is DETECTED, visible paint + geometry reported; responsive/motion/zero-match gates refuse with named alternatives; the recorded inverse restores the page |
| overlay | appears on work start, intercepts clicks at viewport center, updates on steps, removed on end |
| popup | consent auto-acknowledged (no button); honest pre-model state (no hardcoded ack — the "Thinking…" rule); the model's own reply renders; askUser round-trip (options + free text) |

## paid-bench.ts — the paid benchmark

Six discriminating runs (the known-failing classes + controls) with the real
loop: status, wall, paid calls, acts authored/refused, act CSS + reasoning,
visualEffect/perSelector truth, byte-identical screenshot check, parse
failures. Evidence: `proof/paid-<label>.json` + `tests/screenshots/`.

## r3-bench.ts — the one-site MVP benchmark

Ten novel-worded requests on one Wikipedia article (dark theme, magazine,
breathing room, article-only, TOC rail, warmer palette, bigger headings,
collapsible references, premium, undo-everything), each judged against the
R3 pass bar (MVP-plan.txt §R3): intent by eye, no no-op shipped, parity vs
the original page, wall/calls recorded — plus the reversal sequence (apply a
theme, then natural-language undo; the post-undo page must be byte-identical
to the pre-theme page). Vision QA in words runs per run (kimi-k2.7-code,
TEST-ONLY per rule 14's caveat — production never sends screenshots).

## The standing laws

1. **Green is not done.** fast.ts proves mechanics; anything claiming to LOOK
   right needs paid-run screenshots + a human eye (or vision QA in words).
   An unverified run is a failed run.
2. **A test may never be edited to make it pass.** Every check ships with a
   deliberate failing case where possible (the no-op fixture, the fixed-px
   refusal, the motion refusal, the done-gate no-op run).
3. **Never run Playwright against YouTube, Reddit, X, LinkedIn, Amazon,
   Gmail** — captchas hang the harness. MDN, Wikipedia, HN, docs.python.org
   only; protected sites are manual by-eye.
4. **Benchmarks run in isolation** — no concurrent browsers, no concurrent
   builds, and the launcher command must exit immediately (a backgrounded
   `build && bench` chain gets killed by the shell timeout and takes the
   browser with it — this happened twice; launch plain).
5. **Novel wording every paid run** — never reuse a prompt verbatim; no
   benchmark overfitting.
6. **Production code paths are testable without a model** — gates, wiring,
   and serialization are pure or fixture-driven; only the model's JUDGMENT
   needs paid runs.

## Known-failure classes the suites must keep honest

- No-op shipped as done → done-gate + byte-identity + visualEffect (fast + paid).
- Churn (model re-refining blind) → effect lines + convergence guard.
- Bridge loss mid-run ("message port closed") → diagnosed, not named
  "intermittent": close tabs between runs, log renderer crashes and SW
  restarts, never run browsers concurrently.
- Model-call timeouts (uncapped completions on flash) → 60s per-call timeout;
  if a class of goals still exhausts the 300s ceiling, that is model-policy
  evidence, not a harness bug.

## History

The old suites (design-* A/B harnesses, harness.ts, vision probes, t2–t5
browser suites) and all JSON/PNG result artifacts were deleted 31 Aug 2026;
the phase reports in `project/proof/*.md` remain the historical record.

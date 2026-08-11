# 18 — Unified Plan Map

> The single mapping of every plan that has ever run to its real status.
> Read this one document instead of 17. Updated after each build sweep.

## Build sweeps (code-level)

| Plan | Title | Status | What it delivered / why superseded |
|---|---|---|---|
| 1A | Law 0 — Give Layout Back to the Browser | DONE (committed 342d433 + ff1a406) | Purged measurement-derived values from the solver/compiler. Constraint-driven emission replaces geometry-driven. Not verified by eye. |
| 1B | Trust + Carry-overs | DONE (committed c407077) | Fixed 12 items from the 1A review + audit findings. Not verified by eye. |
| 1C | Sight (C0-C11) | DONE (committed 46f3919) | Enriched perception: heading outline tree, HSL colour model, component taxonomy, density/rhythm/alignment, shadow-DOM read-back, text understanding, new serialization. Not verified by eye. |
| 1C.2 | Sight, Deep (D0-D12) | DONE (committed a46f9c6 → 1328c8b) | Model layer: position/spatial, typography as system, background/transparency/elevation, fixed/sticky/scroll, borders/shape/surface, density/rhythm/room, media/landmarks/interactive inventory, dynamism/safety, confidence/provenance, serializer referencing page-level models. |
| 1D | Voice (E0-E8) | DONE (committed 2d15312) | Replaced the enum-based expander (~96K outcomes) with a typed closed-set relational vocabulary (31 relation types). Model states relations, not CSS/enum picks. Deterministic transformation engine resolves relations → Target Layout IR. Boundary validator. |
| 1E | Reach (F1-F7) | DONE | Fixture comment fix, quantization fix (closestStep), emission breadth (all 31 relations produce CSS), motion layer (prefers-reduced-motion), interaction (movable), DOM ops re-enabled (MutationReasons), docs. 37 relations total. |
| 1F | Convergence (G1-G8) | DONE | Target Layout IR, composition vocabulary (9 new relations, 46 total), v1/v2 fork deleted (ONE pipeline), wiring audit (audit:wiring), pixel leaks fixed, file split (content.ts/transform.ts first split), docs. Review subagent found 3 silently-dropped relations. |
| 1G | Conformance (H1-H7) | DONE (this sweep) | Three dead relations made real (adjacentTo/readBefore/prominentFirst via placement). Audit hole closed (emission path ≠ validation path). File split finished (content.ts 1585→1218, transform.ts 743→412, 9 domain modules). Constraints removed (reasoning_effort, --rv-side-max proportional, 65ch prose-only, Law 0 rule 5 dvh/svh, call budget restated). 10 structural conformance checks. Proxy gates retired (changed/coherent/covered demoted to advisory). No aesthetic score. Docs unified. |
| 1H | Languages (I0-I7) | BUILT, NOT VERIFIED BY EYE | Six layout languages as data (dashboard, bento, editorial, feed, split-view, gallery) + documentation as 7th/fallback. `language` is a top-level spec field; the model CHOOSES from a 3-5 candidate shortlist perception proposes. ConstraintPriority restored (assigned in 7 places, read in none): solver relaxes the lowest-priority on a width-axis conflict, records every relaxation, reports required-vs-required as unsatisfiable. Colour-coverage invisible-text fixed structurally (text colour only emitted when contrast is provable against a known effective background). Conformance is three counts (applicable/not-applicable/pass); zero-applicable = "nothing was declared", not a pass. !reflowSkipped hard gate retired (archetype conformance carries reflow). Architect reverted to 'low' (medium measured ~130s vs ceilings); fallback carries `architectFallback:true` the ledger reports. Browser-free relaxation unit test. Gate: tsc+eslint+build+audit:wiring (no site runs). |

## Phases (product-level)

| Phase | Title | Status | Notes |
|---|---|---|---|
| P0 | Perception stability probe | PASSED | Min Jaccard 0.861 (target 0.80). |
| P1 | Deterministic semantic role graph | PASSED | Role-distribution stability 0.943 (target 0.90). |
| P2 | Intent DSL + design packs + conformance | MACHINERY PASSED, BY-EYE FAILED | Engine restyles; never re-lays-out. |
| P2.5 | Layout IR + Responsive Solver v1 | EXPLORED (superseded by 1F) | v1/v2 fork deleted in 1F. One pipeline. |
| P2.6 | Stress sites BBC + YouTube | NOT STARTED | Deferred until build sweeps verified by eye. |
| P3 | Migration completion + brutal deletion | IN PROGRESS | v1/v2 fork deleted (1F). Residual dead code in 1G H3 orphan triage. |
| P4 | Prevention-by-construction | NOT STARTED | |
| P5 | Structural identity + sticky roles | DONE | Handle stability 1.000 on 5 sites. |
| P6 | Conditional post-render visual verifier | NOT STARTED | Kimi, fired only on uncertainty. |
| P7 | Additional layout languages | IN PROGRESS | Six languages + documentation committed in 1H; not yet verified by eye on real sites. |
| P8 | Remaining primitives (motion, depth, density) | NOT STARTED | |

## Investigation docs

| Doc | Title | Status | Notes |
|---|---|---|---|
| 01 | System overview | HISTORICAL | Pre-1D architecture. |
| 02 | Execution flow | HISTORICAL | Pre-1D. |
| 03 | Module breakdown | HISTORICAL | Pre-1D. |
| 04 | Data flow | HISTORICAL | Pre-1D. |
| 05 | DOM pipeline | HISTORICAL | Pre-1D. |
| 06 | AI pipeline | HISTORICAL | Pre-1D. |
| 07 | Architecture analysis | HISTORICAL | Pre-1D. |
| 08 | Root cause analysis | HISTORICAL | Pre-1D. |
| 09 | Browser compatibility | HISTORICAL | Pre-1D. |
| 10 | Performance analysis | HISTORICAL | Pre-1D. |
| 11 | Security analysis | HISTORICAL | Pre-1D. |
| 12 | Failure simulation | HISTORICAL | Pre-1D. |
| 13 | Risk register | LIVE | Updated in 1G (H21 corrected: IN PROGRESS, not DONE — void detector still cannot see the GitHub inter-cluster band). |
| 14 | Technical debt | LIVE | Updated in 1G. |
| 15 | Refactoring roadmap | HISTORICAL | Pre-1D. |
| 16 | Glossary | LIVE | Reference. |
| 17 | System diagrams | HISTORICAL | Pre-1D. |
| 18 | Unified plan map (this doc) | LIVE | Created in 1G. |

## Current position

**BUILD SWEEP 1H — LANGUAGES — BUILT, NOT VERIFIED BY EYE.** Six layout languages + documentation committed; constraint-priority relaxation, colour-contrast guard, three-count conformance, reflow-gate retirement, and timing fallback wired and committed. Gate was build-only (tsc + eslint + wxt build + audit:wiring, all green); a browser-free relaxation unit test passes. After this sweep, testing resumes (real site runs, popup.test.ts, fixture grid, screenshots, paid calls) to verify the languages by eye. Outstanding from 1H (flagged, not built): the full 46-relation golden emission test (executing every relation against a synthetic fixture) — the standing structural audit:wiring remains the coverage gate; and the 46 test-only-export verdicts (the audit already fails orphan exports, so the standing gate holds — a dedicated per-export triage is the next sweep's work).
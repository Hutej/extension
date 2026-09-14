# S9.1 release qualification record — stress, compatibility, performance

The S9.1 measurement record (roadmap S9.1: "Measure stress, compatibility,
performance and product quality"). Every number below is a MEASURED result
from a real command against the BUILT extension; nothing is inferred.

## Supported-browser / capability matrix (truthful)

| Environment | Evidence | Result |
|---|---|---|
| Chromium 1234 (current, playwright 1.61) | full default gate | **374 unit + 41 browser pass**, 0 known-red |
| **Chromium 120.0.6099.28 (the manifest floor)** | live min-version smoke (`tests/stress/min-chrome-smoke.mjs`) | **5/5 PASS**: registration, SaveRevision, saved intent replays LIVE, SetEnabled(false), exact release |
| Edge (Chromium-derived) | — | **NOT live-tested here** — no Edge binary in this environment. Chromium parity is expected (same engine + MV3 surface) but the live run remains an explicit residual; the advertised claim stays "Chrome 120+" until an Edge run is recorded. |
| Old-headless Chromium 120 | smoke harness note | MV3 service workers do not start in Chromium 120's OLD headless; `--headless=new` is required. A test-harness constraint, not a product one (real users run headed). |

## Benchmark distributions (measured 2026-09-14, `npm run test:stress`)

| Measurement | Result |
|---|---|
| T23 mutation storm (~100Hz × 8s, 599 ticks around the customized node) | model posts **0** (planning is user-initiated — I14 under load); worst evaluate round-trip **5ms**; heap **4→3MB**; effect held `rgb(255,0,0)` throughout |
| T23 toggle storm (120 enable/disable round-trips) | p50 **26ms**, p95 **300ms**, max 305ms; last intent wins; re-enable restores |
| T03-P Observe scaling | 2k nodes **39ms**, 10k **126ms**, 50k **736ms** — honest partial coverage with a cursor (`completed=false`), visited nodes bounded (2000 cap; 364 regions at 50k after region selection) |
| T22-P zoom (deviceScaleFactor 1→2→3→1, live customization) | evaluate round-trips **0–1ms**; effect survives |
| T24 soak (60s sustained churn, bounded variant) | heap trajectory **4→4→3→3→3→3→3MB** (flat); effect live at the end |
| E2E latency (canned model, full chat→proposal→apply→saved) | plan→proposal **243ms**; apply→saved **2032ms** (includes verification + persistence) |

The full 30min soak (T24's literal spec) is opt-in: the suite's SOAK_MS is a
constant; the 60s bounded run above is the recorded evidence. No hot path
required optimization (the plan's "optimize only measured hot paths" rule:
nothing measured crossed a bound).

## Model-free correctness matrix (T01–T32 → evidence)

| Row | Evidence |
|---|---|
| T01 foundation | gate.ts + test-gate inventory (zero-discovery refusal, stale-build refusal, known-red accounting) — green every run |
| T02 contracts/parser | unit contracts suite |
| T03 observation | unit observe + browser S3.1; scaling above |
| T04 privacy | browser S3.1/T04 (sentinel absence) |
| T05 target identity | unit targets + browser ambiguity/stale cases |
| T06 roots/frames | browser S8.3 suite (shadow-frame, frame-child fixtures) |
| T07 CSS policy/cascade | unit compile + browser policy cases; §92/alias/net-longhand regressions |
| T08 apply transaction | unit transaction (374 total) + browser staged/dedup cases |
| T09 native reversal | browser clone-restore fixture (same-node, listener preservation) |
| T10 replay/refinement | browser S5.2/T10 (apply→save→reload→disable→reload) + owner toggle regression |
| T11 route continuity | browser S5.2/T11 (SPA route revoke/restore) |
| T12 store concurrency | unit store/broker conflict + tombstone cases |
| T13 verification truth | unit verify (unknown-never-pass, transient rescue, settled re-measure) + browser effect cases |
| T14 cancel/crash/races | browser StartRun/CancelRun + ownership-release regressions (owner-fix `3040ca3`) |
| T15 keyboard access | browser S7.1 suite (keys.html fixture) |
| T16 local behavior | browser S7.2 suite (comments.html) |
| T17 projection board | browser S8.1 suite (board.html) |
| T18 floating/relocation | browser S8.2 suite (player.html) |
| T19/T20 providers | unit providers (19 tests incl. 408 retry, clamp negotiation, deadline) |
| T21 permissions/target UI | workspace suite auto-target + gates (zero-call refusals) |
| T22 responsive/a11y | axe browser pass + zoom measured above |
| T23 storm/cleanup | this record (storm + toggles) |
| T24 soak/memory | this record (60s bounded, flat heap) |
| T25 endpoint/security | unit providers security cases + browser denial cases |
| T26 legacy migration | unit migration/quarantine cases |
| T27 UI outcome honesty | unit workspace statusFor exhaustive + browser status cases |
| T28 product style quality | owner's live model sessions (below) — opt-in, separate from the model-free gates |
| T29 dependency/build | build from lockfile + import-audit gate (forbidden-dep controls) |
| T30 composition | unit transaction multi-customization + browser aggregate cases |
| T31 element insertion | browser S8.1/creator suite |
| T32 owned canvas | unit canvas (13) + browser canvas suite ×2 |

## Manual site coverage (owner-directed, live)

- **Wikipedia, live Cloudflare DeepSeek (the built-in model)**: "make the
  heading crimson" → plan → Apply → `rgb(220,20,60)` held; survives reload;
  My-changes disable reverts exactly (UX-rework session).
- **Wikipedia "transform to neubrutalism"** (owner report): reproduced in the
  harness, root-caused (§44 shared-token collision + §92 default + alias
  table), fixed, and covered by the neubrutalism E2E.
- **Wikipedia "transform this into glassmorphism"** (owner report): reproduced
  (`-webkit-backdrop-filter` dead alias + intra-batch net-cascade), fixed, and
  covered by the glassmorphism E2E — blur now actually renders.

## Residual limitations (explicit, none P0)

1. **Edge live run**: pending an Edge-capable environment (see matrix).
2. **BFCache-specific restore** (T14's literal case): navigation lifecycle is
   covered via reload/SPA tests; a forced BFCache-expiry run is not
   automatable deterministically in this harness — remains manual if claimed.
3. **30min soak**: the 60s bounded soak is the recorded evidence; the full
   duration is opt-in (constant in the suite).
4. **Chrome-120 old-headless**: harness-only (see matrix note).

## Security review status

The P0 security surfaces are exercised green in every gate run: endpoint
redirect/credential-in-URL refusals (T25), URL-free CSS recheck at the broker
boundary (S2.2), no raw model HTML/JS execution (compile policy + creator),
consent gates with zero-call refusals (T21/AC-07), and the build/import audit
(T29: forbidden dependencies, no runtime cycles, no secret sentinels).

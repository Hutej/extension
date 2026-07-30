---
inclusion: always
---

# WebMorph — Product Steering & Roadmap

This is not just an extension — this is an AI agent that lives in your browser.

## The one architectural rule (verbatim — pasted at the top of every doc it belongs in)

> The AI is responsible for design decisions, the Layout IR is responsible for expressing
> structure, the solver is responsible for satisfying constraints, and the compiler is
> responsible for generating CSS. No layer is allowed to take over another layer's responsibility.

## The locked 10-stage pipeline

```
DOM
 -> Perception            (what is on the page: geometry, computed styles)
 -> Semantic Model        (what is this: 14-role graph)
 -> Current Layout IR     (how is it arranged — immutable)
 -> Transformation        (what it should become: intents + archetype + slots)
 -> Target Layout IR      (NEW object, never a mutation of Current)
 -> Responsive Solver     (make it feasible and responsive)
 -> Responsive CSS        (compiler emits, decides nothing)
 -> Runtime Verification  (confirms; never redesigns)
 -> DOM Patch
```

Perception answers "what is this?". Layout IR answers "how is it arranged?".
Keep them separate stages, each with a single responsibility.

The intent DSL SURVIVES and stays the model's only contract. The model must NEVER emit raw layout
constraints. The solver sits BELOW the expander:
`Intent DSL -> Expander -> Target Layout IR -> Solver -> CSS`.

Three orthogonal layers compose the final look, never mixed together:
**Layout Language + Visual Pack + Role Style.** A Dashboard layout must combine freely with Apple
visuals, Material visuals or Editorial visuals. Layout packs and visual packs never share fields.

## Layer ownership table

| Stage | Owns | Must never do |
|---|---|---|
| Perception | geometry, computed styles, cluster handles | express layout structure / make design decisions |
| Semantic Model | the 14-role graph + dominance + grouping | decide layout / assign constraints |
| Model (Architect) | pick ONE archetype from a supplied candidate list; emit role intents | emit raw layout constraints / invent archetypes / assign constraint priority |
| Transformation | deterministic slot assignment; Target IR construction | decide feasibility |
| Solver | satisfy constraints; pick flex/grid; normalize sizing | decide what the layout becomes |
| Compiler | emit CSS | make design decisions |
| Verifier | confirm | redesign |

## Roadmap

Each phase gets an explicit `GATE:` line. A phase is not done until its gate passes by the user's eye.

- **P0 Perception stability probe — PASSED** (min Jaccard 0.861). GATE: min Jaccard ≥ 0.80 across
  reloads on all 5 grid sites — MET (worst 0.861).
- **P1 Deterministic semantic role graph — PASSED** (roleStab ≥ 0.990). GATE: role-distribution
  stability ≥ 0.90 on all 5 sites — MET (worst 0.943).
- **P2 Intent DSL + design packs + conformance — machinery PASSED, BY-EYE GATE FAILED.** GATE:
  5/5 sites apply + the user's by-eye judgment — machinery green but the user said "nothing is good".
  The verdict is architectural (see Current position): the engine restyles the original DOM; it never
  re-lays-out the page.
- **P2.5 Layout IR + Responsive Solver v1 — CURRENT (steps 1–8).** GATE (this phase): IR stability
  gate (Step 1) + all 6 hard gates clean on the 3 validation sites + parity vs the original on those 3
  + resize 1920/1440/1280 no breakage + slot invariant + BBC/YouTube apply-without-rollback. The user's
  eye is the only PASS authority.
- **P2.6 Stress sites BBC + YouTube — 5/5-applied beauty gate returns here.** GATE: 5/5 sites applied
  + by-eye beauty on BBC + YouTube under the exclusion registry.
- **P3 Migration completion + BRUTAL DELETION.** Only AFTER the v2 flag is switched on and parity
  holds. Deletion is LAST, never first. GATE: v2 is the default path, v1 deleted, parity holds on the grid.
- **P4 Prevention-by-construction** — repair becomes structurally rare.
- **P5 Role-anchored stable handles** — handles survive resize/relayout (may be pulled forward if the
  IR probe proves node identity unstable on resize — see the pre-authorized blocked outcome).
- **P6 CONDITIONAL post-render visual verifier (Kimi)** — fired ONLY when the structural pipeline
  reports uncertainty. Not always-on. Planning stays text-based for cost and latency.
- **P7 Additional layout languages** (Magazine, Dashboard, Editorial) — only AFTER one language is
  proven end to end.
- **P8 Remaining primitives** (motion, depth, density).

### P2.5 temporary gate rebase (recorded so the docs don't contradict the standing rules)

The standing rule is "applied ≥4/5" on the full grid. P2.5 narrows this deliberately:

- P2.5 by-eye gate = **MDN, Wikipedia, GitHub docs (3 sites)** — architecture validation, not stress.
- **BBC + YouTube in P2.5 must only APPLY WITHOUT ROLLBACK** under the new exclusion registry. Their
  appearance is NOT judged this phase — that is the P2.6 gate.
- The full **5/5-sites-applied beauty gate RETURNS as the Phase 2.6 gate.**
- Rationale, verbatim: *"Don't touch BBC or YouTube first. Those are stress tests, not architecture validation."*

## Migration policy (law)

Build new path -> reach feature parity -> switch the flag -> THEN delete obsolete code. Never delete
before migration. **Parity is measured against the ORIGINAL PAGE, not against our current output.**
Six criteria, all required: no clipped content / no hidden content / responsive after resize / reading
order preserved / interactive elements still work / no visual regressions beyond the accepted
transformation.

## V1 primitives — exactly six

Layout, Spacing, Typography, Surface, Color, Hierarchy. Motion, depth and density come later.
Blending between design languages is PER-PRIMITIVE COMPOSITION, NEVER INTERPOLATION (deterministic
and explainable: Layout=Dashboard, Typography=Editorial, Surface=Glass, Color=Minimal, Spacing=Apple,
Hierarchy=Magazine).

## DOM policy

CSS-only by default. Minimal DOM restructuring ONLY to escape impossible ancestry, clipping,
stacking contexts, or impossible slot placement. NEVER REBUILD THE TREE. NEVER blindly replace an
existing Flexbox or Grid container — WRAP it or work at a higher semantic boundary. NEVER re-lay-out:
Shadow DOM, virtualized lists, carousels, editors, canvas, SVG, maps, video players, JS-controlled
layout components. (Restyling those is still allowed. Re-layout is not.)

## Reading order is inviolable

Visual order must follow DOM order unless the user explicitly asks otherwise. No `order` or arbitrary
`grid-area` placement that makes keyboard navigation and screen readers diverge from what users see.
Accessibility wins over aesthetics.

## Verification contract

- **HARD GATES (fail the build):** overflow, clipping, hidden content, horizontal scrolling, element
  overlap, reading-order violations (DOM order vs visual order).
- **ADVISORY SCORES (guide only, never block):** alignment consistency, spacing consistency, hierarchy
  preservation, whitespace balance, vertical rhythm.

## Standing rules (non-negotiable)

- Target device is DESKTOP/LAPTOP. No mobile-viewport work.
- ZERO site-specific hardcoding. Aesthetic recipes allowed; site recipes forbidden. Never branch on a
  hostname, ever. (Test fixtures MAY name sites — they need real nav/structure targets. Product code
  may never.)
- REAL PROOF ONLY: real extension, real sites, real model calls. Never pass a check by loosening it.
- ONE-SHOT MANDATE: best result in the existing paid-call budget (2 on the happy path). Phase 2.5 adds
  ZERO new paid calls. Archetype choice folds into the existing Architect call.
- NEVER PARTIALLY APPLY A DESIGN. If the planner fails or times out: abort, or fall back to the last
  fully valid plan. Never half-new/half-old output.
- MATCHED-TARGETS = 0 IS A COMPILER ERROR, not a silent skip. Every transformation reports:
  targets requested / matched / modified. If matched = 0, fail loudly.
- YOU MAY NEVER READ SCREENSHOTS OR PNG FILES. The active models are text-only. ONE exception: an
  advisory, never-in-pipeline self-check via @cf/moonshotai/kimi-k2.7-code, max 1 call per run. The
  user's eye is the only PASS authority.
- ANTI-LOOP: max 3 fix cycles per failing check, then STOP and report honestly with data. Iterate on
  smoke tier only. Max 2 full-grid runs this session. Single commit at the end. An honest blocked
  report is a SUCCESS.
- SCOPE DISCIPLINE: extend existing modules. The allowed new files are listed per step and that list
  is exhaustive. No speculative abstraction.
- FLAG AND STOP on anything out of scope. Do not fix it.
- Security/git: `.env` stays gitignored (public repo); push only after proven slices. Quality over speed.

## Explicitly deferred (do not build early)

Interaction languages, motion languages, domain languages, twelve-primitive taxonomies, multi-pass
global layout optimization.

## Current position

**P2.5 — Layout IR + Responsive Solver v1 (in progress).** Phase 2's machinery passed every gate
(0% escape-hatch usage, conformance clean, 2 paid calls, MDN code examples intact) but the user judged
the output by eye and said "nothing is good." The verdict is architectural, not a bug list: the engine
RESTYLES the original DOM cluster-by-cluster; it never RE-LAYS-OUT the page. A senior engineer's
architecture is now LOCKED (the one architectural rule + the 10-stage pipeline above). This phase
builds the two missing stages: a Layout IR and a Responsive Solver.

**Step 1 (IR stability probe) is the hard gate before any solver work.** If the IR is unstable across
near-identical renders, everything built on top is unstable. Node identity may legitimately drop on
resize (geometry-derived handles re-cluster) — that is NOT a defect; it is evidence Phase 5
(role-anchored stable handles) must be pulled forward ahead of the solver. An honest blocked report
on Step 1 is the correct outcome.

**Step 1 RESULT (BLOCKED, 2/5 sites pass):** the IR *construction* is stable (constraint no-Ordering
0.965–1.000; the 5 new perception fields at 1.00 everywhere). The gate fails on perception-layer
outputs the IR projects verbatim: `role` (Wikipedia 0.875, GitHub 0.812 — `classifyRole`'s
viewport-coupled geometry thresholds reclassify clusters under resize/zoom/reorder) and `handle
identity` (YouTube 0.808 across ALL perturbations, not resize-only — visual-signature re-clustering of
the dense feed). Per the rules the classifier/clustering were NOT tuned to pass. **The solver (Step
2+) is NOT started.** Open decision: accept role-label instability (treat role as advisory), revisit
the classifier's viewport-coupled thresholds, or pull Phase 5 (role-anchored stable handles) ahead of
the solver — which would stabilize both role and YouTube identity. This blocked report is the honest
outcome the phase sanctioned.

## Status update protocol (for ALL agents)

- Flip a sub-phase checkbox to `[x]` ONLY after it is genuinely, honestly done: proven by eye on real
  sites through the real popup→Transform flow, with before/after screenshots and an honest report.
  Green automated checks alone are NOT enough.
- When you flip a box, also rewrite the "Current position" section above (and keep the root `AGENTS.md`
  consistent if it names the phase).
- Never mark done to please anyone. A false "done" is the worst failure in this project.

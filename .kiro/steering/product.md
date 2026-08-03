---
inclusion: always
---

# Revueon — Product Steering & Roadmap

This is not just an extension — this is an AI agent that lives in your browser. Revueon reshapes
ANY website in plain English — locally, never the site's backend. Endgame: replace EVERY browser
extension. The moat is generality: principles, not recipes.

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
  -> Transformation        (what it should become: relations + archetype + slots)
  -> Target Layout IR      (NEW object, never a mutation of Current)
  -> Responsive Solver     (make it feasible and responsive)
  -> Responsive CSS        (compiler emits, decides nothing)
  -> Runtime Verification  (confirms; never redesigns)
  -> DOM Patch
```

Perception answers "what is this?". Layout IR answers "how is it arranged?".
Keep them separate stages, each with a single responsibility.

The relational vocabulary SURVIVES and stays the model's only contract. The model must NEVER emit raw layout
constraints. The transformation engine sits BELOW the model:
`Relations -> Transformation Engine -> Target Layout IR -> Solver -> CSS`.

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

- **P0 Perception stability probe — PASSED.** GATE: min Jaccard ≥ 0.80 — MET (worst 0.861).
- **P1 Deterministic semantic role graph — PASSED.** GATE: role-distribution stability ≥ 0.90 — MET (worst 0.943).
- **P2 Intent DSL + design packs + conformance — machinery PASSED, BY-EYE GATE FAILED.** The engine
  restyles the original DOM; it never re-lays-out the page.
- **P2.5 Layout IR + Responsive Solver v1 — IN PROGRESS.** GATE: IR stability gate + all 11 hard gates
  clean on 3 validation sites + parity vs the original + resize no breakage + slot invariant +
  BBC/YouTube apply-without-rollback. The user's eye is the only PASS authority.
- **BUILD SWEEP 1A — Law 0 (A1-A9) — BUILT, NOT VERIFIED BY EYE.** Gate: typecheck+build+lint only.
  Committed (342d433 + ff1a406). PENDING: by-eye verification.
- **BUILD SWEEP 1B — Trust + carry-overs (B1-B12) — BUILT, NOT VERIFIED BY EYE.** Gate: typecheck+build+lint
  only. Committed (c407077). PENDING: by-eye verification.
- **BUILD SWEEP 1C — Sight (C0-C11) — IN PROGRESS.** Gate: typecheck+build+lint only. Perception
  enrichment: heading outline tree, semantic compression, colour model, component taxonomy, density/
  rhythm/alignment, shadow-DOM read-back, text understanding, serialization format. See `docs/` for
  the moved P2.5 gate rebase decision and the pixel-gate standing rule.
- **P2.6 Stress sites BBC + YouTube — 5/5-applied beauty gate.** GATE: 5/5 sites applied + by-eye
  beauty on BBC + YouTube under the exclusion registry.
- **P3 Migration completion + BRUTAL DELETION.** Only AFTER the v2 flag is switched on and parity
  holds. Deletion is LAST, never first. GATE: v2 is the default path, v1 deleted, parity holds on the grid.
- **P4 Prevention-by-construction** — repair becomes structurally rare.
- **P5 Structural identity + sticky roles — DONE.** Handles derived from DOM structure (tag +
  nth-of-type chain + stable attrs), not appearance. Role/slot stability 1.000 on all 5 sites.
- **P6 CONDITIONAL post-render visual verifier (Kimi)** — fired ONLY when the structural pipeline
  reports uncertainty. Not always-on.
- **P7 Additional layout languages** (Magazine, Dashboard, Editorial) — only AFTER one language is
  proven end to end.
- **P8 Remaining primitives** (motion, depth, density).

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
- ONE-SHOT MANDATE: best result in the existing paid-call budget (2 on the happy path).
- NEVER PARTIALLY APPLY A DESIGN. If the planner fails or times out: abort, or fall back to the last
  fully valid plan. Never half-new/half-old output.
- MATCHED-TARGETS = 0 IS A COMPILER ERROR, not a silent skip.
- YOU MAY NEVER READ SCREENSHOTS OR PNG FILES. The active models are text-only. ONE exception: an
  advisory, never-in-pipeline self-check via @cf/moonshotai/kimi-k2.7-code, max 1 call per run. The
  user's eye is the only PASS authority.
- ANTI-LOOP: max 3 fix cycles per failing check, then STOP and report honestly with data. An honest
  blocked report is a SUCCESS.
- SCOPE DISCIPLINE: extend existing modules. No speculative abstraction.
- FLAG AND STOP on anything out of scope. Do not fix it.
- Security/git: `.env` stays gitignored (public repo); push only after proven slices. Quality over speed.
- **Pixel gates assert physics only** (see docs/ARCHITECTURE.md for the full rule): readable, no
  overflow, no overlap, not blank, capture succeeded. Design quality is the planner's job and the
  user's eye. Whether the relayout happened is asserted at emit time from the solver's own plan, never
  inferred from pixels.

## Explicitly deferred (do not build early)

Interaction languages, motion languages, domain languages, twelve-primitive taxonomies, multi-pass
global layout optimization.

## Current position

**BUILD SWEEP 1D — VOICE (E0-E8) — BUILT, NOT VERIFIED BY EYE.** Committed (2d15312). The relational
vocabulary + deterministic transformation engine replace the old enum-based expander. 31 relation types
in a discriminated union (size, rank, spacing, alignment, elevation, colour, width, surface, typography,
layout, structural ops) + PackPrinciples as checkable data. The model states relations ("this heading is
3× the body size", "this section outranks its neighbours") instead of picking from 4-value enums. The
engine resolves each relation against perception → Target Layout IR, emitting pack tokens (never raw
px — Law 0). Boundary validator rejects invalid relations individually. Review subagent found 4 defect
categories (semantic duplicate paddingSide, silent emphasisRank drop, dead marginEquals prompt, Law 0
violation in lineHeightRatio, unenforced minTypeScaleRatio); all fixed. Gate: typecheck + build + lint +
self-check pass clean. No site runs, no paid calls.

**Prior: BUILD SWEEP 1C.2 — SIGHT, DEEP (D0-D12) — BUILT, NOT VERIFIED BY EYE.** All 13 items committed across
5 phases (a46f9c6 → 1328c8b). Gate: typecheck+build+lint pass clean on a tree with tests/ inside typecheck.
This sweep builds the model layer: position/spatial, typography as a system, background/transparency/
elevation, fixed/sticky/scroll, borders/shape/surface language, density/rhythm/room, media inventory,
landmarks/interactive inventory, dynamism/safety flags, confidence/provenance on everything, and a
serializer that references page-level models from regions. No site runs, no paid calls.

**Prior: BUILD SWEEP 1C — SIGHT (C0-C11) — BUILT, NOT VERIFIED BY EYE.** All 12 items committed (46f3919).
Gate: typecheck+build+lint pass clean. This sweep enriches perception so the model sees what it's
designing: heading outline tree, semantic compression by merging, colour as an HSL model,
component-type taxonomy, density/rhythm/alignment, shadow-DOM read-back, text understanding, and a
new serialization format.

**Prior: BUILD SWEEP 1B — Trust + 1A carry-overs — BUILT, NOT VERIFIED BY EYE.** All 12 items (B1-B12)
committed (c407077). Gate: typecheck+build+lint only.

**Prior: BUILD SWEEP 1A — Give Layout Back to the Browser (Law 0) — BUILT, NOT VERIFIED BY EYE.** All 9
items (A1-A9) committed (342d433 + ff1a406). Measurement-derived values purged from the solver and
compiler; constraint-driven emission replaces geometry-driven emission.

**Prior: P2.5 — Steps 1-9 explored the v2 solver path.** CSS-only grid placement (zero DOM mutation)
achieved 9/9 hard gates on all 3 doc sites in replay, but the by-eye gate consistently failed (MDN
renders as 1 visual column; Wikipedia+GitHub overflow/collapse on SPA re-render). The architecture is
proven; the design quality is the user's eye, not the gate's.

## Status update protocol (for ALL agents)

- Flip a sub-phase checkbox to `[x]` ONLY after it is genuinely, honestly done: proven by eye on real
  sites through the real popup→Transform flow, with before/after screenshots and an honest report.
  Green automated checks alone are NOT enough.
- When you flip a box, also rewrite the "Current position" section above (and keep the root `AGENTS.md`
  consistent if it names the phase).
- Never mark done to please anyone. A false "done" is the worst failure in this project.

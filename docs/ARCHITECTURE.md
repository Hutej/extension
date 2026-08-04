# Revueon — Engine Architecture

*(Read this before touching `project/src/`. Loaded ON DEMAND, not in every prompt — it can afford
detail. If any fact here disagrees with the code, THE CODE WINS: verify against the code and update
this file.)*

## The one architectural rule

> The AI is responsible for design decisions, the Layout IR is responsible for expressing structure,
> the solver is responsible for satisfying constraints, and the compiler is responsible for generating
> CSS. No layer is allowed to take over another layer's responsibility.

**Law 0 — Browser Ownership of Layout** (`docs/LAW_0_BROWSER_OWNERSHIP.md`): the browser
owns layout; we hand it constraints and let it solve. Every emitted length carries provenance
(`token | authorConstraint | intrinsic | measurement`); measurement-provenance lengths are
hard-rejected at emission. Emission is constraint-driven, not measurement-driven. Viewport units
and measurement-derived values are purged. Container queries replace viewport breakpoints. The
existing formatting context is preserved, not flattened. Read the law before any layout emission
change.

## One pipeline (BUILD SWEEP 1F — convergence)

The v1/v2 fork is DELETED. There is now ONE pipeline; the `layoutCompiler` flag is gone
(no `RV_LAYOUT_COMPILER` env, no popup dev toggle).

```
perceive -> Architect+Painter (parallel) -> mergeSpecs -> ops -> solver (structural CSS via
computeGridPlacementCss) -> compileSpec (aesthetic CSS) -> combine -> apply -> verify -> repair -> persist
```

Happy path: **2 paid calls** — Architect (structure/relations/pack) and Painter (surface) run in
parallel on the same perception. The relation language SURVIVES: the model still emits relations;
the engine maps relations → Target IR constraints. The solver sits BELOW the engine and emits
structural CSS via `computeGridPlacementCss`; `compileSpec` emits aesthetic CSS. The two are combined
and applied, then verified, repaired (re-solve, never patch CSS), and persisted.

## Target Layout IR

The declared destination page expressed as constraints the browser re-solves. `TargetLayoutIR` in
`layout/ir.ts` carries: `archetype` (from a shortlist), `tracks` (fr proportions + `minmax()` floors —
never measured widths), `slotAssignment` (handle → track index), `spans`, `adjacency`, `readingOrder`,
`slotBehaviour` (per-track direction/wrap/alignment), `unsatisfiable` (reported, never silent).

Four archetypes: `single-column`, `two-column-rail-left`, `two-column-rail-right`, `three-column`.

`buildFallbackTargetIR()` converts a deterministic `assignSlots` result → Target IR when the model
emits no composition relations. `resolveComposition()` in `compile/transform.ts` builds the Target IR
from the model's composition relations when they are present.

## Composition vocabulary (BUILD SWEEP 1F)

Nine new relations let the model declare page structure (added to the existing relation language):

`archetype`, `assignSlot`, `trackAllocation` (fr ratios with `minmax()` floors), `adjacentTo`,
`spansTracks`, `readBefore`, `stackDirection`, `wrapBehavior`, `prominentFirst`.

Each is a typed relation, validated at the boundary, resolved into the Target IR, satisfiable by the
solver, and present in the Architect prompt. **No magnitude is a pixel.** The solver emits
`fr` / `minmax()` / `fit-content` — never fixed tracks derived from measured widths.

## Wiring audit (permanent gate)

`npm run audit:wiring` is a permanent gate. It fails when:
- a vocabulary relation is missing `RELATION_SPECS` / prompt / validator / emission, or
- a `PackPrinciples` field is never read, or
- an exported symbol has no non-test caller (warn).

Run it with `npm run audit:wiring`.

## Pixel leaks fixed (BUILD SWEEP 1F)

Three pixel-provenance leaks are now pack-derived instead of hardcoded:
- `hoverElevate` `translateY` — from `spacingScale`/`borderScale`.
- `focusRing` outline width/offset — from `borderScale`.
- `movable` keyboard step — from `spacingScale`.

`groupWith` returned to advisory (display:flex only, no forced direction).

## columnCount split (BUILD SWEEP 1F)

`columnCount` is renamed to `proseColumns` (multi-column text flow). Page layout tracks no longer route
through `columnCount`; they route through the `trackAllocation` composition relation.

## BUILD SWEEP 1G — Conformance

### Three relationship relations made real (H1)

`adjacentTo`, `readBefore`, `prominentFirst` were silently dropped in 1F (populated IR fields the
solver never reads). They now satisfy through **placement** — they adjust `slotAssignment`, which
the solver emits as `grid-column`. That IS the emission path. The `adjacency`/`readingOrder` arrays
remain as records for conformance verification, not emission.

The honest accessibility constraint replaces the Law 0 misattribution: Law 0 governs measurement-
derived lengths, not ordering. Ordering is a valid IR constraint kind, and grid placement IS
browser-solved ordering. The real constraint: visual order diverging from DOM order breaks screen
readers and tab sequence. Handling: prefer placement (grid-column, preserves DOM order via auto-row-
placement) over CSS `order` (breaks it). Where DOM order must change, use the DOM op path
(`reorderBefore` with a real `MutationReason`).

`prominentFirst` now consumes the focal point perception (`perception.spatial.focalPoint`), which
was computed but never had a consumer.

### Wiring audit hole closed (H2)

A validation path is not an emission path. The audit now checks that a composition relation's case
block modifies a solver-read IR field (`slotAssignment`, `spans`, `tracks`, `slotBehaviour`), not just
pushes to `adjacency`/`readingOrder`/`unsatisfiable` (which the solver never reads). A relation whose
sole possible outcome is unsatisfiable fails the audit. After the fix: 46/46 pass.

### File split (H4)

`content.ts` (1585→1218 lines) extracts 6 implementation blocks into modules. `transform.ts`
(743→412 lines) splits the relation switch into 9 domain modules (spacing, typography, hierarchy,
surface, color, layout, motion, ops, interaction). Pure moves, no behaviour change. The dispatcher
iterates relations in original order (accent budget + style merge are order-sensitive).

### Constraints removed (H5)

- `reasoning_effort`: per-role. Architect 'medium' (structure needs thinking), Painter 'low' (parallel
  — adds cost, not latency), Critic 'low'. `RV_EFFORT` env is a global floor.
- Intent cap: not found in the relational path (deleted with the old enum system). Bounded by model
  token budget + time budget.
- Law 0 rule 5 amended: viewport units (vw, vh) are a defect when the viewport is not the reference.
  Where it genuinely is, use dvh/svh — never vh or vw for content sizing.
- `--rv-side-max`: 280px → `min(280px, 30cqi)` (proportional bound: 30% of container inline-size,
  capped at 280px).
- `65ch`: renamed `--rv-content-max` → `--rv-prose-max`. Applied ONLY to prose roles
  (article-body, metadata, toc) via `max-width` in per-node declarations. Never to listings, navs,
  or chrome.
- Call budget restated: one round trip of latency (parallel design stage), cost reported separately
  (call count). 2 calls + 1 round trip = happy path.

### Conformance verification (H6)

10 structural checks in `verify/conformance.ts`, all comparing rendered DOM against the
`TargetLayoutIR` (not taste):
1. Archetype conformance — declared vs measured column count. Distinguishes "chose single-column"
   (PASS) from "declared multi but collapsed" (FAIL).
2. Track conformance — declared fr ratios vs measured track proportions (25% tolerance).
3. Slot conformance — every declared slot renders in its assigned track.
4. Reading order conformance — rendered + DOM order match declared order (accessibility).
5. Spacing conformance — every emitted spacing traces to a pack scale step.
6. Type ramp conformance — sizes on ramp, monotonic across hierarchy.
7. Accent budget — accent count within `maxAccentCount`.
8. Elevation — shadow/border from pack scale.
9. Measure — prose line length + line-height in readable band.
10. Unsatisfiable reporting — every solver-unsatisfiable constraint in report. A run with
    unsatisfiables is not a clean run.

Proxy gates retired: `changed`, `coherent`, `covered`, `layoutReshaped`, `usesRoom` demoted to
advisory (can pass on an unchanged page). Physics gates (notBlank, noOverflow, noOverlap,
contrastOk, contentIntact, contentVisible, movedAlive) + reflow check stay as hard gates.
**No aesthetic score** — not as a gate, not as a number.

## The Layout IR type schema (`src/core/layout/ir.ts`)

Four sections per node, no more. **Immutability is a contract, not a convention:** the Current IR is
deep-frozen (`Object.freeze` recursively); any mutation throws in dev. The Target IR is a NEW object
built from the frozen Current IR, never a mutation of it.

- **`semantic`** — `role: DesignRole`, `confidence`, `dominanceRank`, `group`.
- **`authoredLayout`** — `display`, `flow` (row/column/none), `isContainer`, `isFlex`, `isGrid`,
  `flexWrap`, `intrinsicSizing` (auto/fixed/fluid), `position` (static/relative/absolute/fixed/sticky),
  `centered`, `widthRatio` (bucketed to 0.05).
- **`computedRelationships`** — `parent` (handle|null), `children[]` (DOM order), `siblings[]`,
  `alignment` (start/center/end/stretch/mixed), `ordering` (sourceOrder index), `grouping`.
- **`targetConstraints`** — `LayoutConstraint[]`. EMPTY in the Current IR (extraction populates none).
  Populated ONLY in the Target IR by the transformation + the solver. **The model NEVER assigns
  priority.**

`LayoutIR` = `{ viewport, nodes[], byHandle }`. `extractLayoutIR(perception): LayoutIR` is PURE (no
DOM — perception already captured the computed styles). `currentConstraints(node): LayoutConstraint[]`
derives the page's CURRENT arrangement as constraints (the seed the Target IR extends; the probe's
stability signature).

## Constraint vocabulary, priority levels, priority sources

Vocabulary (semantic, not measurements): `FillParent`, `Centered`, `StackVertically`,
`WrapOnOverflow`, `MaxWidth`, `AspectRatio`, `Gap`, `Alignment`, `Ordering`.

Every constraint carries:
- `priority: 'required' | 'preferred' | 'optional'`
- `source: 'law' | 'language' | 'intent'`

Priority is assigned by, in descending authority: **Browser Laws -> Layout Language -> Transformation
Intent. THE MODEL NEVER ASSIGNS PRIORITY.** Required = accessibility, reading order. Preferred =
fill parent. Optional = center horizontally.

Current-IR derivation (`currentConstraints`, source always `law`): `Ordering` (required) on every
node; `Ordering` value `out-of-flow` when `position` is absolute/fixed; `StackVertically` (preferred)
for flex-column/block containers; `Alignment` (preferred) for flex-row containers; `WrapOnOverflow`
(preferred) when `flexWrap`; `FillParent` (preferred, value `partial` when `widthRatio < 0.97`);
`Centered` (optional) when `centered`; `AspectRatio` (preferred) when `naturalAspect` present;
`MaxWidth` (value `partial`) when an authored fixed/fluid width < parent.

## Layout language schema + the Documentation instance

A layout language is NOT CSS and NOT HTML. It defines slots, relationships, constraints, grid
preference and priority rules. Each slot declares: `id`, `allowedRoles[]`, `preferredWidth`,
`flow`, `ordering`, `minWidth`, `constraints[]` (each with priority). The pipeline ships exactly ONE language:
**Documentation** (predictable, information-dense, mostly static, responsive, few JS layout
assumptions). Do NOT build a second language yet.

**Documentation slots:** `masthead`, `nav-local`, `toc`, `main`, `aside`, `footer`, `overflow`.

**The Overflow Slot is mandatory and must not become a junk drawer:** it sits at the end of document
flow, full-measure, preserves the original relative order and stacking of its members, inherits
main's typography, and is never hidden and never visually degraded. Nothing disappears. Nothing
duplicates. Unmatched/unknown content goes here.

## Slot-assignment algorithm + invariant assertions

Slot assignment is DETERMINISTIC. The model's ONLY layout decision is choosing one archetype by id.
Sequence: `Semantic Model -> Role Graph -> Slot Assignment -> Target Layout IR`.

Invariant, enforced with assertions that THROW (a violation is a compiler error, same class as
matched-targets = 0):
- every semantic node is assigned to EXACTLY ONE slot;
- unmatched or unknown content goes to the Overflow Slot;
- sum of slot memberships == node count;
- no node appears twice.

## Solver stages (`src/core/layout/solve.ts`)

IN SCOPE, all five:
1. validate constraints
2. propagate parent constraints to children
3. choose the Flex or Grid algorithm per container
4. normalize sizing (auto, %, `clamp()`, `minmax()`)
5. emit responsive CSS

OUT OF SCOPE — do NOT build: complex constraint relaxation, multi-pass optimization, global
layout optimization.

Conflict handling is a deterministic priority sort, NEVER "first wins": required beats
preferred beats optional. Every dropped optional constraint is logged with its node and reason. If
two REQUIRED constraints conflict, mark that node IMPOSSIBLE and hand it to the ops fallback. Never
silently pick one.

**Worked propagation example:** parent has `MaxWidth 1200` and child has `FillParent` -> emit
`width: min(100%, 1200px)`. Do not refuse. Do not pick one.

## Sizing-normalization patterns + the exact fluid token set

Emit exactly these, applied ONLY at semantic text levels (body, headings, captions). Do NOT make
every nested element fluid; inheritance compounds and the page collapses.
```
--step-0: clamp(1rem, 0.95rem + 0.3vw, 1.125rem);
--step-1: clamp(1.25rem, 1.1rem + 0.8vw, 1.6rem);
--step-2: clamp(1.6rem, 1.3rem + 1.2vw, 2.3rem);
--space-s: clamp(8px, 1vw, 12px);
--space-m: clamp(16px, 2vw, 24px);
--space-l: clamp(24px, 3vw, 40px);
```
This fixes a verified defect: the compiler currently freezes fontSize, padding, maxWidth,
radius and border as raw px. Spacing and type are non-fluid
today; route them through the token set.

## Exclusion registry (`src/core/layout/exclusions.ts`)

Principled detection (NO hostnames, NO site names) marking subtrees `relayout: false` while leaving
`restyle` allowed:
- shadow root present on the element
- tag is canvas / svg / video / iframe / object
- `contenteditable`, or `role=textbox/application`
- carousel signature: `aria-roledescription="carousel"`, or a track element with `transform:
  translate` + `overflow: hidden` + siblings of equal width
- virtualization signature: absolutely-positioned children with translate offsets inside an
  overflow-hidden container whose child count changes on scroll
- JS-controlled layout: inline style writes to width/height/transform observed changing between
  two samples
- map signature: canvas or tiled absolutely-positioned children under a container with a
  wheel/pointer handler

**WRAP-DON'T-REPLACE rule:** if a target node's computed display is flex or grid and it has children
we did not author, you may NOT replace its layout. Wrap it, or move up to a higher semantic boundary.

This is the prime suspect for the BBC and YouTube contentCollapse rollbacks deferred for ten rounds.
The proof report explicitly states whether it resolves them.

## Wrapper lifecycle policy

Mark injected wrappers with a `data-*` attribute; they are disposable runtime layout scaffolding
and never part of the application's semantic DOM. Adding a wrapper is NOT rebuilding — the child is
untouched, no event listeners move, no React state changes, no IDs change. On SPA re-render: if the
framework destroyed it, reapply; if not, reuse.

## Verification: how each hard gate is measured

HARD GATES (any one failing fails the run), measured on the applied DOM:
- **overflow** — `scrollWidth` delta vs before exceeds `MAX_OVERFLOW_RATIO`.
- **clipping** — a region whose visible box shrank below `MIN_COMPONENT_WIDTH_FRACTION` of its
  natural content.
- **hidden content** — opacity < 0.1 or `contentVisible` flag.
- **horizontal scrolling** — `documentElement.scrollWidth > viewport.w + tolerance`.
- **element overlap** — new region collisions vs the original page (delta, so pre-existing floats
  never false-fail).
- **reading-order violations** — DOM order vs visual order divergence (no `order`/arbitrary
  `grid-area` that splits keyboard/SR from sight).

ADVISORY SCORES (computed, logged, never blocking):
- **alignment consistency** — fraction of shared edges/centers that agree across siblings.
- **spacing consistency** — `1 − (variance of repeated gaps ÷ mean gap²)`.
- **hierarchy preservation** — heading-scale rank order preserved + role prominence order preserved.
- **whitespace balance** — distribution of free space (Gini of inter-region gaps; lower = more even).
- **vertical rhythm** — consistency of vertical spacing (`1 − (stdev of vertical gaps ÷ mean)`).

## Repair-as-re-solve + ops fallback

Repair is: **Target IR -> relax constraints -> re-resolve ->
re-emit CSS.** Repair must not edit CSS directly; it modifies the constraint graph and regenerates.

**OPS FALLBACK:** keep move/remove/reorder. They are no longer primary — they are the fallback for
what CSS cannot express: `Solver -> impossible? -> minimal DOM operations -> solve again`. The laws
layer STAYS; it defines the invariants the solver must respect.

## Module map (`src/core/layout/`)

| File | Owns |
|---|---|
| `ir.ts` | the Layout IR type, `extractLayoutIR` (pure), `currentConstraints`, `deepFreeze` |
| `exclusions.ts` | the exclusion registry + detection heuristics |
| `languages/documentation.ts` | the Documentation layout language as PURE DATA (slots + constraints) |
| `assign.ts` | deterministic slot assignment + invariant assertions |
| `candidates.ts` | deterministic composition detection -> 3–5 archetype candidates |
| `solve.ts` | the solver (validate, propagate, flex/grid, normalize, emit CSS) |
| `verify.ts` | hard gates + advisory scores on the applied DOM |

## IR stability probe methodology + measured numbers

The probe (`tests/probe/layout-ir.test.ts`), 0 paid calls, 5 grid sites. Perturbations: resize
(1920/1440/1280), zoom (viewport ÷ factor: 125%→1536px, 150%→1280px — coincides with the 1280 resize,
reported once), SPA route change (GitHub), lazy-load (scroll-to-bottom), minor DOM mutations
(insert/remove/reorder). Metrics per site per perturbation: node identity (Jaccard), parent/child,
role, constraint stability (reported WITH and WITHOUT `Ordering`; gate reads WITHOUT-Ordering), plus
per-constraint-kind flip rates and per-field stability for the 5 new perception fields.

Gates: parent/child ≥ 0.90, role ≥ 0.90, node identity ≥ 0.85, constraint (no-Ordering) ≥ 0.85, on
all 5 sites. Pre-authorized blocked outcome: if the gate fails ONLY on resize node-identity, that is
expected (geometry-derived handles re-cluster) — STOP and recommend pulling role-anchored stable handles ahead of the
solver; never tune clustering to green the number.

**Measured numbers (full 5-site grid, 0 paid calls, 1 full-grid run):**

| Site | worst id | worst pc | worst role | worst con(no-Order) | fields | GATE |
|---|---|---|---|---|---|---|
| Wikipedia | 0.964 | 0.938 | 0.875 | 0.988 | 1.00 | FAIL (role) |
| MDN | 0.989 | 1.000 | 0.924 | 1.000 | 1.00 | PASS |
| BBC | 0.922 | 1.000 | 0.959 | 0.980 | 1.00 | PASS |
| GitHub | 0.988 | 0.965 | 0.812 | 0.965 | 1.00 | FAIL (role) |
| YouTube | 0.808 | 0.979 | 0.773 | 1.000 | 1.00 | FAIL (identity+role) |

**Verdict: BLOCKED (2/5 pass).** The IR *construction* (`extractLayoutIR` + `currentConstraints`) is
stable — constraint(no-Ordering) 0.965–1.000 and the 5 new perception fields at 1.00 everywhere. The
two failure classes live in the **perception layer** the IR projects verbatim:

- **`role` instability (Wikipedia, GitHub):** `classifyRole` uses viewport-coupled geometry thresholds
  (`isLeft`/`isRight`/`widthRatio`/`rectY`). Under resize/zoom/reorder the geometry shifts and clusters
  near a threshold reclassify. This is a perception-CLASSIFIER property, not an IR-derivation defect.
- **`handle identity` instability (YouTube):** handles are signature-hashed from visual signature;
  YouTube's dense feed re-clusters ~18–19% of handles under *any* perturbation (not resize-only), so it
  does NOT qualify for the pre-authorized resize-only-identity blocked outcome.

Per the rules, the classifier and clustering were NOT tuned to pass. The amendment-#2 split was
decisive: with-`Ordering` constraint stability collapses to 0.247–0.859 (Ordering flips 4–75%); the
no-`Ordering` gate number is the stable one (0.965–1.000). Resolution is a user decision: accept
role-label instability (treat role as advisory; the IR structure is stable), revisit the classifier's
viewport-coupled thresholds, or pull role-anchored stable handles ahead of the solver —
which would stabilize BOTH role and YouTube identity by decoupling from geometry/signature.

## Model transport

Architect (structure/relations/pack) + Painter (surface) run in parallel on `@cf/zai-org/glm-5.2`;
Critic repairs on `@cf/zai-org/glm-4.7-flash`. Archetype choice folds into the existing Architect call
(zero new paid calls). One attempt, ≤120s hard abort; retries only 429/5xx; tokens logged per run. No
fallback chain. Key in `project/.env` (`OPENAI_API_KEY`, gitignored) — Cloudflare Workers AI
OpenAI-compatible endpoint is the live path.

## Hard-won lessons (do not relearn these)

- A node cap amputates the page — below-fold content is never perceived. No node cap; see the whole page.
- `keep: true` was a loophole — removed; base-coat covers unaccounted clusters.
- `overflow-wrap: anywhere` collapses min-content and breaks every word. Targeted `break-word` repair
  only, never preventive `anywhere`.
- A px ceiling is zoom-hostile; convert to a viewport-relative percentage.

## Temporary gate rebase (a decision, not a change record)

The standing rule is "applied ≥4/5" on the full grid. The current step narrows this deliberately:

- By-eye gate = **MDN, Wikipedia, GitHub docs (3 sites)** — architecture validation, not stress.
- **BBC + YouTube must only APPLY WITHOUT ROLLBACK** under the exclusion registry. Their
  appearance is NOT judged yet — that is the next gate.
- The full **5/5-sites-applied beauty gate returns at the next gate.**
- Rationale, verbatim: *"Don't touch BBC or YouTube first. Those are stress tests, not architecture validation."*

## Standing rule: pixel gates assert physics only (moved from product.md)

Pixel gates assert physics only — readable, no overflow, no overlap, not blank, capture
succeeded. Design quality is the planner's job and the user's eye. Whether the relayout
happened is asserted at emit time from the solver's own plan, never inferred from pixels.
- Cheating a gate is the only way to fail a step. An honest blocked report is a success.

## Selector strategy

The pipeline uses **structural selectors as primary**, with `[data-rv-c]` as a genuine
fallback. At perception time, each cluster gets a `structuralSelector` computed from the
DOM: nearest stable attribute (id/data-testid/role/aria-label/name) + nth-of-type chain,
uniqueness-checked. The compile path uses `cluster.structuralSelector` when available,
falling back to `cluster.selector` (`[data-rv-c="handle"]`) when no stable anchor exists.
The fallback count is reported as `selectorFallbackCount` in the compile result — a metric
for how often the structural path fails.

## Motion layer (BUILD SWEEP 1E — F4)

Motion is expressed as RELATIONS, never as raw keyframes. The model emits:
- `transitionTier` — duration at tier N on the pack's motionDurationScale
- `transitionEasing` — easing character (smooth/sharp/spring/linear)
- `entranceDelay` — entrance animation at delay tier N (stagger by reading order)
- `hoverElevate` — hover elevation via transform (never layout)
- `focusRing` — focus-visible ring using the named accent

Motion is **transform and opacity only** — nothing that triggers reflow. The
compile path emits `@keyframes rv-enter` and wraps motion CSS in a hard
`@media (prefers-reduced-motion: reduce)` branch that zeros `animation` and
`transition` on all `[data-rv-c]` elements. This is not a setting — it is a
hard branch that disables the entire motion layer.

Each pack declares: `motionAnimated` (boolean — dense-terminal and
minimal-editorial declare themselves still), `motionDurationScale` (ms steps),
`motionEasing` (character → cubic-bezier mapping).

## Interaction layer (BUILD SWEEP 1E — F5)

A `movable` relation opts a cluster into the movable-element capability. The
compile path emits `cursor: grab`, `touch-action: none`, and a `--rv-movable`
custom property. The runtime drag handler (content.ts) applies
`transform: translate()` only — never mutates `style.position`, never moves DOM
nodes. This is trivially reversible (clear the transform) and invisible to any
framework watching the tree. Keyboard movement is a first-class path
(Arrow keys + Shift for larger steps). Bounded to a sensible region so nothing
can be dragged off-screen. Full removal on undo.

## DOM ops with real reasons (BUILD SWEEP 1E — F6)

DOM mutation was inert since 1A because no call site supplied a `MutationReason`.
Sweep 1D added `reorderBefore` and `moveTo` relations — dead on arrival. F6
wires real reasons from the transformation engine's `deriveMutationReason`:
- `escape-overflow-hidden` — content clipped by a contained ancestor
- `escape-stacking-context` — trapped behind a positioned ancestor
- `cross-layout-regions` — subject and reference in different layout regions
- `impossible-ancestry` — parent is a flex/grid container, CSS can't reorder

If none apply, the op is correctly refused and the relation reports it could
not be satisfied. Every op goes through the transaction log with a
handle-resolved inverse for exact undo.

## Quantization fix (BUILD SWEEP 1E — F2)

`sizeRatio` previously snapped continuous ratios to a fixed 4-value type ramp —
ratios 2.6, 2.8, 3.0, 3.4 all resolved to the same 48px. F2 generates a
fine-grained ramp from the pack's base size + scale character
(`minTypeScaleRatio`), giving many more distinct steps within the pack's
[min small, max display] range. The same fix applies to `spacingRatio`,
`gapRatio`, `marginEquals` (continuous spacing, clamped to the scale range +
grid), and `lineHeightRatio` (continuous line-height, clamped to the
lineHeightScale range).

Legitimately discrete scales (kept as-is): `radiusCorner`, `borderWeight`,
`elevationStep`, `surfaceTier`, `fontWeightRank`, `typeRank`, `emphasisRank`,
`outranks`, and all `*Step` relations — these are ordinal ranks or finite
design-token sets by design.

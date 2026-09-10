# Product-to-implementation traceability

**Proposed coverage map.** Purpose: ensure every major component serves a requirement and every vision capability has an implementation/test/acceptance path. Requirements R01–R15 are defined in [master](00-master-blueprint.md); tasks are in [roadmap](25-roadmap.md), tests in [matrix](21-test-matrix.md). None of these paths is claimed implemented yet.

## 1. Requirements → components → modules → tasks → tests → acceptance

| Requirement | Architecture component | Principal target modules | Implementation tasks | Tests | Acceptance |
|---|---|---|---|---|---|
| R01 natural language | Evidence-first bounded planner | planning/controller/context/prompts; providers/*; runtime/observe | S3.1, S6.1/2 | T02/T03/T19/T20/T28 | AC02/05/09/12 |
| R02 appearance/density | General safe style compiler, native layout | runtime/compile/policy/styles/verify; shared/color | S4.1–3 | T07/T13/T22/T28/T30 | AC03/08/12 |
| R03 layout/navigation | Responsive styles, floating native surface, linked views | runtime/styles/behavior/projection/transaction | S4, S7.1, S8.1/2 | T15/T17/T18/T22 | AC03/10/12 |
| R04 behavior/shortcuts | Finite local action rules | runtime/behavior; runtime/facts action catalog | S7.1/2 | T15/T16/T23 | AC11 |
| R05 workflow recomposition | Source-linked board/dashboard/control projection | runtime/projection/content/targets/behavior | S8.1/2 | T17/T18/T28 | AC12 |
| R06 preserve website | Same-node resource ownership, mandatory integrity | runtime/targets/policy/transaction/content/verify | S2–S4, S7/S8 capability tests | T05/T08/T09/T13/T18/T30 | AC02/03/04 |
| R07 persistence/dynamic continuity | Versioned intent, scope-aware reconciliation | background/store/documents; runtime/reconcile | S5.1/2, S6.3 | T10/T11/T12/T26 | AC06 |
| R08 reversal/control | Token revocation, exact receipts, same-node inverse | runtime/transaction/styles/queue; background/styles; ui/status/customizations | S2.2, S4.2/3, S5.2, S6.2 | T08/T09/T14/T27/T30 | AC04/09 |
| R09 interchangeable models | Explicit provider profiles/adapters | contracts/provider; providers/*; ui/settings | S1.1/2, S6.1/2 | T19/T20/T25 | AC05/07 |
| R10 speed/performance | Bounded snapshots/batches/queues, no idle inference | planning/budget/context; runtime/observe/reconcile; providers/client | S3/S4/S5/S6, S9.1 | T03/T20/T23/T24 | AC08 |
| R11 privacy/permission | Explicit site/provider grants and minimization | background/permissions/broker; contracts/validation; ui/settings | S1.2, S2.1, S6.2 | T04/T07/T21/T25/T26 | AC07 |
| R12 honest outcomes | Structured report/receipt/UI projection | contracts/errors/messages; runtime/verify; ui/status; shared/diagnostics | S1/S4.3/S6.2 | T13/T14/T27 | AC03/04/09 |
| R13 accessibility/responsive | Native controls and scoped check/QA, root/frame capability boundaries | runtime/behavior/verify/targets; background/documents; ui/* | S4.3, S6.2, S7/S8.1–3, S9.1 | T06/T15/T18/T22 | AC09/10/11 |
| R14 maintainability/progress | Consolidated modules, simple batch, dependency gates and concise evidence | contracts and cohesive physical layout; entrypoints/tests/plan | S0.1, S1.1, S6.3, S9.2 | T01/T02/T29/T30 | AC01 |
| R15 create elements/graphics | Generic insertUI and optional owned Canvas 2D leaf | runtime/content/compile/transaction; native DOM/Canvas APIs | S4.1/2, S7 for control bindings, S8.4 for canvas | T31/T32 | AC03/04/07/08/12 |

## 2. Vision examples and release path

| User request family | Concrete delivery | Tasks / tests | Limitation that must remain visible |
|---|---|---|---|
| Hide YouTube Shorts permanently | Observed future-set hide + user-approved origin/prefix scope, fresh member validation | S3/S4/S5; T05/T10/T11 | Safe predicate required; loaded/current selection otherwise session-limited |
| Remove X “For You” | Targeted tab hide with focus/native navigation preserved | S3/S4/S5; T05/T13/T22 | Not changing backend recommendation preferences |
| Auto-collapse Reddit comments | Approved disclosure/local collapse rule, per-instance user override | S7.2; T16 | No unbounded observer click, no universal custom component introspection |
| GitHub PR Kanban / GitHub like Linear | Observed field/source mapping + local board + existing links | S8.1; T17/T28 | Loaded items only; local columns not server workflow states |
| Gmail keyboard-first | Existing affordance catalog + explicit key/action binding | S7.1; T15/T21 | Trusted activation/editable/OS shortcut restrictions |
| Hide LinkedIn engagement bait | Current-item semantic selection or user-approved explicit local filter | S3/S4/S5/S7; T05/T11/T16 | General future subjective classification requires separate opt-in inference design |
| Floating Spotify mini-player | CSS float existing controls; linked panel or gated move when necessary | S8.2; T18/T22 | No duplicate media or access to closed/DRM internals |
| Wikipedia magazine | Coherent type/layout/media groups; source/heading links retained | S4/S8; T22/T28 | Not wholesale article DOM replacement |
| YouTube into Spotify | Audio-focused layout and navigation/control projection | S7/S8; T15/T17/T18/T28 | Does not transform service/backend identity |
| Amazon into Apple | Product presentation/layout with native purchase controls untouched | S4/S8; T07/T13/T28 | Never automatically purchase or fabricate checkout controls |
| Glassmorphism/neobrutalism/90s/Notion | General visual value/condition language, coherent effect groups | S4; T07/T22/T28 | No forced theme pack or remote font/image dependency |
| Increase spacing/reduce clutter/one post per screen | Scoped style/set layout with native scrolling and responsive constraints | S4/S5; T11/T22/T23 | Avoid measured-pixel reconstruction and virtualized-node ownership theft |

No P1 core release may imply all P2 workflow examples are already implemented. No P2 requirement disappears from plan because arbitrary websites have limits: delivery and fallback are explicit.

The explicit color/background/spacing/typography/element/behavior/layout/motion/micro-detail/canvas matrix and native element/drawing schemas are in [capability coverage](28-capability-coverage.md). Those requirements are not implicit in a generic “styling” claim. New remote asset loading and arbitrary internal website-canvas editing remain explicitly outside the initial capability set.

## 3. Architectural component justification (no orphan subsystem)

| Component | Why it exists | Why simpler alternative is insufficient |
|---|---|---|
| Visible workspace | R01/R08/R09 long inference + questions/Stop | Ephemeral popup and MV3 long fetch cannot own dependable session |
| Broker/document registry | R06/R11 privileged CSS, page permission, stale event fence | Tab-only messages can hit wrong document |
| Resource ledger | R06/R08 exact undo/partial-failure handling | Tool history does not record effects before mutation |
| Canonical revision store | R07/R08 refine/reload/undo | Accumulating CSS/tool args retains old conflicting actions |
| Semantic snapshot/target registry | R01/R06/R10 weak model useful evidence + identity | Raw DOM costly/private; unique selector isn't identity |
| CSS parser/compiler | R02/R06/R11 flexible safe style | Regex cannot safely handle grammar; fixed style packs cap vision |
| Generic structured owned UI | R05/R06/R11/R15 new elements/views without dead clones | One native creator, not a widget framework or raw HTML sink |
| Bounded owned Canvas 2D leaf | R15 explicitly requested drawing surface | DOM/CSS remains preferred; one small native renderer avoids a scene/animation framework |
| Finite behavior/action catalog | R04/R06 explicit interaction changes | Styling alone cannot create keyboard workflows |
| Verifier with unknown | R06/R12 actual effect/integrity | Model done and missing arrays don't prove correctness |
| Provider adapters | R09 model protocol substitution | One string setting does not change auth/endpoints/request formats |
| Reconciler | R07/R10 dynamic content without model cost | One-time replay and route-only callbacks miss same-route re-renders |
| Diagnostics/testing gates | R12/R14 observable correctness and resumable implementation | Missing historical tests/current prose claims are not evidence |

## 4. Deferred items and unknowns

Not required for first vision-capable release: cloud sync, collaborative editing, arbitrary code marketplace, unattended model agent, embeddings/vector store, worker offload, 1,000-item virtualized owned board, non-Chromium support. Each needs new requirements/ADR/task—not unused scaffolding.

Unknowns to resolve at implementation gates: real installed-user storage inventory (S5.1), minimum-browser documentId/API behavior (S2/S8.3/S9), direct-provider CORS/auth compatibility (S6.1), representative hardware performance (S0/S9), live-site affordance reliability and authenticated manual permission (S7/S8/S9). Defaults are safe and implementation-ready: quarantine, explicit unsupported, bounded partial, no credentialed automation. None authorize invented repository facts.

# Architecture decisions and alternative analysis

**Status: Proposed, accepted for implementation planning; not a claim of shipped behavior.** Purpose: record decisions implementation agents must not casually reverse. Priority and phase dependencies are in [roadmap](25-roadmap.md). Failure-specific fallbacks are in [failure ladders](14-failure-and-fallbacks.md).

Comparison dimensions: C=implementation complexity/cost; P=performance; R=reliability/failure modes; M=maintainability; B=browser compatibility; S=scale ceiling; Mig=migration difficulty. “Low/medium/high” are relative estimates, not schedules or measured benchmarks.

## ADR-01 — Rewrite core subsystems, retain platform

**Context/problem:** complete source inspection found competing undo/replay owners, missing tests and provider lock-in; useful native primitives still exist.

| Option | Advantages | Disadvantages / dimensions |
|---|---|---|
| Patch existing loop | Small initial cost, quick individual fixes | C low→high as exceptions grow; P keeps paid tool loop/full scans; R ownership/race flaws remain; M poor; B unchanged; S weak; Mig low but prolonged dual semantics |
| **Subsystem rewrite** | Correct ownership/contracts while retaining WXT/pure primitives | C medium/high; P bounded common path; R can prove new runtime independently; M simpler seams; B same platform; S bounded incremental; Mig medium with one cutover |
| Full repository rewrite | Clean slate | C high; P no inherent gain; R repeats solved packaging/color work; M new stack unknown; B re-prove everything; S no special gain; Mig highest |

**Decision:** subsystem rewrite, with new runtime developed behind explicit development selection; one active writer/document. **Consequences:** more than minimal diff; old loop not protected. **Reversal:** evidence that retained primitives/tooling block required browser support or testability; new ADR required.

## ADR-02 — Visible workspace owns planning; broker is restartable

| Option | Advantages | Disadvantages / dimensions |
|---|---|---|
| Service worker long loop | Works without visible UI | C medium once resumability added; P little UI cost; R fetch/lifetime interruption and lost globals; M many recovery paths; B MV3 limits; S bounded by lifecycle; Mig low but unsafe current assumptions |
| **Side panel / extension tab host** | Long calls live in extension page; explicit Stop/questions; no keepalive hack | C medium; P native page overhead only while used; R closure cancels provisional, accepted local survives; M clear owner; B Chromium sidepanel + tab fallback; S one run/document; Mig medium |
| Offscreen host/native daemon | Long-lived-ish background processing | C high; offscreen permitted-purpose restrictions/native install; R extra lifecycle boundary; M high; B poor portability; S higher but unneeded; Mig high |

**Decision:** visible workspace; no invisible continuation promise. **Reversal:** explicit product requirement for unattended planning after UI closure plus a platform-compliant durable design and tests.

## ADR-03 — Typed finite operation language, not generated programs

| Option | Advantages | Disadvantages / dimensions |
|---|---|---|
| CSS-only | Fast/simple | C low; R limits to styling but raw CSS still unsafe; M easy; B broad; S expressive ceiling excludes workflows; Mig low |
| **Finite typed operations + general style values** | Model-independent validation/replay/undo; behavior and projections possible | C medium; P compilation/validation bounded; R rejects unsupported actions; M capability-by-capability tests; B explicit support; S vocabulary expands deliberately; Mig medium/high |
| Arbitrary JS/userscripts | Very expressive | C deceptively low authoring/high safety; P unbounded; R cannot guarantee undo/containment; M opaque generated programs; B CSP/store constraints; S cost/attack surface; Mig high |
| Huge universal semantic/layout DSL | Powerful abstract planner | C high; P extra translation/solver cost; R brittle inferred semantics; M speculative; B separate renderer constraints; S unknown; Mig high |

**Decision:** finite operations with flexible CSS values/conditions and one generic insertUI native tree creator. One proposal is one ordered reversible batch; no required/optional subgroup DAG. A bounded Canvas 2D leaf can be added when its requested feature task is implemented, not a graphics framework. No arbitrary code escape hatch. **Reversal:** only via explicit separately sandboxed product capability, not weak-model troubleshooting.

## ADR-04 — Runtime resource ledger + desired-state records

| Option | Advantages | Disadvantages / dimensions |
|---|---|---|
| Persist model tool journal | Existing mechanism, easy append | C low initially; P replay growth; R refusal/partial/repeated actions mixed; M replay/undo coupling; B JSON limitations; S unbounded history; Mig low |
| **Canonical revisions + live resource ledger** | Precise cleanup, replay from intent, model outage independent | C medium; P minimal deltas; R explicit unknown/conflict; M one owner; B native APIs; S bounded records; Mig controlled quarantine |
| Full event sourcing/CRDT | Distributed audit/collaboration | C high; P storage/merge overhead; R ordering hard for DOM; M unnecessary; B feasible data only; S collaborative benefit absent; Mig high |

**Decision:** separate saved intent from applied reality. **Reversal:** actual collaborative multi-device simultaneous authoring requirement; must not replace local resource truth.

## ADR-05 — Observed target refs with separate single/set semantics

| Option | Advantages | Disadvantages / dimensions |
|---|---|---|
| Raw selectors + fingerprint | Familiar, already implemented | C medium; P expensive full-text hashing/twin scans; R unique wrong-target, stale repeated content; M many exceptions; B shadow gaps; S weak on virtualization; Mig low |
| **Session refs + validated durable descriptors + future sets** | Exact in-session identity, safe deliberate repetition | C medium; P local bounded resolution; R ambiguous means suspend; M one registry; B root-aware; S capped membership; Mig medium |
| ML locator/embedding rank as authority | Tolerates visual drift | C/cost high; P inference latency; R plausible wrong control; M calibration; B screenshots/accessibility variation; S expensive; Mig high |

**Decision:** deterministic resolver; ranked inference only assists user/model discovery. **Reversal:** cannot replace authority with probability without new risk policy; descriptor grammar may evolve from fixtures.

## ADR-06 — Bounded semantic evidence, not mandatory global graph

Full perception provides broad data but current six-second walk and O(C²)/repeated queries exceed responsiveness. Raw DOM dump is simpler to collect but costly, private and difficult for weak models. **Select bounded semantic snapshots with targeted expansion.** C medium, P predictable, R honest partial coverage, M one collector path, B native DOM across supported roots, S handles large pages by paging, Mig medium. Global detailed analysis can be optional later if measurable quality gains justify costs. Reverse only with end-to-end benchmarks showing both page performance and quality improve; never remove coverage flags.

## ADR-07 — Scoped styles with explicit override policy

| Option | Advantages | Disadvantages / dimensions |
|---|---|---|
| Page style element AUTHOR origin only | One local owner, easy teardown | C low; P fast; R loses to author important/inline and page removal; M simple; B broad incl open roots; S good; Mig low |
| **USER-important broker sheets for document + root-local fallback** | Reliable intended document overrides; exact removal; supports open roots honestly | C medium due receipts; P small IPC; R staged inert tokens mitigate races, transitions still measured; M explicit resources; B Chrome scripting/open-root differences; S capped sheets; Mig medium |
| Inline style everything | Direct, often wins | C medium inverses/property preservation; P many DOM writes; R author conflicts, no pseudo/media generality; M messy; B broad; S poor repeated sets; Mig medium |

**Decision:** USER important for intended overrides, canonical generated selectors, no normal/retry blanket escalation. Logical fragments are composed into one ordered accepted bundle/root with at most one staged replacement; normalized selector specificity preserves explicit customization precedence across refinements. This bounded rebuild is simpler and more reliable than trying to repair insertion order with cascade-layer tricks. Shadow AUTHOR fallback exposed; narrow tracked inline override only approved property. **Reversal:** browser capability or measured IPC cost, with identical resource/undo policy.

## ADR-08 — Structured content and parsed CSS, not regex sanitization

Regex HTML/CSS sanitizer is low initial C but high R risk and M cost as grammar evolves; B browser syntax differs; P not meaningful if unsafe. DOMPurify would solve HTML sanitization but still allows an unnecessarily broad markup surface. **Select generic safe native element trees and CSS AST validation (`css-tree`) plus browser capability checks.** C medium; P bounded O(bytes); R finite operation/tag/attribute and focused CSS security/impact policy; M one shared compiler instead of a handwritten dictionary of all visual properties; B unsupported syntax rejected; S payload bounds; Mig medium. Introduce raw-markup support only after explicit need, mature sanitizer and security ADR. No fallback to regex when parser rejects.

## ADR-09 — Thin provider adapters, no fixed model or agent framework

Fixed Cloudflare endpoint has lowest cost but violates R09. A large AI framework offers many providers but brings protocol/tool abstractions unrelated to safe DOM execution, dependency churn and bundle cost. **Select native fetch + OpenAI-chat and Anthropic adapters, explicit profile capabilities and normalized text.** C medium; P minimal overhead; R bounds independent of quality; M testable fixture transport; B CORS/host permissions explicit; S limited by user quotas; Mig medium. Add adapters only with real protocol demand. Reverse to SDK only when it demonstrably removes more maintained protocol complexity than it adds, without moving execution authority.

## ADR-10 — Projections before arbitrary native-node moves

CSS reshaping is cheapest, fastest and preserves native nodes but cannot express every layout. Cloning interactive DOM loses listener/state semantics. General reparenting can break frameworks even preserving identity. **Select linked owned projections for new workflows, CSS floating first, gated relocation last.** C medium/high for real board UI; P ≤200 rendered items; R source actions re-resolved; M explicit mapping; B native DOM; S loaded-item ceiling disclosed; Mig new capability after runtime. Reversal: tested site-independent relocation primitives prove safe on required surfaces; never clone native controls as an implementation shortcut.

## ADR-11 — Model-free required verification and responsive QA

Model/vision-only verification is costly, nondeterministic and cannot establish exact ownership. Full whole-page DOM checks after every small act are expensive and confuse existing site defects. **Select affected-target postconditions + baseline sentinels + pass/fail/unknown, real browser responsive fixture tests and user quality review.** C medium; P bounded; R coverage limitations explicit; M reusable check IDs; B real APIs; S scoped; Mig rewrite verify. No actual user-window resize. Add opt-in vision QA for aesthetics only, never as requirement to use a particular model or substitute for missing mechanical checks.

## ADR-12 — Local storage with one writer; explicit content consent

Accumulated per-path journals are easy but unversioned/concurrent; server persistence changes privacy/product burden; IndexedDB provides transactions but adds complexity not yet required by bounded records. **Select single-record-per-origin local storage with broker serial writes, revision IDs and restart reconciliation.** C medium; P infrequent bounded serialization; R quota/conflict explicit; M small schema; B extension storage broadly available; S 6 MiB initial total; Mig disabled legacy quarantine. Reverse to IndexedDB only for measured capacity/multi-record atomicity needs. No auto cloud sync. Existing implicit consent and “model-authored means non-sensitive” assumptions are rejected.

## ADR-13 — Simplify implementation structure, retain safety

**Context:** owner requested no overengineering and explicit coverage of general element creation, motion/micro-details and canvas. The first draft over-fragmented source modules and offered a subgroup dependency language before a concrete need.

**Options:** keep dozens of physical modules and a generic optional-group DAG (high implementation/maintenance cost, harder weak-model contract); use one monolithic unvalidated tool runner (short initially, repeats known ownership/security bugs); or consolidate cohesive files and use one atomic ordered batch (selected).

**Decision:** [physical layout](02-layers-and-dependencies.md) merges related logical contracts into ordinary functions/files, roughly 17 core files plus real later behavior/projection modules and platform entrypoints. No empty scaffolding. One complete batch accepts or rolls back. Owned local node refs refer only to earlier creators. CSS browser grammar covers visual features subject to targeted security/impact validation. One insertUI creator covers annotations/panels/cards/local controls; Canvas 2D uses a bounded leaf renderer only when S8.4 runs. One compact progress log replaces mandatory per-task narrative files.

**Consequences:** less code/protocol/testing combinatorics and fewer concepts for weaker implementation/models; partial useful work must be an explicit smaller revision, not an automatically selected subset. Browser/latency boundaries and exact undo/cancellation/state ownership remain because their failure modes are already evidenced. Canvas/programming scope is deliberately bounded, not sold as universal manipulation of site graphics.

**Reversal conditions:** split files when actual complexity or lifecycle isolation justifies it; introduce a group dependency system only for a demonstrated requirement a linear batch cannot express, with its own tests and ADR. Do not add it for hypothetical extensibility. This owner-approved simplification changes target documentation only; no existing product implementation or schema has been migrated by this task.

## ADR-14 — Workspace document discovery and state pull (ListDocuments / GetState)

**Added 2026-09-09 (S6.2, plan/24 §5 protocol-addition record).**

**Context/problem:** the workspace must pin an EXACT registered DocumentKey — a tab id alone never authorizes (I04) — and must resynchronize per-document live state after close/reopen (plan/06 RuntimeState: “missed sequence triggers snapshot”). RuntimeState pushes alone cannot do either: a freshly opened workspace has received no push, and it cannot address any runtime without a DocumentKey, which only the broker registry knows.

**Options:** (a) keep only push projections — workspace cannot open mid-session or reconnect (violates S6.2 completion “close/reopen states correct” and T21 “user chooses exact target”); (b) let the workspace guess tab-derived keys or re-register runtimes from pages — violates I04/I03; (c) two read-only queries: `ListDocuments` (workspace → broker: registry snapshot) and `GetState` (workspace → registered runtime via the same document fence as every other page-scoped command).

**Decision:** (c). Both commands are workspace-role only, read-only, and return data the workspace already receives via RuntimeState broadcasts (opaque DocumentKeys, epochs, origins, bounded live states) — no new mutation authority, no new trust surface. RuntimeState broadcasts now carry a monotonic `seq`; stale pushes are ignored, `GetState` is the resync pull. **Tests:** unit (stale-seq ignore, exact-target refusal, reopen resync) in `tests/unit/workspace.test.ts`; browser reopen in `tests/browser/workspace.test.ts`. **Consequences:** the plan/06 §1 protocol table gains the two rows. **Reversal:** if a subscription/port mechanism replaces polling pulls, remove both commands with a migration note; the sender allowlist and document fence stay.

## Decision change rules

File naming, private helper extraction and purely internal iteration techniques may change with tests. Ownership, operation grammar, trust boundaries, provider execution host, persistence schema, fallback visibility and acceptance requirements require ADR amendment plus roadmap/test/traceability updates. Changes need evidence of a real failure or requirement; “the model performs better without guards” is not sufficient.

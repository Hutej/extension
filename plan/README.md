# Revueon engineering blueprint

This directory is the authoritative **target architecture and implementation plan**, derived from the product vision and complete reading of all 42 files under `project/src/`. It is not a claim that the target system is already implemented. No product code or tests were added by the planning task.

## Start here

1. Read [00 — Master blueprint](00-master-blueprint.md): product, boundaries, lifecycle and selected strategy.
2. Read [01 — Repository audit](01-repository-audit.md): verified working-tree facts, all-source reading ledger, current failures and preserve/rewrite decisions.
3. Read [23 — Invariants](23-invariants.md) and [24 — Implementation protocol](24-implementation-protocol.md).
4. Open [25 — Checkbox roadmap](25-roadmap.md). **Next implementation task: S0.1.** All product implementation tasks start unchecked.
5. Follow that task's architecture, module, test and acceptance links. Do not implement a random visible feature first.

Product source: [all-about_revueon.txt](../all-about_revueon.txt). Agent rules: [AGENTS.md](../AGENTS.md), [CLAUDE.md](../CLAUDE.md). Actual application cwd: `project/`; there is no repository-root `src/`.

## Architecture in one paragraph

A visible extension workspace hosts bounded planning against a user-configured model/provider. A restartable MV3 broker owns permissions, document identity, privileged CSS delivery and versioned local storage. One isolated-world runtime per document owns semantic evidence, validated targets, reversible effect resources, verification and dynamic reconciliation. Models propose finite typed operations; browser/runtime enforce correctness independently of model quality. Saved customizations are canonical intent revisions, not replayed model tool transcripts. General CSS plus safe content/behavior/linked projections deliver more than theming without generated executable scripts.

## Simplicity and capability check

Read [28 — Capability coverage](28-capability-coverage.md) for the explicit color/background/spacing/new-element/typography/behavior/layout/motion/micro-detail/canvas matrix. Generic insertion and owned Canvas 2D now have concrete contracts and tests; “anything” does not mean bypassing browser restrictions or executing arbitrary model code.

Use the consolidated physical layout in document 02, not a file/class per logical heading. One proposal is one reversible ordered batch, with no optional-group DAG. Native CSS supplies visual vocabulary and motion; one safe DOM creator handles new UI; canvas is a small later leaf renderer. Keep one compact progress log, not a report hierarchy. Safety, undo and cancellation are not optional complexity.

## Document index

| Document | Responsibility / when to read |
|---|---|
| [00 Master blueprint](00-master-blueprint.md) | Entry point; R01–R15 requirements, architecture and execution flow |
| [01 Repository audit](01-repository-audit.md) | Verified baseline, complete source ledger, F01–F24 findings and obsolete docs |
| [02 Layers and dependencies](02-layers-and-dependencies.md) | Allowed/forbidden imports, technology choices, physical module layout |
| [03 Module contracts](03-module-contracts.md) | Every significant target module: I/O, state, lifecycle, failure, performance and tests |
| [04 Data contracts](04-data-contracts.md) | Schemas, source of truth, target/proposal/receipt/revision/provider representations |
| [05 State and lifecycle](05-state-and-lifecycle.md) | Run/document/group state machines, cancellation, composition and user commands |
| [06 Events and concurrency](06-events-and-concurrency.md) | Message inventory, queues, epoch fencing, idempotency, crash windows |
| [07 Observation and targeting](07-observation-and-targeting.md) | Bounded semantic evidence, exact refs, durable descriptors and future sets |
| [08 Transformation runtime](08-transformation-runtime.md) | Operation vocabulary, compiler, CSS/content ownership, apply/verify/undo |
| [09 Behavior and workflows](09-behavior-and-workflows.md) | Shortcuts, local rules, real Kanban/dashboard/mini-player paths and limits |
| [10 Core algorithms](10-core-algorithms.md) | Implementation-oriented pseudocode A1–A10, pre/postconditions and complexity |
| [11 Model providers](11-model-providers.md) | BYO model/protocol contracts, profiles, bounded retries/context and failures |
| [12 Browser runtime](12-browser-runtime.md) | Platform facts, MV3/shadow/frame/SPA/zoom realities and primary-source references |
| [13 Persistence and replay](13-persistence-and-replay.md) | Versioned local records, scope, conflict/quotas, replay, enable/remove/undo |
| [14 Failure and fallbacks](14-failure-and-fallbacks.md) | Preferred/alternative/emergency paths, detection and simulation outcomes |
| [15 Performance](15-performance.md) | Numerical proposed budgets, CPU/memory/latency strategy and benchmark method |
| [16 Observability and UX](16-observability-and-ux.md) | User-visible state/control, diagnostic events, bounded safe exports/debugging |
| [17 Security and privacy](17-security-and-privacy.md) | Trust boundaries, validation, grants, injection/exfiltration and content policy |
| [18 Decisions and alternatives](18-decisions-and-alternatives.md) | ADR01–13 trade-offs, selected solutions, simplification and reversal conditions |
| [19 Migration and deletion](19-migration-and-deletion.md) | Subsystem rewrite/cutover, current→target mapping, exact deletion ledger |
| [20 Testing strategy](20-testing-strategy.md) | Test pyramid, runnable stack, fixture design and execution order |
| [21 Test matrix](21-test-matrix.md) | T01–T32 actionable triggers, results, failure/recovery and priorities |
| [22 Acceptance criteria](22-acceptance-criteria.md) | AC01–12 measurable subsystem and release gates |
| [23 Invariants](23-invariants.md) | I01–I28 non-negotiable architecture rules with enforcement/test paths |
| [24 Implementation protocol](24-implementation-protocol.md) | Session recovery, scoped work, evidence, failure/escalation and evolution |
| [25 Roadmap](25-roadmap.md) | Dependency-ordered task contracts and persistent nested checkboxes |
| [26 Traceability](26-traceability.md) | Requirement→component→module→task→test→acceptance and vision examples |
| [27 Hostile review/self-audit](27-hostile-review-and-self-audit.md) | Adversarial design review, revisions, remaining unknowns and completion audit |
| [28 Capability coverage](28-capability-coverage.md) | Simplicity contract; all requested visual/interaction categories, generic inserted UI and bounded owned Canvas 2D |

## Authority and interpretation

- **Verified:** observed source/tool results in the audit or cited platform facts. Current code behavior is not automatically the desired behavior.
- **Inferred:** plausible risk from code/platform behavior; turn it into a regression test before claiming a fix.
- **Proposed:** all target modules, limits, task contracts and release decisions unless explicitly marked verified.
- **Unknown:** unresolved platform/user/environment facts with safe default and resolution task.

Product vision outranks implementation convenience. Invariants/security/data contracts define hard boundaries; domain docs specify behavior; ADRs explain why; roadmap orders work; acceptance/tests determine completion. If documents conflict, stop the affected task and resolve the contract explicitly rather than choosing the permissive version. Roadmap does not override safety.

Legacy `docs/ARCHITECTURE.md`, `docs/TOOLS.md`, `docs/TESTING.md` and source comments referring to absent proof/tests are superseded as architecture authority. They remain historical material until migration replaces them with pointers. Do not revive the old fixed-model, global-journal, clone-undo or six-second-perception architecture based on those documents.

## Implementation and reading order

Implementation: S0 tests → S1 contracts/trust → S2 lifecycle/privileged ownership → S3 observation → S4 runtime/verification → S5 persistence/reconciliation → S6 providers/workspace/core cutover → S7 behaviors → S8 workflow breadth → S9 release/deletion.

For runtime work read 04→05→06→07→08→10→14 plus relevant module rows. For provider work read 04→11→17→16. For persistence read 04→05→06→13→19. Every task also reads its T/AC/I references.

Performance figures are target budgets, not fabricated benchmarks. Model quality is measured separately: a weak model can be less capable, but cannot change runtime safety, undo, bounds or truthful failure. Browser restrictions are explicit; “any website” is a product ambition, not a claim of impossible browser privileges.

# Implementation protocol and persistent progress

**For the future implementation agent, not authorization to implement during this planning task.** Purpose: enable reliable progress without conversational context. Start at [README](README.md), [master](00-master-blueprint.md), [invariants](23-invariants.md), then [roadmap](25-roadmap.md).

## 1. Session startup

1. Inspect Git status/branch and compare with latest task evidence. The planning baseline was already dirty; never reset/discard owner changes. Record current source revision and existing failures.
2. Read roadmap Current checkpoint. Find next unchecked **leaf task** whose dependencies are complete; do not jump to visible feature polish ahead of runtime ownership.
3. Read task-linked contracts, affected module rows, tests and acceptance IDs. Inspect current actual implementation files fully; plan is target authority, source is current-fact authority.
4. Confirm required tools/tests exist. If missing, the foundation task is incomplete; do not infer old test claims from `docs/`.
5. Establish scope: goal, files/modules, inputs, outputs, invariants, test rows, rollback unit. Write active task/status in roadmap only when implementation work actually begins.

## 2. Scoped change loop

- Start with smallest meaningful vertical task in roadmap, not opportunistic repository rewrite.
- Add/restore a regression test for relevant current failure first; confirm negative control detects it. New behavior tests can initially be red, labeled as task work.
- Implement within the contract. Keep one writer per worktree. Concurrent mutation work requires isolated clean worktrees and explicit ownership; don't have multiple agents edit shared runtime/contract files.
- Run focused unit/component tests during work, then task integration/failure/undo checks, typecheck/lint and dependency gate. Browser changes require a fresh built extension from current source.
- Inspect diff for unrelated edits, new dependencies, unsafe sinks, stale guards and silent error catches. Verify every await/side effect has cancellation/epoch/resource handling where relevant.
- Run task acceptance checks and core regression suite appropriate to [test execution order](20-testing-strategy.md).
- Update docs only for actual contract/fact changes. Do not rewrite plan to match a bug that made tests fail.

## 3. Completion and durable evidence

Use **one compact `plan/progress.md` log**, created when implementation starts. Add one entry per meaningful task/session: task ID/status, source/build revision, changed files, commands/cwd/nonzero test counts, result/acceptance IDs, blocker or residual risk, and next task. Link browser artifacts only when relevant. The roadmap already contains the goal, prerequisites, invariants and rollback contract; do not copy them into a second narrative report.

Separate a longer evidence file only for a real multi-environment release result or architectural failure experiment that cannot fit a concise log entry. No report-per-helper, mandatory ceremony or extra progress database. Preserve actual failing results; simplicity is not permission to omit proof.

Mark leaf `[x]` **only** after outputs exist and all task-mandatory checks pass. A commit alone is not completion. No `[x]` for tests that were not run, unsupported automation silently skipped or provider quality judged from a single screenshot. Parent phase checkbox changes only when all leaf tasks and phase exit gate pass. Current checkpoint names next leaf and blockers; it survives a new agent session.

Large test captures live in an ignored artifact directory with reference from Markdown, not in plan documents. No credentials/private page captures committed. This architecture task starts with **all implementation boxes unchecked**.

## 4. Handling failure

1. Freeze new scope; capture error, resource state and partial diff before cleanup.
2. Classify: implementation bug; test-infrastructure failure; browser/platform limit; requirement/architecture contradiction; provider-quality/transport issue.
3. Implementation bug: add/reproduce test, fix shared root cause, rerun focused and regression tests. Do not patch every caller around a broken contract.
4. Infrastructure failure: repair/retry same protocol. Missing browser/runner/dependency is not permission to switch execution mode, bypass review or claim test pass. If governed subagent workflow fails, follow its failure protocol and ask owner before external/foreground fallback.
5. Platform/design failure: consult [fallbacks](14-failure-and-fallbacks.md) and relevant [ADR](18-decisions-and-alternatives.md). Run the smallest controlled capability experiment; document observed evidence separately from inference.
6. Select only documented fallback whose trigger actually occurred. If fallback changes user-visible capability, ensure UI disclosure and tests; do not silently substitute a different product result.
7. If no valid fallback works, mark task `blocked`, record exact blocker and owner question; leave checkbox unchecked. Do not continue dependent tasks. Independent ready tasks may proceed only with explicit scope record.
8. Architectural change requires amendment described below before implementation. Preserve partial diff; revert only task-owned changes when necessary, never owner baseline changes.

Model failure is not reason to weaken runtime validation, remove timeout bounds, require a particular stronger model or bypass permissions. Runtime must end safely and honestly even if semantic completion is impossible.

## 5. Architecture evolution permissions

| Change | Agent may do? | Required record |
|---|---|---|
| Private naming, helper extraction, pure algorithm with same contract | Yes within task | Tests + module inventory if file location changes |
| Fix bug to satisfy documented invariant | Yes | Regression test/evidence; correct audit status after fix |
| Adjust measured non-safety sampling/perf threshold | With recorded benchmark and no hidden coverage loss | Update performance/acceptance/task evidence together |
| Add operation/protocol/dependency | Architectural review required | ADR, schema/module/fallback/tests/traceability/roadmap update |
| Change trust boundary/ownership/persistence schema/cleanup semantics | Owner architectural approval required | ADR amendment with migration and hostile failure analysis |
| Remove capability promised in vision | Not silently | Explicit product decision, traceability and roadmap revision |
| Bypass guard, execute model code, fake test pass, drop failed inverse | No | Stop/escalate |

ADR amendment must state original assumption, falsifying evidence, options including documented fallback, new selected behavior, risks, reversal conditions, affected invariants and tests. Do not scatter contradictory local exceptions across documents.

## 6. Phase and release discipline

Foundation/runtime/provider phases can be developed/tested independently with deterministic boundary mocks. Feature completion requires production integration, not an exported unused helper. Keep old/new runtime isolation until core cutover, then delete old live paths instead of maintaining two systems. P2 behavior/projection cannot be advertised merely because P1 styles work.

Before phase exit: compare acceptance matrix, run required suites, review unknown outcomes, update source/current-fact documentation, validate local Markdown links and roadmap/evidence references. Before release: full applicable test matrix, security/compatibility/perf/soak, manual product review, no unresolved P0, no false success messages. Release limitations stay visible; tests cannot prove arbitrary-website universality.

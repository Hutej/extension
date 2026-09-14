# Revueon — instructions for coding agents

## Product and authority

Read `all-about_revueon.txt`, then `plan/README.md` and `plan/00-master-blueprint.md`. Revueon reshapes website appearance, layout, interactions and workflows while preserving original functionality. It is not only a theme generator and must not execute model-generated scripts.

`plan/` is authoritative for the target architecture. `plan/01-repository-audit.md` describes the inspected current baseline and complete `project/src/` reading ledger. Legacy `docs/ARCHITECTURE.md`, `docs/TOOLS.md`, `docs/TESTING.md` and old source comments are not current architectural authority. Distinguish verified source facts from proposed design and unresolved unknowns.

## Before changing files

1. Inspect Git status/branch; preserve pre-existing owner edits/deletions. Never reset a dirty checkout to obtain a clean baseline.
2. Read `plan/23-invariants.md`, `plan/24-implementation-protocol.md`, and the current checkpoint in `plan/25-roadmap.md`.
3. Select the next unchecked task whose prerequisites passed. Read its module/data/runtime/test/acceptance contracts and inspect all source it affects.
4. Work only within that task. If the user requests documentation-only work, do not modify implementation/config/test files.

Application commands run from `project/`, not repository root. Source is `project/src/`; WXT is the existing build system. Current release state (S9.2): typecheck, lint and build pass; the default gate is 374 unit + 41 browser tests, 0 known-red; `npm run test:stress` is the isolated S9.1 stress/perf suite. Do not claim green baseline from stale sessions — verify with the commands.

## Architecture rules

- Models propose bounded typed data. Provider/profile substitution must not change runtime validation, recovery or safety.
- Visible workspace owns planning/provider calls; MV3 broker owns privileges/storage; one per-document runtime owns page effects and inverses.
- Every mutation has document/route fencing, operation identity and prepared ownership. Timeout means unknown, not “nothing happened.”
- Stop disarms provisional effects; accepted prior work survives model failure. Cleanup conflicts remain visible.
- Preserve original native nodes/listeners. No clone/innerHTML restoration of native UI, raw model HTML, arbitrary JS, or unsafe network-valued CSS.
- Saved intent revisions, live resource ledger and observation evidence are different state. Replay is local deterministic reconciliation, never another model loop or historical click replay.
- Single-node and approved future-set targeting have different contracts; neither uses a unique selector/hash as proof of identity.
- Missing verification is unknown, never pass. Never resize/move the user's browser window to test a transformation.
- Explicit user/site/provider consent, least privilege and field-level privacy filtering are mandatory.
- No unused abstractions, advertised stubs or new dependencies without justified task/ADR ownership. Follow the consolidated physical layout, not one file/class per logical contract heading.
- One proposal is one ordered reversible batch; no optional-group dependency engine. Use native CSS for visual details/motion and one generic insertUI creator for owned elements. Canvas is a bounded later leaf capability, not a graphics framework; see `plan/28-capability-coverage.md`.

## Tests and progress

Follow `plan/20-testing-strategy.md` and `plan/21-test-matrix.md`. Use actual current source and a freshly built extension; default correctness tests require no live model or private account. Existing commands: `npm run typecheck`, `npm run lint`, `npm run build`, `npm test` (default gate: unit + browser), `npm run test:stress` (isolated stress/perf — outside the default gate by design). The zero-discovery refusal lives in `scripts/test-gate.ts`. New proposed scripts are not assumed to exist before their task.

Add a runnable regression for nontrivial changes. Run focused tests, required browser/failure/undo cases, then task regression gates. Do not remove failing assertions or mock the subsystem under test to claim success. Provider quality and runtime correctness are separate measurements.

Record concise implementation evidence in one `plan/progress.md` log when work begins: changes, commands/cwd/test counts, build/source IDs, results, residual risks and next task. Do not create a narrative report per task/helper; link a separate artifact only when genuinely needed. Check roadmap boxes only after required outputs/tests/acceptance pass. Keep checkpoint current so another session can continue without chat history.

## Failure and architectural change

Use `plan/14-failure-and-fallbacks.md`; preserve partial diff and exact failure evidence. If a required tool/subagent workflow fails, stop that governed path and report it; do not silently switch execution protocol or claim tests ran. Architecture changes require the review/ADR/progress updates in `plan/24-implementation-protocol.md`. Never weaken safeguards because a model is weak, output is malformed or a benchmark is slow.

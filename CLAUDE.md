# Revueon — implementation-agent entry point

Follow `AGENTS.md` for repository rules. The authoritative blueprint is `plan/README.md`; the implementation checklist and current checkpoint are `plan/25-roadmap.md`. This file adds no alternative architecture or model-specific exception.

## Required startup reading

1. `all-about_revueon.txt` — product vision beyond CSS/theming.
2. `plan/00-master-blueprint.md` — target runtime/provider/storage boundaries.
3. `plan/01-repository-audit.md` — verified current facts and all-source reading ledger.
4. `plan/23-invariants.md` and `plan/24-implementation-protocol.md` — safety, evidence and evolution rules.
5. Next ready roadmap task and its linked module/data/test/acceptance documents.

Application cwd is `project/`; source is `project/src/`. Preserve owner changes in the dirty checkout. Legacy `docs/` and source comments about absent tests/proof are historical, not authority. All target architecture described in `plan/` starts as proposed, not already implemented.

## Non-negotiable implementation behavior

- Keep provider/model strength out of deterministic correctness. Any supported model protocol can propose data; only validated runtime capabilities execute.
- One page mutation owner; document/route fencing and operation receipts; inverse ownership before effects.
- No arbitrary model code/HTML, unvalidated CSS URLs, clone-based native UI undo, or hidden model fallback.
- Saved intent is not a tool-call transcript. Replay/resize/mutation/toggle/undo make no model calls.
- Unknown verification/cleanup is not success. Preserve accepted work and newer site/user state during failures.
- User can Stop/disable; no long full-page input blocker or browser-window resize for production verification.
- Add behavior/workflow capabilities through their scoped tasks; do not claim Kanban/keyboard-first support from styling alone.
- Implement cohesive files from `plan/02-layers-and-dependencies.md`, not one class/file per logical heading. One ordered batch replaces optional-group graphs; use native CSS and generic insertUI. Read `plan/28-capability-coverage.md` for new elements, motion, micro-details and bounded Canvas 2D, including limits.

## Completion discipline

Use actual tests, not historical claims. At planning baseline `npm test` had no unit tests and a missing browser runner; S0.1 repairs this before architecture migration. Run commands from `project/` and rebuild before browser tests. Follow the execution order in `plan/20-testing-strategy.md` and task T/AC/I references.

Keep concise task evidence in one `plan/progress.md` log during implementation, then mark nested roadmap boxes only after required checks pass; do not duplicate roadmap contracts into a report per task. Record blockers instead of improvising. Changes to ownership, trust, schema or operation semantics require ADR/plan/test/roadmap updates under the implementation protocol. Documentation-only user requests authorize no production/config/test changes.

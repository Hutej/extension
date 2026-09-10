# Hostile architecture review and final self-audit

Purpose: record adversarial review of this blueprint, revisions made, evidence limits and coverage of the requested planning task. **This was an architectural self-review, not a claimed independent subagent review, browser proof or completed implementation.** All product code remains unchanged by this task.

## 1. Review method

Read every file in `project/src/` before architectural judgment; traced current observation→model→act→verification→undo→persist→replay across contexts. Then designed target ownership/contracts and challenged it with late messages, competing revisions, weak models, dynamic pages, worker loss, rollback conflicts, missing verification, storage races and inaccessible browser surfaces. Re-read cross-document contracts after fixes; documentation integrity checks accompany final delivery.

## 2. Findings against the initial target draft and revisions

| Challenge | Problem in first draft / risk | Revision made | Proof required in implementation |
|---|---|---|---|
| Repeated text revision then disable | A→B→C could restore B instead of original site A if prior inverse discarded | Separate site-base inverse and predecessor rollback state; transfer base on accepted replacement | T09/T30, AC04; runtime/data/state/A4/A5 updated |
| Refinement persists transformed label as identity | Cold replay sees original A but new descriptor might require rendered B | Continue original stable descriptor; exclude own-modified fields; session-only if no independent anchor | T05/T10; observation/data descriptor refinement |
| Refining earlier customization changes cascade | Per-group physical sheet append order could override user order | Canonical per-root aggregate stylesheet, normalized specificity, at most accepted+staged bundles | T07/T30, AC06; compiler/styles/limits/ADR07 updated |
| First operation succeeds, later operation fails | Early acceptance could silently ship an incomplete request | Current simplified design: one ordered batch, all mandatory checks together, complete candidate rollback; no subgroup DAG | T08/T13/T30/T31; master/state/runtime/algorithms updated |
| Cross-frame “atomic” change | Separate per-frame runtimes cannot promise combined DOM transaction | V1 one DocumentKey/proposal, explicit frame selection, session-only frame transformations; no cross-frame dependencies | T06/T14; browser contract and S8.3 added |
| Frame support buried in release phase | Qualification task contained implementation of missing frame subsystem | Dedicated S8.3 root/frame task with scope, tests and completion contract | S9 becomes qualification, not undefined frame implementation |
| Late CSS ack after cancel/navigation | Privileged insert is not abortable, tab may now show another route | DocumentId fence, unique token namespaces, disarm before cleanup, exact operation query/compensation | T08/T14; never rely on insertCSS dedupe |
| Extension update loses session receipts | Old DOM tokens could survive reinjection and reactivate leaked CSS | Non-secret installation namespace, strip identifiable old-runtime tokens, otherwise require clean reload | T14/T26; namespace ownership not treated as secret security boundary |
| Local route changes before broker event | Asynchronous webNavigation notice can lag | Re-read actual local route immediately before non-awaiting commit; old epoch rejects | T11/T14; runtime/session/transaction and A4 |
| Broker restart between local verification and save | Inserted-versus-accepted CSS ownership could be ambiguous | CommitComposition metadata acknowledgement precedes reported acceptance; retain predecessor until final runtime check; query live receipt before cleanup on restart | T08/T14; message inventory/sequence/runtime/A4 |
| Replay has no workspace heartbeat | User-run lease policy could accidentally require open UI for saved customization | Runtime-owned replay has saved grant plus bounded local 5s transaction deadline, no workspace/provider dependency | T10/T14; concurrency lease policy |
| “Any model” interpreted as guaranteed output | Arbitrary model can return nonsense forever | Explicit supported-protocol contract, bounded correction, identical runtime guarantees and honest inability; no stronger-model dependency | T19/T20/AC05; separate quality benchmark |
| Operation/property semantics left too open | Weaker implementation agent could invent a permissive CSS/HTML/action parser | Finite operation/node/attribute/predicate grammar; browser/parser visual CSS vocabulary plus explicit security/impact rules, not an incomplete property dictionary | T02/T07/T31; capability metadata mirrors executable policy |
| Safe CSS mistaken for sole risk policy | Opacity/display/pointer-events can hide controls without named hide op | Equivalent CSS and named operations share impact/target/grant policy | T07/T13/T21 |
| Clone “exact undo” | Markup identity is not native listener/media/form identity | Same-node Text/resource restoration, explicit conflicts instead of clone/HTML repair | T09/T18 |
| Verifier absence “clean” | Empty fallback arrays/old clean state can bless new damage | Exact revision/epoch report with mandatory unknown preventing acceptance | T13, AC03 |
| Model-generated output “not private” | Annotation can repeat private page text | Content sensitivity applies to output, saved labels/paths and exports too | T04/T25/AC07 |
| Observer resurrects user-removed state | Reconcile can fight user expansions/site text changes | Per-instance override, compare-and-restore and conflict circuit breaker | T11/T16/T23 |
| Unbounded abstraction growth | Broad product request could create general agent graph/DSL/server | No graph DB/framework/layout solver/arbitrary programs; finite concrete modules and measured parser dependency | Dependency gate + ADR review |

## 3. Failure simulation outcomes

- **Init fails after one listener:** reverse partial setup; no page effects; typed runtime unavailable.
- **Page rapidly mutates during observation:** bounded partial evidence; revalidate affected refs, never global endless retry.
- **Page navigates during model/insert/verification:** invalidate route/document; disarm old candidate; ignore old response, reconcile resource outcome.
- **Window resized/zoom changed:** invalidate relevant layout evidence; recheck actual user size; never move user window for proof.
- **Two customizations/requests conflict:** one document queue/run owner; explicit resource claims and canonical style order; no duplicate structural owner.
- **Model timeout/malformed/refusal:** shared bounded retries/correction; candidate absent/rolled back; accepted saved work survives.
- **Body stream never completes:** deadline/byte cap spans body; abort and no parsed partial execution.
- **Service worker dies after API call:** intent receipt remains; hydration/query/cleanup before another insert, namespace prevents stale activation.
- **Workspace closes during preview:** local lease expires; provisional disarmed/rolled back; accepted resources retained and inspectable.
- **Site changes original Text/parent while undo pending:** preserve new state, report conflict, don't restore clone onto replacement.
- **Saved state conflicts/quota fails:** reject overwrite or applied-unsaved; user can retry/export/undo.
- **30-minute mutation session/memory pressure:** bounded queues/ref caches/diagnostics; no live inverse eviction or background model polling; pause conflicting group.
- **Root/frame inaccessible or browser feature missing:** explicit unsupported/partial scope, local style/projection alternative only after approval.
- **Projection source disappears:** disable stale action, show source unavailable; never activate next row by index.

These are design outcomes. Tests still have to establish that future implementation follows them.

## 4. Remaining unknowns and safe resolution defaults

| Unknown | Safe default | Resolution task / evidence |
|---|---|---|
| Real installed-user base/state | Preserve legacy records disabled; no destructive migration | S5.1/S6.3 user-approved inventory/import tests |
| Minimal Chrome/API/CSS/worker/BFCache behavior on supported OS | Capability-gated unsupported; no false compatibility claim | S2.2/S8.3/S9.1 actual built-browser tests |
| Arbitrary provider's auth/CORS/structured-output support | Base text contract where reachable; explicit connection test, no hidden proxy | S6.1 mock+user-approved real endpoint test |
| Reference performance on user's hardware | Budgets are proposed, not measured | S0 records environment; S9.1 distributions/soak |
| Live-site framework/affordance stability | Conservative local/projection fallback, session scope if needed | S7/S8/S9 authorized manual site review |
| Semantic classification of future subjective “bait” | No automatic inference; explicit predicate/current-item selection | Future opt-in cost/privacy ADR if requested, not hidden per-item model loop |
| Zero-flash replay | No guarantee; prioritize validated target application | Measure separately S9.1; don't insert unchecked CSS before paint |
| Full arbitrary browser/site coverage | Advertise only actual tested capability matrix | AC10/12; closed/private surfaces remain explicit limits |

## 5. Requested blueprint coverage audit

| Question/domain | Answer location |
|---|---|
| What is Revueon; vision priority and model independence? | 00, 09, 11, 26 |
| Entire repository evaluated; verified/inferred/proposed/unknown? | 01 full 42-file ledger and baseline; README authority; 12 platform sources |
| Complete layers, boundaries, module inputs/outputs/state/lifecycle/errors? | 02, 03, 04, 05 |
| All significant data schemas, persistence/migration/serialization? | 04, 13, 19 |
| Concurrency, ordering, cancellation, idempotency, state machines? | 05, 06, 10 |
| DOM/semantic/layout/transformation mechanics and algorithms? | 07, 08, 09, 10 |
| Behavior/workflow breadth beyond CSS and safe limits? | 09, 08 operation grammar, S7/S8 roadmap |
| Alternatives/trade-offs/fallbacks/ADRs and reversal conditions? | 14, 18 |
| Real browser/MV3/shadow/frame/SPA/resize/zoom constraints? | 12 with linked primary sources; 06/07/13 |
| What to preserve/rewrite/move/delete and when? | 01 per-file disposition; 02 target paths; 19 migration/deletion ledger |
| Dependencies, coupling and unnecessary abstraction prevention? | 02, 03, 18, 23 |
| Performance/memory/latency/caching/cleanup and measurement? | 15, 20/21 |
| Security/privacy/provider/input and page trust? | 17, 04, 11, 12 |
| Observability/user status/diagnostics and control? | 16, 05 |
| Unit/component/integration/E2E/browser/failure/recovery/stress/compatibility tests? | 20, 21 |
| Test execution order and measurable success/failure? | 20, 22 |
| Exact implementation order/task inputs/outputs/invariants/tests/completion/follow-up? | 25 phase table + nested task contracts |
| Survive agent sessions, checkpoints, checkboxes, failure escalation and architecture evolution? | 24, 25, AGENTS.md, CLAUDE.md |
| Product requirement → component/module/task/test/acceptance? | 26 |
| Hostile review/failure simulation/revision/self-audit? | This document plus 14 |
| Entry/index/read order/authoritative document precedence? | README |

## 6. Initial blueprint verification (historical)

Initial planning deliverables were Markdown only: 29 focused documents in `plan/` (README plus 00–27), rewritten root `AGENTS.md` and `CLAUDE.md`. All implementation tasks remain unchecked; next task S0.1. No source/config/test/build implementation written or modified by this task.

Source-integrity check: SHA-256 comparison of all 42 `project/src/` files against hashes captured before planning passed. Existing dirty-tree source/config/doc deletions remain owner baseline. Current implementation commands actually observed: typecheck pass, lint 8 errors, env/wiring audits pass, `npm test` fails with missing browser runner after zero unit tests. No build/browser/live-model tests claimed run.

Documentation validation checks relative links, inventory count, T/AC/I references, roadmap task IDs, Markdown-only deliverables, and no implementation checkboxes pre-completed. First check passed 143 local links and found 21 unique implementation leaf tasks with zero completed boxes. A separate source-to-ledger set comparison caught four omitted tool rows in the initial audit table; these were added (the source files had already been read fully). The final source-to-ledger comparison passed all 42 paths and exact line counts; all 42 source SHA-256 hashes remain unchanged. Documentation-only new-file inventory and agent-document whitespace checks passed. After that initial review, validation passed 29 plan Markdown files, 144 local links, 42 complete source-ledger entries and 21 unique unchecked implementation tasks; no non-Markdown deliverables or source hash changes were found.

## 7. Owner-requested simplicity and capability revision

The follow-up review removed prospective complexity rather than implementation code (none of the new architecture is implemented yet): consolidated physical modules; one ordered batch instead of optional/required subgroup graphs; one concise progress log rather than report-per-task; native CSS vocabulary rather than a second incomplete property catalog. These are recorded in ADR-13 and applied to data/state/algorithm/roadmap/test contracts, not merely appended as advice.

Coverage gaps found: annotations alone were too narrow for generic element creation, and new Canvas 2D drawing had no implementation contract. Replaced annotation-only creator with generic insertUI and added one bounded canvas leaf task, reusing native DOM/CSS/Canvas APIs and the existing transaction path. No widget/scene/animation framework introduced. Native page canvas internals, arbitrary generated programs and silent remote asset downloads are explicitly not promised.

New [capability coverage](28-capability-coverage.md) maps all owner-listed categories to tasks/tests; T31 covers generic insertion/local refs and T32 owned canvas. S8.4 is the new canvas task, without blocking the core preview release. Insertion uses baseline absent for new nodes, exact original baseline for site nodes; behavior remains disarmed until batch acceptance. Pseudo-element selectors stay outside `:where()` and accessible decoration lives on decorative owned hosts. These details were checked against the reduced contract rather than removed as “complexity.”

All implementation boxes remain unchecked; next task S0.1. Follow-up validation passed: 30 plan Markdown documents, 160 local links, 22 unique unchecked implementation tasks, valid requirement/test/invariant references and 42/42 source-ledger entries. All 42 source SHA-256 hashes remain unchanged; no non-Markdown plan files or obsolete subgroup/annotation-only/progress-hierarchy contracts were found. Previous baseline code test results above remain historical; no production tests/build/model calls are newly claimed by a Markdown-only revision.

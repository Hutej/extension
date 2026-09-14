# Dependency-ordered implementation roadmap

**Persistent implementation state. All tasks below are not started.** Architecture documentation completion does not complete product implementation. Follow [protocol](24-implementation-protocol.md); use [module contracts](03-module-contracts.md), [matrix](21-test-matrix.md) and [acceptance](22-acceptance-criteria.md).

## Current checkpoint

- Current phase: **S9 — release qualification and final deletion**.
- Next task: **S9.2** (S9.1 complete — evidence in [29-s9-1-evidence.md](29-s9-1-evidence.md)).

## User-directed UX rework (2026-09-13, between S8.3 and S8.4)

The owner directed a beginner-first workspace rework (his words: "think user as
the dumbest person"; screenshots supplied). Small, owner-approved deviations
from earlier plan wording, all recorded here:

- **Target = the page the user is on** (plan/16 §1 "the user pins a document
  explicitly" is superseded): the workspace resolves the browser's ACTIVE tab
  (side panel semantics; the extension-tab fallback remembers the last real
  web tab via tabs.getCurrent — tabs.query reports the workspace's own tab
  with an empty URL, an honest browser quirk the fix names). No manual page
  picker exists anymore; a run in flight keeps its target (one run, one
  target). Embedded frames are NOT auto-targeted beyond the S8.3
  frame-only registration edge (a frame still requires explicit core API
  selection — session-only, boundary explained on save).
- **Chat panel**: the workspace is a conversation — the user types what should
  change, phase transitions render as chat messages in beginner wording,
  the proposal/question/retry cards live in the chat flow, Enter sends.
- **Separate pages**: Settings (provider, consent, AI on/off, diagnostics) and
  My changes (the saved-customization manager) are their own views — one
  screen at a time for a beginner.
- Manual pins are gone from the persisted settings (legacy pin fields decode
  and are ignored — old settings never break).

Real-browser evidence (headed Chromium, wikipedia.org): auto-target chip,
provider setup in Settings, "make the heading crimson" → plan card → Apply →
"Done — applied and saved", the real heading crimson, survived reload, My
changes disable reverted it exactly. Gates ×2 green (354 unit + 36 browser).
- Active task: none.
- Completed: S0.1 through S8.1 — the S6 cutover is complete (plan/19 §4); S7.1 shipped approved keyboard bindings (see below); **S7.2 completes AC-11's behavior clauses**: the owned collapse disclosure (`collapse` — toggle + owned state attribute + scoped fragment rule, exact release/rollback), and the finite `localRule` engine (trigger target-appeared, actions activateDisclosure/focus, conjunction predicates member-of/expanded-equals/text-contains, once-per-instance sticky state + 500ms cooldown, seed actions post-acceptance so no external click survives a rollback, replay expands the saved future-set per member with relative affordance resolution, reconcile re-applies pick up new members while the sticky once-per-instance state keeps user overrides intact — T16 proven end-to-end). **S8.1 ships linked projections** (`projectCollection`): a list/grid/board view of the observed items in one source container, rendered through the finite field catalog (title/label/link/category) with stable canonical item keys, local-only board buckets (drag + native select, never touching the source DOM), "Show original" reveal, stale/duplicate-key marking with disabled key actions, ≤200 rendered items with coverage + pagination, session-scoped user arrangement that survives release/re-apply, and an explicit consequential review when `showOriginal:false` hides the original set — descriptor resolution now excludes the runtime's own view so projection UI is never site evidence (T17 proven end-to-end). **S8.3 completed the frame/root capability boundary** (one runtime per individually permissioned frame with explicit exact-frame pinning; the broker relay now targets the registered document's exact frame — T06 found the bare-broadcast relay racing frame fence rejections; root-local author stylesheets with a bounded measured inline override for open shadow roots; frame saves are session-only with the boundary explained). **S8.2 ships floating surfaces and gated relocation** (`float`: the existing surface fixed at one corner through the measured compiled style path with a runtime-owned minimize/restore control; `relocate`: explicit structuralGrant, protected native targets refused with the projection/CSS fallback named, the exact node moves with listeners and focus, the site's newer position wins with a visible conflict, and two site overrides suspend relocation for the document — T18 proven end-to-end; the replay now releases on disable/removal whenever the transaction holds a live revision). S7.1 details: the finite bind catalog (focus/scrollIntoView/activate/followLink/toggleDisclosure) on observed targets, one document keydown listener with exact per-binding registry ownership, prepare-time reserved/plain-typing/conflict/cap refusals, event-time IME/password/editable/modal/repeat/visibility eligibility that consumes no key until eligible, and an approval review that names the target and warns that the site's own effect is non-reversible (plan/09 §1/§2).
- Known baseline blockers: none. Residual: an actual Chrome 120 install run is not available in this environment (current-stable Chromium proven; floor declared in the manifest); streaming + capability-probe connection tests deferred from S6.1 (recorded); reconciliation set-membership changes re-apply whole customizations (bounded by the conflict pause); the planner prompt still advertises collapse/float/relocate as vocabulary although their executors are refused as unsupported-capability at apply (pre-existing honesty gap — the refused batch surfaces in the workspace; S7.2/S8 own those executors); browser-level IME composition cannot be synthesized over CDP (Input.dispatchKeyEvent has no isComposing) — the composition decision is unit-proven on the pure evaluator and the listener is three lines.
- Planning baseline: dirty `main` at `71263e0938e0a3d3a2a5e7a44d2175898b9e8c0b`; owner's changes preserved.
- Evidence: `plan/progress.md` (one compact log).
- Simplicity: follow consolidated physical files in document 02. Detailed module names below are logical responsibilities, not mandatory files/classes. One ordered batch per proposal; no subgroup DAG. Capability coverage including insertion/motion/canvas is in document 28.
- Implementation selection: next unchecked task with prerequisites satisfied. No dependencies may be waived by changing checkboxes.

## Dependency graph

```mermaid
flowchart LR
  S0 --> S1 --> S2 --> S3 --> S4 --> S5 --> S6
  S6 --> S7 --> S8 --> S9
```

Provider adapters may be developed in isolation after S1, but S6 cannot complete before runtime/persistence integration. No P2 feature blocks P0 foundations. Phase numbers are order; P0/P1/P2 labels are priority/severity.

## Phase exit and rollback contracts

| Phase | Objective / why it exists | Prerequisites and exact scope | Exit validation / failure condition | Rollback / next dependencies |
|---|---|---|---|---|
| S0 P0 | Restore trustworthy evidence before changing architecture | Current tree; actual Node/Playwright harness, lint/import/build inventory | Nonzero deterministic tests; missing/stale suites fail; don't claim current defects fixed | Revert only task-owned harness/config edits; S1 depends on gates |
| S1 P0 | Fix data/authority contracts before execution | S0; schemas/errors/limits and trust/disclosure boundaries | T02/T04/T21/T25 contract tests; failure if unknown input grants authority | No enabled v2 effects yet; S2/isolated provider work depend on contract |
| S2 P0 | Establish document and privileged effect ownership | S1; broker hydration, runtime identity/queue, style intent/receipt | T08/T14 fencing/restart/duplicate tests; failure if late insert can activate | Disarm namespaces and remove task resources; S3/4 depend on handshake |
| S3 P0/P1 | Replace unsafe/expensive observation targeting | S2; one bounded collector + target registry/root support baseline | T03–T06; failure if coverage lies or wrong node resolves | Keep isolated old runtime only in separate test document; S4 consumes refs |
| S4 P0/P1 | Deliver reversible tested local transformation vertical slice | S3; compiler, policy, style/hide/text/generic insertUI transaction and verifier | T07–T09/T13/T30/T31; failure if partial mutation unowned or missing verifier passes | Release v2 groups, restore accepted predecessor; S5 uses same apply/replay path |
| S5 P1 | Make accepted work durable and dynamic | S4; OriginRecord writer + saved-intent reconciliation/scope | T10–T12/T26; failure if stale history replay/leak/duplicate/lost update | Disable v2 replay, preserve/quarantine records; no legacy auto-replay; S6 integrates user flow |
| S6 P1 | Replace model lock-in and popup lifecycle; core cutover | S5; adapters/controller/workspace/consent/status, remove old live runtime | T19–T21/T27/T29 + AC01–10 applicable; failure if strong model required for safety | Explicit package/dev runtime rollback only after cleanup/reload; v2 state never down-converted; S7 features depend on core |
| S7 P2 | Add actual keyboard/local behavior | S6; approved action catalog/bindings/disclosures finite rules | T15/T16 and AC11; failure if editing intercepted or external action auto-replayed | Disable capability and owned listeners; core presentation remains; S8 projections consume actions |
| S8 P2 | Deliver workflow/graphics breadth and floating existing controls | S7; source-linked projections, floating/guarded relocation, owned Canvas 2D | T17/T18/T28/T32 and AC12; failure if source fiction/cloned controls/lost playback | Remove projection/revert local group; retain original UI; S9 validates full product |
| S9 P1/P2 release | Harden measured performance/compatibility and complete deletion | All previous; stress/soak/platform matrix/legacy cleanup/manual quality | All applicable acceptance, no P0; unsupported features honestly excluded | Revert release package/task only, no destructive storage downgrade; future evolution via ADR |

Each phase also requires updated plan/current-fact docs and dependency/link checks before parent checkbox completion.

---

## S0 — Evidence foundation

Read: [audit](01-repository-audit.md), [testing](20-testing-strategy.md), [migration](19-migration-and-deletion.md).

- [x] **S0 phase completed**
  - [x] **S0.1 — Restore executable baseline and architectural gate**
    - Goal/inputs: current source/config/lockfile and F01/F21–F24 evidence; preserve dirty baseline.
    - Changes: establish real unit/browser fixture harness; fail zero-test/missing/stale builds; fix current lint errors without changing product contracts; add resolved import gate using installed TypeScript; document exact commands.
    - Outputs: runnable scripts/tests, fresh built-extension smoke, baseline regression fixtures for wrong-target/clone/missing-verifier/late-dispatch failures.
    - Invariants: I27/I28; test harness cannot bypass production broker/runtime path under test.
    - [x] Tests: T01/T29 negative controls and relevant existing pure-helper baseline.
    - [x] Validation: typecheck/lint/build plus test counts recorded; known defects explicitly red/characterized, not hidden.
    - [x] Completion: S0.1 entry in `plan/progress.md` records working commands, source SHA and baseline; no references to absent historical proof as current evidence.
    - Follow-up: S1 contracts become safely testable.

## S1 — Contracts and trust boundaries

Read: [data](04-data-contracts.md), [security](17-security-and-privacy.md), [layers](02-layers-and-dependencies.md).

- [x] **S1 phase completed**
  - [x] **S1.1 — Define versioned operation/message/provider/record schemas**
    - Goal/inputs: master requirements and data tables; S0.1.
    - Changes: unknown→validated DTO decoders, finite operation metadata, IDs/epochs/receipts, ordered batch/local-ref validation, structured error taxonomy, named limits. No nested groups or dependency graph executor.
    - Outputs: contracts consumed by tests/prompt metadata; no live unimplemented capabilities advertised.
    - Invariants: I01/I04/I11/I13/I20/I27.
    - [x] Tests: T02; nested graph fields/duplicate or forward local refs/missing target/version/unknown fields/bounds/ambiguous JSON negative cases.
    - [x] Validation: import gate proves contracts have no DOM/extension/fetch dependencies.
    - [x] Completion: schemas and conceptual examples agree, all decoding tests pass; evidence S1.1.
    - Follow-up: S1.2/S2 and isolated provider adapter development.
  - [x] **S1.2 — Implement trust/grant/privacy boundary foundation**
    - Goal/inputs: S1.1; security disclosure/endpoint rules.
    - Changes: sender-role validation, TRUSTED_CONTEXTS storage access, explicit grant/disclosure versions, field-level evidence filtering, exact endpoint/redirect/auth validation.
    - Outputs: denied-by-default permission functions usable by broker/workspace; existing implicit consent not accepted as v2 grant.
    - Invariants: I18/I19/I24.
    - [x] Tests: T04/T21/T25 sentinel and forged-authority cases.
    - [x] Validation: model/page `consent` cannot authorize, no credential in content DTO.
    - [x] Completion: trust boundary tested through simulated actual extension sender metadata; evidence S1.2.
    - Follow-up: broker can accept narrowly privileged requests.

## S2 — Lifecycle and privileged ownership

Read: [state](05-state-and-lifecycle.md), [events](06-events-and-concurrency.md), [browser](12-browser-runtime.md), [fallbacks](14-failure-and-fallbacks.md).

- [x] **S2 phase completed**
  - [x] **S2.1 — Build document broker/runtime bootstrap and serialized queue**
    - Goal/inputs: S1; DocumentKey/Epoch/Envelope.
    - Changes: synchronous listeners + hydration barrier, one runtime/document, one workspace owner, navigation invalidation, typed dispatch, cancellation/queue priorities.
    - Outputs: testable no-op/observation message vertical path with exact document identity, no mutation yet.
    - Invariants: I03/I04/I06/I22.
    - [x] Tests: T08/T11/T14/T21 for old document/new tab/duplicate instance/Stop ordering.
    - [x] Validation: no history monkey patch reliance; old and new runtimes only on separate test documents.
    - [x] Completion: late messages deterministically rejected, bootstrap disposal releases listeners; evidence S2.1.
    - Follow-up: S2.2 style delivery and S3 observation.
  - [x] **S2.2 — Implement CSS delivery intent/receipt and inert namespaces**
    - Goal/inputs: S2.1; exact CSS resource contract.
    - Changes: per-document broker queue, intent-before-insert session write, documentId target, operation dedupe, exact removal/restart reconciliation; runtime token activation/disarm primitives.
    - Outputs: scoped CSS delivery with explicit unknown status; delayed ack cannot activate revoked namespace.
    - Invariants: I05/I06/I07/I10.
    - [x] Tests: T07/T08/T14—kill worker at every delivery boundary, duplicate ID altered payload, permission revoked.
    - [x] Validation: no reliance on undocumented browser CSS dedupe; author-normal/user-important behavior checked.
    - [x] Completion: exact operation cleanup succeeds or explicit conflict, no false ack; evidence S2.2.
    - Follow-up: S4 can stage resources safely.

## S3 — Observation and targeting

Read: [observation](07-observation-and-targeting.md), algorithms A1/A2, module rows for observe/facts/targets.

- [x] **S3 phase completed**
  - [x] **S3.1 — Replace inventory/identity with bounded semantic snapshots**
    - Goal/inputs: S2, target contracts, actual source collector primitives.
    - Changes: one root-aware bounded pass, same-node refs, stable descriptors and approved sets, action/field evidence, safe style/text samples, partial coverage/cursors, targeted inspect/discovery.
    - Outputs: complete proposal evidence path with no model call and no global stamping; old perception not imported by v2 runtime.
    - Invariants: I15/I16/I18/I21/I26.
    - [x] Tests: T03–T06/T24; duplicate IDs/recycle/huge DOM/open root/privacy/stale cursor.
    - [x] Validation: ≤100ms initial local work target on 2k fixture; partial 10k/50k coverage truthful; no long synchronous enrichment tail.
    - [x] Completion: snapshot fields and target resolution meet AC02; evidence S3.1.
    - Follow-up: safe compiler/operation groups.

## S4 — Reversible transformation runtime

Read: [runtime](08-transformation-runtime.md), algorithms A3–A5/A7, [acceptance](22-acceptance-criteria.md).

- [x] **S4 phase completed**
  - [x] **S4.1 — Build parsed CSS/content compiler and policy**
    - Goal/inputs: S3 target refs + S1 capability/grant schemas.
    - Changes: introduce justified pinned CSS parser after license/security/bundle check; browser-native visual properties/conditions/keyframes plus focused security/impact policy; generic safe insertUI tree/local IDs, target/risk claims and exact diagnostics. Cover typography/micro-details/motion without property-per-feature modules.
    - Outputs: resource plans only; no arbitrary CSS selectors/HTML/model code mutation sink.
    - Invariants: I01/I17/I18/I21.
    - [x] Tests: T02/T07/T22/T30/T31 syntax/injection/priority/ordered refs/conflict, modern visual CSS and motion corpus.
    - [x] Validation: valid responsive fixed mini-player sizing is not rejected by pixel-ratio heuristic; unsupported syntax rejected explicitly.
    - [x] Completion: all compiler negative controls pass; dependency recorded; evidence S4.1.
    - Follow-up: S4.2 execution.
  - [x] **S4.2 — Implement one-batch transactions and generic element insertion**
    - Goal/inputs: S4.1 resource plans, S2.2 receipts.
    - Changes: prepared ledger, same-node inverses, single ordered batch acceptance, predecessor/site-base restoration, canonical CSS replacement and bounded conflict claims. Implement insertUI containers/cards/panels/local native controls with validated before/after/first-child/last-child placement and same-batch local styling; annotation is not a separate op.
    - Outputs: candidate apply/rollback path callable by deterministic test controller; no global undoAll.
    - Invariants: I03–I10/I12/I23.
    - [x] Tests: T08/T09/T14/T30/T31 crash at every side-effect/await, original identity, element placement/local refs/nesting/label validation, same-batch styling and exact cleanup.
    - [x] Validation: every live resource has prepared ownership; rollback never touches independent previous customization.
    - [x] Completion: pass/fail/unknown receipts accurate under all fault points; evidence S4.2.
    - Follow-up: verification controls acceptance, S5 uses same path.
  - [x] **S4.3 — Implement mandatory structured verification and combined revision gate**
    - Goal/inputs: S4.2 + documented property/focus/layout/content postconditions.
    - Changes: affected target/sentinel baselines, delivery/effect/integrity split, structured keys, alpha/unknown coverage, bounded settle and one recheck; no automatic real-window resize.
    - Outputs: exact revision VerificationReport required for acceptance, combined customization verification.
    - Invariants: I11/I12/I21/I22.
    - [x] Tests: T13/T22/T30; missing verifier after clean predecessor, already-satisfied effect, authorized hide versus ancestor loss.
    - [x] Validation: no empty-array fallback passes failure; mandatory unknown rolls back provisional; AC03/04.
    - [x] Completion: acceptance only via report for current revision; evidence S4.3.
    - Follow-up: save/replay can trust accepted intent, not model prose.

## S5 — Durable customization and continuity

Read: [persistence](13-persistence-and-replay.md), algorithms A6/A9, [migration](19-migration-and-deletion.md).

- [x] **S5 phase completed**
  - [x] **S5.1 — Implement versioned origin records and canonical revisions**
    - Goal/inputs: S4 accepted receipts, S1 schema/grants.
    - Changes: serialized origin writer, expected revision/mutation ID, active/previous revisions, quotas, tombstones, scope/discriminator UI DTOs, legacy quarantine/import validation.
    - Outputs: explicit saved/conflict/applied-unsaved state; no accumulated tool journal replay.
    - Invariants: I13/I18/I19/I21.
    - [x] Tests: T12/T25/T26/T30 concurrency, quota, interruption and old HTML records.
    - [x] Validation: one complete record write acknowledged; legacy records untouched/disabled; AC06/07.
    - [x] Completion: conflicting saves never overwrite silently; evidence S5.1.
    - Follow-up: S5.2 replay and UI customization management.
  - [x] **S5.2 — Implement route-aware local reconciliation and replay**
    - Goal/inputs: S5.1 records + S3 descriptors + S4 transaction path.
    - Changes: dirty dependency index, missing/ambiguous/waiting/suspended state, set enrollment, route scope enforcement, permission revocation, disable/remove across registered documents.
    - Outputs: saved customization survives compatible reload/re-render without model; per-document cleanup receipts.
    - Invariants: I04/I07/I10/I14/I15/I23/I26.
    - [x] Tests: T10/T11/T14/T23; query/hash apps, BFCache, recycled items and disable pending style.
    - [x] Validation: repeated replay no duplicate widget/listener; mutation CPU within budget; no provider import/call.
    - [x] Completion: apply/refine/save/reload/undo/disable/remove sequence meets AC06; evidence S5.2.
    - Follow-up: core product user integration.

## S6 — Model independence, workspace and core cutover

Read: [providers](11-model-providers.md), [UX](16-observability-and-ux.md), ADR02/09, [cutover](19-migration-and-deletion.md).

- [x] **S6 phase completed**
  - [x] **S6.1 — Implement provider adapters and bounded planning controller**
    - Goal/inputs: S1 contracts, S3 evidence, S4 validation/receipts; adapter code can begin after S1 but integration needs S5.
    - Changes: OpenAI-chat/Anthropic/local profiles, exact endpoint auth, bounded streaming/nonstreaming client, schema decode, recent context and one shared correction budget; model calls in visible workspace.
    - Outputs: arbitrary compatible model selection without source edits; one-call common path, no provider dependency in runtime.
    - Invariants: I01/I02/I12/I18/I20.
    - [x] Tests: T02/T19/T20/T25 across mock strong/weak/text-only/malformed/slow providers.
    - [x] Validation: ≤4 responses/≤6 HTTP attempts, body deadline/Stop, explicit unsupported protocol; AC05.
    - [x] Completion: identical runtime safety results for all model profiles; evidence S6.1.
    - Follow-up: workspace/user settings integration (streaming + capability probe deferred until a task needs them — recorded in progress S6.1).
  - [x] **S6.2 — Build accessible shared workspace and truthful state management**
    - Goal/inputs: S6.1 controller, S5 records/live projections, security disclosures.
    - Changes: sidepanel + extension-tab fallback, exact target selector, provider settings/consent/opt-out, question/approval UX, always available Stop, customization list/undo/scope and diagnostic panel.
    - Outputs: real user workflow no ephemeral popup dependency or full-page blocker; local status immediate.
    - Invariants: I10/I19/I22/I24.
    - [x] Tests: T14/T21/T25/T27 plus keyboard/axe component tests.
    - [x] Validation: no false success, arbitrary-tab fallback, implicit consent or dead opt-out; AC07/09.
    - [x] Completion: close/reopen and partial/unsaved/conflicted states correct; evidence S6.2.
    - Follow-up: production entrypoint cutover (the legacy popup remains the toolbar default until S6.3 removes it; the sidepanel page + tab fallback are the v2 workspace).
  - [x] **S6.3 — Cut over core runtime and remove legacy live paths**
    - Goal/inputs: S6.1/2 plus all S0–S5 gates; migration record.
    - Changes: switch WXT entrypoints; disable old loop/CSS/DOM replay/dispatch together; quarantine state; remove migrated legacy imports/files; legacy docs become pointers.
    - Outputs: one v2 runtime and canonical provider/store/target paths; core preview release explicitly lists unavailable P2 features.
    - Invariants: I03/I13/I27/I28.
    - [x] Tests: full deterministic core T01–T14/T19–T22/T25–T27/T29–T31 applicable, fresh build at min/current Chrome. (Current-stable Chromium proven; the 120 floor is declared in the manifest — an actual Chrome 120 install run is not available in this environment, recorded as residual.)
    - [x] Validation: no live legacy runtime/source path, no unsafe auto migration; AC01–10 applicable.
    - [x] Completion: deletion subset in migration ledger verified, evidence S6.3, next task S7.1 recorded.
    - Follow-up: P2 capabilities build on stable product, not old stubs.

## S7 — Behavior and keyboard-first workflows

Read: [behavior](09-behavior-and-workflows.md), algorithm A10, [security](17-security-and-privacy.md).

- [x] **S7 phase completed**
  - [x] **S7.1 — Install approved native action bindings**
    - Goal/inputs: S6, observed action catalog, trusted input rules.
    - Changes: finite chord/action schema, editable/IME/modal/repeat/reserved-key checks, conflict preview, exact listener ownership, focus/scroll/approved activation.
    - Outputs: keyboard-first navigation/control with no synthetic privilege or backend automation promise.
    - Invariants: I05/I14/I24.
    - [x] Tests: T15/T21/T30 and gesture-gated API manual fixture checks.
    - [x] Validation: ≤4 local steps; no key consumed until eligible; uninstall/reload no duplicate bindings.
    - [x] Completion: AC11 binding requirements pass; evidence S7.1.
    - Follow-up: local disclosure rules and projection actions.
    - Notes: the "conflict preview" is the proposal review naming chord/actions/target + the apply-time refusal naming the owning customization (no probe command was added — YAGNI); the S7.1 keys fixture also exposed and fixed a pre-existing verifier bug (sibling sentinels shared one baseline key → false integrity fails).
  - [x] **S7.2 — Implement collapse and finite local behavior rules**
    - Goal/inputs: S7.1 plus S5 reconciliation.
    - Changes: owned disclosure, approved native expanded-state action, once-per-instance/user override/cooldown, suspension on conflict; persist rule not action history.
    - Outputs: automatic compatible new-comment collapse and explicit manual override; no generic observer click.
    - Invariants: I14/I23/I24.
    - [x] Tests: T16/T23—new instance, repeated mutation, user expansion, disable/reload.
    - [x] Validation: native external action never auto-replayed; conflict fallback owned collapse UI.
    - [x] Completion: AC11 fully met; evidence S7.2.
    - Follow-up: workflow projections/interaction recomposition.
    - Notes: the rule fires through the site's OWN disclosure (activateDisclosure); seed actions fire post-acceptance so an external click never survives a rollback; replay expands the saved rule per member with relative affordance resolution (affordance descriptors are never document-resolved); `owned-state-equals` predicates and the trusted-shortcut/owned-state-change triggers stay explicit unsupported-capability refusals.

## S8 — Workflow and layout breadth

Read: [workflow designs](09-behavior-and-workflows.md), [capability coverage](28-capability-coverage.md), ADR10/13, [performance](15-performance.md).

- [x] **S8 phase completed** (S8.1–S8.4 all checked; checkpoint advanced to S9.1 in the S9.1 session — the S8 parent box was left unticked when S8.4 wrapped, now reconciled)
  - [x] **S8.1 — Implement linked list/grid/board projection** (views: list/grid/board from observed facts; local-only buckets; see notes in the task)
    - Goal/inputs: S7 actions + observed source set/field mapping + owned UI primitives.
    - Changes: stable source keys, truthful field mapping, local buckets/order, pagination, source reveal, stale item disable, accessible board interactions, explicit original-visibility approval.
    - Outputs: real PR Kanban/dashboard capabilities, local organization clearly distinct from server state.
    - Invariants: I08/I14/I18/I25.
    - [x] Tests: T17/T28—duplicate/missing key, live source update, drag local-only, source action stale.
    - [x] Validation: ≤200 rendered items, no cloned native controls/unloaded data invention; AC12 projection criteria.
    - [x] Completion: keyboard and manual visual workflow review passes; evidence S8.1.
    - Follow-up: floating controls and full vision review; persist the user's board arrangement across reloads when every item has a stable key.
    - Notes: the runtime/projection module extracts a finite field catalog (title/label/link/category) from the container's direct element children; board columns come from observed explicit category markers plus an Unsorted local bucket; local organization is session state keyed by stable item key that survives release/re-apply (the S7.2 user-override rule); descriptor resolution excludes the runtime's own view (extension UI is never site evidence); hiding the original set rides the compiled hide path with its verification machinery.
  - [x] **S8.2 — Implement floating existing surfaces and gated relocation**
    - Goal/inputs: S8.1 fallback projection + S4 transaction/native identity guarantees.
    - Changes: float constraints/restore/minimize controls, clipping checks, explicit high-risk same-node relocate with placeholder and protected-target restrictions; suspend on framework conflict.
    - Outputs: working mini-player/native controls without playback duplication; documented projection fallback where move unsafe.
    - Invariants: I08/I09/I23/I26.
    - [x] Tests: T18/T22—listener/media state, overflow/stacking, parent removal, repeated framework replacement, restore focus.
    - [x] Validation: reject unsupported protected native moves rather than require smarter model.
    - [x] Completion: AC04/12 floating/relocation requirements met or advertised capability explicitly restricted with tested fallback; evidence S8.2.
    - Follow-up: S8.3 root/frame completion and S9 full product qualification.
    - Notes: float rides the compiled style path (measured position/size/stacking; overflow/stacking inability surfaces through verification, never silently); the minimize control is runtime-owned UI with an exact attribute-baseline restore. Relocation records exact original anchors (parent + next sibling) and reattaches them by compare-and-restore; the emptied original parent's own reflow is exempt (reviewed consequence) while its ancestors/siblings stay sentinel-measured. **Replay hardening found and fixed by T18**: a disable/record-removal releases whenever the TRANSACTION holds a live revision (the replay state machine can drift behind — a command-path apply whose descriptor later went missing left live aggregate CSS in place while the state said disabled).
  - [x] **S8.3 — Complete root-local fallback and explicit frame targeting**
    - Goal/inputs: S6 core broker/workspace plus S7/S8 capability contracts; initial open-root facts from S3.
    - Changes: expose eligible frame selection by verified DocumentKey, inject one runtime per individually permissioned frame, track parent/top origin only for permission display, root-local AUTHOR stylesheet fallback and approved narrow inline override; frame runs session-only, no cross-frame proposal dependencies.
    - Outputs: working same-origin/permitted cross-origin frame session transformations and truthful root-specific capability reports; no parent-script SOP bypass or persistent frame-index guess.
    - Invariants: I03/I04/I18/I19/I26.
    - [x] Tests: T06/T14/T21/T22 with nested frames, revoked frame permission, removed root/frame, author-important shadow conflicts and separate per-frame outcomes.
    - [x] Validation: document selectors never cross roots, one frame failure does not undo another accepted independent run, frame Save explains session-only boundary.
    - [x] Completion: frame/root support matrix and exact limitations evidenced in S8.3; unsupported closed internals stay explicitly unavailable.
    - Follow-up: S9 validates compatibility rather than discovering/implementing a missing frame subsystem.
    - Notes: `all_frames` injection gates on browser host permissions per frame (Chrome injects only where the extension may reach the frame's origin). **The relay bug T06 found**: the broker relayed every page command with `sendToTab` — a bare broadcast — so (a) a frame-addressed command never reached its runtime (stale-document forever) and (b) another frame's synchronous fence rejection raced ahead of the addressed runtime's queued acceptance. The relay now targets the registered document's EXACT frame (top included). Root-local delivery: the SAME validated namespace-scoped fragment installs as an owned style node inside each involved open root (inert until token activation); the approved narrow inline override (≤32 validated declarations, CSSOM, exact attribute baselines) is the second tier when a root cannot host the node — the effect is MEASURED by the batch's style checks either way. Text/insert/bind on shadow internals stay document-root-refused (honest unsupported; a later slice owns them).
  - [x] **S8.4 — Add bounded owned Canvas 2D, not a graphics framework**
    - Goal/inputs: explicit canvas requirement; S4 generic insertUI/transactions, S5 replay and document 28 drawing contract. Can develop independently of other S8 features after S6; does not block core preview release.
    - Changes: one optional canvas leaf renderer in runtime/content, validated ordered rect/circle/polyline/text records, logical viewBox, native ResizeObserver redraw, capped backing pixels, accessible fallback/context-loss handling. No new canvas dependency, scene graph, worker or continuous animation loop.
    - Outputs: user-requested new owned 2D drawing that can be styled/inserted/replayed/removed through existing mechanisms; existing page canvas internals untouched.
    - Invariants: I05/I08/I14/I18/I21/I26.
    - [x] Tests: T32 known draw output, malformed/oversized scene, resize/zoom/hidden/context unavailable, explicit reduced resolution, replay/disable no leak and native page canvas unchanged.
    - [x] Validation: no model/network calls during redraw; no whole-page canvas capture, arbitrary script or backing-buffer reset on native page canvas; AC07/08/10/12.
    - [x] Completion: planned Canvas 2D capability and honest limits pass; concise S8.4 evidence entry recorded.
    - Notes: the scene record schema (closed rect/circle/polyline/text records, solid-color table + parseColor, ≤256 records/≤2048 polyline points/≤4 KiB text/≤4096 viewBox) lives in contracts with the decode boundary; the renderer lives in the generic content creator (no new module, no dependency). Renderer-owned facts found by the tests: an unknown element (`scene`) is display:inline with clientWidth 0 forever — the creator owns a minimal `display:block` receipt so the owned CSS box is measurable, model style ops override in-batch. Late-scheduled redraws after release are guarded (released state never repaints or corrupts the exact document pixel budget). Backing scale = min(2, dpr) lowered to fit the 1M-pixel/canvas and 2M-pixel/document caps with explicit `data-rv2-canvas-scale`/`data-rv2-canvas-lowered` receipts; unavailability/context loss shows the accessible fallback with `canvas-unavailable`; restoration redraws saved scene data once. The accessible fallback never enters the WCAG AA owned-text check (scene content, not authored text).
    - Follow-up: S9 can qualify all requested capability categories, not just CSS and widgets.

## S9 — Release qualification and final deletion

Read: [tests](20-testing-strategy.md), [matrix](21-test-matrix.md), [acceptance](22-acceptance-criteria.md), [deletion](19-migration-and-deletion.md).

- [ ] **S9 phase completed**
  - [ ] **S9.1 — Measure stress, compatibility, performance and product quality**
    - Goal/inputs: complete core/P2 capabilities with all focused evidence.
    - Changes: finish min/current Chrome/Edge capability tests for S8.3 frame/root runtimes, zoom/BFCache/shadow fallback, storm/soak/perf; optimize only measured hot paths, record manual site coverage.
    - Outputs: truthful supported-browser/capability matrix and benchmark distributions; full model-free correctness matrix.
    - Invariants: I14/I20/I21/I26/I28.
    - [x] Tests: all T01–T32 applicable; stress/perf isolated; opt-in live model quality separate. (isolated `npm run test:stress` suite: T23 storm/toggles, T03-P scaling, T22-P zoom, T24 bounded soak, E2E latency — all green; full mapping in [29-s9-1-evidence.md](29-s9-1-evidence.md))
    - [x] Validation: AC01–12 and release metrics, no zero/unknown-as-pass; security review complete. (gates ×2 green every run: 374 unit + 41 browser, 0 known-red; live Chromium-120 floor smoke 5/5; security surfaces green in-gate)
    - [x] Completion: no open P0; residual limitations explicit, manual checks evidenced; S9.1 record. ([29-s9-1-evidence.md](29-s9-1-evidence.md); residuals: Edge live run, BFCache-forced expiry, 30min soak opt-in — none P0)
    - Follow-up: final release cleanup.
  - [ ] **S9.2 — Finish deletion ledger, documentation and release checkpoint**
    - Goal/inputs: S9.1, all migration rows, source import graph.
    - Changes: delete remaining dead classifiers/serializers/stubs/audit compatibility code, consolidate dependencies only with actual evidence; update current architecture facts and agent rules.
    - Outputs: no orphan legacy execution concepts; release-ready repository and complete progress ledger.
    - Invariants: I27/I28; don't delete useful tested primitives merely for file count.
    - [ ] Tests: full deterministic suite/type/lint/build/import/link checks after deletions; smoke released package.
    - [ ] Validation: every requirement traced to implemented/tested capability or explicit release limitation; exact rollback/storage compatibility documented.
    - [ ] Completion: all parent phases checked with evidence; current checkpoint changed to released/future backlog, not empty “done.”
    - Follow-up: future adapters/features via ADR and new task IDs, no silent drift.

## Progress update rules

Per task keep status (`not-started`, `active`, `blocked`, `complete`) in evidence; checklist is completion truth, not effort percentage. If previously completed contract changes, reopen affected tasks/acceptance rows and explain why. P2 feature gaps cannot disappear by renaming them P3. Deferred optimizations (worker offload, virtualization, cloud sync, more provider SDKs) remain unbuilt unless measured need or product decision creates a new scoped task.

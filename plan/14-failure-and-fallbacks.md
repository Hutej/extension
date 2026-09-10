# Failure, fallback and degraded-mode architecture

**Proposed operational policy.** Scope: what the runtime and implementation agent do when the preferred design fails. Fallbacks are constrained paths, not permission to improvise another architecture. See [state](05-state-and-lifecycle.md), [ADRs](18-decisions-and-alternatives.md) and [implementation failure protocol](24-implementation-protocol.md).

## 1. Outcome taxonomy

- `not-applied`: verified no side effect occurred.
- `rejected`: validation/permission/capability failed before activation.
- `waiting`: enabled intent has no current compatible target.
- `suspended`: target/behavior conflict requires user action.
- `applied-provisional`: visible preview, not accepted/saved yet.
- `accepted`: mandatory checks passed for exact current revision.
- `applied-unsaved`: accepted locally, storage did not acknowledge.
- `partial`: overall goal or live-page coverage is incomplete, or cleanup only partly succeeded; list exact accepted prior revisions/limitations. Never permission to silently execute a subset of one candidate batch.
- `outcome-unknown`: command may have taken effect, receipt incomplete.
- `rolled-back`: own effects confirmed released.
- `conflicted`: own resource cannot be safely restored/confirmed.

No boolean `ok` combines these. Human-readable summary is generated from typed result, not trusted model prose.

## 2. Subsystem fallback ladders

| Subsystem | Preferred | Alternative A: trigger and behavior | Alternative B | Emergency / final behavior |
|---|---|---|---|---|
| Model response | Structured/JSON text proposal | Unsupported optional formatting parameter → one specific downgrade to plain JSON | One bounded format/validation correction using same model | Return cannot-produce-valid-proposal, no effects; user may retry another profile |
| Model network | Configured endpoint with deadline | Transient 429/5xx/network → ≤2 shared retries | Explicit user retry after budget/credentials correction | Stop planning; keep accepted state, roll back provisional |
| Targeting | Fresh exact node or stable descriptor | Missing/unstable anchor → focused observation or expansion | User visual selection, session-only | Refuse target, never first-match guess |
| Document CSS | Scoped USER-important sheet | Broker delivery unknown → disarm tokens, reconcile same operation ID and exact cleanup | If API unavailable, explicit AUTHOR-sheet capability with measured coverage; requires revalidation before approval | No activation if mandatory style cannot be verified; previous revision stays |
| Open shadow styles | Owned constructable AUTHOR sheet | Unsupported assignment → owned local style element | Required property loses cascade → approved narrow tracked inline override | Unsupported root/property; do not claim document style parity |
| Responsive layout | Native responsive CSS verified on changed scope | New overflow/occlusion → rollback candidate; one model correction within budget | User accepts smaller explicit scope / alternate linked view | Keep previous revision; never resize real window as a repair |
| Behavior control | Existing observed affordance, trusted gesture | No usable native disclosure → extension-owned collapse UI | Focus/reveal original control rather than activate it | Unsupported; no synthetic-event spam or MAIN-world arbitrary code |
| Workflow view | Owned projection linked to original | Missing stable fields/key → session-only view with limited features | Presentation-only layout after user agrees to reduced goal | Report unsupported requirement; do not rename a theme “Kanban” |
| New owned UI | Validated insertUI tree | Anchor/nesting invalid → ask/select another placement | Native DOM/CSS equivalent within same capability | Reject whole candidate, never insert raw HTML |
| Owned Canvas 2D | Native bounded scene drawing | Pixel budget → explicit lower backing resolution | Context unavailable → accessible text/table fallback labeled unavailable | Reject unsupported drawing; never borrow page canvas or execute generated code |
| Native relocation | Same-node move with verified anchors | Framework conflict once → immediate compare-and-restore | CSS float or linked projection | Suspend relocation for this document after repeated conflict |
| Persistence | One validated OriginRecord write | Revision conflict → refresh and merge disjoint IDs | Quota/API failure → applied-unsaved with explicit retry/export/delete | Keep accepted local state; never claim reload survival |
| Replay | Resolve/compile/apply/verify saved intent | Missing target → waiting + bounded mutation enrollment | Ambiguous/incompatible → suspended + user reselect | Disable group locally; no automatic model calls |
| Verification | Structured required measurements | Unsettled/measurement error → one local recheck within 500ms settle bound | Narrower explicitly scoped proposal in new validation | Unknown remains unaccepted; rollback provisional, retain accepted prior state |
| Workspace | Side panel | Unsupported/closed unexpectedly → extension-tab workspace on explicit user request | Reopen workspace to inspect accepted/saved state | Runtime expires provisional lease; no hidden process continuation |

Fallbacks that change visible capability (AUTHOR instead of USER origin, session-only instead of persistent, projection instead of native layout) require explicit diagnostic/approval. A model cannot silently select a degraded mode and call it full success.

## 3. Retry/rollback rules

- Never retry an uncertain mutation with a fresh operation ID. Query existing receipt, then compensate its exact resources.
- Retry known failed pure observation only if evidence can change; repeated same snapshot requests return cached bounded evidence or no-new-evidence diagnostic.
- One correction budget per planning run; no separate repair subsystem that resets the budget.
- Rollback covers the single candidate batch on any operation/mandatory-check failure; no global `undoAll` and no optional-subset executor. Independent prior accepted customizations are never included. Failed candidate restores predecessor values; disable restores inherited site baseline.
- Stop removes provisional, not accepted. User disable removes all owned resources of that customization regardless of model availability.
- Resource cleanup failures remain visible and recorded. Final message cannot say “page restored” unless each required cleanup receipt confirms release or document destruction.
- Reload is an offered emergency action; never automatic where drafts/media/site work could be lost.

## 4. Failure simulation table

| Scenario | Detection | Required sequence and terminal evidence |
|---|---|---|
| Partial initialization | A created listener/root fails before ready | Dispose created modules reverse order; report runtime unavailable; no stylesheet |
| Navigation during provider wait | Browser document or local route epoch changes | Cancel request; reject late proposal; new route no stale tokens |
| Navigation while CSS insert pending | Old namespace/document receipt | Disarm namespace immediately; exact old-document cleanup; do not address tab-only target |
| Mutations during final validation | Dependency dirty since snapshot | Re-resolve before synchronous writes; affected mismatch rejects group |
| Rapid mutations/starvation | Dirty work budget/conflict streak | Max-wait slicing; pause unstable group; no unbounded rebuild |
| Resize/zoom during preview | viewportRevision changes | Mark layout report stale; one current-size recheck, unknown→rollback |
| Conflicting customizations | Resource claim collision | Reject/ask replace; deterministic style precedence, no structural overwrite |
| User stops while binding fires | Revocation flag/current lease | Current synchronous native gesture may complete; prevent subsequent steps/listeners; report any non-reversible invocation |
| Workspace disappears | Port disconnect + runtime lease | Abort provider locally when possible, disarm provisional resources; accepted revisions remain |
| Worker restarts before style ack | Session intent without terminal receipt | Hydration barrier; exact cleanup/reconciliation before new insert |
| Model malformed/missing JSON | Union parser rejects | Zero effects; one correction; final honest error |
| Network body never ends | Shared absolute deadline/body byte cap | Abort body, no late parse, bounded attempts |
| API remove fails | Rejected/unknown cleanup receipt | Tokens already disarmed; pending sheet ledger retained; explicit cleanup conflict |
| Text inverse conflicts | Exact node/value comparison differs | Keep newer site value, report conflict, do not clone replace |
| Source item recycled | Stable key/predicate mismatch | Release old item effects, disable stale projection action; re-enroll only if eligible |
| Memory pressure | Resource/evidence counters hit ceiling | Drop optional evidence, not live inverses; reject new group or suspend new member enrollment |
| Long session | Metrics growth after repeated toggles/routes | Release detached refs/timers; diagnostics bounded; test heap trend |
| Save interrupted | mutationId absent/unknown after read | Applied-unsaved or conflict, never blind successful toast |
| Permission revoked | permissions event/API denial | Stop provider/page actions; disarm local tokens; saved intent disabled/suspended until regrant |

## 5. Architectural versus implementation failure

A wrong loop condition, missed await, incorrect schema or unremoved listener is implementation failure: fix within the contract and add regression. A browser cannot perform a required action under documented APIs, or an acceptance criterion is physically unachievable, is architectural evidence: record failed experiment, select the documented fallback and amend decision/acceptance/roadmap together. Do not “solve” it by stronger-model requirement, disabling guards, injecting generated scripts, or faking a passing test.

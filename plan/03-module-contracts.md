# Complete module contracts

**Proposed logical responsibility contracts, not a file/class scaffold.** Purpose: specify each behavior's inputs, owner, failure and tests. The headings below retain stable logical names so roadmap references remain useful. Implement them together according to the consolidated [physical layout](02-layers-and-dependencies.md), not as one `.ts` file, interface or service per heading. No implementation files have been created by this planning task.

## 1. Contract conventions (apply to every module below)

- Inputs are validated conceptual types in [data contracts](04-data-contracts.md); outputs are success/diagnostic unions, never unchecked `any`. External inputs start as unknown.
- Pure modules have no initialization/shutdown, no mutable state, no recovery side effects and deterministic results. Runtime modules initialize once per DocumentKey, update through the runtime queue, and dispose all timers/listeners/refs they own. Broker modules register listeners before async hydration, accept work after hydration, and recover from persisted intents. Workspace modules initialize per visible workspace and cancel their active work on closure.
- No DOM module imports providers or storage writers. No broker module imports DOM executors. No UI module can bypass policy. These forbidden dependencies are inherited by every row; additional restrictions appear below.
- Tests: pure tests call real functions; browser components call real runtime modules; system tests use the extension message path. Every stateful module must exercise initialization, repeated invocation, disposal and interrupted recovery. Exact focused tests are named per row.
- Observability: pure validators emit diagnostic data only; stateful modules emit bounded phase/resource/latency counters through `shared/diagnostics`, never raw page text/secrets.

## 2. Contracts and pure policies

| Module / purpose | Inputs → outputs; consumers | State/dependencies | Failure / performance / required checks |
|---|---|---|---|
| `contracts/messages` — transport boundary | Unknown envelope → validated command DTO; broker/runtime/workspace | No state; validation/errors/limits only | Bad version/kind/sender role payload rejected before dispatch; O(bytes); exhaustive message and size tests |
| `contracts/customization` — operation/record vocabulary | Proposal/revision/descriptor definitions → one authoritative discriminated schema and capability metadata; compiler/store/prompt builder | No browser imports; schema version explicit | Unknown op/version rejected, ordered batch and local-reference validity checked; ≤64 ops; schema corpus tests |
| `contracts/provider` — provider DTO | Profile/normalized response definitions; settings/adapters/controller | No request side effects | Endpoint/auth/capability bounds tested; no model-specific policy |
| `contracts/validation` — decoders | Unknown objects → validated values or field-path diagnostics | Contracts/limits/errors; no coercion of model strings into booleans/numbers | Depth/string/array/finite-number/unknown-field checks; reject prototype-like keys; malformed fuzz corpus |
| `contracts/errors` — failure vocabulary | Error code/phase → retry class + permitted action label | Pure lookup, not browser-error string as policy | Unknown errors default nonretryable; exhaustive taxonomy tests |
| `contracts/limits` — named ceilings | Immutable limits and validated user lower/upper settings | No provider-name thresholds | No per-call duplicate magic numbers; boundary tests and perf report references |
| `shared/color` — color mathematics | Supported RGBA/composited samples → contrast/luminance, unsupported result | Extract tested current primitives; no DOM parsing fallback in pure math | Modern unsupported colors and transparent/image cases return unknown; standard vectors, alpha tests |
| `planning/budget` — bounded request decisions | Clock/usage/deadline/counter → may request/retry/wait | Active-run counters via controller; injected monotonic clock | Shared HTTP/model ceilings; abortable sleep delegated to client; deterministic fake-clock tests |

## 3. Broker modules

### `background/broker` — entrypoint dispatcher

**Inputs:** extension messages and browser sender metadata. **Outputs:** routed validated command receipts, subscription snapshots. **State:** hydration barrier and connection ownership only, no page mutation ledger duplication. **Dependencies:** documents/permissions/styles/store and contracts. **Lifecycle:** listeners installed synchronously; await hydration inside handlers; on restart reconcile pending receipts before mutations. **Failure:** invalid/untrusted request rejected; catch handler failures as `outcome-unknown` if a privileged call was submitted, not `not-applied`. **Performance:** constant routing + bounded payload decode, no provider wait. **Tests:** wrong sender, content spoofed tab, stale run, unknown action, restart during hydration, duplicate message.

### `background/documents` — document registration and route fencing

Inputs: verified content sender, webNavigation/tab lifecycle events, workspace run registration. Outputs: DocumentKey, current route epoch, ownership grant, invalidation events. State: session document registry and one run owner/document; browser identity remains authoritative. Dependencies: extension APIs/store session metadata, no DOM. Init queries live frames/tabs as needed after loading session records; navigation invalidates old run, confirmed destruction releases records; cleanup removes dead entries. Failure: missing document/injection permission reports unavailable. Performance: O(registered documents), bounded to live browser documents. Tests: same tab reload, SPA A→B→A, BFCache, frame detach, two workspaces and arbitrary tab rejection.

### `background/styles` — privileged CSS delivery

Inputs: validated compiled URL-free sheet, exact DocumentKey, operation/namespace ID. Outputs: durable session intent + inserted/removed/unknown receipt. State: per-document style queue and delivery intents, exact CSS bytes; no semantic target decisions. Dependencies: scripting/session storage/contracts policy. Lifecycle: write intent before API; recover uncertain intent by exact cleanup; do not insert same operation twice. Removal records failure until ack/document destruction. Performance: O(bundle bytes), at most accepted+staged physical bundle per root and ≤64 logical style fragments/document; no repeated style generation. Tests: timeout after insert, worker restart between call/ack, exact-byte removal, documentIds targeting, revoked permission, duplicate operation digest conflict.

### `background/store` — persistent record owner

Inputs: expected record revision + mutation ID + validated delta/acceptance evidence. Outputs: new OriginRecord or conflict/unsaved. State: per-origin write queues, local records/session tombstones; no DOM refs. Dependencies: storage/contracts, documents for broadcast. Lifecycle: hydrate recognized versions; migrate only approved records; reconcile ambiguous write by lastMutationId. Error never swallowed. Performance: bounded single-record writes, no writes on every mutation/keystroke. Tests: quota, corruption, unknown version, concurrent tabs, update conflict, lastMutationId replay and legacy quarantine.

### `background/permissions` — trust/grants

Inputs: workspace user action, sender identity, endpoint/site origin, requested capability. Outputs: allowed/denied grant and browser permission request. State: saved grant/disclosure version through store. Dependencies: permission API/contracts; cannot inspect provider responses. Lifecycle: grant only from trusted UI, revoke cancels applicable runs/resources; endpoint change invalidates disclosure. Tests: implicit consent not migrated, model `consent:true` ignored/rejected, optional host denial/revocation, local endpoint allowlist. Small O(1) decisions.

## 4. Planning/provider modules

| Module | Inputs → outputs | State, dependencies and lifecycle | Failure/performance/test contract |
|---|---|---|---|
| `planning/controller` | Goal + pinned document/profile → requestEvidence/proposal flow → run outcome | Own run state, no effect ownership; context/prompts/budget/provider client/broker DTO client. Start with runtime observation; close/Stop aborts; accepted results remain | ≤4 model responses, ≤6 HTTP attempts; cannot bypass runtime validation. Strong/weak/malformed fixture models, cancel/navigation, interrupted save |
| `planning/context` | Snapshot + accepted-state summary + recent diagnostics → bounded provider payload | Ephemeral evidence window only; pure compaction, no full journal | Preserve newest error/target refs; omit old optional detail with coverage. Budget and privacy sentinel tests |
| `planning/prompts` | Capability metadata + response union → stable prompt sections | Pure; no site-specific recipes; no extra own schema definitions | No promises that runtime verifies invented selectors; tests ensure offered capabilities exactly executable |
| `providers/client` | Adapter request + absolute deadline/AbortSignal → normalized text/error/timing | HTTP/body/backoff state only; fetch/profile/adapter/extract. Abort cleans streams/timers; no content script caller | Deadline covers response body; redirect/credential policy; byte cap. Mock HTTP: slow headers/body, 429, network fail, cancel, auth, huge stream |
| `providers/openai-chat` | Normalized request ↔ chat HTTP body/envelope | Pure translation with explicit profile capabilities; no regex on model name | Unsupported parameter downgrade only specific error; messages/usage/refusal/truncation fixture corpus |
| `providers/anthropic-messages` | Normalized request ↔ Messages HTTP body/envelope | Explicit system/max_tokens/headers/text block translation | CORS capability probe; unsupported tool-use fails; content arrays, stop reasons/auth tests |
| `providers/extract` | Bounded model text → exactly one parsed candidate object | Pure scanner/JSON.parse; adapt current extractor cautiously | No O(n²) rescanning or ambiguous-object execution; malformed/prose/fence/partial UTF-8/multiple objects tests |

UI/transport cannot instantiate or invoke runtime executors. Profile addition never changes `runtime/*` behavior.

## 5. Document runtime modules

### `runtime/session` — composition and lifecycle

Inputs: broker handshake, commands, page lifecycle. Outputs: state projections and effect receipts. Owns runtimeInstanceId, epochs, accepted customization map and instantiated module lifetimes. Composes queue/targets/transaction/reconcile; no model fetch or direct local storage. Initializes before body is ready, ensures one instance/document, disposes on unload/update. Handles partial init by disposing created resources in reverse creation order. Tests: body absent, reinjection, update, BFCache and closure; memory counters return to baseline.

### `runtime/queue` — mutation serialization

Inputs: typed operation tasks/cancellation priorities. Outputs: serialized results. Owns queued task IDs and current cancellation flag, not effect inverses. Native synchronous commit sections do not await; cancellation overtakes future work at safe points. No locks across model/human waits. Tests: two apply requests, cancel during reconcile, rollback priority, max queue length. O(queued tasks), bounded 32 pending tasks with coalesced reconcile.

### `runtime/targets` — identity/root registry

Inputs: observed nodes/descriptors and invalidation. Outputs: ResolvedTarget or missing/ambiguous/stale/unsupported. Owns WeakMaps, root refs, current memberships and descriptor index; saved descriptors come from records but no store writes. Re-resolves stable-single/future-set only under documented predicates. No pixel/text-hash identity proof. Dispose drops roots and refs. Tests: twins/duplicate IDs/recycle/shadow root removal/ancestor changes. Complexity O(bounded candidate set × predicate count), not repeated whole-document queries.

### `runtime/facts` and `runtime/observe` — factual collection and orchestration

Facts receives live target and requested field set; outputs bounded declared facts, advisory semantic inference, computed samples. Owns no durable state; only per-pass cached style reads. Observe owns snapshot IDs/cursors and queues bounded traversal; returns PageSnapshot and coverage. Depends targets/facts/color; never mutates website/installs effects. Errors produce partial evidence. Tests: all taxonomy/role examples and unknown, editable privacy, below-fold coverage, deep trees/large nodes, stale cursor; budgets include enrichment, not just walk.

### `runtime/policy` — risk and capability enforcement

Inputs: decoded group, resolved targets, verified user grant, browser capabilities and active resource claims. Outputs: allowed resource plan/risk approval request or rejection. Pure decisions on collected data; no DOM writes or provider calls. Structural/native-action authority never inferred from absence of handlers. Tests: CSS equivalent of hide cannot bypass hide policy, generic click no auto grant, scope escape, protected control. O(operations + claims).

### `runtime/compile` — canonical resources

Inputs: validated group, resolved target tokens, explicit capability set. Outputs: canonical CSS/resources/postcondition plan and exact diagnostics. Depends AST parser/contracts/policy; no insertion. Owns no long-lived state; caches only bounded same-revision results if profiling warrants. Reject unsafe CSS rather than silently strip and re-author. Tests: nested CSS syntax/escaped URL/custom-property chains/pseudo scope, importance, keyframes/reduced motion. O(AST nodes), bounded inputs.

### `runtime/transaction` — effects and inverses

Inputs: resource plan + epoch/grant. Outputs: provisional/accepted/rolled-back/conflicted receipts. Owns authoritative local resource ledger; styles/content/behavior/projection are concrete execution functions under this ledger. Records inverses before side effect, checks current epoch after awaited broker work and re-reads local route immediately before synchronous commit, uses same-node compare-and-restore. One proposal is one ordered batch and accepts only after its complete mandatory verification; no optional-group dependency engine. Replacement transfers site-base inverses while retaining separate predecessor rollback values until acceptance. Reconciliation uses same mutation primitives. Failure preserves independent accepted groups; never drops failed inverse. Tests: failure after every resource step, lost ack, cancel, replacement revision, conflicting author update; resource caps measured.

### `runtime/styles` — target tokens and root-local style resources

Inputs: compiled CSS resource; outputs local token assignments and broker/local sheet receipt. Owns logical style fragments, canonical aggregate composition, local bundle refs and token membership only through transaction records. One accepted and at most one staged bundle per root ensures deterministic customization precedence after refinement. Document CSS goes to broker; open-root CSS uses constructable/style-node fallback. Disarm synchronously before awaited removal. Tests: late insert inert, author-inline-important shadow fallback, token spoof/collision/foreign tokens, partial removal. O(members + sheet bytes); no global restamping.

### `runtime/content` — leaf text and generic owned UI

Inputs: replaceText/insertUI resource plan. Outputs exact Text/host/node resource handles and validated local node IDs. Creates supported containers, headings, lists, local controls and text through native DOM APIs; no arbitrary HTML parser or new rendering framework. `insertUI` is the one creator for annotations, cards, toolbars, panels and other owned elements, with before/after/first-child/last-child placement where valid. Children can be styled and bound in the same ordered batch using declared local IDs. No storage/AI. Original native nodes never cloned/replaced; site editor values excluded. On conflict preserve site state. Tests: T09/T31 listener identity, local IDs, insertion positions, native local controls, malicious attributes, missing owned node and repeat undo. Memory linear in explicitly created nodes/text within caps.

Canvas 2D is a later leaf renderer **inside this module**, not a scene framework: validated bounded draw records → owned canvas plus accessible fallback. State is scene data, canvas/context/ResizeObserver refs; no model-written draw function, page canvas reads or perpetual animation loop. Redraw only on scene/size change, cap backing pixels and commands, remove observer/host on disable. Context loss/redraw failure reports unavailable without modifying existing website canvas. Contract/tests: [capability coverage](28-capability-coverage.md), S8.4/T32.

### `runtime/behavior` — finite local interaction rules

Inputs: approved binding/localRule and current action catalog. Outputs installed listener/rule resources + event result. Owns per-binding once/cooldown/user-override state. Routes its reversible effects through transaction; external activation has distinct non-reversible outcome. No model calls/remote endpoints. Disposes exact listeners. Tests: IME/editable/modal/repeat/reserved key/permission revoked/event after disable/user expansion override. Event path must remain ≤4ms excluding website handler time.

### `runtime/projection` — linked alternative views

Inputs: source set/field mapping/view configuration and explicit local organization. Outputs owned accessible view/resources. Owns rendered-item→source-ref map and local layout selection, not source site state. Depends targets/content/behavior/transaction. Stale source disables action; no cloned native controls or backend status invented. Tests: duplicate/missing keys, dynamic field updates, board local-only grouping, original reveal, keyboard navigation/disposal. ≤200 rendered items; paginate before virtualization.

### `runtime/reconcile` — continuity

Inputs: accepted intent + dirty dependency/root/route events. Outputs minimal resource delta via queue/transaction, per-group waiting/suspended/applied status. Owns dirty set/debounce timers and conflict streak; not a second saved-state store. Observes only while needed, self-write filtering exact, no AI. Stops repeated conflict and clears timers on disable. Tests: mutation storm, recycled nodes, same-route replacement, late shadow root, route out/in and disposal; limits per pass.

### `runtime/verify` — measured postconditions

Inputs: prepared baseline + exact current resource/target group and policy checks. Outputs VerificationReport pass/fail/unknown with coverage. Owns only bounded baseline samples per provisional group; clears after acceptance/rollback. Depends targets/facts/color, no planner or mutation correction. Probe work must not modify native content; if measurement needs owned probe, ledger tracks it and removes in finally. Tests: existing issue worsening, intended hide exemption, target disappearance, alpha/gradient uncertainty, focus/media/form regressions, failed measurement never passes. Bounded affected-target/sentinel scan, no full-page outerHTML hashing.

## 6. UI, entrypoints and supporting tooling

| Module | Input/output/state/lifecycle | Required behavior and tests |
|---|---|---|
| `ui/workspace` | User goal/selection + controller projections → commands; draft and selected profile/tab only | Pin explicit target; sidepanel/tab share controller; closing cancels pending planning; cross-window/run isolation E2E |
| `ui/status` | Typed outcome/receipt → text/buttons/progress | Exhaustive rendering; no gaveUp→✓ or unknown→clean; aria-live polite, Stop always accessible, no full-screen click blocker |
| `ui/settings` | User profile/consent input → validated broker/profile save | Native form labels, explicit endpoint disclosure, no secret in exports; connection test only user triggered |
| `ui/customizations` | OriginRecord + per-document live states → enable/disable/order/undo/remove commands | Enabled distinct from applied; show scope, unsaved/conflicted/waiting; revision conflict and keyboard tests |
| `shared/diagnostics` | Sanitized event DTO → bounded ring/export summary | No raw prompt/CSS/text/URLs/secrets by default; overflow drops oldest diagnostics only, never active resources |
| WXT entrypoints | Browser lifecycle → construct corresponding modules once | Thin bootstraps; compiled manifest smoke, missing permission, update/reinjection tests |
| Test support and dependency audit | Real source modules + fixture adapters → runnable gates | Node built-in tests + Playwright; import graph via installed TypeScript, zero-test failure; test code not a production dependency |

No helper deserves a new abstraction without a real consumer. The logical sections above may share ordinary functions/state in a physical module. Import gates enforce the browser/provider/trust boundaries, not a rule requiring every logical heading to be a separate import. A future split needs a concrete reason and corresponding layout update.

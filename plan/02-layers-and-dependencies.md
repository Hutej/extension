# Layers and dependency architecture

**Proposed.** Purpose: assign ownership and prevent the current shared-registry dependency tangle. Read with [master](00-master-blueprint.md), [module contracts](03-module-contracts.md), and [invariants](23-invariants.md).

## 1. Layers

| Layer | Inputs → outputs | State owned | Allowed dependencies | Forbidden dependencies |
|---|---|---|---|---|
| Contracts/pure policy | Untrusted plain data → validated union or diagnostics; records → decisions | None, except immutable definitions | Platform-independent language/library primitives | DOM, `chrome`, fetch, UI, modules above it |
| Observation/targeting | DOM root + bounded query → semantic snapshot/target refs | Node WeakMaps, root map, epoch-scoped evidence | Contracts, color/math primitives, DOM | Provider, persistence writes, mutation executors, browser-window control |
| Transformation runtime | Validated proposal + user grant + targets → receipts/verification | Applied resource ledger, provisional transaction, target claims | Contracts, observation, local executors, verifier, injected broker client | Provider, planner, arbitrary script execution, direct storage writes |
| Privilege broker/storage | Typed extension requests + trusted sender metadata → scoped API receipts | Document registration, session delivery intents, origin-record write queue | Contracts, extension APIs, storage codec | DOM, model reasoning, content executor imports, UI components |
| Planning/provider | User goal + evidence + capabilities → candidate proposal/request | Active run, recent evidence, deadlines, provider AbortController | Contracts, transport adapters, broker client | Direct DOM, CSS injection, mutation executor imports, permissive “tool.execute” escape hatch |
| Workspace/presentation | User commands + run/customization projections → UI events | Draft input, chosen tab/profile, expanded diagnostics | Contracts, planning controller, broker client | DOM targeting logic, persistence mutation outside broker, page-world bridge |

Dependency direction: UI → planner → contracts; runtime → contracts/observation; broker → contracts. Runtime and planner communicate through protocol data, not module imports. Provider adapter is justified by multiple distinct HTTP protocols, not a general plugin platform.

## 2. Lifecycle, failure, performance and tests by layer

| Layer | Init / update / shutdown | Error behavior | Performance | Test/observability contract |
|---|---|---|---|---|
| Contracts | Load definitions; version schema explicitly | Return path/code/expected form, never coerce unsafe input | Linear in bounded payload | Table/fuzz tests; rejection counts, no raw values |
| Observation | Register document/root; invalidate dirty regions; drop references on disposal | Partial coverage or missing target, never “safe by default” | Yield at ≤4ms cooperative slices, bounded visits | Fixture facts and truncation tests; visited nodes/style reads/duration |
| Runtime | Register once; serial apply/reconcile; revoke tokens/listeners before cleanup | Roll back provisional group, preserve accepted groups, report conflicts | One write group per scheduling turn; no idle work without installed customization | Mutation/rollback/replay browser tests; resource counts and phase receipts |
| Broker | Register listeners synchronously; await hydration; reconcile pending receipts after restart | Typed denied/stale/unknown outcome; never return success on caught API error | Small messages and per-origin writes; no DOM scans | Restart and sender-spoof tests; queue depth/API result latency |
| Planner/provider | Start in visible workspace; request/validate/repair; abort on cancel/close | Bounded retries and truthful terminal outcome | Common path one model call, small evidence window | Mock protocol/fault tests and optional live quality evals; wall/requests/tokens |
| Workspace | Restore run projection; subscribe by run ID; unsubscribe on close | Show actual runtime state, explicit retry/stop | Immediate local status, updates ≤4Hz | Component + keyboard E2E; outcome rendering and accessibility |

## 3. Proposed physical layout

Paths below are **future implementation paths**, not created by this planning task. The previous one-file-per-responsibility layout was unnecessarily fragmented. Start with these cohesive files; create each only when its roadmap task has a real consumer:

| Physical file | Responsibilities kept together |
|---|---|
| `contracts.ts` | Message/operation/provider/record types, decoders, errors, limits and pure shared CSS security checks |
| `background/broker.ts` | Message dispatch, document registration, navigation and permission grants |
| `background/styles.ts` | Privileged CSS delivery, exact receipts and cleanup |
| `background/store.ts` | Serialized versioned storage writes and migration |
| `planning/controller.ts` | Bounded run loop, current context, prompts and budget counters |
| `providers.ts` | HTTP client, JSON extraction and two explicit protocol adapter functions; no registry/plugin framework |
| `runtime/session.ts` | Bootstrap, small serial Promise queue, cancellation and observer reconciliation |
| `runtime/targets.ts` | Root/node references and persistent descriptor resolution |
| `runtime/observe.ts` | Bounded traversal, factual collection and requested detail |
| `runtime/compile.ts` | Operation validation, impact policy and canonical resource compilation |
| `runtime/transaction.ts` | Apply/verify/undo resource ownership |
| `runtime/styles.ts` | Logical fragments, canonical stylesheet and token membership |
| `runtime/content.ts` | Same-node text edits, generic owned UI creation and the later bounded Canvas 2D leaf renderer |
| `runtime/verify.ts` | Scoped postcondition/integrity measurement |
| `ui/workspace.ts` | Workspace, settings, status and customization controls |
| `shared/color.ts` | Tested pure color math |
| `diagnostics.ts` | Small content-free event ring and export formatter |

Add `runtime/behavior.ts` and `runtime/projection.ts` only in S7/S8 when those real features are implemented. WXT bootstraps/HTML entrypoints remain separate because the platform needs them; sidepanel and tab reuse the same workspace. This is a starting layout, not a required file count or scaffolding exercise.

The finer names in [module contracts](03-module-contracts.md) and task/traceability tables are **logical responsibilities inside these files**, not instructions to create dozens of modules. No class/interface/factory for every row. Split a physical file only when a real independent lifecycle, test seam or substantial complexity warrants it; do not mix broker/DOM/provider authority just to reduce file count. `runtime/session` composes concrete functions directly, without a dependency container.

## 4. External dependencies

| Dependency | Decision/owner | Reason and risk |
|---|---|---|
| WXT/Vite | Retain; packaging only | Already installed, extension entrypoint/build support; pin lockfile and prove generated manifest |
| TypeScript | Retain strict; use installed compiler API in development dependency tests | Types do not validate messages; boundary input remains unknown until decoded |
| Native DOM/CSSOM/Web Crypto/fetch | Retain | Browser is layout engine; Crypto only for IDs/digests, not semantic identity proof |
| `@playwright/test` + `playwright` | Retain initially; consolidate direct declaration after import audit | One browser harness, compatible lockfile version; no parallel authenticated-site crawling |
| axe-core | Retain as dev-only | Automated a11y checks plus human/focus tests |
| ESLint/typescript-eslint | Retain | Enable boundary/no-floating-promise rules without blanket model-JSON `any` exemptions |
| `css-tree` | **Introduce in CSS compiler phase**, explicit production dependency | Selector/value AST traversal and syntax validation are justified by injection risks and nested syntax. Pin version after browser-bundle/security/license check; CSSOM alone drops invalid input silently. No “latest” assumption |
| Provider SDK/agent framework | Do not add | Two small HTTP adapters suffice; SDK/tool orchestration layers would not own the actual browser safety problem |
| React/state library | Do not add now | Existing UI is small; native controls and shared workspace functions suffice. Reconsider only after measured UI complexity |
| DOMPurify | Not initially needed | No raw model HTML insertion. If raw imported markup is later approved, this decision must change before introducing that sink |
| Graph DB, vector DB, server, layout solver, WASM | Do not introduce | No current requirement warrants them; all personalization is local |

Browser compatibility: initial target Chromium MV3 **minimum proposed Chrome 120**, test current stable and minimum; Edge current stable after core compatibility gate. Other browsers are not advertised before capability tests. Native side-panel fallback uses extension tab, not a browser-specific UI framework.

## 5. Communication and synchronization

Cross-layer values are JSON-safe, discriminated, bounded, versioned records. DOM Nodes, Map/Set, functions and AbortSignals do not cross extension messaging. Cancellation is a command keyed to run/document epoch; AbortControllers are local per context. UI state derives from runtime/broker snapshots and sequenced updates; it does not maintain a second enabled flag.

Internal dependency test uses TypeScript import resolution (already installed), distinguishes `import type`, rejects runtime cycles and forbidden cross-boundary imports, and includes an intentionally forbidden fixture. Text search can assist review but cannot be the passing condition. The existing `audit-wiring` accepts names mentioned in comments and ignores perception; replace it once the new graph has real entrypoints.

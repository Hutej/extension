# Revueon implementation progress log

One compact log per protocol `plan/24-implementation-protocol.md` §3. Status vocabulary: `not-started`, `active`, `blocked`, `complete`.

## S0.1 — Restore executable baseline and architectural gate — `complete`

- Date: 2026-09-09. Source: dirty `main` (planning baseline `71263e0938e0a3d3a2a5e7a44d2175898b9e8c0b` + preserved owner edits; `plan/` untracked). Working tree stayed dirty; nothing was reset.
- Baseline recorded before changes (cwd `project/`): `npm run typecheck` pass; `npm run lint` 8 errors; `npm test` **0 unit tests** then `MODULE_NOT_FOUND tests/browser/run-all.ts` (F01); `npm run build` pass (audit:env + audit:wiring + wxt build).

### Changes

- Lint fixes (behavior-neutral): unused `actIdentity` import dropped (loop.ts); CSSRuleList iteration via `Array.from` instead of `as any` ×2 (emit.ts); unused `disclosureEl` ref removed + `void` on fire-and-forget sendMessage (popup/main.ts); unused `i` param and `anchorStyle` local removed (act.ts); unused `serializeInventory` import removed (observe.ts). Removing that import made `serializeInventory` in `core/inventory.ts` provably dead — audit-wiring failed the build until the export was deleted (the orphan gate worked as designed).
- `scripts/audit-imports.ts` (T29): resolved import gate on the installed TypeScript API — real file graph, `import type`/type-only named imports exempt, boundary rules (shared leaf; core ↛ agent/tools/entrypoints; tools ↛ agent/entrypoints/core/reason; agent ↛ entrypoints; nothing imports entrypoints), runtime-cycle detection, unresolved-relative-specifier detection. Negative-control fixture `tests/fixtures/import-gate/` (5 deliberate violations + a type-only cycle that must stay clean). Wired into `npm run build` and `npm run audit:imports`. Legacy `audit-wiring`/`audit-env` retained until the cutover per the migration ledger.
- `scripts/test-gate.ts` + `tests/unit/known-red.json` + `tests/browser/known-red.json` (T01): `npm test` runs unit then browser groups; fails on missing/unexpected suite inventory, zero discovered tests, unexpected failures — and fails when a known-red test starts passing (forces the flip to a plain regression). `test:unit` / `test:browser` / `audit:imports` scripts added to package.json.
- Unit baseline `tests/unit/`: color, extract-json, budget, redact (credential-shape policy; DOM boundary stubbed, documented), digest (FIPS vectors), gate self-tests (T01 parse/inventory/classify + T29 fixture + real-src-clean), known-defects (F05 recovery clause red ×2).
- Browser harness `tests/browser/extension.test.ts` + `lib.ts` + fixture pages (`tests/fixtures/pages/`): Playwright loads the built extension and drives the real production path (background SW → `chrome.tabs.sendMessage` → content script → registered tools). Refuses a stale build (newest src/wxt.config vs `.output/chrome-mv3` mtime) and wrong-tab dispatch (URL match before every dispatch). Node 24.19 note: `test {failing:true}` still fails the run, so expected-reds use the checked-in known-red allowlists instead.

### Evidence (commands from `project/`)

| Command | Result |
|---|---|
| `npm run typecheck` | pass (incl. new tests/scripts via tsconfig `../**/*`) |
| `npm run lint` | pass, 0 errors (was 8) |
| `npm run build` | pass — audit:env ✓, audit:wiring ✓, audit:imports ✓ (41 files, no cycles), wxt 332.97 kB |
| `npm test` (×2 consecutive) | exit 0 — unit: 43 tests, 41 passed, 2 known-red; browser: 7 tests, 4 passed, 3 known-red; 0 unexpected |
| `npm run test:unit` / `npm run test:browser` / `npm run audit:imports` | individually green |
| T01 negative controls | missing suite → gate exit 1 (live); zero discovered tests → gate logic unit-tested + enforced; stale build → guard refused a live run after a failed build left `.output` stale |
| T29 negative controls | forbidden fixture: 5 violations detected exactly (4 boundary + 1 cycle); type-only cycle not flagged; real src graph clean |

### Known defects explicitly red (assert desired behavior against real code; recorded in known-red.json)

- F05 (unit): failed/absent post-repair verification counts as `repaired` — recovery treats absent post-check data as empty failure lists.
- F06 (browser): `undoLast` replaces the native node with a clone — site listener and node identity lost.
- F02 (browser): toolCall receipt carries no run/document/operation identity (fencing absent; S2.1/S2.2).
- T05 (browser): after observation, a selector whose node was replaced re-mutates the replacement — unobserved selectors take the unverified branch (S3.1 targeting).

Green defect characterizations (must be revisited by the fixing task): F02 abandoned dispatch still mutates; T05 unobserved-selector replaced-node re-mutation. Passing regressions established: ambiguous-selector refusal; observe→act dispatch path; transport/budget/terminal-disposition policies; color/JSON/redact/digest primitives; import-gate enforcement.

### Residual risks / notes

- `emit.ts` CSSOM iteration change (`Array.from`) is typecheck/build-verified only; no behavioral CSSOM test yet (S4.1 replaces this module).
- Browser suite needs the Playwright `chromium` channel (new headless, extension-capable) — present here; headless launch + `bringToFront` tab matching verified in this environment.
- The F05 loop clause (`verifiedClean` survives verifier errors) is loop-internal and not yet regression-tested; its deterministic regression lands with the S4.3 verification gate.
- `npm run bench` still references the absent `tests/bench/wiki-bench.ts` (deleted with the old harness); bench is opt-in model-quality work from S6.1 — left untouched, not part of the gate.

Next task: **S1.1 — Define versioned operation/message/provider/record schemas**.

## S1.1 — Define versioned operation/message/provider/record schemas — `complete`

- Date: 2026-09-09. Source: dirty `main` (baseline `71263e0` + owner edits + S0.1 additions preserved).
- New module: `project/src/contracts.ts` — the pure bottom layer (plan/02 §3 consolidated `contracts.ts`):
  - Decoder core: plain-object/prototype-key guard (`__proto__`/`constructor`/`prototype` rejected), bounded strings with shape patterns, finite-number-only (never coerced from strings), strict booleans, literal unions (`const T` inference), bounded arrays, explicit-spec records with **unknown-field rejection** (v1 defines no extensions field), depth ceilings, `path?: string` field-path diagnostics.
  - Common records (plan/04 §1): DocumentKey, Epoch, Envelope (protocolVersion=1, bounded payload object), CommandReceipt with the exact seven-status vocabulary (`prepared`…`outcome-unknown`), ErrorRecord taxonomy (23 codes × 10 phases × 4 retry classes; `retryClassFor` maps known codes, unknown → non-retryable).
  - Operations (plan/08 §7 grammar v1 + plan/28 §2): all ten v1 kinds decoded with typed fields/defaults; insertUI tag allowlist (40 tags, no `scene` until S8.4), typed attribute set, input-type allowlist (no password/file), buttons always `type=button`; style rules with per-declaration priority, surface/state pseudo policy (pseudo-element + state conflict rejected), condition records, keyframes; bindKey/localRule/projectCollection/relocate bounded per §7.
  - Ordered-batch validation (`decodeOperationBatch`): 1..64 ops, single linear pass — duplicate localIds rejected, forward/unknown localRefs rejected, targetRef-vs-localRef namespace conflict rejected. No nested groups, no DAG fields (they decode as unknown-field), no graph engine.
  - Planner response union (plan/04 §3): proposal/requestEvidence/question/cannotComplete, exactly one discriminator; expectations must resolve inside the batch namespace; declaration group budget enforced.
  - Records (plan/04 §2/§4): RouteScope (exactPath/pathPrefix/origin; path required except origin), TargetDescriptor v1 (single=exactly-1, future-set requires set, min≤max), Revision/Customization/OriginRecord v2 with activeRevisionId referential integrity.
  - Provider (plan/04 §6, plan/17 §4): profile v1 — https or loopback-http only (LAN http → `denied`), browser-owned/hop-by-hop header names rejected, api-key-header requires headerName, capability overrides explicit (no model-name guessing); UserGrant v1. `isAuthoritySignal()` stub documents that model/page consent flags are never authority (I19).
- Import gate extended: `contracts` layer may import `shared/` only (audit:imports enforces; S1.1 validation criterion). Gate passed on the real graph (42 files, no cycles).
- Tests: `tests/unit/contracts.test.ts` — 25 tests covering the T02 named negatives (unknown fields, DAG/group fields like `dependsOnLabels`/`required`, wrong types, stringified numbers/booleans, missing target, both-refs conflict, duplicate/forward localRefs, unknown kind/version, 0/65 ops, oversized text/tree/JSON depth, prototype keys, question bounds, descriptor invariants, endpoint/header policy, insertUI unsafe grammar, style rule bounds, expectation refs, OriginRecord integrity, receipt status vocabulary) plus valid-baseline decodes of every kind and the full response union.

### Evidence (commands from `project/`)

| Command | Result |
|---|---|
| `npm run typecheck` | pass (contracts + tests included) |
| `npm run lint` | pass, 0 errors |
| `npm run build` | pass — audit:env ✓, audit:wiring ✓, audit:imports ✓ (42 files, contracts imports nothing), wxt build ✓ |
| `npm test` | exit 0 — unit: 68 tests, 66 passed, 2 known-red (F05); browser: 7 tests, 4 passed, 3 known-red; 0 unexpected |

### Notes / residual risks

- No production behavior changed: nothing imports `contracts.ts` yet by design — consumers arrive in S1.2 (trust/grant functions), S2 (broker/runtime dispatch), S6 (providers). The wiring gate treats it as consumed within its own file until then; no fake consumers were added.
- CSS value safety (URL/variable policy) is deliberately NOT here: the schema bounds shape only; the S4.1 compiler owns the pinned-parser AST policy (documented in code where CSS values decode).
- Ambiguous/multi-object JSON remains the extract-layer contract (S6.1, plan A3); the schema layer receives exactly one candidate object.
- `Envelope.payload` is validated as a bounded plain object; per-kind payload validation belongs to the dispatching owner (S2.1) per the module contract row.

Next task: **S1.2 — Implement trust/grant/privacy boundary foundation**.

## S1.2 — Implement trust/grant/privacy boundary foundation — `complete`

- Date: 2026-09-09. Source: dirty `main` (baseline `71263e0` + owner edits + S0.1/S1.1 additions preserved).
- Changes: extended `project/src/contracts.ts` with the denied-by-default trust section (§9), pure over plain sender metadata — no chrome.*/DOM (import gate still proves contracts imports nothing):
  - Sender-role classification (`classifySender`): structural decision over what the BROWSER reports on a MessageSender (id/url/origin/tab/frameId/documentId) — extension pages → `workspace` (checked first, so the fallback workspace tab wins over its hosting tab), service-worker sender (only the id set) → `broker`, web-document sender (tab + non-negative frameId + documentId + http(s) URL) → `runtime`, everything else → `unknown`. No payload field can elevate a sender (I19, T25).
  - Per-Kind authorization (`senderMayInvoke`): the exact plan/06 §1 sender column as an explicit allowlist (RegisterDocument=runtime; StartRun/CancelRun/AnswerQuestion/ApproveProposal/RenewLease=workspace; StageStyle/RemoveStyle/CommitComposition=runtime; GetOperation=workspace+broker; SaveRevision/SetEnabled/RemoveCustomization=workspace+runtime; RouteChanged/PermissionRevoked=broker). Unknown Kinds and the `unknown` role deny everything.
  - Credential context boundaries (`maySubmitCredentials`/`mayReadCredentials`): workspace+broker may submit for storage; only the broker reads back — and it never echoes credentials into replies, logs, exports, or content-bound DTOs (T25).
  - Disclosure-bound consent (`evaluateProviderConsent` + `decodeDisclosureAck`): an acknowledgement is valid only for the exact current `PROVIDER_DISCLOSURE_VERSION` AND the exact configured endpoint; changing the endpoint invalidates consent (plan/04 §6). A legacy boolean consent flag, a missing record, or a model/page "consent" field can never satisfy it.
  - Site permission is separate from provider permission (`evaluateSitePermission`): versioned, origin-scoped, category-scoped, expiry evaluated against an explicit `nowMs` so the layer stays pure and clock-free. Fails closed on unknown versions/foreign origins/ungranted categories.
  - `credentialAppearsInUrl` / `isAllowedRedirect`: pure guards for the S6.1 provider client — credentials never ride in URLs (query/fragment/userinfo) and redirects are accepted only back to the exact configured origin (scheme+host+port; downgrade or port change denied).
- Tests: `tests/unit/trust.test.ts` — 36 tests covering the T04/T21/T25 named negatives: forged senders (foreign extension id, wrong-id chrome-extension URL, chrome:// runtime-shaped sender, externally_connectable web sender, missing id), unknown-Kind/unknown-role denial, consent binding (endpoint change, older/newer disclosure versions, legacy boolean flag, page/model consent), URL credential placement (query/fragment/userinfo), redirect policy (cross-host, scheme downgrade, port change), site-grant separation (foreign origin, ungranted category, unknown version, expiry), and the T04 sentinel corpus through field exclusion + residual redaction (`minimizeEvidence`).

### Evidence (commands from `project/`)

| Command | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run lint` | pass, 0 errors |
| `npm run build` | pass — audit:env ✓, audit:wiring ✓, audit:imports ✓ (42 files), wxt build ✓ |
| `npm test` | exit 0 — unit: 104 tests, 102 passed, 2 known-red (expected); browser: 7 tests, 4 passed, 3 known-red (expected); 0 unexpected |

### Notes / residual risks

- Still no production consumer: the broker (S2.1) is the first caller of `classifySender`/`senderMayInvoke`; the provider client (S6.1) calls the URL/redirect guards. The functions are the checked contracts those tasks must use — no fake consumers were created.
- Trust classification operates on browser-reported sender metadata only; a compromised content runtime is still bounded by per-command roles and by the broker re-verifying epoch/registration on every request (S2.1/S2.2).
- The disclosure/endpoint rules encoded here are v1; changing them requires an ADR amendment per plan/24 §5 (trust boundary).

Next task: **S2.1 — Build document broker/runtime bootstrap and serialized queue** (plan/05, plan/06, plan/12).

## S2.1 — Build document broker/runtime bootstrap and serialized queue — `complete`

- Date: 2026-09-09. Source: `main` `8bf797c` (S0.1+S1 committed; plan/ stays local) + S2.1 additions.
- New modules (plan/02 §3 consolidated layout):
  - `project/src/background/broker.ts` — the MV3 privilege broker (logical `background/broker` + `background/documents`): pure `createBrokerCore(deps)` over plain data + `installBroker()` chrome wiring. Synchronous onMessage listener (v2 envelopes only; legacy `action` dispatcher untouched); handlers await a hydration barrier backed by chrome.storage.session. Per-command sender-role verification (contracts §9 allowlist); envelope decode; per-command payload decoders with unknown-field rejection; document registry keyed by tabId:frameId:browserDocumentId with runtimeInstanceId fencing — identity derived ONLY from browser sender metadata (payload cannot forge tab/document); authoritative route epochs advanced on webNavigation onCommitted/onHistoryStateUpdated (destroyed sibling documents pruned via the browser-reported documentId); one run owner per document (second StartRun → `conflict` with cancel-first recovery); bounded GetOperation relay (deadline-capped, timeout → `timeout-unknown` retryable-same-id, unreachable runtime → `stale-document`); inbound RuntimeState/RunProgress projections observed, never routed.
  - `project/src/runtime/session.ts` — the per-document runtime (logical `runtime/session` + `runtime/queue`): pure `createTaskQueue()` (five priority lanes per plan/06 §2, one task at a time, cancellation overtakes at the task boundary — queued work above rollback rejected deterministically, revoke/rollback lanes still run, in-flight tasks observe `signal.cancelled`, 32-pending bound, coalesced reconcile) and pure `createSessionCore()` (lifecycle booting/ready/suspended/disposed, document fence for I04: instance/tab/epoch checks, monotonic epoch adoption). `bootRuntimeSession()` wiring: duplicate-instance detection via the isolated-world global (old instance disposed directly — never duplicated listeners), RegisterDocument handshake with bounded retries, RuntimeState broadcast to subscribed workspaces, local route detection via popstate/hashchange/pageshow + URL equality at command entry — NO history monkey patching; BFCache pageshow.persisted re-handshakes; disposal removes listeners and rejects commands.
- Entrypoint wiring: `installBroker()` in background.ts, `bootRuntimeSession()` in content.ts — both additive; v2 executes NO mutations in this phase, the legacy path remains the sole mutation owner until the plan/19 cutover task (dual mutation ownership impossible in S2.1).
- Import gate: new boundary rules — `runtime/` must not import background/agent/tools/entrypoints; `background/` must not import `runtime/` (plan/02 §1, plan/03). Negative-control fixtures added; gate self-test updated (7 expected violations).
- Tests: `tests/unit/broker.test.ts` (21: T21 sender matrix incl. runtime-invokes-StartRun/broker-role/foreign; browser-derived identity + forged-payload rejection; T08 replaced-instance late-message rejection; T21 tab-id-alone denial; T11 stale-epoch rejection + navigation epoch advance with RouteChanged notification; T14 second-StartRun conflict + idempotent CancelRun; relay/timeout/unreachable I06 cases; deadline, version, transport-kind-laundering, projection non-routing; registry survival across a simulated worker restart; tab destruction) and `tests/unit/runtime-session.test.ts` (14: serialization, priority preemption, T14 cancel-overtake ordering, generation re-arm, cooperative in-flight signal, 32-bound, coalescing; unregistered/stale-instance/stale-epoch/disposed fences, monotonic epoch adoption, suspend/resume). Browser: 4 new real-path tests — registration with browser-verified identity + legacy coexistence, one-run-owner conflict/cancel cycle, GetOperation full relay (workspace→broker→runtime→relayed unknown-target receipt) with broker-side stale-epoch and forged-document denial, and reload → fresh instance registers while the old instance's late command is deterministically rejected. Dedicated fixture document `tests/fixtures/pages/v2-vertical.html` (old and new runtimes exercised only on separate test documents).

### Evidence (commands from `project/`)

| Command | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run lint` | pass, 0 errors |
| `npm run build` | pass — audit:env ✓, audit:wiring ✓, audit:imports ✓ (44 files incl. new boundary rules), wxt build ✓ |
| `npm test` | exit 0 — unit: 139 tests, 137 passed, 2 known-red (expected); browser: 11 tests, 8 passed, 3 known-red (expected); 0 unexpected |

### Notes / residual risks

- Route-epoch authority is the broker registry; the runtime's local bump (popstate/hashchange) can run ahead if a broker notification is lost — the desync fails SAFE (next command rejected stale-route, recovered by re-registration/reload). Full SPA continuity matrix is T11's later slices.
- The legacy `action` dispatcher and the v2 broker coexist by design until the plan/19 cutover: v2 has no executors, so one-mutation-owner (I03) still holds. The cutover task must disable the legacy CSS-reinsert/replay handlers when v2 mutation arms (plan/19 §3.3).
- RegisterDocument reply carries documentKey+epochs; "applicable saved intent" joins when the store module (S2.3/S4) exists — refused honestly with `unsupported-capability` for RenewLease/SaveRevision/SetEnabled/RemoveCustomization until their owners arrive.
- Service-worker sender shape (id-only vs origin-bearing) varies by Chrome version; RouteChanged acceptance therefore allows trusted extension contexts (broker OR workspace role) and rejects page-world senders — the browser test drives the real path and passes.

Next task: **S2.2 — Implement CSS delivery intent/receipt and inert namespaces** (plan/03 background/styles, plan/06 §3).

## S2.2 — Implement CSS delivery intent/receipt and inert namespaces — `complete`

- Date: 2026-09-09. Source: `main` `18cdf0a` (S2.1 committed) + S2.2 additions.
- New module `project/src/background/styles.ts` — privileged CSS delivery (plan/03 `background/styles`; plan/06 §2 boundary 2), pure `createStyleDelivery(deps)` + `createChromeStyleDelivery()` wiring (documentId-scoped insertCSS/removeCSS at AUTHOR origin):
  - Intent-before-insert (I05): the durable session intent (owner ids + exact bytes = the release strategy) is persisted BEFORE the API call; a persist failure means NO insert is attempted.
  - Exact receipts (I06/I10): inserted / removed / outcome-unknown / remove-failed / revoked. A hanging or failing insertCSS yields `outcome-unknown` with the error recorded — never a live receipt, never "not applied". A failed removal stays recorded (`remove-failed`) until a retry succeeds or the document is destroyed; the error reply names the conflict.
  - Operation dedupe: same operationId + same digest returns the recorded receipt with NO re-insert (no reliance on undocumented browser sheet dedupe — removal always uses the exact recorded bytes); same operationId + different payload digest is refused (`duplicate-id`) and the altered sheet never reaches the browser (T14).
  - Two-bundle rule: at most one accepted + one candidate physical bundle per root; a staging/unknown candidate blocks replacements until `reconcile()` exact-cleans it; a displaced inserted candidate is namespace-revoked then exact-removed BEFORE the new bundle stages (insert→remove→insert order proven).
  - Namespace revocation disarms FIRST (I07): `cancelNamespace` records the namespace revoked before any async cleanup; a late insert ack for a revoked namespace triggers immediate exact cleanup and can never report the bundle live; revoked namespaces are refused for staging and (via the runtime primitives) for activation.
  - Restart reconciliation: startup `reconcile()` exact-cleans every staging/unknown/revoked-pending intent from the hydrated session ledger; `documentDestroyed()` marks a destroyed document's intents terminal without removeCSS calls (the bytes died with the document).
  - Commit promotion: only an observed `inserted` candidate can be committed (plan/05 §4: nothing transitions from delivery-unknown to accepted); the predecessor bundle is retained for an explicit later remove.
  - Delivery budget injectable (`deliveryTimeoutMs`, default 10s) with explicit outcome-unknown on expiry.
- Broker integration: StageStyle/RemoveStyle/CommitComposition (transport `style-delivery`, runtime-only authority) route through document fencing (instance+epoch) into the delivery module; GetOperation prefers the broker style ledger so a lost ack is reconciled by receipt lookup, never by blind re-execution; navigation/tab-close prune delivery receipts for destroyed documents.
- New module `project/src/runtime/styles.ts` — token activation/disarm primitives (plan/08 §4): `createTokenScope(document)` — activation attaches the exact token attribute (`data-rv2-ns`) to connected elements only; disarm removes exactly the matching attribute (page-written attributes untouched); `revoke()` marks before cleanup; activation refuses revoked/malformed namespaces (I07). Namespaces themselves are generated by the S4 compiler (installation-id + resource path); these primitives enforce shape and the revoke guard. Deferral note: like contracts.ts in S1.1, the primitives have no production caller yet — their consumer is the S4 transaction; no fake consumer was added.
- Tests: `tests/unit/styles.test.ts` (18 — the T14 kill-at-every-boundary matrix: persist-crash before side effect, hanging insert → outcome-unknown, startup reconcile exact-clean, failed removal visibility + successful retry, permission-revoked insert, duplicate-id same-digest no-reinsert, duplicate-id altered-payload conflict with no insert, cancel-before-ack late-ack inertness + never-restage, displaced-candidate removal ordering, uncertainty blocks staging until reconciled, commit promotion rules, ceiling + namespace bounds, documentId targeting, worker-death-between-intent-and-ack restart reconciliation, document-destruction terminal receipts) and `tests/unit/token-scope.test.ts` (5 — activation on connected elements only, revoked-namespace refusal, malformed refusal, exact-match disarm protecting page-written tokens, revoke-before-cleanup ordering). Broker suite extended to 26 (style routing with registry-resolved identity, workspace StageStyle denial, stale-instance StageStyle never delivered, RemoveStyle/CommitComposition routing, GetOperation ledger preference).
- Browser: 1 new real-path negative control — a workspace sender staging a style through the actual extension messaging is denied (runtime-only authority, T21 live).

### Evidence (commands from `project/`)

| Command | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run lint` | pass, 0 errors |
| `npm run build` | pass — audit:env ✓, audit:wiring ✓, audit:imports ✓, wxt build ✓ (373.32 kB content script) |
| `npm test` | exit 0 — unit: 167 tests, 165 passed, 2 known-red (expected); browser: 12 tests, 9 passed, 3 known-red (expected); 0 unexpected |

### Notes / residual risks

- Validation "no reliance on undocumented browser CSS dedupe" is enforced by construction: every insert/remove passes exact recorded bytes and the module never assumes an insert dedupes. "Author-normal/user-important behavior checked": sheets insert at AUTHOR origin (wiring), so site author rules and USER-important overrides outrank ours by cascade rules — the live cascade matrix (site !important beats our author-normal sheet) is exercised with real compiled sheets in S4's T07 browser tests, since S2.2 has no production StageStyle caller yet (the delivery layer is exercised through its documented seams; the only live-path proof available without a fake consumer is the authority denial, which is tested).
- The GetOperation ledger reply carries `status: outcome-unknown` with the current registry epoch so the future runtime transaction can reconcile exactly.
- Revoked-namespace persistence is session-scoped (dies with the browser session); a cross-restart namespace reuse is additionally blocked by the intent ledger's duplicate-id rules.

Next task: **S3.1 — Replace inventory/identity with bounded semantic snapshots** (plan/07, plan/10 A1/A2, module rows observe/facts/targets). S2 phase box ticked (both leaves complete with evidence).

## S3.1 — Replace inventory/identity with bounded semantic snapshots — `complete`

- Date: 2026-09-09. Source: `main` (S2.2 committed) + S3.1 additions.
- New module `project/src/runtime/targets.ts` — identity/root registry (plan/03 `runtime/targets`, plan/07 §3, A2):
  - Session-instance identity is EXACT NODE identity: observation registers live nodes under opaque snapshot-local refs (`t<n>`, never selectors echoed to the model); resolution accepts only the recorded node while connected, inside its registered root, with declared tag/role predicates unchanged. The legacy `expectedFp=null → mutate unverified` path has no equivalent (I15: a selector or hash is never identity proof).
  - Declared roles are re-checked against the attribute; landmark approximations are recorded as pure functions of the tag (re-derived, not assumed). A disconnected recorded node resolves `stale` (it was observed, now gone) — distinct from a never-observed ref (`missing`).
  - Root discipline (I26): every registration/query is relative to one registered root; open ShadowRoots are registered roots; document selectors never cross root boundaries.
  - `discover` (A2 observation-only path): browser-evaluated selector inside ONE registered root, bounded candidate cap (64) — zero matches = missing, cap hit = unsupported (never a first match); invalid selectors report unsupported.
- New module `project/src/runtime/observe.ts` — bounded semantic snapshots (plan/03 `runtime/facts`+`runtime/observe` consolidated, plan/07 §1, A1):
  - Deterministic document-order BFS with plan/07 proposed budgets: 2,000 visited nodes, 60 regions, ≤12 KiB serialized evidence, ≤100 ms time budget with 4 ms slice checks; whole evidence records serialized until the byte budget (never split); dropped regions become the expansion cursor (I21: honest partial, never claimed-complete).
  - Regions carry targetRef/rootRef/parentRef (only when actually observed), declared tag/role (approximations labeled `landmark-approximation`), accessible-name approximation (labeled), OWN-text-node samples capped at 80 chars and residual-redacted through the S1.2 boundary layer, quantized viewport geometry with clipping/visibility, and an action catalog by declared control type only — never values.
  - Privacy (T04): password/email/tel/search/hidden inputs contribute no name, no type, no text, no placeholder anywhere in the snapshot; visible-text emails are `[redacted:email]`; titles pass through `redactSensitiveText`. No `.value` read exists anywhere in the walker.
  - Open shadow roots are discovered and walked as roots; no global stamping (I16): the registry WeakMap maps nodes to refs, DOM attributes are added only by accepted runtime resources.
  - Cursor: snapshotId:offset:expiresAt, 30 s TTL (plan/04 LIMITS.cursorTtlMs), epoch-bound; expired/forged/epoch-mismatched cursors rejected deterministically (`stale`).
- Wiring: broker routes Observe/Inspect/Expand (transport `observe-request`) with document fencing and a shared deadline-bounded `relayToRuntime` helper (extracted from the duplicated GetOperation relay); the runtime session owns the observation engine, runs observation commands through the serial queue at observation priority (cooperative, cancellable), and answers snapshot/facts replies. Trust-layer note: broker-relayed commands are accepted at the runtime because the broker already verified the originator against the same allowlist (plan/06 §1 hops); direct workspace senders still pass the allowlist.
- Tests: `tests/unit/targets.test.ts` (7 — exact-node resolution, unknown/missing refusal, disconnected→stale, declared-role predicate re-check, root-local bounded discovery incl. invalid-selector and candidate-cap refusals, dispose teardown). Browser (real path): T04 privacy sentinels absent from the delivered snapshot (password placeholder/email value/name never present; visible-text email redacted), shadow-root region observed in its own root; T03 10k-node fixture → `completed:false`, `reason:node-budget`, cursor offered and expandable, forged cursor refused; T05 Inspect resolves the exact observed ref, unknown ref refused `unknown-target`, replaced node refused `stale-target` (never re-resolves to a lookalike).

### Evidence (commands from `project/`)

| Command | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run lint` | pass, 0 errors |
| `npm run build` | pass — audit:env ✓, audit:wiring ✓, audit:imports ✓, wxt build ✓ |
| `npm test` | exit 0 — unit: 174 tests, 172 passed, 2 known-red (expected); browser: 15 tests, 12 passed, 3 known-red (expected); 0 unexpected |

### Notes / residual risks

- Validation timing: budgets are enforced by the walker (node/time/byte) and verified live on the 10k fixture (≤2s end-to-end message latency observed ≈300ms; the ≤100ms/2k local-work target is a walker budget, and its precise benchmark harness is a T24/P1 measurement, not yet a numbered result — the budgets cannot be exceeded by construction).
- Recycled/virtualized rows and stable-single descriptor re-resolution belong to the S4 transaction path (A2's else-branch with saved anchors); the S3.1 registry covers the session-instance contract.
- Old perception (`core/perceive`, `core/inventory`) is NOT imported by the v2 runtime — the new path is self-contained; legacy deletion happens at the plan/19 cutover with its consumers.
- 50k-node soak and 30-minute memory bounds are T24 (P1), scheduled with the full acceptance pass.

Next task: **S4.1 — Build parsed CSS/content compiler and policy** (plan/08 §2–3, algorithms A3–A5, plan/02 css-tree dependency decision). S3 phase box ticked (single leaf S3.1 complete with evidence).

## S4.1 — Build parsed CSS/content compiler and policy — `complete`

- Date: 2026-09-09. Source: `main` (S3.1 committed) + S4.1 additions.
- Dependency (plan/02 §4 authorization executed): `css-tree@3.2.1` pinned exact, MIT license verified via `npm view`, added as an explicit production dependency; `@types/css-tree` pinned as dev. Bundle note: css-tree is tree-shaken out of the content bundle until the S4.2 transaction wires the first production consumer (current content.js 167.4 kB unchanged); the bundle impact lands with S4.2 and is checked there.
- New module `project/src/runtime/compile.ts` — canonical resource compilation (plan/03 `runtime/compile`; plan/08 §2–3):
  - ONE parser+policy path (plan/22 AC-03 — no handwritten property catalog): every declaration value is parsed by css-tree and walked. URL-bearing/network-capable constructs rejected wherever they appear — url(), data-URI escape hatches, image-set strings, paint/worklet refs, attr(), element(), cross-fade, nested-in-calc — plus Raw fragments (escaped constructs fail closed). The css-tree lexer additionally rejects syntax the platform does not know ("unsupported syntax rejected explicitly"); var()-containing declarations are exempt from static lexing by design (substitution is use-time) with the token policy enforced instead.
  - Function allowlist (visual-only, network-free: math/color/gradients/filters/transforms/easing/clip-shapes/counters/env); `var()` only `--rv-*` or explicitly observed safe site tokens; css-tree parses var() fallbacks as Raw so fallback text is fail-closed scanned for forbidden constructs (documented as the raw-fragment handle, not an AST replacement).
  - `all` (global reset) and legacy executable properties rejected; hiding/cutting declarations (display/visibility/opacity/pointer-events/position/overflow/user-select/touch-action/inset/z-index) compile but are surfaced as HIGH-IMPACT claims (hides-content/blocks-interaction/positions-overlay/replaces-content) so the S4.2 transaction applies the same target/risk policy as named operations (I17 — raw CSS cannot bypass hide/interaction constraints). `content` only on generated ::before/::after surfaces.
  - Generated selectors: `:where([data-rv2-ns="<token>"][:state])::pseudo-outside` — uniform zero specificity so canonical customization order decides; no combinator/:has/:is/comma can ever enter (the model never authors selector text; I01). Targets are resolved to tokens by the injected resolver (S3.1 registry / same-batch local refs); unknown targets produce target diagnostics, never guesses.
  - Keyframes: runtime-namespaced (`rv2-<namespace>-<name>`), animation/animation-name references rewritten ident-exactly, never important, offsets from/to/percent only; motion authored without a prefers-reduced-motion counterpart rule is rejected (plan/08 §2).
  - Conditions: viewport (inline size), prefers-color-scheme, prefers-reduced-motion compile to nested @media (plan/08: per-rule nested conditions preserved); @supports pairs must pass the same value policy (a side-channel bug found and fixed during this task: the supports branch originally bypassed the pair check).
  - Per-declaration `!important` preserved for the USER-origin document sheet; final self-check re-parses the generated sheet and rejects any URL node or unexpected at-rule kind in OUR OWN output; sheet bytes bounded by LIMITS.maxSheetBytes.
  - `compileInsertUi` (plan/28 §2, compile half — execution is S4.2): tag allowlist (no scene until S8.4), typed attribute set, on*/src/srcdoc/href/action/method/style/class/id rejected, local input types text/search/checkbox/radio/range/number (never password/file/submit), buttons forced type=button, structural nesting validated (ul/ol→li, select→option, details→summary first, table row groups/rows/cells), depth/node bounds, local a11y refs (labelFor/ariaDescribedBy/ariaLabelledBy) recorded for S4.2 id rewriting.
- Delivery-origin correction (plan/08 §3): document-root sheets insert at USER origin with explicit scoped important (user normal loses to author normal) — `background/styles.ts` wiring changed AUTHOR→USER for both insert and remove (exact bytes + same origin); the delivery ceiling now shares `LIMITS.maxSheetBytes`. Broker boundary backstop added: staged sheets containing `url(`/`@import`/`image-set(` are refused at the privilege boundary (plan/08: "CSS URL-free policy is rechecked at broker boundary") — independent of, not replacing, the compiler AST policy.
- Tests: `tests/unit/compile.test.ts` (28) — the T07 corpus: modern visual values (color-mix/clamp/text-wrap:balance/gradients/grid repeat/drop-shadow/clip-path/linear() easing), eight unsafe-value rejections incl. data-URI and calc-nested url, var laundering (unknown site token rejected; --rv-* and explicitly observed tokens allowed), all/behavior rejection, group rejection (no partial sheet), high-impact surfacing, :where selector generation with pseudo placement, content-surface rule, keyframe namespacing+reference rewriting, reduced-motion counterpart mandatory, keyframe importance/offset rules, nested media conditions, supports pair policy, bounds; the T22 pixel-ratio criterion (fixed 48px mini-player compiles, surfaced as positions-overlay); T31 compile-half negatives (script/iframe/onclick/href/srcdoc/style/password/file/type and li/summary/row nesting). Broker suite unchanged (18 styles tests still pass with the USER-origin/backstop changes).

### Evidence (commands from `project/`)

| Command | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run lint` | pass, 0 errors |
| `npm run build` | pass — audit:env ✓, audit:wiring ✓, audit:imports ✓ (bare css-tree external ✓), wxt build ✓ |
| `npm test` | exit 0 — unit: 202 tests, 200 passed, 2 known-red (expected); browser: 15 tests, 12 passed, 3 known-red (expected); 0 unexpected |

### Notes / residual risks

- The compiler has no production caller yet — its consumer is the S4.2 transaction (A4 enter-document-queue stage). Like contracts.ts/observe.ts, the deferral is documented; no fake consumer was created. The delivery boundary backstop is live production code in the broker path.
- The lexer's platform-syntax data is css-tree's MDN-derived set; a Chrome-only declaration newer than that data is rejected explicitly (correct per plan: unsupported = explicitly refused, never guessed). The modern corpus in the suite pins the currently-supported surface.
- @container conditions and frame-accurate motion verification arrive with later capability slices (plan/08 §2 names container queries as explicit validated records; not in the S4.1 v1 condition set).
- T30 composition and T31 execution are S4.2/S4.3 work; the compile halves of both are done here.

Next task: **S4.2 — Implement one-batch transactions and generic element insertion** (plan/08 §4, algorithms A4/A5, plan/03 runtime/transaction+content).

## S4.2 — Implement one-batch transactions and generic element insertion — `complete`

- Date: 2026-09-09. Source: `main` (S4.1 committed) + S4.2 additions. Owner edit in `core/config/index.ts` (model default) preserved untouched.
- New module `project/src/runtime/transaction.ts` — the one-batch transaction (plan/03 `runtime/transaction`, plan/08 §4–5, algorithms A4/A5):
  - Prepared ledger before any side effect (I05): every op resolves its exact target (registry session refs; same-batch insertUI localRefs), compiles its fragment (style/hide through the S4.1 compiler under a fresh generation token) or prepares its native write (text leaf shape, anchor placement), and records owner IDs + site baseline + predecessor value. Stale/missing targets keep their exact codes (`stale-target`/`unknown-target`), never a first-match fallback.
  - One proposal is one ordered revision (I11): dedupe by batchId — same digest replays the recorded receipt, a different digest never executes and never overwrites the prior receipt (T14/T08). Unsupported kinds (collapse/float/bindKey/localRule/projectCollection/relocate) are refused `unsupported-capability` BEFORE side effects.
  - Canonical aggregate composition (plan/08 §3): ONE accepted aggregate bundle per document, recomposed from all accepted revisions' fragments in customization acceptance order; a candidate stages the full recomposition (unchanged fragments byte-identical in values/order under the new generation token) — at most one accepted + one candidate physical bundle via the S2.2 broker boundary. Uniform :where() specificity means canonical order decides.
  - A4 flow: stage inert → epoch/cancel recheck after the await → final identity re-check (T08: no activation on targets that mutated after the ack) → ONE synchronous write section (retire replaced tokens → text writes + dropped-claim site-baseline releases with compare-and-guard → insertUI placement → token activation) → bounded settle → verification → CommitComposition ack → epoch recheck → predecessor-bundle release (cleanup failure sets `cleanupPending` and blocks the next aggregate replacement — I10).
  - A5 reversal: disarm candidate tokens FIRST (namespace revoked — I07), reverse writes in reverse creation order on the SAME native references (I08/I09 — failed candidate returns the predecessor value; release returns the site baseline; `releaseCustomization` is per-customization, no global undoAll). A site value changed meanwhile is never overwritten — the conflict stays visible in the receipt (`conflicted` status, bounded conflict claims list). Independent accepted revisions are never touched by a rollback (I12).
  - Bounded conflict claims: a native Text node can be claimed by exactly one customization; another customization's batch claiming it is refused `conflict`. Quota: 64 revisions/document (plan/08 §3 fragment budget) refused before side effects. Retained receipts: last 128 (plan/06 §4).
  - S4.2 verification is delivery/placement/token-membership/written-value (real checks); the structured measured-effect/integrity VerificationReport is S4.3's seam.
- New module `project/src/runtime/content.ts` — the one generic creator (plan/03 `runtime/content`, plan/28 §2): native DOM APIs only (no innerHTML, no clones — I08), a11y local references resolved to runtime-generated `rv2-owned-*` ids AFTER the complete tree validates (missing target refuses the whole batch), before/after/first-child/last-child placement with anchor-context nesting refused up front (a div root host inside a target list/table never reaches the browser's repair), exact removal (already-absent owned nodes are released, not failed restorations), and the replaceText leaf-shape check (exactly one Text child, noneditable — `unsupported-text-shape` otherwise; empty replacement refused pending content-removal approval).
- Wiring: broker routes `ApplyBatch` (run-command transport, workspace-sender allowlist, registry-fenced, deadline-bounded relay — plan/06 §1); the runtime session constructs the transaction over the SHARED target registry (Observe refs resolve in ApplyBatch), a real token scope, and a style-delivery client over `chrome.runtime.sendMessage` (StageStyle/RemoveStyle/CommitComposition with expectedRouteEpoch). ApplyBatch runs through the serial queue at apply priority (cancellation observed at every await); GetOperation now reconciles retained runtime receipts before answering unknown. Installation id persisted in `localStorage` (non-secret, plan/08 §3 namespace component).
- Bug found on the real path: `compile.ts` used Node's `Buffer.byteLength` for the sheet ceiling — undefined in the browser content world; replaced with `TextEncoder`.
- Tests: `tests/unit/transaction.test.ts` (20 — faithful DOM stub, real compiler/registry/token-scope/transaction code: insertion at all placements + localRef styling, label-for id rewriting, missing-ref/invalid-nesting/refused before side effects, replay dedupe, duplicate-id altered-payload, A→B→C failed-candidate-returns-B + disable-returns-A + site-change-preserved, cross-customization claim conflict, staging refusal/unknown, cancel-after-stage, late commit-refusal compensation, stale-target-after-ack, hide-through-style-path, empty-text refusal, quota) and 2 real-path browser tests on a new fixture `v2-apply.html` (accepted insertUI+style batch with computed-style proof at USER origin; label/input id link; replaceText keeps the native node and its page-world listener; a framework-re-render container fails verification and rolls the WHOLE candidate back including the same-batch text write; replaced-node stale refusal; GetOperation receipt reconciliation).

### Evidence (commands from `project/`)

| Command | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run lint` | pass, 0 errors |
| `npm run build` | pass — audit:env ✓, audit:wiring ✓, audit:imports ✓, wxt ✓ (content.js 404.01 kB — the S4.1-documented css-tree bundle impact landing with its first production consumer) |
| `npm test` (×2 consecutive) | exit 0 — unit: 222 tests, 220 passed, 2 known-red (F05); browser: 17 tests, 14 passed, 3 known-red (F06/F02/T05 legacy paths); 0 unexpected |

### Notes / residual risks

- The ApplyBatch relay is deadline-bounded (5s cap): a very slow staging yields `timeout-unknown` and reconciles through GetOperation's retained receipt — never a blind re-execution.
- Verification covers delivery, placement, token membership and written values; baseline-relative effect/integrity measurement (contrast, clipping, focus, sentinels) is S4.3 — acceptance in S4.2 is delivery/placement-verified only, by design of the split.
- `releaseCustomization` is callable on the transaction (T30 disable/site-base restore proven in unit tests) but not yet exposed as a message command — `SetEnabled`/`RemoveCustomization` wiring arrives with S5.
- Shadow-root/cross-frame targets are explicitly refused (document-root sheets cannot reach shadow descendants; plan/08 §3 open-root sheets are a later slice; S8.3 owns frames).
- Site grants/capability consent are not yet enforced inside the runtime (S6 owns the consent workspace; S1.2 functions are ready).
- The aggregate is fully recomposed and restaged on every style-bearing batch (unchanged fragments duplicated during staging per plan/08 §3; bounded by the 256 KiB sheet ceiling) — an accepted batch whose predecessor-bundle removal failed keeps `cleanupPending` and blocks the next aggregate replacement until reconciled.

Next task: **S4.3 — Implement mandatory structured verification and combined revision gate** (plan/08 §6, algorithm A7, plan/03 runtime/verify).

## S4.3 — Implement mandatory structured verification and combined revision gate — `complete`

- Date: 2026-09-09. Source: `main` `cb180b4` (S4.2 committed; owner's dirty `core/config/index.ts` model-name edit preserved untouched).
- New module `project/src/runtime/verify.ts` — the structured verifier (plan/03 `runtime/verify`, plan/08 §6, A7):
  - Delivery/effect/integrity split with STABLE structured keys (`delivery:css`, `delivery:token:<i>`, `effect:style:op<i>:rule<j>:decl<k>:<prop>`, `effect:text:<i>`, `effect:insert:<i>`, `integrity:<key>:present|visible|focusable|control|media|text|overflow`, `contrast:owned:<i>`, `combined:<cust>:…`) — issue identity never depends on message wording.
  - Mandatory baselines (A4 step 2): pre-write samples of every protected target + bounded sentinels (parent + adjacent siblings, caps 24/48) — connectivity, visibility, keyboard reachability, form disabled/media paused, own-text length, per-element and viewport horizontal overflow. Any measurement throw refuses the batch BEFORE staging (`captureBaseline` → `{ok:false}` → not-applied).
  - Effect truth (T13): computed value vs the canonical form of the DECLARED value — canonicalized by an OWNED probe element in the target's inheritance context (`probeCanonicalOf`, removed in `finally`, never modifies native content); already-satisfied values pass; custom-property and keyframe declarations are excluded by design and disclosed in `coverage.unmeasuredDecls` (never silently).
  - Integrity (T13/T22): baseline-relative — protected element removed, unauthorized hidden (intentional hides exempt via the hide scope incl. descendants; newly hidden ancestors/siblings are NOT — the sentinel catches them), focus reachability lost, form control disabled, media paused, protected text vanished, new horizontal overflow >2px tolerance (element + viewport). No window resize/move anywhere (I22) — all measurements are read-only.
  - Contrast (T22/plan/08 §6): new owned text must meet WCAG AA (4.5 normal / 3.0 large via `shared/color` `contrastFloor`); gradients checked against EVERY stop; alpha/unsupported compositing → `unknown`, never an invented ratio.
  - Aggregate: any fail → `fail`; else any unknown → `unknown`; empty check set → `unknown` (no empty-array fallback pass); otherwise `pass`. Unknown outcomes get exactly ONE bounded recheck (60ms seam) before the aggregate — coverage discloses `rechecked`.
  - Combined revision verification (T30): every OTHER accepted revision's stored declaration samples (≤4/revision, stored ≤16 at acceptance) + its text claims (not re-claimed by the candidate) + owned nodes are re-measured post-write; candidate-overridden (el, property) pairs are excluded (canonical-order refinement is intended); effects already broken BEFORE the candidate are exempt and disclosed in `coverage.preExistingBroken` — never silently dropped, never attributed to the candidate.
- Transaction integration (`runtime/transaction.ts`): the S4.2 inline checks are REPLACED by the verifier — `deps.verify` missing → refuse before any side effect (T13 "missing verifier after clean predecessor"); baseline captured pre-stage; a missing/throwing/malformed/zero-check report synthesizes an `unknown` report (`verify:internal` issue) → whole-candidate rollback with the report attached; `report.status !== 'pass'` → rollback (receipt carries `report` + failed keys in the error message); acceptance requires `pass` for the exact revisionId — the accepted receipt ships the report. Fixed en route: the insert placement check now expects the ANCHOR as parent for first/last-child and the anchor's parent for before/after.
- Session wiring: `createVerifier` over the real `window.getComputedStyle` (+ pseudo), `probeCanonicalOf`, `getBoundingClientRect`, 60ms recheck wait; passed into the transaction.
- Tests: `tests/unit/verify.test.ts` (10 — real verifier over stub DOM + fake computed store: already-satisfied, structured fail keys, one-recheck-then-pass, authorized hide exemption vs unauthorized sibling loss, focus loss exempt/fail, contrast pass/fail/alpha-unknown, viewport overflow ±2px tolerance, combined held/broken/pre-existing-exempt, baseline-capture refusal, unmeasured disclosure); `tests/unit/transaction.test.ts` extended to 23 (missing verifier refuses cleanly; zero-check report can never pass — synthetic `verify:internal`; accepted receipt carries the report). Browser (real path, 4 new/extended assertions): T31 accepted receipt carries a pass report with measured checks; T22 low-contrast owned text (`#eee` on white) → rolled-back with `contrast:owned` key and removed tree; T13 a user-NORMAL declaration losing the real author cascade → `effect:style:*` fail → rolled-back, site color untouched, no token remains; T13 authorized hide accepts, hides the target, leaves ancestors/siblings untouched.
- F05 note: the new-runtime equivalent of the F05 defect is now enforced and tested — absent/empty/throwing verification is UNKNOWN, never `repaired`/pass (3 unit tests). The legacy `agent/recover.ts` clause stays known-red by design until the plan/19 cutover deletes that path (S6.3).

### Evidence (commands from `project/`)

| Command | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run lint` | pass, 0 errors |
| `npm run build` | pass — audit:env ✓, audit:wiring ✓, audit:imports ✓, wxt build ✓ (content 642.7 kB: css-tree + verifier now in the bundle) |
| `npm test` (×2 consecutive) | exit 0 — unit: 235 tests, 233 passed, 2 known-red (F05 expected); browser: 20 tests, 17 passed, 3 known-red (expected); 0 unexpected |

### Notes / residual risks

- Pseudo-surface effect checks canonicalize through a probe child of the host element (inheritance-adjacent, not the pseudo box itself); a mismatch there is reported honestly (fail), never silently passed.
- Measurement windows are bounded (settle ≤250ms + one 60ms recheck); a site mutation landing after the recheck but before CommitComposition is caught by the late-promotion compensation (S4.2), not by the report.
- `releaseCustomization` (disable/remove) restores by compare-and-restore with honest conflict receipts but no full report — structured release verification can be added if a task requires it.
- Integrity attribution is window-based: a site mutation racing the ~300ms candidate window is attributed to the candidate (conservative rollback) — the same trade-off the plan's preview window accepts.

Next task: **S5.1 — Implement versioned origin records and canonical revisions** (plan/13, A9, plan/19). S4 phase box ticked (all three leaves complete with evidence).

## S5.1 — Implement versioned origin records and canonical revisions — `complete`

- Date: 2026-09-09. Source: `main` `7983823` (S4.3 committed; owner's dirty `core/config/index.ts` model-name edit preserved untouched).
- New module `project/src/background/store.ts` — the persistent record owner (plan/03 `background/store`, plan/13 §1/§3/§6/§7, plan/04 §4):
  - One OriginRecord per origin under `rv2:origin:<origin>`; the broker alone writes it. Guarantees come from ONE trusted writer with per-origin write serialization, an expected-recordRevision gate and lastMutationId reconciliation — never a fictitious storage CAS.
  - Save protocol (plan/13 §3): workspace sends the accepted revision + expected recordRevision + unique mutationId → stale revision returns explicit `conflict` with the current record summary (UI may merge disjoint customization IDs after refreshing; concurrent edits to the same customization are never overwritten silently); the write is one complete record with new revision + lastMutationId, then a confirming RE-READ — anything unproven is reported unsaved, never a blind retry.
  - Idempotency: same mutationId + same payload replays the stored outcome; same mutationId with a different payload is refused (plan/04 receipt identity).
  - Quotas (plan/13 §1): per-customization 256 KiB, per-origin 2 MiB, total 6 MiB measured on serialized bytes BEFORE the write; oversize refused with the record byte-identical — applied work stays applied-unsaved (I21).
  - Interruption (T12): a session pending marker is written before each record write; hydrate reconciles every marker by lastMutationId (`confirmed` proves the write, `unsaved` reports without proof) — worker death around a write is recoverable and honest.
  - Tombstones (plan/13 §6): removal strips the customization and records a bounded tombstone (≤32, 5-minute stale deadline); stale-session saves of a removed ID are refused until expiry (T30 resurrection test).
  - Revisions: active + previous kept per customization (trim to 2); the customization ARRAY order is the explicit canonical composition order and is never reordered by merges (I13).
  - Quarantine (T26, plan/13 §7, plan/19): hydration loads recognized v2 records; unknown schemaVersion, corrupt JSON and legacy `rv_<origin+path>` journals are quarantined UNTOUCHED (byte-for-byte preserved, never replayed/decoded/executed); raw quarantined bytes are exportable to the trusted workspace for review only (`ExportQuarantine`), and saves against unreadable records refuse rather than overwrite.
- Contracts (`src/contracts.ts`): `RouteDiscriminator` DTO (user-approved query key+value / hash value, no automatic wildcard — plan/13 §2) with optional `discriminators` on RouteScope (cap 8); `Tombstone` + optional `tombstones` on OriginRecord (still schemaVersion 2); LIMITS for the record budgets. Sender authority tightened per plan/04 ("content scripts cannot write it"): `SaveRevision`/`SetEnabled`/`RemoveCustomization` are now workspace-only (was workspace+runtime); added workspace-only `GetOriginRecord` and `ExportQuarantine`.
- Broker: the three stub commands are real — payload decoders (per-command, unknown fields rejected), `storeReply` mapping store outcomes to explicit saved/record-revision/error replies with the conflict summary riding the error reply for the merge UI; `installBroker` builds the store over `chrome.storage.local`/`session` and reconciles pending writes + quarantine after the hydration barrier.
- Legacy notes: `SaveRevision`/`SetEnabled`/`RemoveCustomization` are implemented at the RECORD level (S5.1 scope). Broadcasting new recordRevisions to runtimes and cross-document enable/disable/remove (plan/13 §6 first half) land with S5.2 replay, which is also when content runtimes first read sanitized records through the broker. Import of legacy journals into reviewed disabled drafts needs descriptor mapping from fresh observation — the review flow lands with the workspace cutover; quarantine/export is the honest S5.1 slice.

### Evidence (commands from `project/`)

| Command | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run lint` | pass, 0 errors |
| `npm run build` | pass — audit:env ✓, audit:wiring ✓, audit:imports ✓, wxt build ✓ (content 658.7 kB: store now in the bundle) |
| `npm test` (×2 consecutive) | exit 0 — unit: 253 tests, 251 passed, 2 known-red (F05 expected); browser: 21 tests, 18 passed, 3 known-red (expected); 0 unexpected |
| Tests added | `tests/unit/store.test.ts` 14 tests (save/confirm, revision trim, stale-revision conflict + disjoint merge, serialized concurrent writers, mutationId replay/forgery, customization quota with byte-identical record, pending-marker reconciliation confirmed/unsaved, legacy + unknown-schema + corrupt quarantine untouched, tombstone resurrection block + expiry, setEnabled gate, I13 order, T25 unknown-field credential rejection); `broker.test.ts` +4 (workspace save routing, runtime sender denied with store untouched, GetOriginRecord + conflict summary on error reply, ExportQuarantine raw bytes); `extension.test.ts` +1 real-path browser test (save → recordRevision 1, GetOriginRecord round-trip, stale save conflict with summary, remove tombstone blocks zombie save) |

Next task: **S5.2 — Implement route-aware local reconciliation and replay** (plan/13 §4/§5, plan/19 cutover prep).

## S5.2 — Implement route-aware local reconciliation and replay — `complete`

- Date: 2026-09-09. Source: `main` `85b38d6` (S5.1 committed; owner's dirty `core/config/index.ts` model-name edit preserved untouched).
- New module `project/src/runtime/replay.ts` — continuity core (plan/03 `runtime/reconcile`, plan/13 §2/§4/§5/§6):
  - **Route scope semantics** (plan/13 §2, exported pure): exactPath default (query/hash ignored), pathPrefix with slash boundary, origin-wide; user-approved query/hash **discriminators** are exact alternatives — any match admits the route, never a wildcard over all query values.
  - **Descriptor resolution** (plan/04 §2): anchor predicates (tag/stableId/test-attribute/role/label) locate the anchor; semantic guards constrain the target; relations self/direct-child/sibling/descendant within a verified parent; rootPath shadow-host hops report closed/absent roots as explicit `unsupported` (I26 — never a light-DOM guess). Missing → `waiting`; ambiguous → `suspended`; a hash is never identity (I15). Resolved nodes register into the shared target registry; the saved revision's `d<i>` descriptor refs are rewritten to fresh session refs.
  - **Replay through the SAME transaction path** (I14): each enabled, in-scope customization becomes one batch (`replay:<custId>:<revId>`) run through `transaction.applyBatch` — same validation, staging, activation, mandatory verification and rollback as an initial apply. No provider call, no historical action replay, no page refresh (I23). Per-customization live state is explicit and broadcast: `applied | waiting | suspended | out-of-scope | paused | disabled | conflicted` — never full success with missing coverage.
  - **Same-document reconciliation** (plan/13 §5): a MutationObserver (coalesced 100ms quiet / 500ms max) revalidates applied customizations against the live document; all members lost → release + `waiting`; membership change → release + one desired-state re-apply; per-pass budget (32 customizations) with honest partial coverage; a group pauses after two conflict cycles within 10s and stays visible until an explicit user/route action.
- Transaction fix (`runtime/transaction.ts`): batch receipt dedupe now replays only while the revision is still LIVE — after `releaseCustomization`, re-applying the same intent is fresh work (route return / re-enable), not a stale-receipt replay (T11). Staged operation ids are document- and generation-scoped (`<batchId>:d<docId>:g<gen>:css`) so two documents replaying one saved revision are separate deliveries and a re-apply after release is a new stage, never a digest collision in the broker's ledger (plan/06 §2 per-document bundles).
- Broker: `DocumentRecord` gains the browser-sender site origin; the **RegisterDocument reply carries the applicable validated records** (plan/06 §1; content never touches storage directly); `SaveRevision`/`SetEnabled`/`RemoveCustomization` **broadcast to every registered document of the origin** with per-document acks surfaced in the reply — missing acks stay visible (I10). Save-time validation: saved revisions must reference descriptor refs `d0..dn` (self-contained intent; stale session refs rejected at save). New workspace/broker-relay command `SavedRevision` (roles table).
- Runtime session: registration replays applicable records at reconcile priority; local navigation (popstate/hashchange) and broker `RouteChanged` both re-evaluate scope (out-of-scope tokens revoked before new activation); `SavedRevision`/`SetEnabled`/`RemoveCustomization` relays reconcile locally and ack with the runtime's own result; RuntimeState projections now carry per-customization states.
- Contracts: `SavedRevision: ['workspace', 'broker']` relay role; no schema changes (discriminators/tombstones already in S5.1).

### Evidence (commands from `project/`)

| Command | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run lint` | pass, 0 errors |
| `npm run build` | pass — audit:env ✓, audit:wiring ✓, audit:imports ✓, wxt build ✓ (content 430.9 kB / total 673.3 kB) |
| `npm test` (×2 consecutive) | exit 0 — unit: 261 tests, 259 passed, 2 known-red (F05 expected); browser: 23 tests, 20 passed, 3 known-red (expected); 0 unexpected |
| Tests added | `tests/unit/replay.test.ts` 8 tests (T11 scope semantics incl. slash boundary + exact discriminators; I15 descriptor resolution missing/ambiguous + stable-id/test-attribute/sibling anchors; T10 replay through the transaction path with descriptor-ref rewrite + no re-apply of live intent; missing target waits with zero applies; rolled-back replay suspends with public detail; T11 route A→B→A release/restore; disable/enable/remove broadcasts; T23 conflict pause visible and not auto-retried); `tests/browser/extension.test.ts` +2 real-path tests: T10 apply→save→**reload replays saved intent without a model** (one namespace token — no accumulation), live replay after save broadcast, disable persists across reload, remove cleanup; T11 SPA pushState out-of-scope revokes tokens (0 remain), return restores exactly once (A→B→A) |

### Notes / residual risks

- Reconciliation release+reapply on set-membership change re-resolves the whole customization (one flicker frame) — bounded by the conflict pause; per-member incremental resource deltas would need ledger granularity beyond the one-batch contract and are deferred until a task needs them.
- `bindKey`/`collapse`/`float`/`projectCollection` operations replay through the descriptor rewrite but their runtime executors are not task-owned yet (capability list stays honest — plan/19 workflow-breadth row).
- The broker broadcast targets registered documents only; a document opened while the record changed receives intent at its next registration (cold load), which is the plan/13 §4 path.

Next task: **S6.1 — Implement provider adapters and bounded planning controller** (plan/11, plan/03 §4; adapter code can begin after S1, integration needs S5 — now satisfied).

## S6.1 — Implement provider adapters and bounded planning controller — `complete`

- Date: 2026-09-09. Source: `main` `80be035` (S5.2 committed; owner's dirty `core/config/index.ts` model-name edit preserved untouched). Note: the previous session record named S6.2 as next, but S6.2's contract lists the S6.1 controller as a required input — the owner confirmed doing S6.1 first (protocol order preserved).
- New `project/src/providers.ts` (plan/02 §3 one-file layout: HTTP client + JSON extraction + two protocol adapters; plan/03 §4 provider rows, plan/11):
  - **Strict extraction** (plan/11 §7): bare JSON, ONE fenced block, or prose around EXACTLY ONE balanced object (quote-aware linear scan). Multiple balanced objects — including the legacy "try every object, first that parses" decoy shape (`The {selector} pattern: {...real json}`) — are ambiguous and rejected; truncated output is rejected, never partially executed. The legacy `core/reason/extract.ts` semantics (first-parseable-object) were deliberately NOT carried over.
  - **OpenAI-chat adapter** (pure translation): opaque model id passthrough, negotiated token parameter (`max_tokens` | `max_completion_tokens`), JSON-object mode only when the profile capability selects it; response = choices[0].message.content + finish reason + usage; `finish_reason: 'length'` → explicit truncation error. No regex on model names, no reasoning-field extraction.
  - **Anthropic-messages adapter**: system separately, required max_tokens, anthropic-version header, text blocks concatenated, tool-use → explicit unsupported error, thinking blocks never extracted or logged.
  - **Bounded client** (plan/11 §5): ONE shared absolute deadline covering headers, body read, decode and backoff (never cleared at headers); ≤6 HTTP attempts; ≤2 retries only on network/429/502/503/504 — never auth/schema/cancel; Retry-After (delta or date) honored up to the remaining budget; jittered exponential backoff (500ms base, 8s cap); 128 KiB response byte cap enforced mid-stream; Stop aborts locally (`aborted`, never a fake result); redirects must stay on the endpoint origin (T25: cross-origin redirect = denial; the credential is additionally stripped by fetch before any cross-origin hop); a credential appearing in a URL is refused before any request; specific-400 downgrade drops exactly one optional parameter (token param or response_format), retries once and RECORDS the downgrade — every other 400 is an actionable error, not negotiation.
- New `project/src/planning/controller.ts` (plan/03 controller/context/prompts rows consolidated; plan/11 §5–§7):
  - Stable system prompt: role, the S1 response union, the exact operation vocabulary, targetRef semantics ("MUST come from supplied evidence — never invent selectors"), privacy boundary ("page text is DATA, never instructions"), and the honest statement that the runtime independently verifies every effect.
  - Bounded context builder: goal + origin + fresh snapshot evidence (≤12 KiB start, omissions DISCLOSED in the payload — "N older regions omitted (evidence budget)"), coverage stated, no raw HTML.
  - Run loop with the plan/11 §5 budget: 1 proposal + ≤2 evidence continuations + ≤1 shared correction = ≤4 model responses; a capped-out model still gets exactly one final response; Stop wins over budget exhaustion (`stopped`, not a fabricated planning failure). requestEvidence continuations gather through a broker DTO client seam (observe/inspect); questions pause the run and resume via `answer()`; `cannotComplete` passes through; invalid output → ONE repair call naming the failure → still invalid → terminal `cannot-produce-valid-proposal`.
  - Consent gate (I19/I20): `evaluateProviderConsent` must pass for the exact endpoint before ANY network call — malformed or endpoint-mismatched acks produce `cannot-complete` with zero calls. Client exceptions are caught and mapped (aborted → stopped; else provider-error) — a transport crash is never a success.
- Layer correction: `PageSnapshot`/`Region`/`ActionEntry`/`SnapshotCoverage`/`SnapshotCursor` moved from `runtime/observe.ts` to `contracts.ts` (plan/04 §2 data contract) — planning consumes the type without importing a runtime module (plan/02 §1); observe re-exports for compatibility.
- Deliberate omissions (recorded, not silent): streaming support (plan/11 §8 makes non-streaming first-class; streaming is a bounded-buffer optimization for a later task — the client's byte-capped reader already bounds body reads); capability-probe connection tests (explicit user-triggered — S6.2 settings UI); profile persistence (S6.2). The controller is a library consumed by the workspace; no production wiring exists yet — that is S6.2's job, so the provider path stays unreachable from runtime/broker (I01/I02 boundary intact).

### Evidence (commands from `project/`)

| Command | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run lint` | pass, 0 errors |
| `npm run build` | pass — audit:env ✓, audit:wiring ✓ (deferred exports unchanged), audit:imports ✓ (type-only planning→contracts edge), wxt build ✓ (673.3 kB; providers/controller not yet in any entrypoint bundle) |
| `npm test` (×2 consecutive) | exit 0 — unit: 287 tests, 285 passed, 2 known-red (F05 expected); browser: 23 tests, 20 passed, 3 known-red (expected); 0 unexpected |
| Tests added | `tests/unit/providers.test.ts` 16 tests over a real local HTTP server (T19: opaque model id, negotiated token param + JSON mode opt-in, anthropic system/max_tokens/version, usage/finish extraction, tool-use/thinking refusal, T02: exactly-one-object incl. two-object decoys + truncation, T20: strong one-attempt, 401 never retried, 503 retry-to-success + attempt cap = 3, 429 Retry-After, specific-400 downgrade recorded with body swap, deadline covers slow headers, 128 KiB cap, T25: cross-origin redirect refused with credential stripped before the hop, same-origin redirect allowed, credential-in-URL refused with zero requests, Stop aborts locally); `tests/unit/controller.test.ts` 10 tests (one-call common path, evidence continuations capped at 2 with the ≤4 budget, repair-once then terminal, two-object ambiguity repaired, question pause/resume, cannotComplete passthrough, provider-error surfacing, Stop → stopped with no further calls, consent gates with zero calls, downgrade surfaced, evidence-block budget + disclosed omissions) |

Next task: **S6.2 — Build accessible shared workspace and truthful state management** (its S6.1 controller input now exists; plan/16 UX, plan/06 projections).

## S6.2 — Build accessible shared workspace and truthful state management — `complete`

- Date: 2026-09-09. Source: `main` `00b461c` (S6.1 committed; clean tree).
- Protocol addition (plan/24 §5 record — **ADR-14** in plan/18; plan/06 §1 rows added): two read-only, workspace-role-only commands. `ListDocuments` (workspace → broker: registry snapshot — the exact-target picker needs DocumentKeys; a tab id never authorizes, I04) and `GetState` (workspace → registered runtime through the same document fence: the close/reopen resync pull; RuntimeState pushes now carry a monotonic `seq`, stale pushes ignored). No new mutation authority; both return data broadcasts already carry.
- New `project/src/diagnostics.ts` (plan/02 layout, plan/16 §3/§4): content-free bounded event ring (200) + human summary; overflow drops oldest diagnostics only; no raw prompts/CSS/URLs/secrets by construction (bounded labels/codes/counts only).
- New `project/src/ui/workspace.ts` — the shared workspace (plan/03 §6 ui rows consolidated):
  - **Pure status projection** (plan/16 §2 wording table): typed phases, exact wording, no false success anywhere (`Applied and saved.` only after the store ack; `Applied in this tab; saving failed.` for unsaved; `Stopped; previous accepted changes kept.`; conflicted/unknown never render clean).
  - **Exact target pinning** (T21): registered documents only, explicit radio selection, persisted pin revalidated against live registrations on every load (plan/05 §1) — a dead pin is cleared, never rebound to another tab; start without a pin/goal/consent/profile/AI is an explicit zero-call refusal.
  - **Run flow**: StartRun (one owner/document; conflict → `busy`, never silent replacement) → Observe → S6.1 controller (question pause/resume with a 5-minute expiry that stops honestly — no guessed answers; proposal approval with explicit Apply/Discard and a save-time scope picker) → ApplyBatch through the broker → receipt-mapped honest statuses (rolled-back/conflicted/outcome-unknown each worded per the table) → SaveRevision. Always-available Stop (abort + CancelRun); `pagehide` cancels unfinished planning.
  - **Save prep** (`buildSavedRevision`): self-contained revisions — one TargetDescriptor per referenced targetRef built from OBSERVED region semantics, operations rewritten to `d<i>`; unobserved or shadow-root targets are honest errors, never guessed selectors.
  - **Customization list**: record + live GetState states (enabled ≠ applied), enable/disable/remove/undo-latest-revision (re-save of the stored previous revision with a fresh mutationId), fresh `expectedRecordRevision` before every record mutation; conflicts surfaced with the broker's summary + retry.
  - **Settings**: profiles validated through `decodeProviderProfile` (credential stored once, never rendered/exported), endpoint-scoped explicit consent ack (`evaluateProviderConsent` re-checked by the controller — defense in depth), real AI opt-out (blocks all planning calls; saved customizations stay manageable), malformed stored settings fall back to defaults (no authority from garbage).
  - **Diagnostic panel**: pinned document/epoch/runtime lifecycle, record revision, live customization count, last-run counters (model responses + HTTP attempts shown separately), bounded ring summary.
- Entrypoints: `entrypoints/sidepanel/` (index.html + thin main.ts with chrome seams) — WXT maps it to `side_panel.default_path` + `sidePanel` permission; the SAME page in a tab is the extension-tab fallback with an in-page "Open this workspace in a tab" button; toolbar `action` opens the panel via `setPanelBehavior` where supported.
- Root-cause fixes found by the new tests: (1) workspace-generated `cust-<uuid>` ids pushed replay staged operation ids past the 128-char bound — every saved customization would have replayed `suspended`; ids are now compact (`cust-<12 hex>`). (2) Failure details were dropped by the DOM renderer — statuses now carry bounded public detail.

### Evidence (commands from `project/`)

| Command | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run lint` | pass, 0 errors |
| `npm run build` | pass — audit:env ✓, audit:wiring ✓, audit:imports ✓, wxt build ✓ (sidepanel.html + `side_panel.default_path` + `sidePanel` permission in the manifest; total 745.4 kB) |
| `npm test` (×2 consecutive) | exit 0 — unit: 311 tests, 309 passed, 2 known-red (F05 expected); browser: 27 tests, 24 passed, 3 known-red (expected); 0 unexpected |
| Tests added | `tests/unit/workspace.test.ts` 24 tests (statusFor/liveStateText/scopeText wording tables; buildSavedRevision d<i> rewrite + unobserved/shadow honest errors; T21 pin/no-fallback/disappeared-pin; T25 no-consent → zero runs, cross-endpoint ack refused, AC-07 opt-out blocks planning while record control still works, malformed settings → defaults; T27 complete/rolled-back/conflicted/applied-unsaved+retry/provider-error/cannot-complete/stopped/busy/question-resume, reopen GetState pull + stale-seq ignore, persisted-pin revalidation, undo re-save of previous revision). `tests/browser/workspace.test.ts` 4 tests over the built extension: T21 two-tab listing + no auto-pin + keyboard Tab/Enter to Start + explicit gate refusals with zero fetches; **full E2E against the canned local provider** (fixture server parses the request evidence and answers a valid proposal — no live model, no external network): pin exact page → consented run → proposal approval → apply → `Applied and saved.` → crimson on the pinned tab only (other tab untouched) → reopened workspace lists record + `applied on the open page` (GetState resync) → disable reverts the heading to the exact site baseline; AC-07 opt-out refusal wording; axe (CDP init-script, no CSP bypass) — 0 critical/serious violations |

### Notes / residual risks

- The legacy popup remains the toolbar default until the S6.3 entrypoint cutover removes it (v2 workspace fully reachable as side panel + tab today); the legacy full-page work overlay (I22) is deleted with that same cutover.
- Applied-unsaved offers Retry save (+ reload clears the tab); a runtime-side release path for unsaved live batches has no protocol command and stays deferred until a task needs it (removal-after-save covers the durable path).
- RenewLease still has no runtime-side enforcement (unchanged from S5.2); recorded for the cutover review.
- Descriptor anchors are tag/declared-role/accessible-label only; ambiguous re-resolution replays `suspended` (visible, honest) — richer anchors (stableId/test attributes) need observation disclosure of those fields.
- StartRun busy offers cancel + user re-Start rather than one-click cancel-and-replace (explicit two-step, no implicit model spend).

Next task: **S6.3 — Cut over core runtime and remove legacy live paths** (plan/19; all S0–S6.2 gates now pass).

## S6.3 — Cut over core runtime and remove legacy live paths — `complete`

- Date: 2026-09-09. Source: `main` `9c9d146` (S6.2 committed; clean tree).
- **The plan/19 cutover**: the shipped extension now runs ONE runtime — the v2 broker + per-document runtime + workspace — with no legacy live path. The full deletion record with per-item verification is in plan/19 §4 ("S6.3 deletion record").
- Deleted (12,650 lines): `src/agent/` (loop/journal/prompt/budget/recover), `src/tools/` (act/observe/verify/index), `src/core/` except `sanitize/redact.ts` (the pure tested credential-shape primitive this plan retains — no production dependency, kept for its suite), `src/entrypoints/popup/`, `scripts/audit-wiring.ts` + `scripts/audit-env.ts` (retired per the ledger — the resolved-import gate replaces them; the last browser env read died with `core/config`), the dead `bench` script, and the legacy suites that characterized the deleted code (unit: budget/digest/extract-json/known-defects + the two F05 known-red markers; browser: the toolCall/resetTxn/undoLast dispatch tests + the F02/F06/T05 known-red markers). **Both known-red lists are now empty.**
- Entrypoints rewritten thin (plan/19 §3.2/§6): `background.ts` = installBroker + sidePanel behavior + a one-shot §3.4 migration that exact-removes the old per-tab USER-sheet tracker (`rv_insertedCssByTab`) and clears it; `content.ts` = `bootRuntimeSession()` only — no overlay, no history monkey patching, no legacy dispatcher.
- Manifest: popup-free (`action` opens the side panel, Chrome 116+; `sidepanel.html` doubles as the tab fallback), `minimum_chrome_version: '120'` declared; the stale `process.env` vite defines removed with their deleted subject (`core/config`). Bundle: 419.4 kB total (was 745.4 kB).
- Browser suite rewritten to the v2 surface: the smoke test now PROVES the cutover on the real path (the registered v2 document is listed via ListDocuments; a legacy `action: 'toolCall'` produces no result and no mutation — plan/19 §6 "no legacy action dispatcher"), `openFixture` waits for the verified v2 registration instead of the legacy resetTxn handshake, the workspace sender is `sidepanel.html` (one shared page), and the S2.1 coexistence check is inverted into the one-owner proof. All S2.1–S5.2 v2 verticals pass unchanged.
- Docs: pointer headers on `docs/{ARCHITECTURE,TOOLS,TESTING}.md`; new `docs/CORE-PREVIEW.md` — the core preview release note listing available capabilities and the honestly-absent P2 set (bindKey/localRule/projectCollection executors, canvas, frames, journal import review, streaming/connection tests).

### Evidence (commands from `project/`)

| Command | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run lint` | pass, 0 errors |
| `npm run build` | pass — audit:imports ✓ (21 files, boundaries respected, no cycles), wxt build ✓ — manifest: no `default_popup`, `side_panel.default_path` present, `minimum_chrome_version: 120`; 419.4 kB |
| `npm test` (×2 consecutive) | exit 0 — unit: 291 tests, 291 passed, 0 known-red, 0 unexpected (18 suites, inventory complete); browser: 21 tests, 21 passed, 0 known-red, 0 unexpected (2 suites, inventory complete) |
| Deletion verification | resolved import graph clean (no module imports agent/tools; `src/core` = the one retained primitive); source search clean (`toolCall`/`resetTxn`/`undoAll`/`runLoop`/`AI_CONFIG` exist only in tests that assert their absence); built manifest inspected programmatically (popup absent, side_panel present) |

### Notes / residual risks

- Chrome 120 is declared in the manifest but an actual minimum-version install run is not available in this environment — current-stable Chromium is what the browser suite proves. A store-style min-version verification belongs to a release checklist, not this repo's gate.
- Tabs still carrying a pre-cutover content script answer nothing until their next navigation (MV3 cannot reach stale isolated worlds); the release note says "reload open tabs after update" (plan/19 §3.2 fallback — honest, not silent).
- The §3.4 legacy-CSS exact-removal is best-effort by design (a dead tab's sheets died with it); the tracker is cleared unconditionally so the attempt never repeats.
- `src/core/sanitize/redact.ts` remains as the retained pure primitive (its credential-shape suite is in the roadmap's stay-list); no production code imports it — noted here so it is not mistaken for a live path.

Next task: **S7.1 — Install approved native action bindings** (plan/09, plan/28; the core product is stable at S6 — P2 capabilities now build on it, not on the deleted stubs).

## S7.1 — Install approved native action bindings — `complete`

- Date: 2026-09-09. Source: `main` `df9972e` (S6.3 committed; clean tree).
- **`runtime/behavior.ts` (new)** — the per-document executor (plan/03, plan/09 §1/§2): finite catalog `focus | scrollIntoView | activate | followLink | toggleDisclosure`; chord grammar (Ctrl/Alt/Shift/Meta/F1–F12/named keys, canonical normalization shared by parse and live events); reserved-chord set (Ctrl/Cmd+T/W/N/Q/Tab/PageUp/PageDown, Alt+F4) refused — never promised; plain-typing chords refused (editable-surface conflict); pure `decideBinding` eligibility: IME composition, unwanted repeats, password (NEVER interceptable), editable surfaces (default skip, `editablePolicy:'allow'` narrow opt-in), modal focus (default skip, opt-in), target scope, target visible+enabled — no key consumed until eligible (`preventDefault` only after the decision); sync execution of ≤4 native actions while the gesture is current; ONE document keydown listener per session with exact per-binding registry entries (AC-11: no install can duplicate listeners).
- **Transaction integration** — `bindKey` leaves `UNSUPPORTED_KINDS`: prepare validates chord/target/action-fit (duck-typed per-target validation: followLink needs an http(s) link, toggleDisclosure needs details/summary, focus needs a keyboard-focusable element) and refuses reserved/plain/duplicate/colliding chords and the 21st binding (cap 20) BEFORE any side effect; the write section installs bindings as owned resources (`bind-i` receipt ids); rollback uninstalls the candidate and RE-INSTALLS the predecessor's binding specs; acceptance retires replaced bindings; release disposes exactly; bind targets join the integrity-protected set.
- **Verification (I11)** — a bindKey batch has a measured postcondition (`isBound(chord)`) in the effect section; a binding-only batch can now pass with zero style checks, and a missing seam fails (never an accidental pass).
- **Product bug found and fixed by the new fixture**: sibling sentinels shared ONE baseline key (`sentinel:<p>:sibling`), so a focusable sibling's baseline was measured against the other sibling → false "lost keyboard reachability" integrity fails. Keys are now per-sibling (`-prev`/`-next`); root-cause fix in the shared plan builder, not a fixture workaround.
- **Workspace + planner**: the approval review renders `bind "chord" → actions on target — pressing it activates this page's own control; undo removes the shortcut, not any effect it causes` for consequential actions (plan/09 §1's mandatory distinction); the planner vocabulary documents bindKey, the catalog and the honest rules (reserved chords, exact control only).

### Evidence (commands from `project/`)

| Command | Result |
|---|---|
| `npm run typecheck` / `npm run lint` | pass / 0 errors |
| `npm run build` | pass — audit:imports ✓ (22 files), manifest unchanged, 429.3 kB |
| `npm test` (×2 consecutive) | exit 0 — unit: 312/312, 0 known-red, 0 unexpected (19 suites); browser: 30/30, 0 known-red, 0 unexpected (2 suites) |
| T15 matrix (browser, real path) | trusted CDP activation fires the site's own listener exactly once per gesture; focus/scroll sequence; default editable skip with the key REACHING the editor; approved opt-in fires in editors but never in password fields; CDP autoRepeat skipped under default policy; open dialog keeps keys; reserved chord (`Ctrl+T`), plain typing and collision refusals exact; followLink + toggleDisclosure native; save→broadcast→reload replays the shortcut with NO duplicate listener (one activation per press after reload); disable uninstalls exactly; disabled intent never replays |
| Workspace E2E | model proposes a bindKey through the canned provider → review shows chord/actions/target + the non-reversible warning → Apply → trusted press fires once → checkbox disable uninstalls |
| Validation gates | ≤4 actions per gesture (schema); no key consumed until eligible (decide-then-preventDefault, unit+browser); uninstall/reload no duplicates (exact-handle dispose + one-listener design, proven after reload) |

### Notes / residual risks

- IME composition cannot be synthesized over CDP (`Input.dispatchKeyEvent` has no isComposing parameter): the composition/repeat decisions are proven on the exported pure evaluator; the trusted-path listener is three lines. A real-IME manual check belongs to a release checklist.
- The planner prompt still advertises collapse/float/relocate vocabulary whose executors refuse at apply (pre-existing gap, recorded in the checkpoint residual; S7.2/S8 own those executors).
- "Conflict preview" is implemented as: the proposal review names chord/actions/target, and a colliding chord refuses at apply naming the owning customization — no runtime probe command was added for it (YAGNI; plan/03 lists none).
- Bindings on owned local nodes work through `localRef` in the same batch (validateBindAction duck-checks apply); the insertUI node-level `actionId` attribute stays a declaration until S7.2's localRule triggers consume it.

Next task: **S7.2 — Implement collapse and finite local behavior rules** (plan/09 §3, plan/28 §2; T16).

## S7.2 — Implement collapse and finite local behavior rules — `complete`

- Date: 2026-09-09. Source: `main` `38b7c53` (S7.1 committed; clean tree).
- **`collapse` operation (owned disclosure, plan/08 §1/§7)** — an owned toggle button (existing insertUI build/insert/verify machinery) plus the owned state attribute (`data-rv2-collapsed` on the target, site baseline recorded and restored exactly on release/rollback/replacement) plus one deterministic fragment rule (`[data-rv2-ns][data-rv2-collapsed="1"] { display: none !important }`, regenerated by recompileFragment). The toggle click flips aria-expanded + the state attribute (runtime-owned listener on the OWNED node). `userOverride` is mandatory-true — a `false` proposal is refused. A collapsed initial state joins the intentional hide scope (verification exemption, same policy as `hide`) and is measured: acceptance requires the toggle at its validated anchor AND display:none on the target. AC-11: the collapse state resets to the site baseline on disable — removing OUR UI and its effect, never fighting site/user state.
- **`localRule` operation (finite rule engine, plan/09 §3, plan/08 §7)** — trigger `target-appeared` only; finite actions `activateDisclosure` (click the site's own disclosure — the approved native expanded-state action) and `focus`; conjunction predicates `member-of` / `expanded-equals` / `text-contains` (refs resolved at prepare; `owned-state-equals` refuses with an explicit unsupported-capability). Runtime-controlled semantics the model cannot tune: once-per-instance (sticky for the session — a user expansion is never re-collapsed, across re-applies AND re-enables), 500ms cooldown, one attempt per instance even when the site handler throws. **Seed actions fire post-acceptance** — an external (non-reversible) click can never survive a rollback. A `activateDisclosure` rule validates the affordance: strictly inside the instance with an observable expanded state (aria-expanded or details/summary).
- **Replay expansion (persist the rule, never the click history)** — the saved rule's instance target is a bounded `future-set` descriptor (selection 'set', ≤64); the affordance is saved as its own descriptor and resolved RELATIVE to each member (never document-wide — an affordance-only descriptor is naturally ambiguous across instances). buildBatch expands the rule to one op per member (batch-limit coverage reported honestly in the live state detail); reconcile's member-growth re-apply picks up NEW instances; the sticky once-per-instance state keeps user overrides intact across the release+replay cycle. T16 proven end-to-end on the real path.
- **Supporting changes**: `ActionEntry.expanded` (observed aria-expanded evidence for the planner); planner vocabulary + rules for collapse/localRule (honest: one rule per revision semantics, consequential disclosure clicks); workspace approval previews name the automatic action and warn "undo removes the rule, not collapses it already caused".

### Evidence (commands from `project/`)

| Command | Result |
|---|---|
| `npm run typecheck` / `npm run lint` | pass / 0 errors |
| `npm run build` | pass — audit:imports ✓, 440.6 kB |
| `npm test` (×2 consecutive) | exit 0 — unit: 325/325, 0 known-red, 0 unexpected (19 suites); browser: 32/32, 0 known-red, 0 unexpected (2 suites) |
| T16 matrix (browser, real path) | saved rule replays → both initially-expanded instances collapse ONCE through the site's own disclosure (per-toggle click counts prove exactly one native click); a new expanded instance is collapsed once by the reconcile re-apply; the user's expansion survives the NEXT re-apply (sticky once-per-instance, click counts unchanged); disable → a further new comment is NOT collapsed and the user state is untouched; reload → the disabled rule never reinstalls; the owned `collapse` disclosure installs, measures display:none, expands on user click |
| Unit additions | rule evaluation (once/cooldown/conjunction predicates/disclosure-state reader/throwing-handler consumption), collapse toggle wiring (exact listener), transaction collapse+rule refusals (userOverride, empty label, trigger/action/predicate compatibility, affordance containment/state), release/rollback attribute-baseline restores, save-path future-set descriptors + d<i> mapping of target/targetRef/predicate refs |

### Notes / residual risks

- `owned-state-equals` predicates and the `trusted-shortcut` / `owned-state-change` triggers decode but refuse with explicit unsupported-capability messages — they arrive with the owned-control-state task (recorded; the prompt does not advertise them).
- A saved rule's batch-limited expansion (>64 members) reports partial coverage in the live state detail (`rule expanded to N of M matching instances`) — honest partial, never claimed-complete.
- Multiple localRule ops in one revision are allowed (replay generates the same shape); they share the per-customization once-per-instance key — conservative by design (one automatic action per instance per customization).
- The fixture-side lesson (recorded for future fixtures): plain `<script>` fixtures must stay plain JavaScript — a TypeScript cast silently kills the whole block (caught because the rule's seed clicks "did nothing").

Next task: **S8.1 — Implement linked list/grid/board projection** (plan/25 §S8; T17/T28, invariants I08/I14/I18/I25).

## S8.1 — Implement linked list/grid/board projection — `complete`

- Date: 2026-09-09. Source: `main` `e090a42` (S7.2 committed; clean tree).
- **`projectCollection` operation (linked views, plan/03 runtime/projection, plan/09 §4)** — new `src/runtime/projection.ts`: a `list`/`grid`/`board` view of the OBSERVED items in one source container (the container's direct element children), inserted after its anchor as a neutral `div[role=region]` with a runtime-authored self-contained stylesheet (constant strings — no model CSS, no network values). Every rendered string/link is extracted at render time through the finite field catalog (`title` = the item's link text or own text; `label` = explicit accessible name; `link` = safe http(s) href; `category` = explicit `data-status|state|label|priority` marker on the item or a badge inside it), redacted through the shared evidence policy — never source innerHTML, never invented application state (I25/I18).
- **Stable item keys** — origin-relative canonical link (sensitive query parameters and fragments stripped; cross-origin keeps the full URL; non-http(s) → null); items without a usable link fall back to a session identity. A recycled row is a NEW item: buckets follow the item key, never a DOM position.
- **Local-only board organization** — columns = observed categories (source order) + `Unsorted` + user-created ones; moves happen by native drag-and-drop or a per-card `<select>` (keyboard accessible) and write ONLY the session organization map (keyed by customizationId; survives release/re-apply/re-enable — the S7.2 user-override rule applied to projections: a field change never re-buckets a user-moved item). The review labels it: "arranging it changes your local view only, never the site".
- **Live updates in slices** — ONE MutationObserver on the source container (childList/characterData/attributes-filtered) batches work in a microtask: new children render (bounded), field changes re-extract and patch cards in place, a detached child marks its card stale ("source left the page", reveal disabled) — nothing is silently dropped. Duplicate source keys disable the key action (title becomes text) and mark all copies stale; the detached card keeps its (still-valid) link. Coverage line shows rendered/loaded with the 200 cap; "Show more" paginates 50 at a time before any virtualization.
- **Source-visibility approval** — `showOriginal` defaults to true; proposing `false` hides the original set through the EXACT compiled hide path (same fragment/verification/restore machinery as the `hide` op) and is a consequential review line ("the original list will be hidden on the open page; undo restores it").
- **Descriptor resolution excludes the runtime's own view** (`replay.ts`): anchors and relation targets skip `[data-rv2p-view]` subtrees — extension UI is never site evidence, so a projection can never destabilize reconciliation by joining a descriptor's match set (found as a real reconcile-churn/suspend loop in the browser before the fix).
- **Integration** — transaction prepare/write/release/rollback/record via a `deps.projection` factory seam (transaction tests stub the view; the session binds the real document-bound creator); verify.ts measures connected-at-anchor + rendered count + coverage line + source-set presence; replay retargets `sourceSetRef` (d<i>); workspace saves both refs and previews the operation; planner vocabulary + rules added (container semantics, catalog-only fields, board needs `groupBy:"category"`, `showOriginal:false` is consequential). Decoder tightened: field catalog, ≥1 field, no duplicate fields, board/groupBy cross-check; the unused `maxCollectionGroups` LIMITS entry removed.

### Evidence (commands from `project/`)

| Command | Result |
|---|---|
| `npm run typecheck` / `npm run lint` | pass / 0 errors |
| `npm run build` | pass — audit:imports ✓ |
| `npm test` (×2 consecutive) | exit 0 — unit: 341/341, 0 known-red, 0 unexpected (20 suites); browser: 33/33, 0 known-red, 0 unexpected (2 suites) |
| T17 matrix (browser, real path) | board applied through ApplyBatch: 3 cards with observed titles + safe source links + observed category columns + coverage; "Show original" scrolls the live source item into view; a live status change moves the card to the Done column in a slice; a new source item gains a card; the drag moves the card while the source list HTML is byte-identical; the removed item's card goes stale with reveal disabled; a duplicated source key stales both copies and demotes their titles to text; save + SetEnabled(false) releases the view exactly with the source list untouched |
| Unit additions | projection.test.ts (canonical keys, field extraction, column planning, session organization), transaction S8.1 (install/replace/release, refusals, showOriginal:false hide path + release restore), verify S8.1 (placed/items/coverage/source checks), workspace S8.1 (save descriptors + ref mapping), replay unaffected-by-view exclusion |

### Notes / residual risks

- The user's board arrangement is session state — a reload reconstructs the view in source order. Persisting the arrangement with stable keys is the recorded S8.1 follow-up (needs an owned record field; deliberately not built now).
- Playwright cannot drive native HTML5 drag-and-drop in headless Chromium; the T17 drag dispatches the DOM drag sequence (dragstart/dragover/drop) against the shipped delegated listeners — the wiring under test is runtime-owned, so no trusted-gesture policy applies (no site control is activated).
- Category extraction reads explicit `data-*` markers only; sites using aria-labels or images for status badges need the category field left unmapped (items land in Unsorted) — honest, never guessed.
- `label` extraction is implemented but the view currently renders only title/link/category evidence; the field stays available for the planner.

Next task: **S8.2 — Implement floating existing surfaces and gated relocation** (plan/25 §S8.2; T18/T22, invariants I08/I09/I23/I26).

## S8.2 — Implement floating existing surfaces and gated relocation — `complete`

- Date: 2026-09-09. Source: `main` `4695b01` (S8.1 committed; clean tree).
- **`float` operation (plan/08 §1/§7, plan/09 §5)** — the EXISTING surface is visually fixed at one corner through the SAME compiled style path as `hide`/`style` (measured declarations: `position:fixed`, edge coordinates from the declared inset, `width` = `min(24rem, calc(100vw - 2rem))` default, `max-height` = `50vh` default, stacking z-index) — no copies, no reparent, no player duplication; an unsafe/invalid value refuses through the compiler. The minimize/restore control is runtime-owned UI: an owned button as the surface's first child (typed-attribute `data-rv2-float-btn`), clicking flips the OWNED minimized-state attribute on the target (site baseline recorded and restored exactly on release/rollback/replacement — the collapse pattern); the fragment CSS carries the button's corner placement and the minimized collapse. Bare media/void/lifecycle-sensitive targets are refused with "float its container instead".
- **`relocate` operation (gated high-risk, plan/09 §5)** — explicit `structuralGrant:true` mandatory (the review labels it HIGH RISK and names the fallback); the target cannot contain the destination; script/style/iframe/frame/object/embed/canvas/video/audio/img/picture/source/track/svg/math/br/hr/input/textarea/select/option/optgroup/form/label/template/dialog and UNKNOWN CUSTOM ELEMENTS are refused as targets (and as first/last-child hosts) with the honest reason (framework reconciliation, form ownership, lifecycle callbacks) and the float/CSS-or-projection fallback in the recovery action; before/after requires the destination to have a parent; the effective host runs the same list/table context rules as insertUI so the browser is never left to repair placement. The EXACT node moves (same reference — listeners, focus and media state preserved and measured by the integrity baselines); the ORIGINAL parent joins the intentional restructure exemption (its own reflow is the reviewed consequence; its ancestors/siblings stay sentinel-measured); exact original anchors (parent + next sibling) are recorded and reattached by compare-and-restore — the site's newer position is never overwritten (a visible conflict, I23/I09). **Two site overrides suspend relocation for the document** with the visible projection/CSS fallback (resumes on a fresh load).
- **Replay hardening (found and fixed by T18)** — a disable/record-removal/scope-drop now releases whenever the TRANSACTION holds a live revision for the customization (`releaseIfLive`), not only when the replay's own state machine says 'applied': a command-path apply whose saved descriptor later failed resolution left live aggregate CSS in place while the state said disabled. The transaction is the source of truth for live resources; the explicit `RemoveCustomization` path also releases command-path-only revisions (no saved record).

### Evidence (commands from `project/`)

| Command | Result |
|---|---|
| `npm run typecheck` / `npm run lint` | pass / 0 errors |
| `npm run build` | pass — audit:imports ✓ |
| `npm test` (×3 consecutive) | exit 0 — unit: 347/347, 0 known-red, 0 unexpected (20 suites); browser: 35/35, 0 known-red, 0 unexpected (2 suites) |
| T18 matrix (browser, real path) | float: measured `position:fixed` at the declared bottom-end inset, the video element's paused state unchanged through apply/minimize/restore, the page's own click listener still fires on the real element, the minimize control collapses (`max-height` 48px) and restores exactly, disable returns the surface to flow and removes the control exactly; relocate: the gated move keeps the EXACT node (panel.contains(card)), the moved node's page listener still fires, focus preserved on the moved button, the site's framework replacement wins at release (the node stays where the site put it, the conflict is visible, the fight is counted), and the third gated attempt is refused with the suspension message naming the projection/float fallback |
| Unit additions | float install/minimize/release + bare-media and unsafe-value refusals; relocation gates (no grant, self/containment, protected targets, before/after without parent), exact-node move + anchor restore, site-override conflict counting + suspension, rollback reattach; the v1-unsupported characterization test now proves every v1 kind executes; replay stub gained the transaction `revisions()` seam |

### Notes / residual risks

- The browser fight sequence saves each fight customization first: the save's replay applies the CURRENT intent (reclaiming the site's position — correct, the user saved it after the override), then the site override, then the disable records the fight. Command-path-only customizations have no ws release command; the runtime-side RemoveCustomization now releases them (the recorded hardening above) — a dedicated release command is unnecessary for now.
- Float inset/width/maxHeight are model-proposed CSS values validated through the compiler; geometry (which corner is "reachable") is not measured — the T28 visual-quality pass owns aesthetic review.
- A relocation's `placeholder` field is accepted as `flow-slot` (the recorded anchor strategy); no owned placeholder element is inserted into site layout (extension UI inside site flow would be a new mutation class — deliberately not built).

Next task: **S8.3 — Complete root-local fallback and explicit frame targeting** (plan/25 §S8.3).

## S8.3 — Complete root-local fallback and explicit frame targeting — `complete`

- Date: 2026-09-09. Source: `main` `f11a3bf` (S8.2 committed; clean tree).
- **Per-frame injection (plan/12 §3)** — `allFrames: true` on the one content script: one runtime per individually permissioned frame; the BROWSER injects only where the extension's host permissions cover the frame's origin (per-frame permission gating is the browser's, never a payload claim). Each frame registers its own verified DocumentKey (tabId+frameId+documentId — the broker accepted frame documents since S5; the injection was the missing piece).
- **The relay bug T06 found and fixed**: the broker relayed every page command with `sendToTab` — a bare `tabs.sendMessage` broadcast. Two real failures on the real path: (a) a frame-addressed command never reached its runtime (every attempt rejected `stale-document` by the top runtime's fence — the relay never targeted the frame); (b) when frames exist, another frame's SYNCHRONOUS fence rejection raced ahead of the addressed runtime's queued acceptance, so even top-document commands could return another frame's rejection. The relay now delivers to the registered document's EXACT frame (top included, `sendToFrame(tabId, frameId)`); the fence stays the identity check (I03/I04). The T06 browser test proved both failures before the fix.
- **Frame workspace semantics** — the target picker renders one radio per exact document (`tabId:frameId`); embedded frames are marked "[frame N] — origin (embedded frame of <parent origin>)" from `webNavigation.getAllFrames` (browser-derived, permission DISPLAY only, never targeting or saved intent — I19/I26). The persisted pin gains `pinnedFrameId` (0 = the top document — old persisted pins resolve unchanged); a pin whose exact document no longer registers is dropped, never rebound. **The frame Save boundary**: a run on an embedded frame refuses persistence with the session-only explanation ("the change stays applied in this frame until the run ends or the tab reloads, but it is not saved — a persistent frame scope is a future capability") — plan/12 §3's session-only first frame release; never a saved frame index.
- **Root-local stylesheet + narrow inline override (plan/12 §3, I26)** — style/hide targets inside OPEN shadow roots are no longer refused: the SAME validated, namespace-scoped compiled fragment installs as an owned `<style data-rv2-local>` node inside each involved root (inert until token activation — the sheet's selectors match token-carriers only, so a candidate install needs no staging resource); the effect is MEASURED by the batch's style checks (`getComputedStyle` crosses roots — the postcondition proves it, I11). The second tier: a root that cannot host the node falls back to the approved narrow inline override — the rule's own validated declarations, CSSOM `setProperty(..., 'important')`, ≤32 per fragment, exact inline attribute baselines — released/rolled back exactly. Open-root resolution: `rootPath` hops already implemented (S5 descriptors) — T06 now proves the hop reaches shadow descendants and a closed/absent root is `unsupported`, never a light-DOM guess. Text/insert/bind on shadow internals stay document-root-refused with the honest reason (a later slice owns them).
- **Replay rootPath hardening** — resolveDescriptor's rootPath hop + closed-root/missing-host outcomes are unit-covered for the first time.

### Evidence (commands from `project/`)

| Command | Result |
|---|---|
| `npm run typecheck` / `npm run lint` | pass / 0 errors |
| `npm run build` | pass — audit:imports ✓ |
| `npm test` (×3 consecutive) | exit 0 — unit: 354/354, 0 known-red, 0 unexpected (20 suites); browser: 36/36, 0 known-red, 0 unexpected (2 suites) |
| T06 matrix (browser, real path) | the same-origin iframe's runtime registered as a separate DocumentKey with the browser-resolved parent origin display; the explicitly pinned frame applied its style INSIDE the frame (computed red on the frame node) while the top document stayed untouched (one frame, one outcome); the top document's open-shadow style target installed the root-local stylesheet inside the root (`data-rv2-local`), the measured postcondition held across the shadow boundary, save+disable released it exactly and the site's own inline baseline (black) held again; the relay failure (stale-document forever) reproduced before the exact-frame fix |
| Unit additions | root-local sheet install + exact release (44→47 transaction tests); the hostile-root inline fallback tier; document-root refusals for text on shadow internals; replay rootPath hop/closed-root/missing-host; broker frame-tree parent origin + tree-unavailable degradation; workspace frame pin targets the frame's DocumentKey + the frame save session-only refusal; the relay unit tests route through `sendToFrame` (the production path) |

### Notes / residual risks

- The relay's exact-frame delivery changed `sendToTab` semantics for frameId 0: top-document relays now use `sendToFrame(tabId, 0)` — the fence semantics are unchanged for single-frame tabs (all prior tests pass unchanged); multi-frame tabs can no longer be answered by a sibling frame's rejection.
- The observation disclosure records region `rootRef` identity (plan/07: reachable roots are registered); shadow-internal REGION_TAGS elements disclose normally. A bare non-semantic element inside a root is still not a region (bounded disclosure) — styling it requires it to be a semantic region; the disclosure boundary is unchanged by S8.3.
- Frame documents replay applicable records filtered by the FRAME's own origin (S5 behavior — the iframe's runtime gets only its origin's records). Cross-origin frames: the same flow; the browser's per-frame host permissions gate injection (not testable against a private account here; the same-origin T06 flow is the proven path).
- The inline override writes CSSOM with the rule's validated declarations; the ≤32 ceiling is the honest second tier (the root-local sheet is the primary mechanism and works in practice).

Next task: **S8.4 — Add bounded owned Canvas 2D, not a graphics framework** (plan/25 §S8.4).

## UX rework — chat panel, auto-target, separate settings (owner-directed) — `complete`

- Date: 2026-09-13. Source: `main` `7319750` (S8.3 committed; clean tree).
- **Why**: the owner loaded the extension and reported "things are not working"
  + screenshots of the old form UI. Real-browser investigation (headed
  Chromium + the built extension) confirmed the core worked but the UX was a
  wall: a manual target radio list, technical wording, no chat, settings
  buried in a disclosure, and a "No pages…" line that ACCUMULATED on every
  refresh (a real rendering bug — only labels were cleared, never the empty
  paragraphs).
- **Chat panel** (`mountWorkspace` rewritten): one conversation — the user
  types what should change; phase transitions become chat messages in
  beginner wording ("Reading your page…", "Here's my plan. Look it over,
  then press Apply — nothing changes on your page until you do."); the
  proposal/question/retry cards render inside the chat flow; Enter sends;
  Send/Stop gate the input. Card/changes renderers rebuild only on relevant
  state change (a state push no longer recreates the Apply button or the
  enable checkbox mid-click — Playwright proved both instabilities).
- **Auto-target** (owner decision #3): `pinnedDocument` → `targetDocument` =
  the browser's ACTIVE tab (top document preferred; a frame-only registration
  falls back to that frame — honest edge). No manual picker. A run in flight
  keeps its target. Legacy persisted pins decode and are ignored.
- **The real bug the Wikipedia pass found**: `tabs.query({active:true,currentWindow:true})`
  reports the workspace's OWN tab with an EMPTY `url` — the
  `startsWith(extension-url)` self-check never matched, so the panel targeted
  itself and the chip fell to "No page yet" as soon as the panel tab was
  active. Fix: identify our own tab with `tabs.getCurrent()` (side panel →
  null → query result IS the web page; workspace-as-tab → excluded) +
  onActivated remembers the last real web tab.
- **Separate pages**: Settings (provider form, privacy acknowledgement, AI
  on/off, diagnostics) and My changes (keyed in-place update: text/checkbox
  mutate, nodes persist) are their own views behind header buttons.

### Evidence

| Command | Result |
|---|---|
| `npm run typecheck` / `npm run lint` / `npm run build` | pass / 0 errors / pass |
| `npm test` ×2 | unit 354/354, browser 36/36, 0 known-red, 0 unexpected |
| Real browser (headed, wikipedia.org, canned local provider) | auto-target chip ("Working on: Web browser - Wikipedia"); Settings → provider + consent; chat "make the heading crimson" → proposal card → Apply → "Done — applied and saved. Scope: this exact path (/wiki/Web_browser)"; the real `#firstHeading` computed color `rgb(220, 20, 60)`; reload replayed the saved customization; My changes listed it "applied on the open page"; disable → "disabled on the open page" + the heading reverted to the site's own color |

### Notes / residual risks

- The extension-tab fallback targets the last activated real web tab; the
  SIDE PANEL (the real UX) resolves the active web page directly — the
  fallback path is what the tests drive.
- The workspace browser tests now bring the target page to front AFTER the
  panel opens (the panel learns the target from activation in fallback mode).
- Phase wording is beginner-first but the status oracle (#rv-status, statusFor
  texts) is unchanged — the honest-status tests still hold.

Next task: **S8.4 — Add bounded owned Canvas 2D, not a graphics framework**.

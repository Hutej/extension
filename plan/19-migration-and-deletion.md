# Migration, rewrite and deletion plan

**Proposed.** Purpose: transition from the inspected working tree without dual runtimes, loss of user work or endless compatibility scaffolding. Nothing in this document authorizes implementation changes during the architecture-only task. [Audit](01-repository-audit.md) is the baseline; [roadmap](25-roadmap.md) provides task contracts.

## 1. Selected strategy

Subsystem rewrite, not big-bang repository replacement and not patch-by-patch preservation. Retain WXT/TypeScript and useful verified pure primitives. Build contracts and runtime under new module paths, characterize current failures with deterministic tests, then switch the product entrypoints once the vertical slice passes. A development-only explicit runtime selection can support comparison, but **never instantiate both mutation owners in the same document**.

Unknown installed-user population means destructive storage migration is forbidden by default. Preserve legacy records as disabled quarantine and provide review/export; do not pretend old digest CSS can safely auto-run under new identity policy.

## 2. Migration slices

| Migration | Current → target / reason | Sequence and temporary compatibility | Validation / rollback / risk |
|---|---|---|---|
| Test foundation | Missing referenced tests → real Node/Playwright fixtures | Restore baseline under tests; keep old scripts until new commands pass with nonzero count | Build/type/lint/import/fixture gate; rollback only new test infrastructure; don't “fix” source by assertions removal |
| Protocol/ownership | Untyped toolCall + global logs → DocumentKey/operation receipts/resource ownership | New contracts and document runtime exercised through development entry; old runtime not injected there | Race/lost-ack/undo tests; switch selected runtime back only after old document reloaded and new resources released |
| Observation | Inventory + huge perception + selector fingerprints → bounded snapshots/refs | Extract fact primitives with adapters in tests only; no long-lived dual evidence pipeline in production | Coverage/privacy/target fixtures; original collectors remain until consumers migrated, then delete |
| CSS/content execution | Raw CSS/HTML + partial inverses → one validated reversible batch | New compiler/transaction with style, generic insertUI and same-node text; broker stages inert candidate styles | Injection/cascade/same-node/partial-failure tests; release v2 resources and reload clean comparison profile |
| Persistence | rv_* accumulated journals + independent replay → rv2 OriginRecord desired state | Disable legacy auto-replay at cutover; quarantine recognizable old entries; user review into disabled draft | Import/quota/refine/reload/disable tests; never downgrade-write v2 into v0 records |
| Model host | SW loop/Cloudflare constants → visible workspace/provider profiles | Prefill Cloudflare settings without auto-consent; new adapters alongside no active legacy loop | Mock provider matrix; close/Stop/lifecycle tests; explicit old package rollback only with v2 auto-replay disabled |
| UI | Popup and full-screen overlay → shared workspace/status | Launcher points to workspace; settings/customization views derive typed state | Keyboard/state/permissions E2E; don't preserve arbitrary-tab fallback |
| Workflow breadth | bindKey/recompose stubs → finite bindings/projections | Add only after transaction/replay tested; capability list advertises implemented subset | Native controls remain functional; remove capability if gate fails, not placeholder success |

Rollbacks target task-owned changes and clean test profiles. The user's dirty working tree is not a rollback source to reset. Before work implementation agent records its base diff and does not delete pre-existing changes.

## 3. Required cutover sequence

1. Check source baseline and all regression fixtures; record old storage snapshot with explicit user consent if needed.
2. New package/bootstrap detects protocol mismatch and refuses mixed runtime. Dispose old content instance if supported; otherwise require user reload to start v2.
3. Broker disables old webNavigation CSS reinsert/DOM replay handlers **in the same cutover** as enabling v2 runtime. Do not run legacy CSS behind new token system.
4. Identify existing legacy USER sheets using available tracker/inverse data; exact-remove them on migration attempt. If completeness cannot be proven, report reload required before v2 activation. Never remove unrelated page/extension styles.
5. Mark v0 records quarantined, retain untouched originals; write v2 settings/grants only after explicit consent.
6. Run new vertical slice through UI → provider stub → runtime → verify → save → reload → disable. Confirm one set of listeners and no legacy action dispatcher.
7. Delete compatibility runtime path after the P1 gates; tests/fixtures preserve historical regressions, not live old architecture.

## 4. Deletion ledger

Delete **after** replacement gates, not before tests capture material failure modes. Paths relative to repo root.

| Item | Why delete | Current dependents / replacement | Verify no dependency remains | When |
|---|---|---|---|---|
| `project/src/agent/loop.ts` | Multi-owner orchestration, window manipulation, repeated terminal branches | background → planning/controller + runtime transaction | Resolved import graph + source search for runLoop/resize APIs + UI E2E | P1 cutover |
| `agent/journal.ts` undo/persistence API | Conversation history conflates desired/live state | loop/prompt/persist → context + resource ledger + revisions | No Journal imported by production; revision/reload/undo fixtures | P1 cutover |
| `agent/recover.ts` separate repair runner | Independent success/budget policy and missing-check false pass | loop → one controller correction budget + runtime verifier | No recover import; missing-verifier regression passes | P1 cutover |
| `core/ops/index.ts` unused structural vocabulary | No live executor, grants not trustworthy if model supplied | Deferred audit/tests → actual typed capabilities | Compiler AST import audit; no fake consumer added | During contract replacement |
| `core/ops/{txn,recorder,liveDom}.ts` old singleton/clone inverses | Global cross-run undo, clone identity loss | act/content → runtime transaction/content | Same-node listener + per-revision rollback tests | After v2 transaction cutover |
| `core/identity*.ts` old universal fingerprint/store | Unverified mutation, selector key drift, content/depth coupling | inventory/act/persist/ops → targets | No old resolver imports; single/set/recycle tests | After targeting migration |
| `core/heal.ts` | Implicit parent/sibling changes can hide content or wreck sizing | hide/heal → explicit layout effect group | Hide leaves unrelated parent/sibling intact; no heal tool | After style/hide migration |
| `core/responsive.ts` dominance/strip policy | Pixel counts neither prove nor disprove responsiveness, silent design alteration | act → compiler constraints + responsive browser tests | Fixed mini-player allowed; genuine overflow rejected by test/verification | After compiler gate |
| `core/sanitize` regex CSS and local `sanitizeHtml` | Grammar/injection/exfiltration risk | act/observe → AST policy + structured content | Malicious corpus, no unsafe innerHTML sinks | P0/P1 runtime slice |
| `core/perceive/index.ts` global graph/stamping | Expensive, duplicate observation, unreachable serializers | perceivePage/old ops → observe/facts/targets | No data-rv-c writes or global graph imports; coverage/perf tests | After observe consumers moved |
| Unused perceive serializers/models and repeated `deepQuerySelector*` scans | No output consumer or justified performance benefit | Old perception → only extracted fact primitives | Import graph and bundle absence, quality fixture review | Same observation cutover |
| `core/reason/index.ts` Cloudflare-specific transport and GLM regex | Model override isn't provider support | loop → provider adapters/client | Profile matrix passes without source rebuild | Provider cutover |
| `core/config` build-time model/env settings | Global fixed-model/uncapped policy conflicts with user settings | prompt/background/UI → limits/profiles | No process.env model reads in browser bundle | Provider cutover |
| `core/persist` merge/trim by tool args | Dedupe can erase different owners; journals resurrect stale acts | loop/content/background → OriginRecord store/reconcile | No rv_* live replay; legacy only read in quarantined import | Persistence cutover |
| Old content history monkey patches/full-screen overlay | Isolated history incomplete; input blocker no robust Stop | content → broker events/runtime lifecycle/status UI | Source search + navigate/close/keyboard E2E | Runtime/UI cutover |
| Old CSS tracker/toggleState/replayReport global | Competing sources of truth, cross-tab confusion | background/content/popup → scoped resource receipts/live projections | Restart/two-tabs/remove tests | Same persistence cutover |
| `tools/*` runtime/metadata shared registry and stubs | Pulls DOM runtime into broker; no bindKey functionality | loop/content → contracts metadata + concrete runtime dispatch | Offered capabilities equal real executors; no stub advertised | After last legacy caller removed |
| Popup unconnected optOutModel and fake test-result state hook | Misleading control, test-specific hidden state | popup/tests → actual provider opt-out + typed state query | UI opt-out denies fetch; E2E no hidden result dependency | Workspace cutover |
| `project/scripts/audit-wiring.ts` regex reachability gate | Comments count as wiring; perception excluded | build → resolved TS import/dependency test | Deliberately forbidden/dead fixture fails new gate | Foundation + cutover |
| `project/scripts/audit-env.ts` if last browser env read removed | Redundant after profile migration | build → emitted bundle check | Audit all remaining envs first; retain if still useful for build-only flags | Final cleanup, not automatic |
| `docs/{ARCHITECTURE,TOOLS,TESTING}.md` misleading current claims | Superseded, absent tests and contradictory contracts | Root/history readers → small pointers to plan/current implementation docs | Link check + no agent directions depend on old docs | P1 documentation cutover |
| Duplicate direct Playwright dependency if unneeded | Reduce manifest redundancy only with evidence | Test imports/lockfile → one direct test package | npm dependency/import audit and browser runner | P3 or test consolidation |

`project/src/shared/color.ts` is **not** automatically deleted. Keep tested math with necessary corrections. No forced removal of installed dependencies merely because they are dev-only. No new graph/agent framework to replace deleted code.

### S6.3 deletion record (verified 2026-09-09)

The cutover executed the ledger above. Deleted, with the verification that proves no dependency remains:

- `src/agent/` (loop, journal, prompt, budget, recover) and `src/tools/` (act/observe/verify/index) — the resolved import graph (`scripts/audit-imports.ts`, part of `npm run build`) is clean over the remaining 21 src files; no runtime module imports agent/tools.
- `src/core/` except `sanitize/redact.ts` (the pure, tested credential-shape primitive this plan retains; kept for its suite, no production dependency). All identity/ops/persist/reason/config/perceive/sanitize-HTML paths are gone.
- `src/entrypoints/popup/` — the built manifest has no `default_popup`; the toolbar action opens the side panel (Chrome 116+), the same `sidepanel.html` doubles as the extension-tab fallback.
- Legacy live paths in `entrypoints/background.ts` and `entrypoints/content.ts`: rewritten to thin bootstraps (installBroker / bootRuntimeSession only). The browser suite proves on the real path that a legacy `action: 'toolCall'` message now produces **no result and no mutation** (smoke test) and that every v2 path (S2.1–S5.2 tests) works unchanged.
- `scripts/audit-wiring.ts` and `scripts/audit-env.ts` — retired per this ledger (replaced by the resolved-import gate; the last browser env read died with `core/config`).
- Legacy suites died with their subjects: unit `budget/digest/extract-json/known-defects` (+ the F05 known-red markers), browser `toolCall/resetTxn/undoLast` tests (+ the F02/F06/T05 known-red markers). Both known-red lists are now empty — no known defect remains in the shipped product.
- §3.4 legacy CSS: the new background exact-removes the old per-tab USER-sheet tracker (`rv_insertedCssByTab`) once at startup, then clears it; a tab that is gone took its sheets with it.
- §3.5 quarantine: unchanged from S5.1 — v0 `rv_*` journals are preserved byte-for-byte and never executed; v2 state is never down-converted.
- Docs: `docs/{ARCHITECTURE,TOOLS,TESTING}.md` now carry an explicit not-current pointer header; `docs/CORE-PREVIEW.md` is the release note that lists available vs unavailable P2 capabilities.

## 5. User's pre-existing deletions

Root obsolete plans, old screenshots/userscripts, `project/PROJECT.md`, `playwright.config.ts` and `prove.ts` are already deleted in baseline. Do not recreate them to satisfy stale comments. Preserve their Git history for archaeology, not product authority. Existing `.output`, `.wxt`, node_modules and lockfiles are tooling artifacts, not documentation deliverables; planning task leaves them unchanged.

Prospective design cuts (no production consumers exist yet): remove the optional/required subgroup DAG, one-file-per-logical-heading scaffold and report-per-task process. Their replacements are the single ordered batch, consolidated physical modules and one progress log. Do not implement the deleted design first just to migrate it later. Generic insertUI replaces the narrow proposed annotate op directly; existing source tool `insert` still migrates through the safe creation/undo tests. Canvas 2D is one later native leaf, not an imported graphics framework.

## 6. Migration completion

Zero legacy production imports/dispatchers/replay handlers; runtime version mismatch refuses; every saved v2 record validates; legacy records cannot execute automatically; P1 acceptance suite proves apply/refine/undo/reload/disable/worker restart/provider substitution. Deletion checkboxes only checked when tests and resolved import evidence accompany removal. A renamed file with old ownership bugs does not complete migration.

# Repository audit and complete source-reading ledger

Purpose: establish an evidence-based baseline, not endorse existing comments. Scope: the **current dirty working tree**, after reading every file under `project/src/` completely, plus product vision, build/configuration files, both audit scripts and all three legacy engineering documents. There is no root `src/` directory.

## 1. Evidence and baseline

- **Verified:** branch `main`, HEAD `71263e0938e0a3d3a2a5e7a44d2175898b9e8c0b`; source has pre-existing modifications. Several root plans and `project/PROJECT.md`, `project/playwright.config.ts`, `project/scripts/prove.ts` were already deleted. Do not restore or erase these changes as part of planning.
- **Verified:** 42 files, 12,650 lines under `project/src/` (41 TypeScript files plus popup HTML with embedded CSS). Every file below was read from first to last line before choosing the architecture.
- **Verified:** WXT/TypeScript MV3 extension, no React and no production dependency declared. Installed versions: Node 24.19.0, npm 11.17.0, WXT 0.20.27, TypeScript 5.9.3, Playwright 1.62.1, axe-core 4.12.1. Package ranges are not these exact versions; use the lockfile.
- **Verified:** `project/tests/`, `project/proof/`, and an archive containing the claimed historical tests are absent from the inspected working tree. Comments referring to them do not prove test results.
- **Unknown:** distribution/user count, browser-store review status, actual installed-user storage schemas, performance on representative hardware, and historical benchmark artifacts. Migration defaults therefore quarantine legacy state rather than assume it is safe or disposable.
- **Security handling:** `.env` exists; its values were not read and no live model calls or authenticated browsing were performed.

### Commands actually executed (from `project/`)

| Command | Observed result | Meaning |
|---|---|---|
| `npm run typecheck` | Passed | Static checks only; not runtime safety |
| `npm run lint` | Failed, 8 errors | Unused `actIdentity`, two `any` casts in emit, unused `disclosureEl`, unawaited popup message, unused `i`, `anchorStyle`, `serializeInventory` |
| `npm run audit:env` | Passed, 2 environment reads | Existing regex gate; not proof of bundle execution |
| `npm run audit:wiring` | Passed with deferred `validateOps` | Text-reference heuristic; does not establish real call reachability |
| `npm test` | Unit runner reported **0 tests**, then `MODULE_NOT_FOUND` for `tests/browser/run-all.ts` | No executable green test baseline |

No build was run during this documentation-only task; no generated bundle or test code was written. Existing `.output` is not evidence of current-source behavior.

## 2. Complete source inventory and disposition

Paths relative to `project/src/`. Line counts are baseline counts, not timeless references. **All rows: fully read.** “Reuse” means behavior/primitive after tests, not preserve every comment or API.

| File | Lines | Observed responsibility | Target disposition |
|---|---:|---|---|
| `agent/budget.ts` | 220 | Clock/steps, terminal policy, string issue diff, transport/convergence guards | Split pure budget/receipt-aware policy; remove string-derived correctness |
| `agent/journal.ts` | 337 | Prompt memory, undo, persisted history, success gates | Replace with separate evidence window, runtime receipts, saved revisions |
| `agent/loop.ts` | 1124 | Model loop, dispatch, rollback, verification, window resizing, saving | Rewrite bounded workspace controller; delete resizing and duplicate terminal paths |
| `agent/prompt.ts` | 100 | System/user prompts from shared runtime registry | Rewrite capability contracts, keep explicit natural-language intent |
| `agent/recover.ts` | 149 | One CSS contrast repair and recheck | Fold bounded correction into generic proposal validation; no false empty-check success |
| `core/config/index.ts` | 65 | Cloudflare/GLM defaults, global loop budgets | Replace with runtime limits plus provider profiles |
| `core/design.ts` | 295 | Sampled colors/type/spacing/tokens | Reuse bounded sampling ideas; return typed evidence/coverage |
| `core/emit.ts` | 180 | CSSOM parse, generic nested rules, serialization/selector lists | Rewrite around validated typed rules; retain serialization concept |
| `core/heal.ts` | 166 | Automatically edits parents/siblings when hiding | Delete automatic heuristic healing; explicit validated layout group |
| `core/identity-dom.ts` | 49 | Document-only identity adapter | Replace with root-scoped node registry |
| `core/identity-store.ts` | 47 | Selector → latest fingerprint map | Replace with snapshot-scoped target references |
| `core/identity.ts` | 272 | Structural/text fingerprint, positional twin rejection | Reuse fail-closed intent; replace full-text hashing and unverified acceptance |
| `core/inventory.ts` | 318 | Depth-6/60-region inventory, selectors, duplicate classifications | Rewrite one bounded observation path with expandable evidence |
| `core/ops/index.ts` | 168 | Unused move/remove/reorder/wrap validation | Delete unwired vocabulary; replace only with implemented capabilities |
| `core/ops/liveDom.ts` | 45 | DOM adapter for inverse application | Replace resource-specific primitives, same-node restoration |
| `core/ops/recorder.ts` | 53 | Global content transaction singleton | Replace document runtime's resource ledger keyed by group/revision |
| `core/ops/txn.ts` | 226 | Reverse structural log, cloned-node restoration | Rewrite compare-and-restore, exact IDs, no clone replacement |
| `core/perceive/dom-utils.ts` | 34 | Whole-tree deep query per lookup | Replace cached root registry and bounded query |
| `core/perceive/dynamism.ts` | 365 | Sticky/scroll/virtualization/safety heuristics | Select useful facts on demand; unknown not safe |
| `core/perceive/index.ts` | 1964 | Global walk/clustering/stamps/enrichment/tree serialization | Replace monolith; retain selected fact collectors |
| `core/perceive/media.ts` | 209 | Media metadata/distortion heuristic | Reuse measurements; distinguish object-fit crop from distortion |
| `core/perceive/semantic.ts` | 393 | Closed-role scores/grouping/composition | Retain advisory classifiers only; unknown role required |
| `core/perceive/semantics.ts` | 265 | Outline, second taxonomy, interactive summaries | Merge into semantic facts/action catalog |
| `core/perceive/spatial.ts` | 513 | Pairwise adjacency/rows/columns/density | Remove universal census; bounded optional region analysis |
| `core/perceive/surface.ts` | 520 | Colors/background/elevation/borders | Extract needed color/compositing primitives; remove mandatory global models |
| `core/perceive/typography.ts` | 212 | Text/type-ramp heuristics | Keep targeted type evidence; fix units/direction assumptions |
| `core/persist/digest.ts` | 62 | SHA-256 of content-derived fingerprint | Keep Web Crypto utility, not fingerprint-as-identity contract |
| `core/persist/index.ts` | 129 | Unversioned scope journals, merge/trim by args | Replace versioned customization revision store |
| `core/reason/extract.ts` | 81 | Bare/fenced/balanced JSON extraction | Adapt bounded one-object parser; reject ambiguity |
| `core/reason/index.ts` | 158 | Cloudflare chat transport and retries | Replace explicit protocol adapters/network client |
| `core/responsive.ts` | 312 | Fixed-pixel dominance stripping and motion rules | Delete dominance policy; reuse reduced-motion requirement in compiler |
| `core/sanitize/index.ts` | 130 | Regex CSS filtering permitting remote HTTPS URLs | Replace syntax-aware policy; no network-capable values |
| `core/sanitize/redact.ts` | 56 | Whole-string form-value/credential redaction | Replace field-level minimization before serialization |
| `entrypoints/background.ts` | 323 | Loop host, CSS tracker/replay, questions, toggle | Rewrite privilege broker and versioned storage owner |
| `entrypoints/content.ts` | 518 | Dispatch, isolated-world history patches, overlay, replay/undo | Rewrite document runtime bootstrap; no opaque full-page blocker |
| `entrypoints/popup/main.ts` | 226 | Cloudflare settings, run callback, status, arbitrary-tab fallback | Replace launcher/workspace; exact tab and truthful outcomes |
| `entrypoints/popup/index.html` | 91 | CSS/UI and unconnected opt-out checkbox | Rewrite accessible UI in implementation phase, not now |
| `shared/color.ts` | 141 | Color parsing, contrast, gradients | Preserve tested math; handle unsupported color spaces as unknown |
| `tools/index.ts` | 98 | Shared metadata/executor registry, control tools, argument hints | Replace with pure capability contracts and context-local typed dispatch |
| `tools/observe.ts` | 589 | describe/find/read/inspect/perceive tools and approximate cascade attribution | Replace with bounded observation requests; no unproven cascade winner claims |
| `tools/act.ts` | 1034 | CSS filtering/emission/effect sampling, hide/heal, text/HTML insertion, stubs | Rewrite compiler and owned transactions; remove unsafe HTML/unowned partial effects |
| `tools/verify.ts` | 413 | DOM checksum, layout/contrast/reachability checks and marker cleanup | Replace with structured revision-scoped verification and resource cleanup proof |

## 3. Current call/data flow

Popup stores Cloudflare credentials and implicitly acknowledges consent on open → background `runLoop` sends repeated model calls → registry imported by both background and content → content executes tool → CSS sends another message to background while DOM inverse stays in a global content singleton → background journal records result → background runs whole-page verification before/after acts, optionally resizes actual browser window → persisted journal stores model arguments and inverse CSS → background replays CSS and content independently replays DOM.

The registry imports `observe/act/verify`; those import DOM observation modules and the transaction singleton. Although most DOM access occurs at call time, metadata imports pull page-execution responsibilities into the background dependency graph. Observation modules also import types from their aggregate `index.ts`; this is type-level coupling, not evidence of a runtime cycle. New dependency gates distinguish those cases.

## 4. Material findings

Severity: P0 blocks safe runtime; P1 blocks dependable product; P2 affects breadth/quality. Findings below follow from executed checks or inspected logic; they are not claims of a reproduced live-site exploit.

| ID / priority | Evidence | Consequence and architectural response |
|---|---|---|
| F01 P0 | No tests present; test command accepts zero unit tests before failing browser launch | Restore mechanical baseline and require nonzero expected test inventory |
| F02 P0 | No run/document/operation IDs in `toolCall`; no per-tab run exclusion; timeout only resolves a Promise | Late tool execution can mutate after caller gives up; document fencing, resource receipts and local cancellation required |
| F03 P0 | CSS inserted before a returned inverse; `applyCss` drops insert error resource information; DOM records occur after mutation/await | Partially applied work may be unowned; prepare resource journal before every side effect |
| F04 P0 | `dispatchInverse` swallows CSS errors; missing DOM reply counts as success; global undoAll spans runs | False clean rollback and erasure of prior work; exact resource IDs and acknowledged rollback reports |
| F05 P0 | `verifiedClean` survives subsequent verifier errors; recovery treats absent post-check data as empty failure lists | Previously clean state can bless a new unverified state; verification bound to exact revision/epoch |
| F06 P0 | `cloneNode(true)` then replace original in text undo | Markup restoration loses original listener/node identity; mutate/restores exact text nodes, never replace native controls with clones |
| F07 P0 | Regex HTML sanitizer then `innerHTML`; CSS allows arbitrary HTTPS URLs; trust-boundary arguments widely `any` | Injection/exfiltration surface; structured nodes and syntax-aware CSS policy plus runtime schema validation |
| F08 P1 | Fixed Cloudflare URL/account auth; GLM name regex; model string override only | Not provider-agnostic; explicit protocol adapters and user-configured profiles |
| F09 P1 | Long fetch in service worker, no restartable run state; empty onConnect listener | Slow-call completion not guaranteed by MV3; visible workspace owns inference |
| F10 P1 | Journal serializes oldest-first until 8k, then says “older entries omitted” | Newest failures/actions disappear; recent evidence window and accepted-state summary |
| F11 P1 | `perceivePage` serialization not handled by journal result serializer; `findElements` hides non-inventory live matches | Paid observation can arrive as “ok” or “0 matches”; one explicit evidence contract |
| F12 P1 | Full perception walk permits 6s; enrichment outside that budget; repeated global queries and O(C²) adjacency | Time cap not whole-operation bound; chunked collection and bounded enrichment |
| F13 P1 | Serialization demotion tests `isFull && !tier1.has(...)` though isFull derives from tier1 | Claimed 24k ceiling is not enforced; omitted-parent tree walk can omit descendants; explicit coverage/paging |
| F14 P1 | CSS selector guard keeps unobserved/broad/dormant selectors; CSS mismatch replay now reports but leaves sheet | Fingerprint safety claims do not apply to arbitrary styles; separate observed sets and explicit future-match policy |
| F15 P1 | History patched in isolated world; no ongoing same-route mutation reconciler; route replay does not undo prior text effects | Dynamic continuity incomplete; broker navigation events plus local epoch/dirty-root model |
| F16 P1 | CSS tracker/legacy journal/global txn/toggleState each model live state differently; tracker rehydrates asynchronously | Toggle, remove, restart and replay can disagree; one resource owner and hydration barrier |
| F17 P1 | `ok = status !== error`; popup prints ✓ for gaveUp/budgetExhausted | Failure can display success; exhaustive outcome projection |
| F18 P1 | Popup chooses first HTTP-like tab when active tab is invalid; consent set merely opening UI; optOutModel never read | Wrong-tab risk and misleading permission UX; explicit pinned target and acknowledged consent |
| F19 P1 | Window resizing/activation in production loop; overlay intercepts page input without Stop | Request can disrupt workspace for minutes; nonblocking status, local cancel, responsive tests only in QA |
| F20 P1 | `bindKey`, `recomposePage`, `measure` stubs | Product is mostly styling/text insertion; typed behavior and linked projection modules required |
| F21 P2 | Two classifiers/selectors; geometric “fixed” authored-width inference from computed pixels; cached role depends on mutable clustering | Observation facts and inference conflated; one target registry, advisory roles with invalidation |
| F22 P2 | Comma splitting differs across emitter/filter; whole-rule !important and nested-rule escalation differ | Selector syntax/cascade correctness cannot be handwaved; canonical parsed representation |
| F23 P2 | Contrast alpha not composited consistently; “allIssues” omits some categories; full-page probes write DOM repeatedly | Incomplete metrics used as truth; structured checks with coverage and explicit unknown |
| F24 P1 | Goal/path/model-authored content persisted; disclosure promises no server content storage | Privacy claim exceeds guarantees; explicit provider retention limits and content-aware storage policy |

## 5. Strengths worth preserving

- Native DOM/CSS execution and the intent/execute distinction match the product.
- Tool failure messages often identify actionable recovery, not only errors.
- Exact CSS bytes are retained for removal; Web Crypto used rather than a dependency.
- Baseline-relative verification acknowledges websites already have defects.
- Attempts to preserve verified work after model failure are directionally right.
- Typed pure helpers permit fast tests once fixtures are restored.
- Sampled design evidence is a useful common path; it should replace, not coexist indefinitely with, competing universal perception systems.

## 6. Legacy documentation status

`docs/ARCHITECTURE.md`, `docs/TOOLS.md`, and `docs/TESTING.md` are **superseded by `plan/`**. They mix prior experiments, outdated constants (60s versus current 120s call timeout), absent suites, incorrect CSS origin claims, clone-as-exact-undo claims, and provider-agnostic assertions not supported by transport code. Their historical benchmark numbers are **unverified** until underlying artifacts are recovered. They were not edited in this task; agents must not use them as current contracts. [Migration/deletion](19-migration-and-deletion.md) specifies replacement timing.

All architectural recommendations are proposals. Static risk findings should become executable regression fixtures before implementation claims a fix. See [test matrix](21-test-matrix.md).

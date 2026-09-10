# Testing architecture and execution order

**Proposed test system.** Purpose: establish independent proofs of runtime safety, product fidelity and model quality. Current `npm test` runs zero unit tests then fails because browser runner is absent; see [audit](01-repository-audit.md). Tests described here are future work, not passing existing assets.

## 1. Test stack and files

Retain Node built-in test runner for pure contracts/policies and one Playwright extension harness for real-browser integration. Use already installed axe-core for accessible owned UI. Do not create a second browser test framework. Standardize the exact commands in foundation task S0; proposed stable interface:

| Command from `project/` | Purpose | Expected run class |
|---|---|---|
| `npm run test:unit` | Pure decoders, target predicates, budgets, context, compiler policy, record/version logic | No browser/network, <10s initial target |
| `npm run test:browser` | Built-extension component/integration/E2E using local fixtures/mock provider | Deterministic, <90s core target |
| `npm test` | Unit + core browser suites; fails if inventory missing/zero | No paid provider or external site |
| `npm run test:stress` | Mutation/route/toggle/long-session cases | Scheduled/pre-release |
| `npm run test:perf` | Recorded reference environment distributions | Isolated, no concurrent browser jobs |
| `npm run bench` | Opt-in actual model quality comparison, explicit profile/cost limits | Never default CI/release mechanics gate |

These script names other than current commands do **not exist yet**. Implementation phase must add them and matching actual files/configuration, not documentation alone. Existing typecheck/lint/build/audits remain until deliberately migrated. Browser harness builds once from exact source SHA; never test stale `.output`.

Suggested fixtures under future `project/tests/fixtures/`: static article; cards/feed; nested flex/grid; native forms/media; keyboard/IME/modal; open/opaque shadow; iframe; SPA history/query/hash; virtualized recycled list; adversarial CSS/markup; huge DOM; fake provider. Fixture behavior is explicit; no hidden imports of production source into page that bypass real extension execution.

## 2. Test layers

### Pure unit

Schemas/bounds/unknown fields; ordered proposal and local-node reference validation (no DAG); operation claim conflict; target predicate logic; JSON extraction ambiguity; CSS AST unsafe values and serialization rules; budget/request/retry arithmetic with fake clock; structured issue diff; revision merge/conflict/quarantine; outcome-to-UI mapping; privacy field filtering; alpha/contrast vectors. Test real modules, stub only browser/network/clock boundary where not under test.

### Browser component

Real CSSOM/USER cascade, open-root author sheet fallback, direct native Text restoration, generic insertUI local refs/native controls/valid placement, target token disarming, actual getComputedStyle/viewport behavior, keyboard composed paths, and later owned Canvas 2D drawing/resize/disposal. Exercise micro-details and intentional CSS motion through the same style compiler, not a separate motion framework. No fake DOM can prove CSS cascade or node listener preservation. `getComputedStyle` from detached probes is not assumed equal to attached computed rendering.

### Integration

Workspace→broker→runtime→broker style API→verification→store. Test message schema/sender/document fencing, failed acknowledgement reconciliation, browser API errors and worker termination. Fault injection through development test boundary at **external adapters only**, not a second implementation of transactions. Force content port loss and actual SW restart in Playwright where supported; record manual case if browser automation cannot prove it, not green skip.

### End-to-end

Set provider profile with local mock server; explicit consent; select correct tab; submit request; obtain accepted revision; save; refine; undo; disable; reload; enable; remove. Repeat with workspace tab/sidepanel, different target tabs, model output profiles and closed workspace. Test errors and messages the actual user sees, not hidden test DOM only.

### Security/failure/recovery

Malicious JSON/CSS/content; prompt injection; spoofed tab/frame IDs; redirect/credentials; missing verifier; failure before and after every resource step; partial undo; store quota/corrupt record; route navigation while model/body/style pending; cancellation during backoff; late duplicate message. Failed mutation results must leave resource ledger accurately describing reality. Add a regression fixture for each F01–F24 mechanism relevant to changed task.

## 3. Product and visual fidelity

Pure runtime suite uses deterministic provider proposals and requires no live model. Live quality suite evaluates whether selected model interprets natural language and designs convincing transformations; it does not substitute for safety tests.

Visual test dimensions: glassmorphism/neobrutalism/retro, compact/comfortable density, typography features, micro-details, hover/focus/finite motion, generic inserted panels/controls, owned Canvas 2D versus untouched native page canvas, article magazine layout, source-linked Kanban and floating player. Screenshots compare after fonts settle on controlled fixture; human review checks coherent visual result and preserved original workflow. Pixel difference is neither success nor failure alone. Compare goal-specific measurable effects and original links/media/control behavior. Report model, endpoint protocol, prompt contract and token/time budgets with each quality result.

Live external sites: opt-in, fresh profiles, no personal accounts/credentials in automated runs. Start with public documentation sites; protected/social/mail/shopping flows use local representative fixtures plus authorized manual checks, not CAPTCHA evasion. A fixture proves mechanics, not universal live-site support. Feature claims must name both tested fixtures and manual site coverage.

## 4. Dynamic, responsive and long-running tests

- Viewports: 360, 480, 768, 1280, 1920 CSS px; choose at least narrow/current/wide per layout case. Do not force all combinations after each pure change.
- Browser page zoom: 80%, 100%, 125%, 200% with a method that actually changes page zoom; deviceScaleFactor alone is not page zoom. Record measured CSS viewport and DPR. Text zoom/accessibility and RTL included.
- Reduced motion, dark/light preference, focus-visible, expanded/collapsed states, sticky headers and inner scroll containers.
- Mutation: 100 additions/removals/sec for 10s, 1,000 recycled item replacements, mutation during preview, newly attached open root, delayed fonts/images.
- 100 on/off cycles, 100 SPA route changes, repeated refinement/reload and 30-minute active customization soak. No resource growth or background model calls.
- Pressure: exceed node/response/queue/ledger/storage caps deliberately. Expected result is explicit partial/denied/unsaved, never hang or silent truncation.

## 5. Model/provider matrix

Use mock outputs representing:

1. Strong one-shot valid full proposal.
2. Weak minimal valid proposal.
3. Weak extra prose/outer fence handled under declared parser contract.
4. Invalid schema, invented target, unsupported operation and multiple JSON objects.
5. Endless/repeated evidence request (budget stops it).
6. Delayed headers, delayed body, stream disconnect, token truncation.
7. 401/403/model-not-found/429/503/context limit/unsupported parameter.
8. Different API protocol and custom local model ID without build.

All profiles must leave the runtime in valid state; only quality/completion differs. Same frozen request/evidence compares models fairly. Live variability is evaluated separately with repeated runs; no guarantee of 100% semantic success across arbitrary weak models.

## 6. Test execution order

| Change/gate | Required tests | Not required every time |
|---|---|---|
| Before first implementation | Record typecheck/lint/test baseline; verify test inventory and source SHA | Paid model calls |
| Pure contract/helper | Relevant unit + typecheck + dependency direction | Full visual matrix |
| Runtime operation/identity | Relevant units + local browser component + failure/undo cases | All live websites |
| Broker/storage/lifecycle | Core E2E + restart/late message/quota tests + type/lint/build | Aesthetic benchmark |
| Provider/controller | Adapter/mock matrix + no-effect malformed cases + Stop | Paid model comparison unless quality claim changes |
| Subsystem completion | All subsystem matrix rows + core E2E + accessibility | 30-minute soak for unrelated pure formatting |
| Before runtime migration | Full deterministic suite + legacy quarantine + clean-profile replay | Uncontrolled personal profile |
| After runtime migration | Built-extension end-to-end at min/current Chrome, no legacy runtime imports | Historical absent test claims |
| Phase completion | Required matrix rows and acceptance IDs, docs/link/import checks | Checkbox completion based on prose review alone |
| Before release | All P0/P1, applicable P2, security corpus, min/current/Edge, perf, stress/soak, manual product quality | Unsupported-browser pass claims |

## 7. Failure signals and proof quality

Test runner must fail on zero discovered expected tests, missing fixtures, unbuilt/stale extension, no target content runtime, missing browser or skipped mandatory assertions. Keep known failing regression separate and explicit until fixed; never invert assertion to green without requirement/ADR review.

Every safety test must have a negative control proving assertion detects the bug (e.g. clone-replace loses listener; missing verification yields unknown; stale document op rejected). This does not require mutation-testing framework: a small adversarial fixture is sufficient. Screenshot equality alone does not establish listener/focus/form/media preservation. Use node reference, event count, control state and resource ownership assertions.

Evidence for completion: command, cwd, source/commit, environment, test count, pass/fail, artifact path, residual manual checks. Screenshots/logs contain no private content unless explicitly consented. One future `plan/progress.md` log stores concise result summaries, not a report hierarchy or large raw captures. [Protocol](24-implementation-protocol.md) defines checkpoint rules.

# Performance architecture and measurement budgets

**Proposed targets, not measured current performance.** Purpose: prioritize latency and page responsiveness without hiding partial coverage or weakening safety. Actual baseline is in [audit](01-repository-audit.md); current tests are missing. Targets must be measured on a recorded reference environment before release, and adjusted only with evidence/ADR where product impact changes.

## 1. Critical paths

1. User submit → usable local status and fresh evidence.
2. First provider response → validated visible preview.
3. Preview → required verification → accepted/save acknowledgement.
4. Same-route page mutation → new matching content customized.
5. Stop/disable → no further active effects.

Provider latency is measured separately from extension CPU/IPC/layout latency. Report p50/p95 and worst case; one fast model run does not prove runtime performance. No global performance claims based on old comments claiming 4–30ms observation.

## 2. Initial budgets

| Resource / operation | Proposed budget | Exhaustion behavior |
|---|---:|---|
| Immediate workspace feedback | <100ms p95 | Local UI state; never wait for model acknowledgement |
| Initial evidence on ≤2k-node fixture | ≤100ms p95 total runtime work | Partial snapshot + cursor, no long blocking traversal |
| Cooperative main-thread slice | ≤4ms target; no Revueon-owned task >50ms | Yield and continue; record longest slice/long task |
| Initial evidence sent | ≤12 KiB | Drop optional old/sample fields, retain structure/refs/coverage |
| Provider normalized response | ≤128 KiB; max nesting 32 | Reject oversized/incomplete, never execute truncated prefix |
| Proposal | One ordered batch, ≤64 operations; no nested groups/DAG | Ask split into explicit subsequent revision |
| Single CSS group | ≤32 KiB, ≤256 rules, ≤2,048 declarations | Reject with size diagnostic; no silent truncation |
| Active document effects | ≤64 logical style fragments, ≤2,000 target members, ≤20 bindings | Reject new resources before losing old inverses |
| Physical stylesheet composition | 1 accepted + at most 1 staged bundle/root; ≤256 KiB aggregate/document | Block further replacement while cleanup unknown; reject oversized composition |
| Local accepted effect + verification | ≤200ms p95 excluding deliberate transition wait/API scheduling | Narrow scope or explicit unknown; instrument actual bottleneck |
| Unrelated page transition settle | 2 rAF then bounded 500ms maximum wait | Unsettled mandatory measurement → unknown/rollback |
| Explicitly authored finite motion verification | ≤2s endpoint observation inside the 5s local transaction deadline | Longer motion must use a supported nonblocking style test or be reported unverified; no endless wait |
| Mutation debounce | 100ms quiet, 500ms max wait; work sliced | Partial reconciliation and suspended conflict groups |
| Dynamic fixture continuity | ≤750ms p95 after target arrives on responsive visible page | Waiting/partial metrics; no provider call |
| Resize checks | ≤4/sec, affected groups only | Coalesce; no layout mutation in callback |
| Provider calls | ≤4 responses/run, ≤6 total HTTP attempts/run | Stop with accepted partial/failed state |
| HTTP timeout | 45s default; 15–180s configurable | Abort headers/body/backoff under shared deadline |
| Active run | 120s default; ≤300s configurable | No new planning work; provisional rollback, accepted kept |
| Stop responsiveness | ≤100ms local flag/revocation target | API cleanup may remain pending and is reported |
| Disable visible effects | ≤250ms p95 local, ≤1s acknowledged cleanup fixture target | Disarm first; unresolved receipt conflict shown |
| Resource ledger | ≤8 MiB estimated retained data/document, no full DOM clones | Reject new group; do not evict live inverse |
| Diagnostic ring | ≤200 entries/document and ≤256 KiB/workspace | Drop oldest diagnostics, preserve aggregate counters |
| Projection rendering | ≤200 visible items | Paginate; show coverage rather than invent unloaded rows |
| Generic owned UI | ≤200 nodes, depth≤12, ≤16 KiB text/batch | Reject oversized tree before inserting |
| Owned Canvas 2D | ≤256 draw records, ≤2,048 polyline points, ≤1M backing pixels/canvas and ≤2M/document | Explicit lower resolution or accessible unavailable fallback; no drawing truncation |
| Saved customization/origin/total | 256 KiB / 2 MiB / 6 MiB | Applied-unsaved + management controls |

These are centralized engineering defaults, not separate user-visible configuration systems for every number. Expose provider timeout/context/cost controls and user scope; keep implementation budgets internal unless a measured user need warrants a setting. Timers/deadlines cannot make a frozen browser execute. Above latency targets apply to visible responsive reference fixtures; on suspension, state correctness takes priority and expiry is checked before reactivation.

## 3. CPU/DOM strategy

- Walk once per requested scope; collect primitive facts in one pass; reuse style reads within that pass.
- No repeated full `querySelectorAll('*')` per cluster, whole-document outerHTML checksums, per-leaf DOM probe insertion, universal O(C²) adjacency or duplicated semantic model generation.
- Batch layout reads before local writes; verify after bounded render settle. Use native CSS responsive layout, not JS resize geometry reconstruction.
- Cache only identity-independent immutable compiled resources or epoch-bound measurements. Never cache target safety across DOM replacement or persist a role forever because a hash stayed the same.
- No full-page MutationObserver processing when no customization needs continuity. When enabled, callbacks collect dirty roots; work is bounded and deduplicated.
- No workers initially: DOM is main-thread-only; moving small pure transforms to a worker adds transport cost. Add worker only if profiling proves an isolated pure workload exceeds slice budget, not to hide the six-second walk.
- No model calls for replay, mutations, resize, toggle, undo or health polling. Provider call count is a product metric, not a proxy for effort.

## 4. Memory and lifecycle

Retain exact old Text values only for changed nodes, not ancestors' innerHTML. Owned UI host refs and direct native-node refs are released on acknowledged cleanup or document destruction. WeakMaps do not excuse a separate strong Map retaining every removed element. Root registries drop detached roots. Event listeners, observer callbacks and timers must have explicit owner/dispose paths. Test 100 toggle cycles, 100 route changes, 1,000 incremental item replacements and a 30-minute session.

Memory acceptance: active resource counts return to zero/baseline after disable; post-GC retained heap growth after 100 stable cycles ≤10% or 2 MiB above warmed baseline (whichever larger), with retained-object inspection if exceeded. Browser heap measurement is noisy; record method/GC availability and do not label unknown measurements pass.

## 5. Benchmark protocol

Reference machine record: CPU/RAM/OS/power mode, browser version, Node/toolchain, fixture commit, viewport, extensions/profile state. Initial deterministic fixtures at 2k, 10k and 50k DOM nodes (50k must report bounded partial coverage). Measure 30 warm runs after 5 warmups, plus cold-load separately. Keep screenshots out of timed runtime sections. No concurrent build/browser/performance jobs against same workspace.

Use browser Performance APIs, targeted marks, long-task observer where available, message/resource counters and Playwright timing. Record model headers/body/total, retry wait, input/output bytes and provider usage separately. A p95 budget regression >20% or any new >50ms extension-owned long task blocks phase completion until explained/fixed; don't remove checks to meet budgets.

Quality comparisons: frozen evidence + same goals + same runtime across models, then live-site browser checks for interaction fidelity. Controlled identical prompt comparisons are primary; variants measure wording robustness separately. Visual complexity (blur/filter/shadows) can tax GPU even without JS; measure scrolling/frame smoothness in glassmorphism fixtures and respect reduced motion. No dependency on a vision model for mechanical acceptance.

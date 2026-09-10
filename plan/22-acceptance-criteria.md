# Measurable acceptance criteria

**Proposed release gates, not current passing results.** Purpose: define what counts as completion. All applicable mandatory criteria must be evidenced in [roadmap](25-roadmap.md). Performance values use the recorded fixture/reference methodology in [performance](15-performance.md), not uncontrolled public-site latency. Browser impossibilities are explicit unsupported outcomes, not falsified pass claims.

## AC-01 — Foundation and architectural conformance (P0)

- Exact current build passes typecheck, lint, dependency-direction test and nonzero expected unit/browser inventory.
- Deliberately forbidden runtime→provider and broker→DOM imports fail the gate; type-only references handled correctly.
- No old and new content writers coexist. WXT entrypoints instantiate modules once and expose validated protocol only.
- All current significant source files have preserve/replace/delete mapping; legacy docs cannot override plan.
- Tests T01/T02/T29 pass; baseline issues are fixed in implementation, not retroactively marked passing here.

## AC-02 — Observation and target identity (P0/P1)

- Frozen fixture produces stable logical region order and semantic facts; unknown/missing data explicitly labeled.
- 2k-node initial scan meets ≤100ms p95 local-work target; larger scans return bounded partial coverage and expandable cursor.
- Stale document/route, duplicate ID, replaced native node, ambiguous root hop and positional twin all refuse single-target mutation.
- Future-set enrollment matches explicit approved predicates and reports membership caps; no shared visual clustering used as identity.
- No raw form/editor secrets in evidence; T03–T06 pass.

## AC-03 — Safe expressiveness and verification (P0/P1)

- Style/hide/collapse/float/text/insertUI capabilities have exact ownership and target-scoped postconditions; validate every operation before activating the single batch. No optional subgroup/DAG executor.
- Generic insertUI creates containers/cards/panels/native local controls at validated before/after/inside positions; later operations style/bind declared local refs in the same batch. T31 covers placement, nesting, accessibility, rollback and replay.
- Browser-supported visual typography/spacing/background/layout/micro-detail declarations use one parser+policy path, not an incomplete handwritten property catalog. CSS motion respects explicit request, reduced motion, performance and correct start/end verification.
- Compiler supports documented nested conditions, per-declaration priority and separate keyframes without selector corruption; no unsafe URL request/selector escape in T07.
- Missing/failed/stale mandatory verifier never accepts a group, even after prior clean revision. One local recheck then rollback is tested.
- Already-satisfied intended property is accepted as satisfied; arbitrary visible change does not satisfy unrelated request.
- New protected-control disappearance, >2px introduced horizontal overflow, mandatory focus/contrast failure in supported fixture or combined-customization failure rolls back provisional state.
- T07/T08/T13/T22/T30 pass; aesthetic feedback remains separate.

## AC-04 — Reversal, cancellation and truthful cleanup (P0)

- Each inverse exists before its side effect. Injected crash at every resource step leaves precise prepared/applied/unknown records.
- Same native node and its attached listener survive text change and undo. No clone/innerHTML restore of native content.
- Stop revokes local future effects ≤100ms target on visible responsive fixture; late CSS ack cannot reactivate cancelled namespace.
- Disable removes owned active effects ≤250ms p95 local target; all cleanup receipts known within ≤1s fixture target or explicit conflict state.
- New site writes are preserved by compare-and-restore. Accepted older customization survives failed refinement/model outage. Site text A→accepted B→accepted C→disable restores A; failed C restores B; second-operation failure accepts no early part of the candidate batch.
- T08/T09/T14/T18/T30 pass; no terminal text claims clean restoration with unresolved resource.

## AC-05 — Model independence and bounded planning (P1)

- User selects/adds model ID+endpoint under supported protocol without rebuild/source change; OpenAI-chat, Anthropic and local compatible profiles tested.
- Strong, weak, plain-text/no-JSON-mode, malformed, slow and refusing mock providers all preserve runtime invariants; quality/completion may differ.
- Default simple style request uses one planning response when supplied a valid proposal; no model call just for done/verify/replay/undo.
- At most 4 model responses and 6 actual HTTP attempts/run; deadlines cover headers/body/backoff; cancellation aborts all locally controllable network work.
- Unsupported optional parameter downgraded only on specific evidence; no hidden model/provider substitution.
- T02/T19/T20 pass. Live-model benchmark scores do not substitute for these deterministic guarantees.

## AC-06 — Persistence, replay and composition (P1)

- Apply→save→refine→reload yields canonical latest accepted intent without accumulating old sheets or duplicate widgets/listeners. Refining an earlier customization preserves its explicit cascade order through canonical per-root aggregate composition; at most accepted+staged physical bundle/root.
- Enabled/saved/live are separate states. Quota/interruption gives applied-unsaved, not saved success.
- Origin/path/prefix/discriminator scope honored through SPA, query/hash changes and A→B→A; out-of-scope tokens removed before new activation.
- Two concurrent origin writers do not lose updates: expected-revision conflict or confirmed mutationId.
- Replay resolves targets fresh and uses same runtime validators/inverses/verifier; no model call or replayed native click.
- Legacy records quarantined, unknown versions not executed; disable/remove persists and survives reload.
- T10/T11/T12/T26/T30 pass.

## AC-07 — Security and privacy (P0)

- Page permission and provider disclosure are explicit and endpoint-specific; popup opening grants nothing.
- Secrets absent from content messages, bundle, diagnostics and exports; local/session storage access restricted to trusted contexts.
- Malicious model strings cannot execute scripts/HTML/network-valued CSS or alter unauthorized targets.
- Redirect/HTTP LAN/page-selected endpoint/unknown sender/forged document tests deny privilege.
- Model opt-out actually prevents fetch while saved deterministic customization functions remain usable.
- Stored annotations/labels/paths receive content-aware disclosure; provider retention claims are honest.
- T04/T07/T21/T25/T26 pass with sentinel scans.

## AC-08 — Performance and long-session reliability (P1)

- No Revueon-owned >50ms long task on reference fixtures; cooperative slice target ≤4ms, measured separately from site callbacks.
- Runtime acceptance work ≤200ms p95 excluding explicit settle/API latency; mutation continuity ≤750ms p95 on responsive visible fixture.
- No idle polling/model calls when no active customization; zero model calls during all replay/mutation/resize/toggle tests.
- At caps, report partial/reject/unsaved; do not evict live inverses or silently truncate execution.
- 100 toggles/routes and 30-minute soak release resources; retained heap growth after stable cycles ≤10% or 2 MiB above warmed baseline (larger bound), measured method recorded.
- T03/T20/T23/T24 pass and raw benchmark distributions attached to future evidence.

## AC-09 — User experience and controllability (P1)

- Keyboard-only operation of target/profile selection, consent, Start/Stop, approval, disable/remove/undo; owned UI passes applicable axe checks and manual focus review.
- No arbitrary-tab fallback, full-page blocker or real browser-window resize.
- Exhaustive rendering distinguishes saved/unsaved/partial/waiting/unknown/conflicted; fake model success cannot override receipts.
- Workspace closure cancels unfinished planning/provisional changes and leaves accepted local work manageable on reopening.
- Questions/approvals are snapshot-bound; expiry never authorizes guessing.
- T14/T15/T21/T27 pass.

## AC-10 — Browser/runtime compatibility (P1/P2)

- Built extension passes relevant matrix on minimum proposed Chrome 120 and current stable; Edge current stable before claiming Edge support.
- Document-targeted CSS, worker restart, BFCache, dynamic registration, root styles and actual zoom tested or explicitly block the capability.
- 360–1920 CSS px fixture layouts, 80/125/200% zoom, RTL, reduced motion and inner scrolling remain functional.
- Unsupported closed roots/system pages/frame permissions are honest refusals, not silent “success.”
- T06/T22/T29 pass for advertised support. No Firefox/Safari claim before separate gate.

## AC-11 — Behavior and keyboard workflows (P2)

- Declarative bindings/local rules install/uninstall/replay without duplicate listeners; IME/editables/modal/reserved-key conflicts respected.
- No automatic consequential generic activation. Native activation occurs only from approved trusted gesture; external effects explicitly non-reversible.
- New comment instance collapse occurs once; user later expansion is retained; disabling does not fight user state.
- T15/T16 pass; registry stubs do not count as implementation.

## AC-12 — Product breadth and visual quality (P2)

- Demonstrate all requested families: hide/filter, color/background/spacing/typography, generic owned element creation/insertion, responsive layout, motion/micro-details, shortcuts/local behavior, linked board/dashboard, floating existing controls and bounded owned Canvas 2D.
- PR board shows actual observed fields and source links; drag only changes local organization unless explicit native action chosen; source disappearance disables actions.
- Floating player preserves original node/playback and reachable controls; unsafe relocation falls back explicitly.
- Human review of named visual fixtures verifies coherent glass/neo/retro/magazine results with original content/function intact; report model-specific aesthetic scores separately.
- Every product example has implemented path, explicit bounded limitation and test evidence; no “complete product” claim with only style tests green.
- Owned Canvas 2D renders validated data with accessible fallback, capped backing resolution and resize/context-loss/cleanup handling; no canvas framework, model code or page-owned pixel mutation. T32 passes; internal arbitrary website/WebGL editing and silently fetched remote assets are not advertised.
- T17/T18/T28/T31/T32 pass, plus manual authorized representative-site records; no universal arbitrary-website guarantee.

## Release definitions

**Core preview release:** AC-01 through AC-10 for implemented capabilities; UI clearly labels behavior/projection as unavailable until their gates pass. **Vision-capable release:** additionally AC-11/12 with P2 workflows, not merely renamed CSS tools. **General availability:** relevant security/manual compatibility and soak checks completed, no open P0 or unacknowledged cleanup ambiguity; documented scope limitations remain visible.

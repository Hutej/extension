# Architectural invariants

**Normative for future implementation.** Purpose: prevent gradual architectural drift. Every invariant must be represented in code-level guards and the named tests; prompt instructions alone are insufficient. Related: [master](00-master-blueprint.md), [test matrix](21-test-matrix.md), [ADRs](18-decisions-and-alternatives.md).

| ID | Must remain true | Enforcement owner / proof |
|---|---|---|
| I01 | Models propose data; they never execute browser logic or grant privileges | contracts/runtime policy; T02/T07 |
| I02 | Supported provider/model changes require profile/adapter configuration, not runtime logic changes | provider boundary/import gate; T19 |
| I03 | One mutation owner per document, one run owner/document, no legacy/v2 coexistence | runtime/session + broker/documents; T08/T26 |
| I04 | Every page command is fenced by DocumentKey and route epoch; tab ID alone cannot authorize mutation | broker/runtime; T05/T11/T14 |
| I05 | Every effect has owner IDs and a prepared inverse/release strategy before side effects | transaction/styles; T08/T09 |
| I06 | Timeout is unknown outcome, not evidence that no mutation occurred; retry same operation ID | broker/runtime receipts; T08/T14 |
| I07 | Cancelled namespace cannot reactivate; disarm before asynchronous cleanup; never reuse cancelled namespace | runtime/styles; T14 |
| I08 | Native node identity/listeners/state are preserved; no innerHTML/clone replacement to restore native UI | runtime/content/transaction; T09/T18 |
| I09 | Restore only own resources if identity/value comparison permits; candidate rollback returns predecessor, disable returns inherited site baseline | transaction; T09/T30 |
| I10 | Cleanup conflicts and missing acknowledgements remain visible; never emit false clean status | receipts/UI; T14/T27 |
| I11 | One proposal is one ordered batch; all operations/mandatory checks pass together or candidate rolls back; missing/stale/failed verification cannot pass | verifier/state; T13/T30/T31 |
| I12 | Accepted prior work survives model/network failure and failed refinement; provisional work is not silently accepted | controller/transaction; T14/T20/T30 |
| I13 | Saved intent, live effects, evidence cache and model transcript are distinct; canonical stylesheet composition preserves explicit customization order | store/runtime/context; T10/T12/T30 |
| I14 | Replay/reconciliation use same validation/execution/undo path and never call a model or replay historical consequential actions | reconcile; T10/T11/T16 |
| I15 | A selector or hash is not single-node identity; set-target policy must be explicit and every member validated | targets; T05/T06 |
| I16 | Observation never grants safety from inferred role/confidence and never globally stamps every page node | observe/policy; T03/T05 |
| I17 | Style and equivalent named operations obey same target/risk policy; raw CSS cannot bypass hide/interaction constraints | compiler/policy; T07 |
| I18 | No unsafe HTML/code/network-valued CSS crosses model/import boundary; new UI/canvas data uses bounded validated creators; never borrow a page canvas or expose credentials | validator/provider/broker/content; T04/T07/T25/T31/T32 |
| I19 | User/provider consent is explicit, scoped and versioned; page/model fields cannot impersonate approval | permissions; T21/T25 |
| I20 | Provider retries/deadline/body size/context are bounded; no hidden stronger-model fallback | client/controller; T20 |
| I21 | Main-thread, queue, resource and storage bounds produce honest partial/refused/unsaved results, never discarded live inverses | limits/all owners; T23/T24 |
| I22 | Production never resizes/moves browser windows or blocks page interaction for an entire model run | UI/runtime/import check; T22/T27 |
| I23 | New source/native content and user actions are not overwritten during healing/replay/undo guesses | transaction/behavior; T09/T16 |
| I24 | Generic native activation is user-gesture/approval gated and external effects are not claimed reversible | behavior; T15/T16 |
| I25 | A projection is linked presentation of observed data, not cloned application UI or invented backend state | projection; T17 |
| I26 | Browser/ShadowRoot/frame capability differences are explicit; unsupported does not mean success | roots/broker; T06/T10 |
| I27 | Every shipped capability has implementation, tests, lifecycle cleanup and product traceability | metadata/import/roadmap gate; T01/T29 |
| I28 | Checkboxes change only after required test/acceptance evidence; unknown/manual skips are not passes | implementation protocol; all phase gates |

## When invariants conflict with convenience

Do not relax an invariant because a weak model emits invalid output, a live page is dynamic, a benchmark is slow or a CSS parser rejects syntax. Use documented fallback or report unsupported. If a real product requirement requires changing an invariant, create an ADR amendment with exact new guarantees, failure test, migration impact and owner decision; update this table and every linked contract before shipping.

## Review checklist for every implementation task

- Which invariants does this task touch?
- Which source boundary enforces each one?
- What negative control would fail if enforcement disappeared?
- What happens if the next await returns after cancellation/navigation?
- Does cleanup preserve website changes and report unresolved effects?
- Is any statement in UI stronger than the measured evidence?

These questions complement tests; they do not replace them.

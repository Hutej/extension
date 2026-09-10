# Core algorithms and executable-design pseudocode

**Proposed design, not implementation code.** Scope: the deterministic paths that must not be left to model judgment. Each algorithm below defines pre/postconditions, recovery and tests. Inputs/outputs refer to [data contracts](04-data-contracts.md). All loops are bounded by [limits](15-performance.md); operation scheduling uses [events](06-events-and-concurrency.md).

## A1. Bounded semantic observation

**Purpose:** expose enough meaning for planning without full-page blocking. **Input:** registered root(s), query, epoch, visit/time/output budgets. **Output:** snapshot + coverage + optional cursor. **Preconditions:** current document; permission for content categories. **Postconditions:** no website mutation; every output ref resolves to recorded evidence; omitted work reported.

```text
seed traversal with verified landmarks and root children
reserve output slots for main content, navigation, controls and below-fold regions
while traversal has nodes and budgets remain:
    check cancellation and route identity
    take next node in deterministic priority/order
    skip forbidden private/editor/script subtrees
    record declared facts; collect only requested/sampled style facts
    register exact node reference, root and predicates
    enqueue children/open roots, preserving bounded depth/work
    when slice elapsed: yield; revalidate route and dirty dependencies
coalesce repeated siblings within their verified container, retain outliers
serialize whole evidence records until output budget; never split a record
return snapshot, completed flag, omissions and epoch-bound cursor
```

**Edges/failure:** body absent → wait for readiness within local deadline; hidden document → geometry unknown; huge Text node → capped reads; mutation during snapshot → mark affected evidence stale/recollect once, not endless restart. **Complexity:** O(V + sampled style reads), V bounded; avoid descendant full-text/link recount per ancestor. **Determinism:** fixed traversal priorities, no random sampling. **Recovery:** targeted expansion/user selection. **Tests:** T03/T04/T24; prove all loops yield and truncation propagates to prompt.

Alternative full DOM census gives coverage but unbounded cost; selected bounded paging serves large sites without hiding its limits.

## A2. Resolve target intent

**Purpose:** distinguish exact node, persistent single target and repeatable set. **Input:** targetRef/descriptor, DocumentKey, epoch, allowed root/scope. **Output:** resolved node(s) or missing/ambiguous/stale/unsupported. **Preconditions:** descriptor validated. **Postconditions:** no first-match guess or cross-root escape.

```text
reject mismatched document or route
resolve each open-root host hop uniquely
if session-instance reference:
    accept only recorded connected node with required predicates unchanged
else:
    query observed anchor inside allowed root/container under candidate cap
    retain candidates satisfying every required predicate
    single: require exactly one; set: require explicit matchBounds
    if candidate cap hit: return partial-set, never single success
return resolved references with current evidence revision
```

**Edges:** duplicate IDs, identical twins, recycled list node, new node with same text, removed parent, positional selector, sensitive name cannot persist. **Complexity:** O(C×P), bounded candidates C and predicates P; browser selector evaluation also bounded by controlled generated grammar/root size. **Determinism:** exact predicate conjunction, not threshold ranking that picks a winner. **Recovery:** fresh observation or user-selected session target. **Tests:** T05/T06. Descriptor scorer alternatives are useful to rank suggestions only, never authorize effects.

## A3. Decode and validate a proposal

**Purpose:** contain malformed/hallucinated output. **Input:** bounded normalized text, capability list, snapshot refs, user grant. **Output:** candidate resource plan or diagnostics. **Preconditions:** complete response; finish reason not truncated. **Postconditions:** no mutation; complete ordered batch, required fields and target/local refs all valid.

```text
parse exactly one object (optional single outer JSON fence)
reject ambiguous multiple objects, trailing commands or partial output
validate response discriminator and field types/bounds
if proposal:
    validate 1–64 ordered operations; no nested groups or dependency fields
    validate unique insertUI local node IDs; reject forward references
    resolve observed refs or local refs declared by an earlier creator
    derive required capability/risk from operations and actual target facts
    reject missing approval; never accept a model consent field
    validate CSS/content/action structures, then compile exact resource plan
return errors grouped by field path, with allowed next action
```

**Complexity:** O(B + operations + AST), bounded bytes and operation list; no graph/topological sort. A linear brace/string scanner, not repeated scans from every opening brace. **Determinism:** same data/current target facts → same diagnostics/order. **Failure:** one shared correction budget; otherwise valid cannot-complete. **Recovery:** no broadened targeting. **Tests:** T02/T07/T19/T20.

## A4. Apply and accept one ordered batch

**Purpose:** never create unowned effects or accept unverified state. **Inputs:** resource plan, current revision, operation ID, deadline. **Outputs:** receipt and VerificationReport. **Preconditions:** permissions/targets/resource claims and ordered local refs valid. **Postconditions:** accepted complete batch or compensated/conflicted report; previous accepted revision not accidentally destroyed.

```text
enter document mutation queue
if operation ID seen: return prior receipt (reject different payload)
check document/route/cancel and reserve inverse memory
capture mandatory baseline; reject unknown baseline
record prepared resources and inverse expectations
stage inert privileged CSS; retain receipt even if RPC reply fails
after every await: check current epoch and cancellation
if delivery unknown: disarm namespace; reconcile original operation; stop activation
re-read local URL and verify route epoch; perform final target validation
in one non-awaiting local section:
    retire previous tokens; apply local writes; activate new token membership
wait boundedly for relevant rendering
verify effects + integrity for exact new revision
pass: candidate remains provisional until the entire batch and combined checks pass
before CSS revision acceptance: get broker CommitComposition metadata ack (predecessor stays)
recheck cancellation/actual route; compensate late promotion if invalid
at revision acceptance: transfer site-base inverses, record accepted receipt, retire obsolete resources
any operation fail or mandatory unknown: disarm and reverse whole candidate to predecessor values
never silently execute/accept an optional subset
leave queue; return explicit result
```

**Edges:** mutation after baseline, user focus change, pending CSS at Stop, partial native exception, request reply lost. **Complexity:** O(resources + affected members + sampled checks); network/browser API latency separate. **Determinism:** declared operation order; browser observations can differ, policy cannot. **Recovery:** A5, not whole-document innerHTML reset. **Tests:** T08/T09/T13/T14; inject failure at every await and native write.

## A5. Compare-and-restore rollback

**Purpose:** remove Revueon resources without overwriting newer website/user state. **Inputs:** batch-owned live ledger entries in creation order and restoration mode (`candidate-rollback` or `release-to-site`). **Output:** restored/already-absent/conflicted/unknown counts and pending IDs. **Preconditions:** exact ownership metadata. **Postconditions:** every entry has an explicit disposition; failed entries remain recorded.

```text
revoke active tokens, interaction listeners and provisional namespace first
for resource in reverse creation order:
    if owned node/listener already absent: mark released
    else if original native reference disconnected/replaced:
        mark conflict; never search for substitute to overwrite
    else if field current value differs from installed value:
        mark conflict; preserve newer value
    else:
        select predecessor value/anchors for candidate rollback, inherited site baseline for disable/remove
        apply selected inverse on same native reference
        verify owned effect is absent; mark released only on confirmation
    continue independent resources after failure
request exact CSS removal through broker; retain unknown receipts
return counts plus reload/retry recommendation if resources remain unresolved
```

**Edges:** native Text node replaced; original sibling missing; site removes annotation; author writes same field; broker unreachable. **Complexity:** O(resources), bounded retained data. **Determinism:** comparison/ownership rules exact; no guessed “safe enough” restore. **Recovery:** retry known pending resource once, then disable group/reload offer. Reload is user action, not forced data-loss risk. **Tests:** T09/T14/T18.

## A6. Desired-state reconciliation

**Purpose:** maintain accepted customization as page changes, without AI polling. **Inputs:** current intent, memberships, dirty dependency roots, route. **Output:** minimal add/remove/update resource delta and group state. **Preconditions:** applicable grant/scope. **Postconditions:** no duplicate UI/listeners, no replay of past activations, bounded work.

```text
coalesce dirty roots at quiet window or max-wait
select affected groups from dependency index
for each group in stable precedence order within pass budget:
    resolve descriptor fresh where dependencies changed
    missing -> waiting; ambiguous/unsupported -> suspend and release unsafe bindings
    compute eligible members minus existing owned eligible members
    release members no longer eligible via A5
    enroll new members through A4's same prepare/apply/verify primitives
    respect user per-instance behavior overrides
    repeated conflict -> suspend group; do not fight page
if work remains: schedule another bounded slice, report partial coverage
```

**Complexity:** O(dirty candidates + resource delta); worst-case full affected root bounded and reported. **Determinism:** set difference by real member/item identity. **Recovery:** user reselect/manual resume after conflict. **Tests:** T10/T11/T23/T24. Global periodic re-observation rejected for idle CPU and model cost.

## A7. Verify observable effects and integrity

**Purpose:** separate delivery, effect and safety evidence. **Inputs:** baseline, intended postconditions, actual resource set/current epoch. **Output:** structured check outcomes + coverage. **Preconditions:** current group; comparable snapshot. **Postconditions:** absent/failed measurement is never pass; issue keys do not depend on message wording.

```text
if epoch changed in a relevant dependency: return unknown(stale)
check delivery resource identities
for each requested effect:
    measure actual property/visibility/text/binding/view outcome
    already-at-target counts as satisfied, not false failure
for each protected affected target + sentinel:
    measure visibility, clipping/reachability, focus, media/form/node integrity
    compare to baseline by stable check/target/property key
    pre-existing issue is exempt only if not worsened
aggregate mandatory failures -> fail
aggregate mandatory unknown -> unknown
otherwise pass with advisory/coverage disclosures
```

Geometry tolerances: ≤2 CSS px measurement noise, no new horizontal overflow >2px on viewport/affected scroll container, critical native control reachable by keyboard, not hidden/zero-area unless authorized. New owned text contrast ≥4.5 normal/≥3 large where measurable; unsupported composites unknown. No aesthetic hard thresholds like “8px must move.” **Complexity:** bounded affected targets/sentinels × checks; no whole-page append/measure/remove probe per text leaf. **Recovery:** one local recheck after settle, then rollback provisional. **Tests:** T13/T22.

## A8. Provider request with bounded retry

**Purpose:** protect speed/cost regardless of provider. **Inputs:** validated profile, payload, absolute deadline, cancellation. **Output:** normalized text or typed error plus attempt metrics. **Preconditions:** explicit endpoint permission/disclosure. **Postconditions:** no requests after Stop/deadline; response byte cap enforced through body read.

```text
while HTTP allowance remains:
    check cancellation/deadline before request
    send adapter payload only to approved endpoint with redirect rejection
    read headers AND full body under same deadline/byte cap
    success -> validate transport envelope and finish reason; return normalized text
    specific unsupported optional parameter -> one documented downgrade if allowance
    transient error -> abortable bounded Retry-After/backoff if allowance/time
    all other failures -> return typed failure
return budget exhausted
```

**Complexity:** O(body bytes); total requests ≤6/run. **Determinism:** retry classification fixed, jitter injected/testable. **Recovery:** same model/profile only; user may choose different profile in a new run. **Tests:** T19/T20/T25.

## A9. Origin record compare-and-write

**Purpose:** avoid lost customization updates. **Input:** origin, expected revision, mutation ID, validated delta. **Output:** saved/new revision, conflict or unknown. **Precondition:** broker's single origin writer hydrated. **Postcondition:** no silent overwrite of another tab's revision.

```text
enter origin queue
load current record
if lastMutationId equals request: return saved receipt
if recordRevision differs: return conflict with current summary
construct/validate bounded next record; increment recordRevision
write one complete OriginRecord
read after uncertain response/restart to resolve lastMutationId
broadcast saved revision only after confirmation
```

**Complexity:** O(origin record bytes); low-frequency explicit saves. **Recovery:** refresh then merge disjoint customization changes or ask user for same-ID conflict. **Tests:** T12/T26. IndexedDB is the documented escalation if multi-record transactional needs emerge.

## A10. Trusted binding dispatch and projection update

**Purpose:** support workflows without script generation. **Input:** trusted event or source item delta plus installed finite behavior/view definition. **Output:** one bounded declared action or view update. **Preconditions:** active approved binding, fresh identity, not editing/IME/modal-blocked. **Postconditions:** no invented backend action and no duplicate action retries.

```text
trusted gesture -> qualify scope/key/editability -> resolve action uniquely
only then consume key; execute finite allowed steps under gesture
external side effect -> report invocation, never promise rollback
source mutation -> update owned projected fields by stable source item key
missing/ambiguous source -> disable projected action and mark stale
```

**Complexity:** O(event path + ≤4 actions), projection O(changed items) capped to 200 rendered. **Recovery:** native source reveal or unsupported action message. **Tests:** T15–T18. Relocation is a separate high-risk operation, not the default algorithm for a projection.

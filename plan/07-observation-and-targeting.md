# Semantic observation and target resolution

**Proposed.** Purpose: give models useful meaning without making model quality responsible for target safety. Replaces competing `inventory`/`perceive`/selector-store paths. [Data contracts](04-data-contracts.md) define serialized fields; [algorithms](10-core-algorithms.md) specifies execution order.

## 1. One observation pipeline, expandable detail

Initial observation runs automatically before the first provider call:

1. Enumerate document root and reachable open ShadowRoots. Record inaccessible custom-element internals as unknown, not “closed” merely because `shadowRoot` is null.
2. Walk bounded nodes in cooperative slices. Start with landmarks and visible/near-viewport semantic regions, but reserve coverage for below-fold regions. Do not spend the whole region budget on header descendants.
3. Collect author-declared tag/role, accessible name approximation, text length/sample under privacy policy, parent/root relationships, action affordances and a limited computed-style sample. Accessible name approximation is labeled; do not claim full browser accessibility-tree parity.
4. Group repeated items **inside an observed container** by structure. Never merge unrelated regions merely because they have the same color/font. Each group retains a selector-independent set descriptor, observed count and outlier refs.
5. Include sampled design context: canvas/background, type, spacing, surface, local CSS custom-property candidates and media constraints. Computed pixel widths are resolved measurements, not proof the author wrote pixel CSS.
6. Return PageSnapshot with explicit completed/omitted coverage, target IDs and bounded cursor for expansion.

Initial budget: 2,000 visited nodes, 60 output regions, ≤12 KiB evidence after privacy filtering, ≤100ms total local work with ≤4ms cooperative slices on reference fixtures. These are **proposed measurable targets**, not current benchmark facts. A 10,000-node page reports partial coverage and permits targeted expansion; never blocks six seconds to claim universality.

Observation writes no global `data-rv-c` cluster stamps. A WeakMap maps nodes to session refs; DOM token attributes are added only by accepted/provisional runtime resources, not to observe.

## 2. Evidence requests

| Request | Input | Output / constraints |
|---|---|---|
| Expand regions | snapshot cursor | Next bounded region page; stale cursor rejected |
| Inspect target | targetRef + requested fields | Current computed/style/visibility/affordance facts, same target identity or stale |
| Inspect collection | container targetRef + field names | Bounded source rows, observed field mapping, count/coverage |
| Read text | targetRef + explicit content permission | Capped text slice, no form values/editor drafts; privacy refusal remains valid |
| Discover selector | selector hypothesis within known root/container | Syntax-validated bounded matches for observation only; new target refs with unknown semantics |
| Select visually | user pointer target | Exact node ref plus ancestry alternatives; session-only if no durable anchor |

A model may suggest a selector for discovery; it cannot mutate that selector directly. No local natural-language keyword router pretends to interpret arbitrary intent. The model reasons over semantic evidence; the runtime answers concrete queries.

## 3. Identity contracts

### Single-node target

During one document lifetime prefer the exact live node registered by observation. Before use require: same root and document, connected, current expected role/type, still inside approved scope/container, and no invalidation changing the requested resource. If exact node is gone, session-instance operations fail. Stable-single replay resolves the saved anchor/relation and requires exactly one matching candidate satisfying all required predicates.

A unique selector is not proof of intended identity. Do not allow the existing `expectedFp = null → mutate unverified` path. A new unobserved node must first become evidence, or require user selection. Text is mutable content; do not include every descendant's text/attributes/depth in one universal identity hash. Sensitive labels are not safe merely hashed; a dictionary can guess low-entropy values.

### Set target

A future-set describes “all matching cards within this verified feed,” not the first element of a CSS selector. Every member is checked against observed structural/semantic predicates. Runtime assigns private namespace tokens to qualifying members; CSS only targets those tokens. DOM replacements lose tokens and must qualify afresh. Repeated templates may match many elements legitimately; no indistinguishable-twin refusal for a deliberately approved set.

For “hide engagement bait,” per-item model judgments are **not** reusable predicates. Offer either a user-visible deterministic filter over explicit text patterns selected/approved by the user, or one-time hidden current items with “new items not classified” disclosure. Automatic per-new-item model inference is off by default; adding opt-in classification later requires a separate privacy/cost ADR, not an invisible background agent.

### Root targeting

Each selector query is relative to one registered root. To reach an open shadow descendant, resolve unique hosts successively. Document selectors never cross boundaries. Root removal invalidates all descendant refs/resources. Closed roots and inaccessible frames produce capability boundaries, not broad selectors against a parent as an undisclosed approximation.

## 4. Descriptor production

Order of preference: stable observed unique ID/test attribute → unique role/name inside a stable ancestor → relation within verified stable container → user-selected session node. Exact labels can be used only with explicit content retention consent. An ID is only a candidate anchor: duplicate IDs and dynamic IDs are possible, so uniqueness and semantic predicates are checked each time.

Descriptor refinement must not learn identity from Revueon's own previous output. For a resource continued across revisions, retain its original stable descriptor and exclude fields that the resource itself changes (replacement text, owned attributes/style tokens and owned annotation children) from identity predicates. Fresh observation may describe current rendered state, but persistence cannot require transformed label B on a cold page whose original label is A. If uniqueness depended solely on a text value the operation rewrites and no independent stable anchor exists, keep that change session-only; do not erase the discriminator and pretend identity stayed proven. Recycled source-item keys still require fresh validation and are never excluded as “our style.”

Do not classify “safe” by absence of inline handlers. Browser event listeners and framework ownership are not generally enumerable. Native-control metadata is an affordance/risk signal, not a proof that reparenting is safe.

Classifiers return ranked suggestions with reasons and unknown. They never authorize hiding primary content, infer user permission, mandate reflow, or ban a style. Confidence numbers are not calibrated probabilities. Eliminate sticky role cache keyed solely by structure; invalidate inference when its role/name/container signals change.

## 5. Dynamic invalidation

Targets declare observed dependency classes: subtree membership, role/name, relevant attributes, layout, and root lifecycle. MutationObserver collects dirty subtrees; promotions to parent/root happen when an anchor or membership dependency changes. Unrelated style animations do not force a full semantic scan. A target-set index is capped; beyond it, suspend new member enrollment and report coverage.

Newly attached shadow roots on existing hosts may not trigger a light-DOM child mutation. Discover reachable roots on explicit observation, relevant host mutations and a bounded rescan while an affected active customization needs them. Do not patch `attachShadow` in MAIN world by default. Unsupported discovery latency is disclosed.

## 6. Verification versus interpretation

- Facts: 12 elements found, native button, current aria-expanded, measured clipping, property value.
- Inference: probably a comment thread, likely a virtualized list, inferred design tone.
- User intent: remove Shorts, collapse comments, turn list into board.
- Authorization: this customization may hide this selected region or install this behavior.

Keep these four categories distinct in data and UI. If required facts are unavailable, degrade to user selection or read-only projection. Do not transfer safety decisions to a stronger model.

## 7. Tests and acceptance

Fixtures: duplicate IDs, identical siblings, reordered positional nodes, virtualized recycled rows, RTL mixed-direction text, body absent, 30-level trees, hidden menus, nested open roots, dynamically attached roots, iframe placeholders, private editor/password/PII fields. Snapshot generation must be deterministic for the same frozen DOM and query, modulo opaque IDs and timestamps. Logical region ordering and descriptors must not depend on Map iteration accident or random sampling. [Matrix T03–T06](21-test-matrix.md) and [AC-02](22-acceptance-criteria.md) gate replacement.

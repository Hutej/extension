# Transformation language and deterministic runtime

**Proposed normative contract.** Scope: finite operations, compilation, effects, verification and undo. This is not arbitrary code execution or a layout solver. [Behavior](09-behavior-and-workflows.md) extends the same resource lifecycle; it does not introduce another mutation channel.

## 1. Operations

All operations reference observed targetRefs (proposal) or validated TargetDescriptors (saved revision), never arbitrary mutation selectors. Runtime reports unsupported operations before side effects. Operations contain no loops, functions, fetch URLs, eval, HTML strings, event-handler source, or model-supplied permission flags.

| Operation | Inputs and required preconditions | Observable result | Inverse / limitations |
|---|---|---|---|
| style | target element/set, ordered declarations, allowed state pseudo, optional conditions | Scoped style resources and sampled/targeted property postconditions | Remove owned sheet/tokens; preserve website CSS |
| hide | verified element/set, requested scope | Target no longer displayed; focus safely moved outside hidden region if needed | Remove owned hide resource; no physical deletion, no auto parent healing |
| collapse | target content + label, initial expanded state | Owned accessible disclosure controlling local presentation | Remove binding/UI/style; native subtree remains |
| float | existing surface, corner/edge, responsive size constraints | Same native node visually fixed/sticky with reachable controls | Remove style; overflow/stacking inability reported, no automatic reparent |
| replaceText | exact leaf Text node(s), replacement plain text, user content-change grant | Same parent/native element, text changes | Compare-and-restore original Text node value; exclude inputs/editors/scripts/style/native button labels unless specifically approved |
| insertUI | anchor + safe structured element tree; before/after/first-child/last-child placement | New owned containers, cards, controls, text or Canvas 2D with local refs for styling/binding | Remove exact owned host/resources; never replace native subtree; full contract in capability coverage |
| bindKey | chord + declared action IDs + scope + editable/modal policy | Listener installed; action invoked only on qualified trusted event | Remove exact listener; conflict detection required |
| localRule | declared trigger/predicate/action, finite state transition | Local desired behavior on eligible targets | Remove rule and its owned presentation resources; no replayed consequential action |
| projectCollection | verified source set, field mapping, view type, grouping/order | Owned list/grid/board linked to original items | Remove projection; original content remains accessible |
| relocate | exact native node, destination, placeholder strategy, explicit structural grant | Same node, new parent, preserved function measured | Reattach exact node if anchors intact; high-risk, gated late phase |

No public `remove`, `wrap`, generic `setAttribute`, arbitrary reorder, or “recomposePage(goal)” escape hatch. Add a capability only when its preconditions, inverses and tests exist. Existing unused op types are not a reason to support them.

## 2. Style representation

Each rule contains targetRef, pseudo condition (none/hover/focus-visible/focus-within/active/checked/disabled plus validated structural refinements), declaration list with **per-declaration** priority, and condition tree. Initial conditions: viewport min/max inline size, prefers-color-scheme, prefers-reduced-motion, and supports of a validated declaration. Keyframes use separate frame records and runtime-namespaced names. They are never DOM selectors. Rules can target `element`, `before` or `after`; generated pseudo selection is appended outside the `:where()` target/state wrapper because pseudo-elements cannot be placed inside it. Container queries use an explicit validated condition record when supported by the browser; do not build a second layout engine or silently flatten the condition.

Property policy permits broad visual authoring—colors, typography, borders, shadows, spacing, flex/grid, sizing, transforms, filters and necessary positioning—but forbids network-capable constructs and unrelated document controls. Syntax/size validation uses a pinned CSS AST parser plus browser support checks. Reject unsupported or unsafe declarations with property/path diagnostics. Never rewrite a color-only goal into a fixed design pack.

Rules for values:

- Reject URLs (including escaped tokens, `image-set` strings, `@import`, font sources, paint/worklet references and remote SVG) in model-authored values; no data-URI escape hatch. Existing page background images remain unless the user explicitly requests removal.
- Allow literals and safe CSS functions such as calc/min/max/clamp/gradients after AST validation. Custom properties are namespaced for Revueon by default. Overriding an observed site token is allowed only when its declared consumer scope is compatible and it passes the same value policy.
- `var()` can only refer to approved typed Revueon tokens or observed safe site tokens; unknown inherited token contents that can introduce network-valued properties are rejected or resolved to a safe literal. Do not treat custom properties as an unvalidated second language.
- No global reset (`all`) on website nodes; no hiding/focus removal through CSS outside explicitly approved targets. High-impact opacity/visibility/display/pointer-events/position rules use the same risk policy as equivalent named operations.
- Do not strip fixed pixels based on a ratio of signals. A 48px toolbar or a fixed mini-player is valid. Use bounds/overflow/focus checks and responsive constraints. Layout animation defaults disallowed; transform/opacity recommended. Reduced-motion counterpart is mandatory for extension-authored motion.

## 3. Compiler and CSS ownership

Pipeline: decode → capability check → target resolution → dependency/risk analysis → CSS AST/value policy → resource plan → preview → transaction. Compiler outputs resource-specific byte strings, not a model tool call transcript.

For document roots, use broker `chrome.scripting.insertCSS` with **USER origin and explicit scoped important declarations** where override is intended. User normal loses to author normal; there is no trial normal→whole-sheet escalation loop. Preserve per-declaration flags and nested conditions. Keyframe declarations are never important. Transitions can outrank important values, so verification waits boundedly and reports unsettled state rather than blindly escalating.

Rules target unique runtime token membership, with consistent generated selector specificity. A rule can target descendants only through an observed approved target set; model selectors cannot escape scope using combinators, `:has`, `:is`, commas or pseudo-elements. Compiler—not model—builds selectors. Generated pseudo-elements belong only to an approved annotated/decorative surface and cannot replace meaningful text. CSS URL-free policy is rechecked at broker boundary.

Open ShadowRoot sheets are locally owned constructable stylesheets where supported, otherwise an owned style node inside that root. These are AUTHOR-origin and may lose to author-important layers/inline rules. Never claim parity with USER origin. If a required declaration cannot win, offer a narrow tracked inline override for an approved property or report unsupported; fallback changes resource type only after policy validation. Do not inject document CSS and assume it reaches shadow descendants.

Every insertion/removal uses exact bytes and DocumentKey. Generated namespace includes a persisted non-secret installation ID plus customization/revision/group/document instance; it is not a content fingerprint. Cancelled/replaced namespaces are not reused. On reinjection after extension update, strip only tokens carrying this installation's old runtime namespace before v2 activation; if prior ownership cannot be identified, require a clean reload instead of guessing. Style resources are staged inert, preventing a late broker message from affecting a new route or cancelled group.

### Deterministic composition across customizations

Keep one **accepted aggregate stylesheet per root**, compiled from the current logical group fragments in explicit customization order, then operation order. Normalize generated target/state selector specificity with `:where()`; append an allowed `::before`/`::after` outside it. Rules competing for the same element/pseudo surface have consistent specificity, and no model selector contributes extra specificity. This prevents a refined earlier customization from winning merely because its sheet was inserted later. Important declarations use the documented uniform policy; no layer reordering trick.

A replacement stages a candidate aggregate containing unchanged accepted fragments plus candidate fragments in canonical order. Unchanged fragments may be duplicated physically during staging but have identical values/order; only candidate namespaces are inert. Retire the replaced revision's tokens when activating its candidate. After combined verification passes, broker removes the previous aggregate; candidate becomes accepted. On failure disarm candidate, restore valid predecessor tokens/local values, remove candidate aggregate. There are at most two physical bundles per root (accepted and staged), although up to 64 logical style fragments are budgeted. Disable disarms the customization first, then rebuilds the aggregate without it; it never removes a different customization's identical fragment. Unknown bundle cleanup blocks further replacements until reconciliation, avoiding unbounded sheet accumulation. Open-root local styles follow the same composition order, with their documented AUTHOR-origin limitation.

## 4. Transaction algorithm and revision replacement

1. Resolve all required targets and dependencies. Determine exact resource claims and conflict report.
2. Capture baseline of existing targets, sentinel controls, focus, native-node identities and region integrity. A newly owned insertUI node has baseline `absent`, not an invented pre-insertion geometry; verify its placement/style/drawing after insertion and compare protected site targets to their real baseline. If another mandatory baseline cannot be measured, stop before activating.
3. Prepare all inverse records and budget reservations. Existing accepted revision is still intact.
4. Stage inert CSS via broker. Check operation receipt and current epoch after every await. On failure remove staged resources; no active effect.
5. In one synchronous local mutation section: retire prior revision's active tokens, perform permitted native writes and activate new visual tokens. Prepare new behavior listeners disarmed; arm them only on accepted revision, not during preview. Verify installation without invoking site actions. Do not await between final identity check and writes. Layout is settled afterward.
6. Verify new revision against intended postconditions and the comparable baseline. If mandatory fail/unknown, disarm new tokens/listeners first; reverse new local writes; reactivate prior revision after its own validity check.
7. One proposal is one ordered batch and one revision. All its operations and mandatory checks must succeed before acceptance. Any operation failure rolls back the entire candidate; there are no optional subgroups or dependency DAG. A useful smaller result requires an explicit smaller proposal, not silent filtering. Earlier accepted customizations are unaffected.
8. For broker-delivered CSS, acknowledge CommitComposition session metadata before publishing acceptance; broker retains predecessor bundle until runtime explicitly releases it. Recheck local route/cancellation after that await. Failure/late promotion rolls candidate back using same operation ID. Then transfer underlying-site inverse ownership from predecessor resources to replacement resources and record accepted receipt, release obsolete prior resources while retaining previous *saved intent* for user undo, and tell workspace success. Failed predecessor cleanup is reported/retained and blocks another bundle replacement.
9. Save canonical validated intent. Rejected proposals and temporary auto-corrections do not accumulate in persistence.

Atomicity is logical and compensating, not a claim that DOM plus extension APIs plus storage form a transaction. A brief preview can be visible during verification; UI labels it preview. Hard failure always disables new interactive bindings first.

## 5. Resource ledger and reversal

Each resource has owner IDs, preparedAt, appliedAt?, underlying-site inverse, predecessor rollback value/anchors when replacing, expectedInstalledValue, state and lastError. These are two different restoration goals: **failed candidate rollback restores the predecessor's effective value**, while **disable/remove restores the underlying site's original value** if compare-and-restore permits. For example, site text A → accepted B → candidate C: failed C returns B; accepted C then disable returns A, not B. When replacement inherits the same native resource claim, transfer the predecessor's site baseline/anchors into the new accepted ledger before releasing predecessor records. When replacement drops a claim, release it to the site baseline at swap and keep enough predecessor data to restore B if candidate fails. If the website changed the field meanwhile, neither transition overwrites the newer value; suspend/conflict instead. The same rule applies to inline property overrides, relocation anchors and owned behavior state. Local inverse reads current identity/value before restoring. Undo in reverse resource-creation order; continue cleanup after a failure. A missing owned annotation is already absent, not a failed restoration. A missing native target is not a reason to mutate a replacement. A browser-confirmed destroyed document releases all its local resources; no stale tab fallback.

Do not restore markup by `innerHTML` or replace native elements with clones. Listener preservation is tested by reference equality and behavior, not DOM string comparison. For text use the exact original Text node; if a framework replaces it, suspend and leave the replacement untouched. Resource memory caps reject a new group **before** throwing away an inverse for a live effect.

## 6. Verification responsibilities

Three distinct results:

- **Delivery:** sheet/listener/owned node exists and is associated with correct resource ID.
- **Effect:** requested property/visibility/text/binding/view condition is satisfied, including already-satisfied values. Change-from-before alone is not success and no change alone is not failure.
- **Integrity:** no introduced loss of protected content, focus/reachability, form/media function, or unsupported layout regression in measured scope.

Baseline-relative issue keys are structured. Existing low contrast does not excuse making it worse. New owned text must meet WCAG AA in supported measurable colors; uncertain compositing is unknown, not an invented ratio. Intentional hidden targets are excluded from visibility failure but their newly hidden ancestors/siblings are not. Model “done” cannot override a failed mandatory check. Runtime cannot prove aesthetic satisfaction universally; report evidence coverage and allow user accept/refine.

## 7. Operation field contracts (v1)

This closes the model-facing grammar; do not invent missing fields or accept arbitrary operation-specific objects. Common fields are `kind`, `targetRef` where applicable, and optional public `reason` ≤240 characters. Runtime assigns resource IDs. Strings are plain text unless specifically CSS values.

| Kind | Required operation fields | Optional fields / exact initial defaults |
|---|---|---|
| style | rules (1–256); each rule has observed or earlier-owned target ref + declarations (property, value, priority) | state=none; surface=element (also before/after for approved decoration); conditions=[]; priority normal or important, default important for intentional override; separate keyframes follow motion policy below |
| hide | targetRef | reason only; no implicit healing |
| collapse | targetRef, label ≤120 chars | initialState=collapsed, placement=before; user override=true is mandatory |
| float | targetRef, edge (`top-start`, `top-end`, `bottom-start`, `bottom-end`) | width=`min(24rem, calc(100vw - 2rem))`, maxHeight=`50vh`, inset=`1rem`; these are design defaults, validated responsive values, not measured geometry |
| replaceText | targetRef, text ≤8 KiB | Target must be a noneditable leaf element with exactly one Text child; otherwise return unsupported-text-shape. Runtime changes that same Text node. Empty replacement allowed only with explicit content-removal approval |
| insertUI | targetRef, position (`before`, `after`, `first-child`, `last-child`), nodes | ≤200 owned nodes, depth≤12, ≤16 KiB total text; typed tag/attribute/localId contract below; invalid nesting or unsafe anchor refuses; no invented fallback position |
| bindKey | chord, actionIds (1–4), scope targetRef or document | repeat=false; editablePolicy=ignore; modalPolicy=ignore; no permissive string “action” evaluator |
| localRule | trigger, targetRef, predicates[], actionId | maxExecutionsPerInstance=1; cooldown=500ms; predicates conjunction; at most 8 predicates; allowed states/predicates below |
| projectCollection | sourceSetRef, fields mapping, view (`list`, `grid`, `board`) | groupBy optional observed field or `localBucket`; order=source; showOriginal=true; ≤8 fields and ≤12 groups; empty/unknown field rejected |
| relocate | targetRef, destinationRef, position (`first-child`, `last-child`, `before`, `after`) | placeholder=flow-slot; explicit structural grant mandatory; target cannot contain destination; same DocumentKey/root only |

Local predicates are finite: membership in approved set; `expanded equals true/false`; `ownedState equals value`; `text contains literal` with explicit content/filter approval (literal≤120 chars). No model regex, arbitrary boolean expression, evaluator or query execution. Trigger/action compatibility is checked: target-appeared cannot invoke generic consequential activation; trusted-shortcut may. Debounce/once/user override rules are runtime-controlled, not model-disableable fields.

Use one safe DOM tree representation, not a separate renderer for every widget. Node fields are localId, tag (or `text`), text/children, allowed attributes and optional approved actionId; Canvas 2D adds scene data, not executable code. Containers, headings, lists, local buttons/inputs and other allowed native tags are listed in [capability coverage](28-capability-coverage.md). Later style/binding operations can reference nodes created earlier in the same batch. An annotation is simply an insertUI tree, not another public operation. No arbitrary tags/attributes, HTML strings or inline event/style source; styles use the shared style operation and security policy.

### CSS: native vocabulary, narrow safety policy

Do not maintain a second incomplete catalog of ordinary visual CSS properties or invent one operation per property. Accept declarations recognized by the pinned syntax parser **and** the target browser (`CSS.supports`) after the following security/impact checks. Browser acceptance proves syntax support, not safety. Unknown raw parser nodes remain rejected; supported modern syntax must be added/tested without redesigning the operation language.

- No network-bearing values/at-rules, executable legacy properties (`behavior`, binding/worklet mechanisms), `attr()` or unvalidated custom-variable chains. Keep the earlier URL/variable policy and recursive AST inspection, including escaped tokens and shorthands. Do not replace the parser with regex.
- Model does not control selectors or browser/global policy. Reject `all`; document-level print rules/font sources/imports are outside the style operation. `display`, visibility, opacity, pointer-events, position/order/overflow and other effects that hide/obscure/reorder interactive content pass impact policy regardless of syntax validity. New/unknown side-effect categories require policy tests before enabling.
- Ordinary color, background, spacing, typography (including letter/word spacing and font features), flex/grid/columns, borders, shadows, masks/clips without network references, outlines, cursor keywords and other micro-details use **the same declarations path**. No arbitrary visual-value ceiling such as a global 24px blur ban; scope, render cost and accessibility govern acceptance. Large effects may be rejected for measured performance, with the actual reason shown.
- Literal decorative `content` is allowed only for owned `::before`/`::after` surfaces on an explicitly decorative, aria-hidden owned host; pseudo-elements themselves cannot receive ARIA attributes. Never hide meaningful native content from accessibility just to add decoration, or use generated text to replace accessible content. Network forms, `attr()` and pretending generated text is real content remain forbidden. Plain owned text nodes are preferred.
- Motion uses native CSS transitions/keyframes. Default motion is compositor-friendly transform/opacity; color effects are allowed. `transition: all` remains rejected. A user-requested finite layout transition may be previewed under the same measured cost/overflow checks; never a perpetual layout-animation loop. Reduced-motion alternative and cleanup are mandatory. Do not add an animation library or custom timeline engine.
- Loading a new remote background image/font is **not** smuggled through CSS. It needs a separately approved asset capability; the present release supports colors/gradients, installed fonts and retaining/restyling existing page media. See the explicit coverage boundary rather than claiming every asset request already works.

Verification samples motion at declared start/end states or measures its final state after finite completion; it does not require intentional intermediate animation frames to be geometrically identical. Infinite decorative transform/opacity animation may continue with reduced-motion and visibility handling, but cannot block verification forever. CSS motion on an owned canvas animates its element, not its internal drawing.

## 8. Important edge cases

- Rule references future set with zero current members: save only after explicit future-set approval; show waiting, not transformed.
- Multiple style groups interact: verify combined candidate revision, not each in isolation only.
- Any candidate operation fails but earlier accepted customization exists: roll back the single candidate batch, not earlier accepted customizations; no implicit optional-subset execution.
- CSS delivery acknowledged but target disappears before activation: remove inert sheet, no acceptance.
- Page writes the same attribute Revueon changed: preserve foreign tokens; conflict if a compare-and-restore write would overwrite newer site state.
- Hover/focus states absent now: static syntax validation plus browser fixture tests; don't fabricate measured coverage on this page.
- Responsive testing never manipulates user's window. Active resize events cause local verification; QA covers the breakpoint matrix.

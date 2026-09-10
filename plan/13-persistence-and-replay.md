# Persistence, revision history and dynamic replay

**Proposed.** Purpose: replace accumulated journal replay with desired-state personalization. [Data](04-data-contracts.md), [transactions](08-transformation-runtime.md), [concurrency](06-events-and-concurrency.md) and [migration](19-migration-and-deletion.md) are normative dependencies.

## 1. What persists

One OriginRecord holds saved customizations, approved scopes, enabled flags, active/previous accepted revisions, explicit local organization, grants and record revision. The broker alone writes it. `storage.local` and `storage.session` use TRUSTED_CONTEXTS; content obtains minimal sanitized applicable records through broker. “Remember provider secret” is opt-in; secrets are not encrypted against a compromised user profile, and UI must not imply an OS keychain.

Never persist default raw observations, model prompts/responses, full URLs, DOM/HTML baselines, node clones, transient targetRefs, operation history as execution recipe or global replay error from an unrelated tab. A model-authored annotation/rewrite may contain copied sensitive text: saving requires the same content disclosure as source text.

Storage budget: 256 KiB per customization, 2 MiB per origin, 6 MiB total customization data by default, leaving browser quota headroom. Before save measure serialized bytes and reject oversize with export/delete/session-only alternatives. Never evict an enabled customization or rollback inverse silently. Two accepted intent revisions per customization; optional export supports deeper manual history without growing live records indefinitely.

## 2. Scope and route semantics

Default save scope is exact origin + pathname. “Permanent” means persist the selected customization, not automatically all pages. User can approve slash-boundary path prefix or whole origin for rules such as hiding Shorts throughout YouTube. Scheme/port remain part of origin.

Query/hash apps need separate route interpretation:

- Runtime notices every full local URL change and increments routeEpoch, even when serialized model evidence omits query/hash.
- Default exactPath customization with **no discriminator** revalidates targets on any same-path route change; it does not blindly retain per-instance edits. User approves its applicability to compatible views on that path at save time.
- If the request is view-specific, require user-selected allowlisted query key/hash route discriminator. Store only approved non-secret values. No automatic wildcard over all query values.
- If safe discriminator cannot be saved (token/account ID/private route), mark customization session-only or require manual activation on reload. Do not claim removal of query/fragment eliminates all PII; paths themselves can be sensitive.

Origin-wide descriptors still require target predicates. Scope match alone is never enough to act.

## 3. Save protocol

1. Runtime accepts a revision with exact verification receipt. Workspace requests save using that revision, expected recordRevision and unique mutation ID.
2. Broker validates user authority, scope, schema, bounds and acceptance receipt. Enqueues by origin.
3. Read current OriginRecord; if revision differs, return conflict with current summary. UI can merge disjoint customization IDs after refreshing, but cannot overwrite a concurrent edit to the same customization silently.
4. Write one complete updated OriginRecord with new revision and lastMutationId. Retain previous accepted revision in that same record.
5. On ambiguous write/worker restart read record: matching mutationId proves success. Otherwise report not-saved/conflict after reconciliation. Do not retry a new blind overwrite.
6. Broadcast the new recordRevision to applicable runtimes; each independently reconciles and reports status. Persisting is not proof every open tab applied it.

No database dependency is necessary for initial record sizes. If high-frequency concurrent origin writes exceed simple queue capabilities, migrate to IndexedDB transactions via ADR; do not pretend `chrome.storage` has native CAS.

## 4. Cold load and replay

1. Content boots once, registers browser document identity, awaits applicable validated records.
2. Determine route scope and root capabilities; build only needed descriptors, not full model perception.
3. For each enabled customization in explicit precedence order, resolve target descriptors fresh. Missing target → waiting; ambiguous/mismatch → suspended, no guesses.
4. Compile revision to fresh document namespace, prepare inverse records from this page's live state, stage/activate/verify through **the same runtime transaction path as initial apply**.
5. At initial replay, any failed operation/mandatory check prevents acceptance of that customization's single candidate batch and suspends it; independent accepted customizations remain. Later, disappearing future-set members have their own resources released without guessing replacements; missing required anchor or coupled-control target suspends that customization. Record waiting/degraded status, never full success with missing coverage; no subgroup dependency graph.
6. Start local observer reconciliation only for installed/waiting eligible groups. No provider call, no replay of past user actions, no page refresh to hide a missing inverse.

Pre-first-paint CSS is not guaranteed and is not allowed to skip target validation. Saved intent is authoritative; compiled CSS is a document-local cache/resource. New document gets new tokens, not prior selectors/digests.

## 5. Same-document reconciliation

Maintain descriptor→resolved membership/resource map. On relevant dirty targets:

- Revalidate existing member. If still eligible and owned resource intact, do nothing.
- New eligible member: prepare/apply its finite resource subset once; record inverse before write.
- Member no longer eligible: release owned resources; preserve newer site state on conflict.
- Recycled node now represents another item: old item key/semantics fail → release old effects before considering new eligibility.
- User changed a local disclosure/filter state: respect explicit per-instance override; do not continually reapply initial defaults.
- Text content under replacement changed by page: stop that replacement rather than infinite rewrite combat.

Coalesce at 100ms quiet/500ms max wait, enforce per-pass work/time/memory caps, and pause a group after two repeated conflict cycles within 10 seconds. Show “paused on this page; site keeps replacing this region,” with retry/reselect/disable. No autonomous model repair on observer events.

## 6. Enable/disable/remove and undo

Disable first revokes local active tokens/triggers, then releases resources and writes enabled=false. Save failure means local-off but not durable-off, clearly shown; retry saving before promising reload behavior. Broker targets every registered applicable document, tracks missing acknowledgements separately and does not emit a global clean result when one frame/tab failed.

Remove marks a tombstone in the origin write so another stale session cannot resurrect it. Broadcast cleanup; after acknowledgements or document destruction, remove record content while keeping a bounded mutation tombstone until stale message deadline passes (5 minutes). No partial multi-key saga is needed: tombstone and revisions fit one record.

Every replacement inherits the original site baseline for resources it continues to own. Candidate rollback uses predecessor effective values; disable/remove uses that inherited site baseline. Test site text A→accepted B→accepted C→disable returns A, while a failed C preview returns B. CSS fragments are recomposed in explicit customization order on every revision/order change, never appended in completion order.

Undo revision uses saved previous intent, revalidated on the current document. Replaying previous intent can fail on changed site; report suspended rather than overwrite new site state. Local rollback of a provisional group uses live inverse records; these two operations are not the same.

## 7. Storage migration and privacy

Recognized v0 `rv_*` entries are quarantined disabled. Do not hash their old full-content fingerprint and call it a safe migration. User can review an imported draft: parse CSS under new AST policy, map targets from fresh observation, inspect retained text/HTML and reconstruct structured annotations only through allowed nodes. Old arbitrary HTML is not loaded into DOM for migration. Unknown schema stays untouched/exportable, never executed.

Provider settings migration can prefill a Cloudflare-compatible profile from existing account/model fields after consent, but not auto-send credentials to another endpoint. Existing implicit `revueonConsentShown` does not count as v2 disclosure approval.

Saved insertUI content is the validated tree with local IDs and approved action refs, not DOM/closures or user-entered local draft values. Saved Canvas 2D content is bounded drawing records plus fallback; replay redraws a newly owned canvas after resolving its anchor. Never persist/read back page-owned canvas pixels. Both use the same versioned record, transaction and quotas; no separate widget database or graphics persistence subsystem.

## 8. Tests

Repeated reload produces same intended effects on compatible fixtures with new resource IDs; no duplicate widgets/listeners; disable during pending insert leaves no active effect; refine/save/reload preserves canonical latest state without old CSS accumulation; prior revision undo works or reports target conflict; two tabs write same origin and get deterministic conflict; quota failures keep applied-unsaved work; migration never executes old code/HTML or widens scope. See [T10–T12](21-test-matrix.md).

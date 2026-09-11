# Events, concurrency and message protocol

**Proposed.** Scope: cross-context ordering, page events, idempotency, interruption. No general event bus or replayable event-sourcing system is needed. Use typed direct requests plus bounded subscriptions. [State machines](05-state-and-lifecycle.md) define valid transitions.

## 1. Protocol inventory

Every request uses [Envelope](04-data-contracts.md). Receivers verify sender role independently of payload. Content cannot choose a destination tab by writing `tabId` in a payload.

| Kind | Sender → receiver | Payload / reply | Authority |
|---|---|---|---|
| RegisterDocument | content → broker | runtime ID/capabilities; reply verified DocumentKey/epochs/applicable saved intent | Browser sender.tab/frame/document only |
| StartRun / CancelRun | workspace → broker/runtime | selected DocumentKey, goal metadata; registration/cancel receipt | Trusted extension workspace, one run owner/document |
| Observe / Inspect / Expand | planner → broker → runtime | bounded evidence query; PageSnapshot/result | Current run + route; no mutation |
| ValidateProposal | planner → runtime via broker | proposal + snapshot ID; diagnostics/approval requirements | Schema/policy validation in runtime |
| ApplyBatch | planner → runtime via broker | validated proposal token/revision ID/grant ID; resource receipt | Current approval and epoch; one ordered batch, no subgroup scheduler |
| GetOperation | workspace/broker → runtime | operation ID; current receipt | Resolve lost replies; no side effects |
| ListDocuments | workspace → broker | none; registry snapshot | Read-only discovery for the exact-target picker (S6.2, ADR-14); no mutation authority |
| GetState | workspace → registered runtime | none; live projection + seq | Read-only close/reopen resync (ADR-14); same document fence as every page-scoped command |
| StageStyle / RemoveStyle | runtime → broker | exact compiled aggregate, composition revision, namespaces, operation ID; delivery receipt | Registered document, bounded validated resource contract, CSS policy independently checked |
| CommitComposition | runtime → broker | verified candidate operation/composition IDs; session metadata acknowledgement | Current runtime/epoch; records promotion only, does not remove predecessor bundle |
| RenewLease | owning workspace → runtime via broker | run ID and current provisional operation IDs | Owner identity verified; renewal cannot revive a revoked namespace |
| SaveRevision / SetEnabled / RemoveCustomization | workspace/runtime → broker | expected record revision, mutation ID, validated record delta | Trusted sender or constrained content acceptance receipt; only broker writes |
| RuntimeState / RunProgress | owner → subscribed workspace | sequence + bounded state projection | Filter by run/document; missed sequence triggers snapshot |
| RouteChanged / PermissionRevoked | broker → runtime/workspace | authoritative document/route/permission revision | Invalidate before new work |
| AnswerQuestion / ApproveProposal | workspace → controller | request ID, expected snapshot, answer/grant | User action; no page-origin approvals |

Provider HTTP has separate request IDs and cannot directly emit any of these commands. Model output never sets envelope fields.

## 2. Three serial boundaries, not a scheduler framework

1. **Runtime mutation queue per document**: one applying or reconciling group at a time. Priority: revoke/cancel/dispose > rollback > explicit apply/undo > dynamic reconcile > optional observation. Long tasks cooperate at safe yield points; cancellation flags are checked at each point and immediately before synchronous writes.
2. **Broker style queue per DocumentKey**: orders aggregate-bundle staging/removal and receipt updates. Runtime owns logical group fragments and canonical composition order; broker owns exact physical bundle delivery. Candidate fragment namespaces are inert until content attaches their tokens; unchanged fragments mirror the accepted bundle. At most one accepted and one candidate bundle per root. Cancel makes a late candidate harmless by disarming its tokens even when `insertCSS` cannot be aborted.
3. **Broker write queue per origin**: serializes saved-record mutations with expected recordRevision. No lock is held across provider calls or user questions. Worker restart restores from the acknowledged record/mutation IDs, not an in-memory queue.

Implement these serial boundaries with small Promise chains/Maps in their owning modules, not a reusable queue framework, priority heap or graph scheduler. Cancellation flags take precedence at safe points; dirty observer work coalesces into one pending pass. Independent documents can run in parallel, limited to two active provider requests per profile by default. One user run per document; a second StartRun returns busy with explicit cancel-and-replace option. An extension tab and side panel cannot both own it.

## 3. Apply sequence and crash windows

```mermaid
sequenceDiagram
  participant P as Workspace planner
  participant R as Document runtime
  participant B as MV3 broker
  participant S as Local storage
  P->>R: Validate proposal(snapshot, grant)
  R-->>P: validated batch token / risk report
  P->>R: ApplyBatch(operation ID)
  R->>R: resolve targets + record inverses + reserve namespace
  R->>B: StageStyle(operation ID, inert token sheet)
  B->>S: session delivery intent BEFORE insert
  B->>B: insertCSS exact documentId
  B->>S: delivery receipt
  B-->>R: inserted / outcome-unknown
  R->>R: epoch check, synchronous native writes + token activation
  R->>R: bounded settle + required/combined verification
  R->>B: CommitComposition(verified operation, epoch)
  B->>S: candidate promotion metadata (retain predecessor)
  B-->>R: metadata acknowledgement
  R->>R: final cancellation/epoch check; accept and transfer inverses
  R->>B: release obsolete predecessor bundle
  R-->>P: accepted or rolled-back/conflicted
  P->>B: SaveRevision(expected revision, mutation ID)
  B->>S: one OriginRecord replacement
  B-->>P: saved / conflict / unknown
```

If runtime disappears after staging, broker reconciles runtime state first and removes an unaccepted candidate using its exact receipt when no valid owner remains. Runtime cannot tell workspace a CSS revision is accepted before CommitComposition metadata acknowledgement; promotion retains the old bundle until runtime's final epoch/cancel check and explicit predecessor release. Late promotion after cancellation is compensated as that same operation, never treated as permission to reactivate tokens. If broker disappears after insert but before receipt, restart queries the still-live runtime's operation state; an unaccepted uncertain candidate is exact-cleaned before accepting a new insertion. A runtime-confirmed accepted bundle is retained, not deleted merely because persistence of user intent has not happened. If runtime disappears after acceptance but before save, the original document state may remain only until navigation; UI on reconnection reports unsaved. Do not fabricate a saved revision from a success toast.

## 4. Deduplication and idempotency

- Request ID identifies RPC; operation ID identifies mutation. Retrying an RPC uses both original IDs and original payload digest.
- Runtime retains active/conflicted receipts and last 128 terminal request receipts. An evicted unknown ID is not executed blindly; caller must obtain fresh state and a new reviewed operation.
- Broker persists CSS intent before invoking API. Never rely on undocumented duplicate-sheet deduplication.
- A CSS bundle contains per-document/group/revision namespaces and deterministic ordered fragments. A cancelled namespace is never reused. Removing candidate tokens makes delayed candidate fragments inert; unchanged accepted fragments retain identical semantics. Unknown old-bundle removal blocks another replacement until reconciled.
- UI updates carry increasing owner sequence. Old sequence ignored; a gap requests one snapshot. No replay of page input or network actions.
- Passive replay is desired-state reconciliation, not event replay. Activation behaviors are never replayed as historical clicks.

## 5. Browser event model

| Source | Owner/consumer | Coalescing / ordering | Failure behavior |
|---|---|---|---|
| webNavigation commit/history/fragment events | Broker → runtime | Re-read document route; monotonic epoch; do not trust delivery order alone | Reject stale event for old document |
| popstate/hashchange/pageshow + URL read at command entry | Runtime | Immediate epoch fence before awaits | Backup detection; not isolated-world history patch |
| MutationObserver | Runtime reconciler | Deduplicate dirty roots; 100ms quiet debounce, 500ms max wait, sliced work | Mutation storm reduces scope and suspends unstable groups |
| ResizeObserver/window/visualViewport | Runtime verifier | Mark layout dirty, max 4 checks/sec, no writes inside observer callback | Hidden/unstable layout reported unknown |
| User key/click on installed binding | Runtime behavior | Trusted input, immediate finite action, suppress repeat unless explicitly enabled | Abort on editable/modal/ambiguous target |
| Provider response / timeout | Controller | One request active/run; shared absolute deadline and AbortSignal | Late response ignored; mutation requires new validation |
| Workspace port disconnect | Broker + runtime lease | Cancel pending planning; runtime lease expiry backs up unload | Accepted resources retained; provisional cleaned |
| storage.onChanged | Broker/workspace | Revision snapshot, no content direct mutation | Queue reconciliation against latest revision |

Mutation observation cannot infer author intent or all framework behavior. Runtime records dependencies for a target group and invalidates only affected groups. Self-generated mutations are matched against exact resource writes, not all attributes starting with `data-rv-`; page code can spoof names.

## 6. Cancellation contract

Stop is local-first: workspace disables further calls immediately; sends cancellation with run ID to runtime and broker; provider AbortController aborts fetch/body read/backoff. Runtime revokes pending namespace before asynchronous cleanup. Local synchronous write groups are limited; cancellation takes effect at next safe point (target ≤100ms in responsive visible fixtures). Broker does not claim it cancelled a browser API already executing; it records compensation required.

During user-run provisional operations, workspace sends a lease renewal at most every 5 seconds; runtime expires after 15 seconds without renewal. Runtime-owned replay/reconciliation has no workspace dependency: it uses the validated saved grant and a bounded local transaction deadline (5 seconds maximum including broker acknowledgement), disarming/compensating if it cannot complete. It never waits for a human or provider. This is **not** a service-worker keepalive protocol and stops when no provisional group exists. Frozen documents cannot guarantee wall-clock cleanup; on resume they check expiry before any action or rendering activation. Every provisional namespace starts disarmed on restore. UI distinguishes awaiting cleanup from cancelled.

## 7. Races to test

Navigate A→B while A response arrives; mutate target after validation but before CSS ack; Stop during body stream/backoff; second run during SaveRevision; two tabs save same origin revision; broker restart between intent and insert acknowledgement; target removed during inverse; BFCache restore after lease expiry; UI closes during question; settings endpoint changes during a request. Each has a specific row in [test matrix](21-test-matrix.md).

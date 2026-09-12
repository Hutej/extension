# Revueon — core preview release notes

**Status after the S6.3 cutover (plan/19 §6).** One v2 runtime and the
canonical provider/store/target paths exist; the legacy agent loop, tool
registry, popup and their live paths are **deleted**. This is a preview of
the core product, not the full vision: the unavailable capabilities below
are honestly absent, not stubbed or advertised (plan/28 is the capability
authority).

## What works in this preview

- **Shared workspace** (side panel + extension tab — the same page): pin the
  exact target page, write a goal, Start/Stop at any time, answer planner
  questions, approve or discard proposals, pick the saved scope, watch
  truthful status with no false success.
- **Provider independence** (S6.1): OpenAI-chat and Anthropic-messages
  adapters over a bounded client (deadline, ≤6 attempts, byte cap, redirect
  and credential policy, exactly-one-object extraction). Any compatible
  endpoint/model via workspace profiles — explicit, endpoint-scoped consent
  and a real opt-out that keeps saved customizations working with zero calls.
- **One reversible batch per proposal** (S4): validated style/hide/collapse/
  float/replaceText/insertUI/relocate operations through one transaction
  with mandatory structured verification — accepted, rolled back or
  conflicted, never partially "done".
- **Persistence and continuity** (S5): versioned origin records with
  scope-aware replay, enable/disable/remove/undo-latest-revision, route-epoch
  fencing, worker-restart reconciliation, quota/tombstone protection.
- **Local-only diagnostics** (S6.2): a bounded, content-free event ring and
  a workspace diagnostic panel; legacy `rv_*` data is quarantined untouched
  and exportable, never auto-migrated or executed.

## Not available in this preview (P2 — later roadmap tasks)

- **Approved keyboard bindings** (`bindKey` — S7.1): a finite action catalog
  (focus, scrollIntoView, activate, followLink, toggleDisclosure) installable
  on observed targets with reserved-chord/plain-typing/conflict/cap checks,
  editable/IME/password/modal/repeat policies at event time, exact listener
  ownership, and a measured is-installed postcondition in the acceptance
  gate. Activating a site control is approved in review and is explicitly
  non-reversible externally (undo removes the shortcut, not the site's own
  effect).
- **Auto-collapse rules** (`localRule` — S7.2): a finite target-appeared
  rule collapses newly appearing expanded instances through the site's own
  disclosure (once per instance, sticky user-override, 500ms cooldown,
  review-approved as consequential); the owned collapse disclosure
  (`collapse`) is available as the manual mechanism.
- **Linked alternative views / projections** (`projectCollection` — S8):
  no board/list view of a site collection exists yet.
- **Owned Canvas 2D** (S8.4): no drawing capability yet.
- **Frame-scoped runs** (P2): top documents only; frames have no separate
  runtime/permission path yet.
- **Import of legacy journals into reviewed drafts**: quarantined legacy data
  stays review/export-only until the import flow is implemented and consented.
- **Streaming responses and provider connection tests**: non-streaming is
  first-class; both are deferred until a task needs them (recorded S6.1).

## Update notes

After installing this build over a pre-cutover version, **reload open tabs**:
pages still carrying the old content script cannot be reached by the new
service worker (plan/19 §3.2), and the new runtime starts on the next
navigation. The old background's tracked user-origin sheets are exact-removed
once at startup; anything it could not track is gone with navigation anyway.
Saved v2 records replay without any model call; legacy `rv_*` journals are
preserved untouched under quarantine.

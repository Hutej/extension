# Revueon — core preview release notes

**Status after S9.2 (the release checkpoint of plan/25).** One v2 runtime and
the canonical provider/store/target paths exist; the legacy agent loop, tool
registry, popup and their live paths are **deleted** (S6.3, plan/19 §6). This
note lists the implemented capability set and the honestly absent remainder.
`plan/28` is the capability authority; `plan/29-s9-1-evidence.md` is the
qualification record (measured matrices, Chromium-120 floor, residuals).

## What works in this release

- **Shared workspace** (side panel + extension tab — the same page): pin the
  exact target page, write a goal, Start/Stop at any time, answer planner
  questions, approve or discard proposals, pick the saved scope, watch
  truthful status with no false success. Stop is always available and never
  a dead-end; provisional effects are disarmed on stop/failure while
  accepted prior work survives.
- **Providers** (S6.1 + built-in): OpenAI-chat and Anthropic-messages
  adapters, plus the built-in Cloudflare model (consent-gated, ephemeral
  token in the visible workspace). Bounded client: deadline, ≤6 attempts
  with backoff + Retry-After on 429/408/5xx, byte cap, redirect and
  credential-in-URL refusal, exactly-one-object extraction. Any compatible
  endpoint/model via profiles — endpoint-scoped consent and a real opt-out
  that keeps saved customizations working with zero calls.
- **One reversible batch per proposal** (S4): validated style/hide/collapse/
  float/replaceText/insertUI/relocate operations through one transaction
  with mandatory structured verification — accepted, rolled back or
  conflicted, never partially "done". Each rule is membership-scoped to its
  own target (§44) with omitted priority defaulting to `!important` (§92).
- **Verification honesty** (S9 readiness work): delivery + declared
  postconditions + T30 combined checks on the settled measurement; transient
  CSS transitions are re-measured once before any revert; probe-unmeasurable
  classes are disclosed, never false-failed; net per-longhand cascade is the
  verified effect (intra-batch overrides included).
- **Persistence and continuity** (S5): versioned origin records with
  scope-aware replay, enable/disable/remove/undo-latest-revision, route-epoch
  fencing, worker-restart reconciliation, quota/tombstone protection. A
  disable releases live effects even when the saved descriptor went missing.
- **Local behavior** (S7): approved keyboard bindings (`bindKey`) over a
  finite action catalog with reserved-chord/IME/password/modal/repeat
  policies and measured install; target-appeared collapse rules (`localRule`)
  through the site's own disclosure with sticky user-override.
- **Views and layout** (S8): linked list/grid/board projection
  (`projectCollection`) from observed facts with local-only buckets;
  floating existing surfaces (`float`) with a runtime-owned minimize
  control; gated same-node relocation (`relocate`, explicit
  `structuralGrant` mandatory, protected targets refused with named
  fallbacks); owned Canvas 2D (`scene` insert — bounded records, capped
  pixels, accessible fallback, native page canvas untouched).
- **Frames and roots** (S8.3): per-frame runtimes for individually
  permissioned frames (relay targets the exact frame), root-local owned
  style node with a narrow inline-override fallback, session-only frame
  runs, truthful per-frame outcomes.
- **Local-only diagnostics** (S6.2): a bounded, content-free event ring and
  a workspace diagnostic panel; legacy `rv_*` data is quarantined untouched
  and exportable, never auto-migrated or executed.

## Not available in this release (honest limits, plan/28)

- **Shadow-DOM internals for text/insert/bind**: document-root-refused
  (honest unsupported; a later slice owns them). Style ops cover open roots.
- **Cross-reload persistence of board bucket arrangement**: session state
  that survives disable/re-enable; reload persistence is not built yet.
- **Import of legacy journals into reviewed drafts**: quarantined legacy
  data stays review/export-only until the import flow is implemented and
  consented.
- **Streaming responses and provider connection tests**: non-streaming is
  first-class; deferred until a task needs them (recorded S6.1).
- **Live browser matrix** (S9.1 record): Chromium 120 (the manifest floor)
  and current Chromium are live-tested; an Edge live run is pending an
  Edge-capable environment; BFCache-forced expiry remains a manual check.

## Update notes

After installing this build over a pre-cutover version, **reload open tabs**:
pages still carrying the old content script cannot be reached by the new
service worker (plan/19 §3.2), and the new runtime starts on the next
navigation. The old background's tracked user-origin sheets are exact-removed
once at startup; anything it could not track is gone with navigation anyway.
Saved v2 records replay without any model call; legacy `rv_*` journals are
preserved untouched under quarantine.

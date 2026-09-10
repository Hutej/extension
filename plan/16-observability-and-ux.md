# Observability, debugging and user control

**Proposed.** Purpose: make failures diagnosable and product state truthful without logging sensitive content or blocking the page. Scope: workspace, status UI, runtime instrumentation and local diagnostic exports. Related: [privacy](17-security-and-privacy.md), [state](05-state-and-lifecycle.md), [performance](15-performance.md).

## 1. Workspace behavior

Use one shared workspace UI in side panel or extension tab. Show pinned tab title/origin and user-selected scope before Start. Never select first HTTP tab as fallback. Switching browser tab does not redirect an existing run. New tab selection is explicit and cancels/rebinds only after user confirmation if needed.

Main controls: goal, selected model/profile, Start, Stop, preview/approval, accepted customization list, enable/disable, undo latest revision, remove, show original, settings. Stop remains accessible during planning/verification. Page remains interactable; optional small owned status chip uses closed shadow styling for isolation, not a security boundary. No full-viewport spinner or pointer blocker for minutes.

All text derived from model/page/provider uses text nodes. No HTML string status rendering. Native buttons/labels, keyboard navigation, aria-live polite status, meaningful focus return and reduced-motion support are required. Hidden test-result DOM is not the authoritative state API; tests use production typed state queries.

## 2. Truthful status projection

| Internal state | User wording/action | Never show |
|---|---|---|
| Observing/planning | “Reading page” / “Waiting for [profile]” + elapsed + Stop | “Understood” before model evidence |
| Candidate/provisional | “Previewing; checking changes” | “Saved” |
| Accepted + saved ack | “Applied and saved” + scope/model optional summary | Unqualified “works on every page” |
| Applied-unsaved | “Applied in this tab; saving failed” + Retry save / Undo | ✓ Done with reload promise |
| Partial | State exact previously accepted revisions, incomplete goal/target coverage or cleanup conflicts; never silently accepted subset of a failed batch | Full success based on one visible color change |
| Waiting target | “Enabled; target not present in this view” | “Nothing happened” as generic model error |
| Suspended | Reason: target ambiguous/site changed/unsupported root | Silent re-selection of first match |
| Verification unknown | “Could not verify preview; reverted it” or cleanup conflict | “Clean” from missing check data |
| Cancelled | “Stopped; previous accepted changes kept” | “All changes removed” |
| Cleanup conflict | “Disabled; some cleanup could not be confirmed” + details/reload offer | “Original page restored” |
| Unsupported request | Missing capability and available explicit alternatives | Blame user for not choosing a stronger model |

Open questions/approvals are owned by request ID and snapshot. Reopening workspace shows pending state if owner still valid; expired question requires fresh observation. No timeout instructs model to “proceed with your best judgment” for unresolved permission or target ambiguity.

## 3. Diagnostic event schema

Event fields: eventVersion, monotonicTime, context, runId?, DocumentKey redacted/local ID, routeEpoch, customizationId?, revisionId?, groupId?, operationId?, phase, resultCode, durationMs?, counts?, coverage?, errorCode?, retryClass?. Append public summary only when sanitized and user-consented.

Required events: runtime registered/disposed; hydration start/end; run state transition; provider request headers/body/end; decode rejection; target unresolved; prepared/staged/activated/verified/accepted group; save ack/conflict; cancel requested/revoked/cleanup; replay waiting/suspended; resource release conflict; budget exhaustion. No per-node tracing or per-mutation console spam.

Counters: live resource counts by kind, stale replies rejected, duplicate operations deduped, current queue length, observer work passes, longest slice, emitted CSS bytes, HTTP attempts and usage, replay mismatches, unknown verification counts. Keep model latency separate from runtime latency. `paidCalls` never hides HTTP retries.

## 4. Local inspector and safe export

Workspace diagnostic panel shows active document/epoch, saved versus live revisions, target coverage, resources pending cleanup, last structured verification and operation timeline. Source content is optional on-demand with explicit warning; default export includes no credentials, raw URLs/query/hash, selectors containing personal labels, model prompts/output, CSS values carrying page content, or HTML.

Export is a downloaded JSON diagnostic record generated on explicit user action in implementation phase, plus human-readable summary; this task creates no such implementation file. Include app/contract/browser/provider adapter versions and reproducibility parameters. Do not upload telemetry automatically. Diagnostics are a bounded session-only ring plus explicit export. Do not build a separate persisted-log/retention/settings subsystem without a demonstrated support need; durable customization/delivery receipts remain separate correctness state.

## 5. Debugging recipes

- **No visible result:** check target count/coverage → resource delivery → requested property satisfied/already-satisfied → integrity → user aesthetic approval. Don't infer no-op from eight sampled leaves.
- **Toggle leaves effects:** inspect pending resource IDs and namespace membership; exact CSS receipt state; distinguish old legacy runtime from v2. Never delete every page style to clean up.
- **Reload differs:** compare saved canonical revision and fresh replay target outcomes; check scope/discriminator/permission; do not compare only stylesheet counts.
- **Model churn:** inspect compact context and latest diagnostic visibility, schema errors and call counters; change context/contract only with provider-matrix tests, not a stronger default model.
- **Slow page:** separate observation/style/verification/website handler time; examine maximum slice and repeated dirty root; no blanket timer increases.
- **Wrong route/tab:** trace DocumentKey and routeEpoch from Start through every receipt; verify no tab-only injection path.

## 6. UX acceptance

Keyboard-only user can configure provider, choose target, run, stop, approve, disable and inspect error. Popup/sidepanel closure does not leave opaque overlay. Screenshots cover real visual themes and projection views, but mechanical results come from exact typed state. Human evaluation of aesthetics is separate and reported with model name/version; visual preference cannot override safety gates.

# Model and provider interaction architecture

**Proposed.** Purpose: make model substitution a first-class feature while keeping deterministic behavior independent of model strength. Replaces `core/reason` Cloudflare-only transport and `core/config` GLM policy. [Runtime](08-transformation-runtime.md) never imports this subsystem.

## 1. Responsibility split

Model responsibilities: interpret goal; map evidence to targets; design coherent effects; choose requested observations; explain ambiguity; propose bounded corrections. Not model responsibilities: credentials, browser API invocation, target identity proof, permissions, cancellation, persistence, code execution, runtime deadlines or determining that absent verification is clean.

The controller prepares evidence before asking the model. Common simple flow is **one proposal call**, not model→describePage→model→apply→model→verify→model→done. Required verification is automatic and local. A complex goal can request bounded extra evidence; the same response union works with plain-text JSON, JSON mode, or structured outputs.

## 2. Profiles and supported protocols

User configures label, exact endpoint URL, protocol, model ID, authentication and optional capabilities/context limits. No edit/rebuild needed to add a model served by a supported protocol. Endpoint selection is explicit; model names are opaque strings. Cloudflare is a prefilled OpenAI-chat profile, not the architecture.

| Adapter | Request translation | Response translation | Required special handling |
|---|---|---|---|
| OpenAI-compatible Chat Completions | messages; configured model; compatible token field; optional JSON mode/schema | Extract `choices[0].message.content`; text parts if documented; usage/finish reason | No automatic assumption that max_completion_tokens, reasoning_effort or response_format is accepted |
| Anthropic Messages | system separately; messages; required max_tokens; provider version/auth headers | Concatenate text content blocks only; reject tool-use without supported contract; normalize stop reason/usage | Endpoint CORS/direct-browser requirements and host permission validated in connection check; do not claim all account products expose this API |
| Local endpoints | One of above protocols with explicitly selected loopback URL | Same adapter contract | HTTP permitted only for explicit localhost/127.0.0.1/[::1]; no network-wide HTTP allowance |

OAuth/subscription account reuse, OpenAI Responses, Gemini-native protocols and local proprietary protocols are separate later adapters. A user may use an external compatible gateway, but Revueon does not secretly route data through one. Model substitution within an existing protocol is P1; new wire protocols require an adapter and its tests. The UI tells users which is which.

## 3. Adapter contract

Input: validated profile + system instruction + bounded evidence/goal payload + request ID + absolute deadline + local AbortSignal + output budget. Output: normalized text or protocol error, finishReason, usage if provided, HTTP attempt count, header/body timings and capability-negotiation changes. Adapter does not parse/execute transformations.

Normalization failure examples: missing choices/text block; success HTTP with non-JSON envelope; refused response; context-length error; token-limit truncation; invalid UTF-8/oversized body; error body on 200. All map to explicit errors. No reasoning/private chain-of-thought field is extracted or logged; optional concise user summary is the public explanation.

No hidden model changes, parallel speculative model calls, “strong model rescue,” unbounded self-improvement or multi-agent authoring. A malformed weak-model response triggers the same bounded format repair as a strong-model response.

## 4. Capability negotiation

Store capability outcomes per `(profileId, endpoint, protocol, modelId, configurationVersion)`. User overrides win; changing these invalidates negotiated cache.

1. Base mode requires only text request/response. System instruction explicitly requests the small response union.
2. Enable structured/JSON output only when profile/user selected support or connection probe confirmed it.
3. If a provider returns a **specific unsupported-parameter error**, drop that one optional parameter and retry once, recording downgrade. Do not respond to every 400 by removing arbitrary fields.
4. Authentication, model-not-found, quota, context-too-large and arbitrary 400 errors are not capability negotiation. Show actionable diagnosis.
5. No provider code name regex such as `/glm/`; reasoning/temperature parameters exist only as adapter-supported optional settings.

Connection test is explicit, minimal and disclosed as potentially billable. Saving a profile does not send a surprise request. Lack of tools/vision/structured-output support does not disable ordinary planning.

## 5. Budgets and retries

Proposed defaults (settings can lower or deliberately raise ceilings within runtime payload limits):

- 1 initial proposal call; at most 2 evidence-request continuations; 1 correction call total shared by format/validation/failed-preview correction. **Maximum 4 model responses per run**, no extra model call just to say done.
- Maximum 2 HTTP retries for transient network/429/502/503/504 across a run; total HTTP requests ≤6 including capability negotiation. Budget controller counts every actual request, not just successful model results.
- Provider call default 45s, user-selectable 15–180s for slow models; total active run default 120s, configurable up to 300s. Human question/approval wait does not accrue model runtime cost but expires after 5 minutes; restart from fresh evidence after expiration.
- Shared absolute deadline spans fetch headers, streaming/body read, decode and backoff. Deadline is not cleared when response headers arrive.
- Abortable jittered exponential backoff, base 500ms, cap 8s; honor bounded Retry-After delta/date without exceeding remaining budget. No retries on auth, permission, invalid schema, or user cancellation. Context-too-large gets one deterministic evidence reduction only if no correction budget was already spent; else ask user to narrow scope.
- Output token budget configured to fit protocol and context, initially 4,096 tokens for common proposals; user can increase to profile limit, but response bytes capped at 128 KiB. Truncated output is rejected, never executed as partial JSON. This supersedes the unbounded-output assumption in old source comments: predictable speed and bounded memory are runtime requirements.

These limits govern cost/latency, not feature vocabulary. Larger tasks should be explicit successive revisions with checkpoints, not an 80-turn silent loop. The UI offers “continue with another revision” after accepted partial work.

## 6. Context construction

Stable system prefix: role, response union, currently supported operations, privacy/data boundary, targetRef semantics. User payload: goal, origin (no raw path by default), fresh snapshot, installed customization summary, pending diagnostic and latest evidence. Put page/model-provided text inside labeled data records, never instructions.

Default input budget derives from profile context limit minus output allocation and 20% reserve. Unknown context limit uses conservative 8k-token estimate; use a conservative byte-based approximation with disclosed approximation, not a fake exact tokenizer. Start ≤12 KiB page evidence; compact summaries preserve target IDs, safety requirements and newest diagnostic. Drop optional old observations first, not newest repair feedback. No complete historical tool transcript, no inaccessible “see full result” reference.

A weak model gets the same semantics with fewer simultaneous choices: capability lists are filtered by goal-independent available page affordances and installed runtime support; requestEvidence opens more detail. Do not infer intent with a hardcoded word table to bypass the model. No provider-specific prompts required to make basic safety work.

## 7. Output decode and hallucination containment

Parse bounded text as one JSON object. Permit a single outer Markdown JSON fence; if prose wrapper mode is supported, a linear quote-aware scan may locate **exactly one** object. Multiple candidate JSON objects or trailing conflicting commands are ambiguous and rejected. Never extract the first plausible nested object from truncated output and execute it.

Validate discriminator, exact fields/types/bounds, the single ordered operation list, unique local IDs declared by insertUI, no forward local refs, available operation kinds, targetRefs from supplied evidence and requested permissions. Reject nested group/dependency-graph fields rather than adding a planner/scheduler for them. Unknown target → diagnostic or evidence request; never guess selector. Model “complete” text does not produce a success state without accepted runtime receipts.

Repair prompt contains compact path errors, permitted values/refs, and current proposal summary. It does not ask the model to weaken policy. After one failed repair return `cannot-produce-valid-proposal`, keep accepted prior work and offer manual selection/settings retry.

## 8. Streaming, costs, versions and tests

Use streaming when supported for earlier connection/summary progress and bounded body reads, but **buffer and validate the full response before any effect**. No partial-CSS streaming into the page. Text-only nonstreaming providers remain first-class. Request cancellation aborts the stream and backoff.

Record adapter version, profile version, model ID and prompt-contract version on run diagnostics. Cost is reported from supplied usage × user/provider price metadata; if unavailable say unknown, not zero. Changing provider does not invalidate saved deterministic customizations.

Test adapters with local mock HTTP servers for strong/weak/malformed/slow/streaming profiles; runtime acceptance suite runs with no live model. Live model quality benchmark uses frozen fixture evidence plus separately controlled live-site tasks. Same prompts for comparative runs; wording variants are a secondary robustness set, not an obligation to change wording and destroy comparability. Pass criteria in [AC-05](22-acceptance-criteria.md): no source changes for profile substitution, malformed output never mutates, bounds always hold.

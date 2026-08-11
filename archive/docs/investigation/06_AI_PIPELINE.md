# 06 — AI Pipeline

> Prompt generation, context collection, verification, retry logic, failure recovery, weakness analysis.
> Every claim cites `file:line`. Speculation is marked **UNVERIFIED**.

## Architecture

Three model roles dispatched by `background.ts:11-19` `dispatchRole`, each calling a function in `core/reason/index.ts`:

| Role | Function | Model (default) | Purpose |
|---|---|---|---|
| `architect` | `requestArchitectSpec` | `@cf/zai-org/glm-5.2` | structure / intents / pack |
| `painter` | `requestPainterSpec` | `@cf/zai-org/glm-5.2` | surface (colors/type) |
| `critic` | `requestCriticCorrection` | `@cf/zai-org/glm-4.7-flash` | repair on failure |
| `design` | `requestStyleSpec` | (legacy single-call restyle path) | the non-split path |

`content.ts:738` runs **architect + painter in parallel** (`Promise.all`); the critic runs only on a paint-1 failure (`content.ts:934`).

## Prompt generation

`reason/index.ts:265`:
```js
userContent = `USER REQUEST: ${intent}\n\nRUNTIME PAGE PERCEPTION:\n${perception}`;
```
- **System prompt** documents the intent DSL, the 14-role vocabulary, the handle format (`c` + 6 chars), the design-pack fields, and the op kinds.
- The **perception** is the serialized page (`perceive:1219` v1 / `perceive:1371` v2 painter). v2 painter payload trimmed in S4.1 to role+slot+dominance+handle+tag+signals only (~9K chars vs v1 ~30K+).

## Context collection (what enters the model)

- **From the page:** handles, roles, dominance, text samples, colors, fonts, (v2) slot assignment. v2 painter has **no geometry/rects/parent-child** (trimmed). v1 painter has full serialization.
- **From the user:** the `intent` string (the vibe).
- **From the critique (critic only):** a `critique` string built by `repair/index.ts critiqueFor/voidCritique` describing what failed.
- **Credentials:** `accountId` + `apiToken` from `chrome.storage.local` (`background.ts:36`).

**Privacy:** the serialized perception includes **page text content** (cluster text samples). This is shipped to `api.cloudflare.com` with **no consent gate, no allowlist, no PII redaction** (`reason:303-307`). `host_permissions:<all_urls>` → every site. A bank/medical/email page leaks its visible text. (See `11_SECURITY_ANALYSIS.md`.)

## Verification (response validation)

- `reason/index.ts:331` `JSON.parse(response)`.
- `spec/index.ts:197` `validateSpec`: checks enum fields, requires intents OR rules.
- **Hallucinated roles pass validation (verified):** a spec of 6 intents targeting an invented role `"hero-banner"` has all valid enum fields, just no matching clusters → `expand.ts:174` resolves to `[]` → dropped, only logged. `escapeHatchFraction` denominator falls to `1` → a fully hallucinated spec reports `escapeHatchFraction=0` (looks great) while producing nothing.
- **Hallucinated handles** → `compile/index.ts:301` `byHandle.get(rule.target)` returns `undefined` → `invalidTargets.push`, rule skipped (logged, not failed).
- The real backstop is the post-apply coverage gate (`MIN_MODEL_COVERAGE_FRACTION=0.40`, `laws:287`), but it only catches this **after a wasted paint+verify cycle**.

## Retry logic

`reason/index.ts:281` `callModel` has a `while(true)` loop:
- **429 / ≥500:** `transient++; continue` up to `maxTransientRetries=4` (`config:69`) → **up to 5 billed HTTP requests for one role**. The `transient` counter is local and **never returned** → invisible to the user.
- **400 on `response_format`/`reasoning_effort`:** drops the param and `continue`s → a **second billed request** without incrementing `transient` → can then still hit the 429/5xx path on top. A model that 400s on `response_format` then 429s = 3+ billed calls for one role.
- **Other errors:** throw → caught in `content.ts:1580` → `{ok:false}`.

**429 `Retry-After` header is ignored (verified):** `reason:383` parses OpenAI's body-text format (`try again in Xs`). Cloudflare signals backoff via the `Retry-After` **header**, which is never read → falls back to exponential backoff (`rateLimitBackoffMs * 2^n`, `:385`) → risks re-slamming.

## Failure recovery

### Deterministic free repair (`repair/index.ts`)
- `forceContrast` / `squeeze` repair — no paid call. `planRepair` (`:98`) routes contrast failure to a recompile with `forceContrast:true`.
- **Hole:** the inline backstop sets `color` on the cluster element, not the text-bearing child. A site `<span style="color:#000">` inside a black-bg cluster → black-on-black survives.
- **`packOverrides` unvalidated** (`spec:241` bare `as`): a model emitting `packOverrides.spacingScale = 2` (number) silently no-ops density; a non-object spread can corrupt or crash.

### Paid critic (`reReason`)
- `content.ts:934` `askForSpec('critic', …)` with `critique` describing the failure. Only if `canReReason()` (budget check, `content.ts:482`).
- `critiqueFor`/`voidCritique` (`repair:254`) build the prompt; can repeat similar advice twice → prompt noise.

### `keepBest` / `bestNonBroken`
- `planRepair` returns `action:'keepBest'` in four places (`repair:168,179,184,188`).
- **`bestNonBroken` is dead code (verified):** imported `content.ts:20`, defined `repair:260`, never called. The "keep the best NON-BROKEN attempt" guarantee is unenforced. The last-resort loop (`repair:278`) ignores `notBroken`/`contentIntact` → can return a fully broken attempt.
- `keepBest` → routed to a **redundant paint-2 recompile** (`content.ts:969`) with the same options → wasted paint (H8).

## Rollback / partial failure

- **CSS rollback on failure** (`content.ts:913,954,983,924`): `removeStyleEverywhere` only. **DOM ops NOT undone** (RC3) → a failed transform that removed a sidebar leaves it gone, marked "failed", no recovery. Reload re-perceives a DOM already missing the sidebar → permanent silent structural data loss.
- **No global 120s abort (verified):** `config:52` `designMaxMs:120_000` is documented as "absolute hard abort for the whole transform", but only `canReReason()` and the critic timeout consume it. Per-call: `architectTimeoutMs:70000`, `painterTimeoutMs:90000` parallel, `criticTimeoutMs:45000`. Worst case ≈ **145s**. The "≤120s hard abort" mandate is unenforced.
- **SW killed mid-fetch** → `sendMessage` callback never fires → 120s frozen spinner (`content.ts:1129`). The keepalive port (`background.ts:27`) only prevents idle kill, not forced kill.

## Weakness analysis (summary)

1. **One-shot mandate structurally impossible (verified):** `content.ts:738` is 2 parallel paid calls; `:934` adds a 3rd on failure. `config:47-50`: "paidCalls is observability — NOT a gate."
2. **Retries silently re-bill** (up to 5×/role, never surfaced).
3. **Full page content egress, no consent.**
4. **`bestNonBroken` dead** → "keep best non-broken" guarantee is a lie.
5. **No hallucination prevention at the spec layer** — invented roles/handles pass validation, dropped silently; the metric is gamed.
6. **DOM reference survival = one injected attribute** (`data-rv-c`) + one best-effort observer.
7. **Failed transform leaves DOM mutated** (no op rollback on failure).
8. **No global abort**; 429 header ignored; `isReasoningModel` regex over-matches any id containing "glm" (`reason:394`).
9. **`packOverrides` unvalidated** → silent corruption or crash.
10. **`relocate` with no `to` refused silently** (`expand:249`); `topbar` over-refused on unknown `moveSafety` (`expand:237`).

## UNVERIFIED
- Whether the model ever emits valid but contradictory intents that the deterministic expander cannot reconcile (the `mergeConstraints` validation is computed-but-ignored, `solve:137`).
- Exact Cloudflare 429 response shape vs the OpenAI-format parser.
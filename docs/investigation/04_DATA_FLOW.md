# 04 — Data Flow

> How data moves through Revueon: state changes, storage, AI context, serialization/deserialization.
> Every claim cites `file:line`. Speculation is marked **UNVERIFIED**.

## Data flow overview

```
                    LIVE DOM
                       │
            ┌──────────▼──────────┐
            │  perceive()          │  perceive/index.ts:230
            │  walk → cluster →    │  reads getBoundingClientRect + getComputedStyle per element
            │  stamp data-rv-c →   │  stamps CLUSTER_ATTR (data-rv-c) on each cluster rep
            │  role-classify →     │  semantic.ts classifyRole
            │  enrich              │  enrichLayout/enrichSemantic/gatherSignals
            └──────────┬──────────┘
                       │  Perception object {clusters, skeleton, canvas, cssVars, shadowRoots, composition}
            ┌──────────▼──────────┐
            │  serializePerception │  perceive/index.ts:1219 (v1) / serializeV2Painter:1371 (v2)
            │  → text string        │  compact: handle, role, dominance, text samples, colors, fonts, (v2: slot)
            └──────────┬──────────┘
                       │  + "USER REQUEST: <intent>"
                       ▼
            ┌─────────────────────────────────────────────┐
            │  background.ts → reason/index.ts:265          │  POST api.cloudflare.com
            │  userContent = "USER REQUEST: ${intent}\n\n   │  Authorization: Bearer <token>
            │   RUNTIME PAGE PERCEPTION:\n${perception}"     │  (PAGE TEXT + STRUCTURE LEAVES THE MACHINE)
            └──────────┬────────────────────────────────────┘
                       │  StyleSpec JSON {intent: role@group/handle, aesthetic, ops, packOverrides}
            ┌──────────▼──────────┐
            │  validateSpec        │  spec/index.ts:197
            │  mergeSpecs          │  architect + painter merged; spec:386
            └──────────┬──────────┘
                       │  validated StyleSpec
            ┌──────────▼──────────┐
            │  expandIntents       │  compile/expand.ts  intents → rules (target handle → CSS)
            │  resolvePack         │  design/packs.ts:189  packOverrides spread (UNVALIDATED)
            │  buildDeclarations   │  capabilities/style   contrast lock, !important, viewport-safe
            │  laws                │  core/laws            fluidize, sanitize
            └──────────┬──────────┘
                       │  CSS string (text) + inline backstop handles
            ┌──────────▼──────────┐
            │  applyStyleEverywhere│  execute/index.ts:19  <style id=revueon-style>.textContent = css
            │  + applyInlineBackstop (head + every open shadow root)
            └──────────┬──────────┘
                       │  DOM now mutated (style injected, data-rv-c stamped, v1: ops applied)
            ┌──────────▼──────────┐
            │  verifyStyle         │  verify/index.ts:79  re-measures the LIVE DOM
            │  + pixelVerify       │  capture.ts → pixel.ts  void/invisible/squeeze
            └──────────┬──────────┘
                       │  gate decision (passed booleans + metrics)
            ┌──────────▼──────────┐
            │  planRepair          │  repair/index.ts  forceContrast/squeeze (free) OR critic (paid)
            └──────────┬──────────┘
                       │
              ┌────────┴────────┐
        FAIL                  PASS
        │                       │
   removeStyleEverywhere    persist → chrome.storage.local
   (DOM ops NOT undone!)   startDefenseEverywhere
                            return {ok, applied, changeScore, paidCalls, ...}
```

## State changes (what mutations the extension makes)

1. **`data-rv-c="<handle>"` attribute** stamped on each cluster rep (`perceive:523`). This is the identity surface.
2. **`<style id=revueon-style>`** created/appended to `<head>` and every open shadow root (`execute:19-28`). `textContent` holds the compiled CSS.
3. **`data-rv-grid` attribute** (v2) on the NCA, intermediates, full-width, proxies (`solve:491,511,529,547`) — targeting for grid CSS.
4. **Inline `style` overrides** (`applyInlineBackstop`, `content.ts:509`) — `!important` bg+text on contrast-failing clusters. **NOT persisted, NOT re-applied on reload** (`reapplyStored:1196`).
5. **Structural DOM ops** (v1): move/remove/reorder/wrap (`content.ts:797` `executeOps`). Recorded in `txnLog` for undo.
6. **`revueonRunInFlight`** sessionStorage flag (`content.ts:407`) — popup reads it to show "in progress".
7. **`data-revueon-applied`/`data-revueon-failed`** on `<html>` (`content.ts:133-140`).
8. **Escape UI button** appended to `documentElement` (`execute:125`).

## Storage (`chrome.storage.local`)

| Key | Written by | Read by | Purpose |
|---|---|---|---|
| `cloudflare_account_id`, `cloudflare_api_token` | test harness (or user, but UI is dead) | `background.ts:36` | AI creds |
| `openai_api_key` | `popup/main.ts:30` | **nothing** | DEAD — leftover from the OpenAI path |
| `<site-state key>` (per-origin) | `persist/index.ts` via `content.ts:1042` | `reapplyStored` | spec + CSS + compileOptions |
| `revueonRunInFlight` | `content.ts:407` (sessionStorage actually — `content.ts` uses a session flag) | `popup/main.ts:148` | in-progress indicator |

**Security note:** `chrome.storage.local` is **unencrypted at rest** (a JSON file in the profile dir). The API token is readable by any process with profile-dir access. No `chrome.storage.session`, no keychain. (See `11_SECURITY_ANALYSIS.md`.)

**UNVERIFIED:** `chrome.storage.local` quota (`QUOTA_BYTES`, default ~10MB) on a large spec with many rules — a quota throw inside the persist path could leave no saved state.

## AI context (what enters the model)

`reason/index.ts:265` assembles the `user` message:
```
USER REQUEST: <intent>

RUNTIME PAGE PERCEPTION:
<serialized perception>
```
The serialized perception (`perceive:1219` / `:1371` for v2 painter) contains, per cluster:
- `handle` (the `data-rv-c` value, e.g. `c1a2b3`)
- `role` (masthead/nav/main/footer/ad-or-void/…)
- `dominance` rank
- text samples (cluster text content)
- colors, fonts
- (v2) slot assignment

**v2 painter payload was trimmed in S4.1** to role+slot+dominance+handle+tag+signals only (~9K chars vs v1 ~30K+, ~70% reduction) — no geometry/rects/parent-child in v2. **v1 painter payload is untouched (~30K+ chars).**

**Privacy:** this is **page text content** shipped to `api.cloudflare.com` with the bearer token. There is **no PII redaction, no domain allowlist, no consent gate**. A bank/medical/email page sends its visible text to a third party. (See `11_SECURITY_ANALYSIS.md`.)

## Serialization / deserialization

- **Perception → text:** `serializePerception` (`perceive:1219`) / `serializeV2Painter` (`perceive:1371`) / `serializePainterPerception` (`perceive:1334`). Compact line-based text.
- **Model → StyleSpec:** `reason/index.ts` parses the model's JSON `response` (`:331` `JSON.parse`). Validated by `validateSpec` (`spec:197`). Hallucinated handles land in `invalidTargets` (`compile:301`); hallucinated roles resolve to `[]` and are dropped (`expand:174`).
- **Spec → CSS:** `compileSpec` (`compile/index.ts`) → `expandIntents` → `buildDeclarations` → laws → a CSS string. The CSS is keyed on `[data-rv-c="<handle>"]` (v1) or `buildSelector`/`[data-rv-grid]` (v2).
- **CSS → DOM:** `applyStyle` (`execute:19`) sets `<style>.textContent`.
- **CSS → storage:** `persist` saves the spec + the CSS text + compileOptions. On reload, `reapplyStored` re-compiles from the stored spec (not from the stored CSS directly, though it reads the live `<style>` textContent as authoritative — `content.ts:1039`, a racy read).

## The identity round-trip (the fragile link)

```
perceive:523  stamp  data-rv-c="<handle>"  ──►  serialized handle in prompt
                                                     │
                                                     ▼  (model emits the same handle)
compile:302   rule.target = handle  ──►  [data-rv-c="<handle>"]  ──►  CSS matches the stamped node
                                                     │
                                                     ▼  (framework re-renders the node)
                                            data-rv-c GONE  ──►  CSS stops matching
                                                     │
                                                     ▼  (MutationObserver startDefense re-stamps)
                                            ... if it catches it in time
```
**100% of v1 CSS is keyed on the runtime-injected `data-rv-c` attribute** (`perceive:503`). `solve.ts:23` claims "data-rv-c is a DEBUG label only; nothing in emitted CSS depends on it" — **that is false for v1** (verified). v2 swaps to `buildSelector`/`data-rv-grid` but those are also injected attributes with the same survival problem.

## Data that does NOT survive

- **Inline backstop styles** are not persisted and not re-applied on reload (`reapplyStored:1196`) → invisible text on reload.
- **`data-rv-c` stamps** inside shadow roots can't be cleared by `clearHandles` (`perceive:1115` uses `document.querySelectorAll` — light tree only) → stale stamps leak across runs.
- **Structural ops** executed before verify are NOT undone on failure (RC3).
- **Site-added inline styles** are wiped on undo by `wmPrevCss` restore (`transaction:95`).

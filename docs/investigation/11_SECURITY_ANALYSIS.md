# 11 — Security Analysis

> CSP, Trusted Types, permissions, injection, messaging, extension attack surface.
> Every claim cites `file:line`. Speculation is marked **UNVERIFIED**.

## Permissions (`wxt.config.ts:8-10`)
- `permissions: ['activeTab', 'storage']`
- `host_permissions: ['<all_urls>']`

`<all_urls>` host permission means the content script runs on **every site**, and `host_permissions` grants network access to every origin from the service worker. This is the maximum-surface default.

## 1. PII exfiltration by design (HIGH)
- **Evidence:** `reason/index.ts:265-266` `userContent = "USER REQUEST: ${intent}\n\nRUNTIME PAGE PERCEPTION:\n${perception}"`. The serialized perception (`perceive:1219`) includes **cluster text samples, fonts, colors, DOM structure**. `reason:303-307` POSTs to `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions` with `Authorization: Bearer ${apiToken}`.
- **No consent gate, no domain allowlist, no PII redaction.** `host_permissions:<all_urls>` → every site.
- **Impact:** A user transforming a page showing bank balances, private messages, or medical results sends that visible text to Cloudflare Workers AI. The popup placeholder ("warm parchment manuscript…") gives no hint that page content leaves the machine.

## 2. API token in plaintext storage (HIGH)
- **Evidence:** `background.ts:36-38` reads `cloudflare_account_id`/`cloudflare_api_token` from `chrome.storage.local`. `reason:305` sends as `Authorization: Bearer ${apiKey}`.
- `chrome.storage.local` is **unencrypted at rest** (a JSON file in the profile directory). No `chrome.storage.session`, no OS keychain, no redaction in logs.
- **Impact:** Anyone with read access to the Chrome profile dir (or another process on a multi-user machine) can read the Cloudflare API token.

## 3. Dead auth UI → stored-key confusion (HIGH)
- **Evidence:** `popup/main.ts:25,30` read/write `openai_api_key`; `background.ts:36` reads `cloudflare_*` (RC8).
- **Impact:** A user may believe they've configured authentication and proceed, leaking data to a service they think is configured but isn't; or the product simply fails `invalid_key` for every real user.

## 4. No port auth on the keepalive (MEDIUM)
- **Evidence:** `background.ts:27` `chrome.runtime.onConnect.addListener(() => {})` — empty handler, no port-name check, no sender validation.
- **Impact:** Any caller with the extension's runtime id (a colluding extension) can keep the SW alive indefinitely or open many ports. A malicious page cannot connect (no runtime id access), but the keepalive has no auth boundary.

## 5. Sanitizer regex-bypass (HIGH)
- **Evidence:** `sanitize/index.ts:73-124` is **regex-based, not a real CSS parser**:
  - `@import` regex (`:73`) is bypassed by CSS hex escapes: `@\69 mport` (CSS escape for `i`) → `/@import/i` misses.
  - `url()` allowlist (`:108-112`) accepts all `data:` regardless of MIME → `data:image/svg+xml,<svg onload=…>` allowed (script-bearing SVG in CSS backgrounds, historically exploitable).
  - `expression()`/`-moz-binding`/`behavior:`/`javascript:` stripped, but CSS escapes bypass each.
  - No `@keyframes`/`@font-face`/`@media` block sanitization (`@keyframes` can drive clickjacking via opacity animation).
- **Impact:** A model emitting (or a future code path passing) crafted CSS could load external resources or, in legacy contexts, execute script via `data:image/svg+xml` SVG.
- **Mitigating factor:** the sanitizer runs on model output before injection (`content.ts:560`), and `<style>.textContent` assignment doesn't execute script directly; the realistic risk is resource-loading and the SVG-in-CSS vector.

## 6. `sanitizeMarkup` is dead (MEDIUM)
- **Evidence:** `sanitize/index.ts` defines `sanitizeMarkup` but it's never called in the apply path (grep: only the definition).
- **Impact:** If a future change injects HTML (e.g. an `innerHTML` somewhere), the HTML-sanitization backstop is inactive. Currently inert; a latent gap.

## 7. `DEBUG=true` ships page content to the console (MEDIUM)
- **Evidence:** `config/index.ts:86` `const DEBUG = true;` (hard-wired). `logDebug` (`:87-88`) logs every model call, retry, spec, dropped prop, including `reasoning` text and perception-derived handles. `content.ts:770` logs the full intents array as JSON. `reason:335` logs token usage.
- **Impact:** In a production extension this floods the devtools console (and any page-level console capture) with the user's page content fragments. No `import.meta.env.PROD` gate.

## 8. Unvalidated `packOverrides` (MEDIUM)
- **Evidence:** `spec/index.ts:241` `spec.packOverrides = r.packOverrides as Partial<DesignPack>` (bare `as`). `design/packs.ts:189-202` `resolvePack` spreads overrides directly with no type/shape check.
- **Impact:** A model could emit CSS-bearing strings or malformed objects; the spread-into-pack path is unguarded. The sanitizer runs later, but the pack-corruption path (`spacingScale` becoming a number → density no-ops) is silent.

## 9. Ops execute before verify (HIGH)
- **Evidence:** `content.ts:797` `executeOps(validated, true)` runs structural ops (move/remove/reorder/wrap) **before** `verifyStyle` (`:873`).
- **Impact:** A model-emitted `remove` on a mis-classified "ad" (a false-positive `voidToken` on a "Sponsored Projects" section, `semantic:239`) deletes real content; the gate runs **after** the op. Combined with RC3 (no op rollback on failure), this is irreversible content deletion.

## 10. Messaging attack surface (MEDIUM)
- **`captureVisibleTab(undefined)` (`background.ts:56`):** if `sender.tab` is missing, captures the last-focused window → wrong-page screenshot leak (information disclosure of another tab's content to the recolor baseline).
- **`inFlight` drop (`content.ts:1559`):** no busy reply → a rapid double-Transform can leave the popup hanging; not a security issue but a DoS vector against the user's own session.
- **`webmorphRunInFlight` persists after a tab crash** (`content.ts:407`) — not security, but a liveness bug.

## 11. CSP / Trusted Types
- **CSP:** `execute:19-28` injects `<style>.textContent = css`. Extension content scripts are generally exempt from page CSP in MV3, but inline-style property writes (`applyInlineBackstop`) and `documentElement.appendChild` (`execute:125`) may be affected. **UNVERIFIED** on a `style-src 'none'` strict site.
- **Trusted Types:** **No handling exists.** `textContent` on a `<style>` is not a Trusted-Types sink (only `innerHTML`/`script`/`eval` are tracked), but `style` property writes and `appendChild` may be on enforcing sites. **UNVERIFIED**.

## 12. Injection vectors
- The model's CSS is the injection surface. The sanitizer is the only backstop, and it's regex-based (§5).
- The escape UI button (`execute:125`) is built with `createElement` (no `innerHTML`) — safe.
- No `eval`/`Function` in the apply path. **UNVERIFIED** — `reason/index.ts` does `JSON.parse` on model output (safe); no `eval`.

## Summary risk table

| # | Risk | Severity | Evidence |
|---|---|---|---|
| 1 | PII exfiltration, no consent | HIGH | `reason:265,303` |
| 2 | API token plaintext | HIGH | `background:36` |
| 3 | Dead auth UI | HIGH | `popup:25` vs `background:36` |
| 4 | No port auth | MEDIUM | `background:27` |
| 5 | Sanitizer regex-bypass | HIGH | `sanitize:73-124` |
| 6 | `sanitizeMarkup` dead | MEDIUM | `sanitize` (never called) |
| 7 | `DEBUG=true` ships | MEDIUM | `config:86` |
| 8 | `packOverrides` unvalidated | MEDIUM | `spec:241`, `packs:189` |
| 9 | Ops before verify | HIGH | `content:797` vs `:873` |
| 10 | `captureVisibleTab(undefined)` | MEDIUM | `background:56` |
| 11 | CSP/TT unhandled | UNVERIFIED | no handling |

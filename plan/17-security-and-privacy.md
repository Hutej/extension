# Security, privacy and trust boundaries

**Proposed mandatory policy.** Scope: untrusted page/model/provider inputs, extension privileges, content handling and behavior effects. Existing source is not presumed secure merely because it executes in isolated world. [Runtime](08-transformation-runtime.md) and [provider](11-model-providers.md) enforce these contracts.

## 1. Threat model

Protect user credentials, private page content, original website behavior and user control from malicious page markup, prompt injection, malformed model output, compromised provider response, accidental cross-tab/route mutations, unsafe persistence/imports and injected HTML/CSS. Extension compromise or a fully compromised browser/OS is outside the isolation guarantee; do not promise encrypted-secret protection against it.

| Boundary | Untrusted input | Enforced constraint |
|---|---|---|
| Page → observation | Text, ARIA labels, attributes, URLs, CSS values | Minimize/label data; no page instructions promoted to system prompt; target facts remain evidence, not permission |
| Model → runtime | Proposal JSON/CSS values/annotations/action mapping | Exact schema, operation allowlist, target refs, risk grants, size/time bounds; no executable source |
| Content → broker | Message payload, spoofed target IDs/CSS | Browser sender.id/tab/frame/document verification; per-command role allowlist; independent CSS/bounds validation |
| Workspace → provider | Endpoint/headers/model/profile | Explicit host grant and disclosure; exact endpoint; reject redirects; no page-selected fetch destination |
| Storage/import → replay | Legacy/corrupt/tampered customization | Versioned validation and target re-resolution; quarantine unknown/unsafe |
| User gesture → native action | Shortcut/owned button | Trusted event, active scope, editable/modal checks, explicit action grant |

A closed ShadowRoot prevents ordinary stylesheet leakage into owned UI but does not secure the host from page removal/occlusion. DOM attributes are shared and spoofable; token namespaces prevent accidental collisions, not malicious page control. Safety authority comes from runtime references, grants and broker validation.

## 2. No executable model code

No eval, Function constructor, script elements, inline handlers, `javascript:` URLs, generated content scripts, MAIN-world remote code, userscript runtime or remote code dependencies. Model instructions never name browser API functions or arbitrary network requests. A provider “tool call” is just untrusted data decoded to the fixed response union; tool naming cannot bypass validation.

One insertUI operation creates native owned element trees for annotations, cards, panels, tables and local controls. The exact tag/attribute grammar is in [capability coverage](28-capability-coverage.md), rather than an annotation-only vocabulary. Local inputs cannot submit to a site, collect credentials/payment data or read original form values; button type is always button. No arbitrary HTML, SVG/MathML, inline event/style strings, form actions, iframe/object/embed, custom elements, URL-bearing images or arbitrary attributes. Styles/bindings use the same validated operation path and declared owned local refs. Links are existing observed safe links or explicit user-approved http/https destinations with opener isolation; don't validate schemes via startsWith('http').

Owned Canvas 2D accepts only the bounded drawing records defined in that contract. No arbitrary context method invocation, image URLs, pixel readback of the website, WebGL code or model-written callbacks. Accessible native controls stay outside the bitmap. Removing an owned drawing never rewrites/resets a page-owned canvas.

## 3. CSS security

Parse selectors/values structurally with pinned audited dependency and CSSOM support validation. Deny URL/network loading forms including escaped identifiers, nested functions, import/font/image-set, data images, external filters and custom-property indirection. Model custom properties obey property/value policy. The browser/parser supplies ordinary visual CSS vocabulary; a security/impact check remains mandatory for every declaration, including browser-supported properties. CSS.supports is never treated as an injection sanitizer. No CSS capable of broad scope escape through model-authored selector strings; generated selectors target owned token membership only.

Page CSS values can contain URLs/content too. Observation does not transmit arbitrary background-image strings or all CSS variables. Expose only validated safe values needed for design. Broker accepts compiled style messages only from registered runtime with current resource operation/grant; applies bounds/policy independently so a compromised content message is not an arbitrary privileged CSS service.

## 4. Credentials and provider connections

Provider host permission and page permission are separate. User explicitly configures endpoint and protocol. HTTPS default; explicit loopback-only HTTP for local models, no automatic LAN/private-network scan. Credentials may be Bearer/API-key/custom auth header per adapter, stored in trusted contexts and never sent to content scripts or placed in URLs. Browser-owned/forbidden headers rejected. Cross-origin redirect is rejected; credentials never follow redirect to another host. Do not disable TLS verification or add a remote proxy to bypass CORS silently.

An extension cannot guarantee provider retention. Disclosure states: selected page evidence/goal is sent to configured provider; retention follows provider policy; local customizations stay local unless exported. Do not claim “no page content on any server” while sending evidence to an API.

## 5. Consent and data minimization

Explicit first-run/provider-change acknowledgement identifies endpoint, data categories, use and limits. Merely opening settings is not consent. Add real opt-out: with model calls disabled, deterministic saved customizations/replay/toggle/undo continue; new natural-language planning is unavailable, and UI says so.

Default evidence excludes input/textarea/select values, password/email/payment fields, contenteditable and editors, hidden DOM/private attributes, cookies, storage contents, full URLs, source HTML, account tokens and raw screenshots. Regular expressions may redact residual content, but are not a substitute for field selection. Never run whole-JSON string replacement that mutates selectors/IDs/contracts. Credentials/PII can occur in visible text, title, labels, CSS values and paths; cap/omit sensitive fields and request explicit read permission for user-requested text tasks.

Raw page text is data, not instruction. Prompt labels distinguish user goal from untrusted page excerpts; runtime checks remain the real defense if the model follows prompt injection anyway. Model-authored output can reproduce page secrets: storage/export requires the same sensitivity treatment. Hashing low-entropy content does not anonymize it.

## 6. Permissions and reversible versus external effects

Least-privilege optional site permission; default activeTab for current session, broader persistent permission only on save approval. No generic content-script `runLoop` credential access. Messages that grant permissions/save provider settings/start a run originate from trusted workspace URLs in this extension. No `externally_connectable` page bridge by default.

Local presentation/text changes are reversible within documented conflicts. A native site button may cause an external side effect; generic activation always requires explicit binding review and trusted user action. Do not automatically replay such actions, execute them from observer events, or claim undo reverses backend activity. Read-only projections preserve a clear “local organization only” label.

## 7. Abuse and failure controls

Reject huge/recursive JSON, absurd selectors, thousands of CSS rules, nested operation groups/graph fields, invalid or forward owned-node references, oversized drawing records, unsupported fields, duplicate operation IDs with altered payload and expired grants. Quotas cover parse, queue, resource, storage and provider calls. Unknown/caught errors are not success. Permission revocation cancels pending work, disarms resources and rechecks saved applicability. Imports use the same validator as live model output.

## 8. Security tests and residual risks

Mandatory corpus: escaped CSS url/import/image-set; custom property URL laundering; malformed selector lists; HTML/SVG/event-handler strings as annotation text; prompt-injection labels; spoofed content messages; tab/frame/document substitution; endpoint redirect; secret-bearing URI/title; corrupted saved records; cancellation race; native activation in editor/IME; credential leakage scan of compiled bundles and exported diagnostics.

Residual risks: malicious page can remove/occlude owned UI or fight DOM changes; arbitrary site event handlers have unknowable downstream behavior; user-configured provider may store data; permissioned extension contexts can read stored credentials; browser API delivery can be uncertain. Document these honestly, suspend affected behaviors and retain the user's Stop/disable path. Security approval is a release gate, not a prompt sentence.

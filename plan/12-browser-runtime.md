# Browser and extension runtime realities

Purpose: document platform constraints that override source comments and architectural wishful thinking. **Platform facts** below were checked against linked Chrome/MDN documentation during planning. **Proposed** policies require the named browser tests; they are not already proven by this repository.

## 1. Supported platform

Initial target: Chromium MV3, proposed minimum Chrome 120, current stable, then Edge current stable. WXT remains the packaging tool. Tests must prove generated manifest/entrypoints against the pinned toolchain. Firefox/Safari support is a separate compatibility release, not inferred from use of `browser.*` aliases.

| Constraint | Fact / implication | Target policy |
|---|---|---|
| MV3 lifecycle | Worker may terminate after inactivity, long requests, or fetch responses taking >30s; global state is lost | Visible workspace hosts model calls; broker rehydrates and reconciles pending API receipts |
| Popup lifecycle | UI can close while run is active | Launcher only; side panel or extension tab for active session |
| Side panel | Chrome 114+; programmatic open Chrome 116+ requires user action | Global workspace panel, pinned document target; extension-tab fallback |
| Isolated world | Page JS globals/history function replacements are separate; shared DOM is not separate | No isolated-world pushState monkey patch as sole route detector |
| Messaging | Chrome uses JSON serialization; cannot pass Nodes/Maps/functions as execution state | Versioned JSON DTOs; Node/inverse state stays content-side |
| CSS injection | `insertCSS` resolves delivery, not intended effect; default frame is top; `removeCSS` needs exact bytes/origin | DocumentId-scoped single-target calls and resource receipts |
| CSS cascade | Author normal > user normal; user important > author important; transitions can outrank important | Explicit intentional USER-important overrides and bounded verification, no fake cascade model |
| cloneNode | Does not preserve listeners attached with addEventListener/property handlers, node identity or every live state | No clone replacement of native nodes for undo |
| CSP | MAIN-world code inherits page CSP; remote/eval execution restricted in MV3 | Only bundled deterministic code; model data is never script |
| DOM render scheduling | rAF and timers can be throttled/suspended in hidden/frozen documents | Deadline/visibility-aware settle; unavailable rendering is unknown |

## 2. Document and route lifecycle

A tab ID is not a document ID. Every mutation uses browserDocumentId plus runtime instance and route epoch. Full navigation destroys old native resources; receipts are pruned only on confirmed document destruction. SPA route changes retain DOM and injected CSS, so out-of-scope tokens/listeners must be explicitly removed before enrolling new targets.

Observe broker webNavigation commit/history/fragment events, runtime popstate/hashchange/pageshow and URL equality at command entry. Same-path query/hash navigation can change the view; privacy omission from provider payload must **not** imply ignoring navigation locally. Private full URL may be read transiently for local equality but is not logged or transmitted. When route state cannot be safely matched across reload, require manual resume or explicit route discriminator.

On `pagehide.persisted`, suspend provisional state and triggers. On `pageshow.persisted`, renew document handshake, check namespace expiry, invalidate style measurements, then reconcile. Never replay old provider replies. Prerendered/hidden documents cannot start a model run or activate interaction behavior; wait for activation and fresh identity. Extension update/reinjection disposes old runtime, detects existing instance and prevents duplicate listeners.

## 3. Frames and roots

Top document is P1 scope. Same-origin and permitted cross-origin frames get **their own runtime and DocumentKey** in P2; parent content script never bypasses SOP to reach them. Broker checks explicit host permission for each frame. User approval of top origin does not imply permission to send embedded third-party content to a model.

Version 1 proposals target **exactly one DocumentKey**. Workspace can explicitly select an eligible frame and start a separate frame-scoped run; cross-frame dependency groups and atomic combined proposals are rejected. Do not imply that an accepted change in one frame was rolled back because another frame's separate run failed. Disable tracks each registered document acknowledgement separately. Frame transformations are session-only in the first frame release; persistent matching of multiple similar frames requires a later scope-schema ADR and explicit user approval, never a saved frame index. This preserves a concrete support path without inventing distributed DOM transactions.

Open ShadowRoot styles require root-local resources. Constructable sheet assignment may be unavailable; use owned local style node fallback and verify. `::part`/CSS custom properties on a host can be exposed style capabilities; use only observed declared interfaces. Closed shadow descendants remain opaque. Null shadowRoot does not prove a closed root. No universal deep selector syntax crosses either frames or shadow boundaries.

## 4. Layout and interaction

Use CSS logical properties, intrinsic sizing, flex/grid, minmax/clamp and safe overflow behavior. `getComputedStyle().width` returning px does not reveal authored units. Pixel values are not inherently invalid. Browser viewport units, page zoom, device scale, visualViewport and font loading differ; record the relevant coordinate space rather than multiplying by devicePixelRatio indiscriminately.

A production run must never resize, move, maximize or activate a different browser window for verification. Responsive proof belongs to QA, with active resize monitoring only for actual user changes. No guarantee of “before first paint” from async webNavigation→storage→insertCSS. Prefer correctness over promising zero flash; measure replay flash separately.

Focus is mutable user state. Do not restore a captured focus target if the user moved focus after preview; return focus only when Revueon itself still owns the current focus and old target remains connected/focusable. Modal dialogs and browser top layer cannot reliably be overridden by huge z-index. Status panel must remain dismissible and nonblocking.

Native controls may require trusted activation. Synthetic click cannot grant that privilege; no model chooses a workaround. Frameworks can undo local mutations, recycle nodes or react to moving custom elements. Detect conflict and suspend rather than repeatedly fighting the page. Canvas content is not inspectable semantic DOM; operate only on exposed surrounding controls/containers.

## 5. Settling and memory

Settle targeted regions for two animation frames when visible; unrelated page transitions get a bounded 500ms settle wait. Explicitly authored finite motion uses its declared start/end verification up to 2s within the 5s local transaction deadline, not an accidental generic 500ms failure. Longer/unmeasurable motion remains explicitly unverified unless a supported nonblocking style check suffices; never invent measured endpoint coverage. Listen only to relevant element/property events and remove listeners/timers on success, timeout and abort. Infinite animation is not a reason to wait forever. Font/image loading can invalidate previous layout evidence and schedules another local check, not another model call.

Mutation/resize callbacks enqueue work only. Avoid layout-read/write interleaving in per-element loops. Use known affected targets and sentinels; optional full-page analysis remains bounded. Release detached-node strong refs in ledger after safe terminal cleanup. Do not retain full DOM clones or whole-page HTML for undo/snapshots.

## 6. Permission architecture

Initial permissions: storage, scripting, activeTab, webNavigation, sidePanel where supported. Persistent site application uses optional host permissions requested on user action; activeTab is temporary and insufficient for reload-wide/site-wide customizations. Provider endpoint host permission is separate. Default no debugger, cookies, webRequest, userScripts, unlimitedStorage, nativeMessaging or broad all-sites access. Dynamic content script registration follows approved site origins; revoke unregisters scripts and disarms active resources. Restricted system/store pages remain unsupported even with host permissions.

Canvas boundaries: CSS may style an existing canvas element/container, but changing its width/height attributes resets its drawing state/backing buffer and is forbidden on page-owned canvas. New owned Canvas 2D uses the bounded leaf contract in [capability coverage](28-capability-coverage.md): native drawing, owned resize observer, capped pixels, accessible fallback and no image/pixel extraction from the site. A screenshot/pixel surface is not a semantic DOM tree and exposes no universal API for editing a chart's bars or a game's objects.

## 7. Platform sources and release verification

Sources consulted:

- [Chrome service-worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle): idle/long request/fetch limits; persistence; opening a port alone is not a keepalive guarantee.
- [Content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts): isolated worlds, injection timing, frames, CSP and shared DOM.
- [Scripting API](https://developer.chrome.com/docs/extensions/reference/api/scripting): documentIds, style origins and exact removal semantics.
- [Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/messaging): JSON serialization and hostile content-script input.
- [Storage](https://developer.chrome.com/docs/extensions/reference/api/storage): local/session quotas and TRUSTED_CONTEXTS access.
- [Side panel](https://developer.chrome.com/docs/extensions/reference/api/sidePanel): availability and user-gesture opening.
- [CSS cascade](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Cascade/Introduction): origin/importance/layer/specificity/transition order.
- [Node.cloneNode](https://developer.mozilla.org/en-US/docs/Web/API/Node/cloneNode): native cloning boundaries.

Some fetched source pages contain runnable examples; they were consulted, not copied into implementation. Minimum-browser tests must still establish actual behavior of document-targeted CSS cancellation/removal, BFCache, dynamic registration, shadow sheet fallback, direct provider CORS and lifecycle suspension. If a platform behavior differs, consult [fallbacks](14-failure-and-fallbacks.md) and amend ADR, not add a hidden execution path.

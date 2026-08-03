# 15 — Refactoring Roadmap

> NOT an implementation plan. For each change: What · Why · Expected benefit · Trade-offs · Complexity · Dependencies.
> Evidence cited as `file:line`.

---

## R1 — Composed-tree resolution (deepQuerySelector)
- **What:** Add a `deepQuerySelector`/`querySelectorAllDeep` that pierces open shadow roots (and a stamped-root index for closed). Use it in `representativeFor` (`perceive:692`), `solve.computeGridPlacementCss` (`solve:380`), `exclusions.detectExclusions` (`exclusions:31`), `clearHandles` (`perceive:1115`).
- **Why:** RC1 — the walk descends into shadow roots (`perceive:253`) but every read-back is light-tree `document.querySelector` → shadow clusters default to `ad-or-void` (`:819`). YouTube and all web-component sites get no redesign.
- **Expected benefit:** Unblocks the product's headline target ("reshape ANY website") for web-component-heavy sites.
- **Trade-offs:** A root-index for closed shadow DOM requires stamping; open shadow DOM needs a tree-walk query (slower than `querySelector`). Identity for shadow content must remain structural.
- **Complexity:** Medium — one abstraction, several call-site updates.
- **Dependencies:** none (foundational). Blocks everything on web-component sites.

## R2 — Roll back DOM ops on failure
- **What:** Make the failure paths (`content.ts:913,954,983,924`) call `txnLog.undoAll(liveDom)` before `removeStyleEverywhere`. Guard with try/catch (see R9).
- **Why:** RC3 — failed transforms leave the DOM mutated → permanent silent structural data loss.
- **Expected benefit:** Failed transforms return the page to its original state.
- **Trade-offs:** `undoAll` after a framework re-render may throw (RC6) — must be combined with R9.
- **Complexity:** Low — one call in 4 paths + try/catch.
- **Dependencies:** R9 (undo safety).

## R3 — Fix the dead auth UI
- **What:** Wire the popup to the real Cloudflare keys (rename the field, change `popup/main.ts:25,30` to `cloudflare_*`), or add a proper settings UI for Cloudflare creds.
- **Why:** RC8 — every real user fails `invalid_key`; the popup saves a key the background never reads.
- **Expected benefit:** A real user can authenticate and use the product.
- **Trade-offs:** removes the "easy revert to OpenAI" affordance (`background.ts:31` comment) — acceptable since OpenAI is disabled.
- **Complexity:** Low.
- **Dependencies:** none.

## R4 — Clear the role cache on SPA navigation — DONE (S10.3b)
- **What:** Call `clearRoleCache` (`perceive:466`) in `handleRouteChange` and `reapplyStored`.
- **Why:** RC4 — `clearRoleCache` had 0 callers → stale roles for the whole SPA session.
- **Expected benefit:** Roles refresh on route change.
- **Trade-offs:** re-classification cost on each nav (perceive already re-runs).
- **Complexity:** Trivial — one line in two places.
- **Dependencies:** none.
- **Status:** ✅ DONE — `clearRoleCache` is now imported in content.ts and called in `handleRouteChange` (line 1331) and `reapplyStored` (line 1163).

## R5 — Fix the `semantic.ts` hash
- **What:** Apply the same modulo fix as `perceive:1488` to `semantic:390`.
- **Why:** H2 — the unfixed `.slice(-6)` causes group-id collisions for long handle lists.
- **Expected benefit:** Eliminates a class of group-id collisions.
- **Trade-offs:** none.
- **Complexity:** Trivial — one expression.
- **Dependencies:** none.

## R6 — Consent gate + redaction for page-content egress
- **What:** Warn the user (popup) that page text is sent to a third party; offer an opt-out/local-only mode; at minimum redact obvious PII patterns before serialization.
- **Why:** C3 — `reason:265` ships page text content to Cloudflare with no consent, allowlist, or redaction.
- **Expected benefit:** Privacy compliance; user trust.
- **Trade-offs:** redaction may degrade model context (false-positive redaction of benign content); an opt-out needs a local-only path that doesn't exist yet.
- **Complexity:** Medium (consent UI) – High (local-only mode).
- **Dependencies:** none for the consent UI; a local-only mode is a larger project.

## R7 — Enforce a real one-shot budget OR change the mandate
- **What:** Either enforce a true request budget (count HTTP requests incl. retries, abort the run when exceeded) OR change the mandate to reflect the ≥2-call reality. Surface the request count to the popup.
- **Why:** H4 — the one-shot mandate is impossible by construction (`content.ts:738` parallel + `:934` critic); retries re-bill up to 5× hidden.
- **Expected benefit:** Honest cost accounting.
- **Trade-offs:** a strict request budget may abort more often on transient errors.
- **Complexity:** Low (counting + display) – Medium (abort enforcement).
- **Dependencies:** none.

## R8 — Global 120s abort
- **What:** Add a transform-level `AbortController` wired to all fetches; abort the whole run at 120s, not just per call.
- **Why:** H5 — no global abort; runs hit ~145s.
- **Expected benefit:** Honors the documented hard abort; predictable UI.
- **Trade-offs:** aggressive abort may cut off a slow-but-valid model response.
- **Complexity:** Low-Medium.
- **Dependencies:** R7 (budget enforcement benefits from a shared abort).

## R9 — Undo safety (try/catch + non-destructive restore)
- **What:** Wrap `undoAll` (`transaction:81`) in try/catch; resolve inverses by handle (re-query) rather than live `Node` refs; restore inline styles additively (snapshot only Revueon-owned properties) instead of `cssText` wholesale (`transaction:95`).
- **Why:** RC6/H15/H16 — undo crashes/half-undoes after re-render; `wmPrevCss` wipes site inline styles.
- **Expected benefit:** Robust undo after SPA re-render; no site-state destruction.
- **Trade-offs:** handle-based re-resolution is more code; additive restore is more precise but slower.
- **Complexity:** Medium.
- **Dependencies:** R2 (failure-path rollback uses undo).

## R10 — `packOverrides` validation
- **What:** Validate shape/type before `resolvePack` spreads it (`packs:189`); reject non-object `typeRamp`/`spacingScale`/`colors`.
- **Why:** H8 — bare `as` cast (`spec:241`) → silent corruption or crash.
- **Expected benefit:** No silent pack corruption; fewer full-run crashes.
- **Trade-offs:** stricter validation may reject some valid-but-odd model output.
- **Complexity:** Low.
- **Dependencies:** none.

## R11 — `startDefense` circuit breaker
- **What:** Debounce + max re-insert count; if a site strips the style N times, stop and report.
- **Why:** H19 — unbounded re-insert loop → CPU bomb.
- **Expected benefit:** No CPU bomb on hostile sites.
- **Trade-offs:** a hard stop may leave a stripped site unstyled (acceptable — report it).
- **Complexity:** Low.
- **Dependencies:** none.

## R12 — Decouple the role classifier from viewport geometry
- **What:** Use parent-relative ratios everywhere (close the `normWidthFromParent` top-level gap, `perceive:762`); use `offsetTop`/logical position, not `getBoundingClientRect`, for position signals.
- **Why:** RC2/M2 — roles flip on resize/scroll.
- **Expected benefit:** Stable roles across viewport changes.
- **Trade-offs:** reworking classifier inputs touches the probe metrics; thresholds may need recalibration (must not be tuned to green the gate per the anti-fitting protocol).
- **Complexity:** Medium.
- **Dependencies:** none.

## R13 — `perceive` truncation flag
- **What:** Report `truncated=true` when `MAX_DEPTH`/`MAX_TIME` fire; have the gate refuse rather than apply a partial redesign.
- **Why:** M1 — silent partial perception.
- **Expected benefit:** No silent partial redesigns on large DOMs.
- **Trade-offs:** refusing more often on large pages (honest, but may frustrate users).
- **Complexity:** Low.
- **Dependencies:** none.

## R14 — `verifyStyle` perf (cache + batch + memoize)
- **What:** Cache `querySelectorAll([data-rv-c])` once per call; batch rect/style reads; memoize `effectiveBackground`; reduce forced reflows.
- **Why:** H20/M19/M20 — 8-10 scans + 3 reflows + O(depth²) recursion, runs 2-3× per transform.
- **Expected benefit:** Multi-hundred-ms saved per transform on large pages.
- **Trade-offs:** caching assumes the cluster set is stable during a verify call (true — no apply in between).
- **Complexity:** Medium.
- **Dependencies:** none.

## R15 — Real CSS sanitizer (or restrict `data:` MIME)
- **What:** Replace the regex sanitizer (`sanitize:73-124`) with a tokenizer-based one, or restrict `data:` to `data:image/*`; handle `@keyframes`/`@font-face` blocks.
- **Why:** H7 — regex-bypass via CSS escapes; `data:image/svg+xml` onload allowed.
- **Expected benefit:** Closes the injection surface.
- **Trade-offs:** a real tokenizer adds a dependency/size; MIME restriction is simpler.
- **Complexity:** Low (MIME restriction) – High (real tokenizer).
- **Dependencies:** none.

## R16 — Normalize DPI + capture-failure flag — PARTIAL (S10.3a)
- **What:** Normalize DPI in `capture.ts`; add a `captureFailed` flag so a broken capture can't report PASS.
- **Why:** H9/RC5 residual — false invisible-text on high-DPI; capture failure reports PASS.
- **Expected benefit:** Honest pixel gate; no false positives on high-DPI.
- **Trade-offs:** none.
- **Complexity:** Low.
- **Dependencies:** none.
- **Status:** ✅ captureFailed flag DONE (S10.3a) — added to `PixelVerifyResult`, `pixelVerify`, and all hard gate expressions in content.ts. DPI normalization NOT done (deferred).

## R17 — `DEBUG` gated to dev; reconcile v2 telemetry
- **What:** Gate `DEBUG` behind `import.meta.env.DEV` (`config:86`); stop fabricating the v2 ledger (`content.ts:716-722`).
- **Why:** M7/M8 — page content in production console; v2 perf blind.
- **Expected benefit:** No console spam; honest v2 metrics.
- **Trade-offs:** none.
- **Complexity:** Low.
- **Dependencies:** none.

## R18 — Modernize exclusions
- **What:** `addEventListener`-based map detection (`exclusions:123`); `overflow:clip` carousels (`:68`); non-transform virtualizers (`:97`); tighten `isJsControlledLayout` (`:116`) so `width:100%` doesn't exclude valid targets.
- **Why:** H11/H12/H13-region — maps/carousels/virtual-lists break; valid relayout over-excluded.
- **Expected benefit:** Fewer broken interactive components; more complete redesigns.
- **Trade-offs:** tighter `isJsControlledLayout` may under-exclude some real JS-controlled layout.
- **Complexity:** Medium.
- **Dependencies:** none.

## R19 — De-duplicate identity/hash utilities
- **What:** Extract a shared `structuralPath`/`buildSelector`/`hash` utility used by both `perceive` and `solve`.
- **Why:** M16 — two copies with different joiners; one hash fixed, one not.
- **Expected benefit:** No divergence; no duplicate-bug recurrence.
- **Trade-offs:** touches both modules.
- **Complexity:** Low-Medium.
- **Dependencies:** R5 (hash fix) folds in.

## R20 — Test the env-invariant and gate semantics
- **What:** Add a test asserting the `wxt.config.ts` define set covers `config/index.ts`'s env reads; pin `v2HardGates` membership.
- **Why:** 14_TECHNICAL_DEBT — the env invariant can brick the content script; gate semantics drift.
- **Expected benefit:** No silent content-script bricking on a new env var.
- **Trade-offs:** none.
- **Complexity:** Low.
- **Dependencies:** none.

## R21 — Emit-time plan assertion (S11.3)
- **What:** The solver emits a plan object `{ trackCount, slotToTrack, expectedColumns }` alongside the CSS. At verify time, `assertPlanHonoured` checks the rendered DOM against it: (1) distinct visual x-positions among non-full-width placed proxies === expectedColumns; (2) each placed slot's computed grid-column-start matches slotToTrack. `planHonoured` is a HARD gate.
- **Why:** H22 — `layoutReshaped` went green on a one-column MDN page (width deltas alone). The solver's own plan is a better source of truth than pixel-inferred reshape.
- **Expected benefit:** A redesign that collapses content to one column despite the plan saying two FAILS — deterministically, no pixels.
- ****Expected benefit:** Eliminates a class of false-green gates.
- **Trade-offs:** the plan assertion is structural (grid-column + x-position), not visual quality. A narrow sidebar that the eye reads as "one column" but IS at a different x-position passes planHonoured. Design quality remains the user's eye.
- **Complexity:** Medium — plan emission in solve.ts, assertion function in content.ts, hard gate wiring.
- **Dependencies:** none.
- **Status:** ✅ DONE (S11.3).

## Sequencing
**P0 (do first):** R1, R2, R3, R4 ✅, R5 (correctness blockers, low complexity).
**P1 (safety):** R6, R7, R8, R9, R10, R11.
**P2 (robustness/scale):** R12, R13, R14, R15, R16 ✅ (partial), R17, R18.
**P3 (debt):** R19, R20.

# 13 — Risk Register

> Every issue ranked Critical / High / Medium / Low with Probability · Impact · Priority.
> Evidence cited as `file:line`. Probability/Impact: 1 (low) – 5 (high). Priority = P0 (fix now) → P3.

## Critical

| ID | Issue | Evidence | Prob | Impact | Priority |
|---|---|---|---|---|---|
| C1 | Shadow-DOM resolution gap → YouTube/web-component sites get no redesign | `perceive:819`, `solve:380`, `exclusions:31` | 5 | 5 | P0 |
| C2 | Failed transform leaves DOM mutated (no op rollback on failure) → permanent structural data loss | `content.ts:913` vs `:1225` | 4 | 5 | P0 |
| C3 | PII exfiltration by design (page text → Cloudflare, no consent) | `reason:265,303` | 5 | 4 | P0 |
| C4 | Dead auth UI → every real user fails `invalid_key` | `popup:25` vs `background:36` | 5 | 5 | P0 |
| C5 | API token stored in plaintext `chrome.storage.local` | `background:36` | 3 | 4 | P1 |

## High

| ID | Issue | Evidence | Prob | Impact | Priority |
|---|---|---|---|---|---|
| H1 | `clearRoleCache` never called → stale roles for whole SPA session | `perceive:466` → RESOLVED (S10.3b: called in handleRouteChange + reapplyStored) | 5 | 4 | ~~P0~~ DONE |
| H2 | Unfixed `.slice(-6)` hash → group-id collisions | `semantic:390` | 4 | 3 | P0 |
| H3 | `bestNonBroken` dead → "keep best non-broken" guarantee unenforced | `content.ts:20` (0 calls) | 4 | 3 | P1 |
| H4 | One-shot mandate impossible (≥2 paid calls always + critic) + retries re-bill up to 5× hidden | `content.ts:738,934`; `reason:281` | 5 | 3 | P1 |
| H5 | No global 120s abort → runs hit ~145s | `config:52` vs `content.ts:482` | 3 | 3 | P1 |
| H6 | SW killed mid-fetch → 120s frozen spinner, no cancel | `background:27`; `content.ts:1129` | 3 | 3 | P1 |
| H7 | Sanitizer regex-bypass (`@import` escapes, `data:image/svg+xml` onload) | `sanitize:73-124` | 3 | 4 | P1 |
| H8 | `packOverrides` unvalidated → silent corruption or crash | `spec:241`; `packs:189` | 4 | 3 | P1 |
| H9 | Capture failure reports PASS (no `captureFailed` flag) | `pixel.ts:350`; `capture.ts` → RESOLVED (S10.3a: captureFailed flag in PixelVerifyResult, hard gate) | 3 | 4 | ~~P1~~ DONE |
| H10 | Ops execute before verify → mis-classified `remove` deletes real content | `content.ts:797` vs `:873` | 4 | 4 | P1 |
| H11 | `isMap` misses all modern maps → pan/zoom break | `exclusions:123` | 4 | 4 | P2 |
| H12 | `isJsControlledLayout` over-excludes (`width:100%`) | `exclusions:116` | 5 | 3 | P2 |
| H13 | `display:contents` content-loss (containing block/click-target/clipping) | `solve:515` → RESOLVED (S10.1: replaced with CSS subgrid) | 4 | 3 | ~~P2~~ DONE |
| H14 | `page-title`→masthead rips in-article h1 | `documentation.ts:38` | 4 | 3 | P2 |
| H15 | Undo crashes / half-undoes after framework re-render (no try/catch, live refs) | `transaction:81,23` | 4 | 4 | P2 |
| H16 | `wmPrevCss` restore wipes site inline styles on undo | `transaction:95` | 4 | 3 | P2 |
| H17 | `sourceOrder` is prominence order, mislabeled as document order | `perceive:515` → `ir:165` | 5 | 3 | P2 |
| H18 | `deepFreeze` doesn't freeze Maps → immutability contract runtime-false | `ir:211-214` | 5 | 2 | P3 |
| H19 | `startDefense` no circuit breaker → CPU bomb on style-stripping site | `execute:62` | 3 | 4 | P1 |
| H20 | `verifyStyle` layout thrashing (8-10 scans + 3 reflows, runs 2-3×) | `verify:79` | 5 | 3 | P2 |
| H21 | Void detector blind to inter-cluster regions — `detectVoids` only checks named `ClusterRect[]`; a large empty band BETWEEN clusters (GitHub's cream gap) has no rect and scores voids=0 | `pixel:85` → S11.5: `detectPageVoids` added (full-capture scan for flat regions >¼ viewport) | 4 | 3 | ~~P2~~ DONE |
| H22 | `layoutReshaped` is a relayout proxy, not a truth — went green on a one-column MDN page (width deltas alone) | `verify:199` → S11.4: demoted to advisory; `planHonoured` (S11.3) replaces it as the structural-reshape gate | 4 | 3 | ~~P2~~ DONE |

## Medium

| ID | Issue | Evidence | Prob | Impact | Priority |
|---|---|---|---|---|---|
| M1 | `MAX_DEPTH`/`MAX_TIME` silent truncation, no flag | `perceive:241` | 4 | 3 | P2 |
| M2 | Viewport-coupled role thresholds (resize/scroll flips) | `semantic:99-102` | 5 | 3 | P2 |
| M3 | `isCarousel` misses `overflow:clip` + variable-width | `exclusions:68` | 4 | 3 | P2 |
| M4 | `isVirtualized` misses TanStack/padding-spacer | `exclusions:97` | 4 | 3 | P2 |
| M5 | `mergeConstraints` validation computed-but-ignored | `solve:137` | 5 | 2 | P3 |
| M6 | `assignSlots` `excluded` param dead | `assign.ts:26` | 5 | 2 | P3 |
| M7 | `DEBUG=true` ships page content to console | `config:86` | 5 | 2 | P2 |
| M8 | v2 ledger fabricated zeros → perf blind | `content.ts:716-722` | 5 | 2 | P2 |
| M9 | `reapplyStored` doesn't re-run `applyInlineBackstop` → invisible text on reload | `content.ts:1196` | 4 | 3 | P2 |
| M10 | Shadow observer leak (pushed root orphaned after reassign) | `content.ts:1289,1252` | 4 | 2 | P2 |
| M11 | `noOverflow` delta tolerance hides blow-out | `verify:157` | 3 | 3 | P2 |
| M12 | `inFlight` second-message dropped silently → popup hangs | `content.ts:1559` | 3 | 2 | P2 |
| M13 | `revueonRunInFlight` persists forever after tab crash | `content.ts:407` | 3 | 2 | P2 |
| M14 | `captureVisibleTab(undefined)` captures wrong window | `background.ts:56` | 2 | 3 | P2 |
| M15 | Raw px `fontSize`/`padding` not fluidized → zoom-hostile | `expand:199,214,286`; `laws:442` | 5 | 2 | P2 |
| M16 | `buildSelector` duplicates `structuralPath` (divergence) | `solve:241` vs `perceive:407` | 3 | 3 | P3 |
| M17 | 429 `Retry-After` header ignored | `reason:383` | 3 | 2 | P2 |
| M18 | `isReasoningModel` over-matches "glm" substring | `reason:394` | 2 | 2 | P3 |
| M19 | `effectiveBackground` O(depth²) recursion, no memo | `verify:613` | 3 | 2 | P2 |
| M20 | `nearestCommonAncestor` O(N²×D) | `solve:310` | 3 | 2 | P2 |

## Low

| ID | Issue | Evidence | Prob | Impact | Priority |
|---|---|---|---|---|---|
| L1 | `meta\b` regex misses "metadata" | `semantic:177` | 3 | 1 | P3 |
| L2 | `voidToken` false-positives "sponsorship"/"promotional" | `semantic:239` | 3 | 2 | P3 |
| L3 | RTL `hasRightRail/hasLeftRail` inverted | `semantic:363` | 3 | 2 | P2 |
| L4 | `escapeHatchFraction` gamed by hallucination (denominator=1) | `expand:301` | 3 | 1 | P3 |
| L5 | `relocate` no-`to` refused silently | `expand:249` | 3 | 1 | P3 |
| L6 | `topbar` over-refused on unknown `moveSafety` | `expand:237` | 3 | 2 | P3 |
| L7 | `classifyInvisibleFailures` cascade-loss tautology | `pixel:250` | 4 | 1 | P3 |
| L8 | `checkConformance` regex breaks on `data:` URLs with `;` | `verify:686` | 3 | 1 | P3 |
| L9 | `captureShotAt` destroys user scroll (no save/restore) | `content.ts:222` | 5 | 1 | P3 |
| L10 | Mixed `browser.*`/`chrome.*` in popup | `popup:25,91` | 2 | 1 | P3 |
| L11 | Doc drift (`solve.ts:23` data-rv-c debug-only false for v1; `expand:104` 5 vs 6 chars) | `solve:23`, `expand:104` | 5 | 1 | P3 |
| L12 | `asDecls` coerces numbers to strings (unitless dropped) | `spec:463` | 3 | 1 | P3 |
| L13 | `sanitizeMarkup` dead | `sanitize` (never called) | 2 | 1 | P3 |
| L14 | No port auth on keepalive | `background.ts:27` | 2 | 2 | P3 |
| L15 | `hideRefusal` `rect.h>300` zoom-coupled | `compile:636` | 3 | 1 | P3 |
| L16 | `opaqueOr` rejects translucent model washes → canvas tone | `compile:888` | 3 | 1 | P3 |

## Priority summary
- **P0 (ship-blockers, fix now):** C1, C2, C3, C4, H1, H2.
- **P1 (safety/mandate):** C5, H3, H4, H5, H6, H7, H8, H9, H10, H19.
- **P2 (robustness/scalability):** H11–H20 (excl P1), M1–M14, M15, M17, M19, M20, L3.
- **P3 (debt/edges):** H18, M5, M6, M16, M18, L1, L2, L4–L16.

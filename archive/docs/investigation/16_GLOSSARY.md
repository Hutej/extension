# 16 — Glossary

> Beginner-friendly definitions of every important Revueon concept.

## Extension terms

**MV3 (Manifest V3)** — The current Chrome extension architecture. The background script is a *service worker* (ephemeral: Chrome kills it after ~30s idle). This is why Revueon keeps it alive with a port (`background.ts:27`) during a model fetch.

**Service worker (SW)** — The extension's background process. Holds the Cloudflare credentials and relays AI calls. It can be killed mid-fetch by Chrome under memory pressure, even with a keepalive port.

**Content script** — JavaScript the extension injects into web pages. Runs in an *isolated world* (separate JS context from the page, but shares the DOM). `entrypoints/content.ts` is the orchestrator.

**Popup** — The small HTML window that appears when you click the extension icon. `entrypoints/popup/main.ts` + `index.html`. It closes when it loses focus.

**`host_permissions: <all_urls>`** — A manifest permission letting the extension run on and access every website.

**`chrome.storage.local`** — Unencrypted-at-rest extension storage (a JSON file in the Chrome profile directory). Used for credentials and saved transforms.

## Pipeline terms

**Perception** — A structured description of the page captured by `perceive()`: clusters, roles, geometry, colors, fonts. The model's view of the page.

**Cluster** — A group of visually-similar DOM boxes treated as one unit. Each cluster gets a `data-rv-c` handle and a role.

**`data-rv-c` / handle** — A 6-character identifier (e.g. `c1a2b3`) stamped as an HTML attribute on each cluster's representative element (`perceive:523`). The model emits these handles; CSS targets them via `[data-rv-c="c1a2b3"]`. **This is the fragile identity surface** — it disappears if the framework re-renders the node.

**`data-rv-grid`** (v2) — A targeting attribute stamped by the solver (`solve:491,511,529,547`) for grid CSS, despite the "CSS-only" claim.

**Role** — One of 14 design classifications (masthead, nav-primary, nav-local, sidebar, toc, main, article-body, footer, actions-primary, listing, metadata, media, search, ad-or-void). Assigned by `semantic.ts classifyRole`.

**Design pack / visual pack** — A set of visual parameters (type ramp, colors, spacing). The model emits `packOverrides`; `resolvePack` merges them. Layout packs and visual packs compose per-primitive.

**Intent DSL** — The model's only contract: it emits *intents* ("make the sidebar recede", target `listing@group`), NOT raw CSS. The expander maps intents → CSS.

**StyleSpec / DesignSpec** — The model's structured response: intents, pack overrides, and optional ops. Validated by `validateSpec`.

**Layout IR** — (v2) An immutable projection of perception into 4-section nodes (semantic, authoredLayout, computedRelationships, targetConstraints). `extractLayoutIR`.

**Slot** — A position in a layout language. The Documentation language has 6 slots: masthead, nav-local, toc, main, aside→deleted, footer, overflow. `assignSlots` maps each node to exactly one slot.

**Overflow slot** — The mandatory catch-all at the end of document flow. Unmatched/unknown content goes here; nothing disappears.

**Solver** — (v2) Satisfies constraints: picks flex/grid, normalizes sizing, emits CSS. Sits below the expander.

**Hard gates** — Post-apply checks that fail the run: overflow, clipping, hidden content, horizontal scrolling, element overlap, reading-order violations. (Plus v2's: layoutReshaped, usesRoom, pixel voids/invisible, squeeze.)

**Advisory scores** — Computed but never blocking: alignment, spacing, hierarchy, whitespace, vertical rhythm.

**Paint 1 / Paint 2** — Two apply+verify attempts. Paint 1 is the first design; paint 2 is a recompile (often after repair). The regression guard reverts paint 2 if it regresses a hard gate paint 1 passed.

**Critic / reReason** — A paid repair call to the model on paint-1 failure. `requestCriticCorrection`.

**forceContrast / squeeze repair** — Deterministic (free) repairs. `applyInlineBackstop` sets inline `!important` bg+text on low-contrast clusters.

**Transaction log (`txnLog`)** — Records an exact inverse for every DOM op (move/remove/reorder/wrap) so the user can undo. Holds live `Node` refs (a hazard after re-render).

**`startDefense`** — A MutationObserver that re-inserts the `<style>` if the site removes it (`execute:62`).

**`startDynamicDefense`** — Re-styles on site mutations, re-perceives on bursts (`content.ts:1272`).

**Fixture mode (`RV_FIXTURES`)** — Test-only record/replay of model responses (no network). Dead-branched in production. `content.ts:1099`.

## Identity / stability terms

**Structural identity handle** — `hash(structuralPath(el))`. Tag + nth-of-type chain from a stable ancestor (id/data-testid/role/aria-label/name). Capped at depth 10.

**Sticky role cache** — Classify once per handle per session, reuse on every pass (`globalThis.__rvRoleCache`). **Never cleared** (RC4).

**Composed tree** — The real rendered tree including shadow DOM. Revueon walks it but reads back only the light (flat) tree — the core defect (RC1).

**Role stability / slot stability** — Probe metrics: how often a handle's role (or slot) stays the same across perturbations (resize/zoom/mutation). Gates require ≥0.90–0.95.

## Failure-mode terms

**FOUC** — Flash of unstyled content: the `data-rv-c` attribute is gone during a framework re-render → CSS stops matching → original styles flash until the defender re-stamps.

**Layout thrashing** — Interleaved layout reads and writes that force the browser to recalculate layout repeatedly. `verifyStyle` is the main offender.

**Forced reflow** — Reading a layout property (`scrollWidth`, `getBoundingClientRect`) after a write forces synchronous layout calculation.

**`display:contents`** — CSS that dissolves an element's box but keeps its children. Used by the v2 solver to flatten intermediates — but it also dissolves positioning, clipping, and click-targets.

## AI terms

**Architect** — The model role that picks an archetype and emits role intents + pack.

**Painter** — The model role that emits surface (colors/type). Runs in parallel with Architect.

**Critic** — The model role that repairs on failure (reReason).

**One-shot mandate** — The (claimed) rule: best design in exactly one paid model call. **Structurally impossible** (≥2 calls always).

**`paidCalls`** — Observability counter (counts *roles*, not HTTP requests). "NOT a gate" (`config:47-50`).

## Acronyms
- **NCA** — Nearest common ancestor (grid placement root).
- **IR** — Intermediate representation (Layout IR).
- **DSL** — Domain-specific language (the intent DSL).
- **DPI** — Dots per inch (display density). Not normalized in `capture.ts`.
- **CSP** — Content Security Policy.
- **SPA / MPA** — Single-page / multi-page application.
- **SW** — Service worker.
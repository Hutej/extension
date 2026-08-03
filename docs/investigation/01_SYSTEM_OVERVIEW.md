# 01 — System Overview

> Beginner-friendly architecture overview of the Revueon browser extension.
> Every claim cites `file:line` or a function name. Speculation is marked **UNVERIFIED**.

## What is Revueon?

Revueon is a **Chrome MV3 browser extension** built with the [WXT](https://wxt.dev) framework that reshapes *any* website from a plain-English prompt — entirely inside the user's browser. It never calls the site's backend. The user types a vibe (e.g. "1970s sci-fi paperback cover"), and Revueon re-skins and (in the v2 path) re-lays-out the page using a hosted AI model plus a deterministic CSS compiler.

- **Repo root:** `D:\Revueon`
- **Real codebase:** `project/` (extension + test harness)
- **Build/config:** `project/wxt.config.ts`, `project/package.json`
- **Manifest:** `project/wxt.config.ts:5-10` — `permissions: ['activeTab','storage']`, `host_permissions: ['<all_urls>']`

## The two pipelines (a flag, not a rewrite)

Revueon has two pipelines selected by a flag `layoutCompiler = 'v1' | 'v2'` (default **v1**), set via the `RV_LAYOUT_COMPILER` env var (`wxt.config.ts:26`, `config/index.ts:11`) and a popup dev toggle. The two are *meant* to be separate, but in practice the orchestrator (`content.ts`) is full of `if (v2)` branches — see `07_ARCHITECTURE_ANALYSIS.md`.

- **v1 (legacy, current default):** `perceive → reason (StyleSpec) → compile (expand+laws) → verify → repair → apply`. Emits per-element CSS keyed on a runtime-injected `data-rv-c` attribute. Can also emit structural DOM ops (move/remove/reorder/wrap).
- **v2 (new, behind the flag):** `perceive → extractLayoutIR → assignSlots → solve → computeGridPlacementCss → verify → apply`. Emits a CSS grid shell (`display:grid` on a common ancestor, `display:contents` on intermediates, `grid-column` on placed nodes). Intended to be **CSS-only** (no DOM reparenting) to avoid triggering framework re-renders — though it still calls `setAttribute` for targeting (see H9).

## Major subsystems

```
┌─────────────────────────────────────────────────────────────────────┐
│  POPUP  (entrypoints/popup/main.ts + index.html)                    │
│  User types prompt → chrome.tabs.sendMessage({action:'transform'}) │
└───────────────┬─────────────────────────────────────────────────────┘
                │ message
┌───────────────▼─────────────────────────────────────────────────────┐
│  CONTENT SCRIPT  (entrypoints/content.ts)  ← the orchestrator       │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────┐  ┌──────────┐  │
│  │ perceive │→ │  reason  │→ │ compile  │→ │ verify │→ │ repair   │  │
│  └──────────┘  └──────────┘  └──────────┘  └────────┘  └──────────┘  │
│       │              │             │           │            │         │
│  ┌────▼────┐  ┌──────▼─────┐ ┌──────▼─────┐ ┌───▼────┐ ┌────▼─────┐  │
│  │ layout  │  │ background │ │ execute    │ │ ops    │ │ persist   │  │
│  │ (ir/    │  │ (service   │ │ (apply     │ │ (move/ │ │ (storage) │  │
│  │ solve)  │  │  worker)   │ │  style)    │ │ remove)│ │           │  │
│  └─────────┘  └───────────┘ └───────────┘ └────────┘ └───────────┘  │
└─────────────────────────────────────────────────────────────────────┘
                │ messages
┌───────────────▼─────────────────────────────────────────────────────┐
│  BACKGROUND  (entrypoints/background.ts) — service worker            │
│  Holds Cloudflare creds; forwards perception to AI; captures tabs.   │
│  AI calls go to Cloudflare Workers AI (api.cloudflare.com).          │
└─────────────────────────────────────────────────────────────────────┘
```

### Subsystem responsibilities

| Subsystem | Main file(s) | Responsibility |
|---|---|---|
| **Popup** | `entrypoints/popup/main.ts`, `index.html` | UI: prompt box, Transform/Toggle/Remove buttons, settings (dead — see below) |
| **Content orchestrator** | `entrypoints/content.ts` (1603 lines) | Message handling, the run pipeline, hard-gate decisions, undo, observers, persistence |
| **Perception** | `core/perceive/index.ts` (1489), `core/perceive/semantic.ts` | Walk DOM → cluster → stamp `data-rv-c` → role-classify → serialize |
| **Layout IR / Solver** | `core/layout/ir.ts`, `assign.ts`, `solve.ts`, `exclusions.ts`, `languages/documentation.ts` | (v2) project perception into frozen IR, assign slots, solve constraints, emit grid CSS |
| **AI transport (reason)** | `core/reason/index.ts` | Build prompts, call Cloudflare Workers AI, validate/retry |
| **Spec types/validation** | `core/spec/index.ts` | `StyleSpec`/`DesignSpec` types + `validateSpec` |
| **Compile** | `core/compile/index.ts`, `core/compile/expand.ts` | Expand model intents → CSS declarations; packs/laws |
| **Design packs** | `core/design/packs.ts` | Visual packs (typeRamp, colors, spacing), role styles |
| **Execute** | `core/execute/index.ts` | Inject `<style>`, defense MutationObserver, escape UI |
| **Verify** | `core/verify/index.ts`, `pixel.ts`, `capture.ts` | Hard gates (overflow/hidden/overlap/squeeze/reading-order) + pixel audit |
| **Repair** | `core/repair/index.ts` | Deterministic free repair (forceContrast/squeeze) + paid Critic routing |
| **Ops / Transaction** | `core/ops/index.ts`, `core/ops/transaction.ts` | DOM move/remove/reorder/wrap + undo transaction log |
| **Sanitize** | `core/sanitize/index.ts` | Strip dangerous CSS/HTML vectors |
| **Capabilities** | `core/capabilities/style/index.ts`, `structure/index.ts` | Build safe `!important` declarations, contrast lock, viewport-safe widths |
| **Persist** | `core/persist/index.ts` | Save spec+CSS+opts to `chrome.storage.local` |
| **Config / Laws** | `core/config/index.ts`, `core/laws/index.ts` | Model config, env vars, constants, browser laws, fluidize |

### What does NOT exist
The investigation brief asked about **offscreen document, options page, side panel, React/Vue/Svelte UI**. None exist:
- No `offscreen` permission or document (`wxt.config.ts:8`).
- No options page, no side panel.
- The popup is plain HTML + vanilla TS (`entrypoints/popup/index.html`, `main.ts`) — no framework.
- The content script is the only page surface.

## Component relationships (who calls whom)

- **Popup → Content:** `chrome.tabs.sendMessage` (`popup/main.ts:129`).
- **Content → Background:** `chrome.runtime.sendMessage` for `styleSpec` (AI) and `captureVisibleTab` (screenshot) (`background.ts:29,55`).
- **Content → Background:** `chrome.runtime.connect` keepalive port (`content.ts:406`, `background.ts:27`).
- **Content internal:** `perceive → (v2: extractLayoutIR/assignSlots/solve/computeGridPlacementCss) → askForSpec → compile → applyStyle → verify → planRepair → executeOps → persist → startDefense`.
- **Background → AI:** `reason/index.ts:265` POSTs to `api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`.

## Beginner-friendly explanation

Think of Revueon as a four-stage factory:

1. **Look** (`perceive`): "Walk the page, group similar boxes, give each group a name (`data-rv-c`) and a job title (role: masthead/nav/main/footer/ad)."
2. **Think** (`reason` + AI): "Send a compact description of the page plus the user's vibe to an AI. The AI returns instructions — make the sidebar recede, use this type ramp, move this cluster."
3. **Build** (`compile` + `execute`): "Turn those instructions into safe CSS, lock text colors against backgrounds, inject a `<style>` tag."
4. **Check** (`verify` + `repair`): "Did we overflow the page? Hide content? Break reading order? If yes, try to fix it deterministically, or roll back."

The whole thing is reversible: a transaction log records every DOM op so the user can Toggle/Remove. **(Caveat: the failure path does NOT undo ops — see `08_ROOT_CAUSE_ANALYSIS.md` RC3.)**

## The headline risk (one paragraph)

The product's correctness rests on two fragile pillars: (1) **identity** — every CSS rule targets a runtime-injected `data-rv-c` attribute that disappears the moment a framework re-renders the node; and (2) **perception** — which walks shadow roots but reads them back with light-tree `document.querySelector`, silently classifying all web-component content (YouTube) as empty voids. These are verified defects, not speculation. The detailed evidence is in the rest of this documentation set.

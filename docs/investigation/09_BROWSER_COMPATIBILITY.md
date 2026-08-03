# 09 — Browser Compatibility

> Per-framework/site compatibility analysis. Every claim cites `file:line`.
> **VERIFIED** = traced to source; **INFERRED** = strong inference from verified behavior; **UNVERIFIED** = not tested.

## Frameworks

### React
- **VERIFIED** — `isJsControlledLayout` over-excludes (`exclusions.ts:116`): regex `/(?:width|height|transform)\s*:\s*\d/` matches `width:100%` → any `style={{width:'100%'}}` excluded from relayout.
- **VERIFIED** — CSS keyed on `data-rv-c` (`perceive:503`) → React re-render drops the attribute → CSS stops matching until the MutationObserver re-stamps. Guaranteed FOUC.
- **INFERRED** — v1 DOM reparenting (`executeOps`) breaks React controlled-component state (the roadmap's S6.3 blocker: moving nodes triggers React reconciliation → content removal).
- **INFERRED** — styled-components/emotion hashed class names (`sc-1a2b3c`) → `classTokens` (`perceive:722`) has no semantic tokens → classifier falls to geometry → unstable.

### Vue
- **VERIFIED** — `setAttribute('data-rv-grid',…)` (`solve:491,511,529,547`): Vue may reconcile attributes it didn't author → overwrites `data-rv-grid` → CSS selector stops matching → grid breaks.
- **INFERRED** — `v-bind` class objects produce dynamic classes → `classTokens` churns per render.

### Angular
- **INFERRED** — attribute binding may overwrite `data-rv-grid`; content projection templates can exceed `MAX_DEPTH=30` (`perceive:241`).

### Next.js
- **INFERRED** — App Router Server Components + hydration: `data-rv-c` dropped during hydration → FOUC; RSC streaming may exceed the 6s perception cap.

### Nuxt / Remix / Astro / Solid / Svelte
- **INFERRED** — all SPA-style re-render drops `data-rv-c`/`data-rv-grid`; Solid's fine-grained updates and Svelte's class directives churn `classTokens`. Svelte may reconcile `data-rv-grid`.

## Shadow DOM

### Open shadow DOM
- **VERIFIED** — stamped (`perceive:253`) but unresolvable (`representativeFor:692` light-tree `document.querySelector`) → `ad-or-void` (`:819`). All web-component sites affected.
- **VERIFIED** — `clearHandles` (`perceive:1115`) uses `document.querySelectorAll` → can't clear shadow stamps → stale `data-rv-c` leaks across runs.

### Nested shadow DOM
- **VERIFIED** — same gap; each level stamps but read-back is flat-tree.

### Closed shadow DOM
- **VERIFIED** — `el.shadowRoot` is null (`perceive:253`) → never walked → invisible.

## Portals
- **INFERRED** — React portals / Vue Teleport move subtrees to `body`; depth can exceed `MAX_DEPTH=30` → subtree abandoned (silent).

## iframes
- **VERIFIED** — never entered (`perceive:22` doesn't list IFRAME but `.children` is empty for cross-origin; same-origin `contentDocument` not traversed). An ad iframe is a bare `<iframe>` → `ad-or-void`.
- **VERIFIED** — a container *around* an iframe isn't excluded → solver relayouts around it → can break iframe sizing.

## Cross-origin iframes
- **VERIFIED** — impossible to enter; treated as bare elements.

## CSP (Content Security Policy)
- **VERIFIED** — style injected via `<style>.textContent` (`execute:19-28`), not `setAttribute` on the style element — generally CSP-safe for `style-src 'unsafe-inline'` (extensions are exempt from page CSP by default in MV3, but `content_scripts` inherit the page CSP for inline styles in some Chrome versions).
- **UNVERIFIED** — behavior on a site with `style-src 'none'` or a strict CSP that blocks extension-injected styles. Extension content scripts typically bypass page CSP, but this needs a test matrix.

## Trusted Types
- **VERIFIED** — **No Trusted-Types handling exists.** `<style>.textContent = css` (`execute:19`) is generally not subject to Trusted Types (textContent isn't sink-tracked like `innerHTML`), but inline `style` property writes (`applyInlineBackstop`) and `document.documentElement.appendChild(btn)` (`execute:125`) may be on sites enforcing Trusted Types.
- **UNVERIFIED** — needs a test on a Trusted-Types-enforcing site.

## Sites

### Gmail
- **INFERRED** — 6s perception cap (`perceive:241`) truncates the dense DOM → partial IR; `width:100%` over-exclusion (`exclusions:116`) skips most flex items → minimal redesign.

### Notion
- **INFERRED** — `contenteditable` → excluded (`exclusions` editable rule), but the block chrome isn't; deeply nested block trees exceed depth 30 → orphaned blocks.

### Figma
- **INFERRED** — canvas excluded (`exclusions` canvas/media tag), but dense UI around it hits MAX_DEPTH/MAX_TIME; `isMap`-style heuristics misfire on the canvas wheel handlers (`onwheel` may be set via addEventListener → missed).

### GitHub
- **VERIFIED (documented)** — Turbo morph re-renders content (`product.md` S6.3): `data-rv-c` stamps on recycled nodes → `txnLog` inverses reference recycled nodes → undo replays against wrong nodes → `insertBefore` `NotFoundError` (RC6).

### Google Docs
- **INFERRED** — `contenteditable` excluded; the dense surrounding UI hits the 6s cap → partial.

### Reddit
- **INFERRED** — mostly light DOM (OK), but infinite-scroll virtualization missed by `isVirtualized` (`exclusions:97` only catches `abs+translate`; TanStack uses `top/left`) → relayouted → scroll breaks.

### YouTube
- **VERIFIED** — shadow-DOM resolution gap (RC1): `ytd-*` custom elements stamped but unresolvable → feed classified as `ad-or-void` → no redesign.

### MDN / Wikipedia
- **VERIFIED (roadmap)** — the v2 pipeline's by-eye gate sites. MDN applies intermittently (Painter timeout 90s historically); Wikipedia + GitHub overflow/collapse on the shell grid (Steps 4-8). These are the architecture-validation sites, not stress sites.

### Twitter/X, Facebook, LinkedIn
- **INFERRED** — dense SPAs with heavy virtualization and re-render → `data-rv-c` churn + virtualization missed.

## Browser features

### Zoom
- **VERIFIED** — raw px `fontSize`/`padding` from the expander (`expand:199,214,286`) not covered by `fluidizeRawPxSizing` (`laws:442`) → zoom-hostile type/padding. `hideRefusal`'s `rect.h > 300` (`compile:636`) is zoom-coupled.

### High-DPI
- **VERIFIED** — `capture.ts` downscale + `Math.round` on sub-pixel rects (`perceive:247`) → false invisible-text (RC5 residual) and width-bucket flips.

### RTL
- **VERIFIED** — `hasRightRail/hasLeftRail` (`semantic:363`) physical → inverted for Arabic/Hebrew; `isLeft/Right` (`:101-102`) physical.

### Responsive / window resize
- **VERIFIED** — viewport-coupled thresholds (RC2) flip roles on resize; top-level regions use viewport-relative `widthRatio`.

### Browser extensions (password managers, ad blockers)
- **INFERRED** — inject DOM that perception clusters → spurious clusters get roles → pollute the redesign.

### Sandboxed frames
- **INFERRED** — same as cross-origin iframes; not entered.

### Browser isolation / multi-process
- **VERIFIED** — the service worker can be force-killed under memory pressure mid-fetch (`background.ts:27` keepalive is best-effort) → 120s hang.

## Summary table

| Target | Status | Root reason |
|---|---|---|
| YouTube / web components | ❌ no redesign | shadow-DOM resolution gap (RC1) |
| GitHub (post-Turbo undo) | ❌ undo crashes | live Node refs (RC6) |
| Reddit (infinite scroll) | ❌ scroll breaks | virtualization missed |
| Maps (Leaflet/MapLibre) | ❌ pan/zoom break | `isMap` misses addEventListener |
| Carousels (`overflow:clip`) | ❌ relayouted | `isCarousel` misses clip |
| React SPAs | ⚠ FOUC + over-exclusion | `data-rv-c` churn + `width:100%` excluded |
| Vue/Svelte | ⚠ grid breaks | `data-rv-grid` reconciled |
| RTL pages | ⚠ inverted rails | physical coordinates |
| High-DPI | ⚠ false invisible-text | DPI not normalized |
| Zoom | ⚠ zoom-hostile type | raw px fontSize/padding |
| CSP strict / Trusted Types | ❓ UNVERIFIED | no handling |

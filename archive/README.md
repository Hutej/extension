# Stage 0 Archive — Recovered Source Files

These are the 15 source files deleted from `project/src/` during the Stage 0
rewrite, recovered from git history via `git show <commit>^:<path>` and placed
here as **reference, not living code**.

**This directory does not compile.** It is outside `project/tsconfig.json`,
outside lint, outside the bundle. No tsconfig, no build config, no import
references it. It exists so the knowledge encoded in these files survives the
rewrite and can be read when a foundation or stage needs it back.

---

## How each file was recovered

| File | Deletion commit | Recovered from |
|------|----------------|----------------|
| `core/compile/expand.ts` | `2d15312` | `2d15312^` |
| `core/compile/index.ts` | `142776f` | `142776f^` |
| `core/perceive/enrichment.ts` | `a61402b` | `a61402b^` |
| `core/capabilities/act/index.ts` | `e80891a` | `e80891a^` |
| `core/capabilities/extract/index.ts` | `e80891a` | `e80891a^` |
| `core/capabilities/inject/index.ts` | `e80891a` | `e80891a^` |
| `core/capabilities/integrate/index.ts` | `e80891a` | `e80891a^` |
| `core/capabilities/store/index.ts` | `e80891a` | `e80891a^` |
| `core/sandbox/index.ts` | `e80891a` | `e80891a^` |
| `core/tools/index.ts` | `e80891a` | `e80891a^` |
| `core/understand/index.ts` | `e80891a` | `e80891a^` |
| `core/apply/index.ts` | `11c8e2b` | `11c8e2b^` |
| `core/bundle/index.ts` | `11c8e2b` | `11c8e2b^` |
| `core/observe/index.ts` | `11c8e2b` | `11c8e2b^` |
| `core/plan/index.ts` | `11c8e2b` | `11c8e2b^` |

---

## File-by-file map

### 1. `core/compile/expand.ts` (328 lines)

**What it knew:**
The deterministic intent expander — the Phase 2 pivot piece. The model emits
per-role design INTENTS (`RoleIntent[]`) in token grammar (spacing steps,
type-ramp roles, named accents, surface tiers); this file maps those intents
against a resolved design pack + the perception graph to produce concrete
`rules` / `composition` / `ops` the compiler already consumed. Pure,
deterministic, zero model calls.

**Key knowledge worth preserving:**
- **`DESTRUCTIVE_CONFIDENCE_FLOOR = 0.5`** — hard-safety rule: `hidden` /
  `collapse` intents are FORBIDDEN on roles the classifier is < 0.5 sure about.
  Enforced in code, not just the prompt. This is a constraint-solver pattern
  the new foundation should adopt directly.
- **Target resolution** — handles three target kinds: `handle` (one cluster),
  `group` (fan-out to siblings), `role` (fan-out by `designRole`). The
  `role@groupId` compound narrows a role to a specific sibling group — a
  pattern the model was already expressing.
- **Escape hatch metric** — `escapeHatchFraction` = raw-override handles ÷
  intent-resolved handles. > 20% on a grid run = a loud pivot-failure flag.
  This is a vocabulary-gap metric that measures whether the intent language
  is expressive enough.
- **Colour coverage (B11)** — after the base-coat harmonizer was deleted,
  addressed clusters with layout but no surface got no text colour → invisible
  text on a redesigned canvas. The fix gives addressed clusters the pack's
  text token from the design system. Not the base coat; a targeted colour
  assignment.
- **Topbar refusal** — refuses `width:100%` on a non-reorderable rail because
  widening in place overflows. This is a guard-law pattern: refuse the whole
  op, not half of it.
- **Density → spacing scale** — compact=step 2, comfortable=step 4,
  spacious=step 6, with line-height modulation (±0.1 from body ramp).

**What was wrong with it:**
Built on the semantic-IR pivot infrastructure (`DesignSpec`, `Perception`,
`Cluster`, `DesignRole`, `DesignPack`) that was deleted in Stage 0. The
expander itself was sound, but its dependencies were the pipeline that no
longer exists. The token-grammar principle (model never emits raw px/hex)
survives; the specific type system does not.

**Who will want it back:**
- **F5 (INTEGRITY)** — the destructive-confidence floor is a measurement-based
  guard that prevents removing misread content. The new agent needs this.
- **F6 (THE LOOP)** — the escape-hatch metric is the kind of vocabulary-gap
  signal that tells the model its language isn't expressive enough.
- **Any design/styling capability** — the token-grammar resolution pattern
  (intent → pack → CSS) is the correct architecture; the types need rebuilding
  but the logic is reusable.

---

### 2. `core/compile/index.ts` (17 lines)

**What it knew:**
Typed interface only: `CompiledStyles { css: string }` and
`Compiler { compile(plan: Plan): CompiledStyles }`. A stub — the real compiler
was elsewhere or never built.

**What was wrong with it:**
Depended on `Plan` from `../plan` which was a flat operation list (`hide` /
`isolate` / `act`). The new architecture has no `Plan` type — the agent reasons
about actions directly.

**Who will want it back:**
Nobody directly. The concept "compiled CSS output" survives in F2
(APPLICATION) — one stylesheet node in `@layer revueon` — but the `Compiler`
interface is too thin to matter.

---

### 3. `core/perceive/enrichment.ts` (450 lines)

**What it knew:**
C4–C10 perception enrichment functions that ran DURING perception (DOM access
available) and added the information the model was missing. Each is additive —
enriches the existing `Cluster` / `Perception` without changing what was
already emitted.

**Key knowledge worth preserving:**
- **C4 — Heading outline tree** (`buildOutline`): builds a real document outline
  from h1–h6, ARIA headings, and `role="heading"`. Produces a nested tree with
  depth, text, handle, and the region each heading governs. Walks shadow
  roots. The outline algorithm (stack-based level nesting) is correct and
  reusable. **F7 (SIGHT) wants this** — the model needs the document outline
  to understand page structure.
- **C6 — Colour as a model** (`buildColorModel`, `rgbToHsl`): parses every
  colour into HSL, derives the page's palette, detects relationships
  (complementary, analogous, monochrome, triadic by hue distance), and
  extracts surface geometry (radii, border widths, shadow spread, spacing
  rhythm). The brand detection (prominent position × frequency) is a good
  signal. The RGB→HSL→hex round-trip is correct. **Any design capability
  wants this** — the colour model is the raw material for design decisions.
- **C7 — Component-type taxonomy** (`classifyComponentType`): classifies a
  cluster into 18 recognisable types (card, list, table, form, hero, navbar,
  siderail, breadcrumb, tabstrip, modal, media, codeblock, quote,
  footer-links, cta, avatar-group, badge, pagination, unknown). Uses
  structural + content signals (tag, child structure, text shape, link
  patterns). Each classification carries a confidence number. **F7 (SIGHT)
  and F1 (IDENTITY) want this** — the component type is how the model
  understands what a region IS, which determines what it can become.
- **C8 — Density/rhythm/alignment** (`measureDensity`, `measureAlignmentEdges`):
  measures modal sibling gap (rhythm baseline), alignment edges (repeating
  x-positions quantized to 8px), and whitespace Gini coefficient (distribution
  of free space, 0–1, lower = more even). The Gini coefficient is a clever
  signal for whitespace evenness. **05_BROWSER_CRAFT.md wants this** —
  rhythm and alignment are browser-physics inputs, not gates.
- **C10 — Text understanding** (`analyzeText`): reading length, kind (prose,
  label, heading, number, code, none), direction (ltr/rtl/auto), longest
  unbreakable token, and DOM truncation state (text-overflow:ellipsis or
  -webkit-line-clamp). The comment says: "the longest token decides whether a
  track can safely narrow — the browser needs that number and so does the
  solver." This is **grid-track construction knowledge** — the longest
  unbreakable token is the minimum-content-size constraint for a grid track,
  which is exactly what `min-content` resolves to in CSS Grid. **Any layout
  capability wants this** — the longest token is the `min-content` floor.

**What was wrong with it:**
Depended on `Cluster` from `./index.ts` and `parseColor`/`colorfulness` from
`../../shared/color.ts` — the old perception infrastructure. The enrichment
functions themselves are pure (take signals as data, return structured data)
and don't decide anything — they observe. The deleted `index.ts` and
`shared/color.ts` are the dependencies that need rebuilding, not the
enrichment logic.

**Who will want it back:**
- **F7 (SIGHT)** — the outline tree, colour model, and component taxonomy are
  the raw material for sight. The agent needs to see what's on the page.
- **F1 (IDENTITY)** — the component classification is how a concept ("the
  comments", "the sidebar") resolves to elements.
- **05_BROWSER_CRAFT.md** — the density/rhythm/alignment measurements and the
  longest-token-as-min-content insight are browser-physics knowledge that the
  new CSS emission path needs.
- **Any layout/grid capability** — the longest-unbreakable-token measurement
  is the grid track minimum-content constraint. This is the "grid track
  construction" the user flagged as worth preserving.

---

### 4. `core/capabilities/act/index.ts` (22 lines)

**What it knew:**
Phase 4 (ACT / AUTOMATE) contract: `ActOp` with kinds `shortcut`, `clickFlow`,
`autoFill`, `unlockScroll`, `mediaMode`. Trust-boundary safety checks noted
(no submit/password/payment/cross-origin).

**What was wrong with it:**
Contract only — no implementation. The `ActOp` shape is speculative; the real
behavior engine lived in `apply/index.ts` which had the actual action types
and safety checks.

**Who will want it back:**
- **F2/F3 (APPLICATION/REVERSAL)** — the trust-boundary safety check pattern
  (no submit/password/payment/cross-origin) is the correct security model for
  behavioral ops. The `checkInteractionSafety` function in `apply/index.ts`
  is the real implementation of this idea.
- **Phase 4 (ACT)** — when behavioral capabilities are rebuilt, the `ActOp`
  shape is a starting point, but the real safety logic is in `apply/index.ts`.

---

### 5. `core/capabilities/extract/index.ts` (23 lines)

**What it knew:**
Phase 5 (EXTRACT) contract: `ExtractOp { target, fields, watch? }` and
`ExtractResult { records, extractedAt }`. Repeated children of a target
become records; field names map to relative selectors/attributes.

**What was wrong with it:**
Contract only — no implementation. The "watch" flag implies a polling/observer
model that was never designed.

**Who will want it back:**
- **Phase 5 (EXTRACT)** — when data extraction is built, this is a clean
  starting contract. The `target → repeated children → records` pattern is
  sound and matches how the perception system already groups clusters.

---

### 6. `core/capabilities/inject/index.ts` (21 lines)

**What it knew:**
Phase 3 (AUGMENT) contract: `AugmentOp { kind, html, css?, anchor? }` with
kinds `panel`, `overlay`, `control`, `background`. Sanitized HTML rendered
inside Shadow DOM so injected markup can't collide with or be broken by the
host page.

**What was wrong with it:**
Contract only — no implementation. The Shadow DOM isolation principle is
correct (matches AGENTS.md rule 8 — let the browser do browser work), but the
sanitization pipeline was never built.

**Who will want it back:**
- **Phase 3 (AUGMENT)** — the Shadow DOM isolation pattern is the correct
  architecture. Injected elements should never be in the host page's DOM
  context.
- **F5 (INTEGRITY)** — Shadow DOM isolation is also an integrity measure:
  injected elements can't break the host page and vice versa.

---

### 7. `core/capabilities/integrate/index.ts` (18 lines)

**What it knew:**
Phase 5 (INTEGRATE) contract: `IntegrateOp { kind, url?, payloadFrom? }` with
kinds `httpRequest`, `aiCall`, `export`. Explicit note: "External calls are
high-risk: every outbound destination must be user-approved before this ships."

**What was wrong with it:**
Contract only — no implementation. The `payloadFrom` reference to
`ExtractResult` couples extract and integrate tightly.

**Who will want it back:**
- **Phase 5 (INTEGRATE)** — the per-destination user-consent model is the
  correct security posture. AGENTS.md rule 14 (never send page content to a
  model for identification) is the privacy commitment; this contract respects
  it by requiring explicit approval for outbound calls.

---

### 8. `core/capabilities/store/index.ts` (17 lines)

**What it knew:**
Phase 5/6 contract: `KVStore { get, set, remove }` — durable key/value storage
wrapping extension storage behind a namespaced interface.

**What was wrong with it:**
Contract only — no implementation. Too thin to be wrong.

**Who will want it back:**
- **F4 (CONTINUITY)** — continuity across sessions needs durable storage.
  The `KVStore` interface is fine but `browser.storage.local` is the actual
  primitive; this is a one-line wrapper that probably doesn't need to exist
  as a separate module.

---

### 9. `core/sandbox/index.ts` (23 lines)

**What it knew:**
Phase 4+ contract: `CapabilityGrant { capability, allowed }` and
`SandboxContext { grants, origin }`. Behavioral ops run gated by explicit
grants — a saved tool can only touch the capabilities the user approved.

**What was wrong with it:**
Contract only — no implementation. The capability-permission model is correct
in principle but the `Capability` type from `understand/index.ts` was too
coarse (6 named capabilities).

**Who will want it back:**
- **Phase 4+ (ACT/COMPOSE)** — the capability-grant model is the correct
  security architecture for saved tools. A saved tool that can only hide
  elements should not be able to click buttons. The grant list is the
  permission boundary.

---

### 10. `core/tools/index.ts` (32 lines)

**What it knew:**
Phase 6/8 contract: `SavedTool { id, name, intent, match?, style?, createdAt }`
and `ToolRegistry { list, save, remove }`. The "Revueon builds you an extension
on demand" concept — a bundle of a transform plus metadata the user can
re-invoke and share.

**What was wrong with it:**
Contract only — no implementation. The `style?: StyleSpec` field ties it to the
old style pipeline. The `match?: string` origin/glob field is under-specified.

**Who will want it back:**
- **Phase 6 (COMPOSE)** — the saved-tool concept is the product's endgame
  (replace every browser extension). But it should be rebuilt on the new
  agent's action representation, not `StyleSpec`.

---

### 11. `core/understand/index.ts` (21 lines)

**What it knew:**
Parses the user's English request into a `Goal { intent, capabilities }`. The
`Capability` type union: `'style' | 'structure' | 'augment' | 'act' | 'extract' | 'integrate'`.
Phase 1 was a thin pass-through (every request → `['style']`); Phase 2+ would
decompose into a capability mix.

**What was wrong with it:**
The `understand()` function hardcoded `['style']` for everything — not a
real understanding step. AGENTS.md rule 1 says "every request goes to the
model" — hardcoding a capability list violates that. The model should decide
capabilities, not a function.

**Who will want it back:**
Nobody directly. The new agent's loop (F6) replaces this — the model receives
the request and decides what to do. The `Capability` type union is a useful
vocabulary for tool selection but should not be a static function.

---

### 12. `core/apply/index.ts` (517 lines)

**What it knew:**
The behavior engine — the most substantial implementation in this archive.
Applies a `Plan` to the DOM and manages behavioral side effects with teardown.

**Key knowledge worth preserving:**
- **Trust-boundary safety** (`checkInteractionSafety`): refuses submit buttons,
  submit inputs, forms with password fields, forms with payment inputs
  (`autocomplete*="cc-"`, `name*="card"`, `name*="payment"`), and cross-origin
  links. This is the real implementation of the safety checks that
  `capabilities/act/index.ts` only described. **F2 (APPLICATION) and any
  behavioral capability want this** — interaction safety is a hard requirement.
- **Teardown / reversal** (`teardownBehaviors`, `restoreScrollLock`):
  removes key listeners, restores scroll lock originals (overflow, position,
  top, width), aborts in-flight auto-load via `AbortController`. The
  scroll-lock restore is a **reversal pattern** — save originals before
  mutation, restore on teardown. **F3 (REVERSAL) wants this** — the exact
  pattern for reversible behavioral ops.
- **Tier 1 persistence** (`TIER1_TYPES = new Set(['unlockScroll', 'addShortcut'])`):
  certain behaviors persist across sessions (unlock-scroll, keyboard
  shortcuts). Others are ephemeral. The tier model is the right idea —
  not everything should survive a reload. **F4 (CONTINUITY) wants this.**
- **Re-identification at trigger time** (`reidentify`): when a keyboard
  shortcut fires, the target is re-resolved via a descriptor (not a stale
  DOM reference). This is the **identity re-resolution pattern** that F1
  needs — selectors must survive re-render, and a saved descriptor is the
  fallback when the `data-wm-id` is gone.
- **Action types**: `unlockScroll`, `scrollToTarget`, `clickTarget`,
  `expandAll`/`collapseAll` (aria-expanded + details), `autoLoadMore`
  (async loop with abort + cap), `addShortcut` (key parsing with
  shift/ctrl/alt modifiers, fires in non-input contexts only).
- **Primary content protection**: hide and isolate ops check against
  `findPrimaryContentNode()` — never hide the element that contains the
  page's primary content. This is a **scope guard on measurement** (AGENTS.md
  rule 11) — the guard checks what the target actually IS, not its name.

**What was wrong with it:**
- Applied CSS via inline `style` elements with `display: none !important` —
  a mutation-heavy approach that fights frameworks. AGENTS.md rule 8 says
  "prefer a stylesheet the cascade applies forever." The new architecture
  should use `@layer revueon` for visual changes, not inline style elements.
- Used `data-wm-id` / `data-wm-target` attributes stamped on DOM nodes —
  these are mutations that may not survive SPA re-renders. F1 (IDENTITY)
  requires selectors that survive re-render without stamped attributes.
- The `isolate` op walks the DOM tree hiding siblings up to body — an
  O(depth × siblings) mutation that's hard to reverse cleanly. The
  `tagIsolateSiblings` helper duplicates the logic from `applyPlan`,
  suggesting it was refactored mid-stream.
- Global module state (`activeKeyListeners`, `scrollLockOriginals`,
  `autoLoadAbort`, `transformCounter`) — not safe across multiple concurrent
  invocations. The new architecture should scope state per-invocation.
- The escape UI button is injected as a DOM element with inline styles —
  should be a Shadow DOM panel (the `capabilities/inject` contract had the
  right idea).

**Who will want it back:**
- **F3 (REVERSAL)** — the save-originals-then-restore pattern for scroll lock
  is the template for reversible behavioral ops. Every behavioral op needs
  this.
- **F2 (APPLICATION)** — `checkInteractionSafety` is the trust-boundary
  guard that must exist before any behavioral capability ships. The specific
  checks (submit, password, payment, cross-origin) are correct and complete.
- **F4 (CONTINUITY)** — the Tier 1 persistence model (which behaviors
  survive reload) is the right question. The answer will change, but the
  tier concept is sound.
- **F1 (IDENTITY)** — `reidentify` at trigger time is the re-resolution
  pattern. A saved descriptor that re-resolves to the current DOM element is
  the fallback when stamped IDs are gone.
- **Any behavioral capability** — the action implementations (scroll, click,
  expand/collapse, auto-load with abort + cap, keyboard shortcuts) are
  reusable logic, not just contracts.

---

### 13. `core/bundle/index.ts` (110 lines)

**What it knew:**
The `TransformBundle` — the output contract that was meant to replace the
flat `Plan`. Structured, reversible: `themeCss`, `domOps` (hide/move/inject),
`injectedMarkup` (Shadow DOM), `motion` (reserved), `behavior`. Plus global
limits: `MAX_THEME_CSS_BYTES = 256_000`, `MAX_DOM_OPS = 200`,
`MAX_INJECTED_NODES = 50`, `MAX_MOTION_SPECS = 50`, `MAX_BEHAVIOR_OPS = 50`.

**Key knowledge worth preserving:**
- **Global limits** — the budget constants are the right idea (AGENTS.md
  rule 12: anything a budget clips sets `truncated: true`). The specific
  values (256 KB CSS, 200 DOM ops) are calibration knobs, not laws.
- **Structured ops** — `DomOp` as a union of `hide | move | inject` is the
  correct representation for reversible structural changes. Each op is
  self-describing and individually reversible. **F3 (REVERSAL) wants this.**
- **`buildBundle` stub** — maps the old `Plan` into `TransformBundle`. The
  isolate-as-sentinel (`__isolate__${keepId}`) is a hack that signals the
  apply layer to run special logic — not a clean representation.

**What was wrong with it:**
- The `buildBundle` function was a stub that mapped a flat `Plan` into a
  `TransformBundle` shape — a bridge between two representations that both
  got deleted. The bridge was never tested.
- `MotionSpec` was reserved but never implemented — speculative structure.
- The `themeCss` field is "pre-sanitization" — the sanitization step was
  never built.

**Who will want it back:**
- **F3 (REVERSAL)** — the `DomOp` union (hide/move/inject) is the correct
  shape for reversible structural ops. Each op carries enough information to
  compute its inverse.
- **F2 (APPLICATION)** — the budget limits are the right discipline. The new
  agent should have per-action budgets that clip and report truncation.
- **Phase 3 (AUGMENT)** — the `injectedMarkup` + Shadow DOM pattern is the
  correct isolation model for injected elements.

---

### 14. `core/observe/index.ts` (493 lines)

**What it knew:**
The observation layer — `SemanticMap` builder + `DesignContext` extractor.
Synchronous, single-frame, read-only DOM scan. Tree-based, role/name/
accessibility oriented.

**Key knowledge worth preserving:**
- **`buildSemanticMap`** — walks the DOM tree (piercing shadow roots),
  classifies each element by semantic role, computes accessible name,
  classifies media, detects repeated children, infers names from child
  headings, and produces a tree of `SemanticNode` objects. Each node carries
  id, role, tag, name, media class, rect, viewport flag, area, repeat count,
  preview text. **F7 (SIGHT) wants this** — this IS sight. The agent needs to
  see the page as a semantic tree.
  - Deduplication: if a wrapper has one child with the same role+name,
    reparent (skip the wrapper). This is the correct simplification.
  - Presentational wrappers (no role, no name, no direct text) are skipped
    and their children reparented.
  - Repeated children detection: if 3+ children share a tag|role signature,
    stamp the repeat count. This is how the agent recognizes list items.
- **`getSemanticRole`** — implicit role map: `nav`→navigation, `main`→main,
  `aside`→complementary, etc. Explicit `role` attribute wins. Falls back to
  tag-based inference. Correct and complete.
- **`getAccessibleName`** — full accessible name computation: aria-labelledby,
  aria-label, alt, title, placeholder, direct text. 80-char truncation.
  Correct algorithm.
- **`serializeForAI`** — token-budgeted outline with priority scoring.
  Landmarks (+100), interactive (+100), named (+50), in-viewport (+20),
  depth penalty. When over budget, drops lowest-score nodes first, keeping
  essential nodes (score ≥ 50) with a 2000-char grace. Returns `truncated:
  true` when clipping occurs. **This is AGENTS.md rule 12 implemented
  correctly.** F6 (THE LOOP) wants this — the model needs a budget-bounded
  view of the page.
- **`extractDesignContext`** — samples body, html, and representative
  selectors (main, nav, header, footer, aside, article, section, h1-h3, p,
  a, button, input) for backgrounds, text colours, accent colours, font
  families, border radii, spacing rhythm. Returns capped arrays (5/5/3/3/3/5).
  **F7 (SIGHT) wants this** — design context is part of seeing the page.
- **`findPrimaryContentNode`** — finds the element with the most text that
  has < 30% interactive-text ratio and covers > 5% of the viewport. This is
  **primary content detection** — the guard that prevents the agent from
  hiding the main content. **F5 (INTEGRITY) and the scope guards want this.**
- **`STAMPABLE_ROLES`** — the set of roles worth stamping on DOM nodes
  (navigation, main, banner, contentinfo, complementary, region, form,
  button, link, heading, list, article). The new perceive system may or may
  not stamp attributes — but the role set is the correct vocabulary.

**What was wrong with it:**
- Stamps `data-wm-id` and `data-wm-role` attributes on DOM nodes during the
  walk — mutations during observation. AGENTS.md rule 3 says "observation
  collects evidence; it never decides." Stamping is a mutation, not
  observation. The new perceive system (`project/src/core/perceive/`) was
  rebuilt without stamping — it uses selectors and handles instead.
- Uses `AI_CONFIG.maxObserveNodes` and `maxObserveTimeMs` for budgeting —
  correct idea, but the config object was part of the old pipeline.
- `serializeForAI` uses a fixed 4-chars-per-token approximation — rough but
  serviceable. A real tokenizer would be better.
- `findPrimaryContentNode` iterates ALL elements with `querySelectorAll('*')`
  and calls `getBoundingClientRect` on each that passes the text filter —
  O(n) with layout thrashing. The new perceive system should use the cluster
  tree, not a fresh DOM scan.
- `extractDesignContext` calls `getComputedStyle` on 14+ elements — layout
  thrashing. Should batch or use the perception cluster styles instead.
- The `IGNORED_TAGS` set includes `SVG` — but SVG can contain meaningful
  content (inline SVG with text). The new perceive system handles this
  better.

**Who will want it back:**
- **F7 (SIGHT)** — this is the prior version of sight. The new perceive
  system (`project/src/core/perceive/`) is the successor, but the
  serialization + budgeting logic (priority scoring, truncation flagging) is
  the pattern to compare against.
- **F6 (THE LOOP)** — the token-budgeted serialization with truncation
  flagging is the model's window into the page. The pattern is correct;
  the new system should keep it.
- **F5 (INTEGRITY)** — `findPrimaryContentNode` is the scope guard that
  prevents the agent from destroying the page's main content. The new
  system needs an equivalent.
- **F1 (IDENTITY)** — the semantic role map + accessible name computation
  are the primitives for resolving a human concept to elements. `nav` →
  navigation, `aria-labelledby` → name — these are stable, correct
  mappings.

---

### 15. `core/plan/index.ts` (26 lines)

**What it knew:**
Type definitions only: `ActionSpec`, `InnerAction`, `Operation`, `Plan`. The
operation union: `'hide' | 'isolate' | 'act'`. The action type union (as a
string, not a literal union): unlockScroll, scrollToTarget, clickTarget,
expandAll, collapseAll, autoLoadMore, addShortcut.

**What was wrong with it:**
- `Operation.op` is `'hide' | 'isolate' | 'act'` — too coarse. "isolate" is
  really "hide everything except" — a derived operation, not a primitive.
- `ActionSpec.type` is `string`, not a literal union — no type safety on
  action types. The `ALLOWED_ACTION_TYPES` set in `apply/index.ts` was the
  runtime guard that compensated.
- The `Plan` type is a flat list of operations + reasoning — no structure, no
  budget, no reversibility information. The `TransformBundle` in
  `bundle/index.ts` was the attempted replacement.

**Who will want it back:**
Nobody directly. The new agent's loop (F6) reasons about actions directly —
the model decides what to do, not a `Plan` type. But the `InnerAction`
type (clickTarget / scrollToTarget) and the `ActionSpec.key` field (keyboard
shortcut descriptor with modifier parsing) are the vocabulary for behavioral
ops that the new system will need to reinvent or borrow from `apply/index.ts`.

---

## Cross-cutting findings

### Healing / reversal patterns (F3)

The user flagged: "The knowledge in heal.ts, solve.ts, the six healing steps
and the grid track construction is worth more as reference than the deletion
was worth as cleanliness."

`heal.ts` still exists in the current codebase at
`project/src/core/heal.ts` — it was NOT deleted. `solve.ts` was not found in
the current codebase or in the deleted files list, so it may have been
deleted in an earlier purge not covered by this archive, or may never have
existed as a separate file (its logic may have lived in the compiler).

However, the **reversal/healing patterns** are present across these archived
files:

1. **`apply/index.ts` — scroll-lock save/restore**: `scrollLockOriginals`
   captures `overflow`, `position`, `top`, `width` before mutation;
   `restoreScrollLock()` writes them back. This is the **save-originals-
   then-restore** healing pattern — the template for every reversible
   behavioral op.
2. **`apply/index.ts` — teardown**: `teardownBehaviors()` removes key
   listeners, restores scroll, aborts auto-load. The **complete teardown**
   that leaves no trace — the F3 ideal.
3. **`apply/index.ts` — `reidentify` at trigger time**: re-resolves a saved
   descriptor to the current DOM. This is **identity healing** — the
   selector "heals" after a re-render by re-resolving from a descriptor
   rather than relying on a stale DOM reference.
4. **`bundle/index.ts` — `DomOp` as structured, reversible ops**: each op
   (hide/move/inject) carries enough information to compute its inverse. The
   structure IS the reversal plan.

### Grid track / constraint construction (05_BROWSER_CRAFT)

The "grid track construction" the user flagged appears in:

1. **`enrichment.ts` — `analyzeText` longest-unbreakable-token**: the
   comment says "the longest token decides whether a track can safely narrow
   — the browser needs that number and so does the solver." The longest
   unbreakable token IS the `min-content` size for a grid track. This is
   the raw measurement that a grid solver needs to prevent content
   overflow.
2. **`enrichment.ts` — `measureDensity` whitespace Gini**: the Gini
   coefficient of inter-cluster gaps measures whitespace evenness — a
   constraint signal for layout solvers.
3. **`enrichment.ts` — `measureAlignmentEdges`**: repeating x-positions
   quantized to 8px — the alignment grid the page already uses. A layout
   solver should respect existing alignment edges, not invent new ones.
4. **`expand.ts` — `DESTRUCTIVE_CONFIDENCE_FLOOR`**: a constraint that
   prevents destructive ops on uncertain targets. This is the "refuse on
   measurement" pattern (AGENTS.md rule 11) applied as a solver constraint.
5. **`expand.ts` — topbar refusal**: refuses half-applied structural ops
   (width:100% without reorder) — a constraint that prevents the
   half-applied state. The solver must refuse the whole op, not half of it.

### Constraint logic (expand.ts)

`expand.ts` is the richest constraint file:

- Destructive-confidence floor (0.5) — hard constraint on destructive ops
- Topbar move-safety gate — refuses structural ops on non-reorderable targets
- Escape-hatch fraction (>20% = pivot failure) — vocabulary-gap constraint
- Colour coverage (B11) — text-colour assignment constraint preventing
  invisible text
- Target resolution with role@group compound — the resolution constraint
  system

These are **measurement-based constraints** (AGENTS.md rule 11), not
spelling-based blocklists. The new agent should adopt this pattern: guard
on what a selector actually resolved to, not on what it's called.

---

## What was NOT recovered (and why)

These files were listed as deleted but were NOT in the 15 files recovered
because they are NOT in the task's file list. They are noted here for
completeness — if the Stage 0 purge deleted other files, they would need a
separate recovery pass:

- `heal.ts` — still exists at `project/src/core/heal.ts`. Not deleted.
- `solve.ts` — not found in current codebase or in the deleted files list.
  May have been deleted in an earlier purge, or may never have existed as a
  standalone file. Its constraint-solving logic likely lived in the compiler
  (now deleted) or in `expand.ts` (recovered above).
- The "six healing steps" — not present as a named sequence in any of the
  15 recovered files. The healing patterns exist as individual functions
  (scroll-lock restore, teardown, reidentify) but not as a named six-step
  process. This knowledge may be in `heal.ts` (still extant) or in a file
  not covered by this archive.

---

## Using this archive

These files are **reference, not dependencies**. Read them to understand what
was known and what was wrong. Do not import from them. Do not copy them into
`project/src/`. When a foundation or stage needs the knowledge, rebuild it in
the new architecture — the patterns survive, the types do not.

The most valuable files, ranked by knowledge density:
1. `core/perceive/enrichment.ts` — colour model, component taxonomy, density/
   rhythm/alignment, text understanding (longest-token = min-content)
2. `core/apply/index.ts` — trust-boundary safety, reversal patterns, teardown,
   re-identification, action implementations
3. `core/observe/index.ts` — semantic map, serialization with budgeting,
   primary content detection, design context extraction
4. `core/compile/expand.ts` — intent expansion, destructive-confidence floor,
   escape-hatch metric, constraint logic
5. `core/bundle/index.ts` — structured reversible ops, budget limits
6. Everything else — contracts and stubs, useful as vocabulary but not
   implementation

---

# Stage 0 Archive — Second-Pass Recovery (88 files)

The first archive pass recovered 15 capability/contract stubs. This second
pass recovered **88 additional files** deleted from the working tree but
still present in the git index (`git show HEAD:<path>`). These are the
implementation files — the constraint solver, the Layout IR, the
transformation engine, the 11 relation resolvers, the 7 layout languages,
the conformance checker, and the browser-laws guardrails. Together they
encode the architectural knowledge that `06_FOUNDATION.md` says was "built
on unproven primitives and all of it had to be deleted."

**Recovery method:** `git show HEAD:<path>` → `archive/<path>`, preserving
the original directory structure. No source files were modified. Files that
overlapped with the first-pass archive (e.g. `compile/index.ts`) were
overwritten with the HEAD version, which is the latest committed content.

**Breakdown:** 49 files under `project/src/`, 21 files under `docs/`, 18
files under `project/tests/`.

---

## Important recovered files (with descriptions)

### `core/layout/solve.ts` (737 lines) — the unified responsive solver

The constraint solver. Satisfies Layout IR constraints and emits CSS-only
relayout — no DOM mutation, no wrapper elements, no node moves. Finds the
nearest common ancestor (NCA) of all slot-assigned nodes, emits
`display: grid` + the slot grid template on the NCA, emits
`display: contents` on intermediate elements (with safety checks), and
places each node with `grid-column` (rows auto-place to preserve DOM
reading order). Selector-based targeting — CSS rules are keyed on
selectors derived from stable attributes (id/data-testid/role/aria-label),
never on stamped data attributes. Undo = "remove the stylesheet".

**Key knowledge:**
- **CSS-only relayout** — zero DOM mutation means nothing for a framework's
  MutationObserver to reconcile. This is the AGENTS.md rule 8 ideal.
- **Reading order is inviolable** — no `order` property, no arbitrary
  `grid-area` that diverges keyboard/SR from sight. Grid-column assigns the
  column; rows auto-place in DOM order.
- **v1 scope (5 steps):** validate constraints → propagate parent→child →
  choose Flex or Grid per container → normalize sizing (auto/%/clamp()/minmax())
  → emit responsive CSS.
- **matched-targets = 0 is a HARD ERROR** — the solver refuses to emit
  nothing; it throws instead of silently succeeding.

**Who will want it back:** F2 (APPLICATION), F3 (REVERSAL), F6 (THE LOOP),
any layout/grid capability, 05_BROWSER_CRAFT.md.

---

### `core/layout/ir.ts` (365 lines) — the Layout IR with constraint vocabulary

The IR answers "how is it arranged?" — a separate stage from Perception
("what is this?") and the Semantic Model. It is a pure projection of a
Perception into a four-section node, plus the page's current arrangement
expressed as semantic constraints.

**Key knowledge:**
- **Constraint vocabulary is SEMANTIC, not measurements:**
  `FillParent | Centered | StackVertically | WrapOnOverflow | MaxWidth |
  AspectRatio | Gap | Alignment | Ordering | ...`. Every constraint
  carries a priority (`required | preferred | optional`) + a source
  (`law | language | intent`). The model never assigns priority; priority
  descends by authority: Browser Laws → Layout Language → Transformation
  Intent.
- **Immutability is a contract:** `extractLayoutIR` deep-freezes the
  result (`Object.freeze`, recursively). Any mutation throws in development.
  The Target IR is a NEW object, never a mutation of the Current IR.
- **Archetypes** — named layout patterns the page can become
  (single-column, two-column-rail, three-column, grid, masonry, ...).
- **Pure:** takes Perception as data, no DOM access. 0 model calls.

**Who will want it back:** F6 (THE LOOP), any layout capability,
05_BROWSER_CRAFT.md. The semantic constraint vocabulary is the correct
abstraction — the model expresses intent, the solver satisfies it.

---

### `core/execute/index.ts` (130 lines) — the defence loop

Applies a compiled stylesheet (appended LAST in `<head>` to win the cascade)
and defends it against frameworks that wipe `<head>` on re-render. Also
injects + defends per open shadow root so shadow-DOM content gets the
redesign.

**Key knowledge:**
- **MutationObserver defence loop** — watches `<head>` for childList changes;
  if the style element is removed, re-inserts it. Circuit-breaker
  (`MAX_DEFENSE_ATTEMPTS = 10`) prevents an unbounded CPU loop on pages
  that strip styles aggressively.
- **Shadow DOM injection** — per-shadow-root style elements with the same
  CSS, defended by per-root observers.
- **Visible-paint counter** — set explicitly by the caller (paint 1 → '1',
  paint 2 → '2'), NOT incremented by the defence re-applier (invisible
  restores must not inflate the visible-paint count).

**Who will want it back:** F2 (APPLICATION), F6 (THE LOOP). The defence
loop is the pattern for keeping applied styles alive on SPA pages.

---

### `core/layout/length.ts` (50 lines) — length handling with provenance

Law 0 ("Give Layout Back to the Browser") applied to every numeric value the
compiler emits. A `Length` carries **provenance**: where the value came from.

**Key knowledge:**
- **Provenance kinds:** `token` (design token/fluid clamp), `authorConstraint`
  (layout language), `intrinsic` (auto/min-content/fit-content), `measurement`
  (captured rect — **NEVER emitted**).
- **A measurement-provenance length reaching the emitter is a HARD
  REJECTION** — measurements may inform decisions; they may never become
  output. This is AGENTS.md rule 6 ("Express intent, never implementation")
  enforced at the type level.
- Factory functions: `token()`, `authorConstraint()`, `intrinsic()`,
  `measurement()` — each stamps the provenance.

**Who will want it back:** F2 (APPLICATION), any layout capability,
05_BROWSER_CRAFT.md. The provenance pattern is the correct way to enforce
"never write a measurement back to the page."

---

### `core/layout/assign.ts` (60 lines) — deterministic slot assignment

Assigns each Layout IR node to exactly one slot in a layout language.
Invariants enforced by assertions that **throw** (a violation is a compiler
error):

- Every node lands in exactly one slot
- Unmatched/unknown → the language's overflow slot
- Sum of slot memberships == node count
- No node appears twice

Language-aware: the caller passes the chosen `LayoutLanguage`. When the
model emits no language choice, the documentation fallback is used.

**Who will want it back:** F6 (THE LOOP), any layout capability. The
assertion-enforced invariants are the correct discipline — a bug in
assignment is a compiler error, not a silent wrong layout.

---

### `core/compile/transform.ts` (393 lines) — the deterministic transformation engine

Replaces the old enum-based expansion logic. The model emits **relational
statements** (not enum picks); the engine resolves each relation against the
page's own measured reality and produces concrete `DesignRule[]/DesignOp[]`
the compiler consumes.

**Key knowledge:**
- **Deterministic:** the same relation against the same perception always
  produces the same output. 0 model calls.
- **Reports unsatisfiable relations** — never silently drops a constraint.
  Each unsatisfiable relation carries a reason.
- **DESTRUCTIVE_CONFIDENCE_FLOOR = 0.5** — a destructive relation
  (hide/remove) is forbidden on a role the classifier is < 0.5 sure about.
  (Same pattern as `expand.ts` in the first archive.)
- **escapeHatchFraction** — raw-override handles ÷ intent-resolved handles.
  > 20% = pivot-failure flag (vocabulary gap).
- **Relation dispatch** — builds shared context (helpers + mutable
  accumulators) and dispatches each relation to its domain handler in
  `compile/relations/*.ts`. Behaviour-identical to the old inline switch.

**Who will want it back:** F6 (THE LOOP), any design/styling capability,
F5 (INTEGRITY). The relational-statement architecture is the correct
separation: the model expresses intent, the engine resolves it
deterministically.

---

### `core/compile/relations/` (11 files) — the 11 relation-type resolvers

Each file resolves one domain of model-declared relations into concrete
rules/ops. Together they are the complete vocabulary the model uses to
express design intent.

| File | Lines | Relations resolved |
|------|-------|--------------------|
| `composition.ts` | 269 | archetype, assignSlot, trackAllocation, adjacentTo, spansTracks, readBefore, stackDirection, wrapBehavior, prominentFirst |
| `spacing.ts` | 72 | padding, gap, margin, spacingScale relations |
| `typography.ts` | 84 | typeScale, fontWeight, letterSpacing, lineHeight, textTransform |
| `hierarchy.ts` | 37 | elevation, shadow, z-index layering |
| `surface.ts` | 69 | background, border, radius, backdrop, surface tier |
| `color.ts` | 37 | text color, accent, contrast enforcement |
| `layout.ts` | 50 | layout language selection, slot constraints |
| `motion.ts` | 63 | transition, easing, duration |
| `ops.ts` | 52 | hide, remove, reorder structural ops |
| `interaction.ts` | 22 | hover, focus, active state relations |
| `context.ts` | 59 | shared RelationContext + handler dispatch types |

**Key cross-cutting knowledge:**
- **composition.ts** — the richest. Accessibility constraint: prefers
  grid-column placement (preserves DOM order) over CSS `order` (breaks it).
  Where DOM order must change, the relation reports that case and points to
  the DOM op path. The solver never emits `order`.
- **No magnitude is a pixel** — track allocations are fr ratios, floors are
  minmax() bounds from pack tokens.
- **Unsatisfiable constraints are reported, never silently dropped.**

**Who will want it back:** F6 (THE LOOP), any design/styling capability,
F5 (INTEGRITY). The 11-domain split is the correct granularity — each
domain is independently testable and independently rebuildable.

---

### `core/layout/languages/` (9 files) — the 7 layout languages + registry + contract

A layout language is **pure data**: the slots a page lays out into, the
roles each slot accepts, the constraints each slot carries (with priority),
the archetypes the language supports, and the perception signals it suits.

| File | Lines | Language |
|------|-------|----------|
| `types.ts` | 83 | The `LayoutLanguage` contract (interfaces + role→slot lookup) |
| `index.ts` | 93 | Registry + candidate proposal (scores languages against perception) |
| `documentation.ts` | 123 | Documentation — the safety fallback (single-column reading) |
| `dashboard.ts` | 95 | Dashboard — metrics + sidebar + content |
| `bento.ts` | 72 | Bento — asymmetric grid of varied-size cards |
| `editorial.ts` | 95 | Editorial — magazine-style multi-column |
| `feed.ts` | 83 | Feed — vertical scroll of repeated cards |
| `gallery.ts` | 71 | Gallery — image-driven grid |
| `split-view.ts` | 70 | Split-view — two-pane (list + detail) |

**Key knowledge:**
- **Measurement PROPOSES, the model SELECTS.** Perception scores each
  language against its signals (role inventory, component types, card/media/
  prose levels) and returns the top 3-5. The model sees only that shortlist
  and emits the `language` relation. AGENTS.md rule 1 — every request goes
  to the model.
- **Documentation is always included** as the safety fallback — a model
  naming a non-existent language falls back, never crashes.
- **Slot constraints carry priority** (`required | preferred | optional`)
  the solver reads. A slot's minWidth is a floor the solver respects, never
  an emitted measurement.

**Who will want it back:** F6 (THE LOOP), F7 (SIGHT), any layout
capability. The language-as-pure-data pattern is the correct architecture —
adding a layout means adding a data file, not new code.

---

### `core/design/` (3 files) — design packs and vocabulary

| File | Lines | What it knows |
|------|-------|---------------|
| `vocabulary.ts` | 271 | The relational design vocabulary — the closed, typed set of relation names + magnitude types the model emits. No relation name may be invented outside this file. Magnitudes are ratios/scale-steps/ordinal-ranks — NEVER pixels. |
| `packs.ts` | 261 | Design packs — resolved token sets (type scale, colour palette, spacing rhythm, elevation model, radii, shadow). The engine resolves "three times the body" against the pack's actual body size. |
| `validate.ts` | 128 | Validates a DesignSpec against the vocabulary — every relation name must be in the closed set, every magnitude must be a valid type. Rejects divergent naming before it compiles. |

**Key knowledge:**
- **Relational statements, not enum picks.** The model's primary output is
  a set of `RelationStatement`s, each naming subjects by handle/role/group,
  stating a relation type, and carrying a magnitude as a ratio/scale-step/
  ordinal — never a pixel. "Ratios survive any viewport; pixels do not."
- **Subject resolution:** handle (one cluster), role (fan-out by designRole),
  group (fan-out by group id), keyword (`parent`, `body`, `canvas`).
- **The vocabulary is closed and typed** — divergent naming is the expensive
  kind of conflict because it compiles. The validator catches it first.

**Who will want it back:** F6 (THE LOOP), any design/styling capability.
The relational vocabulary is the correct model output format — it
expresses intent (relations) and lets the deterministic engine resolve
implementation (CSS).

---

### `core/verify/` (7 files) — the conformance checker

| File | Lines | What it knows |
|------|-------|---------------|
| `index.ts` | 774 | The verify pipeline — proxy gates (changed/coherent/covered) demoted to advisory; conformance checks are the real gate. Screenshot capture + pixel comparison. |
| `conformance.ts` | 421 | Structural conformance — "did we build the page we declared?" Checks the rendered DOM against the TargetLayoutIR (getComputedStyle, getBoundingClientRect). NEVER "is it beautiful?" |
| `pixel.ts` | 443 | Pixel-level visual diff — captures before/after screenshots, compares regions, classifies changes (intended vs unintended). |
| `resize.ts` | 134 | Responsive verification — checks the layout survives a window resize (the one surviving hard law from AGENTS.md rule 6). |
| `capture.ts` | 39 | Screenshot capture helper. |
| `pixel-capture.ts` | 93 | Pixel capture from Playwright/harness. |
| `pixel-classify.ts` | 82 | Classifies pixel changes as intended/unintended/noise. |

**Key knowledge:**
- **Conformance checks the rendered DOM, not taste.** Each check compares
  against the declared TargetLayoutIR — did the grid actually place the
  slots where we said? Did the constraints hold? Did the reading order
  survive?
- **Responsive verification** — the layout must survive a window resize.
  This is the AGENTS.md rule 6 hard law: "a transformation must survive a
  window resize."
- **Proxy gates are advisory, conformance is the real gate** — the proxy
  gates (changed/coherent/covered) are fast checks; conformance is the
  authoritative pass/fail.

**Who will want it back:** F5 (INTEGRITY), F6 (THE LOOP), any verification
capability. The "check the rendered DOM against the declared IR" pattern
is the correct verification architecture.

---

### `core/laws/index.ts` (447 lines) — browser-safety guardrails as compiler data

The hard-won priors from BROWSER_LAWS.md, distilled to the subset the
restyle compiler enforces. Every rule that matters lives here as **data
the engine reads** — never as scattered special-cases.

**Key knowledge:**
- **BASE_PROPS allowlist** — the open-ended spec key → real CSS property
  map. Anything not in this map is dropped by the compiler. This is what
  keeps an open-ended AI spec safe.
- **`background` / `backgroundColor` both emit the `background` shorthand**
  — because `background-color` paints *under* gradients/images and silently
  fails; the shorthand nukes them. (Color Exp 003.)
- **MIN_CONTRAST_RATIO** — enforced contrast floor.
- **Type scale, spacing rhythm, elevation model, radii, shadows** — all
  as data the compiler reads, not hardcoded in emit logic.
- **Reversible structural DOM operations** (remove/move/reorder/wrap) are
  validated here against geometry laws before execution.

**Who will want it back:** F2 (APPLICATION), F5 (INTEGRITY), any styling
capability. The "compiler reads laws as data" pattern is the correct
architecture — safety is centralized, not scattered.

---

### `core/spec/index.ts` (482 lines) — the DesignSpec type system

The type definitions for the design specification: `DesignSpec`,
`DesignRule`, `DesignOp`, `StyleDecls`, `LayoutDecls`. The structured
representation the transformation engine produces and the compiler
consumes.

**Who will want it back:** F6 (THE LOOP), any design capability. The spec
types are the contract between the transformation engine and the compiler.

---

### `core/ops/` (3 files) — reversible structural DOM operations

| File | Lines | What it knows |
|------|-------|---------------|
| `index.ts` | 150 | Op types: `remove | move | reorder | wrap` — each self-describing and individually reversible. Validates against laws before execution. |
| `execute.ts` | 103 | Executes ops against the live DOM with a cloned-node inverse for each. |
| `transaction.ts` | 120 | Transaction wrapper — all ops in a transaction succeed or all roll back. Records a cloned node for every mutation. |

**Key knowledge:**
- **Every op records a cloned node** for its inverse — `on → off → on → off`
  restores the DOM byte for byte (AGENTS.md rule 7).
- **Transaction semantics** — all-or-nothing. If op 3 of 5 fails, ops 1-2
  roll back. The inverse is the cloned nodes in reverse order.

**Who will want it back:** F3 (REVERSAL), any structural capability. The
cloned-node-inverse + transaction pattern is the correct reversal
architecture.

---

### `core/repair/index.ts` (227 lines) — the repair/healing engine

The repair engine that fixes broken layouts after the solver emits CSS.
Detects overflow, content collapse, and grid track issues; applies targeted
CSS fixes (not DOM mutation). Reports what it fixed and why.

**Who will want it back:** F3 (REVERSAL), 05_BROWSER_CRAFT.md. The
"detect-then-fix-with-CSS" pattern is the correct healing approach —
mutation is a last resort.

---

### `core/interaction/movable.ts` (111 lines) — movable element support

Drag-to-reorder support for list items. Records original positions for
reversal. Validates that the target is actually a movable list (not a
content region).

**Who will want it back:** Phase 4 (ACT), any interactive capability.

---

### `core/layout/exclusions.ts` (126 lines) — layout exclusion logic

Determines which nodes the solver should skip (ads, embeds, iframes,
third-party widgets). Excluded nodes still land in a slot (overflow) —
they're skipped by the solver, not by the assigner.

**Who will want it back:** F6 (THE LOOP), any layout capability. The
exclusion logic prevents the solver from trying to lay out elements it
can't control.

---

### `core/layout/plan-assert.ts` (45 lines) — plan assertion invariants

Asserts invariants on the solver plan before emission: matched-targets > 0,
no duplicate placements, grid template is valid. Throws on violation —
same class as `matched-targets = 0`.

**Who will want it back:** F5 (INTEGRITY), any layout capability.

---

### `core/capabilities/structure/index.ts` (96 lines) — structure capability contract

Phase 2 contract for structural operations: hide, isolate, move, reorder,
wrap. Each op carries a `MutationReason` (required by AGENTS.md rule 8 —
mutation must declare its reason). Includes scope-guard checks.

**Who will want it back:** F2 (APPLICATION), F3 (REVERSAL). The
`MutationReason` requirement is the correct discipline.

---

### `core/capabilities/style/index.ts` (136 lines) — style capability contract

Phase 1 contract for visual restyling. Defines the `StyleSpec` type and
the safety checks that gate style application. Includes the
allowed-properties allowlist and the contrast enforcement.

**Who will want it back:** F2 (APPLICATION), any styling capability.

---

## docs/ — investigation documents (21 files)

Recovered the full `docs/investigation/` directory (18 numbered analysis
files + README) and `docs/LAW_0_BROWSER_OWNERSHIP.md`:

| File | What it documents |
|------|--------------------|
| `LAW_0_BROWSER_OWNERSHIP.md` | Law 0: "Give Layout Back to the Browser" — the foundational principle. |
| `01_SYSTEM_OVERVIEW.md` | System architecture overview. |
| `02_EXECUTION_FLOW.md` | End-to-end execution flow. |
| `03_MODULE_BREAKDOWN.md` | Module-by-module breakdown. |
| `04_DATA_FLOW.md` | Data flow through the pipeline. |
| `05_DOM_PIPELINE.md` | The DOM processing pipeline. |
| `06_AI_PIPELINE.md` | The AI/LLM pipeline. |
| `07_ARCHITECTURE_ANALYSIS.md` | Architecture analysis. |
| `08_ROOT_CAUSE_ANALYSIS.md` | Root cause analysis of the old architecture's failures. |
| `09_BROWSER_COMPATIBILITY.md` | Browser compatibility findings. |
| `10_PERFORMANCE_ANALYSIS.md` | Performance analysis. |
| `11_SECURITY_ANALYSIS.md` | Security analysis. |
| `12_FAILURE_SIMULATION.md` | Failure mode simulation. |
| `13_RISK_REGISTER.md` | Risk register. |
| `14_TECHNICAL_DEBT.md` | Technical debt inventory. |
| `15_REFACTORING_ROADMAP.md` | The refactoring roadmap that led to Stage 0. |
| `16_GLOSSARY.md` | Glossary of terms. |
| `17_SYSTEM_DIAGRAMS.md` | System diagrams. |
| `18_UNIFIED_PLAN.md` | The unified plan. |
| `README.md` | Investigation index. |

These document the analysis that justified the Stage 0 deletion. They are
the "why we deleted it" record.

---

## project/tests/ — deleted test files (18 files)

| File | Lines | What it tests |
|------|-------|---------------|
| `compile.test.ts` | — | Compiler tests. |
| `ops.test.ts` | — | Structural ops tests. |
| `phase2.test.ts` | — | Phase 2 integration tests. |
| `popup.test.ts` | — | Popup UI tests. |
| `relaxation.test.ts` | — | Constraint relaxation tests. |
| `axe-bench.ts` | — | Axe accessibility benchmark harness. |
| `bakeoff.ts` | — | Layout "bakeoff" comparison harness. |
| `diag.ts` | — | Diagnostic probe. |
| `diag2.ts` | — | Second diagnostic probe. |
| `probe.ts` | — | Layout probe. |
| `vision_probe.js` | — | Vision-model probe (screenshot → description). |
| `probe/expand.test.ts` | — | Expand/probe test. |
| `probe/layout-ir.test.ts` | — | Layout IR test. |
| `probe/perceive-entry.ts` | — | Perception entry probe. |
| `probe/semantic.test.ts` | — | Semantic classification test. |
| `probe/stability.test.ts` | — | Selector stability test. |
| `fixtures/painter/*.json` (3 files) | — | Painter fixtures (github/mdn/wikipedia constructivist-propaganda-poster). |

---

## Updated knowledge-density ranking

Combining both archive passes, the most valuable files by knowledge density:

1. `core/layout/solve.ts` — the constraint solver, CSS-only relayout, reading-order preservation
2. `core/layout/ir.ts` — the semantic constraint vocabulary (FillParent/Centered/StackVertically/...)
3. `core/compile/transform.ts` — the deterministic transformation engine (relational statements → rules)
4. `core/compile/relations/composition.ts` — the richest relation resolver (accessibility-aware grid placement)
5. `core/verify/conformance.ts` — "did we build the page we declared?" (rendered DOM vs declared IR)
6. `core/laws/index.ts` — browser-safety guardrails as compiler data (the BASE_PROPS allowlist)
7. `core/layout/length.ts` — provenance-enforced lengths (measurements never emitted)
8. `core/design/vocabulary.ts` — the closed, typed relational vocabulary the model emits
9. `core/perceive/enrichment.ts` — colour model, component taxonomy, density/rhythm/alignment (first archive)
10. `core/apply/index.ts` — trust-boundary safety, reversal patterns, teardown (first archive)
11. `core/layout/languages/index.ts` — measurement proposes, model selects (7 languages as pure data)
12. `core/ops/transaction.ts` — cloned-node inverse + all-or-nothing transactions
13. `core/spec/index.ts` — the DesignSpec type system (contract between engine and compiler)
14. `core/execute/index.ts` — the defence loop (MutationObserver circuit-breaker)
15. `core/observe/index.ts` — semantic map, serialization with budgeting (first archive)

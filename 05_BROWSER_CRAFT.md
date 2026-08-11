# 05 — BROWSER CRAFT

**Why this file exists.** In August 2026 roughly 12,000 lines of layout code
were deleted: a constraint solver, a target layout IR, a 37-type relation
graph, eight archetypes, seven design languages, a compiler and a conformance
checker. That code never produced a page a human approved of, and deleting it
was correct.

But the code contained **knowledge**, and knowledge is not the same as code.
When recomposition is rebuilt, it must be rebuilt from this knowledge — not
re-derived from zero, and not restored as it was.

This file is that knowledge. It is browser physics. It does not go stale.

---

## 1. The first law: the browser already solved this

The browser contains millions of lines of the best layout, text-shaping,
reflow and paint code ever written, tuned over twenty-five years, running in
C++ at frame rate. Any algorithm we write in TypeScript to decide widths,
break text, or place boxes is a worse version of something already present and
free.

**Our job is to give the browser correct inputs and then get out of the way.**

The practical form of this law:

| We should express | Never compute |
|---|---|
| "these are columns" | column widths in px |
| "this is the main region" | its measured size |
| "this text should be comfortable" | a font-size in px from a measurement |
| "this may shrink" | the shrunk value |
| "these wrap when narrow" | the breakpoint |

**The one hard rule that survived everything:** a transformation must survive a
window resize. If it breaks when the window changes, a measurement was frozen
into the output.

**The diagnostic:** if any number in emitted CSS was read off the live page,
that is a bug. Ratios are fine. Measured lengths are not.

---

## 2. Formatting contexts, and how we destroyed one

Every element participates in a formatting context established by its parent —
block, inline, flex, grid, table. **An element's size is often determined by
its children, not by itself.** Change the children and you change the parent's
size, even though you never touched the parent.

### Case study: the run-1 collapse

`setText` replaced the `textContent` of MDN's article element. No CSS was
emitted. The result: the article rendered in a ~30px column with text breaking
mid-word — `justi / fy- / con / tent`.

What happened, step by step:

1. The article's children — code blocks, tables, wide `<pre>` — contributed the
   **max-content** width that sized its grid track.
2. `textContent = "..."` deleted every one of those children.
3. The remaining single text node contributed almost no minimum width.
4. The grid track, sized by content, collapsed toward zero.
5. With a container narrower than a word and `overflow-wrap` in play, the
   browser broke text mid-word. Correctly. It had no other option.

The browser did nothing wrong. **We deleted its inputs and blamed the output.**

### The rules that follow

- **Never replace the children of an element that participates in layout.** Add
  siblings, wrap, or target a text-level element with no element children.
- Before any structural mutation, ask what the element's children contribute to
  its own size, and to its parent's.
- Prefer `insert` over `setText`. Adding cannot collapse a track. Replacing can.
- If you must replace, give the new content the same intrinsic contribution, or
  give the container an explicit sizing that does not depend on content.

---

## 3. The cascade beats mutation, always

Two ways to change a page:

**A stylesheet.** One `<style>` node. The cascade applies it to everything that
matches — including elements that **do not exist yet**. A React re-render
produces new nodes; they match the same selectors; the style still applies. We
never hear about the re-render, and there is nothing to defend.

**DOM mutation.** We change nodes. The framework re-renders and reverts us. We
observe and re-apply. It re-renders again. This is how a 10-attempt defence
loop with a `MAX_DEFENSE_ATTEMPTS` constant comes to exist, and it is a symptom,
not a solution.

**Default to the stylesheet. Mutation is a declared exception, and it must
supply a reason:**

| Reason | Why CSS cannot do it |
|---|---|
| `insertContent` | new content must exist as nodes |
| `rewriteText` | text is data, not presentation |
| `bindBehaviour` | listeners are not styles |
| `reorderStructure` | only when `order`/`grid-area` genuinely cannot |
| `affordance` | our own UI (toggle, handle) |

A mutation with no declared reason is refused. If the defence loop is growing,
something that should be CSS is being done with JavaScript.

### Making our stylesheet win predictably

- **Cascade layers — the caveat that cost us three runs.** `@layer revueon
  { ... }` does NOT win over unlayered author styles for normal declarations.
  Layer order is consulted *before* specificity: for normal declarations,
  unlayered author styles beat layered author styles **unconditionally** —
  specificity never gets a vote. For important declarations the order
  inverts: layered important beats unlayered important. So:
  - `@layer revueon { body { background: red } }` — **weaker** than every
    unlayered `body { background }` on the page. Proven by the red test.
  - `@layer revueon { body { background: red !important } }` — the
    **strongest position available**. Layered important beats unlayered
    important, and important beats normal regardless of layers.
  - **Default: emit `@layer revueon { ... !important }` for all generated
    CSS.** The `emitStyle()` helper in `core/emit.ts` does this — wraps in
    the layer and adds `!important` to every declaration. This is the only
    path to the style node.
- **`:is()` and `:where()`.** `:where()` contributes **zero** specificity — use
  it to write broad selectors that lose gracefully. `:is()` keeps the highest
  specificity of its arguments.
- **Cross-origin stylesheets** cannot be read. We cannot always know what we are
  competing with. Design for that: prefer layers + `!important` and
  high-specificity scoping over guessing at the page's rules.

---

## 4. Intrinsic sizing — the thing that breaks everything

| Keyword | Means |
|---|---|
| `min-content` | narrowest without overflowing — roughly the longest word |
| `max-content` | width if nothing ever wrapped |
| `fit-content` | `min(max-content, max(min-content, available))` |
| `auto` | context-dependent; in grid usually `minmax(auto, max-content)` |

### The single most common grid bug in the world

A grid track declared `1fr` has an implicit minimum of `auto`, which is
`min-content`. A single long word, a wide `<pre>`, or an unbreakable URL will
blow the track past its share and squeeze its neighbours to nothing.

**The fix is one line and it should be in almost every grid we emit:**

```css
grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
```

The flex equivalent — flex items also default to `min-width: auto`:

```css
.flex-child { min-width: 0; }
```

A large share of the "squeezed column" and "one letter per line" failures in
this project's history are this bug, in one form or another. Emit `minmax(0,
1fr)` and `min-width: 0` by default and most of them never happen.

### Text that breaks mid-word

`overflow-wrap: break-word` breaks a word only when it cannot fit. `word-break:
break-all` breaks anywhere, always — never emit it for prose. If you see text
breaking mid-word, the container is narrower than a word, and **the container
is the bug**, not the text.

---

## 5. Container queries are the real responsive answer

Media queries ask about the viewport. That is the wrong question. A sidebar
card does not care how wide the window is; it cares how wide **it** is.

```css
.region { container-type: inline-size; container-name: region; }

@container region (min-width: 40ch) {
  .card { grid-template-columns: auto 1fr; }
}
```

Why this matters for us specifically: we cannot know the user's viewport, zoom,
font size, sidebar state, or device. Container queries mean **we never have to
know.** The component adapts to whatever space it is actually given, forever,
without a breakpoint we chose.

Related primitives that remove the need to compute:

- `clamp(min, preferred, max)` — fluid type and spacing with no breakpoints.
  `font-size: clamp(1rem, 0.9rem + 0.5cqi, 1.4rem)`.
- `min()` / `max()` — `width: min(65ch, 100%)` is a whole responsive rule.
- `cqi` / `cqw` units — percentages of the container, not the viewport.
- `ch` — width relative to the font's `0` glyph. Reading measure is a `ch` value,
  never a px value.
- `auto-fit` / `auto-fill` with `minmax()` — a responsive grid with no media
  queries at all:
  `grid-template-columns: repeat(auto-fit, minmax(min(20rem, 100%), 1fr))`.
- `aspect-ratio` — reserve space without measuring.

**Never emit `vh`.** Mobile browsers change the viewport as chrome hides. Use
`dvh`, `svh`, `lvh` when a viewport-relative height is genuinely needed.

---

## 6. Layout without reparenting

An extension must almost never move a node. Reparenting breaks event listeners,
framework reconciliation, focus, scroll anchoring, and accessibility trees. The
original architecture wrapped elements in shells and slots and it was abandoned
for exactly these reasons.

Everything below repositions content **without touching the tree**:

| Need | CSS answer |
|---|---|
| change visual order | `order` in flex, `grid-row` / `grid-column` in grid |
| place a deep descendant in a page-level grid | `display: contents` on the intermediates |
| align a child to an ancestor's grid | `subgrid` |
| take something out of flow | `position: absolute/fixed` on a positioned ancestor |
| stick something | `position: sticky` + a `top` |
| overlay | grid with all children in `grid-area: 1/1` |
| swap visual position of two siblings | `order: 1` / `order: 2` |

`display: contents` deserves special attention: it makes an element's box
disappear while keeping its children, so a deeply nested item can participate
in a distant ancestor's grid. It is the correct answer to "this element is
buried four divs deep and I need it in the main grid." **Caveat:** it removes
the element from the accessibility tree in some browsers if it has a semantic
role — never apply it to `<ul>`, `<table>`, or anything with an ARIA role.

**Visual order and DOM order must not diverge for keyboard users.** Tab order
follows the DOM. If `order` moves something visually to the top but it is last
in the DOM, keyboard navigation becomes wrong. Reorder only within a group where
sequence does not carry meaning, or accept the change consciously.

---

## 7. Healing — a removal is not finished when the element disappears

Hiding leaves a hole: a gap where a grid item was, a flex gap that no longer
separates anything, a divider with nothing on one side, a container sized for
content that is gone.

Six healing steps, in this order. Stop at the first that resolves it:

1. **Let the browser reflow.** With `display: none` in a normal flow, nothing is
   needed. Try this first, always.
2. **Collapse the grid or flex slot.** If the parent has explicit tracks, the
   track remains. Remove that track, or switch to `auto-fit`/`auto-fill` so it
   collapses on its own.
3. **Collapse the parent.** If the parent now has no visible children, hide the
   parent too — but only if it has no other purpose (no background, border,
   padding that matters).
4. **Drop the orphaned separator.** A divider, `gap`, or `border` that separated
   two things now separates one.
5. **Release a frozen height.** A `height` or `min-height` set for content that
   is gone leaves dead space.
6. **Expand a single remaining sibling.** If a two-up became a one-up, let the
   survivor take the space rather than sit at half width.

All six are CSS. None require touching the tree.

**Subtraction is a design act.** Hiding six things and leaving six holes is a
worse page than before. "Remove clutter" means the result must look
intentional — not merely emptier.

---

## 8. Targeting elements reliably

This is the hardest problem in browser extensions and it deserves more respect
than it has been given here.

**A selector must be stable across:** re-render, navigation within an SPA, a
return visit next week, a site deploy, and A/B variants.

Ranked by stability:

1. Semantic landmarks — `main`, `article`, `nav`, `aside`, `header`, `footer`
2. ARIA roles and `aria-label` — authored deliberately, rarely churned
3. Custom element tag names — `ytd-rich-shelf-renderer`, `shreddit-comment`.
   Extremely stable; frameworks rename classes, not tags.
4. `id`, when it does not look generated
5. `data-*` attributes with meaningful names
6. Structural position from a stable anchor — `main > :nth-child(2)`
7. Class names — churn on every deploy, and hashed classes (`css-1x9dk2`) are
   worthless
8. Text content — breaks in every other language

**Never anchor to a hashed class.** If the only available class matches
`/^[a-z]+-[a-z0-9]{5,}$/`, treat it as absent.

### When you cannot build a selector

Some elements — deep in shadow DOM, no stable ancestor — genuinely cannot be
targeted. That is a real ceiling, and dropping them is correct.

**Dropping them silently is not.** The result must be `{ targetable: false,
reason }`, surfaced to the model, so it can say "I found it but cannot reach it"
and try another approach. A silent `null` becomes "nothing happened and nobody
knows why."

### Shadow DOM

CSS cannot pierce a shadow boundary. `::part()` works only where the author
exposed a part; `::slotted()` reaches only slotted light-DOM children. To style
inside an open shadow root you must inject a stylesheet into that root, or use
`adoptedStyleSheets`. Closed roots are unreachable — say so rather than
failing quietly.

---

## 9. Surviving re-render and navigation

Three distinct problems, three distinct answers:

| Problem | Answer |
|---|---|
| The framework re-renders the element | The cascade — new nodes match the same selectors. Nothing to do. |
| SPA navigation to a new route | The style node survives if it is on `document.head` and nothing clears it. Watch for route change, re-verify targets still exist. |
| The user returns tomorrow | Persistence, keyed by **origin + path**, replayed on load. |

**Never store or transmit a full URL.** Query strings and fragments carry
session tokens, search terms, document IDs, personal data. Origin and path,
nothing more. This is a privacy commitment, not a preference.

Apply at `document_start` where possible, so the user never sees the unmodified
page flash before ours applies.

---

## 10. Type, colour, spacing, motion — as ratios, never values

**Type.** A scale is a ratio (1.2 minor third, 1.25 major third, 1.333 perfect
fourth), applied to a base the *page* already established. Reading measure is
`45–75ch`, expressed in `ch`. Line height is unitless and inversely related to
measure: long lines need more, short lines need less. Never set a font-size
from a measured pixel value.

**Colour.** Emit a colour only when contrast against its actual background is
**provable**. If the background cannot be resolved — an image, a gradient, a
cross-origin stylesheet — do not change the foreground. WCAG AA is 4.5:1 for
body text, 3:1 for large text and UI. Work in OKLCH where possible: it is
perceptually uniform, so a lightness change means the same thing across hues.
Respect `prefers-color-scheme` and `color-scheme`.

**Spacing.** A scale, not arbitrary numbers. Related things are closer than
unrelated things — proximity carries meaning, and getting proximity right is
most of what "good spacing" is. Prefer `gap` over margins; it does not collapse
and does not leak past the last child.

**Motion.** 150–250ms for small state changes, 250–400ms for larger ones.
`ease-out` for entering, `ease-in` for leaving. Animate `transform` and
`opacity` only — they are compositor-only and free. Animating `width`, `height`,
`top` or `left` forces layout every frame. **Always honour
`prefers-reduced-motion: reduce`** — this is an accessibility requirement, not
a nicety.

---

## 11. Performance

- **Never read layout in a loop after writing.** `offsetWidth`, `getBoundingClientRect`,
  `getComputedStyle` force synchronous layout. Batch all reads, then all writes.
- `content-visibility: auto` with `contain-intrinsic-size` skips rendering
  offscreen content — a large win on long pages, and free.
- `contain: layout style paint` on a region we control stops our changes from
  forcing layout of the whole document.
- One style node, replaced wholesale, beats many small insertions.
- `MutationObserver` on `document.body` with `subtree: true` on a busy SPA fires
  constantly. Scope it, debounce it, disconnect it when idle — or better, do not
  need it, because the cascade already handles re-render.
- **First visible change within one second.** Everything else can take longer;
  this cannot.

---

## 12. What NOT to rebuild

This section is as important as the rest. These were tried, at length, and
failed for reasons that will not change:

**A closed vocabulary of design relations.** 37 relation types, and not one
could express "summarise this." Any fixed vocabulary is a ceiling on what a
user may ask for, and users do not know where the ceiling is. **The model writes
the answer.** We validate it; we do not enumerate it in advance.

**A deterministic expander from intent to CSS.** A lookup table cannot design.
It was described accurately by an outside reviewer: *"an excellent compiler with
an underpowered designer."*

**Layout archetypes and named design languages.** Eight archetypes, seven
languages, scored and selected. The scorer picked `documentation` (8.0) over
`dashboard` (10.5) and nobody could say why. A model that has seen every website
ever built does not need our taxonomy of seven.

**A fallback that invents work.** `buildFallbackTargetIR` placed 75 of 90
clusters that the model never mentioned. The user then saw a page nobody chose.
A missing input means stop, not improvise.

**Conformance checking output against the plan.** A compiler validating its own
AST. Always green, and it was green on a destroyed page.

**Pixel gates asserting taste.** Overflow and invisible text are physics and
worth gating. "Is the spacing good" is a design decision. Nine of nine gates
passed on the worst output this project ever produced.

---

## 13. When recomposition is rebuilt

It returns as **one tool**, `recomposePage`, called rarely, only when the model
has exhausted cheaper options, and only for genuine whole-page requests.

The shape:

```
perceivePage → a compact page model (~50 semantic units, not 200 nodes)
     ↓
ONE model call → the model writes the layout intent AND the CSS
     ↓
validate  — no measured lengths, contrast provable, no reparenting,
            minmax(0,1fr) present, container queries not media queries
     ↓
apply as one stylesheet in @layer revueon
     ↓
checkLayout on the live page → overflow? invisible text? unreachable content?
     ↓
fail → undo. Never repair in place.
```

What is different from what was deleted:

- **The model writes the CSS.** No IR, no relations, no expander, no solver.
- **Compression happens.** 200 nodes to ~50 semantic units — the step both
  outside reviewers named and that was never built.
- **No fallback.** If the model cannot answer, `giveUp`.
- **Verification reads the page**, not the plan.
- **It is one tool among many**, not the pipeline every request must enter.

The knowledge in this file is what that tool's validation layer should enforce
and what its prompt should assume. That is what the deleted code was really
for, and this is the part worth keeping.

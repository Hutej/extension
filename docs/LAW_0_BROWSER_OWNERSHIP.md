# Law 0 — Browser Ownership of Layout

> The browser owns layout. We hand it better constraints and let it solve.
> A site is responsive because the browser re-solves layout from constraints on
> every resize, zoom, font load and scrollbar change — not because its CSS is
> better. We do not replace Blink's layout engine.

## The five rules

1. **Every emitted length carries provenance.** A `Length` type tags each value
   as `token`, `authorConstraint`, `intrinsic`, or `measurement`. A
   `measurement`-provenance length reaching the emitter is a hard rejection.
   Measurements may inform decisions; they may never become output.

2. **Emission is constraint-driven.** Every emitted declaration originates from
   a constraint in the Layout IR (`FillParent`, `Centered`, `StackVertically`,
   `WrapOnOverflow`, `MaxWidth`, `AspectRatio`, `Gap`, `Alignment`, `Ordering`)
   or from a design token — never from a captured rect. Where a declaration has
   no corresponding constraint, the constraint is missing from the IR and must
   be added. Geometry is the recipe, not the cake.

3. **Preserve the existing formatting context.** Before touching a container,
   detect its current context (flex, grid, block, table, inline). If it already
   has a working flex or grid context, modify that context's properties — do not
   replace it. Changing `gap`, `justify-content`, `align-items`, `flex-wrap` and
   `flex-direction` is transformation. Overwriting `display: flex` with
   `display: grid` is flattening. Introduce a new context only where none exists.

4. **No viewport units, no measurement-derived values.** Viewport units ignore
   container context and count the scrollbar. Express tracks with `minmax()`,
   `fr`, `fit-content()` and token floors. Convert frozen values to `min()`,
   `clamp()`, and `auto`. The content floor is a token, not `320px`.

5. **Container queries, not viewport breakpoints.** Establish containment on
   the regions we transform. Express component-level responsive behaviour with
   `@container`. The default is container-relative, not viewport-relative.

## Named violations and their fixes

| Violation | What it was | Fix |
|---|---|---|
| `20vw` side track | Viewport unit in `grid-template-columns` — ignores container, counts scrollbar | `fit-content()` + token floor via `minmax()` |
| `calc(20vw - …)` | Measurement-derived track width | `minmax(min(<token>, 100%), fit-content)` |
| `percentify` | Converting a desired pixel width into a percentage of the captured viewport | Express width relationally: `min()`, `clamp()`, `fr`, `fit-content()` |
| `320px` content floor | Hardcoded px ceiling | `var(--rv-content-min)` token |
| `display: grid` on NCA unconditionally | Flattening a working flex/block context | Detect context; modify if flex/grid exists, introduce only if none |
| Squeeze repair | Patching a rendered result (drop `columnCount`) | A `min-width` or `WrapOnOverflow` constraint carries the load |
| `overflow-x: clip/auto` bleed repair | Patching overflow | The layout was over-constrained; fix the constraint |
| Base-coat flat uniformity | Fifty unaddressed clusters get identical bg+text | Each cluster gets its own constraint-driven styling |
| `forceContrast` silent success | A contrast failure silently becomes a readable pair | A contrast failure means the colour constraint was wrong — report it |

## DOM mutation policy

Default: **do not move DOM nodes.** Restructuring is permitted only when the
transformation is genuinely inexpressible in CSS. The closed list:

1. **Escaping an `overflow: hidden` ancestor** — content clipped by a parent
   that is shorter than the child's natural extent.
2. **Escaping a stacking context** — content trapped behind a
   `z-index`/`transform`/`filter` ancestor that prevents correct visual layering.
3. **Moving content across unrelated layout regions** — a sidebar that must
   become a topbar requires source-order change; CSS `order` does not change
   the flow parent.
4. **An impossible ancestry constraint** — the constraint graph has no CSS
   solution given the current DOM tree (e.g. a `MaxWidth` that the parent's
   `min-width` forbids).

Any mutation must carry a recorded reason from this list, or it does not
execute. The check lives in the ops path (`core/ops/index.ts`).

## Resize invariance

A layout built from constraints survives an arbitrary viewport change with no
pipeline re-run. A layout built from measurements does not. This is physics:
the resize-invariance harness (`core/verify/resize.ts`) applies the transform,
changes the viewport across a range, and asserts no new overflow, no new
overlap, no content squeeze, and no invisible text — without re-running the
pipeline. This is a legitimate hard gate.

## Every future layout change is judged against this law.

Reference: `project/src/core/layout/length.ts` (the `Length` type),
`project/src/core/layout/solve.ts` (constraint-driven emission),
`project/src/core/ops/index.ts` (mutation policy).

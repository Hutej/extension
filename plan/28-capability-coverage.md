# Capability coverage and simplicity contract

**Proposed, not implemented.** Purpose: answer exactly what Revueon should support without turning it into a general programming platform. This revision follows the owner's explicit request to remove overengineering and cover color, background, spacing, new elements, typography, behavior, layout, motion, micro-details and canvas. Read with [runtime](08-transformation-runtime.md), [workflow behavior](09-behavior-and-workflows.md) and [roadmap](25-roadmap.md).

## 1. What is covered—and what “anything” cannot mean

Revueon should accept arbitrary natural-language goals, not a menu of theme presets. The runtime implements broad composable mechanisms; it does not need a separate feature module for every phrase, CSS property or visual style. It cannot guarantee every request succeeds on every website: browser permissions, inaccessible application state, model interpretation, destructive actions and performance limits remain real.

| Requested capability | Concrete planned mechanism | Task / proof | Honest boundary |
|---|---|---|---|
| Color | Native validated CSS declarations on observed elements/sets | S4.1–3; T07/T28 | Required readability and scope still enforced |
| Background | Colors, gradients, layering, size/position/repeat, preserving/restyling existing backgrounds | S4.1–3; T07/T22/T28 | New remote images/fonts are not silently fetched through CSS; a separately approved asset-loading feature is outside the initial scope |
| Spacing/density | Margin/padding/gap, line height, intrinsic sizing, logical properties | S4.1–3; T22/T28 | No measured-pixel reconstruction of the whole page |
| Typography | Families available in browser, size/weight/style/features, wrapping, decoration, letter/word spacing | S4.1–3; T07/T22/T28 | Installing/downloading new fonts is separate from typography styling |
| Create and insert elements | One `insertUI` operation for safe native element trees, including containers, cards, panels, headings and local controls | S4.1/2; T31 | No arbitrary executable markup or replacement of site's native application tree |
| Behavior | Approved shortcuts, local toggle/filter/disclosure state and existing control activation | S7.1/2; T15/T16/T31 | Not arbitrary generated JavaScript or unapproved account actions |
| Layout | Native flex/grid/columns/responsive conditions; linked alternative views; guarded same-node moves | S4, S8.1/2; T17/T18/T22 | Framework/overflow/closed-root constraints can require an explicit fallback |
| Motion | Native transitions/keyframes on owned/scoped targets, hover/focus effects, reduced-motion variants | S4.1–3; T07/T22 | No custom animation engine; expensive/unbounded layout animation refused |
| Micro-details | Borders/radii, shadows, outlines, clipping/masks without URLs, cursor keywords, opacity, focus rings, pseudo decoration | S4.1–3; T07/T22/T28 | No second property vocabulary that arbitrarily excludes ordinary browser-supported visual CSS |
| Page “canvas” / overall composition | Page surface, background and layout through CSS | S4; T22/T28 | This is not the HTML Canvas drawing API |
| New HTML Canvas 2D | Owned canvas child of insertUI; bounded data-only drawing records | S8.4; T32 | No arbitrary drawing program, WebGL engine or per-frame agent loop |
| Existing website canvas | Style the surrounding container/element and exposed native controls | S4/S8.2; T18/T32 | Cannot universally identify/rewrite bars, objects, game state or 3D scenes inside pixels; do not resize its backing buffer or monkey-patch its context |

**Coverage conclusion:** the first draft adequately planned ordinary styling and workflows but restricted element creation too much and did not specify new Canvas 2D drawing. Those two paths are now explicit. There is still no claim of unrestricted remote assets, arbitrary website scripting, 3D engines or universal manipulation of opaque canvas internals. If a goal needs one of those, report the missing capability instead of silently doing a different task.

## 2. Generic element creation, not widget-specific scaffolding

`insertUI` inputs: observed anchor targetRef; position `before`, `after`, `first-child` or `last-child`; a bounded tree of nodes. Each node has unique optional localId, supported tag (or text node), text/children, allowed attributes and optional approved actionId. All content is created with native APIs—never model `innerHTML`.

Initial supported tags: div, span, section, article, header, footer, nav, aside, p, h1–h6, ul, ol, li, strong, em, small, code, pre, blockquote, br, hr, a, button, label, input, select, option, details, summary, table, thead, tbody, tr, th, td; owned canvas adds `scene` in S8.4. Validate actual HTML nesting before insertion (e.g. list→li, table→row groups→rows→cells). A root host that is invalid inside a target table/list is refused; do not let browser repair it into an unexpected place.

Attributes are a short typed set, not an arbitrary bag: title; validated role/aria-label/aria-describedby/aria-labelledby/aria-expanded; local accessibility references (including label forRef); button disabled/type; details open; input type/placeholder/min/max/step/initialValue; select/option local values/selection; th scope. Resolve local label/ARIA references to runtime-generated IDs after validating the complete created tree; accessibility references may name a node anywhere within that same tree. Operation refs still cannot name a later insertUI creator. Buttons are always type=button. Local input types initially text/search/checkbox/radio/range/number; local controls never submit to the website, read page credentials or impersonate credential/payment entry. No form action, password/file input, iframe/embed, script/style, inline event attributes, srcdoc, external images, SVG/MathML or custom elements. Links use existing approved action/link refs or explicitly approved safe destinations.

Local controls are useful for owned search/filter/toggle views, not a general app builder. Native details/summary provides disclosure without extra JS. Native checkbox/select/range state uses the same small behavior handler in S7 when it controls other owned UI. Default no persistence of user-entered local control values; native site form/editor state is never copied. Before replacing an owned panel containing edited text, ask to discard that local draft or leave panel unchanged.

### Styling and binding in the same batch

An insertUI operation declares local IDs such as `panel` and `toggle`. A later style operation can target that local node reference; a later binding can associate its approved action. Ref namespace is explicit: observed target versus previously declared owned local node, never ambiguous string interpretation. Validate all IDs/fields before effects. Forward references and duplicate IDs are errors. This needs a Map and one ordered pass, not a dependency graph or component framework.

Prepare owned tree detached, register its resource handles before insertion, insert at validated anchor, then verify placement/accessibility. If any later operation fails, remove the candidate tree/listeners/styles through the same transaction. Replay creates exactly one tree for that customization. Reconcile never clones or re-renders the website's own subtree. Repeated site removal triggers suspension rather than endless reinsertion.

Bounds: 200 nodes/12 levels/16 KiB text per batch; same response/record budgets as other operations. Bounds prevent pathological work, not a new prescribed visual style.

## 3. New Canvas 2D: one small owned renderer

Prefer DOM/CSS for cards, text, controls, simple charts and layouts. Use canvas when the user requests an actual drawing or bitmap surface. Implement inside `runtime/content` when S8.4 starts; no canvas library, scene graph, physics, hit-testing engine, animation scheduler or OffscreenCanvas worker by default.

### Canvas node contract

Fields: localId, tag=canvas, sceneVersion=1, viewBoxWidth/viewBoxHeight (finite positive logical units, each ≤4096), draw[], accessibleDescription and optional structured fallback text/table. Canvas element layout uses normal style operations. Scene coordinates are local logical drawing coordinates, **not measurements written back as website layout**.

Closed drawing records, evaluated in listed paint order:

- rect: x/y/width/height, fill?, stroke?, lineWidth?;
- circle: center x/y/radius, fill?, stroke?, lineWidth?;
- polyline: bounded coordinate points, closed boolean, stroke/lineWidth, optional fill for closed polygons;
- text: x/y/plain text, validated solid fill, font family/size/weight, alignment (start/center/end).

Every numeric field finite; dimensions/radii nonnegative; points bounded; colors validated solid CSS colors. Coordinates limited to four viewBox extents to avoid pathological geometry. At most 256 draw records and 2,048 total polyline points per canvas; text≤4 KiB/scene. No script strings, method names, arbitrary context properties, images/URLs, pixel readback, filters invoking external resources or data fetched from the page canvas. Simple diagrams/charts compose these records; missing primitives are explicit unsupported drawing capability, not an invitation to evaluate code.

### Lifecycle algorithm

```text
validate complete scene and reserve resource budget
create owned canvas + accessible fallback, never borrow a page canvas
measure owned CSS box; choose capped backing scale from devicePixelRatio
set only owned backing width/height and reset transform
uniformly scale and center logical viewBox inside owned box (contain, not stretch)
draw records in order with no mutation of website layout
on owned size/scene change: coalesce one redraw
on hidden/zero-size box: wait; no zero-size allocation/redraw loop
on disable/rollback: disconnect observer and remove owned host
```

Cap backing scale at 2, each canvas at 1 million pixels and total owned canvases at 2 million pixels/document (maximum four canvases). If full requested resolution exceeds budget, lower backing scale with explicit resolution diagnostic; never silently truncate the drawing. If no allocation/context is possible, show fallback with `canvas-unavailable`, not canvas success. Resize-driven redraw uses native ResizeObserver plus a one-shot scheduled callback, not a perpetual requestAnimationFrame loop. Context loss pauses; on restoration redraw saved data once, otherwise keep fallback. No provider call for redraw/replay/resize.

Canvas animations initially mean CSS animation of the canvas element. Animated internal drawings, arbitrary games, WebGL/WebGPU and canvas-only interactive controls are **not** promised by this renderer. Use native DOM controls around the drawing for accessible interaction. Do not bolt on a graphics framework to answer a vague “canvas” request.

## 4. Simplifications adopted

| Removed from proposed implementation | Replacement | Why capability/safety is retained |
|---|---|---|
| One file/service per detailed module heading | Cohesive physical layout; logical contracts remain documentation | Fewer moving parts without mixing trust boundaries |
| Optional/required subgroup DAG and topological execution | One ordered reversible batch per revision | Easier for weak models; all-or-rollback is clearer and safer |
| Separate per-task narrative reports as default | One compact `plan/progress.md` evidence log | Session recovery/proof remains, less paperwork |
| Speculative persisted diagnostic retention system | Bounded session ring and explicit export | Debugging remains; durable operational receipts are not deleted |
| Incomplete handcrafted dictionary of ordinary CSS properties | Browser/parser syntax support + focused security/impact policy | Broader visual vocabulary without allowing code/network injection |
| Annotation-only creator and future widget-per-feature temptation | One insertUI safe native element tree | Cards/panels/toolbars/annotations share creation, styles and undo |
| Potential canvas/animation frameworks | Native CSS motion and small optional Canvas 2D draw loop | Covers requested basics without a second rendering platform |

Retain target validation, one effect owner, exact CSS receipts, original-site undo baselines, cancellation fences, content/credential protection and real browser tests. Removing those would recreate already-identified correctness bugs, not eliminate overengineering.

## 5. Completion proof

- T31: insert a card containing heading/text/button/local control at each valid position; style its local refs in same batch; test label/focus, invalid nesting/attribute/ref, partial failure rollback, disable and reload without duplicates. S4.2 owns creation; S7 owns behavior bindings.
- T32: draw known shapes/text into owned canvas, resize/zoom, hide/show, lower resolution at cap, reject malformed/oversized scene, handle context unavailability, replay/disable without observer leak. Assert a separate page-owned canvas retains its node, pixels/context use and backing dimensions. S8.4 owns this.
- T07/T22/T28: typography features, container layout, decorative pseudo-elements, hover/focus motion and finite requested layout motion use the same CSS path; unsafe URLs and unbounded motion remain rejected. Do not claim visual completeness from one background-color change.

Documentation coverage is not executable proof. The current source remains an incomplete prototype until its corresponding tasks and acceptance tests pass.

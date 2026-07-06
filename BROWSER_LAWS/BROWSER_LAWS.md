# COLOR LAWS

### Color

1.  **Computed Contrast Gates:** WebMorph must NEVER inject absolute colors (e.g., `background: #FAF8F5`) without first checking the element's existing computed background color. If the existing color is dark, injecting a light background will render the original white text invisible.
2.  **Inherit for Inline UI:** Inline interactive elements (links, bold text) should use `inherit` for color and rely on `text-decoration` or `font-weight` for differentiation. This completely bypasses contrast violations.
3.  **Global Resets are Safe for Block Structural Elements:** Code blocks (`pre`), blockquotes, and `table` borders are generally safe to hit with absolute background colors (like `#f6f8fa`) because they are heavily isolated structural islands.

### Color

1.  **Color Context Requires AI:** Browser DOM signals alone are fundamentally insufficient to classify semantic colors. We must NEVER write flat heuristics to recolor "alerts" or "buttons." We must pass the raw Interface Graph (with computed colors) to the LLM and allow AI to deduce the semantic meaning based on human-like visual reasoning.
2.  **Batch Style Extraction:** Sequential `getComputedStyle` calls are too slow for complex SPAs (>800ms). Future color extraction must rely on the CDP `DOMSnapshot` capability (proven in Exp 004) to batch-extract styles.

### Color

1.  **The Shorthand Mandate:** To guarantee a visual override of a container, WebMorph must always inject the shorthand `background` property. Using `background-color` is completely unsafe as it leaves gradients and images intact on top.
2.  **The Transparency Rule:** WebMorph must NEVER inject background colors globally. Because 95% of DOM nodes are transparent, forcing a background on all nodes will destroy the visual structure and padding. Background overrides must strictly target nodes that already possess a non-transparent computed background.
3.  **The Contrast Lock:** A background color can never be safely overridden without simultaneously overriding (or mathematically verifying) the `color` (text) property. They must be injected as a coupled pair to prevent invisible text.

### Color

1.  **The Relative Color Law:** WebMorph MUST NEVER replace colors using absolute Hex/RGB values unless explicitly commanded. It must leverage native CSS Relative Color Syntax (`lch(from current calc(l +/- delta) c h / alpha)`) to dynamically shift elements. This mathematically guarantees the preservation of existing visual hierarchies.
2.  **The Alpha Inheritance Law:** When transforming transparent overlays or glassmorphic backgrounds, WebMorph must explicitly append `/ alpha` to the relative syntax to instruct the browser engine to preserve the original author's opacity intent.
3.  **The Mathematical Variable Injection:** When a site uses CSS Variables (`--primary-color`), WebMorph can inject `:root { --primary-color: lch(from var(--primary-color) calc(l + 10) c h); }`. The browser will infinitely recurse the mathematical transformation down through the entire cascade perfectly.

### Color

1.  **The Filter Fallback Law:** To instantly guarantee a layout-safe, contrast-safe dark mode without DOM walking, WebMorph MUST utilize `html { filter: invert(1) hue-rotate(180deg) }`. It is the only universal engine-level transformation that inherently respects the Transparency Law (Exp 003).
2.  **The Double-Invert Mandate:** When utilizing global filters, all semantic media (`img, picture, video, svg, canvas, iframe`) MUST receive an identical inversion filter to revert them to their natural state.
3.  **The Variable Preference:** If a site exhibits a robust CSS variable root, WebMorph should prioritize injecting mathematically inverted LCH relative variables over global filters, as variables preserve box-shadow physics and brand identity far better than mathematical inversion.


# INTERACTION LAWS

### Interaction Physics

1. **The Hover Safety Mandate:** WebMorph MUST rely exclusively on 	ransform: scale, ox-shadow, and ilter for creating hover states. It must NEVER inject margin, padding, width, or order inside a :hover block to prevent interaction flickering and layout thrashing.
2. **The Accessible Focus Rule:** WebMorph MUST inject custom focus rings using outline and outline-offset combined with the :focus-visible selector, rather than generic :focus, to preserve native browser accessibility without annoying mouse users.

3. **The Transition Mandate:** WebMorph MUST use 	ransition (never nimation) for interactive state changes (:hover, :active, :focus) to guarantee graceful mid-flight reversal when the user interrupts the interaction.
4. **The Tactile Active Rule:** WebMorph SHOULD inject 	ransform: scale(0.97) on :active states for interactive elements to provide layout-safe tactile feedback. It MUST NEVER inject layout-altering properties (margin, padding, order-width) on :active.
5. **The Compositor Lock:** WebMorph MUST strictly limit transitions and animations to 	ransform, opacity, ilter, ox-shadow, and color. Transitioning structural properties (width, margin) forces the browser to recalculate layout on every single frame (60 reflows per second), guaranteeing severe frame drops and jitter.



# LAYOUT LAWS

No permanent layout laws established yet.
(Experiment 001 - Layout Model Discovery did not exhaustively test failure cases per Protocol v2).

### Layout Failure Boundaries

1. **The Implicit Grid Overlap Law:** Grid cells are not physically sealed. Elements within an implicit grid layout can and will physically overlap if they possess negative margins or CSS transforms, despite not having explicit grid placement coordinates.
2. **The Dimensional Expansion Hazard:** Injecting arbitrary dimensional expansion (width: >100%) onto an element is universally destructive across all layout models (Block, Flex, Grid), guaranteed to trigger clipping, overlap, or horizontal scrolling.

3. **The Flex Intrinsic Overflow Law:** By default, Flexbox will permit a child to physically overflow and clip its parent container if the child's intrinsic content (min-content, such as a long text string) exceeds the available space. The browser's native lex-shrink algorithm is physically bounded by min-content and will not prevent this destruction unless manually overridden.



# MOVEMENT LAWS

### Layout

1. **The DOM Order Trap**: You cannot move an element visually "up" the page using `position: static` or floats if its raw HTML node is located *below* the target area in the DOM tree. The only CSS-native way to force elevation regardless of DOM order is `position: fixed` or flex `order`.
2. **The Expansion Fallacy**: Shrinking elements is universally layout-safe. Expanding elements (`width: 100vw`) is highly destructive.
3. **Space Reclamation**: You cannot simply `display: none` a sidebar and expect a clean redesign. The adjacent content's margins and widths must simultaneously be rewritten to reclaim the void.

### Mechanisms

1.  **The Movement Prohibition Law:** WebMorph MUST NOT attempt to structurally rearrange a page using `transform`, `position: relative`, `position: absolute`, or massive `margin` overrides. These primitives are fundamentally unsafe for macro-layout.
2.  **Constraint-Driven Movement:** The only safe way to move a structural component across a page is to mutate its Constraint Owner (CSS Grid / Flexbox), utilizing the Track Mapping interval discovered in Execution Experiment 004.
3.  **Micro-Movement Exception:** `transform` and `relative` are exclusively authorized for Micro-Mutations (e.g., a tiny `translateY(-2px)` on a button hover), provided the displacement remains within the parent's clipping boundary.

### Visual Reordering

1.  **The Reordering Mandate (Revised):** WebMorph MUST execute macro-reordering (e.g., swapping panels, moving navigations) exclusively through CSS Grid/Flexbox properties (`order`, `grid-column`, `flex-direction`). It must NOT use `appendChild` or `insertBefore` unless structurally impossible.
2.  **The Cross-Boundary Strategy:** If WebMorph must reorder two components that do not share an immediate Constraint Owner, it must recursively apply `display: contents` to the intervening wrapper nodes until the components share a layout context.
3.  **The Accessibility Warning:** Visual reordering via CSS degrades accessibility synchronization. This is an acceptable engineering tradeoff to preserve SPA state stability during mutations.

### Wrapper Flattening Limits

1.  **The Flattening Restriction:** WebMorph MUST NOT apply `display: contents` to any wrapper node that possesses a background, border, padding, margin, `position: absolute/fixed`, or `overflow: hidden`. Doing so will permanently destroy the visual integrity of the layout.
2.  **The Structural Assessment:** Before executing a cross-boundary reorder, the WebMorph compiler must compute the exact CSS payload of the target wrapper. If the wrapper is impure, WebMorph must either abort the cross-boundary swap OR dynamically extract the wrapper's CSS properties (padding, background) and explicitly re-inject them onto the *children* before flattening the parent.

# SIZING LAWS

### Dimension Control

1.  **The Maximum Constraint Law:** Injecting `width` or `height` is physically meaningless if the element or its parent is governed by `max-width` or `max-height`. WebMorph MUST clear `max-*` constraints before attempting to resize structural components.
2.  **The Horizontal Overflow Law:** Expanding a component horizontally inside a Block layout always creates destructive scrollable overflow because block parents refuse to grow horizontally. Horizontal expansion is only safe inside Flex or Grid contexts that allow wrapping or proportional shrinking.
3.  **The Flex/Grid Elasticity Law:** Resizing an element inside a Flex or Grid container inherently stretches or shifts its siblings. The layout engine (parent) owns the sibling geometry; modifying one node modifies the matrix.
4.  **The Vertical Reflow Asymmetry:** Browsers are designed for vertical elasticity. Expanding an element's height pushes siblings downward safely. Expanding an element's width almost always triggers a layout collision or horizontal scrollbar.

### Spacing Physics

1.  **The Margin Collapse Trap:** WebMorph MUST NOT rely on injecting `margin` to create precise vertical spacing in Block contexts, as the browser will collapse it unpredictably against unknown sibling margins.
2.  **The Box-Sizing Limit:** WebMorph MUST NOT inject `padding` values larger than an element's existing width/height. Doing so physically shatters the `border-box` constraint and forces BoundingRect expansion, causing layout shifts.
3.  **The Auto-Margin Hijack:** WebMorph MUST definitively verify a component is NOT in a Flex container before injecting `margin: auto`.
4.  **Gap Supremacy:** The `gap` property provides the only mathematically pure, non-collapsing spacing mechanism, but WebMorph MUST dynamically convert Block parents to `display: flex; flex-direction: column` before injecting it.

### Real-World Validation

1.  **The Maximum Constraint Law is Absolute:** You physically cannot resize a modern webpage component without simultaneously neutralizing `max-width` and `min-width` constraints. This graduates to a Permanent Law.
2.  **The Elasticity Illusion:** We cannot mathematically guarantee that modifying a Flex child will shift its siblings. If `flex-wrap` is active, the layout resolves vertically instead of horizontally.

### Constraint Solver

1.  **The Min-Width Trump Card:** `min-width` mathematically overrides both `width` and `max-width` in the Chromium engine.
2.  **The Flex-Basis Override:** WebMorph MUST modify `flex-basis` rather than `width` when attempting to explicitly size components inside a Flexbox layout.
3.  **The Percentage Padding Law:** WebMorph MUST NEVER use percentage-based vertical padding/margins unless it intentionally desires them to scale horizontally with the parent's width.
4.  **The Height Percentage Trap:** WebMorph MUST NEVER inject `height: 100%` into a node unless it can programmatically verify that the parent node has a rigid, explicitly declared height. Otherwise, the constraint silently fails to `auto`.


# SURFACE LAWS

### Surface Primitives

1.  **The Paint-Only Mandate:** WebMorph MUST default to `outline` instead of `border` for safely framing arbitrary components, and rely heavily on `box-shadow` and `border-radius` for safe surface upgrades.
2.  **The Border-Box Condition:** WebMorph MUST NOT inject a `border` property into a node unless it simultaneously injects or validates `box-sizing: border-box`.

### Native Control Surface Compatibility

1.  **The Appearance Mandate:** Before WebMorph injects surface upgrades (like `border-radius` or custom backgrounds) onto an `<input>`, `<select>`, `<textarea>`, or `<button>`, it MUST simultaneously inject `appearance: none` (and `-webkit-appearance: none`). 
2.  **The Checkbox/Radio Exemption:** WebMorph should generally AVOID attempting to style `<input type="checkbox">` or `<input type="radio">` directly, as stripping their appearance entirely destroys their native checkmark/dot rendering, requiring complex SVG recreation.



# TYPOGRAPHY LAWS

### Typography

1. NEVER trust HTML semantics (`<article>`, `<main>`) to isolate reading content, as they are frequently used for layout grids and card feeds.
2. ALWAYS use Text Density (`directTextLength / area`) and Interactive Ratio (`interactiveCount / totalTextLength`) to identify true reading blocks.
3. Widgets and sidebars can be reliably identified by evaluating if they occupy less than 40% viewport width and are physically pushed to the screen edges, combined with a high interactive ratio.

### Typography

1.  **Hierarchy Coupling:** You cannot safely increase body `font-size` without proportionately increasing `h1-h6` tags. Typography must be applied as a *complete mathematical scale* (e.g., Modular Scale), never as isolated properties.
2.  **Link Clarity:** Never remove underlines from links (`text-decoration: none`) inside body text; it destroys usability. Always use `text-underline-offset` to improve aesthetics safely.
3.  **The 18px Limit:** Unless the layout container is explicitly responsive, forcing base font sizes above `18px` risks breaking nested rigid-width UI components due to text expansion.

### Typography

1. **Never Inject Absolutes:** WebMorph must never hardcode `18px`. It must extract the baseline (e.g., 16px) and apply a scalar `+12.5%`.
2. **Preserve Modular Scale:** When scaling body text, WebMorph must extract the site's existing Modular Scale ratio and multiply the new body size by that ratio to dynamically generate the new `H1`-`H6` values, perfectly preserving the site's original visual hierarchy.
3. **Measure Over Assume:** Line length (`ch`) cannot be assumed. It must be physically measured by injecting a temporary 100-character string into the DOM to determine the true pixel-to-character ratio of the active font.

### Typography

1. **The Law of Absolute Override:** To guarantee a visual override in the Light DOM without perfectly matching the original selector's specificity, WebMorph MUST use `!important`. Normal CSS injection will arbitrarily fail against framework stylesheets.
2. **The Variable Preference:** If a site uses CSS variables for a property (e.g., `--primary-color`), WebMorph should always override the variable at the `:root` level rather than targeting the elements. It is infinitely safer and completely bypasses specificity wars.
3. **The Shadow Boundary Limit:** Global CSS injection is strictly limited to the Light DOM. If a site is built heavily with Web Components (like Reddit or YouTube), global `<style>` injection will silently fail on those components.

### Typography

1.  **The CSS Variable Preference:** The safest, most robust method for theming a Web Component is to scan it for CSS variables and override them at the Light DOM `:root`. This completely bypasses the need to pierce the shadow boundary.
2.  **The Injection Mandate:** If variables do not exist, WebMorph MUST recursively walk the DOM to find `shadowRoot` objects and physically inject a `<style>` tag (or mutate the `adoptedStyleSheets` array) directly inside each root.
3.  **The Declarative Workaround:** Because JavaScript hooks cannot catch Declarative Shadow DOM, WebMorph cannot rely on interception arrays. It must rely on native browser APIs (or CDP) to recursively walk the `DOM` and collect the attached `shadowRoot` properties manually after parsing.


# VISIBILITY LAWS

### Visibility Fundamentals

1.  **The Layout Collapse Law:** To hide an element AND collapse the surrounding layout space, WebMorph MUST use `display: none` (or the `hidden` attribute). All other techniques preserve spatial voids.
2.  **The Space Preservation Law:** To hide an element but strictly preserve the page layout (avoiding jank and reflows), WebMorph MUST use `visibility: hidden`.
3.  **The Focus Security Law:** WebMorph MUST NEVER use `opacity: 0`, `clip-path`, or off-screen positioning (`left: -9999px`) to suppress UI components (like ads or banners). These methods leave the invisible components fully active in the focus tree, degrading accessibility and allowing accidental user interaction.

### Layout Reflow

1.  **The Flex Redistribution Law:** You cannot safely hide an element (`display: none`) inside a Flexbox container without mutating the physical dimensions (`width`/`height`) of its adjacent siblings, unless they possess rigid fixed dimensions.
2.  **The Grid Shift Law:** You cannot safely hide an element inside a CSS Grid container without forcing all subsequent siblings to shift into the wrong grid cells. 
3.  **The Absolute Void Law:** Removing an absolutely positioned element never triggers a layout reflow for its siblings; it is inherently layout-safe but will leave a spatial void.
4.  **The Master Reflow Law:** If an element disappears, Chromium redistributes space according to the *parent* layout algorithm, not according to the removed element.

### Layout Reflow

1.  **The Grid Freeze Law:** To safely hide an element in a CSS Grid without causing structural shifts, WebMorph MUST compute and inject explicit `grid-column` and `grid-row` coordinates on all subsequent siblings before applying `display: none`.
2.  **The Flex Zero-Bound Law:** To safely collapse an element in a Flexbox container without triggering component unmounting issues or margin-collapse bugs, WebMorph MUST use a chained injection: `visibility: hidden` coupled with `flex: 0 0 0px; margin: 0; padding: 0; border: 0; overflow: hidden;`. This mathematically forces a 0-width void that securely triggers flex redistribution.

### Persistent Suppression

1.  **The Declarative Persistence Law:** To guarantee flicker-free, zero-CPU persistence across React/Vue dynamic unmounting and infinite scrolling, WebMorph MUST rely on injecting global declarative `<style>` rules based on stable selectors, rather than relying on `MutationObserver` heuristics.
2.  **The MutationObserver Limit:** JavaScript DOM observers must be relegated strictly to identifying unstable components (where classes change randomly) to inject stable tracking attributes. They should never be used as the primary suppression mechanism due to latency and main-thread blocking constraints.
3.  **The Shadow Amnesia Law:** WebMorph must actively monitor the DOM for the birth of new Shadow Hosts, because any previously suppressed Shadow DOM components will lose all injected styling the moment their parent framework unmounts and remounts them.

### Suppression Detection

1.  **The Geometry & Density Law:** The browser's native calculation of BoundingRects and Interactive Density Ratios provides a mathematically stable, CSS-selector-free fingerprint for classifying UI structure. WebMorph MUST use these physical measurements rather than relying on brittle semantic classes or heuristic AI guessing.
2.  **The Sidebar Constraint:** Any structural node with a width between 150px and 400px, occupying the extreme left or right bounds of the viewport, with an interactive ratio > 0.50, is deterministically a sidebar or secondary navigation menu.
3.  **The Content Mass Rule:** The primary content of a webpage is deterministically the node with the highest absolute text mass that also possesses an interactive ratio < 0.30 and occupies the central horizontal bounds of the viewport.
# 01 Project Vision

## What WebMorph is
WebMorph is a tool that allows users to transform arbitrary websites using natural language by deeply understanding semantic intent and safely modifying the page at runtime.

## What problem it solves
Websites are rigid and often prioritize the creator's layout or goals over the user's preferences. Users currently lack a simple, universal way to reshape their web experience (e.g., hiding distractions, compacting UI, enhancing accessibility) without writing complex scripts or relying on fragile CSS selectors.

## Why it exists
To give users total control over their web experience through intent-based transformations rather than brittle code-based theming.

## What success looks like
Users can describe their intent (e.g., "Hide YouTube Shorts", "Make LinkedIn compact", "Give me a floating Spotify player") and WebMorph automatically, deterministically, and safely executes the transformation across the site without breaking its core functionality.

## What WebMorph is NOT
* A generic CSS theming engine
* A developer tool for manual DOM hacking
* A brittle web scraper that breaks on every site update
* A research playground for architectural over-engineering


# 02 Product Principles

* **Users describe intent.** The user's natural language request is the starting point.
* **AI understands.** The system translates human intent into a semantic understanding of the website.
* **Never break websites.** Functionality and interactivity must be preserved. Transformations must be safe.
* **Preserve functionality.** The core utility of the website must remain intact.
* **Transformation over theming.** We change the behavior and structure to meet user intent, not just swap colors.
* **Product over architecture.** Every line of code must justify how it helps execute a user prompt.
* **Simple over clever.** Avoid unnecessary abstraction.
* **Deterministic execution.** Results must be repeatable and predictable.


# 03 Engineering Principles

* **Every package must justify its existence.** If it doesn't directly help transform websites, it gets deleted.
* **Every abstraction removes complexity.** If an abstraction adds cognitive load without simplifying the core product, it must be removed.
* **Delete before adding.** Continuously aggressively remove dead code, unused systems, and failed experiments.
* **Evidence beats assumptions.** Build features based on proven browser physics and validated capabilities, not hypothetical architectures.
* **Research exists only to improve the product.** We do not do research for research's sake.
* **No unnecessary architecture.** Code should be as simple as possible. Keep knowledge, delete architecture.

# 05 Product Roadmap

The roadmap is strictly product-driven. Every milestone must unlock a real user capability.

## Milestone 1: Focus & Distraction Removal
* Hide YouTube Shorts
* Hide Twitter "For You" timeline
* Reddit auto-collapse of promoted content

## Milestone 2: Layout Optimization
* LinkedIn compact mode
* GitHub Kanban view simplification

## Milestone 3: Workflow Enhancement
* Gmail keyboard-first navigation
* Spotify floating player
* Universal shortcuts across distinct websites

## Milestone 4: Advanced Control
* Workflow rewrites
* Layout reconstruction
* Behavior rewriting
* Persistent user profiles


# 06 Experiment Registry

Keep the knowledge from every experiment. Never repeat solved experiments.

## Experiment: Semantic Representation Quality (Minimalist LLM Transformations)
* **Question:** What is the absolute minimum information representation required for an LLM to reliably execute complex website transformations?
* **Hypothesis:** Lean, evidence-based minimalist bounding boxes provide better reasoning quality than heavy, heuristic-based ontologies.
* **Method:** Compared six candidate representations ranging from raw DOM data to minimalist bounding boxes, analyzing LLM reasoning quality.
* **Result:** Minimalist representations proved highly effective, eliminating the need for heavy architectural layers.
* **Decision:** Move away from large compiler intelligence and heavy ontologies towards lean, first-principles representations.
* **Permanent Knowledge:** AI understands simpler, cleaner representations better than bloated DOM dumps.

## Experiment: CSS Layout Boundaries (Deterministic Design Compiler)
* **Question:** Can we deterministically transform websites into specific visual design languages without AI-generated CSS?
* **Hypothesis:** Semantic component extraction combined with a deterministic compiler can reliably inject composition-aware CSS.
* **Method:** Empirical validation across major websites using Playwright-based testing.
* **Result:** It is possible to map high-level semantic recipes to deterministic browser instructions.
* **Decision:** Avoid on-the-fly AI CSS generation; rely on deterministic, mapped styling.
* **Permanent Knowledge:** Visual transformations must be executed deterministically.

## Experiment: Browser Styling Capabilities
* **Question:** What are the physical limits of modern CSS engines for structural manipulation?
* **Hypothesis:** Layout failure boundaries (overflow stress, track collapse) can be deterministically measured and avoided.
* **Method:** Empirical measurements of layout failure boundaries across controlled playgrounds and production websites.
* **Result:** Established safe boundaries for structural manipulation without causing functional regressions.
* **Decision:** Implement strict guardrails for layout mutations based on physical CSS limits.
* **Permanent Knowledge:** Layout mutations must respect track collapse and overflow boundaries to maintain functionality.

## Experiment: WebMorph Typography Capability Lab
* **Question:** Can generic, safe typography enhancements be applied across diverse websites without layout regressions?
* **Hypothesis:** Safe typography CSS strategies can be isolated and applied generically to content-heavy pages.
* **Method:** Controlled browser experiments and automated testing to validate typography enhancements.
* **Result:** Identified optimal CSS strategies that do not break layout.
* **Decision:** Typography enhancements are a proven, safe baseline capability.
* **Permanent Knowledge:** Safe typography variables and rules are permanently validated.


# 07 Browser Laws

This document collects permanent browser laws discovered.
(Detailed logs are preserved in `/BROWSER_LAWS/`)

* **Observation Level 0:** The DOM is the source of truth, but visual layout dictates meaning.
* **Mutation Safety:** Layout mutations must respect track collapse and overflow boundaries to maintain functionality.
* **Constraint Ownership:** The browser engine owns layout constraints; we must not violate them.
* **Runtime Execution:** Structural manipulation must occur deterministically to avoid functional regressions.


# 09 Capabilities

This document tracks all proven capabilities of WebMorph.
(Detailed capability journal is preserved in `/RESEARCH/CAPABILITY_JOURNAL.md`)

## Proven Capabilities
* **Deterministic Design Compiler:** Can deterministically transform websites into specific visual design languages.
* **Minimalist Representation:** Can extract and map semantic components using lean bounding box representations for AI reasoning.
* **Typography Injection:** Can safely inject and enhance typography globally without breaking layout.
* **Safe Layout Boundaries:** Can determine physical limits of modern CSS engines to ensure structural manipulation is safe.

## Limitations
* AI is prone to hallucinations when generating CSS; must use deterministic styling.
* Large intelligent compilers and ontologies add unneeded complexity and reduce reliability.

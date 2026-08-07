# 02 — PRINCIPLES

*Binding law. If code and this file disagree, the code is wrong.*
*Twelve principles: seven from the founder, five corrections from the 7 Aug review.*

Every principle below has a **test**. A principle without a test is a slogan, and this project has
already died once from slogans.

---

## P1 — Build representations, not features.

A feature is a branch. A representation is a thing the system can hold, inspect, and reuse.
"Hide" is not a feature; it is an operation over a representation of an element. "Dark mode" is
not a feature; it is a value in a representation of colour.

**Forbids:** a module, class, route or file named after an operation. Nobody writes a
`subtract/` module. Claude Code has no `rename-variable/` directory.

**Test:** grep the source tree for directories and files named after verbs. There must be none.

---

## P2 — Observe before reasoning.

No model call may be made about the page before evidence about the page has been collected. And
observation itself collects evidence only — it never decides.

**Forbids:** an observation function that returns a plan, a spec, a style, a decision, or anything
that implies intent. Observation returns facts and a confidence number.

**Test:** every observation tool's return type contains no field that could be applied to a page.

---

## P3 — Escalate intelligence only when confidence is insufficient.

Depth is chosen at run time, from evidence. Never from a keyword, a category, a request length, or
a hardcoded route.

**Forbids:** any table mapping request text to a code path. Every request goes to the model.

**Corollary, equally binding:** low confidence means **do less**, not guess more. Zero output is a
successful outcome. Partial output is a successful outcome. "I hid Shorts, I could not find the
sidebar, here is why" is a **good** result.

**Test:** the word `fallback` does not appear in the source tree as a mechanism that invents work.
No function fills in decisions the model did not make.

---

## P4 — Express intent, never implementation.

Say what should be true, not how to make it true. `--rv-side-max: min(280px, 30cqi)` is intent.
`width: 283.5px` measured off the live page is implementation, and it is frozen the instant the
window resizes.

**Forbids:** any length derived from a measurement of the current page being written back into the
page.

**Test:** a transformation survives a window resize from 1440px to 380px and back without breaking.
This is the single surviving hard law from Law 0 and it is not negotiable.

---

## P5 — Every operation must be reversible.

Off must restore the page **byte for byte**. Not approximately. Not visually. Identically.

**Forbids:** destructive DOM edits with no recorded inverse; state that only exists in the DOM;
"reverse" implemented as "try to undo each step."

**Test:** `on → off → on → off` produces a DOM identical to the original. This has never passed and
until it does, every measurement ever taken on this project is suspect.

---

## P6 — Let the browser do browser work. Let AI do reasoning.

The browser has millions of lines of layout engine. We have none. Reflow, wrapping, intrinsic
sizing, the cascade, container queries, `clamp()`, `minmax()`, `:has()` — all of it is free and all
of it is better than anything we will write.

**The sharpest form of this rule:** we currently *edit* the DOM and then *defend* the edit with a
ten-attempt re-application loop, because frameworks re-render and undo us. That is an arms race we
lose. **Hand the browser a stylesheet instead.** The cascade then applies our rules forever, to
every matching element, **including elements that do not exist yet**. A framework re-render stops
being an attack and becomes an event we never hear about.

**Forbids:** DOM mutation without a declared, recorded reason. Mutation is the rare exception —
required for inserting text, binding keys, adding a toggle affordance — and it must say why.

**Test:** the defence loop shrinks toward zero as the stylesheet path grows. Any surviving mutation
call site supplies a reason string.

---

## P7 — Build capabilities that compose, not pipelines that duplicate.

A capability is a tool with one job and a clean signature. A pipeline is a fixed sequence someone
has to maintain. Ten composable tools beat three pipelines, because ten tools have far more than
ten behaviours.

**Forbids:** a second code path that does 80% of what an existing one does. When you feel the urge
to add a route, you are duplicating a pipeline.

**Test:** every capability is callable on its own, in any order, and appears exactly once.

---

## P8 — The model writes the answer.

We do not translate model intelligence through a vocabulary we invented. The model produces the
artifact; we **validate and repair** it. Review is a thing we are good at. Authoring by lookup
table is not.

**Forbids:** an intermediate token language between the model and the output whose only purpose is
to be expanded by our code.

**Test:** the model can express something we never thought of, and it works.

---

## P9 — Execution scope equals decision scope.

If the agent reasoned about three elements, exactly three elements may differ. Everything else in
the document is provably untouched.

**Forbids:** page-wide relayout as a side effect of a local request.

**Test:** snapshot before, snapshot after, diff. Nodes outside the decided subtree are identical.

---

## P10 — Applying is an experiment.

After acting, read the page back and compare against **reality**, not against the plan. Checking
that output matches intent is a compiler validating its own AST; it proves nothing about the screen.

**Forbids:** a verification step that runs before the browser has rendered, or that compares only
to internal state.

**Test:** every verification tool reads the live DOM after layout.

---

## P11 — There is a stream of results, not one result at the end.

The cheapest correct change lands in the first second. Refinements arrive as they are computed.
The user can stop it at any point.

**Forbids:** accumulating a whole plan and applying it in one batch.

**Test:** something visible and correct happens within one second of the user pressing go.

---

## P12 — A test may never be edited to make it pass.

When a check fails, the extension is wrong until proven otherwise. Loosening a threshold, widening
a tolerance, or excluding a case is falsifying evidence.

And: **every check ships with a deliberate failing case.** A gate that has never failed has never
been shown to work.

**Test:** the harness contains at least one case that must fail, and it fails.

---

## Two words that are banned

**"Intermittent."** Nothing in a deterministic system is intermittent. It is a race, a timeout, or
a state you have not modelled.

**"Harness artifact."** Used twice on this project to explain away invisible text and a broken
toggle. Both were real. If the harness sees it, the user will see it.

---

## The final authority

Green checks are not completion. **A human eye on a real site is the only pass.** Any region that
looks wrong is a failure even if every automated check is green.

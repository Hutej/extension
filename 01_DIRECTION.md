# 01 — DIRECTION

*The architectural thesis. Everything else in this folder is downstream of this file.*
*Origin: senior developer review, 6 Aug 2026, adopted 7 Aug 2026.*

---

## The wrong problem

Revueon was built on one assumption:

> **One user request = one transformation pipeline.**

Every request — trivial or enormous — enters the same machine, pays the same cost, and takes the
same path. "Hide Shorts" invokes the identical machinery as "Transform this website into an
Apple-style documentation experience."

That assumption is false, and every correct engineering decision made on top of it inherited the
error. This is why three months of good work produced a bad product.

## The right problem

> **Every user request is an investigation.**

This is how Cursor, Claude Code, Gemini CLI and MimoCode work. They do not run a fixed pipeline.
They work progressively:

```
Receive goal
  → Estimate complexity
  → Observe the smallest amount possible
  → Enough information?
      YES → solve
      NO  → observe more
  → Deeper investigation if still uncertain
  → Solve
  → Look at what happened
```

The governing sentence:

> **Reasoning is proportional to uncertainty. Not proportional to capability.**

A coding agent asked to rename a variable does not read the whole repository. Asked to refactor an
auth system, it reads for ten minutes first. Same agent. Same tools. Different depth, chosen at
run time from evidence — never from a category decided in advance.

## Observation is the primary primitive

Before anything else happens, the system answers:

- What is the user referring to?
- Where is it?
- How confident are we?
- Is more context required?

And one hard constraint:

> **Observation collects evidence. Observation never makes design decisions.**

The moment an observation layer starts deciding, you have rebuilt the pipeline with extra steps.

## Progressive observation — six levels

| Level | Scope | What it means |
|---|---|---|
| **0** | Intent only | No DOM. Understand the goal and the origin. |
| **1** | One named thing | "Shorts", "the sidebar", "comments", "the footer", "navigation". |
| **2** | One component | A hero, a card grid, a table, a search box, a nav bar. |
| **3** | One region | A meaningful section of the page and its immediate context. |
| **4** | Whole page | Today's `perceive()`. Only now is full-page reasoning justified. |
| **5** | Whole site | Cross-page understanding, persistent design systems. Not built. |

Reasoning depth mirrors it: level 1 needs a locator, level 4 needs a designer.

**Most requests must never reach level 4.** Today, all of them do.

## Escalation is driven by confidence, never by category

Every observation returns four numbers: **confidence, latency, complexity, cost.**

```
Semantic locator · confidence 98% · 35 ms  →  stop here, act
Semantic locator · confidence 47% · 35 ms  →  escalate one level
```

> The system must never escalate because "that's the pipeline."
> It escalates because the evidence it has is insufficient.

And the sibling rule, which is equally binding:

> **Low confidence means do less. It never means guess more.**

## The Architect does not disappear

The Architect becomes **the highest observation level, not the default execution path.**
It is one tool the agent may reach for when the evidence says it needs a whole-page designer.
Everything else bypasses it completely.

## The architectural law

> **Every user request must be solved using the minimum observation level, the minimum reasoning
> depth, and the minimum execution scope capable of producing a correct result with sufficient
> confidence. Escalate only when additional evidence is required.**

---

## Four corrections adopted on top of the thesis (7 Aug 2026)

The thesis fixes the *input* side. These four fix the rest.

### C1 — The model writes the answer. It does not fill in our vocabulary.

Revueon asked the model to emit a `DesignSpec` of 37 relation tokens, which a deterministic
expander turned into CSS. That expander was the real designer, and it was a lookup table.

A vocabulary is a **ceiling**, not a safety rail. The model can only express what our tokens can
say. "Summarise this article" was not a missing feature — it was **unspeakable**.

Claude Code does not emit a `RefactorSpec` for an engine to expand. It writes the code.
Revueon writes the CSS. Our job moves from **authoring** to **validating and repairing**.

### C2 — Execution scope must equal decision scope.

Observation got levels; execution never did. Narrow observation feeding a page-wide solver is
worse than both being wide, because now page-wide decisions rest on partial evidence.

Measured: on one MDN run the model named 10–15 subjects out of 90 clusters and a fallback
heuristic placed the other ~75. Three quarters of what the user saw was invented by code that did
not know what they asked for.

**If the agent reasoned about three elements, exactly three elements may differ.**

### C3 — Applying is an experiment, not a conclusion.

A coding agent runs the code and reads the error. Revueon applied changes and walked away.
Conformance ran *before* render and compared output to **the plan** — a compiler checking its own
output against its own AST.

After acting, read the page back and compare against **reality**. If it is worse, revert.

### C4 — There is a stream of results, not one result at the end.

145 seconds of an unchanged page followed by a broken page is not a product. The cheapest correct
change lands immediately; refinements land as they arrive; the user can stop it at any point.

In a pipeline this was hard. In an agent loop it is nearly free, because the loop already acts in
steps.

---

## What this means in one paragraph

Revueon is not a browser extension that transforms pages. Revueon is **an intelligent runtime that
investigates a user's goal, gathers only the evidence it needs, chooses the cheapest correct way to
act, does it, looks at the result, and stops.** That shift is larger than adding another model,
another planner, or another compiler stage — and it makes the system smaller, not bigger.

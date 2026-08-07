# 04 — THE CAPABILITY MODEL

This file does not describe the current codebase. It describes the contract
every capability in Revueon obeys, permanently. If the code disagrees with
this file, the code is wrong.

Read this before adding anything.

---

## 1. What a capability is

A capability is **a tool the agent can call**. It is not a feature, not a mode,
not a route, not a pipeline stage.

| A user asks for a feature | The agent composes capabilities |
|---|---|
| "Hide Shorts" | `findElements` → `hide` → `heal` |
| "Summarise this article" | `describePage` → `readText` → `insert` |
| "Reduce clutter" | `describePage` → `hide` ×n → `heal` → `checkLayout` |
| "Make this a magazine" | `perceivePage` → `recomposePage` → `checkLayout` |

Features are what users ask for. Capabilities are what the agent composes to
answer them. **A feature never gets its own file, its own branch, or its own
name in the codebase.** If you are writing `src/core/summarise/`, stop — you
are building a pipeline again.

**The test that tells you whether the capability set is healthy:**

> A new kind of user request should require **no new code** — only a new
> combination of existing tools. If every new request needs new code, the
> capability set is incomplete and you are building features.

When a request genuinely cannot be expressed, that is a signal to add **one
general capability**, not one specific feature. "Summarise" did not need a
summarise module. It needed `readText` and `insert`, and those two now also
answer translate, explain, annotate, simplify, and rewrite.

---

## 2. The tool contract

Every tool, without exception:

```ts
interface ToolDef {
  name: string
  kind: 'observe' | 'act' | 'verify' | 'control'
  description: string              // one line, written for the model
  args: Record<string, string>     // arg name → type hint, for the model
  execute: (args) => Promise<ToolResult>
}

interface ToolResult {
  ok: boolean
  result?: unknown         // evidence | confirmation | finding
  confidence?: number      // 0..1 — REQUIRED for every observe tool
  inverse?: Inverse        // REQUIRED for every act tool
  error?: string           // must teach, see §5
  truncated?: boolean      // REQUIRED if any budget clipped the result
  costMs: number
}
```

Seven rules bind all of them:

1. **Every tool appears in the registry exactly once.** The registry is the only
   list of capabilities. There is no second list, no switch statement, no
   `if (toolName === ...)` anywhere else.
2. **No tool calls another tool.** Composition happens in the loop, where the
   model can see it and the journal can record it. A tool that calls another
   tool is a hidden pipeline.
3. **Every tool is callable in isolation** and makes sense on its own.
4. **No tool knows what request it is serving.** A tool that behaves differently
   for "hide Shorts" than for "hide ads" is a route in disguise.
5. **No tool contains site-specific knowledge.** No YouTube, no Reddit, no
   Wikipedia in any tool, prompt, or constant. The model knows what a site is.
   We do not.
6. **Every budget that clips a result sets `truncated: true`**, and the model is
   told. A silently truncated result makes the model confidently wrong.
7. **Every tool is described to the model in one line.** If a tool needs a
   paragraph to explain, it is doing two things. Split it.

---

## 3. The four kinds, and the law each one obeys

### OBSERVE — collects evidence, decides nothing

Returns facts plus a confidence number. **Never returns anything that could be
applied to the page.** No plans, no specs, no styles, no recommendations.

The moment an observation tool starts returning "and here's what you should do
about it," perception has taken over design, and every design decision becomes
invisible to the model and untraceable in the journal. This is the single
failure that cost this project three months.

Observation is **levelled**, and every level costs more than the last:

| Level | Scope | Cost | Tool |
|---|---|---|---|
| 0 | goal + origin, no DOM | free | — |
| 1 | one named element | ~ms | `findElements`, `inspect` |
| 2 | one component | ~ms | `inspect`, `measure` |
| 3 | one region / page map | ~10ms | `describePage` |
| 4 | whole page, deep | seconds | `perceivePage` |
| 5 | whole site | not built | — |

**Start at the lowest level that could possibly answer the question.** Escalate
only when confidence is insufficient — never because "that's the pipeline."

**Scope refusal is measured, never named.** Do not block `body`, `html` and `*`
by string match — someone will pass `:root`, `html > *`, or a selector that
happens to match 90% of the page. Refuse on **what the selector actually
resolved to**: element count, share of page text, share of page area. A physics
check cannot be evaded by clever wording.

### ACT — scoped, reversible, immediate

1. **Scope equals decision.** An action may only touch what the model explicitly
   decided about. If the model named 12 elements, the action touches 12
   elements — never "and the 78 others by the same rule."
2. **Every act records its exact inverse before it runs.** See §4.
3. **Actions apply immediately.** Never accumulate a batch and flush at the end.
   The user sees progress, and a bad step is caught while it is still one step.
4. **The stylesheet is the default; mutation is the declared exception.** See
   `05_BROWSER_CRAFT.md` §3.
5. **An act that would destroy structure refuses and says what to use instead.**

### VERIFY — reads reality after render

1. **Reads the live DOM, after layout.** `await requestAnimationFrame` first, or
   you are measuring the previous frame.
2. **Compares against the page, never against the plan.** Checking that output
   matches intent is a compiler validating its own AST. It is always green and
   it means nothing. The old system reported `planHonoured` and 9/9 gates on a
   page that was destroyed.
3. **Asserts physics, not taste.** Overflow, invisible text, zero-size,
   unreachable content, contrast ratio — these are provable. Balance, rhythm,
   "does it look good" are design judgements and belong to the model and the
   human eye.
4. **A failed verification triggers undo, not repair.** Repairing a bad result
   in place produces a differently bad result nobody planned.

### CONTROL — ends or rewinds

`undo(steps)` · `done(summary)` · `giveUp(reason)`.

`giveUp` is a **success state**. An agent that gives up honestly is worth more
than one that invents work. Never make `giveUp` feel like failure in the prompt,
or the model will avoid it and hallucinate instead.

---

## 4. Reversal is part of the act, not a feature

Every act tool records its inverse **before** it runs, and the inverse must
restore the exact prior state.

| Act | Correct inverse | Wrong inverse |
|---|---|---|
| `applyCss` | remove that style node | rewrite the CSS |
| `hide` | remove that rule from the node | `display: revert` |
| `insert` | remove the inserted node | — |
| `setText` | **the cloned node or `innerHTML`** | `textContent` — lossy |
| `move` | restore parent + next sibling reference | reinsert at end |
| `bindKey` | remove that exact listener | `removeEventListener` on a new fn |

**`textContent` is never a valid inverse for anything.** It throws away every
child element. An inverse built on it will restore a wall of unstyled text and
the page will never be byte-identical again.

The proof that reversal works is not a unit test. It is:

```
snapshot → apply → off → on → off → snapshot → byte-identical?
```

Until that passes on a real page, reversal is not built, no matter what the
tests say.

---

## 5. Errors must teach

A tool error is read by a model that is deciding what to do next. It is not a
log line. It is an instruction.

| Bad | Good |
|---|---|
| `"invalid selector"` | `"'body' resolves to 4,102 elements (98% of page text). Call describePage first, then read the specific region."` |
| `"not found"` | `"No element matched 'video player'. describePage found 15 regions: nav, search, breadcrumb, sidebar, article, ..."` |
| `"failed"` | `"setText refused: target <main> has 47 element children and replacing them would destroy the layout. Use insert instead."` |
| `"not implemented"` | `"recomposePage is not implemented. Available layout tools: applyCss, hide, move."` |

Every refusal names the reason **and the alternative**. A model that is told
what to do instead recovers in one step. A model that is told "failed" retries
the same thing until the budget dies — which is exactly what happened on the
first "reduce clutter" run.

---

## 6. The capability map

This is the complete intended set. Status changes; the list is stable. Adding a
row is a real decision — see §7.

### Observation

| Tool | Level | Returns |
|---|---|---|
| `describePage` | 3 | region map: role, type, text sample, position, targetable |
| `findElements` | 1 | concept → matches with confidence and selectors |
| `inspect` | 1–2 | computed style, box, formatting context, children |
| `measure` | 1–2 | geometry, overflow, intrinsic sizes |
| `readText` | 1 | text of one chosen element, redacted, truncation flagged |
| `perceivePage` | 4 | the full perception model — expensive, rare |

### Action

| Tool | Mechanism | Notes |
|---|---|---|
| `applyCss` | stylesheet | the primary path for everything visual |
| `hide` | stylesheet | must be followed by `heal` |
| `heal` | stylesheet | closes the hole a removal leaves |
| `insert` | mutation | the safe content path — adds, destroys nothing |
| `setText` | mutation | text-level targets only; refuses structural ones |
| `move` | stylesheet first (order/grid-area), mutation last resort |
| `bindKey` | listener | keyboard behaviour; inverse removes the exact listener |
| `recomposePage` | stylesheet | whole-page layout — the highest-cost tool |

### Verification

| Tool | Checks |
|---|---|
| `snapshot` | serialisable DOM state for comparison |
| `diff` | what changed between two snapshots |
| `checkLayout` | overflow, zero-size, invisible text, unreachable content |
| `checkContrast` | provable contrast ratio |
| `assertDomClean` | after full reverse, the DOM is byte-identical |
| `look` | a vision model reads a screenshot and describes what it sees |

### Control

`undo(steps)` · `done(summary)` · `giveUp(reason)`

---

## 7. Adding a capability

Before writing a line, answer all six in the commit message:

1. **What request cannot be expressed without it?** Name a real one.
2. **Can existing tools compose to do it?** If yes, do not add it.
3. **Is it general?** If the answer mentions a specific website, it is a feature.
4. **What is its exact inverse?** If you cannot state it, it is not ready.
5. **What does it return when it does not apply?** Every tool must be able to
   say "this does not apply here" without failing.
6. **What is its one-line description to the model?** If you cannot write one
   line, it does one too many things.

Then: registry entry, tool file, prompt line, a real call in a real run. **All
in the same commit.** A tool written and not wired is a lie the codebase tells
for months — it has happened nine times here.

---

## 8. What is not a capability

- A pipeline. A fixed sequence of stages is the thing this architecture replaced.
- A route. `if (intent.includes('hide'))` is a route. So is a keyword table, an
  intent classifier, and a saved action.
- A mode. "Reader mode" is a composition the model performs, not a switch.
- A fallback that invents work. A tool may return "cannot", "unknown", or
  "does not apply". It may **never** substitute work nobody asked for. Ninety
  clusters, fifteen named by the model, seventy-five invented by a fallback —
  that is how this project produced a page that no human ever chose.
- A repair pass. A verification failure means undo, not patch.

---

## 9. The five-minute review

A reviewer with no context should be able to check these:

1. Every export in `src/tools/` appears in the registry exactly once.
2. Every registry entry is reachable from the loop.
3. No tool imports another tool.
4. No file, tool, prompt or constant names a specific website.
5. Every act tool has an inverse, and no inverse uses `textContent`.
6. Every observe tool returns a confidence number.
7. Every truncating tool sets `truncated`.
8. Every error string names an alternative.
9. No file is named after an operation (`subtract/`, `ops/`, `summarise/`).
10. Nothing in `src/` is unreachable from an entrypoint.

A failure in any of these is a build failure, not a warning. "Informational
warnings" reached 131 on this project before anyone acted.

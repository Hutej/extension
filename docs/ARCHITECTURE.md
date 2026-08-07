# Revueon — Architecture

*(Read before touching `project/src/`. Loaded on demand, so it can afford detail.
If any fact here disagrees with the code, **the code wins** — verify, then update this file.)*

**Companion files.** This describes the *shape* of the system. For the permanent tool contract read
`04_CAPABILITIES.md`. For browser physics — formatting contexts, intrinsic sizing, cascade layers,
container queries, healing, selector stability — read `05_BROWSER_CRAFT.md` before emitting any CSS
or touching the DOM.

---

## The one architectural rule

> **Every user request is an investigation, not a pipeline.**
>
> Solve it with the minimum observation level, the minimum reasoning depth, and the minimum
> execution scope capable of producing a correct result with sufficient confidence.
> Escalate only when the evidence is insufficient — never because "that's the pipeline."

The retired rule — *"AI owns design decisions, the Layout IR owns structure, the solver owns
constraints, the compiler owns CSS"* — described layers of a fixed sequence. That sequence was the
product's central defect. It is gone.

---

## The shape of the system

```
User goal
   ↓
Agent loop  (background service worker — the brain)
   ↓  tool call                    ↑  result + confidence
Tool layer  (content script — the hands)
   ↓
The page
```

One loop. A growing set of tools. Nothing else.

There is no orchestrator, no fixed stage order, no route table, and no code path chosen from the
text of the request. Every request goes to the model.

---

## The loop

```
1. Receive the goal and the origin+path.
2. Ask the model: what do you need to know?
3. Run the tool it asked for. Append the result to the journal.
4. Ask again with the journal. Enough evidence?
      no  → back to 3, one level deeper
      yes → act
5. Act. Apply immediately — do not accumulate a batch.
6. Read the page back. Compare against reality, not against the plan.
      worse → undo and try something else
      good  → continue or stop
7. done(summary) | giveUp(reason) | budget exhausted → stop and say what happened.
```

**Two behavioural rules earned the hard way.** At least one observation before any act — without it
the model answers from training data and never looks at the page. And when one third of the budget
remains, the next turn must be act, done or giveUp — without it the model observes forever on a
vague goal and the budget dies with nothing applied. Both were observed on real runs. Do not solve
either by growing the prompt; see `07_ANTIPATTERNS.md` §A10.

**The journal** is the single record of the run: every tool call, every result, every change made.
It is what the model sees on each turn, what `undo(n)` walks backwards, and what persistence
replays on the next visit to the same origin.

---

## Progressive observation — six levels

Depth is chosen at run time from confidence. Never from a keyword or a category.

| Level | Scope | Typical tool | Cost |
|---|---|---|---|
| 0 | Goal + origin only, no DOM | — | ~0 |
| 1 | One named thing | `findElements`, `readText` | ms |
| 2 | One component | `inspect`, `measure` | ms |
| 3 | One region / page map | `describePage` | ~10ms |
| 4 | Whole page | `perceivePage` | seconds, expensive |
| 5 | Whole site | not built | — |

Every observation returns **confidence, latency, cost**. High confidence stops the escalation. Low
confidence escalates one level — and if evidence is still insufficient at the top, the agent **does
less**, it does not guess more.

**Most requests must never reach level 4.** In the old architecture every request did, which is the
whole problem: "hide Shorts" and "redesign this site as Apple documentation" invoked identical
machinery, at 145 seconds each.

**The working pattern is map-then-read.** Level 3 to find the region, level 1 to read only that
region. The model never sees the whole page, the whole DOM, or any HTML — it sees a map of ~15
regions, then the text of the one it chose.

**Scope refusal is measured, never named.** A guard checks what a selector actually resolved to —
element count, share of page text, share of area — not whether it was spelled `body`. Blocklists
leak; `:root` and `.main-wrapper` walk straight through one.

---

## The tool layer

Every capability lives in `src/tools/` and appears in the registry exactly once. **No tool calls
another tool** — composition happens in the loop where the model can see it and the journal can
record it. A tool that calls another tool is a hidden pipeline. The full contract is in
`04_CAPABILITIES.md`.

### Observation — collects evidence, decides nothing

| Tool | Returns |
|---|---|
| `describePage` | Region map: roles, component types, text samples, positions, `targetable` |
| `findElements` | Candidates matching a concept, each with confidence and a selector |
| `inspect` | Computed style, box, formatting context, children of one element |
| `measure` | Geometry, overflow, intrinsic sizes |
| `readText` | Text of one chosen element — redacted, and `truncated` when clipped |
| `perceivePage` | Full perception. Level 4. Expensive. Called deliberately, rarely. |

No observation tool may return a plan, a spec, a style, or anything applicable to a page. The moment
observation starts returning "and here's what you should do," perception has taken over design and
every design decision becomes invisible to the model and untraceable in the journal. That single
failure cost this project three months.

### Action — scoped and reversible

| Tool | Notes |
|---|---|
| `applyCss` | The primary action. A stylesheet the browser owns. |
| `hide` | Scoped `display:none`, always followed by `heal`. |
| `heal` | Close the hole a removal leaves. Six ordered CSS steps — `05_BROWSER_CRAFT` §7. |
| `insert` | **The safe content path.** Adds nodes; cannot collapse a track. Prefer it. |
| `setText` | Text-level targets only. **Refuses** an element with element children. |
| `move` | `order` / `grid-area` first. Reparenting is a last resort and usually wrong. |
| `bindKey` | Behaviour. Declarative, reversible. |
| `recomposePage` | Whole-page layout, as **one tool**. Never the default. Shape in `05_BROWSER_CRAFT` §13. |

### Verification — reads reality, after render

`snapshot` · `diff` · `checkLayout` · `checkContrast` · `assertDomClean` · `look`

All of these read the live DOM after `requestAnimationFrame`, or they are measuring the previous
frame. They compare against **the page, never the plan** — checking output against intent is a
compiler validating its own AST, and it reported 9/9 gates green on a destroyed page. `look` sends
a screenshot to a vision model and gets back a description in words; it is the only check that sees
what the user sees.

### Control

`undo(steps)` · `done(summary)` · `giveUp(reason)`

`giveUp` is a **success state**. An agent that gives up honestly is worth more than one that invents
work. Never make it feel like failure in the prompt or the model will hallucinate instead.

---

## Errors are instructions

A tool error is read by a model deciding what to do next. It is not a log line.

| Bad | Good |
|---|---|
| `"invalid selector"` | `"'body' resolves to 4,102 elements (98% of page text). Call describePage first, then read the specific region."` |
| `"not found"` | `"No match for 'video player'. describePage found: nav, search, breadcrumb, sidebar, article…"` |
| `"failed"` | `"setText refused: <main> has 47 element children; replacing them would destroy the layout. Use insert."` |

Every refusal names the reason **and the alternative**. A model told what to do instead recovers in
one step; a model told "failed" retries until the budget dies.

---

## How output reaches the page

**Default: a stylesheet.** One scoped `<style>` node in `@layer revueon`, written by the model,
validated by us. The cascade applies it forever to every matching element — **including elements
that do not exist yet**. A framework re-render is not an attack we survive; it is an event we never
hear about.

This is why the old ten-attempt defence loop had to go. It existed only because we mutated the DOM
and React undid us. **If a defence loop is ever needed again, something that should be CSS is being
done with JavaScript.**

Cascade layers mean our styles win predictably without a single `!important`. `:where()` contributes
zero specificity for rules that should lose gracefully. `!important` is genuinely correct for hiding,
where intent is absolute; it is wrong for typography and spacing, where the page may have a better
reason than we do.

**Exception: DOM mutation.** Required for inserting content, rewriting text, binding keys, and our
own affordances. Allowed, rare, and it must record a reason from a small named set. A mutation with
no declared reason is refused.

**Before any structural mutation**, ask what the element's children contribute to its own size and
to its parent's. Replacing an element's children deletes the intrinsic sizes holding its grid track
open — this collapsed an MDN article into a 30-pixel column with text breaking mid-word, with no CSS
emitted at all. `05_BROWSER_CRAFT` §2 has the full anatomy.

**Off** removes the style node and replays the journal in reverse. Every act records its exact
inverse **before** it runs, and **`textContent` is never a valid inverse for anything** — it
discards every child element. Anything touching structure records a cloned node. `on → off → on →
off` must produce a byte-identical DOM, proven by `assertDomClean`.

---

## The model's role

The model **writes the answer**. It does not fill in a vocabulary we invented.

There is no `DesignSpec`, no relation tokens, no expander, no pack lookup table. Those were a
ceiling on the model's intelligence disguised as a safety rail — the reason *"summarise this"* was
literally unspeakable in the old architecture, where 37 relation types could express none of it.

Our job is **validation and repair**: contrast provable before colour is emitted, no measured length
written back into the page, `minmax(0, 1fr)` and `min-width: 0` present in generated grid and flex,
container queries rather than media queries, scope respected, reversibility recorded. Review is a
thing we are good at. Authoring by lookup table is not.

**Model tiering:** a fast model for observation and routing turns; a strong model for design
judgement and content; a vision model for reading screenshots. Tool calls use native tool calling
where supported, otherwise a strict single-object JSON envelope with exactly one retry that shows
the parse error back, then `giveUp`.

---

## Budgets and stopping

| Budget | Value | On exhaustion |
|---|---|---|
| Steps | 12 tool calls | Stop, report what was achieved |
| Wall clock | 60 s total | Stop, keep what already landed |
| First visible change | 1 s | Not a limit — a requirement |
| Cost | per-run ceiling | Stop, report spend |

**Check the budget before starting a call, not after it returns.** A model call takes 10–15 seconds;
checking afterwards overshoots by a whole call, which is exactly how a 60-second ceiling produced an
80-second run.

A stopped run is not a failed run. Partial success is success. The agent says what it did, what it
skipped, and why.

---

## What lives where

```
project/src/
  agent/
    loop.ts        the loop above
    prompt.ts      the agent prompt — under 2,000 characters, and that is a ceiling not a target
    journal.ts     record, replay, undo, persist per origin+path
    budget.ts      steps, time, cost
  tools/
    index.ts       the registry — the only list of capabilities
    observe.ts     describePage, findElements, inspect, measure, readText, perceivePage
    act.ts         applyCss, hide, heal, insert, setText, move, bindKey, recomposePage
    verify.ts      snapshot, diff, checkLayout, checkContrast, assertDomClean, look
  core/
    perceive/      kept intact — exposed as the single tool perceivePage
    inventory.ts   the lightweight DOM walk behind describePage and findElements
    heal.ts        the six healing steps
    reason/        model transport only — no prompts that decide anything
    persist/       per origin+path journal storage
    sanitize/      CSS validation, sensitive-data redaction
    config/        loop config: models, budgets
  entrypoints/
    background.ts  hosts the loop — the brain
    content.ts     dispatches tools — the hands. It wires; it never implements.
    popup/         goal entry and result display
```

`content.ts` wires and dispatches. It never implements. It previously reached 1,698 lines doing
exactly the opposite, and that is how the fixed pipeline survived so long unexamined. It is now
~85 lines. Keep it that way.

---

## Invariants a reviewer can check in five minutes

1. No file or directory is named after an operation.
2. No table maps request text to a code path.
3. The word `fallback` appears nowhere as a mechanism that invents work.
4. Every observation return type is inapplicable to a page.
5. Every observation tool returns a confidence number.
6. Every act tool has an exact inverse, and **no inverse uses `textContent`**.
7. Every mutation call site supplies a reason.
8. Every capability is in the registry exactly once, and no tool imports another tool.
9. No length measured off the live page is written back into it.
10. Every tool that can clip a result sets `truncated`.
11. Every error string names an alternative.
12. No file, tool, prompt or constant names a specific website.
13. Every tool created in a commit is called in that same commit; nothing in `src/` is unreachable
    from an entrypoint.

A failure in any of these is a build failure, not a warning. "Informational warnings" reached 131 on
this project before anyone acted on them.

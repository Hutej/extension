---
inclusion: always
---

# Revueon — Product

Revueon is **an AI agent that lives in the browser**.

A user states a goal in plain English. Revueon investigates the page, gathers only the evidence it
needs, chooses the cheapest correct way to act, does it, looks at the result, and stops.
Everything happens locally — never through the site's backend.

Endgame: **replace every browser extension.** The moat is generality — principles, not recipes.

---

## The two rules

> **1. Every user request is an investigation, not a pipeline.**
>
> Solve it with the minimum observation level, the minimum reasoning depth, and the minimum
> execution scope capable of producing a correct result with sufficient confidence. Escalate only
> when the evidence is insufficient — never because "that's the pipeline."

> **2. No new capability ships while a foundation is broken.**
>
> Seven foundations underpin every request. They are in `06_FOUNDATION.md`. Features built on
> unproven primitives have been deleted four times now.

*(The old rule about AI / Layout IR / solver / compiler layers is retired. It described a pipeline
that no longer exists.)*

---

## What Revueon does

Five capabilities, in the order they happen:

1. **Observe** — look at only as much of the page as the goal requires.
2. **Understand** — work out what the user is referring to, and how sure we are.
3. **Decide** — choose the cheapest correct action. The model writes the answer; we validate it.
4. **Apply safely** — scoped, reversible, and preferably as a stylesheet the browser owns.
5. **Keep working** — survive re-render, navigation, and the site changing under us.

## What Revueon is not

Not a CSS generator. Not a theming engine. Not dark mode. Not reader mode. Not a userscript
manager. Not a new browser. Not a pipeline with a chat box on the front.

---

## The five kinds of demand

These describe **what users ask for**. They are *not* code paths — there is one loop and it handles
all of them. Never build a route from this table.

| Kind | Share of demand | Example |
|---|---|---|
| **Subtract & local** | ~2/3 | "Hide YouTube Shorts permanently" |
| **Restyle** | ~1/4 | "Transfer this site to neobrutalism" |
| **Recompose** | a handful | "Turn GitHub PRs into a Kanban board" |
| **Behave** | growing | "Make Gmail keyboard-first" |
| **Content** | unbounded | "Summarise this article" |

The old architecture served only the third row and had **nowhere at all** to put the fifth. Of 37
relation types in the design vocabulary, exactly zero could express *summarise*. That is the whole
diagnosis in one number.

---

## The MVP

> **Revueon reliably does small things to any web page, never breaks the page, and always comes off
> cleanly.**

Deliberately unambitious about *what* it can do. Completely uncompromising about *how well*.

**In:** all seven foundations proven · observe, hide, heal, applyCss, insert, setText · subtract,
local and content requests · persistence per origin + path · one-click reverse that provably
restores the page · the consent gate re-enabled.

**Out, until the foundations hold:** whole-page recomposition · design languages and themes · move
and keyboard behaviour · cross-site transformation · memory, sharing, registry, marketplace,
ecosystem.

The seven-row acceptance corpus is in `06_FOUNDATION.md` §3. When all seven pass **and a human
agrees by eye**, the MVP exists.

---

## Hard product requirements

1. **Sixty seconds wall clock, including big requests.** A requirement, not a target.
2. **Something visible and correct within one second.** Results stream; they do not arrive in a
   batch at the end.
3. **Off restores the page byte for byte.** Not approximately — identically.
4. **Revueon never refuses a page.** No "page too large", no unsupported-site message. Do part of
   the job and say what you skipped.
5. **A transformation survives a window resize.** 1440px → 380px → back, without breaking.
6. **Never send a screenshot or page content to a model for identification.** Origin and path only,
   query and fragment stripped. This is a privacy commitment written into the terms.
7. **Subtraction is a design act.** Hiding six things and leaving six holes is a worse page than
   before. A removal that leaves a hole is an unfinished job.
8. **The consent gate is currently disabled for testing and must be re-enabled before launch.**
   P0 launch blocker.

---

## Current position

**7 Aug 2026 — Stage 0 shipped. Foundation work in progress.**

The pipeline is gone — roughly 12,000 lines deleted: the design vocabulary, the compiler, the
solver, the Target Layout IR, eight archetypes, seven design languages, conformance and the pixel
gates. Perception survives intact as one tool. Eleven build sweeps (1A–1I) are dead, so are
Execution Roadmap v1/v2, MOVES 0–7 and stages T1–T6. `03_ROADMAP.md` is the only roadmap.

In its place: an agent loop with a tool registry. Every request goes to the model.

**What is proven.** The loop. Asked to *"hide the video player"* on a page that has none, the agent
observed, found nothing, changed nothing, and said why — in 24 seconds. That is the first time a
deliberate failing case has ever passed on this project, and it is the exact behaviour the old
architecture violated on every single run.

**What is not.** Six of the seven foundations. Reversal is broken by construction. Persistence has
never been tested across a reload. Nothing can see what it produced. Asked to *"summarise this
article"*, the agent replaced the article's contents and collapsed the layout into a 30-pixel
column with text breaking mid-word — diagnosed in one screenshot, which is itself the improvement.

See `06_FOUNDATION.md` for the scoreboard and the build order. Sight comes first, because nothing
else can be judged until we can see.

---

## Status discipline

When a stage is genuinely finished — proven by eye on real sites — update this section and the
stage's row in `03_ROADMAP.md`. **Never** mark a stage done on green automated checks alone.
Eleven consecutive sweeps were green while the product got worse, and for two of them the extension
could not even start. If in doubt, leave it open and write down why.

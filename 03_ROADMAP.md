# 03 — ROADMAP

*The only roadmap. All previous roadmaps (product.md phase tracker, Execution Roadmap v1/v2,
BUILD SWEEPS 1A–1I, MOVES 0–7, T1–T6) are dead. Do not resurrect them.*
*Written 7 Aug 2026 at the restart.*

---

## The shape of the plan

We are not building phases of a pipeline. We are building **one loop and a growing set of tools**.
Every stage below adds tools to the same loop. The loop is never rewritten again.

A stage is done when a human opens a real site, types the goal, and says it looks good.
Nothing else counts. Not typecheck, not lint, not a green gate, not a passing test.

---

## STAGE 0 — THE LOOP

**Build the agent.** Nothing else in this file is possible until this exists.

- Goal in → model decides what to observe → tool runs → result appended to a journal → model decides
  again → acts → verifies → stops.
- Brain in the background service worker. Hands in the content script.
- Budgets: step count, wall clock, cost. When a budget is exhausted the agent stops and says so.
- The journal is the only record of what happened. Reverse = undo the journal.

**Minimum tool set to declare Stage 0 done:**

| Kind | Tools |
|---|---|
| Observe | `describePage` · `findElements` · `inspect` · `readText` |
| Act | `applyCss` · `hide` · `setText` |
| Verify | `snapshot` · `diff` · `checkLayout` |
| Control | `undo` · `done` · `giveUp` |

**The proof this stage works is one goal:** *"Summarise this article"* on an MDN page.
It requires `readText` → one model call → `setText`/insert. No layout, no design, no Architect.
If the loop can do that, the architecture is correct and every remaining stage is a tool, not a
rewrite. If the loop cannot do that, nothing below matters.

**The deliberate failing case:** *"Hide the video player"* on an MDN page. There is no video player.
The agent must observe, find nothing, change nothing, and say so. If it invents something, P3 is
broken and the stage is not done.

---

## STAGE 1 — SUBTRACT AND LOCAL

The biggest real demand and the cheapest to serve. Roughly two thirds of what users type.

- Hide a named thing, permanently, per origin.
- Heal the hole. **Removal is a design act** — a gap left behind is a worse page than the one we
  started with. Collapse the empty track, drop the orphaned separator, release the frozen height,
  let the surviving sibling expand.
- Persist per origin and survive SPA re-render — by stylesheet, not by defence loop.
- One-click full reverse.

**Corpus:** Hide YouTube Shorts permanently · Remove the Twitter "For You" tab · Hide LinkedIn
engagement bait · Reduce clutter (MDN).

---

## STAGE 2 — RESTYLE

A whole-page look change with no structural movement. Typography, colour, spacing, density,
surface, border, elevation.

- The model writes the CSS. No pack lookup tables, no relation vocabulary.
- Contrast is proved before a colour is emitted, and only then.
- One dimension at a time, all the way to good, before starting the next.

**Corpus:** Transfer this site to neobrutalism · Transfer this site to glassmorphism ·
Increase spacing · Turn Wikipedia into a magazine.

---

## STAGE 3 — RECOMPOSE

Structural change. This is where the existing perceive → IR → solver machinery earns its keep —
**as one tool the agent may call**, never as the default path.

- `recomposePage` is a single capability with a clear input and a clear output.
- It is invoked only when the evidence says the goal genuinely requires whole-page structure.
- If it fails, the agent falls back to doing less — not to guessing more.

**Corpus:** Turn GitHub Pull Requests into a Kanban board · Turn YouTube into Spotify ·
Turn Amazon into Apple · Replace layouts.

---

## STAGE 4 — BEHAVE

The page starts doing things it did not do before. **This bites earlier than the tier ordering
suggests** — "auto-collapse Reddit comments" is a Stage 1 request and it cannot be done in CSS,
because a real collapse needs a toggle and state.

- Bounded, declarative, reversible behaviour primitives: bind a key, attach a handler, observe and
  react, add a control.
- Not arbitrary injected JS. Same discipline as CSS: declare intent, the runtime executes.

**Corpus:** Auto-collapse Reddit comments · Make Gmail keyboard-first · Move Spotify's player into a
floating mini-player · Add shortcuts · Modify interaction behaviour.

---

## STAGE 5 — CONTENT

The class the old architecture had nowhere to put. Unbounded, and the model is already capable of
all of it.

- Summarise, rewrite, translate, explain, extract, annotate, tabulate.
- Reads with `readText`, writes with `setText`/insert, scoped and reversible like everything else.
- Proven in Stage 0; broadened here.

**Corpus:** Summarise this article · Explain this code block · Extract every price on this page.

---

## STAGE 6 — ACROSS THE SITE

The same goal holding on every page of an origin, not just the one that was open.

- Targets identified by description; the selector is a cache, not the truth.
- When the cache misses, re-identify quietly rather than break.
- "Permanently" becomes true.

**Corpus:** Rewrite workflows · every Stage 1–5 item, verified on three pages of the same site.

---

## The test corpus — all eighteen

The founder's list. This is the product definition, not a suggestion. A stage is done when its
rows work by eye on the real site.

| # | Goal | Stage |
|---|---|---|
| 1 | Hide YouTube Shorts permanently | 1 |
| 2 | Remove the Twitter "For You" tab | 1 |
| 3 | Hide LinkedIn engagement bait | 1 |
| 4 | Reduce clutter | 1 |
| 5 | Transfer this site to neobrutalism | 2 |
| 6 | Transfer this site to glassmorphism | 2 |
| 7 | Turn Wikipedia into a magazine | 2 |
| 8 | Increase spacing | 2 |
| 9 | Replace layouts | 3 |
| 10 | Turn GitHub Pull Requests into a Kanban board | 3 |
| 11 | Turn YouTube into Spotify | 3 |
| 12 | Turn Amazon into Apple | 3 |
| 13 | Auto-collapse Reddit comments | 4 |
| 14 | Make Gmail keyboard-first | 4 |
| 15 | Move Spotify's player into a floating mini-player | 4 |
| 16 | Add shortcuts | 4 |
| 17 | Modify interaction behaviour | 4 |
| 18 | Rewrite workflows | 6 |

Plus, added 7 Aug: **Summarise this article** (Stage 0, the architecture proof).

---

## Hard requirements that apply to every stage

1. **Sixty seconds, wall clock, including big requests.** Not a target. A requirement.
2. **Something visible within one second.** Perceived speed is a product feature (P11).
3. **Revueon never refuses a page.** No "page is too large", no unsupported-site message. If we
   cannot do the whole job we do part of it and say what we skipped.
4. **Never send a screenshot or page content to a model for identification.** Send the origin and
   path only, query and fragment stripped. This is a privacy commitment, not a preference.
5. **Off restores the page byte for byte** (P5).
6. **The consent gate must be re-enabled before launch.** It is currently disabled for testing and
   this is a P0 launch blocker.

---

## Explicitly out of scope right now

Do not build, do not design for, do not leave hooks for: shared cross-user knowledge, a
transformation registry, sharing or remixing, a marketplace, cross-browser support, a settings
surface beyond on/off, accounts, or anything described as an "ecosystem." These are real ideas and
they are all downstream of a product that works on one page for one person. It does not yet.

# 07 — ANTIPATTERNS

Thirteen ways this project has already failed. Each one is stated as a rule, and
each one comes with the evidence that earned it.

These are not history. They are the specific mistakes this codebase is prone to,
and every one of them will be attempted again by a well-meaning engineer who has
a good reason. **The good reason is always there. That is what makes these
antipatterns rather than accidents.**

Read this before you argue for any of them.

---

## A1 — Wrote it, never read it

**The rule:** code is wired to a real caller in the same commit that creates it,
or it is not committed.

**The evidence.** Nine separate times, a representation was built with care and
then never consumed:

- nine IR constraints computed, then discarded before emission
- `ConstraintPriority` — 7 writes, 0 reads
- `TargetLayoutIR.adjacency` and `.readingOrder` — never read
- `Cluster.provenance` — never serialised
- `minTypeScaleRatio` — never read
- `bestNonBroken` — never called
- 124, then 131, orphan warnings, marked "informational"
- 46 test-only exports, never triaged
- `RV_EFFORT_ARCHITECT` and `RV_EFFORT_PAINTER` — read at runtime, never
  declared in the build. **The content script threw `process is not defined` at
  load and never registered its listener. Two entire sweeps landed green on an
  extension that could not start.**

That last one is the whole antipattern in one story. Every gate was green.
Nothing was running.

**Enforcement:** a wiring audit that **fails the build**. Not warns. The count
reached 131 while everyone agreed it was informational.

---

## A2 — The fallback that invents work

**The rule:** a missing input means stop and say so. It never means substitute
something.

**The evidence.** `buildFallbackTargetIR` placed roughly **75 of 90 clusters**
that the model never mentioned. The model named 10–15. The user then looked at a
page that no intelligence — human or artificial — had ever chosen.

On a second run the fallback ran because the model call finished **9 milliseconds**
past a 70,000 ms timeout. Nine milliseconds decided the entire page.

**The word itself is the tell.** "Fallback" made it sound responsible. It was
fabrication with a reassuring name. Grep for it; treat every instance as guilty
until proven otherwise.

---

## A3 — Measuring fidelity instead of quality

**The rule:** verification reads the page. It never compares output to the plan.

**The evidence.** `checkConformance` compared emitted CSS to the spec that
generated it — a compiler validating its own AST. It reported *"9/9 hard gates
on all 3 sites"* and *"MDN passes ALL 10 gates"* and, memorably, *"No gate is
lying."*

The page those gates passed on had overlapping text, a full-page black void, and
the word "Modules" rendered one letter per line.

**Both real failures were found by a human looking at the screen.** Not one was
found by a gate.

---

## A4 — Gates that assert taste

**The rule:** automated checks assert physics. Design is judged by the model and
the human eye.

Physics, and therefore gateable: overflow, invisible text, zero-size, contrast
ratio, unreachable content, text breaking mid-word, survives resize.

Taste, and therefore not gateable: is the spacing good, is it balanced, does it
look like Apple, is the hierarchy clear.

**The evidence.** Five proxy gates were eventually demoted after it became clear
they measured nothing real. Before that they had been the basis for eleven
sweeps' worth of "PASS."

---

## A5 — Editing the test until it passes

**The rule:** a test may never be modified to make it pass. If a test fails, the
product is wrong or the test was wrong from the start — and "the test was wrong"
requires an explanation of why it was ever written that way.

**The evidence.** `INVISIBLE_VARIANCE` was lowered rather than the invisible text
being fixed. `assertNoMeasurementLengths` was mocked. Repeatedly, when a check
went red, the check moved.

Stated plainly by the person paying for it: *"when the error happen mimo just
update test script not the actual extension code."*

**Corollary:** every check ships with a deliberate failing case, and that case is
demonstrated actually failing. A check that has never been seen to fail is not
known to work.

---

## A6 — Two words that are always wrong

**Banned: "intermittent" and "harness artifact."**

Every single time either word was used on this project, the underlying problem
was real, reproducible, and in the product.

"Intermittent" means *I have not found the condition yet.* "Harness artifact"
means *I would prefer this to be the test's fault.* Say the true thing instead:
"I do not know why this happens." That sentence is respected. Those two words
are not.

---

## A7 — A closed vocabulary is a ceiling

**The rule:** the model writes the answer. We validate it. We never enumerate in
advance what a user may ask for.

**The evidence.** A design vocabulary was built with **37 relation types** across
eleven files. A user typed *"summarise this text"* and **zero of the 37** could
express it. Not a hard one — the most ordinary request imaginable.

A vocabulary does not announce its own ceiling. It just silently cannot say
things, and everyone assumes the gap is elsewhere.

The same failure in a different costume: eight layout archetypes, seven design
languages, four design packs. A model that has seen every website ever built
does not need a taxonomy of seven.

---

## A8 — Deciding narrowly, executing widely

**The rule:** execution scope equals decision scope. Act on what was decided,
nothing more.

**The evidence.** The model named 10–15 clusters. Ninety were placed. The
remaining ~75 were filled in "by the same rule" — and the rule was not one
anybody had chosen.

This is subtle because it feels like generalisation, which usually feels like
good engineering. Here it means the visible result is mostly composed of
decisions nobody made.

---

## A9 — Advisory checks

**The rule:** if a check matters, it blocks. If it does not block, delete it.

**The evidence.** `conformance ok=false` with 16 violations, on both runs.
`planHonoured=false` on both runs. **Both designs applied anyway**, because
conformance was "advisory."

An advisory check is a check that has been pre-emptively overruled. It produces
log noise and the feeling of safety without any of it.

---

## A10 — Growing the prompt to fix judgement

**The rule:** when a model behaves badly, add one rule, not a page. Keep the
agent prompt under 2,000 characters.

**The evidence.** The Architect prompt reached ~7,600 characters of constraints,
non-negotiables and vocabulary. It produced **compliance, not design** — output
that satisfied every stated rule and looked like nothing anyone wanted.

The opposite error exists too: at ~1,300 characters the model both acted without
observing and observed without ever acting. The answer is not "longer," it is
**two precise rules**: observe at least once before acting, and act before the
budget dies.

---

## A11 — Naming a module after an operation

**The rule:** modules are named for what they *are*, never for what they *do* to
a request.

**The evidence.** `src/core/subtract/` was created for subtraction. Inside it
were `inventory.ts` and `heal.ts` — both completely general, both useful to
every kind of request, both invisible because of where they lived. Both had to
be moved out within a week. `core/ops/` was deleted for the same reason.

If you are creating a directory named after a verb, you are building a pipeline
branch and calling it organisation.

---

## A12 — One request, one pipeline

**The rule:** every request is an investigation. Reasoning is proportional to
uncertainty, not to capability.

**The evidence.** "Hide Shorts" invoked exactly the same machinery as "transform
this site into an Apple-style documentation experience": full-page perception,
an Architect call, a solver, a compiler, conformance. **145 seconds** and a paid
model call to hide one shelf.

After the rewrite, "hide the video player" was answered correctly — *nothing
found, nothing changed* — in 24 seconds with two cheap calls. Same product,
same page, correct amount of thinking.

---

## A13 — Building on unproven foundations

**The rule:** no new capability ships while one of the seven foundations in
`06_FOUNDATION.md` is broken.

**The evidence.** Reversal has never once been proven byte-identical. Persistence
has never been tested across a reload. Meanwhile eleven build sweeps shipped
layout archetypes, design languages, motion tiers and a relation graph — all of
which sat on top of both.

The user found the reversal bug himself by toggling off and on and watching the
layout completely change. **No gate, no test and no report ever mentioned it.**

---

## The shortest possible version

1. Wire it or do not write it.
2. Missing input means stop, never invent.
3. Verify against the page, never the plan.
4. Gate physics, judge taste.
5. Never edit a test to pass.
6. Never say "intermittent" or "harness artifact."
7. Never enumerate what a user may ask.
8. Act only on what was decided.
9. If it does not block, delete it.
10. One rule, not a page.
11. Name things for what they are.
12. Think as much as the uncertainty requires, and no more.
13. Foundations first.

**And the one that contains all of them: green is not done. A human looking at
the screen is done.**

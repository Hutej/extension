# Revueon — AGENTS.md

*(Keep this file SMALL — it is auto-loaded into every prompt. Details live in the numbered files;
read them on demand.)*

Revueon is **an AI agent that lives in the browser**. A user states a goal in plain English and
Revueon investigates the page, gathers only the evidence it needs, chooses the cheapest correct way
to act, does it, looks at the result, and stops. Locally — never the site's backend.

Endgame: replace every browser extension. The moat is generality — **principles, not recipes**.

---

## The two rules everything else follows from

> **1. Every user request is an investigation, not a pipeline.**
>
> Solve it with the minimum observation level, the minimum reasoning depth, and the minimum
> execution scope capable of producing a correct result with sufficient confidence.
> Escalate only when the evidence is insufficient — never because "that's the pipeline."

> **2. No new capability ships while a foundation is broken.**
>
> Seven foundations underpin every request Revueon will ever serve — identity, application,
> reversal, continuity, integrity, the loop, sight. They are listed in `06_FOUNDATION.md` with
> their honest current state. Three months of features were built on unproven primitives and all
> of it had to be deleted.

The old rule — *"AI owns design decisions, the Layout IR owns structure, the solver owns
constraints, the compiler owns CSS"* — is **retired**. It described layers of a pipeline that no
longer exists.

---

## Read these before working

| File | Read it when |
|---|---|
| `all_about_revueon.txt` | Revueon details, what is our product what it should be all the details contains in this file. 
| `01_DIRECTION.md` | **Always, first.** The thesis the whole product rests on. |
| `02_PRINCIPLES.md` | **Always.** Twelve binding principles, each with a test. |
| `03_ROADMAP.md` | Before starting any task — which stage we are in and what "done" means. |
| `04_CAPABILITIES.md` | **Before adding or changing any tool.** The permanent tool contract. |
| `05_BROWSER_CRAFT.md` | **Before emitting any CSS or touching the DOM.** Browser physics — formatting contexts, intrinsic sizing, cascade layers, container queries, healing, selector stability. This is the knowledge recovered from 12,000 deleted lines. |
| `06_FOUNDATION.md` | Before planning work. The seven foundations, their state, and the MVP. |
| `07_ANTIPATTERNS.md` | Before claiming anything works. Thirteen ways this project has already failed. |
| `senior_developer_advices\` | Senior developer advice for this project
| `roadmap.txt` | Optinal to read 

`docs/ARCHITECTURE.md` — the loop, the tools, the budgets. Read before changing the agent.

---

Remember after you write code, this code will verify by codex, claude code and senior developer 

## Repo map (root = `Revueon/`)

- `project/` — the codebase: extension + harness (WXT, TypeScript strict, MV3, Playwright).
- `project/src/agent/` — the loop, the prompt, the journal, the budget.
- `project/src/tools/` — observe, act, verify. **Every capability lives here and nowhere else.**
- `project/src/core/perceive/` — kept intact. The strongest thing we built. It is **one tool**, level 4.
- `project/src/core/` — shared machinery: inventory, heal, reason (transport), persist, sanitize, config.
- `.kiro/steering/product.md` — product definition + current position.

---

## Absolute rules

1. **Every request goes to the model.** No keyword table, no saved action, no hardcoded route, no
   "fast path" for simple things. Claude Code has no saved action for renaming a variable.
2. **No module, file or directory is named after an operation.** Nobody writes a `subtract/` module.
   Build representations and capabilities, not features.
3. **Observation collects evidence; it never decides.** No observation function returns anything
   that can be applied to a page.
4. **Low confidence means do less, never guess more.** Zero output and partial output are successful
   outcomes. The word `fallback` does not belong in this codebase.
5. **Execution scope equals decision scope.** Reasoned about three elements → exactly three elements
   may differ.
6. **Express intent, never implementation.** No length measured off the live page is ever written
   back into it. A transformation must survive a window resize — the one surviving hard law.
7. **Every operation is reversible, and `textContent` is never a valid inverse.** It discards every
   child element. Anything touching structure records a cloned node. `on → off → on → off` restores
   the DOM byte for byte.
8. **Let the browser do browser work.** Prefer a stylesheet the cascade applies forever — including
   to elements that do not exist yet — over a DOM edit we then have to defend. Mutation is a rare
   exception and must declare its reason.
9. **Capabilities compose.** No second code path that does 80% of an existing one. A new kind of
   request should need a new *combination*, not new code.
10. **Revueon never refuses a page.** No "page too large", no unsupported-site message. Do part of
    the job and say what you skipped.
11. **Refuse on measurement, never on spelling.** A scope guard checks what a selector actually
    resolved to — element count, share of page text, share of area. Blocklists of `body`, `html`,
    `*` leak: `:root` and `.main-wrapper` walk straight through.
12. **Anything a budget clips sets `truncated: true` and tells the model.** Silent truncation makes
    a model confidently wrong, which is worse than a model that knows it is missing something.
13. **Every error message names an alternative.** A model told "invalid selector" retries until the
    budget dies. A model told *"call describePage first, then read the specific region"* recovers in
    one step. Errors are instructions, not log lines.
14. **Never send a screenshot or page content to a model for identification.** Origin and path only,
    query and fragment stripped. Privacy commitment, not a preference. *(Screenshots of our own test
    runs going to a vision model in the harness are a separate thing and are fine.)*
15. **A test may never be edited to make it pass.** Every check ships with a deliberate failing case,
    demonstrated actually failing. If the check goes red, the extension is wrong.
16. **Code is wired in the same commit that creates it.** An orphan is a build failure, not a
    warning. Nine separate representations were written and never read — that stops here.
17. **Zero site-specific hardcoding.** No YouTube, Reddit or Wikipedia in any file, tool, prompt or
    constant. Principles, not recipes. Novel test prompts every time — never reuse one.
18. **Never run Playwright against YouTube, Reddit, X, LinkedIn, Amazon or Gmail.** They serve
    captchas to automation and the harness hangs. Use MDN, Wikipedia, news.ycombinator.com,
    docs.python.org. Protected sites stay in the corpus as **manual by-eye tests only**.
19. **Green is not done. An unverified run is a failed run.** A human eye — or at minimum a vision
    model describing the screenshot in words — is the only pass. Any region that looks wrong is a
    failure even if every check is green.

---

## Two banned words

**"Intermittent"** — nothing in a deterministic system is intermittent. It is a race, a timeout, or
unmodelled state. Say "I do not know why this happens." That sentence is respected.

**"Harness artifact"** — used twice, wrong twice. If the harness sees it, the user will see it.

---

## Ponytail — lazy senior developer mode

Apply this mode to all coding work in Revueon. Lazy means efficient, not careless. The best code is the code never written.

Before writing code, stop at the first rung that holds:

1. Does this need to be built at all? (YAGNI)
2. Does it already exist in this codebase? Reuse the helper, util, or pattern already here; don't rewrite it.
3. Does the standard library already do this? Use it.
4. Does a native platform feature cover it? Use it.
5. Does an already-installed dependency solve it? Use it.
6. Can this be one line? Make it one line.
7. Only then: write the minimum code that works.

The ladder runs after understanding the problem, not instead of it: read the task and the code it touches, trace the real flow end to end, then climb.

**Bug fix = root cause, not symptom.** Grep every caller of the function you touch and fix the shared function once. One guard there is a smaller diff than one per caller; patching only the path named by a ticket leaves sibling callers broken.

Rules:
- No abstractions that weren't explicitly requested.
- No new dependency if it can be avoided.
- No boilerplate nobody asked for.
- Deletion over addition. Boring over clever. Fewest files possible.
- Shortest working diff wins, but only once you understand the problem.
- Question complex requests: "Do you actually need X, or does Y cover it?"
- Pick the edge-case-correct option when two standard-library approaches are the same size.
- Mark deliberate simplifications that cut a real corner with a `ponytail:` comment naming the ceiling and upgrade path.

Not lazy about:
- understanding the problem and tracing the real flow before coding
- input validation at trust boundaries
- error handling that prevents data loss
- security
- accessibility
- calibration real hardware needs
- anything explicitly requested

Lazy code without its check is unfinished: non-trivial logic leaves ONE runnable check behind—the smallest thing that fails if the logic breaks. Trivial one-liners need no test.

## Working style

- **Think before coding.** State assumptions. If two interpretations exist, say so — don't pick
  silently. If something is unclear, stop and ask. Stopping to ask is always the right call.
- **Simplicity first.** Minimum code that solves the problem. If you wrote 200 lines and it could be
  50, rewrite it. Nothing speculative, no abstraction for single-use code.
- **Surgical changes.** Every changed line traces to the request. Don't improve adjacent code.
  Remove orphans *your* change created.
- **Use as many subagents as you want** — for parallel work, for review, for cleanup. Give each one
  a scope it can hold entirely; vague scope produces vague work. Never let a subagent decide scope,
  delete something outside its brief, or edit a test to make it pass. **Always run a review subagent**
  against `02_PRINCIPLES.md` and the ten-point check in `04_CAPABILITIES.md` §9 before you report,
  and report what it found even when it is unflattering.

## Reporting

End every task with: what shipped · what is proven, with real numbers (wall clock, paid calls, what
the vision model saw in words) · **what failed** · what you did not build, named explicitly ·
anything that looks bad to you even if it passed.

Never report a commit hash. Never overstate. "Not built" is a perfectly good line and omitting it
is not.

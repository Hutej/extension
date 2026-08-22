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

## Browser Automation

Revueon uses two browser automation layers.

### Playwright — authoritative testing

Playwright is the canonical deterministic test harness.

Use Playwright for:
- regression tests
- extension/MV3 lifecycle tests
- service-worker tests
- deterministic DOM assertions
- timing/race-condition tests
- viewport/resize tests
- CI and reproducible proof
- real-site behavioral proof

Do NOT replace existing Playwright tests with agent-browser without explicit approval.

### agent-browser — exploration and debugging

agent-browser is available in this project.

Use agent-browser for:
- exploratory browser investigation
- quickly reproducing a browser/page issue
- interactive debugging
- navigating real websites during development
- inspecting accessibility/DOM state
- investigating SPA navigation
- quick manual-style validation before writing a deterministic test

When using agent-browser, load its current skill/instructions rather than inventing commands.

agent-browser is NOT the authoritative regression/proof harness.

If an exploratory result from agent-browser becomes an important behavioral claim, reproduce it with the appropriate deterministic Playwright test before treating it as project proof.

### Decision rule

Use agent-browser when the task is primarily:
"explore / investigate / reproduce / debug this browser behavior."

Use Playwright when the task is primarily:
"prove / regression-test / deterministically verify this behavior."

Use both when appropriate:
agent-browser → investigate quickly
Playwright → encode the discovered behavior as a reproducible test.

## Two banned words

**"Intermittent"** — nothing in a deterministic system is intermittent. It is a race, a timeout, or
unmodelled state. Say "I do not know why this happens." That sentence is respected.

**"Harness artifact"** — used twice, wrong twice. If the harness sees it, the user will see it.

## Working style

- **Think before coding.** State assumptions. If two interpretations exist, say so — don't pick
  silently. If something is unclear, stop and ask. Stopping to ask is always the right call.
- **Simplicity first.** Minimum code that solves the problem. If you wrote 200 lines and it could be
  50, rewrite it. Nothing speculative, no abstraction for single-use code.
- **Surgical changes.** Every changed line traces to the request. Don't improve adjacent code.
  Remove orphans *your* change created.

---
# 5. IMAGE / VISION RULE — CRITICAL

Production Revueon DOES NOT send screenshots to a vision model.

Production flow:

user webpage
→ Revueon
→ normal DOM/browser evidence
→ model
→ action

NOT:

user webpage
→ screenshot
→ vision model

Vision models may ONLY be used for development and testing:

- visual QA
- screenshot inspection
- browser debugging
- visual regression testing
- validating that a transformation visually worked
- helping evaluate test results

If a screenshot is needed during development:

browser/test harness
→ screenshot
→ test-only vision model
→ textual description
→ developer reasoning

Never add vision-model screenshot calls to production code.

Never claim the production system "uses vision" because the test harness does.

---
ASK-QUESTION RULE

Do not ask the user about ordinary implementation details.

Make normal engineering decisions yourself using:

- roadmap
- current code
- tests
- architecture
- existing conventions

Ask the user ONLY when the decision is genuinely architectural or cannot be
safely inferred.

Examples:

- two materially different architectures
- privacy/product decision
- conflicting authoritative documents
- changing an approved foundation invariant
- unclear product behavior
- uncertainty about the intended roadmap

When asking:

1. State the exact decision.
2. Give the realistic options.
3. Recommend one.
4. Explain the important trade-off.
5. Stop and wait.

Do not guess through genuine ambiguity.
---
ARCHIVE RULE

Before implementing something that has historical precedent, inspect archive/.

Use archive/ to:

- recover useful ideas
- understand previous failures
- avoid repeating mistakes
- identify reusable browser techniques

Do NOT treat archive/ as current production architecture.

Do NOT resurrect the old pipeline.

When reusing archive material, adapt the principle to the current architecture.

---

SENIOR DEVELOPER ADVICE

Read relevant material under:

Senior_developer_advices/

Use it to understand:

- previous architectural reasoning
- browser constraints
- known failure modes
- rejected approaches
- important invariants

But current roadmap + explicit current user decisions win over historical
advice.

Do not blindly implement old advice if it belongs to an obsolete architecture.


## Reporting

End every task with: what shipped · what is proven, with real numbers (wall clock, paid calls, what
the vision model saw in words) · **what failed** · what you did not build, named explicitly ·
anything that looks bad to you even if it passed.

Never report a commit hash. Never overstate. "Not built" is a perfectly good line and omitting it
is not.

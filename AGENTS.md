# Revueon — AGENTS.md

Revueon is **an AI agent that lives in the browser**. A user states a goal in plain English and
Revueon investigates the page, gathers only the evidence it needs, chooses the cheapest correct way
to act, does it, looks at the result, and stops. Locally — never the site's backend.

Endgame: replace every browser extension. The moat is generality — **principles, not recipes**.

The claim is honest: the loop runs in the extension's service worker, every tool executes in the
page, all state is local. The only remote element is the model inference API call — true of every
competitor too. The system must work with ANY model (BYOK free tier): the brain is replaceable,
the architecture is the product.

---

## The two rules everything else follows from

> **1. Every user request is an investigation, not a pipeline.**
>
> Solve it with the minimum observation level, the minimum reasoning depth, and the minimum
> execution scope capable of producing a correct result with sufficient confidence.
> Escalate only when the evidence is insufficient — never because "that's the pipeline."

---

## Read these before working

| File | Read it when |
|---|---|
| `MVP-plan.txt` | THE current plan: diagnosis, phases R0–R7, keep/reject decisions from all past advice |
| `docs/ARCHITECTURE.md` | the live system — loop, tools, budgets, effect feedback, gates |
| `docs/TOOLS.md` | the tool registry contract |
| `docs/TESTING.md` | the two test commands and the standing test laws |
| `all_about_revueon.txt` | the product definition and vision |
| `project/proof/*.md` | the phase reports — the evidence trail. Numbers in reports are the truth, not claims |

Historical (`roadmap.txt`, `Transformation-quality-roadmap*.txt`, `how this project should be.txt`):
superseded context. The senior-advice folder was triaged and deleted 31 Aug 2026 — every kept
kernel and every rejected idea is recorded in `MVP-plan.txt §0.5`. Do not re-litigate them.

## Where we are (31 Aug 2026)

- Foundations F1–F7 proven (reversal, integrity, identity, continuity, responsive/contrast gates).
- T1–T5 transformation quality: design snapshot, prompt intelligence, cascade delivery, textEffect.
- R0/R1/R2 done: model-override benchmarking, `visualEffect` (the model's eyes) + the journal
  wiring fix that killed the 43/54-call churn, done-gate (a no-op run cannot ship as done),
  convergence guard, askUser, agent presence (overlay + genuine model first reply).
- Tests: `npm test` = 35 checks in ~1.5s; `npm run test:paid` = the real-model benchmark.
- **Next: R3 — the one-site (Wikipedia) MVP benchmark, 10 requests, the by-eye pass bar in
  MVP-plan.txt §R3.**

Remember after you write code, this code will be verified by codex, claude code and senior developer.

## Repo map (root = `Revueon/`)

- `project/` — the codebase: extension + harness (WXT, TypeScript strict, MV3, Playwright).
- `project/src/agent/` — the loop, the prompt, the journal, the budget.
- `project/src/tools/` — observe, act, verify. **Every capability lives here and nowhere else.**
- `project/src/core/perceive/` — kept intact. The strongest thing we built. It is **one tool**, level 4.
- `project/src/core/` — shared machinery: inventory, heal, reason (transport), persist, sanitize, config, design.
- `project/src/shared/color.ts` — pure color math for the contrast gate + perception.
- `docs/` — ARCHITECTURE / TOOLS / TESTING. Must describe the live system or be fixed in the same commit.

---

## Absolute rules

1. **Every request goes to the model.** No keyword table, no saved action, no hardcoded route, no
   "fast path" for simple things — and no hardcoded agent replies either: what the user reads as
   Revueon's answer is the model's own reasoning, forwarded.
2. **No module, file or directory is named after an operation.** Build representations and
   capabilities, not features.
3. **Observation collects evidence; it never decides.** No observation function returns anything
   that can be applied to a page.
4. **Low confidence means do less, never guess more.** Zero output and partial output are successful
   outcomes. The word `fallback` does not belong in this codebase.
5. **Execution scope equals decision scope.** Reasoned about three elements → exactly three elements
   may differ.
6. **Express intent, never implementation.** No length measured off the live page is ever written
   back into it. A transformation must survive a window resize — the one surviving hard law.
7. **Every operation is reversible, and `textContent` is never a valid inverse.** Anything touching
   structure records a cloned node. `on → off → on → off` restores the DOM byte for byte.
8. **Let the browser do browser work.** Prefer a stylesheet the cascade applies forever — including
   to elements that do not exist yet — over a DOM edit we then have to defend. Mutation is a rare
   exception and must declare its reason. Never relayout shadow DOM, virtualized lists, carousels,
   editors, canvas, SVG, maps, or video players; never replace an existing flex/grid container —
   wrap it or work at a higher boundary.
9. **Capabilities compose.** A new kind of request should need a new *combination*, not new code.
10. **Revueon never refuses a page.** No "page too large", no unsupported-site message. Do part of
    the job and say what you skipped.
11. **Refuse on measurement, never on spelling.** A scope guard checks what a selector actually
    resolved to — element count, share of page text, share of area. Blocklists leak.
12. **Anything a budget clips sets `truncated: true` and tells the model.** Silent truncation makes
    a model confidently wrong, which is worse than a model that knows it is missing something.
13. **Every error message names an alternative.** Errors are instructions, not log lines. A no-op
    act's report says *call findElements and scope to what it returns*.
14. **Never send a screenshot or page content to a model for identification.** Origin and path only,
    query and fragment stripped. Vision models are TEST-ONLY (QA in words on our own screenshots).
15. **A test may never be edited to make it pass.** Every check ships with a deliberate failing case
    where possible. If the check goes red, the extension is wrong.
16. **Code is wired in the same commit that creates it.** An orphan is a build failure — the wiring
    audit enforces it.
17. **Zero site-specific hardcoding.** No YouTube, Reddit or Wikipedia in any file, tool, prompt or
    constant. Principles, not recipes. Novel test prompts every time.
18. **Never run Playwright against YouTube, Reddit, X, LinkedIn, Amazon or Gmail.** Captchas hang the
    harness. Use MDN, Wikipedia, news.ycombinator.com, docs.python.org. Protected sites stay in the
    corpus as manual by-eye tests only.
19. **Green is not done.** A human eye — or at minimum a vision model describing the screenshot in
    words — is the only pass. `npm test` proves mechanics; the paid bench + by-eye review proves the
    product. Benchmarks run in isolation (no concurrent browsers, no concurrent builds).

## Two banned words

**"Intermittent"** — nothing in a deterministic system is intermittent. It is a race, a timeout, or
unmodelled state. Say "I do not know why this happens." That sentence is respected.

**"Harness artifact"** — if the harness sees it, the user will see it.

## Working style

- **Production-quality code, always.** Every line is written as if it ships to
  a million users tomorrow: descriptive professional identifiers (never
  scratch names like `firstreply`, `tmp2`, `handleThing`), comments that explain
  the WHY and the invariants — not restating the code, no leftover TODO noise,
  no debug prints. A reviewer should understand a function's intent and its
  edge cases from the name + comment before reading the body. If a name needs
  a comment to excuse it, rename it.
- **Think before coding.** State assumptions. If two interpretations exist, say so — don't pick
  silently. If something is unclear, stop and ask. Stopping to ask is always the right call.
- **Simplicity first.** Minimum code that solves the problem. Nothing speculative, no abstraction
  for single-use code, no orphan "for later" exports (the audit fails the build on them).
- **Surgical changes.** Every changed line traces to the request. Don't improve adjacent code.
  Remove orphans *your* change created.
- **Every phase ends with a report in `project/proof/`**: what shipped · what is proven with real
  numbers (wall clock, paid calls) · **what failed** · what was not built, named explicitly.
  Never report a commit hash. Never overstate. "Not built" is a perfectly good line and omitting it
  is not.

## Model policy

Production runs ONE model (`@cf/zai-org/glm-5.3-flash` on Cloudflare Workers AI, user decision).
The model is never the excuse: the system must work on any brain (BYOK). Benchmark variants via
`chrome.storage` overrides (`revueon_model_override` etc.) — no rebuild needed. Model-call cost
is NOT a loop concern; runaway safety (steps/wall/timeout/breakers) is.

## Browser automation

- **Playwright** is the authoritative harness: `npm test` (fast, deterministic) and
  `npm run test:paid` (real model, real sites).
- **agent-browser** is for exploration/debugging only. Anything it discovers that becomes a
  behavioral claim gets encoded in fast.ts or the paid bench before it counts as proof.

## Image rule

Production Revueon does NOT send screenshots to a vision model — DOM evidence only. The currently
configured coding model does NOT support image inputs: prefer DOM assertions, source inspection,
and text output. If visual verification is genuinely required and no vision tool is configured,
report the limitation rather than getting stuck. Never block unrelated work on it.

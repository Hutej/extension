# 06 — THE FOUNDATION AND THE MVP

**The thesis of this file:** stop building capabilities. Build the seven things
that every capability depends on, prove each one, and then every capability
after that is cheap.

Three months were spent building sophisticated features on top of primitives
that were never proven. The features failed, and the reason was always
underneath them.

---

## 1. The seven foundations

Every single Revueon request — "hide Shorts", "summarise this", "turn this into
a magazine", anything a user will ever type — needs all seven of these. Nothing
above them can be more reliable than they are.

| # | Foundation | The question it answers |
|---|---|---|
| F1 | **IDENTITY** | Given a human concept, which elements? And the same ones next time? |
| F2 | **APPLICATION** | How does a change reach the page and stay there? |
| F3 | **REVERSAL** | How does it come off, exactly? |
| F4 | **CONTINUITY** | Does it survive reload, SPA navigation, and tomorrow? |
| F5 | **INTEGRITY** | Is the page still good after the change? |
| F6 | **THE LOOP** | How does the agent decide what to do? |
| F7 | **SIGHT** | Can we see what we actually did? |

---

### F1 — IDENTITY

**Concept → elements, reliably and repeatably.**

The user says "Shorts", "the comments", "this article", "the engagement bait".
We must resolve that to specific elements, produce selectors that survive
re-render and revisit, and know when we cannot.

This is the hardest problem in browser extensions. It is also the one that
determines whether the product feels magical or broken, because everything else
is downstream of pointing at the right thing.

**Done means:**
- `describePage` returns a map good enough for the model to choose from, on any
  page, at any size, without refusing.
- `findElements` resolves a concept with a confidence number, and below the
  floor it does nothing and says why.
- Every candidate carries `targetable: true | { false, reason }`. Nothing is
  ever dropped silently.
- A selector produced on one page load resolves to the same element on the next
  load, and after an SPA re-render. **Tested, not assumed.**
- Hashed classes are never used as anchors.

**Currently:** partial. The map and the match work. Re-resolution after
re-render and after reload has never been tested.

---

### F2 — APPLICATION

**A change reaches the page and holds, without fighting the framework.**

**Done means:**
- One stylesheet node, in `@layer revueon`, is the default path for everything
  visual.
- Mutation happens only with a declared reason, and the reason set is small and
  named.
- A React or Vue re-render does not undo us, and **no defence loop is required**
  to make that true. If a defence loop is still needed, something that should be
  CSS is being done with JavaScript.
- First visible change within one second of the user pressing go.

**Currently:** working for CSS. The mutation path exists. The defence loop was
deleted along with `execute/`, which is correct — but that means nothing is
re-applying after SPA navigation, and that is F4.

---

### F3 — REVERSAL

**Every change comes off exactly. Byte for byte.**

This is the foundation the whole product's trust rests on. A user who has once
seen "off" leave the page damaged will never enable it on a page that matters.

**Done means:**
- Every act tool records its exact inverse before it runs.
- No inverse anywhere uses `textContent`.
- `undo(n)` walks the journal backwards and each step restores precisely.
- `assertDomClean` exists and passes on `on → off → on → off` on at least three
  real pages.

**Currently: BROKEN, and broken by construction.** `setText`'s inverse stores
`textContent`, which discards every child element — restoring it would leave a
wall of unstyled text. `assertDomClean` is a stub and has never run once in this
project's life.

**This is the most important unfixed thing in the codebase.**

---

### F4 — CONTINUITY

**The change survives reload, SPA navigation, and the next visit.**

Without this, Revueon is a party trick. With it, it is a product. "Hide Shorts"
that stops working when you click a video is worse than not having it, because
the user now has to think about it.

**Done means:**
- Journal persists per **origin + path**. Never a full URL — query strings and
  fragments carry tokens and personal data.
- On page load, the journal replays before first paint where possible.
- SPA route change is detected and targets re-verified.
- If a target no longer exists after replay, that is reported, not silently
  skipped.
- A change made today is still there tomorrow.

**Currently:** the storage layer exists and replay exists. **Never tested.**

---

### F5 — INTEGRITY

**The page is not broken after we touch it, and we know it.**

**Done means:**
- `checkLayout` catches, on the live DOM after render: overflow, zero-size
  elements that should be visible, invisible text (contrast ~0), content made
  unreachable, text breaking mid-word.
- `heal` runs after every removal. A hole left behind is an unfinished job.
- A failed check triggers **undo**, not repair. Repairing a bad result in place
  produces a differently bad result nobody planned.
- Checks assert physics only. Balance, rhythm and taste belong to the model and
  the human eye.

**Currently:** `checkLayout` is basic. `heal` is a stub with working code behind
it. Nothing triggers undo automatically.

---

### F6 — THE LOOP

**The agent decides, observes, acts, verifies, and stops.**

**Done means:**
- Every request goes to the model. No keyword table, no saved action, no route.
- Observation escalates on **confidence**, never on category.
- At least one observation before any act.
- Budget pressure is stated to the model, and the budget is checked **before**
  starting a call, not after it returns.
- The journal is the only state, and it is what the model reads each turn.
- `giveUp` is a respected outcome.

**Currently: working.** This is the one foundation that is genuinely proven —
the "hide the video player" run observed, found nothing, changed nothing, and
said why. That is the first time a deliberate failing case has passed here.

---

### F7 — SIGHT

**We can see what we actually did.**

For three months, every quality judgement came from one pair of human eyes,
days after the fact. Everything automated measured fidelity — did the output
match the plan — and reported success on destroyed pages.

**Done means:**
- The harness screenshots before and after every run.
- A vision model reads each screenshot and **describes it in words** in the
  report.
- "I could not visually verify" is never an acceptable report line. An unverified
  run is a failed run.
- Eventually: the agent itself can call `look` mid-run when it needs to know
  whether what it did worked.

**Currently:** missing entirely.

---

## 2. Where the foundations stand

| | Foundation | State |
|---|---|---|
| F1 | Identity | partial — never tested across renders |
| F2 | Application | working for CSS |
| F3 | Reversal | **broken by construction** |
| F4 | Continuity | untested |
| F5 | Integrity | heal stubbed, no auto-undo |
| F6 | The loop | **working** |
| F7 | Sight | missing |

One of seven is proven. That is the honest number, and it is why nothing built
on top has worked.

---

## 3. What the MVP is

> **Revueon reliably does small things to any web page, never breaks the page,
> and always comes off cleanly.**

That is the whole MVP. It is deliberately unambitious about *what* it can do and
completely uncompromising about *how well* it does it.

### In the MVP

- All seven foundations proven, each with a real test on a real page.
- Capabilities: `describePage`, `findElements`, `readText`, `inspect` ·
  `applyCss`, `hide`, `heal`, `insert`, `setText` · `snapshot`, `diff`,
  `checkLayout`, `assertDomClean`, `look` · `undo`, `done`, `giveUp`.
- Requests of the SUBTRACT, LOCAL and CONTENT kinds.
- Persistence per origin + path.
- One-click reverse that provably restores the page.
- The consent gate re-enabled. It is currently `CONSENT_REQUIRED = false` and
  that is a **P0 launch blocker**.

### Not in the MVP

Not because they are unimportant — because they cannot be reliable until the
foundations are:

- `recomposePage` and whole-page redesign
- Design languages, themes, aesthetic transformation
- `move`, `bindKey`, workflow rewriting
- Cross-site transformation
- Memory, sharing, a registry, a marketplace, an ecosystem

### The MVP acceptance corpus

All on automation-friendly sites — **never** YouTube, Reddit, X, LinkedIn,
Amazon or Gmail in Playwright; they serve captchas and the harness hangs. Those
stay as manual by-eye tests.

| # | Page | Request | Must |
|---|---|---|---|
| 1 | MDN article | "Summarise this article" | read the real page, insert, destroy nothing |
| 2 | MDN article | "Hide the video player" | find nothing, change nothing, say why |
| 3 | Wikipedia | "Hide the sidebar" | hide, heal, survive reload and a second article |
| 4 | MDN | "Reduce clutter" | act within budget; small is fine, nothing is not |
| 5 | Hacker News | "Increase spacing" | readable, no overflow, survives resize |
| 6 | any of the above | on → off → on → off | byte-identical DOM |
| 7 | any of the above | resize the window after | still correct |

Seven rows. When all seven pass **and a human agrees by eye**, the MVP exists.

---

## 4. The order

Build in this order. Each unblocks the next.

**First: F7 SIGHT.** Nothing else can be judged until we can see. Every hour
spent building without sight is an hour of unverified work, and this project has
already shipped eleven sweeps that way.

**Second: F3 REVERSAL.** It is broken by construction, it is the trust
foundation, and every act tool built before it is fixed will inherit the bug.

**Third: F5 INTEGRITY.** Wire `heal`. Make a failed check trigger undo. Now
every action is safe by default.

**Fourth: F1 IDENTITY, tested properly.** Same page twice, same selectors. After
re-render, same selectors.

**Fifth: F4 CONTINUITY.** Reload, navigate, return. This is the one that turns a
demo into a product.

**Sixth: F6 refinements.** The observe/act balance, budget accounting before the
call, error messages that teach.

**Then, and only then, capabilities.**

---

## 5. The rule this file exists to enforce

> **No new capability ships while a foundation is broken.**

When a new idea arrives — and it will, constantly — the question is not "can we
build it?" It is: *which of the seven does it depend on, and is that one
proven?*

If the answer is no, the idea waits. It is not lost — it goes in the roadmap.
But it does not get built on sand, because everything built on sand here has
had to be deleted, four times now.

# Phase 1 — F7 SIGHT (report)

*12 Aug 2026. Revueon rebuild plan v2, `roadmap.txt` §5. The gate everything
else is judged through: we can finally **see** what the extension does.*

> Rule 14: never send page content to a model for identification — origin/path
> only. Describing **our own test screenshots** is explicitly allowed, and is
> the whole point of this phase. The author of this report never looked at any
> PNG — only the vision model (`@cf/moonshotai/kimi-k2.7-code`) saw the images,
> and only its **words** were kept (`proof/vision-report.json`). Per user
> instruction: I do not support image input; any image goes to the vision model
> via a script.

---

## What shipped

1. **The red test ran to completion — all 6 variants, including the two that
   never produced artifacts before.** `proof/red-test-results.json` = 6/6 PASS.
   Artifacts: `proof/red-v1..v5b*.png`, `proof/red-v4-apply.json`,
   `proof/red-v5b-apply.json`. **Caveat up front (see "Anything that looks
   bad"):** the previous V4/V5b gap was a *test-harness* bug (wrong browser
   binary), not an extension bug. This 6/6 PASS is not a fix to extension code —
   the extension's USER-origin path was never broken; the test just couldn't
   reach it. The extension code was untouched this phase.
2. **A full vision-in-words report** for every harness before/after pair and
   every red-test single: `proof/vision-report.json` (12 descriptions, full,
   untruncated). The harness log (`tests/harness-run.log`) truncated vision to
   200/500 chars; this phase required the full words.
3. **The harness ran** (prior session) on 6 goals + a control pair; before/after
   PNGs are in `tests/screenshots/`, results in `tests/harness-run.log`.
4. **Two throwaway diagnostics** that found and proved the root cause of the
   red-test's V4/V5b gap: `tests/debug-ext-id.ts` (the diagnosis) and the
   `getExtensionId` fix in `tests/red-test.ts`.
5. **No extension code was touched.** Phase 1 is *see before you touch*. Every
   change is to the test harness or a new report script. (One test-only fix to
   `tests/red-test.ts` is described below.)
6. **A mandatory independent review ran** (6 agents: 5 lens reviewers + 1
   adversarial refuter). Its verdicts: headline proof survives refutation;
   Phase-1 bar met with caveats. It caught real errors in an earlier draft of
   this report (a false causal claim about the harness deaths, a wrong table
   entry for run 2) — both corrected below. The corrected report is what you
   are reading.

### What I saw (one paragraph, per the bar)

I did not look at any screenshot myself (rule 14 / this session's instruction:
no image input). The vision model (`@cf/moonshotai/kimi-k2.7-code`) looked and
told me in words: on the red-test fixture it saw a bright red background and a
bright red `#v5-box` for the user-origin variants (V4/V5b) and green for the
author-loses variant (V5a) — exactly matching the `getComputedStyle` readings.
On the real sites it saw one genuine change — the Hacker News page with much
taller header and far more whitespace, stories 1–7 visible instead of 1–20
(run 5) — and "nothing changed" for the void runs and the byte-identical
control pair. That is the whole point of F7 SIGHT: I can finally describe what
the extension did using someone's eyes that are not mine.

---

## What is proven, with real numbers

### The origin move — behavioural evidence on the fixture (the big one)

The memory recorded "origin move unproven — V4/V5b never produced artifacts."
That gap is closed — on the red-test fixture (a hand-authored page served over
`127.0.0.1`). Two independent modalities agree, and the review's adversarial
refuter confirmed the proof is genuine (it even pixel-inspected the PNGs and
found a 199×99 red rectangle at the `#v5-box` location — a third modality):

| Variant | What it tests | `getComputedStyle` read | Expected | Vision model saw (words) |
|---|---|---|---|---|
| **V4** user-origin `insertCSS` + `!important` | USER CSS beats unlayered author rule | `rgb(255, 0, 0)` | RED | "the page has a bright red background overall" |
| **V5b** user-important vs inline `green !important` | USER `!important` beats inline author `!important` | before `rgb(0,128,0)` → after `rgb(255,0,0)` | RED | "a bright red rectangular box labeled 'Variant5 target'" |

**V5b is the load-bearing one** (the review confirmed this too): V5a proves
that an author-origin `!important` **loses** to the inline green; V5b applies
the **same** CSS at USER origin and **wins** — the box turns from green to red.
The only variable between V5a and V5b is the CSS origin. That is the
controlled differential that isolates the origin move.

**Scope of this proof, stated honestly (per review):** this is behavioural
evidence on one shorthand (`background`) on one hand-authored fixture, not a
proof that USER-origin CSS wins on every real page. The origin move is a
browser-level guarantee and V5a/V5b isolate it cleanly, but no real-site
harness run was a user-vs-author origin head-to-head (the real-site runs died
at the observation step — see "What failed"). So "our CSS always wins" is the
*claim* this fixture supports on the *cascade-origin* axis; it is not yet
demonstrated against real sites with CSP, cascade layers, or author
`!important`. That is real-site proof, which belongs to later phases.

Full red-test result (all 6):

```
PASS  unlayered author normal              — other (rgb(246,246,239))  expect NOT red
PASS  author normal, emitter bypassed       — other (rgb(246,246,239))  expect NOT red
PASS  author important                      — red (rgb(255,0,0))         expect RED
PASS  author important vs inline !important — green (rgb(0,128,0))      expect GREEN (author loses)
PASS  user origin via insertCSS + important — red (rgb(255,0,0))        expect RED
PASS  user important vs inline !important   — red (rgb(255,0,0))        expect RED (user wins)
```

### The one genuinely successful transform — confirmed by eye (vision)

Run 5, "Increase spacing" on news.ycombinator.com:
- **Status:** `budgetExhausted` (but after 9 steps / 9 model calls / 56.9s — it
  ran the full tool chain: `describePage → checkLayout → checkLayout → applyCss ×4`).
- **`assertApplied`:** 2 act(s) moved computed style.
- **Resize check (1440 → 380 → 1440):** no overflow at either width. ✓
- **Vision diff (words):** "Increased vertical spacing and header size. The
  orange Hacker News header bar is much taller… The vertical gap between each
  numbered story entry is significantly larger, so only stories 1–7 are visible
  in the second screenshot instead of 1–20… substantially more whitespace."

This is the phase's bar met in the positive: a real change on a real site, a
vision model describing it in words, and it survived resize.

### The negative control holds

Control pair (two identical HN screenshots 500ms apart):
- `assertScreenshotsDiffer` → byte-identical (the harness flagged it correctly).
- Vision: "nothing changed." — the vision model does **not** invent changes on
  identical input.

### Sight works

`tests/vision-probe.js` → `verify status: 200`, then
"kimi-k2.7-code described the image in words." The vision path is real, the
token is valid **now** (see "Memory correction" below).

---

## What failed

### Most harness runs failed before acting — and that is a pass for this phase

The harness log's own SUMMARY: 4 `budgetExhausted` (runs 1, 2, 4, 5) + 2 `error`
(run 3 crashed, run 6 invalid JSON). That is 5 of 6 runs that did not complete a
satisfying transform — but **run 5 is one of the `budgetExhausted` and is the
genuine success** (it ran the full tool chain and changed the page). So the
honest count is: **1 run succeeded (run 5); 3 died at the observation step on a
parse/JSON error (runs 1, 2, 4, 6); 1 crashed on a closed context (run 3).**

| Run | Goal | Status | Steps | Calls | Time | Tools reached | Vision |
|---|---|---|---|---|---|---|---|
| 1 | Summarise article (MDN) | budgetExhausted | 2 | 3 | 60.0s | `describePage` only | nothing changed (void — before/after byte-identical) |
| 2 | Hide the video player (MDN) | budgetExhausted | 2 | 3 | 60.0s | `describePage` only | blue focus outline + chevron appeared on the `justify-content` code input (not our doing — an MDN widget focus state, per the vision diff) |
| 3 | Hide the sidebar (Wikipedia) | **error** | 0 | 0 | 0.0s | none | crashed: "Target page, context or browser has been closed" |
| 4 | Reduce clutter (MDN) | budgetExhausted | 2 | 3 | 60.0s | `describePage` only | a chevron appeared on the `justify-content` code input (same MDN widget focus state; not our doing) |
| 5 | Increase spacing (HN) | budgetExhausted | 9 | 9 | 56.9s | `describePage → checkLayout → checkLayout → applyCss ×4` | **real change, survived resize** (overflow check; no post-resize screenshot) |
| 6 | Summarise article / toggle cycle (MDN) | error | 2 | 3 | 60.0s | `describePage` only | nothing changed; "model returned invalid JSON twice" |

**Where the loop actually died:** runs 1, 2, 4, 6 never got past
`describePage` — "budget too low for retry after parse error" (run 6: "model
returned invalid JSON twice"). Run 3 crashed on a closed context (a
Playwright/context-lifecycle race, not an extension bug; I do not know why it
happens). **Only run 5 reached an act tool**, and run 5 is the one that worked.

**A transform that fails is a pass for this phase** (roadmap §5: "even a
failing run with real screenshots is a pass — we can finally see"). We can now
see exactly where the loop dies, and it is **not** where I first claimed — see
the correction below.

### A real bug the sight pass exposed (one finding — its causal reach is narrow)

**The tool self-reports failure on a successful application.** In V4/V5b the
page visibly turned red and `getComputedStyle` read `rgb(255,0,0)` — yet
`applyCss` returned `applied: false`:

```json
// proof/red-v4-apply.json
"applied": false, "before": "none", "after": "none", "matched": 1
```

Root cause (traced, not guessed): `core/emit.ts` `primaryTarget` picks
`item.declarations[0].property` — the first declaration. The CSSOM parser
expands `background: red` into longhands in insertion order, so
`declarations[0]` is `background-image`, whose computed value stays `none` even
after `background-color` (the tenth longhand) turns red. `assertApplied`
compares `background-image` before→after: `none`→`none` = no change =
`applied:false`.

**Correction to an earlier draft of this report (found by the Phase 1 review,
which read the harness log against this claim).** I first wrote that this bug
is "almost certainly why 5 of 6 harness runs hit `budgetExhausted`" — that
**causal claim is false against the evidence above.** The bug lives *inside*
`applyCss`; runs 1, 2, 4, 6 never called `applyCss` (they died at
`describePage` on a parse error / invalid JSON), and run 3 crashed before any
tool. The one run that exercised `applyCss` — run 5 — is the **success**, and
its `assertApplied` recorded `applied: true` (2 acts moved computed style), so
the bug did not block it either. The honest statement is narrower: **the bug
is real, deterministic, and reproducible on the red-test fixture, but it is
not demonstrated to have blocked any harness run.** The 4 early-death runs
failed on a genuine model/parse failure (invalid JSON / parse error at the
observation step), which is a **different** root cause Phase 2 must also look
at. I over-reached; the review caught it; this is the corrected version.

This is **not** a harness artifact and **not** "intermittent" (banned word). It
is a deterministic wrong-property-picked bug in `primaryTarget`. It is the exact
"green is not done" failure Phase 1 exists to surface — and now that we can see
it, Phase 2+ can fix it (and separately chase the parse-error-at-describePage
deaths).

**I did not fix it.** It is tool code (`core/emit.ts` / `tools/act.ts`), outside
Phase 1 scope ("no extension code changes expected — see before you touch").
Flagged for Phase 2 (F3 REVERSAL touches `act.ts` anyway) or a dedicated fix.

---

## What I did not build (named, per CLAUDE.md)

- **No extension code.** No foundation fixes, no capability, no tool changes.
  The one code change (`tests/red-test.ts`) is to the test harness — dropping
  `executablePath` so it uses Playwright's bundled Chromium, matching the
  harness. The diagnosis (`tests/debug-ext-id.ts`) and the full-vision report
  (`tests/vision-report.ts`) are new test/report scripts only.
- **No fix to the `primaryTarget` bug.** Found, traced, repro'd, left for the
  next phase — by scope, not by oversight.
- **No re-run of the harness.** The harness output is from the prior session
  (its screenshots and log are intact). Re-running it would not change Phase 1
  — most runs die at the observation step on a parse/JSON error (a different
  root cause from the `primaryTarget` bug), so a re-run now would likely fail
  the same way. Phase 2 should chase the parse-error-at-`describePage` deaths
  *and* fix `assertApplied`, then re-run the harness when a green run would
  mean something.
- **No resurrection of the deleted DSL.** The closed design vocabulary stays
  deleted (antipattern A7).

---

## Anything that looks bad even though it passed

1. **`prove-results.json` is 15/15 PASS and still says "STRUCTURAL only — it
   reads source, it never runs the code."** That has not changed; it is the
   standing "green is not done" example (`scripts/prove.ts` labels it
   honestly). Behavioural proof lives in the red test (now 6/6) and the vision
   report, not in `prove`.
2. **The red test's V4/V5b gap was a test bug, not an extension bug.**
   `red-test.ts` set `executablePath: '/usr/bin/google-chrome'`; under Playwright
   that Chrome build never registers the MV3 service worker on `127.0.0.1`, so
   V4/V5b could not call the extension (0 service workers over 25s, proven via
   `tests/debug-ext-id.ts`). Dropping `executablePath` (use bundled Chromium,
   as `harness.ts` does) fixed it. The *extension* was never broken here.
3. **Run 3 (Wikipedia) crashed on a closed context** — a Playwright
   context-lifecycle race, not investigated. Worth a look in Phase 2 but not a
   foundation blocker.
4. **Run 5's "survived resize" is overflow-check-only, not vision-verified.**
   The harness resized 1440→380→1440 and asserted no horizontal overflow at
   either width — that is a weaker proxy than P4's full no-breakage definition,
   and there is no post-resize screenshot for the vision model to describe. It
   is the existing harness's gate, not a Phase-1 defect, but "survived resize"
   should not be read as vision-confirmed at the resized widths.
5. **The harness runs against live MDN/Wikipedia/HN** (rule 18: MDN, Wikipedia,
   news.ycombinator.com are all on the allowed automation list). No protected
   site was automated.

---

## Memory correction (important)

The memory file `project-credentials-broken.md` says the Cloudflare token is
**invalid (code 1000)** and blocks the loop + vision. **That is stale.** The
user fixed the token. Verified directly this session:
`node --env-file=.env tests/vision-probe.js` → `verify status: 200`, then a
real vision description. The token is valid and Workers AI is reachable.
- The invalid-token memory should be retired/updated.
- The "no saved harness results" finding was likely a mix: dead creds in
  earlier sessions, plus the harness runs dying at the observation step on
  parse/JSON errors (a model/parsing failure, not the `primaryTarget` bug —
  that bug was not the cause, as corrected above).

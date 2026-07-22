# Phase 1 Closure — Final Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use compose:execute (inline) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Audit reports against the work order's letter-numbers VERBATIM — no renumbering, no omissions.

**Goal:** Close Phase 1 — production hygiene, "use the room", invisible text killed at emission, harness/live parity, BBC collapse fixed, third-strike debts cleared, close-out proofs asserted, and ONE final paid grid proving the lot with genuinely novel prompts.

**Architecture:** Tests-first (failing → passing), free-test-first then one paid grid. Every new check enters the harness before its fix. Compile-laws (not prompts) guarantee behavior. Pixel detectors calibrated against real labeled captures so the harness predicts the live browser. Ponytail full governs every edit.

**Tech Stack:** WXT MV3, TypeScript strict, Playwright harness, OpenAI design model, Chrome `captureVisibleTab`.

## Global Constraints (bind every task)
- Zero site-specific hardcoding. Principles, not recipes. Grid uses NOVEL prompts (the exclusion list in section H is binding).
- Real proof only: real extension, real sites, real model calls. Never pass a test by loosening it.
- ≤2 visible paints per transform. 1 paid call happy path. Design ≤30s target, ≤120s hard cap. Simple asks ≤5s.
- Free-test-first; ONE final paid grid at the end.
- Small commits per task; typecheck + unit tests green before every merge.
- Every task ships or is flagged-and-stopped WITH DATA. An omitted/renumbered task = failed round.
- The source is a product surface — no agent-protocol vocabulary, no site names, no conversation quotes in `src/`.

## Acknowledged prior-round violations (do not repeat)
1. The prior grid reused Carnival / Mid-century / Holi / quiet-luxury / evening-edition — ALL on the exclusion list — and reported them as "fresh novel prompts." A rules violation reported as compliance.
2. The harness reported MDN "13 invisible" and BBC "applied=NO" while the user's LIVE MDN was the best output and live BBC applied a coherent design. The pixel invisible-text detector MISFIRES (likely code-block tokens / ads / iframes / sub-scrollable regions), and the harness environment diverges from live. Prior "by-eye-killer detected" claims were partly false positives.

## Execution order (free-test-first; paid grid only at H)
A (hygiene, free) → D (calibrate the eyes, free — everything downstream depends on trustworthy detectors) → C (invisible-text emission law, free) → B (use the room, free) → E (BBC collapse, free) → F (debts, free) → G (close-out proofs, free) → H (ONE final paid grid).

---

## A — PRODUCTION HYGIENE: the source becomes a product

### Task A1: Scrub agent-protocol vocabulary from source
**Covers:** A1
**Files:** `project/src/core/{repair,verify/pixel,verify/index,content via entrypoints,execute,background,laws,reason,config,spec,persist,compile,perceive}/index.ts`, `project/src/entrypoints/{content,background}.ts`, `project/src/entrypoints/popup/main.ts`
**Mechanism:** rewrite every comment that mentions "Round N", "WS1…WS6", "workstream", "mandate", "ponytail", "architect", "the user's eye", "120s rule" / latency-rule phrasing into timeless product terms (what the code does + why). Config VALUES unchanged; their comments describe product behavior ("hard abort for a single generation attempt"). Remove `// ponytail:` markers but KEEP the reasoning (rewrite as a plain product comment).
- [ ] Step 1: sweep `verify/pixel.ts`, `verify/index.ts`, `content.ts`, `background.ts`, `execute/index.ts` — rewrite each protocol comment.
- [ ] Step 2: sweep `laws`, `repair`, `reason`, `config`, `spec`, `persist`, `compile`, `perceive`, `popup/main.ts`.
- [ ] Step 3: `npm run compile` green.
- [ ] Step 4: commit `refactor(hygiene): rewrite agent-protocol comments as product comments (A1)`.

### Task A2: Finish site-name + conversation-quote scrub
**Covers:** A2
**Files:** `project/src/core/repair/index.ts:121` (BBC), `project/src/core/compile/index.ts:232` ("sleeps in the washroom")
**Mechanism:** genericize the two residual regression-story comments into product terms ("a dense grid page", "a text cluster narrowed below a readable measure").
- [ ] Step 1: rewrite both comments.
- [ ] Step 2: `npm run compile` green.
- [ ] Step 3: commit `refactor(hygiene): remove last site-name + conversation-quote references (A2)`.

### Task A3: Grep proof + commit the grep output
**Covers:** A3
**Mechanism:** run `rg -riE 'round [0-9]|ws[1-6]|workstream|mandate|ponytail|architect|120s|wikipedia|youtube|github|mozilla|bbc|mdn' project/src/` and confirm it returns nothing (each genuine technical hit justified individually). Commit the grep output as proof at `docs/compose/reports/2026-07-21-hygiene-grep.txt`.
- [ ] Step 1: run the grep; if any hits remain, fix them (A1/A2 missed spots).
- [ ] Step 2: save empty/justified grep output to the report path.
- [ ] Step 3: commit `docs: hygiene grep proof — zero protocol/site-name hits in src/ (A3)`.

---

## D — HARNESS/LIVE PARITY: calibrate the eyes (before trusting any detector)

### Task D1: Root-cause the harness/live disagreement + calibrate invisible-text detector
**Covers:** D1
**Files:** `project/tests/popup.test.ts` (harness capture), `project/src/core/verify/pixel.ts` (`detectInvisibleText`)
**Mechanism:** the detector misfires on code-block tokens, ads, iframes, and sub-scrollable regions where text is offscreen at the capture scroll position. Root-cause both: (a) MDN "13 invisible" = false positives on code blocks / offscreen-on-scroll content; (b) BBC "applied=NO" = harness viewport/cookies/timing diverges from a live logged-in browser. Calibration: capture labeled crops from real MDN/BBC post-apply screenshots; label each `[data-wm-c]` rect as truly-invisible vs detector-artifact; adjust `detectInvisibleText` to (i) skip rects whose cluster is not within the capture's visible scroll window, (ii) skip code/pre clusters (monospace runs read as low variance but are legible), (iii) require the rect's text length + rendered area thresholds. Make the harness viewport/timeout match a live browser (same default viewport, wait for network-idle + a settle).
- [ ] Step 1: write a failing harness test that captures post-apply MDN, labels known-good code clusters, and asserts `detectInvisibleText` returns ZERO on them.
- [ ] Step 2: run it — record the false-positive count (the "13").
- [ ] Step 3: fix `detectInvisibleText` (scroll-window filter + code-cluster skip + thresholds).
- [ ] Step 4: run it — assert zero false positives on the labeled crops.
- [ ] Step 5: align harness viewport/network-idle with a live browser; re-run BBC.
- [ ] Step 6: commit `fix(verify/pixel): calibrate invisible-text detector on real captures (D1)`.

### Task D2: Re-derive the severe-invisible escalation threshold from calibrated data
**Covers:** D2
**Files:** `project/src/core/repair/index.ts` (the `pixelInvisible.length >= 6` gate)
**Mechanism:** after D1 calibration, re-run the labeled captures and find the threshold that separates a genuinely-broken run from a one-off artifact. Replace the guessed `>= 6` with the data-derived value; if no genuine case reaches the old threshold, the escalation gate may move to a higher bar or to a SECOND capture confirming the first (two-position agreement) to kill single-position artifacts.
- [ ] Step 1: gather calibrated invisible counts across the labeled runs.
- [ ] Step 2: set the threshold from data (or switch to two-position agreement).
- [ ] Step 3: commit `fix(repair): re-derive severe-invisible threshold from calibrated data (D2)`.

---

## C — INVISIBLE TEXT: kill it at emission

### Task C1: Emission-time contrast law in the compiler
**Covers:** C1
**Files:** `project/src/core/compile/index.ts` (new `assertEmissionContrast`), `project/src/core/laws/index.ts` (contrast threshold export)
**Mechanism:** the compiler REFUSES any emitted text/background pair below the contrast floor, computed on the EFFECTIVE pair the emitted CSS creates (the cluster's declared text color vs its declared/ancestor background, alpha-composited). A rule that sets `color` without a reachable contrasting background is dropped (logged) rather than shipped. This makes the ~19 invisible clusters impossible to emit. Strengthen the reasoning-prompt directive too, but the LAW is the guarantee.
- [ ] Step 1: write a failing compile test that feeds a spec with dark text on a dark declared bg and asserts the emitted CSS does NOT contain that color/bg pair.
- [ ] Step 2: run it — record the fail (the pair ships).
- [ ] Step 3: implement `assertEmissionContrast` (walk emitted declarations, compute WCAG ratio on the effective pair, drop offending color decls).
- [ ] Step 4: run it — assert pass; free suite green.
- [ ] Step 5: commit `feat(compile): emission-time contrast law refuses low-contrast text/bg pairs (C1)`.

### Task C2: Pixel-grounded contrast repair (sample the rendered background)
**Covers:** C2
**Files:** `project/src/core/verify/pixel.ts` (extend `detectInvisibleText` to return the effective-bg sample), `project/src/core/repair/index.ts`
**Mechanism:** for clusters still rendering invisible, sample the rendered pixels BEHIND the failing text rect (from the WS1 capture) to get the true background, then repair whichever side the design intends (if the cluster is meant to be a light card, force the bg light; if dark text on dark canvas, force the text light) rather than blind text-color forcing. The pixel critique carries the sampled bg so the repair router can choose.
- [ ] Step 1: extend the pixel invisible entry to include the sampled bg color.
- [ ] Step 2: repair router: if the sampled bg is dark and the design palette is dark-canvas, force text light; if the design is light-canvas, the bg is wrong — force bg light.
- [ ] Step 3: commit `feat(verify/repair): pixel-grounded contrast repair samples the rendered bg (C2)`.

### Task C3: Acceptance case — Wikipedia ghost headings + washed links
**Covers:** C3
**Files:** `project/tests/popup.test.ts` (Wikipedia acceptance assertion)
**Mechanism:** add a harness assertion that Wikipedia post-apply has no invisible headings/links (the four-round failure). Runs on the final grid; the C1+C2 fixes are what make it pass.
- [ ] Step 1: write the failing assertion (pixel invisible on Wikipedia heading/link clusters).
- [ ] Step 2: record the fail on the current build.
- [ ] Step 3: (passes after C1+C2 land on the final grid).
- [ ] Step 4: commit `test: Wikipedia ghost-heading/washed-link acceptance case (C3)`.

---

## B — USE THE ROOM: the shrink bug

### Task B1: Pixel utilization metric
**Covers:** B1
**Files:** `project/src/core/verify/pixel.ts` (`measureUtilization`), `project/src/core/spec/index.ts` (a `readingMeasure?: boolean` design declaration on the spec)
**Mechanism:** from each capture, measure the content-ink bounding box (the non-background pixels) vs the viewport rect. Utilization below a floor = FAIL — UNLESS the spec explicitly declared `readingMeasure: true` (an articulated long-form layout decision, not a default). The metric is pure (takes a PixelInput).
- [ ] Step 1: write a failing unit test: a capture with ink only in the central 80% width → utilization below floor → fail (no reading-measure declared).
- [ ] Step 2: run it — fail.
- [ ] Step 3: implement `measureUtilization`; add `readingMeasure` to the spec interface.
- [ ] Step 4: assert pass; free suite green.
- [ ] Step 5: commit `feat(verify/pixel): content-ink utilization metric + reading-measure opt-out (B1)`.

### Task B2: Compile-law against canvas/container shrink below original content width
**Covers:** B2
**Files:** `project/src/core/compile/index.ts` (new `assertWidthUtilization`), `project/src/core/laws/index.ts`
**Mechanism:** canvas/container-level width rules must not narrow the composition below the original page's content width UNLESS the spec declares a reading measure. Margins must be deliberate, symmetric, bounded. Drop (log) offending maxWidth/width declarations that shrink below the measured original content width minus a tolerance.
- [ ] Step 1: failing compile test: a spec narrowing the canvas to 60% of original content width with no reading-measure → emitted maxWidth dropped.
- [ ] Step 2: run it — fail.
- [ ] Step 3: implement `assertWidthUtilization` (compare emitted widths to perception's original content width; drop shrinkers without readingMeasure).
- [ ] Step 4: assert pass; free suite green.
- [ ] Step 5: commit `feat(compile): refuse canvas/container shrink below original content width (B2)`.

### Task B3: Empty-band detector
**Covers:** B3
**Files:** `project/src/core/verify/pixel.ts` (`detectEmptyBand`)
**Mechanism:** any viewport-wide horizontal band above a height threshold with no content ink = a void fail (the empty header band). Pure — scans the capture row-by-row for inkless viewport-wide bands taller than the floor.
- [ ] Step 1: failing unit test: a capture with a 200px-tall inkless band at the top → detected.
- [ ] Step 2: run it — fail.
- [ ] Step 3: implement `detectEmptyBand`.
- [ ] Step 4: assert pass; free suite green.
- [ ] Step 5: commit `feat(verify/pixel): empty-band detector (B3)`.

### Task B4: Root-cause the live GitHub shrink + top void, prove the fix
**Covers:** B4
**Files:** `project/tests/popup.test.ts` (GitHub utilization + empty-band assertions)
**Mechanism:** add the harness assertions (utilization pass + no empty band on GitHub); the B1+B2+B3 fixes are what make them pass. Root-cause logged in the commit message (the live symptom = content column ~80% width, dead margins, empty top band).
- [ ] Step 1: write the failing GitHub assertions.
- [ ] Step 2: record the fail (utilization low, empty band present).
- [ ] Step 3: (passes after B1/B2/B3 on the final grid).
- [ ] Step 4: commit `test: GitHub shrink + top-void acceptance case (B4)`.

---

## E — BBC COLLAPSE

### Task E1: Root-cause content-height collapse + compile-law
**Covers:** E1
**Files:** `project/src/core/compile/index.ts` (new `assertNoContentCollapse`), `project/tests/popup.test.ts`
**Mechanism:** the model produces layouts that zero out content height (display/height/maxHeight combos that collapse a content-bearing cluster). Compile-law: refuse an emitted height/maxHeight/display:none on a cluster whose perception samples hold real text, unless the rule explicitly declares `hide: true`. Strengthen the reasoning prompt's "do not collapse content height" directive. Prove on BBC with a NOVEL prompt (H exclusion list obeyed).
- [ ] Step 1: failing compile test: a spec with `maxHeight:0` on a text-bearing cluster (not hide) → dropped.
- [ ] Step 2: run it — fail.
- [ ] Step 3: implement `assertNoContentCollapse`.
- [ ] Step 4: assert pass; free suite green.
- [ ] Step 5: commit `feat(compile): refuse content-height collapse on text-bearing clusters (E1)`.

---

## F — THIRD-STRIKE DEBTS

### Task F1: Serialization budget
**Covers:** F1
**Files:** `project/src/core/perceive/index.ts` (`serializePerception` budget), `project/src/core/config/index.ts`
**Mechanism:** bound the perception payload to a char ceiling; truncate/coalesce low-priority clusters when over budget. Report chars before/after per site in the ledger.
- [ ] Step 1: add a budget constant + a budgeting pass in serializePerception; add `serializeCharsBefore` to the ledger.
- [ ] Step 2: unit test: a perception over budget → serialized length ≤ ceiling.
- [ ] Step 3: commit `feat(perceive): serialization budget — bound payload chars (F1)`.

### Task F2: Model bake-off table
**Covers:** F2
**Files:** `docs/compose/reports/2026-07-21-model-bake-off.md`
**Mechanism:** from the final grid data (H), commit a comparison table: model × quality (changeScore/coverage/pixel-clean) × latency × tokens. Any mix allowed; pick from data. Bar: design ≤30s, simple ≤5s. NOTE: the bake-off is filled from the final grid data — produced at H, committed there.
- [ ] Step 1: (data gathered at H).
- [ ] Step 2: commit the table at H.

### Task F3: Root-cause + fix the 23s unaccounted ledger gap
**Covers:** F3
**Files:** `project/src/entrypoints/content.ts` (instrument `askForSpec` + `serializePerception` + rafs), `project/src/core/reason/index.ts`
**Mechanism:** wrap each untracked span (serializePerception, the `chrome.runtime.sendMessage` round-trip beyond `callMs`, the post-call spec validation, the rafs) in timers; add them to the ledger so `unaccountedMs` → ~0. Root cause stated as "it is X, proven by Y" in the commit.
- [ ] Step 1: add `serializeMs`, `ipcOverheadMs`, `rafMs` to the ledger.
- [ ] Step 2: run smoke; read which bucket ate the 23s.
- [ ] Step 3: fix the largest bucket (likely IPC overhead or a missing wait).
- [ ] Step 4: commit `fix(content): root-cause + close the 23s ledger gap (F3)`.

### Task F4: Route repair reasoning to a faster model
**Covers:** F4
**Files:** `project/src/core/reason/index.ts` (a `repairModel` config + path), `project/src/core/config/index.ts`
**Mechanism:** the severe-repair escalation costs ~109s because it re-runs the full design model. Repair needs far less context than design — route it to a faster/cheaper model (from the F2 bake-off data). Bar: design ≤30s, simple ≤5s; a repair reReason must not push total over the hard cap.
- [ ] Step 1: add `repairModel` to AI_CONFIG; the reReason path uses it.
- [ ] Step 2: commit `feat(reason): route repair reReason to a faster model (F4)`.

---

## G — CLOSE-OUT PROOFS (each = a harness assertion)

### Task G1: New shadow roots created after apply get styles injected
**Covers:** G1
**Files:** `project/tests/popup.test.ts`, `project/src/core/execute/index.ts` (if needed)
**Mechanism:** add a harness assertion that injects a new open shadow root AFTER apply and asserts it receives the style within a settle window. If the current observer only covers roots found at perception, extend it to detect new shadow roots (MutationObserver on document for `shadowRoot`-bearing custom elements).
- [ ] Step 1: write the failing assertion.
- [ ] Step 2: fix the observer if it misses new roots.
- [ ] Step 3: commit `test+fix: new shadow roots injected post-apply (G1)`.

### Task G2: Scroll-loaded content styled (explicit assertion)
**Covers:** G2
**Files:** `project/tests/popup.test.ts`
**Mechanism:** keep the scrollLoad check green; assert explicitly with a recorded verdict.
- [ ] Step 1: ensure the assertion runs + records a verdict on the final grid.
- [ ] Step 2: commit `test: scroll-loaded content styled assertion (G2)`.

### Task G3: Persistence — reload + SPA re-applies verified CSS
**Covers:** G3
**Files:** `project/tests/popup.test.ts`
**Mechanism:** assert reload + SPA navigation re-applies the SAME verified CSS (not a re-compile drift). "Pre-existing" is not proof — assert this round.
- [ ] Step 1: write the failing assertion (reload, compare applied CSS to the stored verified CSS).
- [ ] Step 2: fix the persistence path if it drifts.
- [ ] Step 3: commit `test+fix: persistence re-applies verified CSS on reload + SPA (G3)`.

### Task G4: Escape hatch instant at any moment
**Covers:** G4
**Files:** `project/tests/popup.test.ts`
**Mechanism:** assert Off/Remove All works mid-transform, post-repair, after SPA nav.
- [ ] Step 1: write the assertion at all three moments.
- [ ] Step 2: commit `test: escape-hatch instant at any moment (G4)`.

### Task G5: Theme polarity opposite to site default honored
**Covers:** G5
**Files:** `project/tests/popup.test.ts`
**Mechanism:** one run whose prompt implies the OPPOSITE polarity to the site's default (e.g. a dark site → light design), assert the canvas honors the design polarity.
- [ ] Step 1: write the assertion on a polarity-opposite run.
- [ ] Step 2: commit `test: theme-polarity-opposite honored (G5)`.

### Task G6: Typography laws in the compiler (verified, not requested)
**Covers:** G6
**Files:** `project/src/core/compile/index.ts` (typography laws), `project/src/core/laws/index.ts`, `project/tests/compile.test.ts`
**Mechanism:** compiler laws for readable measure (~45–90ch), a deliberate type scale (ratio between heading/body), line-height floors. Verified by a compile test, not just a prompt request.
- [ ] Step 1: failing compile test: a spec with 0.9 line-height body or 110ch measure or no type scale → flagged/dropped.
- [ ] Step 2: implement the typography laws.
- [ ] Step 3: commit `feat(compile): typography laws — measure, type scale, line-height floors (G6)`.

### Task G7: Background-contains-content law + test
**Covers:** G7
**Files:** `project/src/core/verify/pixel.ts` (`detectContentEscape`), `project/tests/popup.test.ts`
**Mechanism:** no text escaping its painted panel — a text cluster whose rendered rect extends beyond its declared background's painted rect = fail. Law + test.
- [ ] Step 1: failing test: text rect beyond bg rect → detected.
- [ ] Step 2: implement `detectContentEscape`.
- [ ] Step 3: commit `feat(verify/pixel): background-contains-content law + test (G7)`.

### Task G8: Multi-viewport + zoom + resize + devtools hold
**Covers:** G8
**Files:** `project/tests/popup.test.ts`
**Mechanism:** assert the design holds at 2nd viewport, 80%/125% zoom, window resize, devtools-open shrink — per run. Keep the existing checks; ensure each records a verdict on the final grid.
- [ ] Step 1: ensure all four record verdicts.
- [ ] Step 2: commit `test: multi-viewport/zoom/resize/devtools verdicts (G8)`.

### Task G9: Vague prompts held to the same bars
**Covers:** G9
**Files:** `project/tests/popup.test.ts`
**Mechanism:** vague-axis runs pass the same pixel/utilization/contrast bars as design prompts.
- [ ] Step 1: assert vague runs meet the bars.
- [ ] Step 2: commit `test: vague prompts held to the same bars (G9)`.

---

## H — FINAL GRID & DEFINITION OF DONE

### Task H1: ONE final paid grid
**Covers:** H
**Files:** `project/tests/popup.test.ts` (prompt selection), grid run
**Mechanism:** 5 sites + 2 vague prompts + fast-path checks. GENUINELY NOVEL prompts — NOT on the exclusion list: cyberpunk HUD, children's picture book, quiet luxury, editorial magazine, minimal brutalist, calm night, retro terminal, 1920s newspaper, coffee shop, dark academia, Swiss grid, glassmorphism, neobrutalism, zen garden, 8-bit arcade, Art Nouveau, tropical resort, vintage travel poster, Bauhaus, Soviet constructivist, Memphis, Cottagecore, Frida Kahlo, Carnival, Vorticism, Pop Art, Mid-century, Holi, evening-edition.
Novel candidate prompts (pick 5 + 2 vague, none on the list): "high-contrast Swiss ticket-stub", "1970s airport departure board (split-flap)", "risograph zine", "blueprint schematic", "Japanese station signage", "acid-graphic rave flyer", "soft pastel planner", "industrial control panel". Vague: "make it easier to read", "make it feel important".
- [ ] Step 1: confirm all A–G free work is green (typecheck + unit tests).
- [ ] Step 2: `npx wxt build`.
- [ ] Step 3: run the grid; record full stage ledger, paid calls, tokens, serialization before/after, per-check verdicts, paint counts, before/after screenshots at 3 scroll positions.
- [ ] Step 4: produce the bake-off table (F2) from this data.
- [ ] Step 5: honest report — audit every task A1–G9 + H by letter-number, shipped/failed/stopped-with-flag.

### Definition of Done (Phase 1)
Every G proof green · pixel audit clean (no invisible, no voids, no squeeze, no empty bands) · utilization pass on every site · ≤2 visible paints · 1 paid call on the happy path · design ≤30s target with the hard cap honored · simple asks ≤5s · hygiene scrub complete with grep proof · zero site-specific anything.

Reference standard: the dark editorial MDN output — disciplined type, coherent accent, framed panels, full width used. That quality, on every site, at every zoom. Not "applied". Designed.

---

## Self-review (spec coverage)
Every work-order letter-number maps to a task: A1→A1, A2→A2, A3→A3, B1→B1, B2→B2, B3→B3, B4→B4, C1→C1, C2→C2, C3→C3, D1→D1, D2→D2, E1→E1, F1→F1, F2→F2 (data at H), F3→F3, F4→F4, G1→G1, G2→G2, G3→G3, G4→G4, G5→G5, G6→G6, G7→G7, G8→G8, G9→G9, H→H1. No task omitted or renumbered. Deviations: F2 bake-off data is produced at the final grid (H) and committed there — flagged here, not deferred silently.

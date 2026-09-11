# Revueon — Architecture

> **Historical document — not current architecture.** The S6.3 cutover
> (plan/19) deleted the system this file describes (the agent loop, tool
> registry, legacy persistence and their live paths). It is preserved for
> archaeology only. Current authority: `plan/` (architecture) and
> `plan/progress.md` (implementation state). Do not follow anything here.



*Complete specification of the live system. Rebuilt 31 Aug 2026 from source
after R0/R1/R2. Every number in this file is verified against code — when code
changes, this file changes in the same commit (stale-doc drift was the T0
lesson; numbers in `project/proof/*.md` reports are the historical truth).*

## 1. What Revueon is

An AI agent that lives in the browser. The user types a goal in plain English;
Revueon investigates the page, gathers only the evidence it needs, authors the
cheapest correct change, applies it locally, reads back the effect, and stops.
The site's backend is never touched. One model, any brain: the model is a
replaceable config constant — the architecture is the product.

Honest claim audit: the loop runs in the extension's service worker, every
tool executes in the page, all state is local (`chrome.storage`). The only
remote element is the model inference API call — true of every competitor.

## 2. The three contexts

```
POPUP (the face — src/entrypoints/popup/)
  goal input · model reply · askUser question + options + free text
  status/metrics · credentials · result JSON (#revueon-result, test hook)

BACKGROUND SERVICE WORKER (the brain's host — src/entrypoints/background.ts)
  runLoop — the agent loop (src/agent/loop.ts)
  callLoopModel — the ONLY model transport (src/core/reason/)
  chrome.scripting.insertCSS / removeCSS — USER-origin CSS
  webNavigation replay · per-tab CSS tracker (storage.session)
  askUser pending-question map (id → resolver, 120s timeout)

CONTENT SCRIPT (the hands — src/entrypoints/content.ts, one per page)
  tool dispatch against the live DOM (src/tools/)
  TransactionLog — exact structural undo (src/core/ops/)
  work overlay (closed shadow root) · identity store · persisted-DOM replay
```

## 3. Message protocol (complete)

| message | from → to | purpose |
|---|---|---|
| `runLoop {goal, tabId}` | popup → background | start the agent loop |
| `insertCSS {css}` / `removeCSS {css}` | content → background | USER-origin CSS (tab tracked in `storage.session`) |
| `toggleCss {on}` | content → background | toggle persisted CSS for the scope |
| `toolCall {tool, args}` | background → content (tab) | dispatch one tool |
| `undoAll` / `undoLast` / `resetTxn` | background → content | structural rollback / log reset |
| `revueonWorkStart {goal}` | background → content | show overlay, block page input |
| `revueonWorkStep {entry:{tool,kind,reasoning?}}` | background → content | overlay phase/reply text |
| `revueonWorkEnd` | background → content | remove overlay (always — incl. error path) |
| `revueonReply {text}` | background → popup | the model's own first reply |
| `askUserPrompt {requestId, question, options}` | background → popup | ask the user |
| `askUserAnswer {requestId, answer}` | popup → background | resolve the pending question |
| `toggle` / `remove` | popup → content | user-facing on/off / remove-all |

## 4. The loop, turn by turn (src/agent/loop.ts)

System prompt (`SYSTEM_PROMPT`, src/agent/prompt.ts): identity, the JSON
response contract, and the non-negotiable guardrails (preserve content and
function; never invent selectors; author responsive intent, never measured
pixels; ask only on genuine ambiguity; done requires visible effect; honest
giveUp over wrong transformation). User prompt: goal, origin+path (never
query/fragment), the tool list, the budget line, the full serialized journal,
and the design-intelligence paragraph (effect-not-property, one coordinated
stylesheet, sub-region scoping via findElements, intended-visible-effect
clause, stop-when-satisfied).

One model call per turn (`callLoopModel`, temperature 0, JSON object response
format), one parse retry on invalid JSON. Each successful parse is one of:
`{tool,args,reasoning}` · `{done,summary}` · `{giveUp,reason}`.

Turn order and every gate:

1. **First reply** — the first parsed response's `reasoning` (or summary) is
   forwarded once as the user-facing reply (popup `Revueon: …` + overlay). No
   hardcoded acknowledgment exists anywhere in the product.
2. **done** — R2 done-gate first: if applyCss acts were authored and ALL
   reported `visibleChange:false`, done is refused and the journal names the
   recovery path. Then the T3 resize proof: the transformation must survive a
   480px viewport vs a captured narrow baseline; new narrow-viewport issues →
   undo the last act and refine (breaker-capped).
3. **giveUp** — unverified acts roll back; verified work disposition applies.
4. **Tool dispatch** — restricted mode (act reserve reached, 2 no-info
   observations, or ⅓ budget left) refuses observation tools structurally.
   `askUser` (control) pauses the loop and round-trips the popup.
5. **Pre-act** — forced `checkLayout` baseline capture (stateless issues are
   baseline-diffed, so the site's own defects are never blamed on us); narrow
   baseline captured once before the first layout-affecting act.
6. **Act gates (in-tool)** — F1 identity guard (selector → live element,
   fail-closed; the stylesheet contract for multi-match cascade intents),
   responsive gate (fixed-px layout dominance refused), motion gate (layout-
   property transitions refused), reduced-motion auto-wrap for motion sheets.
7. **Emission** — USER-origin sheet; every rule's computed style is measured
   before/after (`perSelector`); if ANY rule was defeated, the whole sheet is
   re-emitted with `!important`; `assertApplied` waits out active transitions.
8. **Effect feedback (R1)** — `visualEffect`: stride-sampled text leaves
   (cap 8) + layout containers (cap 24), compared before→after on geometry
   (move/resize > 8px), visibility, paint (color/bg), type — one honest line:
   `VISIBLE — 5 resized, 3 moved…` or `NO VISIBLE CHANGE — … call findElements
   …`. The journal always shows it, plus `rules defeated by page styles: …`.
9. **Forced post-act checkLayout** — new issues → auto-undo the act;
   circuit breaker at 2 consecutive undos → honest gaveUp with rollback.
   R3d exception, before any undo: when the ONLY new issues are
   invisible-text failures on a CSS sheet, ONE bounded contrast recovery runs
   (`agent/recover.ts`) — a targeted model call carrying the structured
   evidence (element, measured ratio, fg, bg), a repair through the same
   `applyCss`, verification against the pre-act baseline. Repaired → both
   sheets stay live and the act counts as clean; not repaired → the repair is
   removed and the standard undo path follows. Hard bound: one recovery per
   run (a never-reset flag), so primary → repair → repair is impossible.
10. **Convergence guard (R2)** — 2 consecutive no-visible-change applyCss acts
    → escalating journal note (re-scope or giveUp).
11. **Terminal disposition** — `disposeTerminalRun`: verified-clean work is
    KEPT when the model becomes unreachable; unverified acts roll back.

## 5. Budgets and constants (single source: `src/core/config`, `loop.ts`)

| constant | value | role |
|---|---|---|
| maxSteps | 80 | runaway ceiling, not governor |
| maxWallMs | 300,000 | runaway ceiling |
| callTimeoutMs | 60,000 | per model call (sized for uncapped completions) |
| maxCompletionTokens | null | NO artificial output cap (user decision); provider default applies |
| ACT_RESERVE_MS | 12,000 | wall reserved for acting (tool restriction, not timeout shrink) |
| MIN_TURN_MS | 5,000 | below this no turn can complete — break |
| MAX_CHECKLAYOUT_UNDOS | 2 | integrity circuit breaker |
| NARROW_WIDTH | 480 | resize-proof viewport |
| MAX_JOURNAL_CHARS | 8,000 | journal section of the prompt (`[TRUNCATED]` flagged) |
| reasoning_effort | low (GLM models) | per-turn |
| R0 overrides | `revueon_model_override`, `revueon_reasoning_effort`, `revueon_max_tokens` (chrome.storage) | benchmark without rebuild |

## 6. Observation and evidence

- `describePage` (the default first call): ≤60 semantic regions
  (id/role/type/selector/textSample ≤80 chars/position/targetable+reason) +
  the DESIGN snapshot — palette, type, spacing, surface in ≤600 chars,
  4–30 ms. Sampling: body/html canvas + 3 elements per role + ≤40 regions.
- `findElements`: resolve a model-named selector (≤10 matches, confidence,
  targetability). `readText`: capped, redacted element text.
- `perceivePage`: level-4 deep perception (outline tree walking shadow roots,
  color model, density, spatial model, surface/elevation, CSS vars, media,
  landmarks, interactive), 6s walk budget, 24k serialize ceiling, 8k tool
  result. Expensive — the prompt says call it rarely.
- Journal serialization: design snapshot first; regions capped at 15 in the
  prompt; act entries always carry `applied ✓/✗`, the `effect:` line, and
  defeated selectors; askUser answers appear as `user answered: "…"`.
- Rule 14 invariant: production NEVER sends screenshots or page content to a
  model for identification. Origin + path only. Vision is TEST-ONLY.

## 7. Identity, reversal, continuity

- **F1 identity** (src/core/identity*): structural descriptors re-resolved
  at use time against the live DOM — never a stamped attribute. Fail-closed
  on zero/many/wrong-target; identical-twin nth-of-type mitigation; act-time
  fingerprint for setText/insert undo verification; identity digests
  (SHA-256, style-agnostic) persisted for replay re-verification.
- **F3 reversal** (src/core/ops/): every act records its exact inverse BEFORE
  mutating; structural ops record cloned nodes (`textContent` is never a
  valid inverse); on→off→on→off restores the DOM byte-for-byte (proven on
  MDN/Wikipedia/HN); the failure path fires `undoAll` (the old RC3 fix).
- **F4 continuity**: scope = origin + pathname (never query/fragment). CSS
  replays via webNavigation.onCommitted (before first paint) +
  onHistoryStateUpdated (SPA pushState). DOM acts replay from the journal
  with digest re-verification; missing/mismatched targets are reported,
  never silently skipped. The loop itself never replays (single-replay rule).
- **F5 integrity**: checkLayout's 7 checks (overflow, zero-size content,
  invisible text, narrow containers, collapsed main, unreachable/clipped,
  mid-word breaks), baseline-diffed both wide and narrow; contrast scan
  three-tier (BREAKING <2.0 / WARNING <AA), every gradient stop.

## 8. Model transport (src/core/reason/)

Cloudflare Workers AI, OpenAI-compatible `/chat/completions`. `max_completion_tokens`
is sent ONLY when explicitly configured (default: absent — no artificial
cap). HTTP retries (4) for 429/5xx with parsed `retry-after` backoff; a 400
drops params one at a time (reasoning_effort → temperature → response_format).
Parse recovery via `extractJson` (balanced-object extraction). Every failure
is captured (`parseFailures`) with raw output for root-cause classification.
Model-agnostic by construction: one constant + storage override; BYOK is a
settings UI away, not an architecture change.

## 9. What lives where

```
project/src/
├── agent/         loop · prompt · journal (serialization + R2 gates) · budget
├── tools/         observe · act · verify · registry (index.ts) — ALL capabilities
├── core/
│   ├── perceive/  describePage/perceivePage engine (one tool, level 4)
│   ├── design.ts  the DESIGN snapshot builder
│   ├── identity*  F1 target guard · ops/ TransactionLog · persist/ state+digests
│   ├── responsive fixed-px dominance + motion gates · sanitize CSS hygiene
│   ├── reason/    the ONLY model transport · config/ single source of truth
├── shared/color.ts  pure color math (parse, WCAG contrast, gradient stops)
└── entrypoints/  background (brain host) · content (hands + overlay) · popup (face)
```

## 10. Known limits (honest, current)

- The user-side reversal does not restore the original page for
  loop-persisted CSS: popup remove-all leaves the page transformed (R10
  6 Sep: `pageRestoredToOriginal: false`; toggle-off restores 1/9 live).
  The removal path is the remaining product gap — the apply path is healthy
  (toggle-on restores 9/9).
- Live state and replayed state diverge on reload: storage persists every
  applied sheet and the webNavigation replay fires, but the post-reload page
  differs from the pre-reload live page (R10 6 Sep: survivesReload 4/9,
  `finalDiffersFromRemoved: true`). Replay fidelity is the second face of
  the reversal gap.
- Sub-region goals ("only the main content area") can defeat scoping — the
  model acts without calling findElements first and breaks layout → honest
  gaveUp. Cheap lever: landmark hints in describePage region data.
- hn-premium-class open-ended goals end via model timeout, not the model's
  own done — stop-discipline obedience is partial on flash-tier models (R10
  6 Sep: 3 post-verification timeouts in one run; verified work KEPT each
  time — the terminal disposition working exactly as designed).
- Slow model turns (uncapped completions + flash latency) can consume the
  300s ceiling on complex goals (R3 dark-theme evidence; R10: 207s/214s on
  two clean dones).
- Direct tool-call sheets are not persisted — only loop runs persist
  (contract, not a bug; toggle-off is an honest no-op for test-injected CSS).
- The image rule: production never sends screenshots to a model; if visual
  verification is required and no vision model is configured, it is reported
  as a limitation, never silently skipped.

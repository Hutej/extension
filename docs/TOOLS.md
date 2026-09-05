# Revueon — Tool registry

*Complete contract of every tool. The registry is `src/tools/index.ts`; tools
execute in the content script, the background imports the registry to build
the prompt, the loop dispatches via `chrome.tabs.sendMessage {action:'toolCall'}`.
Capabilities compose — a new kind of request needs a new combination, not new
code. Adding a tool: implement in observe/act/verify.ts, register in index.ts;
the wiring audit fails the build on orphans or unlisted tools.*

## Universal result shape

```
{ ok, result?, error?, confidence?, inverse?, truncated?, costMs?, identityDigest? }
```

- Observation returns evidence — never anything that can be applied to a page.
- Action returns confirmation + the exact inverse recorded BEFORE the mutation.
- Every error names an alternative (rule 13): *"selector X matched nothing —
  call describePage to find the current region, then retry"* recovers in one
  step; *"invalid selector"* burns the budget.
- `truncated: true` is REQUIRED whenever a budget clipped a result (rule 12) —
  silent truncation makes the model confidently wrong.

## observe — collect evidence

### describePage  *(the default first call)*
Semantic inventory of the page: ≤60 regions, each `id/role/type/tag/selector/
textSample(≤80ch)/position/width/repeat/targetable|untargetableReason` —
plus the **DESIGN snapshot** (≤600 chars, ms-fast): canvas/bg/text/accent
palette, type scale + families, spacing rhythm/scale/density, surface
language/radii/borders/shadows/gradients. Registers region identities
(fingerprints) for the act-time F1 guard.

### findElements
Resolve a model-named selector: ≤10 matches with confidence, selector, and
targetability. The scoping tool — the prompt routes sub-region goals here.

### readText
Text content of one element (identity-guarded, capped, redacted).

### perceivePage  *(expensive — rarely)*
Level-4 deep perception: outline tree (shadow-DOM aware), color model,
density, spatial model, surface/elevation, CSS vars, scrollables, media,
landmarks, interactive elements. Walk budget 6s; serialize ceiling 24k;
tool result capped 8k (truncated flag).

### inspect / measure — stubs, hidden from the prompt.

## act — scoped, reversible

### applyCss  *(the primary act)*
Args: `{css}`. Pipeline: sanitize (input cap 512k) → parse to structured
rules → F1 stylesheet-contract guard on every selector → responsive gate
(fixed-px layout dominance refused) → motion gate (layout-property
transitions refused) → reduced-motion auto-wrap → emit at USER origin via the
background → measure EVERY rule's computed style (`perSelector`) → if any
rule defeated, re-emit the whole sheet with `!important` → `assertApplied`
(ALL declared longhands, transition-settled). Result carries: `applied`,
`before/after`, `perSelector`, **`textEffect`** (rendered-text truth,
stride-sampled ≤8 leaves) and **`visualEffect`** (the model's eyes — see
below), plus the persisted identity digest of the primary target.

**visualEffect** (R1): stride-sampled text leaves (≤8) + layout containers
(≤24), compared before→after: moved/resized (>8px), hiddenNow, paintChanged
(color/bg), textChanged (font). One honest line —
`VISIBLE — 5 resized, 3 moved, 2 repainted (of 24 sampled)` or
`NO VISIBLE CHANGE — geometry, text and paint all unchanged… Call
findElements on the region…`. Evidence, never a gate: the model reads it and
re-scopes; the loop's done-gate consumes its boolean.

### hide
Args: `{selector}`. `display:none` + heal the gap; default-important sheet;
identity-guarded single target; cloned-node/DOM path when structural.

### insert
Args: `{selector, position: top|bottom|before|after, html}`. Identity-guarded
target; recorded in the TransactionLog with a cloned-node exact inverse;
persisted with digest for reload replay (insert-replay: the digest is captured
BEFORE insertion — the PHASE5 high-severity fix).

### setText
Args: `{selector, text, reason}`. Text-only elements; reason required from a
closed list (summarise/rewrite/translate/…); exact cloned-node inverse.

### heal
Closes the layout gap left by a hidden element (the F5 "a hole is an
unfinished job" rule).

### bindKey / recomposePage — stubs, hidden from the prompt.

## verify — read reality after render

### checkLayout
7 integrity checks: overflow, zero-size content, invisible text, narrow
containers, collapsed main, unreachable/clipped content, mid-word breaks.
Returns capped `issues` + uncapped `allIssues` (baseline-diff fuel),
`warnings`/`allWarnings`, `innerWidth`. Forced around every act by the loop.

### checkContrast
WCAG contrast of a text element vs its background — every gradient stop,
worst-case. Pure math in `shared/color.ts`.

### snapshot / diff
DOM state checksum + comparison.

### assertDomClean
No Revueon traces after toggle off (the F3 proof tool).

## control — handled by the loop, never dispatched to the tab

### undo
Args: `{steps}`. Replays journal inverses, handle-resolved (SPA-safe);
DOM-kind inverses route to the content script's TransactionLog.

### done
Args: `{summary}`. Runs the R2 done-gate (refused when every applyCss act
was a no-op — the journal names the recovery path) and the T3 resize proof
before finishing.

### giveUp
Args: `{reason}`. Honest stop; unverified acts roll back; verified-clean
disposition applies. A clear reason is a valid outcome (rule: low confidence
means do less, not guess more).

### askUser
Args: `{question, options[]}` (≤4 options). The loop pauses; the background
broadcasts to the popup (question + option buttons + free-text box); the
answer returns as a journal evidence line. 120s timeout → the model proceeds
with its best judgment. Headless (no popup): refuses with guidance. For
genuinely-ambiguous requests only — everything resolvable from page evidence
is decided alone. Model-agnostic: a protocol, not a brain feature.

## Prompt-facing guarantees

- One line per tool in the prompt; restricted mode lists act+verify+done/
  giveUp only (structural enforcement, not a request).
- Act entries in the journal ALWAYS show: `applied ✓/✗`, the `effect:` line,
  and `rules defeated by page styles: …` when delivery failed.
- The first turn's reasoning is the user-facing reply; later turns' reasoning
  rides their journal entries.

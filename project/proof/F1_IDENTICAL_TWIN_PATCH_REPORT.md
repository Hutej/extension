# F1 IDENTICAL-TWIN fail-closed patch — report

*A narrowly scoped corrective patch to Phase 4 (F1 IDENTITY). NOT a new phase.
The ONLY problem solved: when Revueon's structural identity cannot distinguish
two genuinely identical sibling elements, it must FAIL CLOSED — refuse to act
rather than guess (pick-first / trust `nth-of-type`). The Phase-4 adversarial
review named this an irreducible limitation; this patch turns it from a
documented limitation into an enforced refusal.*

> The correct claim, and the ONLY claim this patch makes: **when the current
> identity evidence cannot distinguish the target from an identical twin,
> Revueon now refuses to act rather than guessing.** It does NOT claim structural
> fingerprints can solve the fundamental identical-twin problem — they cannot.

---

## 1. Problem

Two genuinely identical siblings share a structural fingerprint. A positional
selector (`:nth-of-type(k)`) resolves to exactly one of them with that
fingerprint. A DOM reorder silently reroutes the selector to the *other* twin,
which has the *same* fingerprint — so a bare fingerprint-verify PASSES and the
WRONG twin is mutated. This is the exact attack the Phase-4 review identified
and called irreducible.

## 2. Existing Phase 4 behaviour

Phase 4's `resolveTarget` already fail-closed on **zero / many / wrong-target**
(fingerprint differs). It did NOT close the **identical-twin** case: a selector
matching exactly one element whose fingerprint matched the observe-time
fingerprint → `ok` — even when another element on the page shared that
fingerprint. The `many` refusal only fires when the *selector* matches >1; the
twin case is *selector matches exactly 1 + duplicate fingerprint elsewhere*.

## 3. Root cause

`resolveTarget` verified *this selector resolves to one element whose
fingerprint matches the observed one* — but identity is "is this the element I
meant," not "does this selector happen to resolve to something with the right
fingerprint." A reorder makes the selector resolve to a *different physical
element* that *also* has the right fingerprint. The fingerprint-verify alone
cannot tell the two apart. The Phase-4 report named this and stopped at
"documented limitation"; this patch enforces the refusal.

## 4. Archive findings

A background search of `archive/` (per the spec's archive rule):
- **No prior art fails closed on a non-unique fingerprint.** Every archived
  resolution was first-match `querySelector` (fail-open) or `Map.set` last-wins.
- The archive's RC4 root-cause (`08_ROOT_CAUSE_ANALYSIS.md`) names fingerprint
  non-uniqueness as a real defect, but its documented remedy was "make
  fingerprints unique / lengthen the path" — the *opposite* philosophy
  (disambiguate) to this patch (refuse-when-not-unique).
- `transaction.ts` (by-handle undo) and `selectorIsUnique` (solve.ts) are the
  reusable seams; neither checked fingerprint uniqueness. **REJECTED** the
  archive's disambiguation philosophy; **ADAPTED** the central-resolution-point
  seam (the fix lives in the current `resolveTarget`, exactly as the spec says).

## 5. Exact fix

One new refusal, added inside the existing `resolveTarget` in
`core/identity.ts` (the single authoritative identity decision — no second
system):

```
resolveTarget(dom, selector, expectedFp):
  zero / many            -> refuse (zero / ambiguous)        [existing, unchanged]
  exactly-one match:
    liveFp = fingerprint(el)
    if !isUniqueInFlippableSet(el, liveFp, selector, dom):   [NEW]
      -> refuse, reason 'indistinguishable-twin'             [NEW]
    if !expectedFp:       -> ok, reason 'unverified'         [existing]
    if liveFp != expectedFp -> refuse (wrong-target)         [existing]
    -> ok, el                                             [existing]
```

- **`isUniqueInFlippableSet`** (new): the "flippable set" = the selector with
  positional pseudo-classes stripped (`:nth-of-type/:nth-child/:nth-last-*`/
  `:first|last|only-*`, **all `an+b` forms** — see finding #3). It is the set of
  elements a sibling/div reorder could route the selector to. Count how many
  elements in that set share `el`'s fingerprint; if >1 (the target itself +
  a twin), it is NOT unique → refuse. Excludes Revueon-inserted nodes
  (`[data-revueon-inserted]`).
- The twin check runs **before** the unverified branch, so the `unverified`
  path cannot be a twin bypass (finding: the unverified path on a twin must
  also refuse).

## 6. Why the fix is fail-closed

- On a non-unique fingerprint, `resolveTarget` returns `{ok:false,
  reason:'indistinguishable-twin'}` — mutate NEITHER twin.
- The act tools' `guardTarget(selector)` calls `resolveTarget` and returns the
  refusal **before** any mutation: no CSS inserted, no `textContent=`, no
  `insertAdjacentElement`, no `recordStructural`. Verified on the live browser
  path (cases 7g/7h: neither twin's `display` changed; no card is `display:none`).
- The undo path runs the SAME `resolveTarget` (finding #1 fix) — a refused undo
  throws, counted as `failed`, clone NOT applied to the wrong twin.

## 7. Tests

Two files extended (NOT rewritten — existing F1 cases untouched):
- `tests/f1-identity-test.ts` — **32/32** pure (was 18; +14 twin/undo cases).
- `tests/f1-identity-browser-test.ts` — **32/32** real Chromium (was 17; +15
  twin/reorder/control cases through the real act path).

New cases (each with a control, per rule 15):
1. **TWIN-REFUSE**: identical siblings → refuse (`indistinguishable-twin`).
2. **TWIN-REORDER** (the attack): observe A, reorder → B at the selector,
   fp(B)==fp(A) → REFUSE (not accidental pass). Pure + browser.
3. **UNVERIFIED-on-twin refuses**: no twin bypass via the unverified path.
4. **UNDO-TWIN** (finding #1): the act *creates* a twin (setText A→"B"), reorder
   reroutes the undo → refuse (clone NOT applied to wrong twin; the mutated node
   untouched). Control: distinct siblings undo normally.
5. **CONTROL distinct siblings act**: distinct-text cards still act (no over-refuse).
6. **CONTROL id-anchored unique with twins elsewhere**: an id-anchored selector
   is its own flippable set of size 1 → never trips on twins elsewhere.
7. **EXISTING many-match intact**: bare selector matching both → still `ambiguous`.
8. **Formula twins** (finding #3): `:nth-of-type(-n+1)` / `0n+1` / `nth-last-of-type`
   twins refuse (stripPositional must strip `an+b`, not just `\d+`).
9. **Real act guard path**: hide on a twin → `guardTarget` refuses → no CSS, no txn.

## 8. Real-browser evidence

`proof/f1-identical-twin-result.json` — every field derived from actual test
runs, not hand-rolled. The browser probe read the live cards directly:
- selector: `main#main > article:nth-of-type(1)`
- stripped flippable set: `main#main > article`, **count 2**, both `Twin card text`
- refusal: `ok:false`, reason `indistinguishable-twin`
- mutation count: 0 — before `["block","block"]`, after `["block","block"]`
- transaction count: 0 — no card is `display:none`
- reorder attack: observe A → swap → act → REFUSE, both cards display+text unchanged

No real-site test was run: the spec allows a synthetic fixture when no real site
can reliably create the identical-twin condition, and altering a real site to
manufacture it would make the test unreliable. This limitation is stated honestly
(`proof/f1-identical-twin-result.json`).

## 9. Adversarial review

A RUNNER/SKEPTIC/ARITHMETIC 3-agent review (9 agents: 3 reviewers + 5 verifiers
+ synthesis) against the real code. **6 findings raised, 5 confirmed**, most-
severe first.

### 10. Runner findings
- **#1 (MAJOR, was stillBroken → FIXED by me): undo verify skipped the twin
  check.** `applyInverse` (setText) did a bare `querySelector` + fingerprint
  compare and never ran `isUniqueInFlippableSet`. The act can *create* a twin
  (setText A→"B" makes A and B identical); a reorder reroutes the undo to B
  (fp(B)==act-fp) → the bare verify PASSES → the clone restores onto the WRONG
  twin (B corrupted; the mutated A left unrestored). **Fix (applied):**
  `applyInverse` now runs the SAME `resolveTarget` guard via a new
  `DomAdapter.identityDom()` accessor — one authoritative decision for both the
  act and undo paths, catching zero/many/wrong-target AND twin. Proven by the
  new undo-twin pure case (clone NOT applied; mutated node untouched) + control
  (distinct siblings undo normally). The verifier deliberately declined this
  fix (it crosses into the undo path); I assessed it as in-scope ("directly
  necessary to make the identical-twin invariant hold on the undo path too"
  — acceptance criteria 3 & 5) and applied it.
- **#2 (MINOR, FIXED by verifier): `hide`'s healing CSS selectors bypassed
  `guardTarget`.** `applyHealing` builds positional `:nth-of-type(k)` sibling
  selectors that were emitted UNGUARDED; a reorder reroutes a healing selector
  onto the wrong twin via the cascade. **Fix:** `hide` now parses the full
  sheet (hide + healing), guards every comma-part via `guardTarget`, and DROPS
  any healing rule whose selector refuses (keeping the already-guarded primary
  hide). Fail-closed; reuses existing `parseCss`/`serializeEmit`/`guardTarget`.

### 11. Skeptic findings
- **#3 (MAJOR, FIXED by verifier): `stripPositional` missed formula positionals.**
  `:nth-of-type(\d+)` only matched integer forms; `:nth-of-type(-n+1)`,
  `0n+1`, `2n+1`, `odd`, `even`, `:nth-last-of-type(-n+1)` were left UNSTRIPPED
  → the flippable set collapsed to size 1 → the twin vanished from the set →
  false unique → wrong twin mutated. **Fix:** the four regexes now use
  `\(([^)]*)\)` to strip every `an+b` form. Proven by 3 new rule-15 formula
  twin cases (verified they go red when the regex is reverted to `\d+`).

### 12. Arithmetic findings
- **#4 (MAJOR, FIXED by verifier): dangling-combinator relaxed selector throws
  → live adapter swallowed → twin guard bypassed.** A relaxed selector like
  `main#main > :nth-of-type(1)` left a dangling `>`; `querySelectorAll` threw;
  the catch returned `true` (unique) — a twin bypass. **Fix:** the malformed-
  selector branch now fails closed (returns false) instead of fail-open.
  Attack probe returns `indistinguishable-twin` post-fix (was `ok:true` pre-fix).
- **#5 (MINOR, FIXED by verifier): FNV-1a hash truncated to ~28 bits.**
  `.padStart(7).slice(0,7)` dropped the top nibble to 28 effective bits, making a
  false twin-negative (two distinct long texts treated as identical → false
  refuse) plausible with no `truncated:true` signal. **Fix:** keep all 8 hex
  chars (full 32-bit FNV-1a) — 16× larger collision space, one-char cost.

No findings were refuted after verification; the RUNNER's #1 was the only one
left `stillBroken` by its verifier, and I fixed it (above).

## 13. Remaining limitations

- **Identical twins are still indistinguishable** — that is irreducible. This
  patch does NOT make them distinguishable; it refuses to act. The model/user
  must give a distinguishing anchor (id/data-testid/role/aria-label) or target a
  uniquely-containing parent.
- **Secondary CSS selectors** (a multi-part comma rule where only the primary
  is verified) — `applyCss` already guards all selectors; `hide`'s healing
  path now does too (finding #2). A full secondary-selector guard across every
  emit site remains a Phase 7 (RESTYLE) concern.
- **No real-site capstone** — a synthetic fixture is used (spec-permitted); no
  real site can reliably create the identical-twin condition without altering it.
- **`shortHash` is still a hash** — 32-bit FNV-1a makes a false twin-negative
  astronomically unlikely but not impossible (no `truncated:true` signal for a
  collision). A future phase could use a longer hash if a real collision appears.

## 14. Phase 5 was NOT touched

Explicitly NOT implemented: persisted fingerprints, replay fingerprints,
reload identity, SPA persistence, origin/path persistence, first-paint replay,
route-change persistence, F4 continuity. The re-apply `unverified` path
(Phase-4 open question 3) is owned by Phase 5 and was NOT pulled forward. The
undo path now uses `resolveTarget`, but with `expectedFp = inv.fingerprint`
(the act-time fp, already stored in the txn log) — NO new persistence.

## 15. Parse-death work was NOT touched

Explicitly NOT implemented: parse retries, model-JSON reliability, budget
exhaustion handling, Cloudflare model-output work, Phase 6 reliability. The
known parse-death wall is unchanged.

## 16. Files changed

```
project/src/core/identity.ts        +125  (resolveTarget twin check, isUniqueInFlippableSet,
                                            stripPositional [an+b fix], shortHash [32-bit fix],
                                            indistinguishable-twin reason + rule-13 error,
                                            IdentityDom.fingerprintOfRef)
project/src/core/identity-dom.ts       +5  (liveIdentityDom.fingerprintOfRef)
project/src/core/ops/txn.ts          +12/-18 (applyInverse uses resolveTarget via
                                            DomAdapter.identityDom(); import .ts)
project/src/core/ops/liveDom.ts        +4  (liveDom.identityDom())
project/src/tools/act.ts             +36   (hide healing-selector guard, finding #2)
project/tests/f1-identity-test.ts    +276  (14 new twin/undo cases + fakeAdapter.identityDom)
project/tests/f1-identity-browser-test.ts +168 (15 new twin/reorder/control cases)
project/tests/ops.test.ts            +33   (fakeDom.identityDom for the undo resolveTarget)
```

## 17. Net line-count change

- **src:** +178 / −24 → **net +154** (the patch + the undo-path unification)
- **tests:** +473 / −4 → **net +469** (the proof)
- **proof:** +151 / −6 (regenerated artifacts — `phase2.5-review-regression.json`
  randomized its `target=#rva…` handle on re-run; only that string changed, all
  `pass:true`/`MATCH` results identical; not a code change)

## 18. DONE / NOT BUILT / DEFERRED

**DONE** — all 12 acceptance criteria:
1. Genuine identical twins detected as identity ambiguity. ✓
2. Refuses to mutate an indistinguishable twin. ✓
3. Reordering identical twins cannot silently redirect an action (act + undo). ✓
4. The real act path respects the refusal. ✓
5. No mutation after the refusal (display unchanged, no CSS, no txn entry). ✓
6. No transaction inverse recorded when no mutation occurred. ✓
7. Existing zero-match and many-match refusal intact. ✓
8. Legitimately distinguishable elements still work. ✓
9. Refusal reason explicit and actionable (names an anchor/parent, NOT nth-of-type). ✓
10. No nth-of-type/index guessing introduced. ✓
11. No second identity system (one `resolveTarget`, now shared by act + undo). ✓
12. No Phase 5/F4 functionality implemented. ✓

**NOT BUILT:** a real-site twin capstone (no real site reliably creates the
condition; spec-permits a synthetic fixture). A future disambiguator (the
spec forbids it in this patch). Secondary-selector guarding beyond hide/applyCss.

**DEFERRED (explicitly, per spec):** Phase 5 (F4 continuity), the parse-death
wall (Phase 6), a longer `shortHash` (only if a real collision appears), a
full secondary-selector guard (Phase 7 RESTYLE).

**Proof:** `project/proof/f1-identical-twin-result.json` (real execution data).
**Test artifacts:** `proof/f1-identity-test.json` (32/32), `proof/f1-identity-browser-test.json` (32/32).

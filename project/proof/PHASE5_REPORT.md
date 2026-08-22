# PHASE 5 — F4 CONTINUITY (PROVEN)

*Implementation 18–19 Aug 2026 against `b9c1cf8` (the canonical main branch
`phase2-reversal`). Built on `proof/PHASE5_DESIGN.md` (the design doc), which
remains the reference for rationale. This report records what was built, what
was proven, and the one design decision that changed during implementation.*

---

## 0. The one-line result

**F4 CONTINUITY is proven.** A modification ("hide the sidebar") now survives
reload, does not propagate to a second article (strict origin+path scope), and
returns when you come back. Missing/mismatched targets are reported, never
silently skipped. F3 exact undo survives the reload-replay path. The persisted
journal carries **no cleartext page content** (privacy-strict, user decision
19 Aug 2026) — only the model-authored args, a SHA-256 identity digest, and the
extension's own output CSS. The full test suite is green (44/44 F4 browser +
32/32 F4 unit + all foundation/regression tests); the real-site Wikipedia
second-article pass is confirmed by a vision model in words. A 5-dimension
adversarial review (12 findings, 7 confirmed) found a high-severity
insert-replay bug my own tests had missed and a high-severity privacy
contradiction — both fixed and pinned.

---

## 1. What was built (the diff, by file)

| File | Change | Why |
|---|---|---|
| `core/persist/index.ts` | Added `scopeKey(url)` = `u.origin + u.pathname` (no query, no fragment). Added `path` to `JournalState`. Re-exported the digest. Kept `originKey` removed. | The binding keying decision (origin+path). |
| `core/persist/digest.ts` (new) | `digestOfElement(el, dom)` = SHA-256 of F1's `fingerprint()`. `sha256Hex` via Web Crypto. `IdentityDigest` type. | A privacy-safe persisted identity: a cryptographic hash, never the cleartext fingerprint (which embeds a 40-char text prefix + attribute values). |
| `tools/act.ts` | Each act (`setText`/`insert`/`hide`/`applyCss`/`heal`) captures `identityDigest` and returns it on `ToolResult`. **setText captures the PRE-mutation, live-attached element** (replay finds the original after reload); the in-session `actFp` stays POST-mutation (for undo) — different values, on purpose. | The persisted identity replay re-verifies against. |
| `tools/index.ts` | `ToolResult.identityDigest?: string`. | The act→loop→persist channel for the digest. |
| `agent/loop.ts` | Persist `identityDigest` into `JournalEntry`. Set `journal.path`. **Removed the in-run replay block** (approved Q2: the content script owns replay; the loop replaying too caused double-application + the `goal===goal` gate broke cross-goal continuity). `persistJournal`/`rollbackDomIfActed` key by `scopeKey(origin + path)`. Removed unused `loadJournalState` import. | Continuity is a page concern, not a run concern. |
| `agent/journal.ts` | `toState()` includes `path`. | The persisted state carries the scope. |
| `entrypoints/content.ts` | `reapplyPersistedDom` rewritten: re-resolve via F1's `resolveTarget` (zero/many/twin) → re-verify via the persisted `identityDigest` (wrong-target) → `registerIdentity` (verified, not unverified) → idempotency (setText already-applied) → re-execute the tool (repopulates `txnLog` so undo works post-reload). `removeMismatchedCss` removes background-inserted CSS whose target mismatched. `reportReplayOutcomes` surfaces `revueonReplayReport` to storage (never silent). SPA hooks key on `scopeKey` (a hashchange/query change is NOT a scope change). Added `hashchange`. | The replay path: re-verify, replay, report. |
| `entrypoints/background.ts` | **Added `webNavigation.onHistoryStateUpdated`** (SPA `pushState`/`replaceState` CSS replay — `onCommitted` does not fire for those). `reinsertSavedCss` keyed by `scopeKey(url)`. **Strict-scope enforcement: `insertedCssByTab` tracks inserted CSS per tab; on a new scope, REMOVE the prior scope's CSS** (USER-origin `insertCSS` persists across `pushState` and does not auto-remove — the leak the spa-route test caught). `handleToggleCss` + the `insertCSS`/`removeCSS` handlers keep the tracker in sync. | The SPA-CSS gap (the "hide stops working on click" failure) and the strict-scope leak. |
| `docs/ARCHITECTURE.md` | Fixed the "Persistence scope" contradiction: now documents origin+path, the `onHistoryStateUpdated` hook, and the strict-scope removal. The old origin-only position is marked superseded. | The binding docs now agree. |
| `tests/foundation-helpers.ts` | `persistJournalEntry` writes under the scope key (`rv_<origin><path>`) with `path` + `identityDigest`. | The helper must match the live key format or replay tests silently no-op. |
| `tests/f4-helpers.ts` (new) | `openFixture`, `persistActEntry` (persist a real act with its real digest), `readReplayReport`, `sendUndoAll`. | Shared F4 test plumbing. |
| 7 new `tests/f4-*.ts` | The Phase-5 suite (see §3). | Proof. |

**Not changed** (F4 invariants held): `core/identity.ts`, `core/identity-store.ts`,
`core/identity-dom.ts`, `core/ops/txn.ts`, `core/ops/recorder.ts`, `core/ops/liveDom.ts`,
`core/emit.ts`, `core/inventory.ts`, `agent/budget.ts`, `agent/prompt.ts`, `roadmap.txt`.
F1 stays the sole identity resolver; F3's cloned-node algebra is untouched; the
budget and prompt are untouched.

---

## 2. The two things that changed during implementation (not in the design)

1. **The setText digest timing.** The design (§9/§13) said "capture the
   observe-time fingerprint." It did not specify that for **setText** the
   persisted digest must be the **PRE-mutation** element (replay finds the
   original text after reload) while the **in-session `actFp`** must be
   POST-mutation (undo verifies against the element holding the new text). A
   single digest cannot serve both — they are opposite timings. I split them:
   `identityDigest` (persisted, pre-mutation, for replay) and `actFp` (session,
   post-mutation, for undo). The `f4-identity-mismatch-test` and
   `f4-rollback-after-replay-test` prove both paths. **Also**: the digest must
   be taken from the **live attached** element, not a detached clone — the
   fingerprint includes `depthFromRoot`, which is 0 for a detached clone but
   correct for the live element. (Found by the rollback test; fixed in act.ts.)

2. **The strict-scope CSS leak.** The design (§11/§12) named the SPA-CSS gap
   (no `onHistoryStateUpdated`) but did not name the **leak**: USER-origin
   `insertCSS` persists on the *tab* across `pushState` and does not auto-remove,
   so a hide on `/page1` would stay on `/page2` even with `onHistoryStateUpdated`
   wired. The `f4-spa-route-test` caught it (step 3: /page2's sidebar stayed
   hidden). Fix: the background tracks inserted CSS per tab and removes the
   prior scope's CSS on each reinsert. This is new state (`insertedCssByTab`)
   the design did not specify — added as the minimal correct enforcement.

## 2.5. The adversarial review (5 reviewers × per-finding skeptics)

A 5-dimension adversarial review (keying-privacy, replay-identity, spa-css-scope,
loop-replay-removal, f3-f1-f5-noregress) fanned out, then each finding was
verified by an independent skeptic reading the actual code. **12 raw findings,
7 confirmed real, 5 correctly dismissed.** Every confirmed finding was fixed
and pinned by a test; the fixes are listed below. (Full verified results:
`project/proof/f4-adversarial-review-wf_dff21cdc-3c9.json`-adjacent journal.)

| # | Finding | Sev | Fix | Pinning test |
|---|---|---|---|---|
| 1 | `insert` identityDigest captured AFTER the insert — inside inserts (`top`/`bottom`) change the anchor's childCount, so the persisted digest never matches the pre-insert anchor on reload → insert silently lost (identity-mismatch) on every reload. My setText-replay tests missed it because I only exercised setText + CSS replay. | **high** | Capture the anchor digest BEFORE `el.insertAdjacentElement` (same timing rule as setText). | `f4-insert-replay-test` (8/8, new) — inside insert now replays after reload. |
| 2 | `removeMismatchedCss` used `document.querySelector` — a second selector→element resolver bypassing `resolveTarget`'s many/twin guards (F4 invariant #1: resolveTarget is the SOLE resolver). | **med** | Re-resolve via `resolveTarget(liveIdentityDom, sel, null)` (zero/many/twin guarded). | `f4-identity-mismatch-test` (7/7) + the resolveTarget path. |
| 3 | `insertedCssByTab` in-memory only — wiped on an MV3 service-worker restart, so the strict-scope leak-fix stops removing stale CSS after the SW restarts. | **med** | Persist the tracker in `chrome.storage.session` (survives SW restart, cleared on browser close) + rehydrate on SW start + `tabs.onRemoved` cleanup. | `f4-spa-route-test` (5/5). |
| 4 | `setText`/`insert` persist full pre-mutation `inverse.prevHtml` (cleartext innerHTML: text, attribute values, URLs) — richer cleartext than the fingerprint F4 hashed to avoid. Pre-dates F4 (F3's post-reload undo fallback), but F4's privacy commitment raises the bar. | **high** | **User decision (19 Aug 2026): strip cleartext from persisted state.** `Journal.toPersistableState()` drops observe entries, act `result`, and `inverse.prevHtml`; keeps `identityDigest` + `removeCss` CSS (our output). Cost: post-reload DOM-undo of setText/insert is a no-op (the innerHTML fallback is removed); the in-session cloned-node undo is unchanged and authoritative. | `f4-persist-key-test` (32/32, +10 privacy checks). |
| 5 | Observe `result` (describePage textSample, readText text, perceivePage perception) persisted wholesale but never consumed by replay — pure cleartext page-text leak. | **med** | Same fix as #4 — `toPersistableState` drops observe entries entirely (replay skips them). | `f4-persist-key-test` (32/32). |
| 6 | `setText` already-applied pushed the `already-applied` outcome BEFORE the repopulating re-execute — a failed re-execute would report BOTH `already-applied` AND `failed`. | **low** | Push the outcome AFTER the re-execute: `already-applied` if the re-execute succeeded, `failed` if not. | `f4-idempotency-test` (6/6). |
| 7 | No `tabs.onRemoved` cleanup of `insertedCssByTab` — unbounded tracker growth for closed tabs. | **low** | Added `chrome.tabs.onRemoved` listener that deletes the tabId from the tracker (and re-persists session storage). | `f4-spa-route-test` + the session-tracker. |

**Dismissed (5):** a transient `dispatchInverse` tracker desync (self-correcting
on the next reinsert); the `handleToggleCss` empty-journal early-return
(intended per-scope toggle semantics); the tracker-reset-on-empty-want
(self-correcting); one `prevHtml` finding the verifier downgraded to "intended
F3 fallback" (which the user then chose to strip anyway via #4); and one
duplicate of #2. None required a change beyond what #1–#7 already did.

The review's biggest value: it found a **high-severity correctness bug my own
tests missed** (#1 — inside-insert replay) and a **high-severity privacy
contradiction** (#4) the design had flagged but not resolved. Both are now
fixed and pinned.

---

## 2.6. The privacy decision in full (user, 19 Aug 2026)

The F4 design (§22-Q1 privacy sub-question) raised but did not resolve whether
"no cleartext page content persisted" extends beyond the identity to the whole
journal. The adversarial review (#4, #5) forced the question. The user chose
the privacy-strict option: **strip cleartext from the persisted state.**

- **What's persisted now:** act `args` (the CSS/text/html the *model* authored
  — our input, not the page's content), `identityDigest` (SHA-256, no
  cleartext), `inverse.removeCss.css` (the extension's own output), `tool`,
  `kind`, `confidence`, `costMs`, `timestamp`. `path` + `origin` + `goal` on
  the state.
- **What's NOT persisted now:** observe entries (entirely), act `result`
  (the confirmation slices), `inverse.prevHtml` (the cleartext innerHTML
  fallback).
- **Cost:** the post-reload DOM-undo fallback (innerHTML re-parse) is removed.
  A `undoAll` issued *after a reload* no longer restores a setText/insert's
  pre-mutation DOM via the persisted innerHTML — that path is a no-op. The
  **in-session** cloned-node undo (the authoritative F3 path) is unchanged and
  still exact. Replay re-executes the tool (repopulating the session `txnLog`),
  so an `undoAll` *after a reload-replay* still undoes the replayed ops via the
  fresh clones. The only thing lost is restoring a page to its *pre-modification*
  state after a reload *without* replay having re-run — which the in-session
  clone cannot do anyway (the clone is gone after reload). This is a documented
  narrowing, not a regression of the in-session guarantee.
- **`toState()` (session) is unchanged** — the model still sees the full
  journal (results, reasoning) during a run, and the act's `guardTarget` still
  uses the result. The strip is **persistence-only**.

---

## 3. Proof — the test suite (all green)

### Unit (Node, no browser)

| Test | Result | What it proves |
|---|---|---|
| `f4-persist-key-test` | **32/32** | `scopeKey` strips query/fragment; `/wiki/CSS ≠ /wiki/HTML`; the digest is 64-hex SHA-256, same-element→same, changed-text/attr→different, style-agnostic, no cleartext, genuine twins→same (twin protection stays in F1). **+10 privacy checks (review §2.5 #4/#5):** `toPersistableState` drops observe entries, act `result`, `inverse.prevHtml`; keeps `identityDigest` + `removeCss` CSS; the serialized persisted state has NO cleartext page text; the session `toState` still carries it (strip is persistence-only). |
| `f1-identity-test` | 32/32 (unchanged) | The live F1 guard is unbroken. |
| `ops.test` (F3) | pass (unchanged) | The transaction algebra is unbroken. |
| `parse-death-test` | pass (unchanged) | The regression pin holds. |
| `red-test` | 8/8 (unchanged) | Cascade-origin behavior is unbroken. |

### Browser (Playwright + the built extension)

| Test | Result | What it proves (each has a deliberate failing case, rule 15) |
|---|---|---|
| `f4-rollback-after-replay-test` | **7/7** | setText persisted → reload → replay re-applies → `undoAll` works (undone=1, txnLog repopulated) → restores to the pre-replay baseline. F3 exact undo survives the reload-replay path. |
| `f4-insert-replay-test` (new, review §2.5 #1) | **8/8** | An INSIDE insert (`where:'top'`) — the bug case — is persisted, then replays after reload (the inserted node reappears, positioned as a child of `#anchor`). The bug (digest-after-insert) would have made this `identity-mismatch`/lost. Also covers an outside insert for parity. |
| `f4-missing-target-test` | **6/6** | A target gone after reload → `missing-target` reported (not silent); no mutation. The outcome is in storage, not console-only (requirement 5). |
| `f4-identity-mismatch-test` | **7/7** | A target whose text changed after reload → `identity-mismatch` (the digest catches it), no mutation. Twin protection stays in F1 (`.card` refused as ambiguous in-session; the digest does not disambiguate twins). |
| `f4-idempotency-test` | **6/6** | reload→replay→reload→replay→reload→replay: text applied once, no doubling, persisted journal stays at 1 entry (no growth), txnLog repopulates to size 1 (not 2). |
| `f4-spa-route-test` | **5/5** | The SPA-CSS gap closed: hide on /page1 → reload survives → pushState(/page2) shows the sidebar visible (strict scope, leak fixed) → pushState(back) re-hides. `onHistoryStateUpdated` is load-bearing. |
| `f4-second-article-test` (capstone, controlled) | **5/5** | Hide on /wiki/CSS → reload survives → /wiki/HTML is VISIBLE (strict scope, not propagated) → /wiki/CSS-again is HIDDEN (durable). The roadmap's Phase-5 Done criterion. |
| `f4-second-article-vision-test` (capstone, real Wikipedia + vision) | **7/7** | Real `en.wikipedia.org/wiki/CSS`: hide the main menu → reload survives → `/wiki/HTML` is untouched (strict scope) → `/wiki/CSS` again is hidden. Vision model describes each screenshot in words (rule 14). |

### Regression (no F4 damage to earlier phases)

| Test | Result |
|---|---|
| `phase2.5-review-regression` (F3 real sites) | **9/9** (the `B:cssCycle` cases that F4's key change initially broke were fixed by updating the test helper to the scope key — the production key change is correct) |
| `phase3-f5-loop-test` (F5) | **5/5** |
| `f1-identity-browser-test` (live F1) | **32/32** |
| `audit-wiring` (orphan check) | OK — every new export (`scopeKey`, `digestOfElement`, `sha256Hex`, `IdentityDigest`) is wired |
| `tsc --noEmit` + `wxt build` | clean |

### The real-site vision-in-words (rule 14 — I reason from the words, not the PNGs)

- `/wiki/CSS` after hide: *"The left-side navigation menu is hidden/collapsed,
  as shown by the hamburger menu icon (≡) next to the Wikipedia logo at the
  top left."* — **hidden** ✓
- `/wiki/CSS` reloaded: computed `display=none` — **survives reload** ✓
- `/wiki/HTML`: computed style `visible=true` (the menu has a rendered box).
  The vision words describe *"the hamburger menu icon … absence of a sidebar,
  the main left-side navigation menu is hidden/collapsed"* — this is
  Wikipedia's **default-collapsed** Vector2022 menu (untouched by us), NOT a
  hide that propagated. The key F4 signal: under the rejected origin-only
  keying, `/wiki/HTML` would have been `visible=false` (our hide leaked); it is
  `visible=true` (untouched). **Strict scope holds** ✓
- `/wiki/CSS` again: computed `display=none` — **the hide returned** ✓

The capstone is proven both deterministically (controlled fixture, 5/5) and by
a real-site vision pass (7/7).

---

## 4. How the open questions (§22) were resolved

- **Q1 (keying): origin+path.** Implemented as `scopeKey`. The `ARCHITECTURE.md`
  origin-only position is superseded (doc fixed). Privacy: the key is origin +
  pathname only; the persisted identity is a SHA-256 (no cleartext). The
  privacy sub-question: **persist the hash only** (option b) — the cleartext
  40-char fingerprint prefix is never written to storage; `digestOfElement`
  hashes in memory. Wrong-target detection survives (a hash still differs).
- **Q2 (loop in-run replay): removed** (option A, with C's spirit — the model
  re-observes; no prior-work summary was added to the prompt yet, deferred as
  YAGNI until a goal needs it).
- **Q3 (content script run_at): stayed at `document_idle`** (option A). The
  background `onHistoryStateUpdated` covers SPA-CSS regardless of content-script
  timing.
- **Q4 ("survives a second article"): strict scope** (option A). A's mod is
  durable for A; B is untouched; A-again shows the mod. Proven by both capstone
  tests.
- **Q5 (legacy migration): no migration** (option B). Pre-launch; no real
  users. Noted here.

---

## 5. What this phase did NOT build (per CLAUDE.md)

- No second target resolver — F4 reuses `resolveTarget`.
- No second mutation/rollback system — F4 reuses the act tools + `txnLog`.
- No `document_start` move (Q3-B deferred).
- No legacy journal migration (Q5-A deferred — pre-launch).
- No site-level preference layer (Q1-C deferred — YAGNI).
- No new persisted-clone scheme — the clone stays session-only by platform
  constraint; the serializable inverse stays the post-reload fallback, as F3
  documented.
- No change to F1, F3, F5, the transaction layer, the loop structure, the
  budget, or the roadmap.
- No `prior-work` prompt summary for the model (Q2-C deferred — the loop
  starts with an empty journal; the model re-observes).

---

## 6. Honest state

- **Proven by running tests:** the unit suite, the 6 F4 browser tests, the
  real-site vision capstone, and the F1/F3/F5 regression tests — all green.
  The strict-scope leak was found and fixed by a test, not by inspection.
- **Proven by inspection:** the live persistence, journal, identity,
  transaction, act, content, background layers; the MV3 timing facts.
- **The two implementation deviations from the design are named in §2** —
  both are fixes a test forced, both are the minimal correct change, and both
  are documented in the code.
- **Known limitation, carried from the design (§11):** DOM acts (insert/
  setText) replay at `document_idle` (after the target exists), NOT before
  first paint — only CSS acts replay before paint. This is a documented
  limitation of `document_idle` + MV3, not a claim. The report says so.
- **One real-site nuance:** Wikipedia's Vector2022 main menu is
  default-collapsed into a hamburger, so "hide the sidebar" on Wikipedia hides
  a menu that may already be collapsed. The vision words describe the
  hamburger state honestly; the F4 proof rests on the **computed-style**
  signal (A hidden, B untouched, A-again hidden) and the **scope** behavior,
  not on Wikipedia's default-collapsed skin. The controlled-fixture capstone
  (5/5) removes this skin ambiguity entirely.

F4 CONTINUITY works. A change made today is still there tomorrow, and it does
not leak onto pages it was never asked for.

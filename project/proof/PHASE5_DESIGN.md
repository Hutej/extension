# PHASE 5 — F4 CONTINUITY (DESIGN ONLY)

*Investigation performed 18 Aug 2026 against the canonical main branch
(`b9c1cf8`, clean, `phase2-reversal` == `b9c1cf8`). The previous Phase 5
investigation was performed against the pre-migration checkout and is
INVALIDATED; this document restarts from the real tree. This is a DESIGN
document — no production code is changed. Implementation awaits explicit
approval.*

---

## 0. How to read this document

Every claim about "current behaviour" cites the exact file and function it
was verified in. Where the live code contradicts a roadmap/doc assumption,
the live code wins and the contradiction is named. Where a genuine product
decision is required, it is isolated in §22 (Open questions) with options,
evidence, and a recommendation — those are the only things that block
implementation.

---

## 1. F4 requirements (from `roadmap.txt` §4 Phase 5, `06_FOUNDATION.md` F4)

1. **Persistence scope = origin + path.** Never a full URL. Never query,
   never fragment — tokens and personal data live there.
2. **Replay the journal before first paint where possible.**
3. **Detect SPA route changes.**
4. **Re-verify targets after route changes.**
5. **Missing targets are reported, never silently skipped.**
6. **Done = "hide the sidebar" survives reload AND survives a second
   Wikipedia article** (MVP corpus row 3). A change made today is still
   there tomorrow.

These are the binding requirements. They are not weakened anywhere below.

---

## 2. Current main architecture (verified against `b9c1cf8`)

The relevant live files:

| File | Role | F4 relevance |
|---|---|---|
| `core/persist/index.ts` | `originKey()`, `loadJournalState`, `saveJournalState`, `JournalState`, `JournalEntry` | **the storage layer F4 must change** |
| `agent/journal.ts` | `Journal` class, `toState()`, `undo()` | the record persisted |
| `agent/loop.ts` | `runLoop`, `persistJournal`, `rollbackDomIfActed`, in-loop replay block (L143–157) | **persist + replay trigger** |
| `entrypoints/content.ts` | `reapplyPersistedDom`, `undoPersistedDom`, SPA hooks (L24–39), `restoreHtmlLocal` | **the replay + SPA-detection site** |
| `entrypoints/background.ts` | `reinsertSavedCss` (webNavigation.onCommitted), `handleToggleCss` | **the CSS-replay site** |
| `core/identity.ts` | `resolveTarget` (fail-closed guard), `fingerprint`, `stripPositional`, `isUniqueInFlippableSet` | **the re-verify primitive F4 must reuse** |
| `core/identity-store.ts` | session-only `Map<selector, Fingerprint>` | observe→act bridge; session-only by design |
| `core/identity-dom.ts` | `liveIdentityDom` | the live DOM surface for `resolveTarget` |
| `core/ops/txn.ts` | `TransactionLog`, `OpInverse`, `applyInverse` | F3 inverse algebra; **session-only, cloned nodes** |
| `core/ops/recorder.ts` | `txnLog` singleton, `recordStructural`, `undoAllStructural` | content-script singleton |
| `core/ops/liveDom.ts` | `liveDom` adapter | the DOM surface for `txn.ts` |
| `tools/act.ts` | `guardTarget`, `applyCss`/`hide`/`setText`/`insert`/`heal` | act tools that record inverses |
| `core/inventory.ts` | `buildInventory`, `buildStableSelector` | produces the persisted selectors |

Key architectural facts (all verified in code this session):

- **Identity is structural fingerprints, re-resolved at use time** — not a
  stamped attribute. `resolveTarget(dom, selector, expectedFp)` is fail-closed
  for zero/many/wrong-target/indistinguishable-twin, and "mutate flagged
  unverified" for a unique selector with no observe-time fingerprint
  (`identity.ts:148–193`). This is the single authoritative identity guard; the
  act path (`tools/act.ts:guardTarget`) and the undo path (`txn.ts:applyInverse`
  for setText) both route through it.
- **In-session inverses are exact (cloned nodes); the serializable journal
  inverses (`restoreText`/`restoreHtml` via `innerHTML`) are the post-reload
  fallback only** (`tools/act.ts:373–400` setText, `content.ts:191–221`). Law 7:
  `textContent`/`innerHTML` is never a valid *in-session* inverse.
- **The TransactionLog is session-only and holds live `Node` refs**
  (`txn.ts:35–41`, `recorder.ts:15`). The clone cannot cross the
  `chrome.tabs.sendMessage` structured-clone boundary — this is why the log
  lives in the content script, and why it cannot be persisted as-is.
- **CSS is inserted at USER origin via `chrome.scripting.insertCSS` from the
  background; there is no style node, no `@layer`** (`background.ts:23`,
  `emit.ts`, ARCHITECTURE.md §"How output reaches the page").

---

## 3. Current persistence implementation (Step 4 answers — cited)

1. **Where is persistence implemented?** `core/persist/index.ts` (storage
   primitives) + `agent/loop.ts:persistJournal` / `rollbackDomIfActed`
   (write sites) + `entrypoints/content.ts` (replay) +
   `entrypoints/background.ts` (CSS re-insert).
2. **What is currently persisted?** `JournalState { enabled, origin, goal,
   entries[], createdAt }` (`persist/index.ts:12–19`). `entries` are full
   `JournalEntry` objects including `args`, `result`, `inverse`, `confidence`.
3. **Current persistence key?** `origin` alone — `PREFIX + origin`
   (`persist/index.ts:33–40`). `originKey(url)` returns `u.origin`.
4. **Origin-only, origin+path, or other?** **Origin-only.** Explicit:
   `persist/index.ts:36` "Per-origin storage key. Origin only — no path, no
   query, no fragment." and `loop.ts:664` "persist by origin only — not origin
   + path."
5. **How is pathname normalized?** It is not. `path` is read in the loop
   (`loop.ts:123` `path = u.pathname`) and passed to the prompt only; it is
   never stored.
6. **Are query strings persisted?** No (origin-only key). Correct by
   accident, not by design.
7. **Fragments persisted?** No (origin-only key). Correct by accident.
8. **How are operations serialized?** The whole `JournalEntry` is
   JSON-cloned into `chrome.storage.local`. CSS inverses are serializable
   (`{kind:'removeCss', css}`). DOM inverses carry a serializable fallback
   (`{kind:'restoreText', selector, prevHtml}` / `{kind:'restoreHtml',
   selector, prevHtml, isInside}`) **and** the in-session clone (which is NOT
   in the persisted state — it lives only in the content-script `txnLog`).
9. **Does persistence contain target identity?** Partially. The act entries
   carry `args.selector`. The setText/insert entries do NOT carry the
   observe-time fingerprint in the *persistable* inverse —
   `restoreText`/`restoreHtml` have only `selector` + `prevHtml`. The
   fingerprint lives in the session-only `identity-store` and the `txnLog`
   inverse (`inv.fingerprint`), neither persisted.
10. **Does persistence contain fingerprint information?** **No.** The
    structural fingerprint is never written to `JournalState`. The journal
    `result` may contain selectors but no fingerprints (describePage
    deliberately omits fingerprints from model-facing output,
    `observe.ts:49–67`).
11. **How is the journal loaded?** `loadJournalState(key)` via
    `browser.storage.local.get` (`persist/index.ts:42–47`).
12. **How is replay triggered?** Three paths:
    - `content.ts:main()` calls `reapplyPersistedDom()` on content-script
      load (L21).
    - `content.ts` SPA hook `checkRouteChange` calls `reapplyPersistedDom()`
      on pushState/replaceState/popstate (L24–39).
    - `loop.ts:143–157` replays persisted DOM act entries at the start of a
      new run **if `stored.goal === goal`**.
13. **Does replay exist at all?** Yes, but partially and unsafely (see §4).
14. **What if a replay target is missing?** `reapplyPersistedDom`
    (`content.ts:161–189`) calls the tool anyway, then checks
    `document.querySelectorAll(sel).length === 0` and pushes the selector to
    a `missing[]` list logged via `console.warn` (L185–187). **This is a
    silent skip for the model/user** — the warn is console-only; nothing
    reaches the journal or the popup. Violates requirement 5.
15. **Ambiguous replay target?** The replay calls `tool.execute(entry.args)`
    directly (`content.ts:179`). For CSS acts this re-runs `guardTarget` →
    `resolveTarget` → refuses on ambiguous. For setText/insert the same
    guard runs. **So ambiguity IS caught on replay** — but a refusal throws
    away the persisted op with no record (the tool returns `ok:false`, the
    return value is discarded at `content.ts:179`).
16. **Fingerprint mismatch on replay?** Same as 15: the guard refuses, the
    refusal is discarded. No record that a persisted op could not be
    re-applied.

### The single most important finding

**Replay today re-runs the act tools, which re-run `guardTarget`/`resolveTarget`
— so identity safety is already in place for CSS acts.** What is missing is:
(a) the persistence key is wrong (origin-only, not origin+path); (b) DOM-act
replay relies on the lossy `restoreText`/`restoreHtml` serializable inverse
and the `tool.execute` re-run, NOT on a persisted fingerprint; (c) refusals
are swallowed; (d) the loop's in-run replay gates on `goal === goal`, which
silently skips cross-goal continuity (a "hide the sidebar" persisted, then
the user runs "reduce clutter" — the sidebar does NOT come back because the
goals differ); (e) the loop replay dispatches DOM acts that the content
script ALSO replays on load → **double-application risk**.

---

## 4. Current journal + replay implementation (verified)

### The loop's in-run replay (`loop.ts:143–157`)
```
key = originKey(origin)
stored = await loadJournalState(key)
if (stored.entries?.length && stored.goal === goal):
  for entry in stored.entries:
    if entry.kind == 'act':
      if entry.inverse.kind == 'removeCss': continue   // background handles CSS
      await dispatchTool(tabId, entry.tool, entry.args)
      journal.entries.push(entry)
```
Problems:
- **`stored.goal === goal` gate.** A persisted "hide the sidebar" is NOT
  replayed if the new run's goal is anything else. This is the opposite of
  continuity — the sidebar modification vanishes the moment the user asks
  for a second, unrelated thing on the same origin. (The MVP requires the
  sidebar to survive a *second article*, which is a different URL/paths but
  could be the same goal; the gate still breaks cross-goal continuity.)
- **Double-application.** The content script's `reapplyPersistedDom` already
  re-applied these on load (`content.ts:21`). The loop replaying them again
  means `insert` runs twice (it does remove `[data-revueon-inserted]` first
  at `content.ts:169`, so insert is idempotent by construction; `setText` is
  NOT — re-running it re-mutates and records a second structural inverse).
- **No identity re-verify recorded.** The replayed entries are pushed into
  the journal as if they were freshly observed, with no fingerprint
  re-registration. A subsequent act that depends on one of those selectors
  will find the identity-store empty for it (the store was reset, and replay
  never calls `registerIdentity`).

### The content-script load replay (`content.ts:161–189` `reapplyPersistedDom`)
```
key = originKey()
state = await loadJournalState(key)
if (!state.enabled || !state.entries?.length) return
document.querySelectorAll('[data-revueon-inserted]').forEach(el => el.remove())
for entry in state.entries:
  if entry.kind != 'act': continue
  if entry.inverse.kind == 'removeCss': continue
  tool = getTool(entry.tool); if (tool) await tool.execute(entry.args)
  if selector && querySelectorAll(selector).length == 0: missing.push(selector)
if missing.length: console.warn(...)
```
This is the path that actually runs on every page load and SPA route change.
It re-executes DOM acts through the live tools — which re-verify identity
through `guardTarget`. So:
- **CSS is NOT replayed here** (handled by background `reinsertSavedCss`).
- **DOM acts (insert/setText) ARE replayed** via tool re-execution.
- The replayed act calls `recordStructural`, populating the session `txnLog`
  with fresh clones — so the *in-session* undo path works after a reload.
  This is good. But the clone is of the post-replay state, not the original
  pre-mutation state, so an undo after reload restores to the re-applied
  baseline, not the true original. (Acceptable: the user toggled off → page
  restored; toggled on → replay reapplies. The "byte-identical" guarantee of
  F3 is in-session only, which F3 already documents.)
- **Missing targets are console-warned only** (requirement 5 violated).

### The background CSS replay (`background.ts:87–112`)
```
webNavigation.onCommitted.addListener(details => {
  if details.frameId != 0: return
  reinsertSavedCss(details.tabId, details.url)
})
```
`reinsertSavedCss` re-inserts every persisted `removeCss` inverse's CSS at
USER origin. **Critical MV3 fact (verified via Chrome docs this session):
`webNavigation.onCommitted` fires for full navigations (link, reload,
typed) BEFORE first paint — but does NOT fire for `history.pushState` /
`history.replaceState`** (those fire `onHistoryStateUpdated`). So:
- Full navigation/reload → CSS replayed before paint. Good.
- SPA `pushState` route change → **CSS NOT replayed by the background**.
  The content-script hook fires `reapplyPersistedDom`, which skips CSS
  (L177 `if inv?.kind === 'removeCss': continue`). **So a CSS hide applied
  on article A is NOT re-inserted when the user pushState-navigates to
  article B.** This is the exact "hide the sidebar stops working when you
  click a video" failure F4 exists to fix.

---

## 5. Current F1 integration point (verified)

F1 is `core/identity.ts` + `core/identity-store.ts` + `core/identity-dom.ts`.
The act path uses it via `tools/act.ts:guardTarget`:

```
guardTarget(selector):
  expectedFp = getIdentity(selector)          // session store (NOT persisted)
  r = resolveTarget(liveIdentityDom, selector, expectedFp)
  if !r.ok: return { ok:false, error: r.error }   // refuse, record nothing
  return { ok:true, el: r.el, unverified: r.reason == 'unverified' }
```

`resolveTarget` returns `ok` only when: exactly one match AND (fingerprint
matches expectedFp, OR no expectedFp but unique-and-not-a-twin). On reload,
the identity-store is empty (session-only, `identity-store.ts:10`), so
`getIdentity(selector)` returns `null`, and `resolveTarget` takes the
"unverified" path — which **still runs the identical-twin guard** and still
mutates a unique target. This means: **a persisted act replayed after reload
mutates the unique target it names, flagged unverified.** That is safe
(unique target is not wrong by construction) but it is weaker than
observe-time-verified: if the page re-rendered and the selector now points
to a *different* element of the same structure, the unverified path cannot
catch it (no expectedFp to compare). The fingerprint guard's wrong-target
catch requires an `expectedFp`.

**This is the crux of F4 + F1 integration:** to make replay *verified*
(not merely unverified), the persisted journal must carry the
observe-time fingerprint per target, so replay can call
`resolveTarget(dom, selector, persistedFp)` and get the wrong-target refusal
instead of a silent unverified mutate.

### Can the current fingerprint be safely persisted?

**Yes.** The fingerprint is:
- A string (`tag|attrStr|c{childCount}|d{depth}|{text40}|{hash8}`),
  fully serializable (`identity.ts:65–88`).
- Style-agnostic (excludes `style` + all `data-rv-*` stamps), so it
  survives the transform we apply AND survives our replay re-applying it.
- Deterministic for the same structure across re-render/reload.
- PII: it contains a 40-char text prefix + a hash of the full text. This is
  *content*. Per the privacy commitment (rule 14, `05_BROWSER_CRAFT` §9,
  product req 6), we store origin+path only and never a full URL. A 40-char
  text sample + hash of an element's own text is **not a URL** and is the
  same kind of content already stored in the journal `result.textSample`
  (`inventory.ts:111`). **However**: the fingerprint hash is over the
  *full* text, and persisting it is a (hashed) content fingerprint, not
  content itself. The 40-char prefix IS stored in cleartext inside the
  fingerprint string. This is a privacy consideration to flag — see §22 Q1.

So the persisted per-op record should carry `selector + fingerprint` (the
observe-time identity), letting replay re-verify with the full
`resolveTarget` strength. This is exactly the `buildDescriptor`→`reidentify`
pattern the archive's `apply/index.ts` sketched (but whose source is lost),
realized with the current fingerprint type.

---

## 6. Current F3 integration point (verified)

F3 is `core/ops/txn.ts` + `recorder.ts` + `liveDom.ts`. Inverses:
- `removeCss` (CSS — serializable, exact, persisted as the CSS string).
- `setText` — in-session clone + `fingerprint`; serializable fallback
  `restoreText {selector, prevHtml}` (innerHTML re-parse — lossy, post-reload
  only).
- `insert` — in-session `node` ref; serializable fallback `restoreHtml
  {selector, prevHtml, isInside}`.

**The TransactionLog is session-only by construction** (`txn.ts:84`,
`recorder.ts:15`). The clone and the live `Node` cannot be persisted.

F4 must NOT create a second mutation/rollback system (requirement). So F4
replay reuses:
- The **act tools** themselves (`tools/act.ts`) as the replay executor —
  replay = re-call `tool.execute(args)` against the fresh DOM, which
  re-records into the live `txnLog` (giving the post-reload session a working
  in-session undo). This is what `reapplyPersistedDom` already does.
- The **`resolveTarget` guard** as the re-verify gate.
- The **`rollbackDomIfActed`** path for any failure during a *new* run.

What F4 must NOT do: persist the `txnLog` entries (they hold `Node` refs).
The persistable unit is the **journal entry's `args` + an identity
descriptor (selector + fingerprint)**, replayed by re-executing the tool.

---

## 7. Archive prior art (Step 3 — classified)

Searched `archive/` (103 files). The live `persist/index.ts` and old
`content.ts` orchestrator are **referenced everywhere but absent from the
archive**; the recovered `.ts` is a subset. Findings:

| Prior art | Classification | Why |
|---|---|---|
| `reapplyStored` re-derives ops from stored spec against fresh perception; idempotent (each op checks live state, skips if satisfied) — `execute.ts:31–33`, `04_DATA_FLOW.md`, `05_DOM_PIPELINE.md` | **ADAPT** | skeleton reusable; re-derive-from-spec → re-resolve-via-fingerprint + replay-persisted-journal |
| SPA hook set: `pushState`/`replaceState`/`popstate`/`hashchange`, debounced, `handleRouteChange` → clear cache + reapply — `content.ts:1331/1546` (current code already has this at `content.ts:24–39`) | **ADAPT** | already ported; add `onHistoryStateUpdated` (the pushState gap), add Turbo/morph detection |
| `OpInverse` algebra + `DomAdapter` — `archive/.../ops/transaction.ts` | **ADAPT** | already ported to live `txn.ts` with the fingerprint upgrade; the *persistable* form is new |
| `buildDescriptor`/`reidentify` capture-then-re-resolve — `archive/.../apply/index.ts:3,392–423` | **ADAPT** | pattern is exactly F4 replay; descriptor type must be the current fingerprint (old source lost, was structural-path) |
| `clearRoleCache` on route change + reapply — S10.3b resolution | **REUSE** | directly: invalidate session resolution caches on route change |
| Fail-closed / report-missing principle — `07_ARCHITECTURE_ANALYSIS.md:29` | **REUSE** | extend F1's fail-closed to report-missing-on-replay |
| `KVStore` contract — `capabilities/store/index.ts` (unimplemented) | **REJECT** | wrong abstraction (per-tool KV, not journal) |
| Reload Jaccard probe — `tests/probe/stability.test.ts` | **ADAPT** | methodology reusable; identity metric must be fingerprint, not `data-rv-c` handle |

**Key archive facts:**
- Old identity was **never persisted** — `data-rv-c` was re-stamped on every
  `perceive()` run; what was persisted was spec+CSS+opts. F4 introduces
  persisted identity (the fingerprint) for the first time.
- Old keying was **origin-only** (same as live). No prior art for
  origin+path. F4 introduces it.
- **RC6** (archive `08_ROOT_CAUSE_ANALYSIS.md`, `09_BROWSER_COMPATIBILITY.md`,
  `05_DOM_PIPELINE.md`): Turbo morph re-renders → handles on recycled nodes →
  undo replays wrong nodes → `insertBefore NotFoundError`. This is the
  canonical "wrong target on replay" hazard. F4's re-resolve-via-fingerprint
  is the fix; the identical-twin guard (`identity.ts:178`) closes the
  reorder-within-morph case.
- **No archive prior art for first-paint replay timing.** The old system
  relied on a post-render MutationObserver with acknowledged FOUC. F4's
  before-first-paint replay is new ground.

---

## 8. Persistence-key design (Step 7)

### Required change
`originKey(url)` → `scopeKey(url)` returning `origin + pathname`, with query
and fragment stripped. Concretely in `core/persist/index.ts`:

```
export function scopeKey(url?: string): string {
  const u = new URL(url ?? window.location.href);
  return u.origin + u.pathname;   // NO search, NO hash
}
```

### Why origin+path (not origin-only) — and the contradiction
The binding docs (`06_FOUNDATION.md` F4, `roadmap.txt` Phase 5,
`.kiro/steering/product.md`) all say **origin+path**. But
`docs/ARCHITECTURE.md:214–221` **explicitly defends origin-only** as a
product decision: *"a request like 'hide the sidebar' describes a site-level
preference, not a per-URL one… Keying by origin+path would fragment that
intent across every article URL and defeat continuity."*

This is a **genuine, documented contradiction** between two binding-seeming
sources. It is NOT resolvable by reading code. **See §22 Q1** — this is the
single most important open question and it gates the whole design. The
roadmap and 06_FOUNDATION are the more recent, more authoritative
statements (authored 12 Aug 2026 specifically to resolve contradictions),
and they say origin+path; ARCHITECTURE.md predates them. My recommendation
follows the roadmap (origin+path), but the second-Wikipedia-article
capstone (§12) depends on the answer, so it must be confirmed.

### Normalization
- `pathname` is already normalized by `URL` (lowercased host, percent-encoded
  path, no trailing semantics). No extra normalization needed.
- `/wiki/CSS` and `/wiki/HTML` are different keys → a hide on /wiki/CSS
  does NOT auto-apply to /wiki/HTML. This is the **opposite** of the
  origin-only behaviour, and it is the crux of the capstone (§12): "survives
  a second Wikipedia article" must mean something specific under origin+path.

---

## 9. Persisted-operation schema (Step 5/6)

The persistable unit is a **replayable operation record** — not the whole
journal. Proposal: extend `JournalEntry` with an optional persisted-identity
field, and define a slim `PersistedOp` projection that the replay path
consumes.

```
// In core/persist/index.ts (additive)
export interface PersistedIdentity {
  selector: string;
  fingerprint: Fingerprint;   // observe-time structural fingerprint (§5)
}

// Replayable projection of an act entry.
export interface PersistedOp {
  tool: string;               // 'applyCss' | 'hide' | 'setText' | 'insert' | 'heal'
  args: Record<string, unknown>;
  identity?: PersistedIdentity;   // for acts with a selector target
  inverse: Record<string, unknown>; // serializable inverse only (removeCss / restoreText / restoreHtml)
}
```

- For CSS acts (`applyCss`/`hide`/`heal`): `identity` = the primary
  selector + its fingerprint (capture from the act's `guardTarget` result;
  the act already computes `actFingerprint` for setText at `act.ts:388` —
  generalize to all acts).
- For `setText`/`insert`: `identity` = the target selector + fingerprint.
- The **clone / live Node is NOT persisted** (cannot be). The serializable
  inverse stays as the post-reload fallback only, as today.

The `JournalState` gains `path: string` (for the key) and a `ops: PersistedOp[]`
(or keep `entries` and derive `ops` at replay). Minimal change: keep
`entries`, add `path`, and add `identity` to the act entries that have a
selector. Replay reads `entries` filtered to `act` + identity.

**Why this is enough:** replay re-executes the tool with the original
`args`, after re-verifying the target via `resolveTarget(dom, selector,
identity.fingerprint)`. The fingerprint gives the wrong-target refusal on
replay. The tool re-records into the live `txnLog`, so in-session undo
works post-reload. No second mutation system.

---

## 10. Replay lifecycle (Step 4/6/8)

### Trigger points (three, unchanged in shape, fixed in behaviour)
1. **Content-script load** — `reapplyPersistedDom()` at `content.ts:21`.
2. **SPA route change** — `checkRouteChange` at `content.ts:24–39`.
3. **Loop start** — `loop.ts:143–157`.

### The unified replay procedure (proposed, in `content.ts`)
```
async function reapplyPersistedDom():
  key = scopeKey()
  state = loadJournalState(key)
  if !state.enabled or !state.entries: return
  // CSS handled by background; here DOM only (insert/setText).
  document.querySelectorAll('[data-revueon-inserted]').forEach(el => el.remove())
  results = []
  for entry in state.entries where entry.kind == 'act':
    if entry.inverse.kind == 'removeCss': continue
    id = entry.identity  // selector + fingerprint
    if id:
      // F4: RE-VERIFY before replaying. Use the persisted fingerprint.
      r = resolveTarget(liveIdentityDom, id.selector, id.fingerprint)
      if !r.ok:
        results.push({ selector: id.selector, status: mapReason(r.reason), error: r.error })
        continue   // do NOT replay; report
      // Pre-register the identity so the tool's own guardTarget sees a
      // matching fingerprint (verified, not unverified) — or pass the
      // verified el through. Simplest: registerIdentity(id.selector, r.el).
      registerIdentity(id.selector, r.el, liveIdentityDom)
    tool = getTool(entry.tool)
    res = tool ? await tool.execute(entry.args) : null
    if !res?.ok: results.push({ selector: id?.selector, status: 'failed', error: res?.error })
  if results.length:
    // F4 requirement 5: report, never silently skip. Surface to the popup
    // via a storage flag the popup reads, AND console.warn.
    reportReplayOutcomes(results)
```

`mapReason` maps `ResolveReason` → the outcome set of requirement 10:
- `zero` → `missing-target`
- `ambiguous` → `ambiguous-target`
- `wrong-target` → `identity-mismatch` (the page changed under us)
- `indistinguishable-twin` → `ambiguous-target`
- (a tool returning `ok:false` after a successful resolve) → `failed`

**Already-applied detection (idempotency, Step 11):** before re-verifying,
check if the op is *already applied*:
- For CSS acts: not applicable here (background handles CSS).
- For `insert`: the `[data-revueon-inserted]` removal at the top handles
  stale inserts; a fresh insert is the replay. (Idempotent by removal.)
- For `setText`: check if the element's current `textContent` already equals
  `args.text` → skip (already applied). This prevents the loop's double-replay
  from re-mutating.

### Fixing the loop's in-run replay (§4 problems)
- **Remove the `stored.goal === goal` gate** OR replace it with a
  per-origin+path "already replayed this load" guard. Continuity must not
  depend on the new goal matching the old one. **Recommended: remove the
  loop's in-run replay entirely** — the content script already replays on
  load; the loop should not replay again. The loop's replay exists only to
  populate the *journal* the model reads; instead, on a fresh run the
  journal should start empty (the model re-observes). Persisted ops are a
  *page* concern, not a *run* concern. (See §22 Q2 — this changes what the
  model "sees" about prior work.)
- If we keep any in-run replay, it must: (a) use `scopeKey`, (b) not
  double-apply, (c) record replay outcomes into the journal so the model
  knows what is already on the page.

---

## 11. First-paint strategy (Step 8)

### MV3 facts (verified this session)
- The content script runs at **`document_idle`** by default (confirmed in
  the built manifest `.output/chrome-mv3/manifest.json`:
  `content_scripts[0]` has no `run_at` → `document_idle`). `document_idle`
  fires after `DOMContentLoaded`, near load-end — **after first paint**.
- `chrome.webNavigation.onCommitted` fires **before first paint** for full
  navigations (link/reload/typed), but **does NOT fire for
  `pushState`/`replaceState`** — those fire `onHistoryStateUpdated`.
- `chrome.scripting.insertCSS` is the live CSS path; it has no documented
  `runAt` guarantee, but called from the SW during `onCommitted` it lands
  before paint (the background already relies on this, `background.ts:87`).
- Content scripts CAN register at `document_start` (WXT `defineContentScript`
  supports `runAt: 'document_start'`). At `document_start` the DOM is
  essentially empty (`document.body` may not exist yet), so DOM-act replay
  cannot run there — but CSS-act replay (USER-origin stylesheet) can be
  requested from the background during `onCommitted`, independent of the
  content script.

### The strongest honest guarantee the current system can provide
- **CSS acts (hide/applyCss/heal): replayable before first paint** for full
  navigations, via the background `onCommitted` → `insertCSS` path that
  already exists. **For SPA `pushState`, CSS is NOT replayed before paint
  today** (the gap in §4). Fix: add `onHistoryStateUpdated` listener in the
  background that calls `reinsertSavedCss` for the new URL's scope key.
  This closes the "hide the sidebar stops working on click" failure.
- **DOM acts (insert/setText): NOT replayable before first paint**, because
  the target element does not exist at `document_start`. They replay when
  the content script runs (`document_idle`) or when the SPA hook fires
  (after a 500ms debounce). This is a **documented limitation**, not a
  guarantee. The roadmap says "before first paint where possible" — DOM acts
  are the "not possible" case. F4 must say so in the report, not claim it.

### Proposed first-paint replay ordering
1. Background `webNavigation.onCommitted` (full nav) → `reinsertSavedCss`
   (CSS, before paint). **Add**: `webNavigation.onHistoryStateUpdated`
   (SPA pushState/replaceState) → `reinsertSavedCss` for the new scope key.
   Both keyed by `scopeKey(details.url)`.
2. Content script at `document_idle` (or on SPA hook) → `reapplyPersistedDom`
   (DOM acts, after the target exists). Re-verifies identity first.

### A product decision lurking here (§22 Q3)
Should the content script move to `document_start` to register the SPA
hooks earlier (so a pushState before `document_idle` is still caught)?
At `document_start` the hooks can be installed but DOM replay cannot run.
The benefit: catching very-early SPA navigations on fast sites. The cost:
more complex ordering, and `document_start` content scripts have limited
DOM access. This is marginal; **recommendation: stay at `document_idle`**
and rely on `onHistoryStateUpdated` (a background event, fires regardless of
content-script timing) for the SPA-CSS case. Flag in §22.

---

## 12. SPA route detection (Step 9)

### Current (verified)
`content.ts:24–39` hooks `popstate`, `history.pushState`, `history.replaceState`
(patch + 500ms debounce → `checkRouteChange` → `reapplyPersistedDom`).
`hashchange` is NOT hooked (a `#section` change fires `popstate` in modern
browsers, so this is usually covered, but a pure `hashchange` without
`popstate` is a gap). The background hooks `onCommitted` only (misses
pushState — §4).

### Minimum mechanism required (proposed)
1. **Keep** the content-script `pushState`/`replaceState`/`popstate` hooks
   (already correct for DOM-act replay). Add `hashchange` for completeness
   (cheap; closes the pure-hash edge).
2. **Add** `webNavigation.onHistoryStateUpdated` in the background
   (`background.ts`) → `reinsertSavedCss` for the new scope key. This is the
   fix for the SPA-CSS gap (§4, §11). It is the single most impactful change
   in F4 for the capstone.
3. **Do NOT** introduce a navigation framework, a MutationObserver defence
   loop, or a route-detection library. The two-event hook (content hooks +
   `onHistoryStateUpdated`) is the minimum.

### On route change (the design target, Step 9)
```
route changes (pushState/replaceState/popstate/hashchange OR onHistoryStateUpdated)
  ↓
determine new origin + pathname → scopeKey(newUrl)
  ↓
load corresponding persistence state
  ↓
CSS: background reinsertSavedCss (before paint, onHistoryStateUpdated)
DOM: content reapplyPersistedDom (after target exists, re-verify via fingerprint)
  ↓
report missing/ambiguous targets (requirement 5)
```

---

## 13. Identity re-verification on replay (Step 5 — concretized)

Replay calls `resolveTarget(liveIdentityDom, selector, persistedFingerprint)`:
- `ok` + `el` → the target is the same element (fingerprint match). Replay
  the tool. **Register** the identity (`registerIdentity(selector, el)`) so
  the tool's own `guardTarget` sees a verified fingerprint, not unverified.
- `ok:false, reason:'wrong-target'` → the page changed under us; the
  selector resolves to a *different* element. **Do not replay.** Report
  `identity-mismatch`. (This is the case origin-only keying + re-render
  makes common; the fingerprint catches it.)
- `ok:false, reason:'zero'` → target gone. Report `missing-target`.
- `ok:false, reason:'ambiguous'` or `indistinguishable-twin` → report
  `ambiguous-target`.
- `ok:true, reason:'unverified'` → only if `persistedFingerprint` is null
  (a legacy persisted op from before F4). Replay flagged unverified; do not
  fail. (Backwards-compat for journals persisted before this phase.)

This reuses the **single** `resolveTarget` — no second resolver. F1 owns
identity; F4 feeds it a persisted fingerprint.

---

## 14. Missing-target policy (Step 10)

### Outcomes (requirement 10 + mapReason above)
- `replayed` — op re-applied, identity verified.
- `already-applied` — op's effect is already present (setText text matches;
  insert handled by removal+reinsert). Idempotent skip.
- `missing-target` — `resolveTarget` reason `zero`.
- `ambiguous-target` — reason `ambiguous` or `indistinguishable-twin`.
- `identity-mismatch` — reason `wrong-target`.
- `failed` — tool executed but returned `ok:false` (non-identity reason).

### Invariants
- `missing-target ≠ successful replay`. A missing target is reported, not
  counted as applied.
- `ambiguous-target ≠ successful replay`. Same.
- The outcome set is surfaced: to the popup (via a `replayReport` field in
  storage the popup reads on open), to the console (`console.warn`), and —
  for the in-run path — into the journal so the model knows what is already
  on the page and what refused.

### No huge state machine
The outcome is a per-op `{selector, status, error?}` list produced during
replay. Stored transiently (session), not a persisted FSM.

---

## 15. Idempotency strategy (Step 11)

### Scenarios
1. **load → replay → reload → replay again.** Each replay re-verifies and
   re-applies. For CSS: `insertCSS` of the same string is idempotent
   (deduped by origin+css). For insert: the `[data-revueon-inserted]`
   removal at the top of `reapplyPersistedDom` prevents duplicates. For
   setText: the "current textContent == args.text" check skips
   re-mutation. **Net: idempotent by construction, no duplicate CSS /
   duplicate inserts / repeated setText.**
2. **load → replay → SPA route event → replay again.** Same path, same
   idempotency. The route change loads the *new* scope key's state (often
   empty for a never-visited article) → no replay. For the same scope key
   revisited, idempotent.
3. **loop in-run replay + content load replay (the double-application bug
   of §4).** Fixed by removing the loop's in-run replay (§10) or by gating
   it on a per-load "already replayed" flag.

### Journal duplication
- Replayed ops should NOT be appended to the persisted journal as new
  entries (that would grow storage every reload). Replay reads the
  persisted `entries` and re-applies; it does not write new persisted
  entries. The session `txnLog` is repopulated (for in-session undo), but
  that is session-only.

---

## 16. Second-article behaviour (Step 12 — the capstone)

### The roadmap's exact capstone
*"hide the sidebar" survives reload AND survives a second Wikipedia article.*

### What it means under origin+path keying (the design target)
- Article A `/wiki/CSS`: user runs "hide the sidebar". The sidebar is
  hidden (CSS). Persisted under `scopeKey = en.wikipedia.org/wiki/CSS`.
- **Reload A**: `onCommitted` → `reinsertSavedCss` re-inserts the hide CSS
  before paint. Sidebar stays hidden. ✓ (survives reload)
- **Navigate to article B `/wiki/HTML`** (a link click = full navigation):
  `onCommitted` fires for B. `reinsertSavedCss` loads `scopeKey =
  en.wikipedia.org/wiki/HTML` → **no persisted state for B** → CSS not
  re-inserted → **sidebar reappears on B.**
  - This is the **honest behaviour under origin+path**: the hide was scoped
    to A, not B. "Survives a second article" under strict origin+path means
    **the modification does not corrupt B**, not that it propagates to B.
- **Navigate to B via SPA pushState** (Wikipedia is mostly full navigations,
  but if a client-side router is used): `onHistoryStateUpdated` for B →
  same: B's scope key has no state → no replay.

### The ambiguity (§22 Q4 — IMPORTANT)
The capstone's "survives a second Wikipedia article" has two readings:
- **(A) Strict scope:** the hide stays on A across reload; on B it is
  absent (not propagated). "Survives" = "does not break when the user moves
  to another article; A's modification is intact when the user returns to A."
- **(B) Propagated scope:** the hide applies to B too, because "hide the
  sidebar" is a *site-level* intent (the `ARCHITECTURE.md:214` argument).
  Under origin-only keying this is automatic; under origin+path it is not.

These two readings imply **opposite keying decisions**:
- Reading (B) wants **origin-only** (the old behaviour, what
  `ARCHITECTURE.md` defends).
- Reading (A) wants **origin+path** (what `06_FOUNDATION.md`/`roadmap.txt`
  say).

**This is the same contradiction as §8, now from the capstone side.** It
MUST be resolved before implementation. See §22 Q1+Q4. My recommendation
(§22) reconciles them.

---

## 17. Failure / rollback semantics (Step 6/11)

- **Replay-time refusal (missing/ambiguous/mismatch):** no mutation
  happened (the guard refused before the tool ran). Report. The persisted
  op stays in storage (so a future reload can try again if the page
  recovers). Do NOT delete persisted state on a replay refusal — the
  modification may become re-applicable when the page changes back.
- **Replay-time tool failure (tool returned ok:false after resolve):**
  report `failed`. No rollback needed (the tool's own guard ran).
- **Partial replay:** some ops replay, some refuse. Each op is independent
  (per-op try/catch, mirroring `txn.ts:158–174`). The page ends with the
  subset that verified; the refusals are reported. No all-or-nothing
  rollback of replay (replay is re-application, not a transaction).
- **A new run that fails:** unchanged — `rollbackDomIfActed` rolls back the
  *new* run's changes (F3 RC3 fix). F4 does not touch this path except to
  use `scopeKey` when clearing storage.
- **`undoAll` after replay:** replay repopulated the session `txnLog`
  (each replayed tool called `recordStructural`). So `undoAll` after a
  reload-replay undoes the replayed ops — correct. CSS is undone by the
  background `removeCss` path. This preserves F3's in-session exactness
  post-reload.
- **Duplicate journal entries:** replay does not append to the persisted
  journal (§15), so no duplication.

---

## 18. Required files to change (specific)

| File | Change | Size |
|---|---|---|
| `core/persist/index.ts` | Add `scopeKey(url)` (origin+pathname). Keep `originKey` for backwards-compat read of legacy data OR migrate. Add `path` to `JournalState`. Add `PersistedIdentity`/`PersistedOp` types. | small |
| `agent/loop.ts` | Replace `originKey` with `scopeKey` at persist/replay/clear sites (L145,248,283,317,502,658,668). **Remove or fix the in-run replay block (L143–157)** per §10/§22-Q2. Store `path` in `journal.toState()`. Capture per-act fingerprint into the persisted entry. | medium |
| `agent/journal.ts` | `toState()` includes `path`. (Journal already has `origin`; add `path`.) | tiny |
| `entrypoints/content.ts` | `reapplyPersistedDom`: use `scopeKey`, add fingerprint re-verify via `resolveTarget` + `registerIdentity`, add `already-applied` setText check, surface `replayReport` to storage for the popup. Add `hashchange` hook. (SPA hooks otherwise unchanged.) | medium |
| `entrypoints/background.ts` | Add `webNavigation.onHistoryStateUpdated` listener → `reinsertSavedCss` with `scopeKey(details.url)`. Update `reinsertSavedCss`/`handleToggleCss` to use `scopeKey`. | small |
| `tools/act.ts` | Capture the observe-time fingerprint into the persisted inverse/entry for CSS acts too (generalize `actFingerprint` from setText to all acts with a selector). | small |
| `entrypoints/popup/main.ts` | (Optional, for requirement 5) read `replayReport` from storage and surface missing/ambiguous targets to the user. | small |
| `docs/ARCHITECTURE.md` | Fix the §"Persistence scope" contradiction (L214–221) to match the approved keying decision. | tiny |

**Not changed:** `core/identity.ts`, `core/identity-store.ts`,
`core/identity-dom.ts`, `core/ops/txn.ts`, `core/ops/recorder.ts`,
`core/ops/liveDom.ts`, `core/emit.ts`, `core/inventory.ts`, the act-tool
logic itself, `agent/budget.ts`, `agent/prompt.ts` (unless §22-Q2 says
surface prior replay to the model), `roadmap.txt`.

---

## 19. Required tests (each with a deliberate failing case, rule 15)

1. **`tests/f4-persist-key-test.ts` (pure unit).** `scopeKey` strips query
   and fragment; `?token=SECRET` and `#section` do not change the key;
   `/wiki/CSS` ≠ `/wiki/HTML`. **Failing case:** a `scopeKey` that includes
   `search` or `hash` → fails (privacy requirement 6).
2. **`tests/f4-replay-test.ts` (browser, controlled fixture).** Persist a
   hide + an insert under scopeKey; reload; assert (a) CSS re-applied before
   paint (computed style), (b) insert re-applied, (c) no duplicate inserts,
   (d) `replayReport` empty. **Failing case:** remove the
   `onHistoryStateUpdated` hook → SPA pushState does not re-insert CSS →
   fails.
3. **`tests/f4-missing-target-test.ts` (browser).** Persist a hide on
   selector `aside#sb`; reload with the aside removed from the fixture;
   assert `replayReport` contains `missing-target` for that selector and
   NO mutation happened. **Failing case:** if missing targets are
   console-warned only (not surfaced) → fails (requirement 5).
4. **`tests/f4-identity-mismatch-test.ts` (browser).** Persist a hide on
   `aside#sb` with fingerprint; reload with the aside's text changed
   (different fingerprint); assert `identity-mismatch`, no mutation.
   **Failing case:** replay without persisted fingerprint (unverified
   path) mutates the wrong element → fails (proves the fingerprint is
   load-bearing).
5. **`tests/f4-idempotency-test.ts` (browser).** Persist a setText; reload
   twice; assert the element holds the new text once, `txnLog` has one
   entry, no duplicate persisted journal entries. **Failing case:** remove
   the `already-applied` check → second reload re-mutates / doubles.
6. **`tests/f4-spa-route-test.ts` (browser).** On a fixture with a
   client-side `pushState` router, apply a hide on `/page1`, pushState to
   `/page2`, assert `/page1`'s CSS is NOT on `/page2` (strict scope) OR IS
   (propagated — per §22 answer), and `/page1`'s CSS returns on
   pushState back. **Failing case:** the `onHistoryStateUpdated` hook
   missing → CSS not re-inserted on pushState-back → fails.
7. **`tests/f4-second-article-test.ts` (real Wikipedia, vision).** The
   capstone: "hide the sidebar" on `/wiki/CSS`, reload, navigate to
   `/wiki/HTML`, screenshot → vision model describes whether the sidebar is
   hidden on each. Behaviour per §22-Q4 answer. **Failing case:** the
   contradiction-reading this test encodes must match the approved reading.
8. **`tests/f4-rollback-after-replay-test.ts` (browser).** After a
   reload-replay, `undoAll` restores the page (replay repopulated
   `txnLog`). Asserts F3 exactness survives the reload-replay path.

All tests reuse `foundation-helpers.ts` / the harness; no new harness
infra. Real-site tests use Wikipedia/MDN/HN only (rule 18).

---

## 20. Real-site validation plan

- **Wikipedia `/wiki/CSS`**: hide the sidebar. Reload. Navigate to
  `/wiki/HTML`. Screenshot both. Vision model (kimi-k2.7-code) describes
  in words whether the sidebar is hidden on each. (Rule 14: I reason only
  from the vision model's words, never inspecting the PNG.)
- **MDN article**: insert a summary. Reload. Assert insert present, no
  duplicate. SPA-style hash navigation (`#Syntax`) → assert no spurious
  re-replay.
- **Hacker News**: applyCss (spacing). Reload. Resize 1440→380. Assert
  CSS survives (CSS-only act, the before-paint path).
- **SPA fixture**: a local page with a `pushState` router, to prove the
  `onHistoryStateUpdated` path without a real SPA site (rule 18 keeps us
  off real SPAs in Playwright).

Each run produces a `proof/phase5-*.json` + screenshot + vision words.
Green gates do not pass the phase; a human eye (or vision-in-words) does.

---

## 21. Risks (what could break F1/F3/F5)

| Risk | Impact | Mitigation |
|---|---|---|
| Persisting the 40-char text prefix in the fingerprint is content storage (privacy) | could violate rule 14 / product req 6 | §22-Q1: store fingerprint *hash* only, or store selector-only and accept unverified replay. Flag for approval. |
| Removing the loop's in-run replay changes what the model sees (no prior-work context) | model re-does work, wastes budget | §22-Q2: keep a *read-only* "prior persisted ops on this scope" summary in the prompt instead of replaying. |
| `onHistoryStateUpdated` may fire for same-document hash changes too → spurious CSS re-insert | minor (idempotent insertCSS) | dedupe by scopeKey; idempotent by construction. |
| A replayed setText's "already-applied" check (text matches) could skip a legitimately-different re-application | false skip | only skip if text matches AND fingerprint matches (both). |
| Moving content script to `document_start` (not recommended) breaks DOM access | breaks replay | stay at `document_idle` (recommendation). |
| Legacy origin-only journals become unreadable after the key change | lost continuity on upgrade | migration: on first load, read old `origin`-keyed state, re-write under `scopeKey`. One-time. (§22-Q5) |
| F5's forced checkLayout after a replayed act could false-undo a legitimate replay | page flicker / undo of correct replay | replay should NOT trigger the loop's forced-checkLayout (replay is not a model act); gate the forced check on `hasActed` in the *current* run only (already the case — replay does not set `hasActed`). |
| Identical-twin refusal on replay leaves a page with no modification where the user expects one | user sees "it stopped working" | report `ambiguous-target` clearly; the model/user can re-run with a better anchor. |

---

## 22. Open questions (genuine architectural decisions — require your answer)

These are the only blockers. Each has evidence + a recommendation.

### Q1. Persistence scope: origin+path or origin-only?
**CURRENT EVIDENCE:** `06_FOUNDATION.md` F4, `roadmap.txt` Phase 5, and
`.kiro/steering/product.md` all say **origin+path**. `docs/ARCHITECTURE.md:214–221`
says **origin-only** and defends it as a product decision ("hide the
sidebar describes a site-level preference"). The live code is origin-only.
The two positions are mutually exclusive and both appear in binding-seeming
docs.
**WHY IT MATTERS:** This decides the keying, the capstone semantics (§16),
and whether "hide the sidebar" propagates across articles. It is the
foundation of the whole phase.
**OPTIONS:**
- A. **origin+path** (roadmap/06). Hide on /wiki/CSS does not propagate to
  /wiki/HTML. "Survives a second article" = A's mod is intact when you
  return to A; B is untouched.
- B. **origin-only** (ARCHITECTURE.md). Hide propagates to every article on
  the origin. "Survives a second article" = the hide is on B too.
- C. **origin+path, but with a per-origin "site-level preference" layer**
  for intents the model marks site-level. (More machinery; introduces an
  intent classification F1/F4 do not own today.)
**RECOMMENDATION:** **A (origin+path)**, per the roadmap. It is the more
recent, more authoritative statement, and it matches the privacy
commitment best (less state per key). C is YAGNI until a real goal needs
site-level propagation. **But** the capstone (Q4) must be read consistently
with this.
**PRIVACY SUB-QUESTION:** if A, may we persist the structural fingerprint
(includes a 40-char text prefix)? Or only the selector (accepting
unverified replay)? Persisting the fingerprint enables wrong-target
detection on replay; persisting only the selector degrades replay to
unverified. **Recommendation:** persist the fingerprint — it is a hash + short prefix,
not a URL. **Refinement (review):** the 40-char text prefix inside the
fingerprint is **cleartext**, whereas the inventory's `textSample`
(`inventory.ts:111`) is **redacted** — so the fingerprint prefix is
actually *more* sensitive than textSample, not equivalent. If rule 14 /
product req 6 extend to "no page *content* persisted" (not just no URL),
the cleartext prefix must be dropped or hashed before persistence, at the
cost of weaker wrong-target detection (a hash-only fingerprint can still
match/differ, so wrong-target detection survives — only the human-readable
prefix is lost). **Recommend either: (a) persist the full fingerprint
(prefix + hash) and accept it as content-class storage, or (b) persist a
hash-only fingerprint (drop the cleartext prefix) — preserves wrong-target
detection, drops the human-readable content. Lean (b).** Flag for your
call.

### Q2. Should the loop's in-run replay (L143–157) be removed?
**CURRENT EVIDENCE:** The loop replays persisted DOM acts at run start if
`stored.goal === goal`. The content script ALSO replays on load. This
risks double-application and the `goal===goal` gate breaks cross-goal
continuity (a "reduce clutter" run does NOT see the persisted "hide the
sidebar").
**WHY IT MATTERS:** Defines what the model knows about prior work and
whether continuity is per-run or per-page.
**OPTIONS:**
- A. **Remove the in-run replay.** Replay is a page concern (content
  script). The loop starts with an empty journal; the model re-observes.
  Persisted ops stay on the page but the model is not told about them.
- B. **Keep in-run replay, fix the gate** (drop `goal===goal`, dedupe vs
  content-script replay, record outcomes into the journal).
- C. **Remove in-run replay execution, but add a read-only "prior persisted
  ops on this scope" summary to the prompt** so the model knows what is
  already on the page without re-doing it.
**RECOMMENDATION:** **C.** It gives the model prior-work context (so it
does not re-hide an already-hidden sidebar) without double-application or
the goal gate. Cheapest correct option.

### Q3. Move the content script to `document_start`?
**CURRENT EVIDENCE:** Currently `document_idle` (after paint). `document_start`
would let SPA hooks catch very-early pushState but cannot run DOM replay
(no DOM yet).
**WHY IT MATTERS:** Marginal first-paint improvement for fast-SPA sites.
**OPTIONS:** A. stay `document_idle` (rely on `onHistoryStateUpdated` for
SPA-CSS). B. `document_start` (install hooks early; DOM replay still at
idle via a ready check).
**RECOMMENDATION:** **A.** The `onHistoryStateUpdated` background event
covers the SPA-CSS case regardless of content-script timing. `document_start`
adds ordering complexity for little gain. Defer unless a real site fails.

### Q4. What does "survives a second Wikipedia article" mean (given Q1)?
**CURRENT EVIDENCE:** `roadmap.txt` Phase 5 Done + `06_FOUNDATION.md` MVP
row 3. Under origin+path (Q1=A), a hide on /wiki/CSS is absent on
/wiki/HTML.
**WHY IT MATTERS:** The acceptance test (§19 test 7, §20) encodes one
reading; it must match yours.
**OPTIONS:**
- A. **Strict scope.** Hide stays on A; B is untouched; returning to A
  shows the hide. Test asserts: A hidden, B visible, A-again hidden.
- B. **Propagated.** Hide applies to B. Test asserts: A hidden, B hidden.
  (Requires Q1=B, origin-only.)
**RECOMMENDATION:** **A** (consistent with Q1=A). "Survives" = the
modification is durable for its scope and is not corrupted by visiting
another page; it does not mean "applies everywhere."

### Q5. Migrate legacy origin-only journals on first load?
**CURRENT EVIDENCE:** Users (test profiles) have state under the old
`origin`-only key. After switching to `scopeKey`, that state is orphaned.
**WHY IT MATTERS:** Continuity breaks for existing installs unless migrated.
**OPTIONS:** A. one-time migration (read old key, write under scopeKey,
delete old). B. no migration (clean break; test profiles only).
**RECOMMENDATION:** **B** for now (this is pre-launch; no real users).
Add migration only if/when there are real users. Note in the report.

---

## 23. Recommended implementation order

Each step ships with its test (rule 15) and is verified by-eye before the
next.

1. **`scopeKey` + `JournalState.path`** (§8, §9). Pure unit test (test 1).
   No behaviour change yet (keep `originKey` as an alias reading legacy).
2. **Persist per-act fingerprint** in `tools/act.ts`/`loop.ts` (§5, §9).
   No replay change yet; just capture the identity.
3. **Fingerprint re-verify in `reapplyPersistedDom`** (§13). Missing-target
   reporting to storage (test 3, 4). **This is where requirement 5 lands.**
4. **`onHistoryStateUpdated` background hook** for CSS re-insert (§11, §12).
   The SPA-CSS fix (test 6). **Biggest capstone impact.**
5. **Idempotency: setText already-applied check** (§15). Test 5.
6. **Remove/replace the loop in-run replay** per Q2 answer (§10). Test 2/8.
7. **Popup surfaces `replayReport`** (§14, requirement 5 user-facing).
8. **Real-site validation**: Wikipedia second-article (test 7) + MDN + HN
   (§20). Vision-in-words. Human by-eye pass.
9. **Doc fix**: `docs/ARCHITECTURE.md` §"Persistence scope" to match the
   approved Q1 answer.

Step 4 is the highest-leverage single change (the SPA-CSS gap is the
literal "hide the sidebar stops working when you click a video" failure).
Steps 1–3 are prerequisites. Steps 5–9 are hardening + reporting.

---

## 24. What this design does NOT build (named, per CLAUDE.md)

- No second target resolver — F4 reuses `resolveTarget`.
- No second mutation/rollback system — F4 reuses the act tools + `txnLog`.
- No navigation framework, no MutationObserver defence loop.
- No site-level preference layer (Q1-C) — YAGNI.
- No `document_start` move (Q3-B) — deferred.
- No legacy migration (Q5-A) — pre-launch.
- No new persisted-clone scheme — the clone stays session-only by
  platform constraint; the serializable inverse stays the post-reload
  fallback, as F3 already documented.
- No change to F1, F3, F5, identity, the transaction layer, the loop
  structure, the budget, or the roadmap.

---

## 25. Honest state of this design

- **Proven by inspection (cited):** the live persistence, journal, identity,
  transaction, act, content, background layers; the archive prior art; the
  MV3 timing facts (`onCommitted` vs `onHistoryStateUpdated`,
  `document_idle`).
- **NOT proven:** any of the proposed behaviour. Nothing has run. The
  design is implementable but unverified. The first-paint claim for CSS on
  full navigations relies on the existing `onCommitted` path (which the
  background already trusts); the SPA-CSS fix relies on
  `onHistoryStateUpdated`, which must be wired and tested.
- **One real contradiction** (§8/§16/§22-Q1): origin+path vs origin-only.
  The roadmap says one thing, `ARCHITECTURE.md` says the opposite. This
  gates implementation and must be answered.

This document is a design. It is not a claim that F4 works.

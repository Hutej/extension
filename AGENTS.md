# WebMorph — AGENTS.md

*(Keep this file SMALL — it is auto-loaded into every prompt. Details live in the files below; read them on demand.)*

This is not just an extension — this is an AI agent that lives in your browser. WebMorph reshapes ANY website in plain English — locally, never the site's backend. Endgame: replace EVERY browser extension. The moat is generality: principles, not recipes.

## Repo map (root = WebMorph/)

- `project/` — the real codebase: extension + test harness (WXT, TypeScript strict, MV3, Playwright). All code work happens in `project/src/` and `project/tests/`.
- `.kiro/steering/product.md` — roadmap with ALL phases + sub-phases and the CURRENT POSITION. **Read before starting any task.**
- `.kiro/steering/ponytail.md` — engineering discipline. **Read before starting any task.**
- `docs/ARCHITECTURE.md` — engine pipeline, laws/constants, model config, harness gotchas. **Read before touching `project/src/`.**
- `BROWSER_LAWS/`, `RESEARCH/`, `all-about_webmorph.txt` — background reference; read only when relevant.

## Absolute rules

1. **Phase discipline:** only solve the CURRENT phase's problems (see product.md). Defer + flag everything else.
2. **Zero site-specific hardcoding.** Principles, not recipes. No aesthetic lookup tables. Test grids rotate NOVEL prompts (never reuse one).
3. **Real proof only:** real extension, real sites, real model calls, real popup→Transform flow. NEVER pass a test by loosening it. NEVER fake or overstate a result.
4. **All or nothing:** any original-looking region after a redesign = FAILURE, even if every automated check is green. The human eye is the final gate.
5. **One-shot mandate:** best design in exactly ONE paid model call; deterministic/free repair preferred; paid reReason budget 1 (log loudly as a failure signal); ≤120s hard abort per attempt; retries only on 429/5xx; log tokens per run.
6. **Do not rebuild `perceive/`** unless the audit proves it wrong (Round 7 rebuilt it — full-page, no node cap, hierarchical, family-aware). No vision/screenshot input to the design model.
7. **Security/git:** `.env` stays gitignored (public repo); push only after proven slices. Quality over speed.

## The ladder (walk it before every change)

1. Does this need to exist? → no: skip it (YAGNI)
2. Already in codebase? → reuse
3. Stdlib? → use it
4. Native platform feature? → use it
5. Installed dependency? → use it
6. One line? → one line
7. Only then: the minimum that works

## Run the harness

```
cd project && node --experimental-strip-types --env-file=.env tests/popup.test.ts
```
`WMGRID=smoke` for 1-site quick test, `WMGRID=full` (default) for 5-site grid.

## Status updates (required duty)

When a sub-phase is REALLY done — proven by eye on real sites, screenshots captured, honest report given — update `.kiro/steering/product.md`: flip that sub-phase's checkbox to done and rewrite the "Current position" section. NEVER flip a checkbox on green automated checks alone; "done" requires genuine, honest, by-eye completion. If in doubt, leave it open and say why.

## Reporting

End every task with an honest report: what shipped · what's proven (real numbers: wall-clock, paid calls, verdicts) · what failed · out-of-scope findings (flag and STOP — never expand scope on your own).

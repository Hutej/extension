# Revueon — AGENTS.md

*(Keep this file SMALL — it is auto-loaded into every prompt. Details live in the files below; read them on demand.)*

This is not just an extension — this is an AI agent that lives in your browser. Revueon reshapes ANY website in plain English — locally, never the site's backend. Endgame: replace EVERY browser extension. The moat is generality: principles, not recipes.

## Pointers (read `.kiro/steering/product.md` before any work)

- **One architectural rule:** the AI owns design decisions, the Layout IR owns structure, the solver
  owns constraints, the compiler owns CSS. No layer takes over another's responsibility.
- **Pipeline flag:** `layoutCompiler = 'v1' | 'v2'` (default `v1`; `RV_LAYOUT_COMPILER` env + popup dev
  toggle). v2 is the Layout IR -> Solver path; the two are not intertwined.
- **Ponytail ladder:** walk it before every change (below). Stop at the first rung that holds.

## Repo map (root = Revueon/)

- `project/` — the real codebase: extension + test harness (WXT, TypeScript strict, MV3, Playwright). All code work happens in `project/src/` and `project/tests/`.
- `.kiro/steering/product.md` — roadmap with ALL phases + sub-phases and the CURRENT POSITION. **Read before starting any task.**
- `docs/ARCHITECTURE.md` — engine pipeline, laws/constants, model config, harness gotchas. **Read before touching `project/src/`.**
- `docs/LAW_0_BROWSER_OWNERSHIP.md` — the governing law for all layout changes: browser owns layout, we hand it constraints. **Read before any layout emission change.**
- `all-about_revueon.txt` — background reference; read only when relevant.
- `roadmap.txt` - if you dont know in which phase you are, you can refer this and you have authority to make changes in it if the step is completed and moving on. User will not specify this in prompt you have to handle it own
  
## Absolute rules

1. **Phase discipline:** only solve the CURRENT phase's problems (see product.md). Defer + flag everything else.
2. **Zero site-specific hardcoding.** Principles, not recipes. No aesthetic lookup tables. Test grids rotate NOVEL prompts (never reuse one).
3. **Real proof only:** real extension, real sites, real model calls, real popup→Transform flow. NEVER pass a test by loosening it. NEVER fake or overstate a result.
4. **All or nothing:** any original-looking region after a redesign = FAILURE, even if every automated check is green. The human eye is the final gate.
6. **Do not rebuild `perceive/`** unless the audit proves it wrong. No vision/screenshot input to the design model. (Enrichment of `perceive/` is allowed — additive fields like `designRole`; a rebuild is not.)
7. **Security/git:** `.env` stays gitignored (public repo); push only after proven slices. Quality over speed.
8. **Layout flag:** `layoutCompiler = 'v1' | 'v2'` (default `v1`). v2 is built behind the flag; never
   intertwine the two paths.

## Run the harness

```
cd project && node --experimental-strip-types --env-file=.env tests/popup.test.ts
```
`RVGRID=smoke` for 1-site quick test, `RVGRID=full` (default) for 5-site grid.

## Status updates (required duty)

When a sub-phase is REALLY done — proven by eye on real sites, screenshots captured, honest report given — update `.kiro/steering/product.md`: flip that sub-phase's checkbox to done and rewrite the "Current position" section. NEVER flip a checkbox on green automated checks alone; "done" requires genuine, honest, by-eye completion. If in doubt, leave it open and say why.

## Reporting

End every task with an honest report: what shipped · what's proven (real numbers: wall-clock, paid calls, verdicts) · what failed · out-of-scope findings (flag and STOP — never expand scope on your own).

# AGENTS.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
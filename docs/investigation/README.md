# Revueon — Forensic Engineering Investigation

A hostile, evidence-grounded investigation of the Revueon browser extension.
**Default stance: every subsystem is broken until the code proves otherwise.**
Every claim cites `file:line` / function names. Speculation is marked **UNVERIFIED**.

## Method
Three parallel `explore` agents read **every** module in `project/src/` end-to-end and traced call chains. The 7 highest-impact claims were then re-verified directly with `read`/`grep` (shadow-DOM resolution gap, dead `clearRoleCache`, dead `bestNonBroken`, unfixed `.slice(-6)` hash, un-frozen `Map` in `deepFreeze`, dead popup auth UI, false "zero DOM mutation"). Additional cited references (`exclusions.ts:116`, `transaction.ts:95`, `documentation.ts:38`) were spot-checked and confirmed.

## Documents

| # | File | Contents |
|---|---|---|
| 01 | [SYSTEM_OVERVIEW](01_SYSTEM_OVERVIEW.md) | High-level architecture, subsystems, responsibilities, relationships, beginner explanation |
| 02 | [EXECUTION_FLOW](02_EXECUTION_FLOW.md) | User click → DOM mutation, message flow, lifecycle, sequence diagrams |
| 03 | [MODULE_BREAKDOWN](03_MODULE_BREAKDOWN.md) | Every module: purpose, I/O, deps, callers, assumptions, failure modes |
| 04 | [DATA_FLOW](04_DATA_FLOW.md) | Data movement, state changes, storage, AI context, serialization |
| 05 | [DOM_PIPELINE](05_DOM_PIPELINE.md) | Capture, analysis, mutation, observer lifecycle, rollback, selection preservation |
| 06 | [AI_PIPELINE](06_AI_PIPELINE.md) | Prompt generation, context, verification, retry, recovery, weakness |
| 07 | [ARCHITECTURE_ANALYSIS](07_ARCHITECTURE_ANALYSIS.md) | Strengths, weaknesses, coupling, scalability, design flaws |
| 08 | [ROOT_CAUSE_ANALYSIS](08_ROOT_CAUSE_ANALYSIS.md) | 10 root causes: symptom/evidence/cause/impact/repro/solution/confidence |
| 09 | [BROWSER_COMPATIBILITY](09_BROWSER_COMPATIBILITY.md) | React/Vue/Next/Shadow DOM/iframes/CSP/Trusted Types/Gmail/Notion/Figma/GitHub/YouTube/etc. |
| 10 | [PERFORMANCE_ANALYSIS](10_PERFORMANCE_ANALYSIS.md) | Bottlenecks: memory/DOM/layout/paint/AI/CPU/network |
| 11 | [SECURITY_ANALYSIS](11_SECURITY_ANALYSIS.md) | CSP, Trusted Types, permissions, injection, messaging, attack surface |
| 12 | [FAILURE_SIMULATION](12_FAILURE_SIMULATION.md) | 14 hostile scenarios: what/why/breaks/recovery/root cause |
| 13 | [RISK_REGISTER](13_RISK_REGISTER.md) | Every issue ranked Critical/High/Medium/Low with probability/impact/priority |
| 14 | [TECHNICAL_DEBT](14_TECHNICAL_DEBT.md) | Dead code, duplication, drift, untested invariants |
| 15 | [REFACTORING_ROADMAP](15_REFACTORING_ROADMAP.md) | 20 refactors: what/why/benefit/trade-offs/complexity/dependencies (NOT an impl plan) |
| 16 | [GLOSSARY](16_GLOSSARY.md) | Beginner-friendly definitions of every important concept |
| 17 | [SYSTEM_DIAGRAMS](17_SYSTEM_DIAGRAMS.md) | ASCII diagrams: architecture, message flow, DOM pipeline, AI pipeline, lifecycle, modules |

## Headline verified findings

1. **Shadow-DOM resolution gap (RC1)** — `perceive:253` walks/stamps shadow children, but `representativeFor:692`, `solve:380`, `exclusions:31` read back with light-tree `document.querySelector` → shadow clusters default to `ad-or-void` (`:819`). **YouTube and all web-component sites get no redesign.**
2. **Failed transforms leave the DOM mutated (RC3)** — `content.ts:797` runs ops before verify; failure paths (`:913,954,983,924`) roll back CSS only, never `txnLog.undoAll`. Permanent structural data loss.
3. **Dead auth UI (RC8)** — `popup:25` saves `openai_api_key`; `background:36` reads `cloudflare_*`. Every real user fails `invalid_key`.
4. **`clearRoleCache` has 0 callers (RC4)** — stale roles for the entire SPA session.
5. **`bestNonBroken` is dead code** — imported `content.ts:20`, never called; the "keep best non-broken attempt" guarantee is unenforced.
6. **PII exfiltration by design** — `reason:265` ships page text to Cloudflare with no consent/redaction.
7. **One-shot mandate structurally impossible** — ≥2 parallel paid calls + critic; retries re-bill up to 5× hidden.
8. **`deepFreeze` doesn't freeze Maps** (`ir:211`) — `byHandle` mutable; immutability contract runtime-false.

## What is genuinely solid
The deterministic expander/compile/laws layer is well-disciplined; the hard-gate *concept* is sound; the fluid-token and exclusion-registry *ideas* are right; the v2 CSS-only-grid direction is the correct escape from the SPA-re-render trap.

## Scope notes
- `project/tests/` (the Playwright harness) was NOT read in depth; harness-related claims rest on `product.md` reports and are marked UNVERIFIED.
- CSP/Trusted-Types behavior needs a runtime test matrix (marked UNVERIFIED).
- No source code was modified to produce this documentation.

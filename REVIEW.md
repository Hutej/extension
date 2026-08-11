# REVIEW.md — Origin Move

One table. From any sentence in the report to a command in under ten seconds.

| Claim | File | Command | Artefact |
|---|---|---|---|
| CSS inserted at USER origin via chrome.scripting | `src/entrypoints/background.ts` | `npm run prove` (check 9, 10, 11) | `proof/prove-results.json` |
| No style node in source | `src/core/emit.ts`, `src/entrypoints/content.ts` | `npm run prove` (check 3) | `proof/prove-results.json` |
| Emitter: structured EmitItem, no regex | `src/core/emit.ts` | `npm run prove` (check 1, 2) | `proof/prove-results.json` |
| Emitter: !important from flag, not scanning | `src/core/emit.ts` | `npm run prove` (check 1) | `proof/prove-results.json` |
| At-rules never get !important on inner | `src/core/emit.ts` | `npm run prove` (check 2) | `proof/prove-results.json` |
| assertApplied: computed style moved | `src/tools/act.ts` | `npm run prove` (check 14) | `proof/prove-results.json` |
| Budget gate: act reserve restricts, not breaks | `src/agent/loop.ts` | `npm run prove` (check 4) | `proof/prove-results.json` |
| findElements: no model call | `src/tools/observe.ts` | `npm run prove` (check 5) | `proof/prove-results.json` |
| verifySelector: accepts 1..N | `src/tools/observe.ts` | `npm run prove` (check 6) | `proof/prove-results.json` |
| Journal serialization capped | `src/agent/journal.ts` | `npm run prove` (check 7) | `proof/prove-results.json` |
| checkLayout: checks page, not own markers | `src/tools/verify.ts` | `npm run prove` (check 8) | `proof/prove-results.json` |
| Undo: removeCss via chrome.scripting | `src/agent/loop.ts` | `npm run prove` (check 10) | `proof/prove-results.json` |
| Continuity: webNavigation.onCommitted | `src/entrypoints/background.ts` | `npm run prove` (check 11) | `proof/prove-results.json` |
| Toggle off: persists enabled: false | `src/entrypoints/background.ts` | `npm run prove` (check 12) | `proof/prove-results.json` |
| Persist: keyed by origin only | `src/agent/loop.ts` | `npm run prove` (check 13) | `proof/prove-results.json` |
| Manifest: scripting + webNavigation | `wxt.config.ts` | `npm run prove` (check 9) | `proof/prove-results.json` |
| Red test (5 variants) | `tests/red-test.ts` | `node --experimental-strip-types tests/red-test.ts` | `proof/red-test-results.json` |
| Red test variant 5 (inline !important) | `tests/red-test.ts` | `node --experimental-strip-types tests/red-test.ts` | `proof/red-v5a-*.txt`, `proof/red-v5b-*.txt` |
| Cold-nav flash: not measured | (report) | `npm run prove` (check 15) | N/A — report says "not measured" |
| Extension builds | `wxt.config.ts` | `npm run build` | `.output/chrome-mv3/` |
| TypeScript compiles | `tsconfig.json` | `npx tsc --noEmit` | (no output = pass) |

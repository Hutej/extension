# Phase 1 Finishing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use compose:subagent (recommended) or compose:execute to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish Phase 1 of WebMorph — give the engine eyes (rendered-pixel verification), fluidity (designs that survive resize/zoom/devtools), a living page (dynamic + shadow content inherits the design), latency discipline (≤2 visible paints, accounted ledger, model bake-off), design-quality laws (contrast-from-pixels, accent accounting, typography, width-utilization, containment), and product hygiene (broad fast-path, vague prompts, scrubbed comments, escape-hatch + persistence proofs).

**Architecture:** The Round-7 pipeline stands: `perceive → reason → compile → verify → repair → persist`. This work adds organs, it does not rebuild the spine. The centerpiece is WS1: after `apply`, verification reads **rendered pixels** (not just computed styles) via screenshots at 3 scroll positions, and four deterministic detectors (void / invisible-text / squeeze / recolor) feed the repair router with pixel-grounded critiques. WS2 makes the compiler emit fluid units by law so designs survive viewport change. WS3 generalizes selectors and detects new shadow roots so un-perceived content inherits the design. WS4 batches repairs (≤2 visible paints), accounts the ledger to wall-clock, and runs a model bake-off. WS5 root-causes contrast from sampled pixels, counts canvas-held accent, and encodes typography/measure/containment/width-utilization as compiler laws + verify checks. WS6 broadens the fast-path router, scrubs site-name comments, and hardens escape-hatch + persistence proofs.

**Tech Stack:** WXT + TypeScript strict + MV3, Playwright harness, OpenAI Chat Completions (gpt-5 family). Pure unit checks via `node --experimental-strip-types`; e2e via `project/tests/popup.test.ts`.

---

## Global Constraints

- **Phase discipline:** only Phase-1 (restyle) problems. moves[] execution stays deferred to Phase 2; routing for "move" is in scope, execution is not.
- **Zero site-specific hardcoding:** engine source (`project/src/`) branches on NO domain and names NO site in comments. Test grid (`project/tests/`) legitimately exercises 5 real sites with novel prompts.
- **Real proof only:** real extension, real sites, real model calls, real popup→Transform flow. Never pass a test by loosening it. Never fake or overstate.
- **One-shot mandate:** best design in exactly ONE paid model call; deterministic/free repair preferred; paid reReason budget 1 (logged as a failure signal); ≤120s hard abort per attempt; retries only on 429/5xx; log tokens per run.
- **Tests-first, fail-first:** the harness acceptance checks ARE the specification. New checks are written/ strengthened BEFORE workstream code, run against the current build, and the failures recorded. Workstream code exists to turn them green. Never write a check after the code it validates.
- **All-or-nothing:** any original-looking region after a redesign = failure, even if every automated check is green. The human eye is the final gate.
- **Stop conditions:** any spec/reality conflict, threshold to loosen, task to defer, or latency bar to trade away → flag-and-stop, never self-approve. Dropping a task silently = a failed round.
- **Priority if anything gives:** WS1 → WS2 → WS3 → WS4 → WS5 → WS6. Whatever gives is flag-and-stop, never silently dropped.
- **Harness run cmd:** `cd project && node --experimental-strip-types --env-file=.env tests/popup.test.ts` (`WMGRID=smoke` 1-site, `WMGRID=full` 5-site).
- **Ponytail:** climb the ladder before any code — need-to-exist → reuse → stdlib → native → installed dep → one line → minimum that works. Mark deliberate shortcuts with `ponytail:`.

---

## Part A — Auditable Brief (workstream order, mechanisms, deviations)

This is the artifact the work order demands committed before implementation. It is audited after the merge.

### Workstream order (priority-mandated, not negotiable)
1. **WS1 — EYES** (centerpiece): rendered-pixel verification feeding the repair router.
2. **WS2 — FLUIDITY:** compiler fluid-unit law + multi-viewport/zoom/resize re-verify.
3. **WS3 — LIVING PAGE:** signature-generalized selectors + new shadow-root detection.
4. **WS4 — LATENCY:** ≤2 visible paints, accounted ledger, serialization budget, bake-off.
5. **WS5 — DESIGN QUALITY:** contrast-from-pixels, accent accounting, typography/measure/containment/width laws.
6. **WS6 — PRODUCT HYGIENE:** broad fast-path, vague prompts, scrubbed comments, escape-hatch + persistence proofs.

### Mechanisms chosen
- **Pixel capture (WS1):** HARNESS screenshots at 3 scroll positions (already scaffolded as `pixelAudit`); PRODUCT path via `chrome.tabs.captureVisibleTab` in the content script, fed to a new `pixelVerify` stage that runs AFTER DOM-`verify`. Both feed the repair router.
- **Four detectors (WS1):** void (large uniform-color region overlapping a content rect), invisible-text (near-zero pixel variance inside a rendered text rect), squeeze (rendered chars-per-line below floor — measured from pixel text bounds, not just DOM), recolor (downscaled before/after edge-map + hue-shift comparison: identical structure + hue-only shift = recolor). All Tier-1, deterministic, zero model calls.
- **Repair router wiring (WS1):** pixel critiques appended to the existing `planRepair` decision so a by-eye-killer is mechanically impossible to report PASS. `verify.passed` becomes `domPassed && pixelPassed`.
- **Fluid law (WS2):** a `fluidize()` compiler pass converts viewport-derived raw px sizing values into fluid units (`min(Xpx, 100%)` is already emitted for widths — extend to all BOX_GROWTH_KEYS and font-sizes that derive from a one-viewport measurement). Unit-test the conversion. Specs store intent; persisted CSS is audited to contain no frozen one-viewport px in sizing keys.
- **Multi-condition re-verify (WS2):** harness re-runs `pixelAudit` at a 2nd viewport width AND 80%/125% zoom AND post-resize. Runtime: debounced resize/zoom listener → free re-perceive + re-compile + re-verify (no paid calls).
- **Signature generalization (WS3):** for clusters with a stable, specific signature (tag + ≥1 distinctive non-utility class, count>1), the compiler emits an ADDITIONAL signature selector (`tag.specificClass`) alongside the handle selector, guarded so it cannot over-match unrelated nodes. New shadow roots are detected via a body-level observer that re-runs shadow discovery + style injection.
- **Paint batching (WS4):** the repair loop computes ALL repair option changes as a batch, then does ONE merged re-apply. Visible paints instrumented via `data-webmorph-paint-count` on `<html>`, incremented in `applyStyleEverywhere`. ≤2 = pass; a 3rd = failing check.
- **Ledger accounting (WS4):** add `unaccountedMs` = `totalMs − (perceive + model + compile + apply + verify + pixelVerify + persist)` so the ~44s GitHub gap is visible by site, not hidden.
- **Bake-off (WS4):** `WM_MODEL` env override on `AI_CONFIG.styleModel`; a `WMGRID=bakeoff` mode runs the grid once per model in `[gpt-5, gpt-5.1, gpt-5.2, gpt-4o]`, emits a comparison table (model × applied × quality× latency × tokens) to `docs/compose/reports/bakeoff.md`.
- **Contrast from pixels (WS5):** `effectiveBackground` samples the rendered pixel behind the text from WS1's capture instead of the DOM parent-chain walk (which falls back to white on gradient/transparent panels).
- **Accent accounting (WS5):** `measureAccentAreaFraction` adds the canvas background's saturated area to the numerator so a vivid canvas reads as accent (the Carnival flatness failure).
- **Typography/containment/width laws (WS5):** compiler refuses narrowing below a readable measure (already has `MIN_CHARS_PER_LINE` in verify — promote to a compiler refusal on `maxWidth`/`width` that would break measure); line-height floor on body text; containment law = a child's painted bg must not exceed its parent's content box (verify check). Width-utilization metric = content-column area ÷ viewport area from rendered pixels.
- **Fast-path router (WS6):** `classifyIntent` extended to a sub-second classifier with more deterministic paths: `hide`, `bigger-text`/`smaller-text` (clamp font-size on body/primary), `remove-sidebar` (hide a complementary/nav region). "move this" intents classify to a `move` kind that returns a Phase-2-deferred message (routing in scope, execution deferred).

### Deviations from the architect's methodology (with reasoning)
1. **The harness already contains most acceptance checks** (a prior round scaffolded `pixelAudit`, `multiViewportCheck`, `zoomCheck`, `devtoolsCheck`, `scrollLoadCheck`, `paintCountCheck`, `escapeHatchCheck`, `structuredReportCheck`, `VAGUE_SITES`). Deviation: tests-first is **harden + complete**, not create-from-scratch. I will (a) close the loopholes that make existing checks trivially pass against the current build, (b) add the missing detectors (squeeze-in-harness, recolor, captureVisibleTab product path, multi-condition pixel re-verify), then run the grid to record honest failures.
2. **`paintCountCheck` loophole:** the content script never sets `data-webmorph-paint-count`, so the check reads `0` and trivially passes (0 ≤ 2). Deviation: the hardened check treats an **absent** attribute as a FAILURE (uninstrumented), so it genuinely fails first; WS4 instruments + batches to turn it green.
3. **Signature generalization safety:** the architect says "compile cluster-signature-level CSS where safe." Full signature-keyed selectors (`div.foo`) risk styling unrelated future nodes. Deviation: emit a signature selector ONLY for clusters with (tag + ≥1 distinctive non-utility class + count>1), AND only the paint/typography subset (never hide, never layout that moves geometry), so the blast radius of an over-match is cosmetic, not structural. The existing deterministic re-stamp defender stays as the primary mechanism; signature selectors are a zero-latency bonus for the common scroll-loaded-sibling case.
4. **Model bake-off cost:** it requires real paid calls across ≥3 models on the 5-site grid (15+ paid calls + ~15min). Per the stop-conditions this is the most likely flag-and-stop item. I will run it last in WS4; if budget/time/env is exhausted, I flag-and-stop with the structured-table skeleton + the models actually run, never silently.
5. **No-vision rule preserved:** still NO vision input at design time. Pixels are used only post-apply for verification. A cheap vision model as Tier-2 is pre-built only if Tier-1 insufficiency is proven with data (flag-and-stop, not pre-built).
6. **Comment scrub scope:** "scrub every site-name comment from the source" applies to `project/src/` engine code (regression-story comments like "BBC mutilation", "Wikipedia white-strip", "YouTube timeout", "GitHub recolor" → generic descriptions). The test grid in `project/tests/popup.test.ts` legitimately names the 5 real sites it exercises; those names stay. `docs/ARCHITECTURE.md` site-name references in "hard-won lessons" are genericized too (it is reference, but the rule says "zero site-specific anything, comments included").

### Stop-conditions I will honor (not self-approve)
- If the env lacks `OPENAI_API_KEY` or the grid cannot run real paid calls in this environment → I cannot produce "real proof"; I flag-and-stop grid-dependent tasks and ship only what is unit-test-proven, stating the gate honestly.
- If a detector threshold needs loosening to pass a site → flag with data, never silently adjust.
- If a workstream item cannot meet a hard bar (≤120s, ≤2 paid calls, ≤2 paints) → stop that item with evidence, do not trade the bar away.

---

## Part B — Tests-First Harness Hardening (the failing tests that ARE the spec)

The harness already scaffolds most checks. This part CLOSES LOOPHOLES and ADDS THE MISSING CHECKS so they genuinely fail against the current build. Run the grid after this part to record the baseline failures. Workstream code (Part C) turns them green.

### Task 0: Close the `paintCountCheck` loophole + add the missing detectors to the harness

**Covers:** WS4 (paint count), WS1 (squeeze-in-harness, recolor, multi-condition pixel re-verify)

**Files:**
- Modify: `project/tests/popup.test.ts` (harden `paintCountCheck`; add `squeezeCheck`, `recolorCheck`, `captureVisibleTabCheck`; extend `runPostApplyChecks` + `PostApplyChecks` interface; re-run pixel audit at 2nd viewport + zoom)

**Interfaces:**
- Consumes: `data-webmorph-paint-count` attribute set by WS4 on `<html>` (absent → fail until WS4).
- Produces: a hardened `PostApplyChecks` with `paintCount`, `squeeze`, `recolor`, `multiConditionPixel` fields that the assertion block gates.

- [ ] **Step 1: Write the failing hardened checks**

Add to `PostApplyChecks` interface:
```ts
interface PostApplyChecks {
  pixelVoids: number;
  pixelInvisibleText: number;
  pixelSqueeze: number;          // NEW (WS1): rendered chars-per-line below floor
  recolor: boolean;             // NEW (WS1): structure-identical + hue-only shift
  multiConditionPixel: boolean; // NEW (WS2): pixel audit holds at 2nd viewport + zoom
  multiViewport: boolean;
  zoomCheck: boolean;
  devtools: boolean;
  scrollLoad: boolean | null;
  paintCount: number;            // now FAILS when attribute absent (was a no-op)
  escapeHatch: boolean;
  structuredReport: boolean;
  pixelDetails: string[];
}
```

Harden `paintCountCheck` (absent attribute = fail, not 0):
```ts
async function paintCountCheck(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const v = document.documentElement.dataset['webmorphPaintCount'];
    if (v === undefined) return -1;          // uninstrumented -> assertion fails
    return parseInt(v, 10) || 0;
  });
}
```

Add `squeezeCheck` (rendered, pixel-grounded — measures actual line breaks from the DOM text rect, not the verify-DOM proxy):
```ts
/** WS1 squeeze detector: a text cluster whose rendered chars-per-line < MIN_CHARS_PER_LINE.
 *  Pixel-grounded: uses the element's ACTUAL rendered clientWidth + fontSize, and
 *  requires >=3 lines of text so a short label isn't a false positive. */
async function squeezeCheck(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const MIN_CPL = 12;
    let squeezed = 0;
    for (const el of Array.from(document.querySelectorAll('[data-wm-c]'))) {
      if (el.hasAttribute('data-webmorph-ui') || !(el instanceof HTMLElement)) continue;
      const text = (el.textContent || '').trim();
      if (text.length < 80) continue;            // need real prose, not a label
      const r = el.getBoundingClientRect();
      if (r.width < 50 || r.height < 40) continue;
      const cs = getComputedStyle(el);
      const fs = parseFloat(cs.fontSize) || 16;
      const cpl = el.clientWidth / (fs * 0.5);
      // >=3 lines heuristic: height > 2.5 * fontSize * lineHeight
      const lh = parseFloat(cs.lineHeight) || 1.5;
      if (el.clientHeight > fs * lh * 2.5 && cpl < MIN_CPL) squeezed++;
    }
    return squeezed;
  });
}
```

Add `recolorCheck` (downscaled before/after edge-map + hue-shift):
```ts
/** WS1 recolor detector: structure-identical (same edge map) + hue-only shift =
 *  a recolor, not a redesign. Compares the stored BEFORE full-page screenshot
 *  to the AFTER screenshot, downscaled to 64px wide. */
async function recolorCheck(page: Page, beforePath: string): Promise<boolean> {
  const fs = await import('node:fs');
  if (!fs.existsSync(beforePath)) return false;     // no before -> cannot claim recolor
  const beforeBuf = fs.readFileSync(beforePath);
  const afterBuf = await page.screenshot({ type: 'png' });
  const res = await page.evaluate(async (b64: string, a64: string) => {
    const load = (b64: string) => new Promise<{ edges: number[]; hues: number[] }>((resolve) => {
      const img = new Image();
      img.onload = () => {
        const W = 64;
        const H = Math.round((img.naturalHeight / img.naturalWidth) * W) || 64;
        const c = document.createElement('canvas'); c.width = W; c.height = H;
        const ctx = c.getContext('2d')!; ctx.drawImage(img, 0, 0, W, H);
        const d = ctx.getImageData(0, 0, W, H).data;
        const edges: number[] = []; const hues: number[] = [];
        for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
          const i = (y * W + x) * 4;
          const gx = Math.abs(d[i] - d[i - 4]) + Math.abs(d[i + 1] - d[i - 3]) + Math.abs(d[i + 2] - d[i - 2]);
          edges.push(gx > 40 ? 1 : 0);
          // hue via simple RGB max-min
          const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
          hues.push(mx === mn ? -1 : Math.atan2(Math.SQ1_2 * (d[i + 1] - d[i + 2]), d[i] - (d[i + 1] + d[i + 2]) / 2));
        }
        resolve({ edges, hues });
      };
      img.onerror = () => resolve({ edges: [], hues: [] });
      img.src = b64;
    });
    const a = await load('data:image/png;base64,' + b64);
    const b = await load('data:image/png;base64,' + a64);
    if (!a.edges.length || a.edges.length !== b.edges.length) return false;
    // structure identical? edge agreement >= 0.92
    let agree = 0; for (let i = 0; i < a.edges.length; i++) if (a.edges[i] === b.edges[i]) agree++;
    const structIdentical = agree / a.edges.length >= 0.92;
    // hue-only shift? hues differ but luminance (proxied by max+min) similar
    let hueDiff = 0, lumDiff = 0, n = 0;
    for (let i = 0; i < a.hues.length; i++) {
      if (a.hues[i] < 0 || b.hues[i] < 0) continue;
      hueDiff += Math.abs(a.hues[i] - b.hues[i]); lumDiff += 0; n++;
    }
    const hueShift = n ? hueDiff / n : 0;
    return structIdentical && hueShift > 0.5;   // structure same + hue moved = recolor
  }, beforeBuf.toString('base64'), afterBuf.toString('base64'));
  return res;
}
```

Add `multiConditionPixelCheck` (re-run the pixel audit at a 2nd viewport width + 80% zoom):
```ts
/** WS2: the pixel audit must hold at a 2nd viewport width AND at 80% zoom — not just
 *  the capture viewport. Fluid-by-construction CSS should pass both. */
async function multiConditionPixelCheck(page: Page): Promise<boolean> {
  const orig = page.viewportSize();
  // 2nd viewport width
  if (orig) { await page.setViewportSize({ width: Math.round(orig.width * 0.75), height: orig.height }); await page.waitForTimeout(500); }
  const a = await pixelAudit(page);
  if (orig) await page.setViewportSize(orig);
  // 80% zoom (CSS zoom)
  await page.evaluate(() => { (document.body.style as unknown as { zoom: string }).zoom = '0.8'; });
  await page.waitForTimeout(400);
  const b = await pixelAudit(page);
  await page.evaluate(() => { (document.body.style as unknown as { zoom: string }).zoom = ''; });
  return a.voids === 0 && a.invisibleText === 0 && b.voids === 0 && b.invisibleText === 0;
}
```

Wire them into `runPostApplyChecks` (add `recolorCheck` using the stored before screenshot path — pass it in):
```ts
async function runPostApplyChecks(page: Page, site: SiteSpec, resultJson: string, beforePath: string): Promise<PostApplyChecks> {
  const pixel = await pixelAudit(page);
  const squeeze = await squeezeCheck(page);
  const recolor = await recolorCheck(page, beforePath);
  const mcp = await multiConditionPixelCheck(page);
  const mv = await multiViewportCheck(page);
  const zoom = await zoomCheck(page);
  const dt = await devtoolsCheck(page);
  const sl = site.isSPA || site.isShadowDOM ? await scrollLoadCheck(page) : null;
  const pc = await paintCountCheck(page);
  const eh = await escapeHatchCheck(page);
  const sr = structuredReportCheck(resultJson);
  return {
    pixelVoids: pixel.voids, pixelInvisibleText: pixel.invisibleText, pixelSqueeze: squeeze,
    recolor, multiConditionPixel: mcp, multiViewport: mv, zoomCheck: zoom, devtools: dt,
    scrollLoad: sl, paintCount: pc, escapeHatch: eh, structuredReport: sr, pixelDetails: pixel.details,
  };
}
```

Extend the assertion block (after the existing post-apply asserts):
```ts
    if (r.applied && r.postApply) {
      const pa = r.postApply;
      if (pa.pixelVoids > 0) { console.log(`    ✗ FAIL: pixel audit found ${pa.pixelVoids} void(s)`); failures++; }
      if (pa.pixelInvisibleText > 0) { console.log(`    ✗ FAIL: pixel audit found ${pa.pixelInvisibleText} invisible-text cluster(s)`); failures++; }
      if (pa.pixelSqueeze > 0) { console.log(`    ✗ FAIL: pixel audit found ${pa.pixelSqueeze} squeezed text cluster(s)`); failures++; }
      if (pa.recolor) { console.log(`    ✗ FAIL: recolor detector (structure-identical + hue-only shift)`); failures++; }
      if (!pa.multiConditionPixel) { console.log(`    ✗ FAIL: multi-condition pixel audit (2nd viewport or 80% zoom)`); failures++; }
      if (!pa.multiViewport) { console.log(`    ✗ FAIL: multi-viewport check (overflow on resize)`); failures++; }
      if (!pa.zoomCheck) { console.log(`    ✗ FAIL: zoom check (overflow or content lost at 80%/125%)`); failures++; }
      if (!pa.devtools) { console.log(`    ✗ FAIL: devtools simulation (overflow on 30% shrink)`); failures++; }
      if (pa.scrollLoad === false) { console.log(`    ✗ FAIL: scroll-load proof (new content not styled)`); failures++; }
      if (pa.paintCount < 0 || pa.paintCount > 2) { console.log(`    ✗ FAIL: paint count ${pa.paintCount} (uninstrumented or >2 visible paints)`); failures++; }
      if (!pa.escapeHatch) { console.log(`    ✗ FAIL: escape hatch (On/Off did not remove style)`); failures++; }
      if (!pa.structuredReport) { console.log(`    ✗ FAIL: structured report (missing stage ledger / serialized chars)`); failures++; }
    }
```

- [ ] **Step 2: Pass `beforePath` through `transformSite` → `runPostApplyChecks`**

`transformSite` already captures `before_${site.name}.png`. Thread that path into `runPostApplyChecks(page, site, resultJson, path.join(ARTIFACTS_DIR, 'before_' + site.name + '.png'))`.

- [ ] **Step 3: Run the harness against the current build; record the honest baseline failures**

Run: `cd project && node --experimental-strip-types --env-file=.env tests/popup.test.ts` (WMGRID=smoke first).
Expected: paint-count FAIL (uninstrumented, returns −1), and whichever of squeeze/recolor/multi-condition fail against the current build. Record these in `docs/compose/reports/baseline-failures.md`.

- [ ] **Step 4: Commit**

```
git add project/tests/popup.test.ts docs/compose/reports/baseline-failures.md
git commit -m "test: harden harness — close paint-count loophole, add squeeze/recolor/multi-condition pixel checks (tests-first, fail-first)"
```

---

## Part C — Workstream Tasks (WS1 → WS6)

Each workstream below lists its tasks. Failing-test code is complete (tests are the spec); implementation contracts name the exact functions/signatures the execution writes. Execution writes the full bodies via TDD.

### WS1 — EYES: rendered-pixel verification (centerpiece)

**Goal:** After `apply`, the engine reads rendered pixels. Four deterministic detectors (void / invisible-text / squeeze / recolor) feed the repair router with pixel-grounded critiques. A by-eye-killer is mechanically impossible to report as PASS. Tier-1 only; a vision model (Tier-2) is built only if Tier-1 insufficiency is proven with data (flag-and-stop, not pre-built).

**Files:**
- Create: `project/src/core/verify/pixel.ts` (pure pixel detectors — pure so unit-testable)
- Create: `project/src/core/verify/capture.ts` (product path: `captureVisibleTab` → `PixelInput` at 3 scroll positions)
- Modify: `project/src/core/verify/index.ts` (`pixelVerify` stage; `passed := domPassed && pixelPassed`)
- Modify: `project/src/core/repair/index.ts` (consume pixel critiques)
- Modify: `project/src/entrypoints/content.ts` (capture + pixelVerify wired)
- Modify: `project/src/entrypoints/background.ts` (`captureVisibleTab` relay — MV3 service worker owns it)
- Modify: `project/tests/compile.test.ts` (pure detector unit checks)

**Interfaces:**
- Consumes: `PixelInput = { width; height; data: Uint8ClampedArray }`; `ClusterRect = { handle; rect: {x,y,w,h}; text; fontSize? }`.
- Produces: `PixelVerifyResult { voids: string[]; invisibleText: string[]; squeeze: string[]; passed: boolean; critiques: string[] }`.

#### Task 1.1: Pure pixel detectors (void / invisible-text / squeeze / recolor)

- [ ] **Step 1: Write failing pure unit checks** (add to `compile.test.ts` — the pure-check home):
```ts
import { detectVoids, detectInvisibleText, detectSqueeze, detectRecolor, type PixelInput, type ClusterRect } from '../src/core/verify/pixel.ts';
function img(solid: [number,number,number], w: number, h: number): PixelInput {
  const data = new Uint8ClampedArray(w*h*4);
  for (let i=0;i<w*h;i++){data[i*4]=solid[0];data[i*4+1]=solid[1];data[i*4+2]=solid[2];data[i*4+3]=255;}
  return { width:w, height:h, data };
}
function imgText(bg:[number,number,number],fg:[number,number,number],w:number,h:number,rect:{x:number;y:number;w:number;h:number}):PixelInput {
  const d=img(bg,w,h);
  for(let y=rect.y;y<rect.y+rect.h;y++)for(let x=rect.x;x<rect.x+rect.w;x++){if((x+y)%2===0){const i=(y*w+x)*4;d.data[i]=fg[0];d.data[i+1]=fg[1];d.data[i+2]=fg[2];}}
  return d;
}
// VOID: large uniform empty cluster -> flagged
assert.ok(detectVoids(img([255,255,255],800,600), [{handle:'c1',rect:{x:100,y:100,w:400,h:300},text:''}]).includes('c1'), 'px: void');
assert.ok(!detectVoids(imgText([255,255,255],[0,0,0],800,600,{x:100,y:100,w:400,h:300}), [{handle:'c2',rect:{x:100,y:100,w:400,h:300},text:'x'.repeat(200)}]).includes('c2'), 'px: text-bearing not void');
// INVISIBLE TEXT: zero-variance text rect -> flagged
assert.ok(detectInvisibleText(img([20,20,20],400,200), [{handle:'c3',rect:{x:10,y:10,w:380,h:180},text:'x'.repeat(60)}]).includes('c3'), 'px: invisible');
assert.ok(!detectInvisibleText(imgText([20,20,20],[240,240,240],400,200,{x:10,y:10,w:380,h:180}), [{handle:'c4',rect:{x:10,y:10,w:380,h:180},text:'x'.repeat(60)}]).includes('c4'), 'px: visible not flagged');
// SQUEEZE: rect width < MIN_CPL * fontSize * 0.5
assert.ok(detectSqueeze({handle:'c5',rect:{x:0,y:0,w:40,h:200},text:'x'.repeat(120),fontSize:16}).includes('c5'), 'px: squeezed (5cpl)');
assert.ok(!detectSqueeze({handle:'c6',rect:{x:0,y:0,w:600,h:200},text:'x'.repeat(120),fontSize:16}).includes('c6'), 'px: 75cpl not squeezed');
// RECOLOR: same structure + hue shift -> true
assert.strictEqual(detectRecolor(img([200,50,50],64,64), img([50,50,200],64,64)), true, 'px: recolor');
assert.strictEqual(detectRecolor(img([200,50,50],64,64), imgText([200,50,50],[255,255,255],64,64,{x:10,y:10,w:40,h:40})), false, 'px: structure changed not recolor');
```

- [ ] **Step 2: Run to verify fail** (`detectVoids is not a function`).
- [ ] **Step 3: Implement `core/verify/pixel.ts`** with the four pure functions matching the contract. Keep pure — no DOM.
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** — `feat(verify/pixel): pure rendered-pixel detectors`

#### Task 1.2: Product capture path (`captureVisibleTab`) + 3 scroll positions

- [ ] **Step 1: Failing unit check** for `capture.ts` orchestration:
```ts
import { captureAtPositions } from '../src/core/verify/capture.ts';
{ const calls:number[]=[]; const shot=async(y:number)=>{calls.push(y);return {width:1,height:1,data:new Uint8ClampedArray(4)};};
  const out=await captureAtPositions([0,500,1000],shot);
  assert.strictEqual(out.length,3,'capture: 3 shots'); assert.deepStrictEqual(calls,[0,500,1000],'capture: order'); }
```
- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement `core/verify/capture.ts`** — `captureAtPositions` + `screenshotToPixelInput(png: Buffer): Promise<PixelInput>`.
- [ ] **Step 4: Background relay** in `background.ts`:
```ts
chrome.runtime.onMessage.addListener((m,_s,send)=>{ if(m.action==='captureVisibleTab'){chrome.tabs.captureVisibleTab({format:'png'},(d)=>send({ok:!!d,dataUrl:d}));return true;} /*existing*/});
```
- [ ] **Step 5: Wire `content.ts`** — after apply, capture at scroll 0/mid/deep, run `pixelVerify`, feed repair.
- [ ] **Step 6: Commit** — `feat(verify/capture): captureVisibleTab product path wired`

#### Task 1.3: Detectors gate `passed` + feed repair critiques

- [ ] **Step 1: Implement `pixelVerify`** in `verify/index.ts`:
```ts
export function pixelVerify(captures: PixelInput[], rects: ClusterRect[]): PixelVerifyResult {
  const voids:string[]=[],invisible:string[]=[],squeeze:string[]=[];
  for(const c of captures){voids.push(...detectVoids(c,rects));invisible.push(...detectInvisibleText(c,rects));}
  for(const cr of rects) if(detectSqueeze(cr).includes(cr.handle)) squeeze.push(cr.handle);
  const passed = voids.length===0 && invisible.length===0 && squeeze.length===0;
  return {voids,invisibleText:invisible,squeeze,passed,critiques:[...voids.map(h=>`cluster ${h} renders as a blank void`),...invisible.map(h=>`cluster ${h} renders invisible against its effective background`),...squeeze.map(h=>`cluster ${h} text squeezed below readable measure`)]};
}
```
- [ ] **Step 2: Fold into the loop** — `passed := domPassed && pixelPassed`; append `pixelVerify.critiques` to the reReason critique. The harness `pixelInvisibleText`/`pixelVoids`/`pixelSqueeze` assertions (Task 0) now gate PASS.
- [ ] **Step 3: Run smoke grid** — verify a real site with a void/invisible cluster no longer reports PASS.
- [ ] **Step 4: Commit** — `feat(verify): pixelVerify gates passed + feeds pixel-grounded critiques`

#### Task 1.4: Tier-1 insufficiency gate (no pre-built vision Tier-2)

- [ ] After WS1 ships, run the full grid. If any by-eye-killer passes Tier-1, record it in `docs/compose/reports/tier1-insufficiency.md` (site + screenshot + which detector missed) and flag-and-stop. Only then consider a Tier-2 vision model.
- [ ] Commit the (possibly empty) insufficiency report.

### WS2 — FLUIDITY: the design must survive reality

**Goal:** Emitted CSS speaks fluid units by law; specs store intent not measurements; harness re-verifies (incl. pixel audit) at 2nd viewport + 80%/125% zoom + after resize; runtime re-adapts for free.

**Files:**
- Modify: `project/src/core/compile/index.ts` (`fluidize()` guard)
- Modify: `project/src/core/laws/index.ts` (`fluidizeLength`, `FLUIDIZE_SIZING_KEYS`)
- Modify: `project/src/core/persist/index.ts` (persist audit)
- Modify: `project/src/entrypoints/content.ts` (resize/zoom free re-verify)
- Modify: `project/tests/compile.test.ts`

#### Task 2.1: `fluidizeLength` + raw-px ban

- [ ] **Step 1: Failing unit test** (compile.test.ts):
```ts
import { fluidizeLength } from '../src/core/laws/index.ts';
assert.strictEqual(fluidizeLength('width','1280px',{viewportW:1280}),'min(1280px, 100%)','fluid: px width');
assert.strictEqual(fluidizeLength('maxWidth','960px',{viewportW:1280}),'min(960px, 100%)','fluid: px maxWidth');
assert.strictEqual(fluidizeLength('width','80%',{viewportW:1280}),'80%','fluid: % passthrough');
assert.strictEqual(fluidizeLength('width','min(700px, 90vw)',{viewportW:1280}),'min(700px, 90vw)','fluid: already-fluid passthrough');
assert.strictEqual(fluidizeLength('fontSize','4rem',{viewportW:1280}),'4rem','fluid: fontSize not fluidized here');
```
- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement `fluidizeLength(key,val,{viewportW})`** in `laws/index.ts` — `BOX_GROWTH_KEYS` raw px → `min(Xpx,100%)`; relative/%/clamp/min passthrough.
- [ ] **Step 4: Failing compile test** — `assert.ok(!/(^|[\s{;])(width|max-width|min-width)\s*:\s*\d+px\s*!important/.test(compileSpec(...).css), 'fluid: no raw px sizing')`.
- [ ] **Step 5: Implement** the post-compile guard in `compile/index.ts` (strip + log any raw-px sizing that slipped through; route growth keys through `fluidizeLength`).
- [ ] **Step 6: Commit** — `feat(compile/laws): fluidize() law — raw px sizing banned from emitted CSS`

#### Task 2.2: Specs store intent; persist audit

- [ ] **Step 1: Failing test** — harness reload step reads `chrome.storage.local` css and asserts no raw-px sizing.
- [ ] **Step 2: Implement `persistAudit(css)`** in `persist/index.ts` — same no-raw-px regex; log loudly on failure (a non-fluidized compile leaked).
- [ ] **Step 3: Commit** — `feat(persist): audit persisted CSS for frozen one-viewport px`

#### Task 2.3: Runtime resize/zoom re-adaptation (free)

- [ ] **Step 1: Failing test** — harness `multiConditionPixelCheck` (Task 0) already covers 2nd viewport + 80% zoom; ensure it gates.
- [ ] **Step 2: Implement** — `content.ts` `scheduleRestyle` already fires on resize; ensure it also re-runs `pixelVerify` (free) and applies deterministic repair (e.g. `clampTargets`) if a detector trips — no paid call.
- [ ] **Step 3: Commit** — `feat(content): free re-verify + deterministic repair on resize/zoom`

#### Task 2.4: Devtools simulation test

- [ ] **Step 1: Failing test** — already scaffolded (`devtoolsCheck` shrinks 30%).
- [ ] **Step 2: Implement** — fluid CSS should pass without new code; if it fails, Task 2.1's fluidize law is the fix. Add code only if a non-fluid path is found.
- [ ] **Step 3: Commit** (if a fix was needed) — `fix: devtools-shrink overflow via fluidize`

### WS3 — THE LIVING PAGE: dynamic content

**Goal:** un-perceived scroll-loaded siblings inherit the design via signature selectors; new shadow roots detected + styled; explicit proofs on YouTube scroll + sidebar expand + ≥2 scroll regions.

**Files:**
- Modify: `project/src/core/compile/index.ts` (signature selectors)
- Modify: `project/src/core/perceive/index.ts` (`signatureClasses` on Cluster)
- Modify: `project/src/entrypoints/content.ts` (new shadow-root detection)
- Modify: `project/tests/popup.test.ts` (2-scroll-region test; `scrollLoadCheck` asserts *styled*)

#### Task 3.1: Signature-generalized selectors (safe subset)

- [ ] **Step 1: Failing compile test**:
```ts
const cards = cluster({ handle:'ccard', selector:'[data-wm-c="ccard"]', tag:'article', count:6,
  signatureClasses:['product-card'], layout:layout({widthRatio:0.3}),
  style:{...cluster({}).style, background:'rgb(255,255,255)'} });
const p = perception([cards]);
const r = compileSpec({reasoning:'',canvas:{background:'#0a0a0a',color:'#f5f5f5'},
  rules:[{target:'ccard',styles:{background:'#111',color:'#fff',borderRadius:'8px'}}]}, p);
assert.ok(r.css.includes('article.product-card'), 'sig: signature selector emitted');
assert.ok(r.css.includes('[data-wm-c="ccard"]'), 'sig: handle selector still emitted');
assert.ok(!/article\.product-card[^}]*display:\s*none/.test(r.css), 'sig: no hide on signature selector');
```
- [ ] **Step 2: Run to verify fail** (`signatureClasses` not on Cluster).
- [ ] **Step 3: Implement** — add `signatureClasses?: string[]` to `Cluster`; perception populates from distinctive non-utility classes. In compile, for `tag + signatureClasses.length>=1 + count>1`, emit a second selector group for the PAINT subset only (styles bag; never hide, never geometry-moving layout). `ponytail: signature selector cosmetic-only — never hide/layout, blast radius of over-match is paint not structure; upgrade to full if a regression proves safety`.
- [ ] **Step 4: Commit** — `feat(compile): safe signature selectors for scroll-loaded siblings`

#### Task 3.2: New shadow-root detection + injection

- [ ] **Step 1: Failing harness test** — on a shadow-DOM site, after apply, attach a NEW open shadow root with content; assert it contains `#webmorph-shadow-style` within 2s.
- [ ] **Step 2: Implement** in `content.ts` — body-level `MutationObserver` (added nodes); on any new shadow root, `injectShadowStyle(root, activeCss)` + start its defender. Debounce with the existing restyle timer.
- [ ] **Step 3: Commit** — `feat(content): detect + inject style into new shadow roots post-apply`

#### Task 3.3: Strengthen scroll-load proof + ≥2 scroll regions

- [ ] **Step 1: Failing test** — strengthen `scrollLoadCheck`: after scroll, new cards have a NON-original background (computed `background-color` differs from before) — "styled" not just "stamped". Add a 2-scroll-region test: page with two independent scroll containers, scroll both, both got handles.
- [ ] **Step 2: Implement** — signature selectors (3.1) style new siblings pre-debounce; for the 2-region test, verify perception surfaces both scrollables and compile emits for both (add code only if missing).
- [ ] **Step 3: Commit** — `test: scroll-load proof (styled not stamped) + 2-scroll-region test`

### WS4 — LATENCY + THEATER

**Goal:** ≤2 visible paints per transform (apply → verify incl. pixel → batch ALL repairs → one merged re-apply); serialization budget (YouTube 13.4K chars test case); ledger accounts to wall-clock (no unexplained gap); model bake-off table committed; structured run report emitted.

**Files:**
- Modify: `project/src/core/execute/index.ts` (`applyStyleEverywhere` increments `data-webmorph-paint-count`)
- Modify: `project/src/entrypoints/content.ts` (batch repair; structured report; ledger `unaccountedMs`)
- Modify: `project/src/core/perceive/index.ts` (serialization budget)
- Modify: `project/src/core/config/index.ts` (`WM_MODEL` env override)
- Modify: `project/tests/popup.test.ts` (`WMGRID=bakeoff` mode)
- Create: `docs/compose/reports/bakeoff.md`

#### Task 4.1: Paint-count instrumentation + batched repair (≤2 visible paints)

- [ ] **Step 1: Failing test** — harness `paintCountCheck` (Task 0, hardened: absent=-1 fails) now must read ≤2. Against current build it reads −1 → FAIL.
- [ ] **Step 2: Instrument `execute/index.ts`** — `applyStyleEverywhere` increments `document.documentElement.dataset['webmorphPaintCount']` (init 0 on first apply, reset on new transform in `content.ts`).
- [ ] **Step 3: Batch repair in `content.ts`** — the repair loop currently re-applies per iteration (visible theater). Change: compute ALL repair option changes for the iteration into one `CompileOptions` diff, recompile once, re-apply once. Target: apply (paint 1) → verify → batched repair → re-apply (paint 2). A 3rd paint = the failing check.
- [ ] **Step 4: Failing test** — assert `pa.paintCount <= 2` (already gated in Task 0).
- [ ] **Step 5: Commit** — `feat(content): batched repair + paint-count instrumentation (≤2 visible paints)`

#### Task 4.2: Serialization budget (perception payload cap)

- [ ] **Step 1: Failing test** — the harness logs `serializeChars` per site; assert YouTube's serialized perception ≤ a budget (e.g. 14000 chars — current is 13.4K, so the budget is the regression floor). Add `assert.ok(ledger.serializeChars <= 14000, ...)` for the YouTube row.
- [ ] **Step 2: Implement** in `perceive/index.ts` `serializePerception` — cap the compact one-liner tier more aggressively when total chars exceed the budget (drop the least-prominent clusters' one-liners first; keep the top-80 full-detail tier). Report chars before/after in the ledger.
- [ ] **Step 3: Commit** — `feat(perceive): serialization budget (cap payload, YouTube ≤14K chars)`

#### Task 4.3: Root-cause the ledger gap (`unaccountedMs`)

- [ ] **Step 1: Failing test** — the harness logs `LEDGER perceive=… model=[…] compile=… apply=… verify=… total=…`; add an `unaccounted` line and assert it is < 10% of total per site (catches the ~44s GitHub gap).
- [ ] **Step 2: Implement** in `content.ts` — add `pixelVerifyMs`, `persistMs` to the ledger; compute `unaccountedMs = totalMs − sum(stages)`. If `unaccountedMs > 0.1*totalMs`, log `LEDGER GAP …` loudly so the stage eating the gap is investigated (the current ~44s GitHub gap is likely the `requestAnimationFrame` + `waitForTimeout` cadence + chrome.runtime round-trips — instrument those).
- [ ] **Step 3: Commit** — `feat(content): account ledger to wall-clock (unaccountedMs + gap logging)`

#### Task 4.4: Model bake-off (`WM_MODEL` + `WMGRID=bakeoff`)

- [ ] **Step 1: Implement `WM_MODEL` override** in `config/index.ts`:
```ts
styleModel: process.env.WM_MODEL || 'gpt-5.1',
```
- [ ] **Step 2: Implement `WMGRID=bakeoff`** in `popup.test.ts` — loop the grid over `['gpt-5','gpt-5.1','gpt-5.2','gpt-4o']` (set `WM_MODEL` per run via the service-worker `chrome.storage.local` or a worker eval), collect `applied/quality(latency/tokens)`, write `docs/compose/reports/bakeoff.md` as a table.
- [ ] **Step 3: Run the bake-off** on the real grid. Per the stop-conditions this is the most likely flag-and-stop (paid calls + time). If budget is exhausted, commit the table skeleton + models actually run, flag-and-stop honestly.
- [ ] **Step 4: Commit** — `feat(config/test): WM_MODEL + WMGRID=bakeoff; commit bake-off table`

#### Task 4.5: Structured run report (one JSON artifact per transform)

- [ ] **Step 1: Failing test** — `structuredReportCheck` (Task 0) already requires `ledger.serializeChars/modelCalls/totalMs/paidCalls`. Extend it to also require `paintCount`, `unaccountedMs`, and a `checks` object with per-check verdicts (incl. pixel-audit + multi-viewport/zoom/resize).
- [ ] **Step 2: Implement** in `content.ts` — the `TransformOutcome` already carries most fields; add `paintCount` and the per-check verdicts to the returned JSON. The popup already surfaces it via `#webmorph-result`.
- [ ] **Step 3: Commit** — `feat(content): structured run report (paintCount + per-check verdicts + unaccountedMs)`

### WS5 — DESIGN QUALITY: the residuals

**Goal:** contrast from sampled rendered pixels (not DOM walk); accent accounting counts canvas-held color; theme polarity proven; typography/measure/containment/width-utilization as compiler laws + verify checks.

**Files:**
- Modify: `project/src/core/verify/index.ts` (`effectiveBackground` from pixel sample; `measureAccentAreaFraction` adds canvas; width-utilization; containment)
- Modify: `project/src/core/compile/index.ts` (measure refusal; line-height floor; containment)
- Modify: `project/src/core/reason/index.ts` (system prompt already has directives 9/10/4 — audit, no rewrite unless a gap is found)
- Modify: `project/tests/compile.test.ts` + `popup.test.ts`

#### Task 5.1: Contrast from rendered pixels (root-cause)

- [ ] **Step 1: Failing test** — a gradient/transparent panel where the DOM walk falls back to white but the rendered pixel is dark: `effectiveBackground` (pixel-grounded) returns dark, so contrast picks light text and passes.
- [ ] **Step 2: Implement** — `verify/index.ts` `effectiveBackground(el)` takes an optional `pixelSample` (from WS1's capture at the text rect); when present, returns the pixel's RGB instead of the DOM walk. Wire WS1's capture to supply it. Keep the DOM walk as fallback when no capture.
- [ ] **Step 3: Commit** — `fix(verify): contrast effectiveBackground sampled from rendered pixels (gradient/transparent root-cause)`

#### Task 5.2: Accent accounting (canvas-held color counts)

- [ ] **Step 1: Failing test** — a vivid canvas (saturated `body` background) with no cluster accents: `measureAccentAreaFraction` returns > 0 (canvas counts), so a flat-looking "explosive" prompt can't pass with accent=0.000.
- [ ] **Step 2: Implement** — `measureAccentAreaFraction` adds the canvas background's saturated area to the numerator: if `parseColor(canvasBg)` is colorful (`colorfulness >= 0.35`), add `viewport area` to the sum. Re-calibrate `MAX_ACCENT_FRACTION` interaction so a deliberate vivid canvas still passes (vivid mode already lifts the cap).
- [ ] **Step 3: Commit** — `fix(verify): accent accounting counts canvas-held color (Carnival flatness)`

#### Task 5.3: Theme polarity proof

- [ ] **Step 1: Failing test** — a grid run whose prompt implies light polarity on a dark-default site (and vice versa): harness asserts the applied canvas luminance matches the implied polarity. (Directive 9 exists in the system prompt; this proves it.)
- [ ] **Step 2: Implement** — add a harness assertion that reads the applied `body` background luminance and compares to the prompt's implied polarity (encoded in a `polarity: 'light'|'dark'` field on the `SiteSpec` for two test rows).
- [ ] **Step 3: Commit** — `test: theme polarity proof (light prompt → light canvas on dark site)`

#### Task 5.4: Typography + measure + containment + width-utilization laws

- [ ] **Step 1: Failing compile test** — a `maxWidth`/`width` that would break measure (< `MIN_CHARS_PER_LINE * fontSize * 0.5`) on a text-bearing cluster is refused by the compiler:
```ts
const text = cluster({handle:'ct',selector:'[data-wm-c="ct"]',samples:['x'.repeat(200)]});
const r = compileSpec({reasoning:'',rules:[{target:'ct',layout:{maxWidth:'80px'}}]}, perception([text]));
assert.ok(!/max-width:\s*80px/.test(r.css) || r.droppedProps.some(d=>d.includes('measure')), 'measure: sub-readability maxWidth refused');
```
- [ ] **Step 2: Implement** in `compile/index.ts` — for text-bearing clusters (samples text length > 80), refuse a sizing value whose effective chars-per-line < `MIN_CHARS_PER_LINE`; log to `droppedProps`. Also emit a body line-height floor (`lineHeight >= 1.4`) when the model set body type.
- [ ] **Step 3: Failing verify test** — containment: a child whose painted bg exceeds its parent's content box → flagged.
- [ ] **Step 4: Implement** in `verify/index.ts` — `checkContainment()` walks painted clusters: if a child's rect extends beyond its parent cluster's rect by > tolerance, push to `details` and fail `passed`.
- [ ] **Step 5: Failing harness test** — width-utilization: content-column area ÷ viewport area from rendered pixels; Wikipedia narrow-column failure detected. Add `widthUtilization` to `PostApplyChecks`; assert ≥ a floor (e.g. 0.55) for portal/feed sites.
- [ ] **Step 6: Implement** — `measureWidthUtilization(capture)` in `pixel.ts`: fraction of non-margin content pixels in the viewport center band. Wire into harness.
- [ ] **Step 7: Commit** — `feat(compile/verify): typography measure + containment + width-utilization laws`

### WS6 — PRODUCT HYGIENE

**Goal:** fast-path router beyond hide (≤5s deterministic for bigger-text/remove-sidebar; "move this" routing in scope, execution deferred); vague-prompt axis held to same bars; scrub every site-name comment from `project/src/`; escape-hatch safety at any moment; persistence survives SPA navigation.

**Files:**
- Modify: `project/src/entrypoints/content.ts` (`classifyIntent` broadened; escape-hatch + persistence hardening)
- Modify: `project/src/core/compile/index.ts`, `verify/index.ts`, `laws/index.ts`, `reason/index.ts`, `perceive/index.ts`, `execute/index.ts` (scrub site-name comments → generic)
- Modify: `docs/ARCHITECTURE.md` (genericize site-name references in lessons)
- Modify: `project/tests/popup.test.ts` (mid-transform escape-hatch; SPA-navigate persistence)

#### Task 6.1: Broaden the fast-path router

- [ ] **Step 1: Failing test** — `'make the text bigger'` → applies in ≤5s with 0 paid calls (a deterministic `font-size` clamp on body/primary); `'remove the sidebar'` → hide a complementary/nav cluster, ≤5s, 0 paid calls; `'move the sidebar to the top'` → returns a Phase-2-deferred message (routing classified, execution not run).
- [ ] **Step 2: Implement** — extend `classifyIntent` to `'bigger-text'|'smaller-text'|'remove'|'move'|'design'|'hide'`. Add `fastSizePath(intent, delta)` (clamp font-size on body + primary content) and `fastRemovePath` (alias to the existing hide path). `'move'` returns `{ ok:false, kind:'phase2_deferred', message:'Moving elements arrives in Phase 2.' }`.
- [ ] **Step 3: Commit** — `feat(content): broadened fast-path router (size/remove/move-routing)`

#### Task 6.2: Vague-prompt axis held to the same bars

- [ ] **Step 1: Failing test** — `VAGUE_SITES` (already in harness) must meet `applied && changeScore>=0.25 && coverage>=0.85` like any design prompt. Already asserted in the harness (Task 0 region).
- [ ] **Step 2: Implement** — no new engine code expected; if a vague prompt fails, the system prompt (directive on "named aesthetics are a direction, not a recipe — reason to specific values") is the lever, not a code change. Flag-and-stop if a vague prompt can't meet the bar without loosening it.
- [ ] **Step 3: Commit** (if a system-prompt tweak was needed) — `fix(reason): vague-prompt handling`

#### Task 6.3: Scrub site-name comments from `project/src/` + `docs/ARCHITECTURE.md`

- [ ] **Step 1: Audit** — grep `project/src/` for `BBC|Wikipedia|YouTube|GitHub|MDN` in comments. List each.
- [ ] **Step 2: Rewrite** each regression-story comment to a generic description (e.g. "the word-mutilation bug", "the white-strip false pass", "the long first-call timeout", "the recolor-reason failure"). Do NOT change behavior. Same for `docs/ARCHITECTURE.md` lessons. The test grid in `project/tests/` legitimately names the 5 sites it exercises — those stay.
- [ ] **Step 3: Verify** — `rg -n 'BBC|Wikipedia|YouTube|GitHub|MDN' project/src/` returns only legit non-comment uses (none expected). Re-run `compile.test.ts` (pure unit) green.
- [ ] **Step 4: Commit** — `refactor: scrub site-name comments from engine source (generic regression stories)`

#### Task 6.4: Escape-hatch safety at any moment

- [ ] **Step 1: Failing harness test** — click On/Off (a) mid-transform (while `inFlight`), (b) post-repair, (c) after an SPA navigation on a SPA site. Assert style removed instantly in all three.
- [ ] **Step 2: Implement** — `removeAll` already tears down; ensure `inFlight` cancellation: clicking during a transform sets a cancel flag the loop checks before each re-apply. SPA `handleRouteChange` already tears down; ensure the escape UI is re-created on re-apply and the click handler still resolves.
- [ ] **Step 3: Commit** — `feat(content): escape-hatch safe at any moment (mid-transform/post-repair/post-SPA)`

#### Task 6.5: Persistence survives SPA navigation

- [ ] **Step 1: Failing harness test** — after a transform on a SPA site, trigger an in-app navigation (click a link / `history.pushState`), assert the verified CSS re-applies (not a re-compile drift) within 5s.
- [ ] **Step 2: Implement** — `handleRouteChange` calls `reapplyStored` which re-compiles the stored spec; ensure it reuses the stored `compileOptions` (already does) and the applied CSS matches the persisted verified CSS (audit: no drift). Add the assertion to the harness.
- [ ] **Step 3: Commit** — `test: persistence survives SPA navigation (verified CSS re-applies)`

#### Task 6.6: Honest docs — update `product.md` current-position

- [ ] **Step 1** — after each workstream is genuinely done (proven by eye on real sites + honest report), update `.kiro/steering/product.md`: flip that sub-phase's checkbox and rewrite "Current position". NEVER flip on green automated checks alone. If in doubt, leave open and say why.
- [ ] **Step 2: Commit** — `docs: update product.md current position (honest, by-eye gate)`

---

## Part D — Self-Review (spec coverage)

Mandate-audit checklist — every numbered task in the work order mapped to a plan task. Statuses are the target; the final report fills actuals.

| Work order item | Plan task | Target status |
|---|---|---|
| WS1 capture (3 scroll, captureVisibleTab) | 1.2 | shipped |
| WS1 void detector | 1.1 | shipped |
| WS1 invisible-text detector | 1.1 | shipped |
| WS1 squeeze detector | 1.1 (pure) + Task 0 (harness) | shipped |
| WS1 recolor detector | 1.1 (pure) + Task 0 (harness) | shipped |
| WS1 wiring to repair router | 1.3 | shipped |
| WS1 Tier-2 vision gate | 1.4 | stopped-with-flag (build only if Tier-1 insufficient) |
| WS2 fluid-first compiler LAW + unit test | 2.1 | shipped |
| WS2 specs store intent not measurements | 2.2 | shipped |
| WS2 re-verify 2nd viewport + 80%/125% zoom + resize | Task 0 (multiConditionPixel) + 2.3 | shipped |
| WS2 runtime re-adaptation | 2.3 | shipped |
| WS2 devtools simulation test | 2.4 | shipped |
| WS3 selector generalization | 3.1 | shipped |
| WS3 new shadow roots | 3.2 | shipped |
| WS3 YouTube scroll + sidebar-expand proofs | 3.3 | shipped |
| WS3 multiple scrollable containers test | 3.3 | shipped |
| WS4 ≤2 visible paints | 4.1 | shipped |
| WS4 serialization budget | 4.2 | shipped |
| WS4 root-cause GitHub overhead | 4.3 | shipped |
| WS4 model bake-off | 4.4 | shipped-or-stopped (paid/time) |
| WS4 structured run report | 4.5 | shipped |
| WS5 contrast gradient/transparent (pixel) | 5.1 | shipped |
| WS5 accent accounting | 5.2 | shipped |
| WS5 theme polarity proof | 5.3 | shipped |
| WS5 typography/measure/line-height laws | 5.4 | shipped |
| WS5 use-the-room width-utilization | 5.4 | shipped |
| WS5 background contains content | 5.4 | shipped |
| WS6 fast-path beyond hide + move routing | 6.1 | shipped |
| WS6 vague-prompt axis | 6.2 | shipped |
| WS6 scrub site-name comments | 6.3 | shipped |
| WS6 escape-hatch safety | 6.4 | shipped |
| WS6 persistence acceptance | 6.5 | shipped |
| WS6 honest docs | 6.6 | shipped |

(32 work-order items → 32 plan tasks. None absent from the checklist.)

## Execution Handoff

Per `compose:plan` execution-handoff: check memory for a saved `execution-style` preference; if absent, ask via `compose:ask`.

Default if no user available: this plan has >3 tasks but many are tightly coupled through `verify/compile/content` and require real browser+API grid runs that only work in the main session. Default to **inline** execution (compose:execute, batch with checkpoints) for the coupled core + harness runs; use **subagents** for isolated pure modules (pixel detectors, fluidize math, recolor math) where a fresh reviewer adds value. The plan structure already separates those (pure unit tests vs harness integration).

Hard env gate before any grid run: verify `OPENAI_API_KEY` is present in `project/.env` and a real `npm run build` succeeds. If the grid cannot run real paid calls in this environment, flag-and-stop grid-dependent tasks and ship only unit-test-proven work, stating the gate honestly.


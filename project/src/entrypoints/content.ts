/**
 * content — the Phase-1 pipeline orchestrator, running in the page.
 *
 *   perceive -> (background: reason -> DesignSpec) -> compile -> apply CSS
 *            -> verify(before) -> repair loop (recompile / re-reason / keepBest)
 *            -> persist
 *
 * Round 7: shadow-aware (inject + defend per open shadow root), SPA navigation
 * (hook pushState/popstate, re-perceive + re-compile on route change), per-URL
 * persistence (origin + normalized pathname).
 */

import { perceive, serializePerception, clearHandles, captureLayoutFingerprint } from '@/core/perceive';
import { compileSpec, type CompileOptions } from '@/core/compile';
import { sanitizeCss } from '@/core/sanitize';
import { verifyStyle, type VerifyResult } from '@/core/verify';
import { pixelVerify, type PixelVerifyResult, type PixelInput, type ClusterRect } from '@/core/verify/pixel';
import { captureAtPositions, screenshotToPixelInput } from '@/core/verify/capture';
import { planRepair, bestNonBroken, type Attempt } from '@/core/repair';
import { checkCompleteness } from '@/core/spec';
import { applyStyle, applyStyleEverywhere, removeStyle, removeStyleEverywhere, startDefense, startDefenseEverywhere, ensureEscapeUI, removeEscapeUI } from '@/core/execute';
import { loadSiteState, saveSiteState, clearSiteState, storageKey, type SiteState } from '@/core/persist';
import { MAX_REPAIR_ATTEMPTS, logDebug } from '@/core/config';
import type { DesignSpec } from '@/core/spec';
import type { Perception } from '@/core/perceive';

interface SpecResponse { ok: boolean; spec?: DesignSpec; kind?: string; message?: string; usage?: unknown; model?: string; callMs?: number; }

export interface Ledger {
  perceiveMs: number;
  serializeChars: number;
  modelCalls: { ms: number; promptTokens?: number }[];
  compileMs: number;
  applyMs: number;
  verifyMs: number;
  pixelVerifyMs: number;   // WS1: 3-position capture + pixel detectors
  persistMs: number;      // WS4: storage write
  unaccountedMs: number;  // WS4: totalMs − sum(stages); a big gap = something unmeasured
  totalMs: number;
  paidCalls: number;
  paintCount: number;     // WS4: visible repaints (<=2 contract)
}

export interface TransformOutcome {
  ok: boolean;
  message?: string;
  kind?: string;         // error kind for popup taxonomy (invalid_key, timeout, etc.)
  reasoning?: string;
  spec?: DesignSpec;
  verify?: VerifyResult;
  pixel?: { passed: boolean; voids: number; invisibleText: number; squeeze: number };
  perceiveMs?: number;
  clusters?: number;
  changeScore?: number;
  accentFraction?: number;
  modelCoverageFraction?: number;
  wallMs?: number;       // total transform wall-clock
  model?: string;        // which model served the request
  usage?: unknown;       // token usage
  paidCalls?: number;    // paid model calls used
  paintCount?: number;   // WS4: visible repaints
  ledger?: Ledger;       // stage-by-stage time breakdown (structured run report)
}

const APPLIED = 'webmorphApplied';
const FAILED = 'webmorphFailed';

let inFlight: Promise<TransformOutcome> | null = null;
let activeShadowRoots: ShadowRoot[] = [];

// Dynamic-content defense (req C): the stored spec + opts, used to re-stamp +
// re-apply the design on inserted content (free, no model call).
let activeSpec: DesignSpec | null = null;
let activeOpts: CompileOptions = {};
let dynamicObserver: MutationObserver | null = null;
let shadowDynamicObservers: MutationObserver[] = [];
let restyleTimer: ReturnType<typeof setTimeout> | null = null;

function markApplied(id: string): void {
  delete document.documentElement.dataset[FAILED];
  document.documentElement.dataset[APPLIED] = id;
}
function markFailed(msg: string): void {
  delete document.documentElement.dataset[APPLIED];
  document.documentElement.dataset[FAILED] = msg.slice(0, 80);
}

// ── Core Phase-1 run ───────────────────────────────────────────────

/** WS1: build ClusterRect[] from the current [data-wm-c] elements for the pixel
 *  detectors. One representative per handle, with the rendered rect + text + font
 *  size. Skips our own UI nodes. */
function buildClusterRects(): ClusterRect[] {
  const seen = new Set<string>();
  const out: ClusterRect[] = [];
  for (const el of Array.from(document.querySelectorAll('[data-wm-c]'))) {
    if (el.hasAttribute('data-webmorph-ui') || !(el instanceof HTMLElement)) continue;
    const handle = el.getAttribute('data-wm-c')!;
    if (seen.has(handle)) continue;
    seen.add(handle);
    const r = el.getBoundingClientRect();
    out.push({
      handle,
      rect: { x: r.left, y: r.top, w: r.width, h: r.height },
      text: (el.textContent || '').trim(),
      fontSize: parseFloat(getComputedStyle(el).fontSize) || 16,
    });
  }
  return out;
}

/** WS1: capture the visible tab at 3 scroll positions (top / mid / deep) and run
 *  the pixel detectors. Returns the PixelVerifyResult + the time it took. Asks the
 *  background service worker for captureVisibleTab (only it can capture a tab).
 *  Free, deterministic, zero model calls — the centerpiece of WS1. */
async function captureAndPixelVerify(): Promise<{ result: PixelVerifyResult; ms: number }> {
  const tc = performance.now();
  const rects = buildClusterRects();
  const shot = async (y: number): Promise<PixelInput> => {
    window.scrollTo(0, y);
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    return new Promise<PixelInput>((resolve) => {
      chrome.runtime.sendMessage({ action: 'captureVisibleTab' }, (resp: { ok: boolean; dataUrl?: string }) => {
        if (chrome.runtime.lastError || !resp?.ok || !resp.dataUrl) { resolve({ width: 0, height: 0, data: new Uint8ClampedArray(0) }); return; }
        screenshotToPixelInput(resp.dataUrl).then(resolve);
      });
    });
  };
  const h = document.documentElement.scrollHeight || 1;
  const captures = await captureAtPositions([0, Math.floor(h / 2), Math.floor(h * 0.8)], shot);
  window.scrollTo(0, 0);
  const result = pixelVerify(captures, rects);
  return { result, ms: Math.round(performance.now() - tc) };
}

async function runStyle(intent: string): Promise<TransformOutcome> {
  const t0 = Date.now();
  delete document.documentElement.dataset[APPLIED];
  delete document.documentElement.dataset[FAILED];
  // WS4: reset the visible-paint counter at the start of every transform. The
  // harness asserts paintCount <= 2 (apply + one batched repair). applyStyleEverywhere
  // increments it.
  document.documentElement.dataset['webmorphPaintCount'] = '0';
  stopDynamicDefense();
  activeSpec = null;

  clearHandles();
  const perception = perceive();
  activeShadowRoots = perception.shadowRoots;
  const serialized = serializePerception(perception);
  const serializeChars = serialized.length;
  const before = captureLayoutFingerprint();
  logDebug(`perceived ${perception.nodeCount} nodes -> ${perception.clusters.length} clusters (${perception.builtInMs}ms) ${perception.shadowRoots.length} shadow roots serialize=${serializeChars}chars`);

  const modelCalls: { ms: number; promptTokens?: number }[] = [];

  let specRes = await askForSpec(intent, serialized);
  if (specRes.callMs != null) modelCalls.push({ ms: specRes.callMs, promptTokens: (specRes.usage as { prompt_tokens?: number })?.prompt_tokens });
  if (!specRes.ok || !specRes.spec) {
    logDebug(`LEDGER perceive=${perception.builtInMs}ms serialize=${serializeChars}chars model=[${modelCalls.map((c) => `${c.ms}ms/${c.promptTokens ?? '?'}tok`).join(', ')}] total=${Date.now() - t0}ms paidCalls=${modelCalls.length} — FAILED ${specRes.kind ?? ''}`);
    markFailed(specRes.message || 'engine failed');
    return { ok: false, kind: specRes.kind, message: specRes.message || 'Design engine failed.', paidCalls: modelCalls.length, wallMs: Date.now() - t0 };
  }
  let spec = specRes.spec;
  logDebug(`served by=${specRes.model ?? '?'} usage=${JSON.stringify(specRes.usage ?? {})}`);
  logDebug(`paletteMode=${spec.paletteMode ?? 'restrained(default)'} rules=${spec.rules.length} composition=${spec.composition?.length ?? 0} clusters=${perception.clusters.length}`);

  let reReasonsDone = 0;

  // Completeness contract — BEFORE apply.
  {
    const comp = checkCompleteness(spec, perception.handles);
    if (!comp.ok) {
      logDebug(`INCOMPLETE SPEC — ${comp.reason}`);
      if (reReasonsDone < MAX_REPAIR_ATTEMPTS && Date.now() - t0 < 60000) {
        reReasonsDone++;
        logDebug('PAID SECOND CALL — completeness gate failed');
        const critique = comp.reason + ' Unaccounted clusters will be base-coated as a safety net, but you must actively design the major clusters.';
        const re = await askForSpec(intent, serialized, critique, Math.max(15000, 115000 - (Date.now() - t0)));
        if (re.callMs != null) modelCalls.push({ ms: re.callMs, promptTokens: (re.usage as { prompt_tokens?: number })?.prompt_tokens });
        if (re.ok && re.spec) {
          spec = re.spec;
          const comp2 = checkCompleteness(spec, perception.handles);
          logDebug(`revised spec: ${comp2.ok ? 'complete' : comp2.reason ?? 'still incomplete — proceeding to verify'}`);
        }
      }
    } else {
      logDebug(`completeness OK — ${perception.handles.size} clusters, ${comp.unaccounted.length} base-coated`);
    }
  }

  // Build modelAddressed set for the model coverage gate.
  const modelAddressed = new Set<string>();
  for (const rule of spec.rules) {
    if (rule.styles || rule.layout || rule.hover || rule.focusVisible || rule.hide) modelAddressed.add(rule.target);
  }
  if (spec.composition) {
    for (const rule of spec.composition) {
      if (rule.styles || rule.layout || rule.hide) modelAddressed.add(rule.target);
    }
  }

  let options: CompileOptions = { paletteMode: spec.paletteMode };
  const attempts: Attempt[] = [];
  let lastVerify: VerifyResult | null = null;
  let lastPixel: PixelVerifyResult | null = null;
  let compileMsTotal = 0, applyMsTotal = 0, verifyMsTotal = 0, pixelVerifyMsTotal = 0;

  // WS4 batched repair: apply once (paint 1) → verify (DOM + pixel) → compute ALL
  // repairs as a batch → one merged re-apply (paint 2) → STOP. A 3rd visible repaint
  // is a failing check (the harness asserts paintCount <= 2). No keepBest re-apply
  // beyond paint 2: if paint 2 is broken we rollback+fail rather than repaint again.
  let paintCount = 0;
  const applyOnce = async (curSpec: DesignSpec, opts: CompileOptions): Promise<{ compiled: ReturnType<typeof compileSpec>; sanitized: string; verify: VerifyResult; pixel: PixelVerifyResult }> => {
    const tcCompile = performance.now();
    const compiled = compileSpec(curSpec, perception, opts);
    compileMsTotal += performance.now() - tcCompile;
    const sanitized = sanitizeCss(compiled.css).css;
    if (!sanitized.trim()) return Promise.reject(new Error('no styles'));
    const tcApply = performance.now();
    applyStyleEverywhere(sanitized, activeShadowRoots);
    applyMsTotal += performance.now() - tcApply;
    paintCount++;
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    const tcVerify = performance.now();
    const verify = verifyStyle(before, curSpec.paletteMode, modelAddressed);
    verifyMsTotal += performance.now() - tcVerify;
    const px = await captureAndPixelVerify();
    pixelVerifyMsTotal += px.ms;
    return { compiled, sanitized, verify, pixel: px.result };
  };

  // ── Paint 1: initial apply + verify (DOM + pixel) ──
  let phase1Sanitized = '';
  let phase1Verify: VerifyResult | null = null;
  try {
    const p1 = await applyOnce(spec, options);
    phase1Sanitized = p1.sanitized; phase1Verify = p1.verify; lastVerify = p1.verify; lastPixel = p1.pixel;
    attempts.push({ spec, css: p1.sanitized, notBroken: p1.verify.checks.notBlank && p1.verify.checks.noOverflow && p1.verify.checks.noOverlap && p1.verify.checks.contrastOk && p1.verify.checks.contentCollapsed && p1.verify.checks.contentVisible, changeScore: p1.verify.changeScore, covered: p1.verify.checks.covered, coherent: p1.verify.checks.coherent, changed: p1.verify.checks.changed, contentCollapsed: p1.verify.checks.contentCollapsed });
    logDebug(`paint1: rules=${p1.compiled.rulesEmitted} baseCoat=${p1.compiled.baseCoatCount} checks=${JSON.stringify(p1.verify.checks)} pixel(passed=${p1.pixel.passed} voids=${p1.pixel.voids.length} invisible=${p1.pixel.invisibleText.length} squeeze=${p1.pixel.squeeze.length}) change=${p1.verify.changeScore.toFixed(3)} accent=${p1.verify.accentFraction.toFixed(3)} coverage=${p1.verify.coverageFraction.toFixed(3)} modelCov=${p1.verify.modelCoverageFraction.toFixed(3)}${p1.compiled.droppedProps.length ? ' dropped=[' + p1.compiled.droppedProps.slice(0, 12).join(',') + ']' : ''}`);
    logDebug(`  detail: ${p1.verify.details.join(' | ')}`);
    if (!p1.pixel.passed) logDebug(`  pixel critiques: ${p1.pixel.critiques.join(' | ')}`);
  } catch (e) {
    removeStyleEverywhere(activeShadowRoots); markFailed('no styles');
    return { ok: false, message: (e as Error).message || 'Produced no applicable styles.', spec, reasoning: spec.reasoning, paidCalls: 1 + reReasonsDone, wallMs: Date.now() - t0 };
  }

  // WS1: passed := DOM passed AND pixel passed. A by-eye-killer is mechanically
  // impossible to report as PASS.
  const phase1Passed = phase1Verify.passed && (lastPixel?.passed ?? true);

  if (!phase1Passed && paintCount < 2) {
    const decision = planRepair(phase1Verify!, options, reReasonsDone, spec.paletteMode, lastPixel);
    logDebug(`repair -> ${decision.action}: ${decision.reason}`);

    if (decision.action === 'rollback') {
      removeStyleEverywhere(activeShadowRoots); markFailed('content blanked');
      return { ...failVerify(spec, phase1Verify!), paidCalls: 1 + reReasonsDone, wallMs: Date.now() - t0 };
    }

    if (decision.action === 'reReason') {
      // Latency guard: if the 1st call already consumed >60s, a 2nd call pushes
      // total past the 130s harness marker. Skip it, ship paint 1 if non-broken.
      if (Date.now() - t0 > 60000) {
        logDebug('reReason skipped — elapsed > 60s (latency budget); shipping paint 1');
        if (!(phase1Verify!.checks.notBlank && phase1Verify!.checks.contentCollapsed)) {
          removeStyleEverywhere(activeShadowRoots); markFailed('latency budget — no revision');
          return { ...failVerify(spec, phase1Verify!), paidCalls: 1 + reReasonsDone, wallMs: Date.now() - t0 };
        }
      } else {
        // Append the pixel-grounded critiques to the reReason so the model fixes
        // the by-eye-killers (voids, invisible text, squeeze), not just DOM flags.
        const critique = decision.critique + (lastPixel && !lastPixel.passed ? '\nPixel verification also found: ' + lastPixel.critiques.join('; ') : '');
        const failing = Object.entries(phase1Verify!.checks).filter(([, v]) => !v).map(([k]) => k).join(',');
        logDebug(`PAID SECOND CALL — first-call prompt failed to prevent: ${failing}${lastPixel && !lastPixel.passed ? ' +pixel' : ''}`);
        reReasonsDone++;
        const re = await askForSpec(intent, serialized, critique, Math.max(15000, 115000 - (Date.now() - t0)));
        if (re.callMs != null) modelCalls.push({ ms: re.callMs, promptTokens: (re.usage as { prompt_tokens?: number })?.prompt_tokens });
        if (re.ok && re.spec) {
          spec = re.spec; options = { paletteMode: spec.paletteMode };
          // ── Paint 2: re-apply with the revised spec ──
          try {
            const p2 = await applyOnce(spec, options);
            lastVerify = p2.verify; lastPixel = p2.pixel;
            attempts.push({ spec, css: p2.sanitized, notBroken: p2.verify.checks.notBlank && p2.verify.checks.noOverflow && p2.verify.checks.noOverlap && p2.verify.checks.contrastOk && p2.verify.checks.contentCollapsed && p2.verify.checks.contentVisible, changeScore: p2.verify.changeScore, covered: p2.verify.checks.covered, coherent: p2.verify.checks.coherent, changed: p2.verify.checks.changed, contentCollapsed: p2.verify.checks.contentCollapsed });
            logDebug(`paint2(reReason): checks=${JSON.stringify(p2.verify.checks)} pixel(passed=${p2.pixel.passed})`);
            // If paint 2 is broken, rollback+fail (no 3rd paint to revert).
            if (!(p2.verify.checks.notBlank && p2.verify.checks.contentCollapsed)) {
              removeStyleEverywhere(activeShadowRoots); markFailed('revision broke content');
              return { ...failVerify(spec, p2.verify), paidCalls: 1 + reReasonsDone, wallMs: Date.now() - t0 };
            }
          } catch {
            // reReason'd spec produced no styles — keep paint 1 if non-broken.
            if (!(phase1Verify!.checks.notBlank && phase1Verify!.checks.contentCollapsed)) {
              removeStyleEverywhere(activeShadowRoots); markFailed('revision failed');
              return { ...failVerify(spec, phase1Verify!), paidCalls: 1 + reReasonsDone, wallMs: Date.now() - t0 };
            }
            applyStyleEverywhere(phase1Sanitized, activeShadowRoots); // revert to paint 1
            logDebug('paint2 produced no styles — reverted to paint 1');
          }
        }
      }
    } else {
      // Deterministic repair: batch ALL option changes into one CompileOptions,
      // recompile once, re-apply once (paint 2). No keepBest re-apply beyond this.
      const batchedOpts = { ...options, ...decision.options };
      options = batchedOpts;
      try {
        const p2 = await applyOnce(spec, options);
        lastVerify = p2.verify;
        attempts.push({ spec, css: p2.sanitized, notBroken: p2.verify.checks.notBlank && p2.verify.checks.noOverflow && p2.verify.checks.noOverlap && p2.verify.checks.contrastOk && p2.verify.checks.contentCollapsed && p2.verify.checks.contentVisible, changeScore: p2.verify.changeScore, covered: p2.verify.checks.covered, coherent: p2.verify.checks.coherent, changed: p2.verify.checks.changed, contentCollapsed: p2.verify.checks.contentCollapsed });
        logDebug(`paint2(repair): checks=${JSON.stringify(p2.verify.checks)} pixel(passed=${p2.pixel.passed}) change=${p2.verify.changeScore.toFixed(3)} accent=${p2.verify.accentFraction.toFixed(3)}`);
        if (!(p2.verify.checks.notBlank && p2.verify.checks.contentCollapsed)) {
          // Repair broke content — revert to paint 1 (paint 1 is still on screen?
          // No — paint 2 overwrote it). Re-applying paint 1 would be a 3rd paint.
          // Rollback+fail honestly instead.
          removeStyleEverywhere(activeShadowRoots); markFailed('repair broke content');
          return { ...failVerify(spec, p2.verify), paidCalls: 1 + reReasonsDone, wallMs: Date.now() - t0 };
        }
      } catch {
        // repair produced no styles — keep paint 1
        applyStyleEverywhere(phase1Sanitized, activeShadowRoots);
        logDebug('paint2(repair) produced no styles — reverted to paint 1');
      }
    }
  }

  // WS4: verify the paint budget. <=2 paints is the contract; a 3rd = failing.
  // Set the dataset explicitly from the internal counter — applyStyleEverywhere no
  // longer increments it (defense re-applies are invisible restores, not visible
  // paints), so the harness reads the true visible-paint count.
  document.documentElement.dataset['webmorphPaintCount'] = String(paintCount);
  const finalPaintCount = paintCount;
  if (finalPaintCount > 2) logDebug(`PAINT BUDGET EXCEEDED: ${finalPaintCount} > 2 (visible repair theater)`);


  // Persist + defend + mark applied. (WS4: time the persist stage too.)
  const key = storageKey();
  const state = await loadSiteState(key);
  const id = `style_${Date.now()}`;
  const appliedCss = document.getElementById('webmorph-style')?.textContent ?? attempts[attempts.length - 1]?.css ?? '';
  state.enabled = true;
  state.style = { id, intent, spec, css: appliedCss, reasoning: spec.reasoning, compileOptions: options, createdAt: Date.now() };
  const tPersist = performance.now();
  await saveSiteState(key, state);
  const persistMs = Math.round(performance.now() - tPersist);

  startDefenseEverywhere(state.style.css, activeShadowRoots);
  activeSpec = spec;
  activeOpts = options;
  startDynamicDefense();
  ensureEscapeUI(toggleSiteState);
  markApplied(id);

  // Ledger — stage-by-stage time breakdown (WS4: account to wall-clock, nothing
  // unexplained). unaccountedMs = totalMs − sum(stages); a big gap means a stage
  // is eating time we didn't instrument (the ~44s unexplained-overhead case).
  const totalMs = Date.now() - t0;
  const stagesMs = perception.builtInMs + modelCalls.reduce((s, c) => s + c.ms, 0) + Math.round(compileMsTotal) + Math.round(applyMsTotal) + Math.round(verifyMsTotal) + Math.round(pixelVerifyMsTotal) + persistMs;
  const ledger: Ledger = {
    perceiveMs: perception.builtInMs, serializeChars,
    modelCalls, compileMs: Math.round(compileMsTotal),
    applyMs: Math.round(applyMsTotal), verifyMs: Math.round(verifyMsTotal),
    pixelVerifyMs: Math.round(pixelVerifyMsTotal), persistMs,
    unaccountedMs: Math.max(0, totalMs - stagesMs),
    totalMs, paidCalls: 1 + reReasonsDone, paintCount: finalPaintCount,
  };
  const modelMsStr = modelCalls.map((c) => `${c.ms}ms/${c.promptTokens ?? '?'}tok`).join(', ');
  logDebug(`LEDGER perceive=${ledger.perceiveMs}ms serialize=${serializeChars}chars model=[${modelMsStr}] compile=${ledger.compileMs}ms apply=${ledger.applyMs}ms verify=${ledger.verifyMs}ms pixelVerify=${ledger.pixelVerifyMs}ms persist=${persistMs}ms unaccounted=${ledger.unaccountedMs}ms total=${totalMs}ms paidCalls=${ledger.paidCalls} paints=${finalPaintCount}`);
  if (ledger.unaccountedMs > 0.15 * totalMs) logDebug(`LEDGER GAP >15%: ${ledger.unaccountedMs}ms unaccounted — investigate`);

  return {
    ok: true, reasoning: spec.reasoning, spec, verify: lastVerify || undefined,
    pixel: lastPixel ? { passed: lastPixel.passed, voids: lastPixel.voids.length, invisibleText: lastPixel.invisibleText.length, squeeze: lastPixel.squeeze.length } : undefined,
    perceiveMs: perception.builtInMs, clusters: perception.clusters.length,
    changeScore: lastVerify?.changeScore, accentFraction: lastVerify?.accentFraction,
    modelCoverageFraction: lastVerify?.modelCoverageFraction,
    wallMs: totalMs, model: specRes.model, usage: specRes.usage,
    paidCalls: 1 + reReasonsDone, paintCount: finalPaintCount, ledger,
  };
}

function failVerify(spec: DesignSpec, verify: VerifyResult): TransformOutcome {
  return { ok: false, message: 'Result failed checks: ' + verify.details.slice(0, 3).join('; '), spec, reasoning: spec.reasoning, verify };
}

function askForSpec(intent: string, perception: string, critique?: string, timeoutMs?: number): Promise<SpecResponse> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'styleSpec', intent, perception, critique, timeoutMs }, (response) => {
      if (chrome.runtime.lastError || !response) resolve({ ok: false, message: chrome.runtime.lastError?.message || 'No response from design engine.' });
      else resolve(response as SpecResponse);
    });
  });
}

// ── Persistence / toggle ───────────────────────────────────────────

async function reapplyStored(): Promise<boolean> {
  const key = storageKey();
  let state = await loadSiteState(key);
  // Origin-level fallback: if no design for this pathname, check origin.
  if (!state.style) {
    state = await loadSiteState(window.location.origin);
    if (!state.style) return false;
  }
  if (!state.enabled || !state.style?.css) return false;
  clearHandles();
  const perception = perceive();
  activeShadowRoots = perception.shadowRoots;
  // Re-compile the stored spec against the current perception (handles may differ).
  const opts = state.style.compileOptions ?? { paletteMode: state.style.spec.paletteMode };
  const compiled = compileSpec(state.style.spec, perception, opts);
  const css = sanitizeCss(compiled.css).css || state.style.css;
  applyStyleEverywhere(css, activeShadowRoots);
  startDefenseEverywhere(css, activeShadowRoots);
  activeSpec = state.style.spec;
  activeOpts = opts;
  startDynamicDefense();
  ensureEscapeUI(toggleSiteState);
  markApplied(state.style.id);
  return true;
}

async function toggleSiteState(): Promise<void> {
  const key = storageKey();
  const state = await loadSiteState(key);
  if (!state.style) return;
  state.enabled = !state.enabled;
  await saveSiteState(key, state);
  if (state.enabled) await reapplyStored();
  else { stopDynamicDefense(); activeSpec = null; removeStyleEverywhere(activeShadowRoots); removeEscapeUI(); delete document.documentElement.dataset[APPLIED]; }
}

async function removeAll(): Promise<void> {
  stopDynamicDefense();
  activeSpec = null;
  removeStyleEverywhere(activeShadowRoots); removeEscapeUI();
  delete document.documentElement.dataset[APPLIED];
  await clearSiteState(storageKey());
}

// ── Dynamic content defense (req C) ────────────────────────────────
// Signature-based handles are deterministic: new content with the same visual
// signature gets the SAME handle, so the stored CSS applies once re-stamped.
// A MutationObserver (light DOM + active shadow roots) debounces a FREE
// re-perceive + re-compile(stored spec) + re-apply — no model call. New content
// is either styled (matches an existing family) or base-coated (novel signature).
// Self-trigger is avoided by ignoring additions of our own data-webmorph-ui nodes.
function restyleDynamic(): void {
  if (!activeSpec) return;
  restyleTimer = null;
  clearHandles();
  const perception = perceive();
  activeShadowRoots = perception.shadowRoots;
  const compiled = compileSpec(activeSpec, perception, activeOpts);
  const css = sanitizeCss(compiled.css).css;
  if (css) applyStyleEverywhere(css, activeShadowRoots);
  logDebug(`dynamic restyle: ${perception.clusters.length} clusters re-stamped + re-applied`);
}

function scheduleRestyle(): void {
  if (restyleTimer) clearTimeout(restyleTimer);
  restyleTimer = setTimeout(restyleDynamic, 600);
}

function startDynamicDefense(): void {
  stopDynamicDefense();
  // Ignore mutations whose only additions are our own injected elements (style /
  // escape UI) so re-applying never self-triggers a restyle loop.
  const hasForeignAdd = (muts: MutationRecord[]): boolean =>
    muts.some((m) => Array.from(m.addedNodes).some(
      (n) => !((n instanceof HTMLElement) && n.hasAttribute('data-webmorph-ui')),
    ));
  dynamicObserver = new MutationObserver((muts) => { if (hasForeignAdd(muts)) scheduleRestyle(); });
  dynamicObserver.observe(document.body, { childList: true, subtree: true });
  for (const root of activeShadowRoots) {
    const obs = new MutationObserver((muts) => { if (hasForeignAdd(muts)) scheduleRestyle(); });
    obs.observe(root, { childList: true, subtree: true });
    shadowDynamicObservers.push(obs);
  }
  // Resize (req B): re-compile so containerWidthPx-based font clamps track the new
  // width. Most fluidity is already in the CSS (clamp/min(100%,…)); this catches
  // the container-measured clamps. Debounced with the same restyle timer.
  window.addEventListener('resize', scheduleRestyle);
}

function stopDynamicDefense(): void {
  dynamicObserver?.disconnect();
  dynamicObserver = null;
  for (const o of shadowDynamicObservers) o.disconnect();
  shadowDynamicObservers = [];
  if (restyleTimer) { clearTimeout(restyleTimer); restyleTimer = null; }
  window.removeEventListener('resize', scheduleRestyle);
}

// ── SPA navigation ─────────────────────────────────────────────────

let routeTimer: ReturnType<typeof setTimeout> | null = null;

function onRouteChange(): void {
  if (routeTimer) clearTimeout(routeTimer);
  routeTimer = setTimeout(handleRouteChange, 500); // debounce — SPA frameworks sometimes call pushState multiple times
}

async function handleRouteChange(): Promise<void> {
  if (inFlight) return; // a transform is running — it will handle the current page
  stopDynamicDefense();
  activeSpec = null;
  removeStyleEverywhere(activeShadowRoots);
  removeEscapeUI();
  delete document.documentElement.dataset[APPLIED];
  await reapplyStored();
}

// ── Adaptive effort (req E) ─────────────────────────────────────────
// Simple intents (hide/remove a named thing) take a FAST path: perceive → match
// the target noun to clusters → hide-only spec → apply. Zero paid model calls,
// ~1-2s. Ambitious/descriptive intents get the full design pipeline. A heuristic
// classifier routes obvious cases; ambiguous ones fall through to the full path.

function classifyIntent(intent: string): 'hide' | 'design' {
  const s = intent.trim().toLowerCase();
  if (s.length > 120) return 'design';                  // long/descriptive → design
  // Starts with a hide verb AND has no aesthetic/design keywords → simple hide.
  if (/^(hide|remove|delete|get rid of)\b/.test(s) &&
      !/\b(like|style|theme|aesthetic|redesign|make it|transform|look)\b/.test(s)) return 'hide';
  return 'design';
}

async function fastHidePath(intent: string): Promise<TransformOutcome> {
  const t0 = Date.now();
  delete document.documentElement.dataset[APPLIED];
  delete document.documentElement.dataset[FAILED];
  stopDynamicDefense();
  activeSpec = null;

  clearHandles();
  const perception = perceive();
  activeShadowRoots = perception.shadowRoots;

  // Extract target words after the hide verb (length > 3, stopwords removed).
  const targetWords = intent.toLowerCase()
    .replace(/.*?\b(hide|remove|delete|get rid of)\b/, '')
    .replace(/\b(the|a|an|all|please|and|on|my|site|page|element|section)\b/g, '')
    .split(/[^a-z]+/).filter((w) => w.length > 3);
  if (!targetWords.length) {
    markFailed('could not identify what to hide');
    return { ok: false, message: 'Could not identify what to hide. Try: "hide the footer".', paidCalls: 0, wallMs: Date.now() - t0 };
  }

  // Match clusters whose role/tag/samples contain any target word.
  const hideHandles: string[] = [];
  for (const c of perception.clusters) {
    const haystack = [c.role ?? '', c.tag, ...c.samples].join(' ').toLowerCase();
    if (targetWords.some((w) => haystack.includes(w))) hideHandles.push(c.handle);
  }
  if (!hideHandles.length) {
    markFailed('no matching element found');
    return { ok: false, message: `No element matching "${targetWords.join(' ')}" was found.`, paidCalls: 0, wallMs: Date.now() - t0 };
  }

  // Hide-only spec — hideRefusal guards primary content/wrappers, so this can't
  // delete the page. If every match is refused, sanitized CSS is empty.
  const spec: DesignSpec = { reasoning: `fast hide: ${intent}`, rules: hideHandles.map((h) => ({ target: h, hide: true })) };
  const compiled = compileSpec(spec, perception, {});
  const sanitized = sanitizeCss(compiled.css).css;
  if (!sanitized.trim()) {
    markFailed('hide refused (protected content)');
    return { ok: false, message: 'That element is protected and cannot be hidden.', paidCalls: 0, wallMs: Date.now() - t0 };
  }
  applyStyleEverywhere(sanitized, activeShadowRoots);
  document.documentElement.dataset['webmorphPaintCount'] = '1'; // WS4: 1 visible paint (fast path)
  await new Promise<void>((r) => requestAnimationFrame(() => r()));

  const key = storageKey();
  const state = await loadSiteState(key);
  const id = `hide_${Date.now()}`;
  state.enabled = true;
  state.style = { id, intent, spec, css: sanitized, reasoning: spec.reasoning, compileOptions: {}, createdAt: Date.now() };
  await saveSiteState(key, state);
  startDefenseEverywhere(sanitized, activeShadowRoots);
  activeSpec = spec;
  activeOpts = {};
  startDynamicDefense();
  ensureEscapeUI(toggleSiteState);
  markApplied(id);

  const wallMs = Date.now() - t0;
  logDebug(`FAST HIDE PATH: ${hideHandles.length} cluster(s) hidden in ${wallMs}ms (0 paid calls)`);
  return {
    ok: true, reasoning: spec.reasoning, spec, perceiveMs: perception.builtInMs,
    clusters: perception.clusters.length, paidCalls: 0, wallMs,
    ledger: { perceiveMs: perception.builtInMs, serializeChars: 0, modelCalls: [], compileMs: 0, applyMs: 0, verifyMs: 0, pixelVerifyMs: 0, persistMs: 0, unaccountedMs: 0, totalMs: wallMs, paidCalls: 0, paintCount: 1 },
  };
}

// ── Entry ──────────────────────────────────────────────────────────

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',

  main() {
    reapplyStored();

    // SPA navigation detection.
    const origPush = history.pushState;
    history.pushState = function (...args) { origPush.apply(this, args); onRouteChange(); };
    const origReplace = history.replaceState;
    history.replaceState = function (...args) { origReplace.apply(this, args); onRouteChange(); };
    window.addEventListener('popstate', onRouteChange);
    window.addEventListener('hashchange', onRouteChange);

    window.addEventListener('keydown', (e) => {
      if (e.altKey && e.shiftKey && e.key.toLowerCase() === 'r') toggleSiteState();
    });

    browser.runtime.onMessage.addListener((message: { action: string; intent?: string }) => {
      if (message.action === 'transform' && message.intent) {
        if (!inFlight) {
          const intent = message.intent;
          // Adaptive effort (req E): simple hide intents take the fast no-model path.
          const runner = classifyIntent(intent) === 'hide' ? fastHidePath(intent) : runStyle(intent);
          inFlight = runner.finally(() => { inFlight = null; });
        }
        return inFlight;
      }
      if (message.action === 'toggle') return toggleSiteState().then(() => ({ ok: true }));
      if (message.action === 'remove_all') return removeAll().then(() => ({ ok: true }));
      if (message.action === 'getSiteInfo') {
        return Promise.resolve({
          url: window.location.href,
          origin: window.location.origin,
          applied: document.documentElement.hasAttribute(`data-${APPLIED}`),
        });
      }
      return undefined;
    });
  },
});

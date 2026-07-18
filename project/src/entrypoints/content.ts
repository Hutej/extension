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
  totalMs: number;
  paidCalls: number;
}

export interface TransformOutcome {
  ok: boolean;
  message?: string;
  kind?: string;         // error kind for popup taxonomy (invalid_key, timeout, etc.)
  reasoning?: string;
  spec?: DesignSpec;
  verify?: VerifyResult;
  perceiveMs?: number;
  clusters?: number;
  changeScore?: number;
  accentFraction?: number;
  modelCoverageFraction?: number;
  wallMs?: number;       // total transform wall-clock
  model?: string;        // which model served the request
  usage?: unknown;       // token usage
  paidCalls?: number;    // paid model calls used
  ledger?: Ledger;       // Round 8: stage-by-stage time breakdown
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

async function runStyle(intent: string): Promise<TransformOutcome> {
  const t0 = Date.now();
  delete document.documentElement.dataset[APPLIED];
  delete document.documentElement.dataset[FAILED];
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
  let compileMsTotal = 0, applyMsTotal = 0, verifyMsTotal = 0;

  for (let iter = 0; iter < 10; iter++) {
    const tcCompile = performance.now();
    const compiled = compileSpec(spec, perception, options);
    compileMsTotal += performance.now() - tcCompile;
    const sanitized = sanitizeCss(compiled.css).css;
    if (!sanitized.trim()) { removeStyleEverywhere(activeShadowRoots); markFailed('no styles'); return { ok: false, message: 'Produced no applicable styles.', spec, reasoning: spec.reasoning, paidCalls: 1 + reReasonsDone, wallMs: Date.now() - t0 }; }

    const tcApply = performance.now();
    applyStyleEverywhere(sanitized, activeShadowRoots);
    applyMsTotal += performance.now() - tcApply;
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    const tcVerify = performance.now();
    const verify = verifyStyle(before, spec.paletteMode, modelAddressed);
    verifyMsTotal += performance.now() - tcVerify;
    lastVerify = verify;
    const notBroken = verify.checks.notBlank && verify.checks.noOverflow && verify.checks.noOverlap && verify.checks.contrastOk && verify.checks.contentCollapsed && verify.checks.contentVisible;
    attempts.push({ spec, css: sanitized, notBroken, changeScore: verify.changeScore, covered: verify.checks.covered, coherent: verify.checks.coherent, changed: verify.checks.changed, contentCollapsed: verify.checks.contentCollapsed });
    logDebug(`iter ${iter}: rules=${compiled.rulesEmitted} baseCoat=${compiled.baseCoatCount} checks=${JSON.stringify(verify.checks)} change=${verify.changeScore.toFixed(3)} accent=${verify.accentFraction.toFixed(3)} framed=${verify.framedFraction.toFixed(3)} coverage=${verify.coverageFraction.toFixed(3)} modelCov=${verify.modelCoverageFraction.toFixed(3)} bleeds=${verify.bleedTargets.length} squeezes=${verify.squeezeTargets.length} repeatedAccent=${verify.repeatedAccent}${compiled.droppedProps.length ? ' dropped=[' + compiled.droppedProps.slice(0, 12).join(',') + ']' : ''}`);
    logDebug(`  detail: ${verify.details.join(' | ')}`);

    if (verify.passed) break;

    const decision = planRepair(verify, options, reReasonsDone, spec.paletteMode);
    logDebug(`repair -> ${decision.action}: ${decision.reason}`);

    if (decision.action === 'rollback') { removeStyleEverywhere(activeShadowRoots); markFailed('content blanked'); return { ...failVerify(spec, verify), paidCalls: 1 + reReasonsDone, wallMs: Date.now() - t0 }; }

    if (decision.action === 'keepBest') {
      const best = bestNonBroken(attempts);
      if (!best) { removeStyleEverywhere(activeShadowRoots); markFailed('nothing non-broken'); return { ...failVerify(spec, verify), paidCalls: 1 + reReasonsDone, wallMs: Date.now() - t0 }; }
      applyStyleEverywhere(best.css, activeShadowRoots);
      spec = best.spec;
      break;
    }

    if (decision.action === 'reReason') {
      // Latency guard: if the 1st call already consumed >60s (YouTube's 1st call ran
      // ~116s near its 120s timeout), a 2nd call — even capped — pushes total past the
      // 130s harness marker. Skip it, keepBest, ship what we have. No timeout, no
      // wasted 2nd call. The reReason is a prompt-failure signal anyway.
      if (Date.now() - t0 > 60000) {
        logDebug('reReason skipped — elapsed > 60s (latency budget); keepBest instead');
        const best = bestNonBroken(attempts);
        if (best) { applyStyleEverywhere(best.css, activeShadowRoots); spec = best.spec; break; }
        removeStyleEverywhere(activeShadowRoots); markFailed('latency budget — no revision'); return { ...failVerify(spec, verify), paidCalls: 1 + reReasonsDone, wallMs: Date.now() - t0 };
      }
      const failing = Object.entries(verify.checks).filter(([, v]) => !v).map(([k]) => k).join(',');
      logDebug(`PAID SECOND CALL — first-call prompt failed to prevent: ${failing}`);
      reReasonsDone++;
      const re = await askForSpec(intent, serialized, decision.critique, Math.max(15000, 115000 - (Date.now() - t0)));
      if (re.callMs != null) modelCalls.push({ ms: re.callMs, promptTokens: (re.usage as { prompt_tokens?: number })?.prompt_tokens });
      if (re.ok && re.spec) { spec = re.spec; options = { paletteMode: spec.paletteMode }; continue; }
      const best = bestNonBroken(attempts);
      if (best) { applyStyleEverywhere(best.css, activeShadowRoots); spec = best.spec; break; }
      removeStyleEverywhere(activeShadowRoots); markFailed('revision failed'); return { ...failVerify(spec, verify), paidCalls: 1 + reReasonsDone, wallMs: Date.now() - t0 };
    }

    options = decision.options;
  }

  // Ledger — stage-by-stage time breakdown (Round 8: instrument before you fix).
  const totalMs = Date.now() - t0;
  const ledger: Ledger = {
    perceiveMs: perception.builtInMs, serializeChars,
    modelCalls, compileMs: Math.round(compileMsTotal),
    applyMs: Math.round(applyMsTotal), verifyMs: Math.round(verifyMsTotal),
    totalMs, paidCalls: 1 + reReasonsDone,
  };
  const modelMsStr = modelCalls.map((c) => `${c.ms}ms/${c.promptTokens ?? '?'}tok`).join(', ');
  logDebug(`LEDGER perceive=${ledger.perceiveMs}ms serialize=${serializeChars}chars model=[${modelMsStr}] compile=${ledger.compileMs}ms apply=${ledger.applyMs}ms verify=${ledger.verifyMs}ms total=${totalMs}ms paidCalls=${ledger.paidCalls}`);

  // Persist + defend + mark applied.
  const key = storageKey();
  const state = await loadSiteState(key);
  const id = `style_${Date.now()}`;
  const appliedCss = document.getElementById('webmorph-style')?.textContent ?? attempts[attempts.length - 1]?.css ?? '';
  state.enabled = true;
  state.style = { id, intent, spec, css: appliedCss, reasoning: spec.reasoning, compileOptions: options, createdAt: Date.now() };
  await saveSiteState(key, state);

  startDefenseEverywhere(state.style.css, activeShadowRoots);
  activeSpec = spec;
  activeOpts = options;
  startDynamicDefense();
  ensureEscapeUI(toggleSiteState);
  markApplied(id);

  return {
    ok: true, reasoning: spec.reasoning, spec, verify: lastVerify || undefined,
    perceiveMs: perception.builtInMs, clusters: perception.clusters.length,
    changeScore: lastVerify?.changeScore, accentFraction: lastVerify?.accentFraction,
    modelCoverageFraction: lastVerify?.modelCoverageFraction,
    wallMs: totalMs, model: specRes.model, usage: specRes.usage,
    paidCalls: 1 + reReasonsDone, ledger,
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
          inFlight = runStyle(intent).finally(() => { inFlight = null; });
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

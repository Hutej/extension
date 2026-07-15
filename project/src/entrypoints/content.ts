/**
 * content — the Phase-1 pipeline orchestrator, running in the page.
 *
 *   perceive -> (background: reason -> DesignSpec) -> compile -> apply CSS
 *            -> verify(before) -> repair loop (recompile / re-reason / keepBest)
 *            -> persist
 *
 * DOM-move execution is DEFERRED: the compiler plans moves but this loop applies
 * CSS only. On success/failure it sets a real marker on <html> so the test
 * harness (and any tooling) can wait on the true applied signal.
 */

import { perceive, serializePerception, clearHandles, captureLayoutFingerprint } from '@/core/perceive';
import { compileSpec, type CompileOptions } from '@/core/compile';
import { sanitizeCss } from '@/core/sanitize';
import { verifyStyle, type VerifyResult } from '@/core/verify';
import { planRepair, bestNonBroken, type Attempt } from '@/core/repair';
import { checkCompleteness } from '@/core/spec';
import { applyStyle, removeStyle, startDefense, ensureEscapeUI, removeEscapeUI } from '@/core/execute';
import { loadSiteState, saveSiteState, clearSiteState } from '@/core/persist';
import { MAX_REPAIR_ATTEMPTS, logDebug } from '@/core/config';
import type { DesignSpec } from '@/core/spec';

interface SpecResponse { ok: boolean; spec?: DesignSpec; kind?: string; message?: string; usage?: unknown; model?: string; }

export interface TransformOutcome {
  ok: boolean;
  message?: string;
  reasoning?: string;
  spec?: DesignSpec;
  verify?: VerifyResult;
  perceiveMs?: number;
  clusters?: number;
  changeScore?: number;
  accentFraction?: number;
}

const APPLIED = 'webmorphApplied';
const FAILED = 'webmorphFailed';

// In-flight guard: a duplicate Transform (double-click, harness retry) must NOT
// start a second model call — two racing runs let the WEAKER spec land last and
// overwrite the stronger one (seen live: 0.623 overwritten by 0.338). Every
// caller of a duplicate request gets the same in-flight run's outcome.
let inFlight: Promise<TransformOutcome> | null = null;

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
  delete document.documentElement.dataset[APPLIED];
  delete document.documentElement.dataset[FAILED];

  clearHandles();
  const perception = perceive();
  const serialized = serializePerception(perception);
  const before = captureLayoutFingerprint();
  logDebug(`perceived ${perception.nodeCount} nodes -> ${perception.clusters.length} clusters (${perception.builtInMs}ms)`);

  let specRes = await askForSpec(intent, serialized);
  if (!specRes.ok || !specRes.spec) { markFailed(specRes.message || 'engine failed'); return { ok: false, message: specRes.message || 'Design engine failed.' }; }
  let spec = specRes.spec;
  // Surface served-model + token usage on the PAGE console so the test harness
  // (which can't see the background service worker) can report real cost per run.
  logDebug(`served by=${specRes.model ?? '?'} usage=${JSON.stringify(specRes.usage ?? {})}`);
  logDebug(`paletteMode=${spec.paletteMode ?? 'restrained(default)'} rules=${spec.rules.length} composition=${spec.composition?.length ?? 0} clusters=${perception.clusters.length}`);

  let reReasonsDone = 0;

  // ── Completeness contract (Mechanism 1) — BEFORE apply. Every retained cluster
  // must be accounted for (restyled / hidden / kept). An incomplete spec routes
  // the single reReason budget with a critique that names the unaccounted clusters.
  {
    const comp = checkCompleteness(spec, perception.handles);
    if (!comp.ok) {
      logDebug(`INCOMPLETE SPEC — ${comp.unaccounted.length}/${perception.handles.size} clusters unaccounted: ${comp.unaccounted.slice(0, 16).join(', ')}`);
      if (reReasonsDone < MAX_REPAIR_ATTEMPTS) {
        reReasonsDone++;
        logDebug('PAID SECOND CALL — first-call prompt failed to account for all clusters');
        const critique = `Your spec left ${comp.unaccounted.length} cluster(s) unaccounted: ${comp.unaccounted.slice(0, 24).join(', ')}. EVERY cluster handle in the COMPONENTS list MUST appear in your rules — restyle it (styles/layout), hide it ("hide": true), or explicitly keep it ("keep": true) if its original design already serves the aesthetic. A spec that ignores clusters is incomplete and will be rejected. Family-consistency reminder: if you restyle one cluster of a family (e.g. one group of links), restyle every cluster of that family in the same visual language.`;
        const re = await askForSpec(intent, serialized, critique);
        if (re.ok && re.spec) {
          spec = re.spec;
          const comp2 = checkCompleteness(spec, perception.handles);
          logDebug(`revised spec: ${comp2.ok ? 'complete' : `${comp2.unaccounted.length} still unaccounted — proceeding to verify`}`);
        }
      }
    } else {
      logDebug(`completeness OK — all ${perception.handles.size} clusters accounted for`);
    }
  }

  let options: CompileOptions = { paletteMode: spec.paletteMode };
  const attempts: Attempt[] = [];
  let lastVerify: VerifyResult | null = null;

  for (let iter = 0; iter < 10; iter++) { // deterministic escalation is monotonic; cap is a safety net
    const compiled = compileSpec(spec, perception, options);
    const sanitized = sanitizeCss(compiled.css).css;
    if (!sanitized.trim()) { removeStyle(); markFailed('no styles'); return { ok: false, message: 'Produced no applicable styles.', spec, reasoning: spec.reasoning }; }

    applyStyle(sanitized); // CSS only — planned moves (compiled.ops) are NOT executed this slice
    // Wait one rAF tick: !important injection via appendChild needs a layout pass before
    // getComputedStyle (used by verify's contrast + fingerprint) reflects the new values.
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    const verify = verifyStyle(before, spec.paletteMode);
    lastVerify = verify;
    const notBroken = verify.checks.notBlank && verify.checks.noOverflow && verify.checks.noOverlap && verify.checks.contrastOk;
    attempts.push({ spec, css: sanitized, notBroken, changeScore: verify.changeScore });
    logDebug(`iter ${iter}: rules=${compiled.rulesEmitted} baseCoat=${compiled.baseCoatCount} checks=${JSON.stringify(verify.checks)} change=${verify.changeScore.toFixed(3)} accent=${verify.accentFraction.toFixed(3)} framed=${verify.framedFraction.toFixed(3)} coverage=${verify.coverageFraction.toFixed(3)} bleeds=${verify.bleedTargets.length} squeezes=${verify.squeezeTargets.length} repeatedAccent=${verify.repeatedAccent}${compiled.droppedProps.length ? ' dropped=[' + compiled.droppedProps.slice(0, 12).join(',') + ']' : ''}`);
    logDebug(`  detail: ${verify.details.join(' | ')}`); // per-region coverage verdicts + contrast fails, every run

    if (verify.passed) break;

    const decision = planRepair(verify, options, reReasonsDone, spec.paletteMode);
    logDebug(`repair -> ${decision.action}: ${decision.reason}`);

    if (decision.action === 'rollback') { removeStyle(); markFailed('content blanked'); return failVerify(spec, verify); }

    if (decision.action === 'keepBest') {
      const best = bestNonBroken(attempts);
      if (!best) { removeStyle(); markFailed('nothing non-broken'); return failVerify(spec, verify); }
      applyStyle(best.css);
      spec = best.spec;
      break; // keep the best non-broken attempt (a flat result is KEPT, not reverted)
    }

    if (decision.action === 'reReason') {
      // ONE-SHOT MANDATE: a paid second call means the first-call prompt failed to
      // prevent this. Log loudly — it is a to-do for the system prompt, not a
      // steady state. (Budget is MAX_REPAIR_ATTEMPTS = 1.)
      const failing = Object.entries(verify.checks).filter(([, v]) => !v).map(([k]) => k).join(',');
      logDebug(`PAID SECOND CALL — first-call prompt failed to prevent: ${failing}`);
      reReasonsDone++;
      const re = await askForSpec(intent, serialized, decision.critique);
      if (re.ok && re.spec) { spec = re.spec; options = { paletteMode: spec.paletteMode }; continue; }
      const best = bestNonBroken(attempts);
      if (best) { applyStyle(best.css); spec = best.spec; break; }
      removeStyle(); markFailed('revision failed'); return failVerify(spec, verify);
    }

    options = decision.options; // recompile (deterministic escalation)
  }

  // Persist + defend + mark applied.
  const origin = window.location.origin;
  const state = await loadSiteState(origin);
  const id = `style_${Date.now()}`;
  // ponytail: persist exactly what's on the page — the verified, repair-baked CSS.
  // Re-compiling here (as the old code did) discards all repair options and persists
  // a stylesheet that would have FAILED verify. The DOM is the source of truth.
  const appliedCss = document.getElementById('webmorph-style')?.textContent ?? attempts[attempts.length - 1]?.css ?? '';
  state.enabled = true;
  state.style = { id, intent, spec, css: appliedCss, reasoning: spec.reasoning, createdAt: Date.now() };
  await saveSiteState(origin, state);

  startDefense(state.style.css);
  ensureEscapeUI(toggleSiteState);
  markApplied(id);

  return {
    ok: true, reasoning: spec.reasoning, spec, verify: lastVerify || undefined,
    perceiveMs: perception.builtInMs, clusters: perception.clusters.length,
    changeScore: lastVerify?.changeScore, accentFraction: lastVerify?.accentFraction,
  };
}

function failVerify(spec: DesignSpec, verify: VerifyResult): TransformOutcome {
  return { ok: false, message: 'Result failed checks: ' + verify.details.slice(0, 3).join('; '), spec, reasoning: spec.reasoning, verify };
}

function askForSpec(intent: string, perception: string, critique?: string): Promise<SpecResponse> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'styleSpec', intent, perception, critique }, (response) => {
      if (chrome.runtime.lastError || !response) resolve({ ok: false, message: chrome.runtime.lastError?.message || 'No response from design engine.' });
      else resolve(response as SpecResponse);
    });
  });
}

// ── Persistence / toggle ───────────────────────────────────────────

async function reapplyStored(): Promise<boolean> {
  const state = await loadSiteState(window.location.origin);
  if (!state.enabled || !state.style?.css) return false;
  // Re-run perceive so the stable hash handles get re-stamped, then inject stored CSS.
  clearHandles();
  perceive();
  applyStyle(state.style.css);
  startDefense(state.style.css);
  ensureEscapeUI(toggleSiteState);
  markApplied(state.style.id);
  return true;
}

async function toggleSiteState(): Promise<void> {
  const origin = window.location.origin;
  const state = await loadSiteState(origin);
  if (!state.style) return;
  state.enabled = !state.enabled;
  await saveSiteState(origin, state);
  if (state.enabled) await reapplyStored();
  else { removeStyle(); removeEscapeUI(); delete document.documentElement.dataset[APPLIED]; }
}

async function removeAll(): Promise<void> {
  removeStyle(); removeEscapeUI();
  delete document.documentElement.dataset[APPLIED];
  await clearSiteState(window.location.origin);
}

// ── Entry ──────────────────────────────────────────────────────────

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',

  main() {
    reapplyStored();

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
      return undefined;
    });
  },
});

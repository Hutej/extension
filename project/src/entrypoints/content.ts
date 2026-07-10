import { buildSemanticMap, serializeForAI, extractDesignContext, serializeDesignContext, serializeThemeContext, type SemanticMap, type SemanticNode } from '@/core/observe';
import { applyPlan, removeStyles, removeAllStyles, injectStoredCSS, tagIsolateSiblings, reapplyBehavior, teardownBehaviors, type ApplyResult } from '@/core/apply';
import { type Plan } from '@/core/plan';
import { loadSiteState, saveSiteState, reidentify, clearSiteState, type ThemeRecord } from '@/core/persist';
import { sanitizeCss } from '@/core/sanitize';
import { verifyTheme, type VerifyResult } from '@/core/verify';
import { MAX_THEME_REGEN_ATTEMPTS, logDebug } from '@/core/config';

import { type PlanResult, type ThemeResult } from '@/core/reason';

import { AI_CONFIG } from '@/core/config';

const STYLE_ELEMENT_ID = 'webmorph-styles';

let lastMap: SemanticMap | null = null;
let lastOutline = '';
let styleObserver: MutationObserver | null = null;

// ── Existing Plan-based transform flow ─────────────────────────────

async function runTransform(intent: string, timings?: Record<string, number>): Promise<PlanResult> {
  const tObserve = performance.now();
  lastMap = buildSemanticMap();
  const serialized = serializeForAI(lastMap, AI_CONFIG.maxOutlineTokens);
  lastOutline = serialized.outline;
  if (timings) timings.observe = performance.now() - tObserve;
  
  if (serialized.truncated) {
    console.log('[WebMorph] Outline was truncated to fit token budget.');
  }
  
  return new Promise((resolve) => {
    const tGen = performance.now();
    chrome.runtime.sendMessage(
      { action: 'transform', intent, outline: lastOutline },
      (response) => {
        if (timings) timings.generate = performance.now() - tGen;
        if (chrome.runtime.lastError) {
          resolve({ ok: false, kind: 'unknown', message: chrome.runtime.lastError.message || 'Error communicating with background' });
        } else {
          resolve(response as PlanResult);
        }
      }
    );
  });
}

// ── NEW: Theme-based re-skin flow ──────────────────────────────────

async function runTheme(intent: string, timings?: Record<string, number>): Promise<ThemeResult> {
  const tObserve = performance.now();
  lastMap = buildSemanticMap();
  const outlineStr = serializeThemeContext(lastMap);
  const designCtx = extractDesignContext();
  const designContextStr = serializeDesignContext(designCtx);
  if (timings) timings.observe = performance.now() - tObserve;
  
  return new Promise((resolve) => {
    const tGen = performance.now();
    chrome.runtime.sendMessage(
      { action: 'theme', intent, designContext: designContextStr, outline: outlineStr },
      (response) => {
        if (timings) timings.generate = performance.now() - tGen;
        if (chrome.runtime.lastError) {
          resolve({ ok: false, kind: 'unknown', message: chrome.runtime.lastError.message || 'Error communicating with background' });
        } else {
          resolve(response as ThemeResult);
        }
      }
    );
  });
}

// ── Apply theme CSS with sanitization + verification ───────────────

function injectThemeCss(sanitizedCss: string): void {
  // Remove any existing theme/style element first
  const existing = document.getElementById(STYLE_ELEMENT_ID);
  if (existing) existing.remove();

  const style = document.createElement('style');
  style.id = STYLE_ELEMENT_ID;
  style.setAttribute('data-webmorph-ui', 'theme');
  style.textContent = sanitizedCss;
  document.head.appendChild(style);
}

function removeThemeCss(): void {
  const el = document.getElementById(STYLE_ELEMENT_ID);
  if (el) el.remove();
  stopStyleObserver();
}

interface ThemeApplyResult {
  ok: boolean;
  sanitizedCss: string;
  stripReport: { strippedCount: number; stripped: string[] };
  verify: VerifyResult;
  reasoning: string;
  usage?: any;
}

async function applyTheme(intent: string, regenAttempt: number = 0, timings?: Record<string, number>): Promise<ThemeApplyResult> {
  const res = await runTheme(intent, timings);
  
  if (!res.ok) {
    return {
      ok: false,
      sanitizedCss: '',
      stripReport: { strippedCount: 0, stripped: [] },
      verify: { passed: false, checks: { notBlank: false, noOverflow: false, contrastOk: false }, details: [(res as any).message || 'Theme request failed'] },
      reasoning: '',
      usage: undefined,
    };
  }

  const bundle = res.bundle;
  const rawCss = bundle.themeCss || '';
  
  const tSanitize = performance.now();
  const { css: sanitizedCss, report: stripReport } = sanitizeCss(rawCss);
  if (timings) timings.sanitize = performance.now() - tSanitize;
  
  if (stripReport.strippedCount > 0) {
    logDebug('[applyTheme] Sanitizer strip report:', stripReport);
  }

  // Inject the sanitized CSS
  const tApply = performance.now();
  injectThemeCss(sanitizedCss);
  if (timings) timings.apply = performance.now() - tApply;

  // Verify the result
  const tVerify = performance.now();
  const verify = verifyTheme();
  if (timings) timings.verify = performance.now() - tVerify;
  
  if (!verify.passed) {
    logDebug('[applyTheme] Verify FAILED:', verify.details);
    // Rollback
    removeThemeCss();

    // Optionally try ONE regen
    if (regenAttempt < MAX_THEME_REGEN_ATTEMPTS) {
      logDebug('[applyTheme] Attempting regen...');
      return applyTheme(intent, regenAttempt + 1);
    }

    return {
      ok: false,
      sanitizedCss,
      stripReport,
      verify,
      reasoning: bundle.reasoning || '',
      usage: res.usage,
    };
  }

  // Persist the theme
  const origin = window.location.origin;
  const state = await loadSiteState(origin);
  const themeRecord: ThemeRecord = {
    id: `theme_${Date.now()}`,
    intent,
    sanitizedCss,
    reasoning: bundle.reasoning || '',
    createdAt: Date.now(),
  };
  state.theme = themeRecord;
  state.enabled = true;
  await saveSiteState(origin, state);

  // Start defending the style element
  startStyleObserver(sanitizedCss);

  // Ensure escape UI
  ensureEscapeUI();

  return {
    ok: true,
    sanitizedCss,
    stripReport,
    verify,
    reasoning: bundle.reasoning || '',
    usage: res.usage,
  };
}

// ── MutationObserver: defend the <style> element ───────────────────

function startStyleObserver(sanitizedCss: string): void {
  stopStyleObserver();

  styleObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (let i = 0; i < mutation.removedNodes.length; i++) {
        const node = mutation.removedNodes[i];
        if (node instanceof HTMLElement && node.id === STYLE_ELEMENT_ID) {
          logDebug('[StyleObserver] Theme style removed by framework, re-inserting');
          injectThemeCss(sanitizedCss);
          return;
        }
      }
    }
  });

  styleObserver.observe(document.head, { childList: true });
}

function stopStyleObserver(): void {
  if (styleObserver) {
    styleObserver.disconnect();
    styleObserver = null;
  }
}

// ── Escape UI ──────────────────────────────────────────────────────

const ESCAPE_UI_ID = 'webmorph-escape-ui';

function ensureEscapeUI(): void {
  if (document.getElementById(ESCAPE_UI_ID)) return;
  const btn = document.createElement('button');
  btn.id = ESCAPE_UI_ID;
  btn.setAttribute('data-webmorph-ui', 'true');
  btn.textContent = 'WebMorph: Toggle On/Off';
  btn.style.cssText = 'position: fixed; top: 10px; right: 10px; z-index: 2147483647; pointer-events: auto; padding: 12px 24px; background: #e74c3c; color: white; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; box-shadow: 0 4px 6px rgba(0,0,0,0.3); font-family: sans-serif;';
  btn.onclick = () => {
    toggleSiteState();
  };
  document.documentElement.appendChild(btn);
}

// ── Plan apply + save (existing path) ──────────────────────────────

async function applyAndSave(plan: Plan | null, intent: string = ''): Promise<ApplyResult | null> {
  if (!plan) {
    removeStyles();
    return null;
  }
  
  const validIds = new Set<string>();
  if (lastMap) {
    function collect(n: SemanticNode) {
      validIds.add(n.id);
      n.children.forEach(collect);
    }
    lastMap.roots.forEach(collect);
  }
  
  const result = applyPlan(plan, validIds, intent);
  
  const origin = window.location.origin;
  const state = await loadSiteState(origin);
  
  // Save CSS transform records if any CSS was produced
  if (result.transformRecords.length > 0) {
    for (const rec of result.transformRecords) {
      state.transforms.push(rec);
    }
  }
  
  // Save Tier 1 behavior records
  for (const beh of result.behaviorRecords) {
    state.behaviors.push(beh);
  }
  
  if (result.transformRecords.length > 0 || result.behaviorRecords.length > 0) {
    state.enabled = true;
    await saveSiteState(origin, state);
  }
  
  return result;
}

// ── Toggle / persistence ───────────────────────────────────────────

async function toggleSiteState() {
  const origin = window.location.origin;
  const state = await loadSiteState(origin);
  if (state.transforms.length === 0 && state.behaviors.length === 0 && !state.theme) return;
  state.enabled = !state.enabled;
  await saveSiteState(origin, state);
  
  if (state.enabled) {
    initPersistence();
  } else {
    removeStyles();
    removeThemeCss();
    stopStyleObserver();
    const esc = document.getElementById(ESCAPE_UI_ID);
    if (esc) esc.remove();
  }
}

async function initPersistence() {
  const origin = window.location.origin;
  const state = await loadSiteState(origin);
  if (state.enabled && (state.transforms.length > 0 || state.behaviors.length > 0 || state.theme)) {
    const reidResults: any[] = [];
    let fullCss = '';
    
    // Re-apply CSS transforms (hide/isolate)
    for (const transform of state.transforms) {
      if (transform.kind === 'hide' && transform.targetDescriptors) {
        transform.targetDescriptors.forEach((desc, i) => {
          const match = reidentify(desc);
          reidResults.push({ kind: 'hide', desc, matched: !!match, confidence: match?.confidence });
          if (match) {
            match.el.setAttribute('data-wm-target', `${transform.id}_${i}`);
          }
        });
      } else if (transform.kind === 'isolate' && transform.keepDescriptor) {
        const match = reidentify(transform.keepDescriptor);
        reidResults.push({ kind: 'isolate', desc: transform.keepDescriptor, matched: !!match, confidence: match?.confidence });
        if (match) {
           tagIsolateSiblings(match.el, transform.id);
        }
      }
      fullCss += transform.css + '\n';
    }
    
    if (fullCss.trim()) {
      injectStoredCSS(fullCss);
    }

    // Re-apply persisted theme
    if (state.theme && state.theme.sanitizedCss) {
      injectThemeCss(state.theme.sanitizedCss);
      startStyleObserver(state.theme.sanitizedCss);
      ensureEscapeUI();
      reidResults.push({ kind: 'theme', intent: state.theme.intent, applied: true });
    }
    
    // Re-apply Tier 1 behaviors
    for (const behavior of state.behaviors) {
      const result = reapplyBehavior(behavior);
      reidResults.push({ kind: 'behavior', actionType: behavior.actionType, success: result.success });
    }
    
    // Broadcast for tests
    window.postMessage({ type: 'WEBMORPH_REID_RESULTS', results: reidResults }, '*');
    (window as any).__webmorphReidResults = reidResults;
  }
}

// ── Content script entry ───────────────────────────────────────────

export default defineContentScript({
  matches: ['<all_urls>'],

  main() {
    initPersistence();

    window.addEventListener('message', async (e) => {
      if (e.data && e.data.type === 'WEBMORPH_RESET_CLICKED') {
        toggleSiteState();
      }
    });

    if (import.meta.env.DEV) {
      window.addEventListener('message', async (e) => {
        if (e.data && e.data.type === 'WEBMORPH_TEST_RUN') {
          try {
            const res = await runTransform(e.data.intent);
            if (res.ok) {
              const result = await applyAndSave(res.plan, e.data.intent);
              window.postMessage({ type: 'WEBMORPH_TEST_RESULT', plan: res.plan, result }, '*');
            } else {
              window.postMessage({ type: 'WEBMORPH_TEST_RESULT', error: JSON.stringify(res), kind: res.kind }, '*');
            }
          } catch (err: any) {
            window.postMessage({ type: 'WEBMORPH_TEST_RESULT', error: err.message }, '*');
          }
        } else if (e.data && e.data.type === 'WEBMORPH_TEST_THEME') {
          try {
            const result = await applyTheme(e.data.intent);
            window.postMessage({ type: 'WEBMORPH_TEST_THEME_RESULT', result }, '*');
          } catch (err: any) {
            window.postMessage({ type: 'WEBMORPH_TEST_THEME_RESULT', error: err.message }, '*');
          }
        } else if (e.data && e.data.type === 'WEBMORPH_TEST_RESET') {
          removeStyles();
          removeThemeCss();
          stopStyleObserver();
          window.postMessage({ type: 'WEBMORPH_TEST_RESET_DONE' }, '*');
        } else if (e.data && e.data.type === 'WEBMORPH_TEST_REMOVE_ALL') {
          clearSiteState(window.location.origin).then(() => {
            removeAllStyles();
            removeThemeCss();
            stopStyleObserver();
            const esc = document.getElementById(ESCAPE_UI_ID);
            if (esc) esc.remove();
            window.postMessage({ type: 'WEBMORPH_TEST_REMOVE_ALL_DONE' }, '*');
          });
        } else if (e.data && e.data.type === 'WEBMORPH_TEST_GET_MAP') {
          const serializableRoots = lastMap ? JSON.parse(JSON.stringify(lastMap.roots)) : [];
          window.postMessage({ type: 'WEBMORPH_TEST_MAP', map: { roots: serializableRoots } }, '*');
        } else if (e.data && e.data.type === 'WEBMORPH_TEST_GET_DESIGN_CONTEXT') {
          const ctx = extractDesignContext();
          const serialized = serializeDesignContext(ctx);
          window.postMessage({ type: 'WEBMORPH_TEST_DESIGN_CONTEXT', context: ctx, serialized }, '*');
        } else if (e.data && e.data.type === 'WEBMORPH_TEST_INJECT_ERROR') {
          chrome.runtime.sendMessage({ action: 'INJECT_ERROR', errors: e.data.errors }, () => {});
        } else if (e.data && e.data.type === 'WEBMORPH_CLEAR_KEY') {
          chrome.storage.local.remove('openai_api_key');
        } else if (e.data && e.data.type === 'WEBMORPH_SET_KEY') {
          chrome.storage.local.set({ openai_api_key: e.data.key });
        }
      });
    }

    window.addEventListener('keydown', (e) => {
      if (e.altKey && e.shiftKey && e.key.toLowerCase() === 'r') {
        toggleSiteState();
      }
    });

    browser.runtime.onMessage.addListener(
      (message: { action: string; intent?: string }, _sender) => {
        if (message.action === 'transform' && message.intent) {
          const intent = message.intent;
          const tStart = performance.now();
          const timings: Record<string, number> = {};

          return new Promise((resolve) => {
            const tClassifyStart = performance.now();
            chrome.runtime.sendMessage({ action: 'classify', intent }, (classRes) => {
              timings.classify = performance.now() - tClassifyStart;
              if (chrome.runtime.lastError || !classRes) {
                resolve({ ok: false, kind: 'unknown', message: 'Error classifying intent.' });
                return;
              }
              
              if (classRes.classification === 'theme') {
                const tThemeStart = performance.now();
                applyTheme(intent, 0, timings)
                  .then(result => {
                    timings.total = performance.now() - tStart;
                    console.log('Theme Transform Timings (ms):', JSON.stringify(timings));
                    resolve({ ok: result.ok, kind: 'theme', result });
                  })
                  .catch(err => resolve({ ok: false, kind: 'unknown', message: err.message }));
              } else {
                const tPlanStart = performance.now();
                runTransform(intent, timings)
                  .then(async res => {
                    if (res.ok) {
                      const tApplyStart = performance.now();
                      const result = await applyAndSave(res.plan, intent);
                      timings.apply = performance.now() - tApplyStart;
                      const totalTargetDesc = result?.transformRecords?.reduce((acc, r) => acc + (r.targetDescriptors?.length || 0), 0) || 0;
                      timings.total = performance.now() - tStart;
                      console.log('Plan Transform Timings (ms):', JSON.stringify(timings));
                      resolve({ ok: true, plan: res.plan, result, count: totalTargetDesc, kind: 'plan' });
                    } else {
                      resolve(res);
                    }
                  })
                  .catch(err => resolve({ ok: false, kind: 'unknown', message: err.message }));
              }
            });
          });
        } else if (message.action === 'reset') {
          return applyAndSave(null).then(() => ({ ok: true }));
        } else if (message.action === 'toggle') {
          return toggleSiteState().then(() => ({ ok: true }));
        } else if (message.action === 'remove_all') {
          return clearSiteState(window.location.origin).then(() => {
            removeAllStyles();
            removeThemeCss();
            stopStyleObserver();
            return { ok: true };
          });
        }
      }
    );
  },
});

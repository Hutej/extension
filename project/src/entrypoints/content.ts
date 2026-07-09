import { buildSemanticMap, serializeForAI, type SemanticMap, type SemanticNode } from '@/core/observe';
import { applyPlan, removeStyles, removeAllStyles, injectStoredCSS, tagIsolateSiblings, reapplyBehavior, teardownBehaviors, type ApplyResult } from '@/core/apply';
import { type Plan } from '@/core/plan';
import { loadSiteState, saveSiteState, reidentify, clearSiteState } from '@/core/persist';

import { type PlanResult } from '@/core/reason';

let lastMap: SemanticMap | null = null;
let lastOutline = '';

async function runTransform(intent: string): Promise<PlanResult> {
  lastMap = buildSemanticMap();
  const { outline, truncated } = serializeForAI(lastMap);
  lastOutline = outline;
  
  if (truncated) {
    console.log('[WebMorph] Outline was truncated to fit token budget.');
  }
  
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { action: 'transform', intent, outline: lastOutline },
      (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, kind: 'unknown', message: chrome.runtime.lastError.message || 'Error communicating with background' });
        } else {
          resolve(response as PlanResult);
        }
      }
    );
  });
}

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

async function toggleSiteState() {
  const origin = window.location.origin;
  const state = await loadSiteState(origin);
  if (state.transforms.length === 0 && state.behaviors.length === 0) return;
  state.enabled = !state.enabled;
  await saveSiteState(origin, state);
  
  if (state.enabled) {
    initPersistence();
  } else {
    removeStyles();
  }
}

async function initPersistence() {
  const origin = window.location.origin;
  const state = await loadSiteState(origin);
  if (state.enabled && (state.transforms.length > 0 || state.behaviors.length > 0)) {
    const reidResults: any[] = [];
    let fullCss = '';
    
    // Re-apply CSS transforms
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
        } else if (e.data && e.data.type === 'WEBMORPH_TEST_RESET') {
          removeStyles();
          window.postMessage({ type: 'WEBMORPH_TEST_RESET_DONE' }, '*');
        } else if (e.data && e.data.type === 'WEBMORPH_TEST_REMOVE_ALL') {
          clearSiteState(window.location.origin).then(() => {
            removeAllStyles();
            window.postMessage({ type: 'WEBMORPH_TEST_REMOVE_ALL_DONE' }, '*');
          });
        } else if (e.data && e.data.type === 'WEBMORPH_TEST_GET_MAP') {
          const serializableRoots = lastMap ? JSON.parse(JSON.stringify(lastMap.roots)) : [];
          window.postMessage({ type: 'WEBMORPH_TEST_MAP', map: { roots: serializableRoots } }, '*');
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
          return runTransform(message.intent)
            .then(async res => {
              if (res.ok) {
                const result = await applyAndSave(res.plan, message.intent!);
                const totalTargetDesc = result?.transformRecords?.reduce((acc, r) => acc + (r.targetDescriptors?.length || 0), 0) || 0;
                return { ok: true, plan: res.plan, result, count: totalTargetDesc };
              } else {
                return res;
              }
            })
            .catch(err => {
              return { ok: false, kind: 'unknown', message: err.message };
            });
        } else if (message.action === 'reset') {
          return applyAndSave(null).then(() => ({ ok: true }));
        } else if (message.action === 'toggle') {
          return toggleSiteState().then(() => ({ ok: true }));
        } else if (message.action === 'remove_all') {
          return clearSiteState(window.location.origin).then(() => {
            removeAllStyles();
            return { ok: true };
          });
        }
      }
    );
  },
});

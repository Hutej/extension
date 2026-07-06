import { buildSemanticMap, serializeForAI, type SemanticMap, type SemanticNode } from '@/core/observe';
import { applyPlan, removeStyles, removeAllStyles, injectStoredCSS, tagIsolateSiblings, type ApplyResult } from '@/core/apply';
import { type Plan } from '@/core/plan';
import { loadSiteState, saveSiteState, reidentify, clearSiteState } from '@/core/persist';

let lastMap: SemanticMap | null = null;
let lastOutline = '';

async function runTransform(intent: string): Promise<Plan> {
  lastMap = buildSemanticMap();
  lastOutline = serializeForAI(lastMap);
  
  return new Promise((resolve, reject) => {
    browser.runtime.sendMessage(
      { action: 'transform', intent, outline: lastOutline },
      (response: any) => {
        if (browser.runtime.lastError) {
          return reject(browser.runtime.lastError);
        }
        if (response.error) {
          return reject(new Error(response.error));
        }
        resolve(response.plan);
      }
    );
  });
}

async function applyAndReset(plan: Plan | null, intent: string = ''): Promise<ApplyResult | null> {
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
  
  if (result.transformRecord) {
    const origin = window.location.origin;
    const state = await loadSiteState(origin);
    state.transforms.push(result.transformRecord);
    state.enabled = true;
    await saveSiteState(origin, state);
  }
  
  return result;
}

async function toggleSiteState() {
  const origin = window.location.origin;
  const state = await loadSiteState(origin);
  if (state.transforms.length === 0) return;
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
  if (state.enabled && state.transforms.length > 0) {
    const reidResults: any[] = [];
    let fullCss = '';
    
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
    
    injectStoredCSS(fullCss);
    
    // Broadcast for tests
    window.postMessage({ type: 'WEBMORPH_REID_RESULTS', results: reidResults }, '*');
    (window as any).__webmorphReidResults = reidResults;
  }
}

export default defineContentScript({
  matches: ['<all_urls>'],

  main() {
    initPersistence();

    // Expose for Playwright test via postMessage bridge
    window.addEventListener('message', async (e) => {
      if (e.data && e.data.type === 'WEBMORPH_TEST_RUN') {
        try {
          const plan = await runTransform(e.data.intent);
          const result = await applyAndReset(plan, e.data.intent);
          window.postMessage({ type: 'WEBMORPH_TEST_RESULT', plan, result }, '*');
        } catch (err: any) {
          window.postMessage({ type: 'WEBMORPH_TEST_RESULT', error: err.message }, '*');
        }
      } else if (e.data && e.data.type === 'WEBMORPH_TEST_RESET') {
        // Just clear the styles for testing reset
        removeStyles();
        window.postMessage({ type: 'WEBMORPH_TEST_RESET_DONE' }, '*');
      } else if (e.data && e.data.type === 'WEBMORPH_RESET_CLICKED') {
        toggleSiteState();
      } else if (e.data && e.data.type === 'WEBMORPH_TEST_REMOVE_ALL') {
        clearSiteState(window.location.origin).then(() => {
          removeAllStyles();
          window.postMessage({ type: 'WEBMORPH_TEST_REMOVE_ALL_DONE' }, '*');
        });
      } else if (e.data && e.data.type === 'WEBMORPH_TEST_GET_MAP') {
        // Send a serializable version of the map
        const serializableRoots = lastMap ? JSON.parse(JSON.stringify(lastMap.roots)) : [];
        window.postMessage({ type: 'WEBMORPH_TEST_MAP', map: { roots: serializableRoots } }, '*');
      }
    });

    window.addEventListener('keydown', (e) => {
      if (e.altKey && e.shiftKey && e.key.toLowerCase() === 'r') {
        toggleSiteState();
      }
    });

    browser.runtime.onMessage.addListener(
      (message: { action: string; intent?: string }, _sender, sendResponse) => {
        if (message.action === 'transform' && message.intent) {
          runTransform(message.intent)
            .then(async plan => {
              const result = await applyAndReset(plan, message.intent!);
              sendResponse({ ok: true, plan, result });
            })
            .catch(err => {
              sendResponse({ error: err.message });
            });
          return true; // async
        } else if (message.action === 'reset') {
          applyAndReset(null);
          sendResponse({ ok: true });
        } else if (message.action === 'toggle') {
          toggleSiteState();
          sendResponse({ ok: true });
        } else if (message.action === 'remove_all') {
          removeAllStyles();
          sendResponse({ ok: true });
        }
      },
    );
  },
});

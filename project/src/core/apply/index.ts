import { type Plan } from '../plan';
import { findPrimaryContentNode } from '../observe';
import { buildDescriptor, type TargetDescriptor, type TransformRecord } from '../persist';

const STYLE_ELEMENT_ID = 'webmorph-styles';
const ESCAPE_UI_ID = 'webmorph-escape-ui';

export interface ApplyResult {
  count: number;
  dropped: string[];
  expanded: boolean;
  primaryContentId: string | null;
  transformRecord?: TransformRecord;
}

let transformCounter = 0;

/** Apply a plan by generating CSS and injecting it. */
export function applyPlan(plan: Plan, validIds: Set<string>, intent: string): ApplyResult {
  removeStyles(); // Reset first

  let css = '';
  let count = 0;
  const dropped: string[] = [];
  let expanded = false;

  const primaryEl = findPrimaryContentNode();
  const primaryId = primaryEl ? primaryEl.getAttribute('data-wm-id') : null;

  const transformId = `tf_${Date.now()}_${transformCounter++}`;
  const targetDescriptors: TargetDescriptor[] = [];
  let keepDescriptor: TargetDescriptor | null = null;

  if (plan.kind === 'hide') {
    for (const targetId of plan.targetIds) {
      if (validIds.has(targetId)) {
        const targetEl = document.querySelector(`[data-wm-id="${targetId}"]`);
        if (targetEl) {
          if (targetEl.tagName === 'BODY' || targetEl.tagName === 'HTML' || targetEl.hasAttribute('data-webmorph-ui') || targetEl.closest('[data-webmorph-ui]')) {
            dropped.push(targetId);
            continue;
          }
          if (primaryEl && (targetEl === primaryEl || targetEl.contains(primaryEl))) {
            dropped.push(targetId);
            continue;
          }
          
          targetDescriptors.push(buildDescriptor(targetEl));
          const targetClass = `${transformId}_${count}`;
          targetEl.setAttribute('data-wm-target', targetClass);
          css += `[data-wm-target="${targetClass}"] { display: none !important; }\n`;
          count++;
        }
      }
    }
  } else if (plan.kind === 'isolate') {
    if (plan.keepId && validIds.has(plan.keepId)) {
      let keepEl = document.querySelector(`[data-wm-id="${plan.keepId}"]`);
      if (keepEl) {
        if (primaryEl && !keepEl.contains(primaryEl)) {
          let p = keepEl.parentElement;
          while (p && !p.contains(primaryEl)) {
            p = p.parentElement;
          }
          if (p) {
            keepEl = p;
            expanded = true;
          }
        }
        
        keepDescriptor = buildDescriptor(keepEl);
        
        let current: Element | null = keepEl;
        while (current && current !== document.body && current !== document.documentElement) {
          const parent = current.parentElement;
          if (parent) {
            for (let i = 0; i < parent.children.length; i++) {
              const child = parent.children[i];
              if (child !== current && child.tagName !== 'SCRIPT' && child.tagName !== 'STYLE' && child.tagName !== 'LINK') {
                if (child.hasAttribute('data-webmorph-ui') || child.closest('[data-webmorph-ui]')) {
                  continue;
                }
                const targetClass = `${transformId}_iso_${count}`;
                child.setAttribute('data-wm-target', targetClass);
                css += `[data-wm-target="${targetClass}"] { display: none !important; }\n`;
                count++;
              }
            }
          }
          current = parent;
        }
      }
    }
  }

  if (css) {
    const style = document.createElement('style');
    style.id = STYLE_ELEMENT_ID;
    style.textContent = css;
    document.head.appendChild(style);

    if (!document.getElementById(ESCAPE_UI_ID)) {
      const btn = document.createElement('button');
      btn.id = ESCAPE_UI_ID;
      btn.setAttribute('data-webmorph-ui', 'true');
      btn.textContent = 'Reset WebMorph';
      btn.style.cssText = 'position: fixed; top: 10px; right: 10px; z-index: 2147483647; pointer-events: auto; padding: 12px 24px; background: #e74c3c; color: white; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; box-shadow: 0 4px 6px rgba(0,0,0,0.3); font-family: sans-serif;';
      btn.onclick = () => {
        removeStyles();
        window.postMessage({ type: 'WEBMORPH_RESET_CLICKED' }, '*');
      };
      document.documentElement.appendChild(btn);
    }
  }

  const record: TransformRecord = {
    id: transformId,
    intent,
    kind: plan.kind,
    keepDescriptor,
    targetDescriptors,
    css,
    createdAt: Date.now()
  };

  return { count, dropped, expanded, primaryContentId: primaryId, transformRecord: record };
}

export function removeStyles(): void {
  const el = document.getElementById(STYLE_ELEMENT_ID);
  if (el) el.remove();
  
  const tempEls = document.querySelectorAll('[data-wm-target]');
  for (let i = 0; i < tempEls.length; i++) {
    tempEls[i].removeAttribute('data-wm-target');
  }
}

export function removeAllStyles(): void {
  removeStyles();
  const esc = document.getElementById(ESCAPE_UI_ID);
  if (esc) esc.remove();
}

export function injectStoredCSS(css: string): void {
  let style = document.getElementById(STYLE_ELEMENT_ID) as HTMLStyleElement;
  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ELEMENT_ID;
    document.head.appendChild(style);
  }
  style.textContent += css;

  if (!document.getElementById(ESCAPE_UI_ID)) {
    const btn = document.createElement('button');
    btn.id = ESCAPE_UI_ID;
    btn.setAttribute('data-webmorph-ui', 'true');
    btn.textContent = 'WebMorph: Toggle On/Off';
    btn.style.cssText = 'position: fixed; top: 10px; right: 10px; z-index: 2147483647; pointer-events: auto; padding: 12px 24px; background: #e74c3c; color: white; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; box-shadow: 0 4px 6px rgba(0,0,0,0.3); font-family: sans-serif;';
    btn.onclick = () => {
      removeStyles();
      window.postMessage({ type: 'WEBMORPH_RESET_CLICKED' }, '*');
    };
    document.documentElement.appendChild(btn);
  }
}

export function tagIsolateSiblings(keepEl: Element, transformId: string): void {
  let count = 0;
  let current: Element | null = keepEl;
  while (current && current !== document.body && current !== document.documentElement) {
    const parent = current.parentElement;
    if (parent) {
      for (let i = 0; i < parent.children.length; i++) {
        const child = parent.children[i];
        if (child !== current && child.tagName !== 'SCRIPT' && child.tagName !== 'STYLE' && child.tagName !== 'LINK') {
          if (child.hasAttribute('data-webmorph-ui') || child.closest('[data-webmorph-ui]')) {
            continue;
          }
          const targetClass = `${transformId}_iso_${count}`;
          child.setAttribute('data-wm-target', targetClass);
          count++;
        }
      }
    }
    current = parent;
  }
}

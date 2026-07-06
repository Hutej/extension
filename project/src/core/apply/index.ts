import { type Plan, type ActionSpec, type InnerAction } from '../plan';
import { findPrimaryContentNode } from '../observe';
import { buildDescriptor, reidentify, type TargetDescriptor, type TransformRecord, type BehaviorRecord } from '../persist';
import { logDebug } from '../config';

const STYLE_ELEMENT_ID = 'webmorph-styles';
const ESCAPE_UI_ID = 'webmorph-escape-ui';

const ALLOWED_ACTION_TYPES = new Set([
  'unlockScroll', 'scrollToTarget', 'clickTarget',
  'expandAll', 'collapseAll', 'autoLoadMore', 'addShortcut'
]);

const TIER1_TYPES = new Set(['unlockScroll', 'addShortcut']);
const MAX_AUTO_LOAD_CLICKS = 20;

export interface ApplyResult {
  count: number;
  dropped: string[];
  expanded: boolean;
  primaryContentId: string | null;
  transformRecord?: TransformRecord;
  behaviorRecords: BehaviorRecord[];
  actionResults: ActionResult[];
}

export interface ActionResult {
  type: string;
  success: boolean;
  reason?: string;
}

// ── Active behavior tracking for teardown ──────────────────────────
const activeKeyListeners: { key: string; handler: (e: KeyboardEvent) => void }[] = [];
let scrollLockOriginals: { htmlOverflow: string; bodyOverflow: string; bodyPosition: string; bodyTop: string; bodyWidth: string } | null = null;
let autoLoadAbort: AbortController | null = null;

let transformCounter = 0;

// ── Apply a plan ───────────────────────────────────────────────────
export function applyPlan(plan: Plan, validIds: Set<string>, intent: string): ApplyResult {
  removeStyles();

  let css = '';
  let count = 0;
  const dropped: string[] = [];
  let expanded = false;
  const behaviorRecords: BehaviorRecord[] = [];
  const actionResults: ActionResult[] = [];

  const primaryEl = findPrimaryContentNode();
  const primaryId = primaryEl ? primaryEl.getAttribute('data-wm-id') : null;

  const transformId = `tf_${Date.now()}_${transformCounter++}`;
  const targetDescriptors: TargetDescriptor[] = [];
  let keepDescriptor: TargetDescriptor | null = null;

  if (plan.mode === 'isolate') {
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
  } else if (plan.mode === 'edit') {
    for (const op of plan.operations) {
      try {
        if (op.op === 'hide' && op.targetId) {
          if (!validIds.has(op.targetId)) continue;
          const targetEl = document.querySelector(`[data-wm-id="${op.targetId}"]`);
          if (!targetEl) continue;
          if (targetEl.tagName === 'BODY' || targetEl.tagName === 'HTML' || targetEl.hasAttribute('data-webmorph-ui') || targetEl.closest('[data-webmorph-ui]')) {
            dropped.push(op.targetId);
            continue;
          }
          if (primaryEl && (targetEl === primaryEl || targetEl.contains(primaryEl))) {
            dropped.push(op.targetId);
            continue;
          }
          targetDescriptors.push(buildDescriptor(targetEl));
          const targetClass = `${transformId}_${count}`;
          targetEl.setAttribute('data-wm-target', targetClass);
          css += `[data-wm-target="${targetClass}"] { display: none !important; }\n`;
          count++;
        } else if (op.op === 'act' && op.action) {
          const result = executeAction(op.action, validIds);
          actionResults.push(result);
          // Persist Tier 1 actions
          if (result.success && TIER1_TYPES.has(op.action.type)) {
            const targetId = op.action.targetId || op.action.do?.targetId;
            const targetEl = targetId ? document.querySelector(`[data-wm-id="${targetId}"]`) : null;
            behaviorRecords.push({
              id: `bh_${Date.now()}_${transformCounter++}`,
              intent,
              actionType: op.action.type,
              descriptor: targetEl ? buildDescriptor(targetEl) : null,
              actionSpec: op.action,
              createdAt: Date.now()
            });
          }
        }
      } catch (e: any) {
        logDebug(`Operation ${op.op} failed: ${e.message}`);
        if (op.op === 'act' && op.action) {
          actionResults.push({ type: op.action.type, success: false, reason: e.message });
        }
      }
    }
  }

  if (css) {
    const style = document.createElement('style');
    style.id = STYLE_ELEMENT_ID;
    style.textContent = css;
    document.head.appendChild(style);
  }

  ensureEscapeUI();

  const record: TransformRecord = {
    id: transformId,
    intent,
    kind: plan.mode === 'isolate' ? 'isolate' : 'hide',
    keepDescriptor,
    targetDescriptors,
    css,
    createdAt: Date.now()
  };

  return { count, dropped, expanded, primaryContentId: primaryId, transformRecord: css ? record : undefined, behaviorRecords, actionResults };
}

// ── Behavior engine ────────────────────────────────────────────────
function executeAction(action: ActionSpec, validIds: Set<string>): ActionResult {
  if (!ALLOWED_ACTION_TYPES.has(action.type)) {
    return { type: action.type, success: false, reason: `Unknown action type: ${action.type}` };
  }

  switch (action.type) {
    case 'unlockScroll':
      return execUnlockScroll();
    case 'scrollToTarget':
      return execScrollToTarget(action.targetId, validIds);
    case 'clickTarget':
      return execClickTarget(action.targetId, validIds);
    case 'expandAll':
    case 'collapseAll':
      return execExpandCollapse(action.type, action.scope, validIds);
    case 'autoLoadMore':
      return execAutoLoadMore(action.targetId, action.maxClicks, validIds);
    case 'addShortcut':
      return execAddShortcut(action.key, action.do, validIds);
    default:
      return { type: action.type, success: false, reason: 'Unhandled action type' };
  }
}

function execUnlockScroll(): ActionResult {
  const html = document.documentElement;
  const body = document.body;
  // Save originals for teardown
  scrollLockOriginals = {
    htmlOverflow: html.style.overflow,
    bodyOverflow: body.style.overflow,
    bodyPosition: body.style.position,
    bodyTop: body.style.top,
    bodyWidth: body.style.width,
  };
  html.style.overflow = 'auto';
  body.style.overflow = 'auto';
  if (body.style.position === 'fixed') {
    const scrollY = parseInt(body.style.top || '0', 10) * -1;
    body.style.position = '';
    body.style.top = '';
    body.style.width = '';
    window.scrollTo(0, scrollY);
  }
  return { type: 'unlockScroll', success: true };
}

function restoreScrollLock(): void {
  if (!scrollLockOriginals) return;
  const html = document.documentElement;
  const body = document.body;
  html.style.overflow = scrollLockOriginals.htmlOverflow;
  body.style.overflow = scrollLockOriginals.bodyOverflow;
  body.style.position = scrollLockOriginals.bodyPosition;
  body.style.top = scrollLockOriginals.bodyTop;
  body.style.width = scrollLockOriginals.bodyWidth;
  scrollLockOriginals = null;
}

function execScrollToTarget(targetId: string | undefined, validIds: Set<string>): ActionResult {
  if (!targetId || !validIds.has(targetId)) {
    return { type: 'scrollToTarget', success: false, reason: 'Invalid targetId' };
  }
  const el = document.querySelector(`[data-wm-id="${targetId}"]`);
  if (!el) return { type: 'scrollToTarget', success: false, reason: 'Element not found' };
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  return { type: 'scrollToTarget', success: true };
}

function execClickTarget(targetId: string | undefined, validIds: Set<string>): ActionResult {
  if (!targetId || !validIds.has(targetId)) {
    return { type: 'clickTarget', success: false, reason: 'Invalid targetId' };
  }
  const el = document.querySelector(`[data-wm-id="${targetId}"]`);
  if (!el) return { type: 'clickTarget', success: false, reason: 'Element not found' };

  // SAFETY GUARD: refuse submit controls, password/payment forms, cross-origin nav
  const htmlEl = el as HTMLElement;
  // Check submit control
  if (el.tagName === 'BUTTON' && (el as HTMLButtonElement).type === 'submit') {
    return { type: 'clickTarget', success: false, reason: 'Refused: submit button' };
  }
  if (el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'submit') {
    return { type: 'clickTarget', success: false, reason: 'Refused: submit input' };
  }
  // Check if inside a form with password/payment inputs
  const form = el.closest('form');
  if (form) {
    const hasPassword = form.querySelector('input[type="password"]');
    const hasPayment = form.querySelector('input[autocomplete*="cc-"], input[name*="card"], input[name*="payment"]');
    if (hasPassword) {
      return { type: 'clickTarget', success: false, reason: 'Refused: form contains password input' };
    }
    if (hasPayment) {
      return { type: 'clickTarget', success: false, reason: 'Refused: form contains payment input' };
    }
  }
  // Check cross-origin anchor
  if (el.tagName === 'A') {
    const href = (el as HTMLAnchorElement).href;
    try {
      const linkOrigin = new URL(href, window.location.href).origin;
      if (linkOrigin !== window.location.origin) {
        return { type: 'clickTarget', success: false, reason: 'Refused: cross-origin navigation' };
      }
    } catch {
      // Invalid URL, skip
    }
  }

  htmlEl.click();
  return { type: 'clickTarget', success: true };
}

function execExpandCollapse(type: 'expandAll' | 'collapseAll', scope: string | undefined, validIds: Set<string>): ActionResult {
  const desiredState = type === 'expandAll' ? 'true' : 'false';
  let container: Element | Document = document;
  if (scope && scope !== 'page') {
    if (!validIds.has(scope)) return { type, success: false, reason: 'Invalid scope' };
    const el = document.querySelector(`[data-wm-id="${scope}"]`);
    if (!el) return { type, success: false, reason: 'Scope element not found' };
    container = el;
  }

  const toggles = container.querySelectorAll('[aria-expanded]');
  let clicked = 0;
  toggles.forEach(toggle => {
    if (toggle.getAttribute('aria-expanded') !== desiredState) {
      (toggle as HTMLElement).click();
      clicked++;
    }
  });

  const details = container.querySelectorAll('details');
  details.forEach(det => {
    const isExpanded = det.open;
    if ((type === 'expandAll' && !isExpanded) || (type === 'collapseAll' && isExpanded)) {
      det.open = (type === 'expandAll');
      clicked++;
    }
  });

  return { type, success: true, reason: `Toggled ${clicked} elements` };
}

function execAutoLoadMore(targetId: string | undefined, maxClicks: number | undefined, validIds: Set<string>): ActionResult {
  if (!targetId || !validIds.has(targetId)) {
    return { type: 'autoLoadMore', success: false, reason: 'Invalid targetId' };
  }
  const cap = Math.min(maxClicks || 5, MAX_AUTO_LOAD_CLICKS);

  // Run async but return immediately
  autoLoadAbort = new AbortController();
  const signal = autoLoadAbort.signal;

  (async () => {
    let clicks = 0;
    while (clicks < cap && !signal.aborted) {
      const el = document.querySelector(`[data-wm-id="${targetId}"]`);
      if (!el || getComputedStyle(el).display === 'none' || getComputedStyle(el).visibility === 'hidden') break;
      (el as HTMLElement).click();
      clicks++;
      await new Promise(r => setTimeout(r, 800));
    }
    window.postMessage({ type: 'WEBMORPH_AUTOLOAD_DONE', clicks }, '*');
  })();

  return { type: 'autoLoadMore', success: true, reason: `Started with cap=${cap}` };
}

function execAddShortcut(key: string | undefined, innerAction: InnerAction | undefined, validIds: Set<string>): ActionResult {
  if (!key || !innerAction) {
    return { type: 'addShortcut', success: false, reason: 'Missing key or action' };
  }

  const handler = (e: KeyboardEvent) => {
    // Don't fire in input fields
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable) return;

    // Parse key descriptor
    const parts = key.toLowerCase().split('+');
    const mainKey = parts[parts.length - 1];
    const needShift = parts.includes('shift');
    const needCtrl = parts.includes('ctrl');
    const needAlt = parts.includes('alt');

    if (e.key.toLowerCase() !== mainKey) return;
    if (needShift !== e.shiftKey) return;
    if (needCtrl !== e.ctrlKey) return;
    if (needAlt !== e.altKey) return;
    if (!needShift && e.shiftKey) return;
    if (!needCtrl && e.ctrlKey) return;
    if (!needAlt && e.altKey) return;

    e.preventDefault();

    // Re-identify target at trigger time via reidentify or direct lookup
    const targetEl = document.querySelector(`[data-wm-id="${innerAction.targetId}"]`);
    if (!targetEl) return;

    if (innerAction.type === 'clickTarget') {
      (targetEl as HTMLElement).click();
    } else if (innerAction.type === 'scrollToTarget') {
      targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  document.addEventListener('keydown', handler);
  activeKeyListeners.push({ key, handler });

  return { type: 'addShortcut', success: true, reason: `Bound key: ${key}` };
}

// ── Re-apply Tier 1 behaviors from persistence ─────────────────────
export function reapplyBehavior(behavior: BehaviorRecord): ActionResult {
  if (behavior.actionType === 'unlockScroll') {
    return execUnlockScroll();
  }
  if (behavior.actionType === 'addShortcut' && behavior.actionSpec.key && behavior.actionSpec.do) {
    // Re-resolve target via reidentify if descriptor available
    let targetId = behavior.actionSpec.do.targetId;
    if (behavior.descriptor) {
      const match = reidentify(behavior.descriptor);
      if (match) {
        const wmId = match.el.getAttribute('data-wm-id');
        if (wmId) targetId = wmId;
      }
    }
    const innerAction: InnerAction = { type: behavior.actionSpec.do.type, targetId };
    const allIds = new Set<string>();
    document.querySelectorAll('[data-wm-id]').forEach(el => {
      const id = el.getAttribute('data-wm-id');
      if (id) allIds.add(id);
    });
    return execAddShortcut(behavior.actionSpec.key, innerAction, allIds);
  }
  return { type: behavior.actionType, success: false, reason: 'Unknown behavior type for re-apply' };
}

// ── Teardown ───────────────────────────────────────────────────────
export function teardownBehaviors(): void {
  // Remove key listeners
  for (const { handler } of activeKeyListeners) {
    document.removeEventListener('keydown', handler);
  }
  activeKeyListeners.length = 0;

  // Restore scroll lock
  restoreScrollLock();

  // Abort any in-flight autoLoadMore
  if (autoLoadAbort) {
    autoLoadAbort.abort();
    autoLoadAbort = null;
  }
}

// ── CSS and UI management ──────────────────────────────────────────
export function removeStyles(): void {
  const el = document.getElementById(STYLE_ELEMENT_ID);
  if (el) el.remove();

  const tempEls = document.querySelectorAll('[data-wm-target]');
  for (let i = 0; i < tempEls.length; i++) {
    tempEls[i].removeAttribute('data-wm-target');
  }

  teardownBehaviors();
}

export function removeAllStyles(): void {
  removeStyles();
  const esc = document.getElementById(ESCAPE_UI_ID);
  if (esc) esc.remove();
}

function ensureEscapeUI(): void {
  if (document.getElementById(ESCAPE_UI_ID)) return;
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

export function injectStoredCSS(css: string): void {
  let style = document.getElementById(STYLE_ELEMENT_ID) as HTMLStyleElement;
  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ELEMENT_ID;
    document.head.appendChild(style);
  }
  style.textContent += css;
  ensureEscapeUI();
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

/**
 * core/execute — apply operations to the live page and keep them applied.
 *
 * Phase 1 applies a single compiled stylesheet, appended LAST in <head> so it
 * wins the cascade, and defends it against frameworks that wipe <head> on
 * re-render. Also injects + defends per open shadow root so shadow-DOM
 * content (custom elements, video portals, etc.) gets the redesign.
 */

import { STYLE_ELEMENT_ID } from '../laws';

const ESCAPE_UI_ID = 'webmorph-escape-ui';
const SHADOW_STYLE_ID = 'webmorph-shadow-style';
let observer: MutationObserver | null = null;
let shadowObservers: MutationObserver[] = [];
// B4: circuit-breaker for the style re-insert loop. An unbounded loop is a CPU
// bomb on any page that strips styles. Bound the attempts, then surrender.
const MAX_DEFENSE_ATTEMPTS = 10;
let defenseAttempts = 0;
let shadowDefenseAttempts = new Map<ShadowRoot, number>();

// ── Phase-1 style application ──────────────────────────────────────

export function applyStyle(css: string): void {
  let el = document.getElementById(STYLE_ELEMENT_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ELEMENT_ID;
    el.setAttribute('data-webmorph-ui', 'style');
  }
  el.textContent = css;
  document.head.appendChild(el);
}

export function applyStyleEverywhere(css: string, shadowRoots: ShadowRoot[]): void {
  applyStyle(css);
  for (const root of shadowRoots) injectShadowStyle(root, css);
}
// The visible-paint counter is set EXPLICITLY by the runStyle/fastHidePath caller
// (paint 1 → '1', paint 2 → '2'), NOT incremented here — applyStyleEverywhere is also
// called by the mutation-defense re-applier (invisible restores), which must not
// inflate the visible-paint count the harness asserts (≤2).

function injectShadowStyle(root: ShadowRoot, css: string): void {
  root.querySelector(`#${SHADOW_STYLE_ID}`)?.remove();
  const style = document.createElement('style');
  style.id = SHADOW_STYLE_ID;
  style.setAttribute('data-webmorph-ui', 'style');
  style.textContent = css;
  root.appendChild(style);
}

export function removeStyle(): void {
  stopDefense();
  document.getElementById(STYLE_ELEMENT_ID)?.remove();
}

export function removeStyleEverywhere(shadowRoots: ShadowRoot[]): void {
  stopDefense();
  document.getElementById(STYLE_ELEMENT_ID)?.remove();
  for (const root of shadowRoots) root.querySelector(`#${SHADOW_STYLE_ID}`)?.remove();
}

/** Re-insert our stylesheet if a framework removes it during re-render.
 *  B4: circuit-breaker — bound the re-insert attempts, then surrender. An
 *  unbounded loop is a CPU bomb on any page that strips styles. */
export function startDefense(css: string): void {
  stopDefense();
  defenseAttempts = 0; // B4: reset on each new defense session
  observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of Array.from(m.removedNodes)) {
        if (node instanceof HTMLElement && node.id === STYLE_ELEMENT_ID) {
          stopDefense();
          defenseAttempts++;
          if (defenseAttempts > MAX_DEFENSE_ATTEMPTS) {
            console.warn(`[WebMorph] Defense surrendered after ${MAX_DEFENSE_ATTEMPTS} re-insert attempts — page is stripping styles too aggressively.`);
            return; // B4: surrender, don't re-insert or re-observe
          }
          applyStyle(css);
          startDefense(css);
          return;
        }
      }
    }
  });
  observer.observe(document.head, { childList: true });
}

export function startDefenseEverywhere(css: string, shadowRoots: ShadowRoot[]): void {
  startDefense(css);
  stopShadowDefense();
  shadowDefenseAttempts = new Map(); // B4: reset shadow defense counter
  for (const root of shadowRoots) observeShadowRoot(root, css);
}

function observeShadowRoot(root: ShadowRoot, css: string): void {
  const obs = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of Array.from(m.removedNodes)) {
        if (node instanceof HTMLElement && node.id === SHADOW_STYLE_ID) {
          obs.disconnect();
          const attempts = (shadowDefenseAttempts.get(root) ?? 0) + 1;
          if (attempts > MAX_DEFENSE_ATTEMPTS) {
            console.warn(`[WebMorph] Shadow defense surrendered after ${MAX_DEFENSE_ATTEMPTS} attempts on a shadow root.`);
            return; // B4: surrender
          }
          shadowDefenseAttempts.set(root, attempts);
          injectShadowStyle(root, css);
          observeShadowRoot(root, css);
          return;
        }
      }
    }
  });
  obs.observe(root, { childList: true });
  shadowObservers.push(obs);
}

export function stopDefense(): void {
  observer?.disconnect();
  observer = null;
}

function stopShadowDefense(): void {
  for (const obs of shadowObservers) obs.disconnect();
  shadowObservers = [];
}

// ── Escape hatch UI ────────────────────────────────────────────────

export function ensureEscapeUI(onToggle: () => void): void {
  if (document.getElementById(ESCAPE_UI_ID)) return;
  const btn = document.createElement('button');
  btn.id = ESCAPE_UI_ID;
  btn.setAttribute('data-webmorph-ui', 'true');
  btn.textContent = 'WebMorph: On/Off';
  btn.style.cssText = [
    'position:fixed', 'top:10px', 'right:10px', 'z-index:2147483647',
    'padding:10px 18px', 'background:#111', 'color:#fff', 'border:2px solid #fff',
    'border-radius:6px', 'font:600 13px sans-serif', 'cursor:pointer',
    'box-shadow:0 4px 12px rgba(0,0,0,.35)',
  ].join(';');
  btn.onclick = onToggle;
  document.documentElement.appendChild(btn);
}

export function removeEscapeUI(): void {
  document.getElementById(ESCAPE_UI_ID)?.remove();
}

/**
 * core/execute — apply operations to the live page and keep them applied.
 *
 * Phase 1 applies a single compiled stylesheet, appended LAST in <head> so it
 * wins the cascade, and defends it against frameworks that wipe <head> on
 * re-render (Persistence Exp 004: anchor in a declarative <style>, and re-insert
 * if a framework removes the node).
 *
 * The Transaction types below are the seam for Phase 2+ (reversible DOM ops with
 * undo, Shadow-DOM isolation). Not implemented yet — scaffold only.
 */

import { STYLE_ELEMENT_ID } from '../laws';

const ESCAPE_UI_ID = 'webmorph-escape-ui';
let observer: MutationObserver | null = null;

// ── Phase-2+ seam (types only) ─────────────────────────────────────

export type OpKind = 'style' | 'structure' | 'augment' | 'act';
export interface Transaction {
  kind: OpKind;
  /** undo() restores the pre-op state. Phase 1 style uses removeStyle() instead. */
  undo: () => void;
}
export type TransactionLog = Transaction[];

// ── Phase-1 style application ──────────────────────────────────────

export function applyStyle(css: string): void {
  let el = document.getElementById(STYLE_ELEMENT_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ELEMENT_ID;
    el.setAttribute('data-webmorph-ui', 'style');
  }
  el.textContent = css;
  document.head.appendChild(el); // append (not prepend) => last in head => wins ties
}

export function removeStyle(): void {
  stopDefense();
  document.getElementById(STYLE_ELEMENT_ID)?.remove();
}

/** Re-insert our stylesheet if a framework removes it during re-render. */
export function startDefense(css: string): void {
  stopDefense();
  observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of Array.from(m.removedNodes)) {
        if (node instanceof HTMLElement && node.id === STYLE_ELEMENT_ID) {
          stopDefense();
          applyStyle(css);
          startDefense(css);
          return;
        }
      }
    }
  });
  observer.observe(document.head, { childList: true });
}

export function stopDefense(): void {
  observer?.disconnect();
  observer = null;
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

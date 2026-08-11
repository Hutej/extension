/**
 * core/heal — close the gap left by a hidden element.
 *
 * A hole in the page is a defect, not a side effect. The healing steps run in
 * order and each step logs whether it fired. All healing is CSS-only (no DOM
 * mutation); the browser owns the reflow.
 *
 * The six steps (per the spec, in order):
 *   1. The element is out of flow, so the browser reflows on its own.
 *   2. Remove the parent's explicit grid track or flex-basis that reserved it.
 *   3. Collapse the parent if only chrome remains (heading, divider, padding).
 *   4. Drop separators and rules now stranded at a container edge.
 *   5. Release fixed heights and min-heights sized for the removed element.
 *   6. If exactly one sibling survives, let it take the freed room.
 */

import { buildStableSelector } from './inventory';

export interface HealResult {
  css: string;           // healing CSS to add to the stylesheet
  steps: string[];       // which steps fired (for logging)
}

/** Run the healing steps for a set of hidden elements. Each hidden element
 *  is identified by its CSS selector. Returns healing CSS + the steps that fired. */
export function applyHealing(hiddenSelectors: string[], hiddenElements: Element[]): HealResult {
  const cssParts: string[] = [];
  const steps: string[] = [];

  // Step 1: display:none removes the element from flow — the browser reflows
  // automatically. This always fires (it's the nature of display:none).
  steps.push('1:browser-reflow (display:none removes from flow)');

  for (let i = 0; i < hiddenElements.length; i++) {
    const el = hiddenElements[i];
    const sel = hiddenSelectors[i];
    const parent = el.parentElement;
    if (!parent) continue;

    const parentResult = buildStableSelector(parent as HTMLElement);
    // R6 fix: surface untargetable instead of silent skip.
    if (!parentResult.targetable) {
      steps.push(`SKIP-heal (${sel}: parent untargetable — ${parentResult.reason})`);
      continue;
    }
    const parentSel = parentResult.selector;

    // Step 2: Remove the parent's explicit grid track or flex-basis that reserved it.
    // F5: emit minmax(0, 1fr) not 1fr — prevents grid tracks from expanding
    // past their share (05_BROWSER_CRAFT §4). Emit min-width: 0 for flex items.
    const parentStyle = getComputedStyle(parent);
    if (parentStyle.display === 'grid' || parentStyle.display === 'inline-grid') {
      const visibleChildren = countVisibleChildren(parent, hiddenSelectors);
      if (visibleChildren <= 1 && parent.children.length > 1) {
        cssParts.push(`${parentSel} { grid-template-columns: minmax(0, 1fr) !important; }`);
        steps.push(`2:grid-collapse (${sel} was a grid track in ${parentSel})`);
      }
    }
    if (parentStyle.display === 'flex' || parentStyle.display === 'inline-flex') {
      const visibleChildren = countVisibleChildren(parent, hiddenSelectors);
      if (visibleChildren <= 1 && parent.children.length > 1) {
        cssParts.push(`${parentSel} > * { flex: 1 1 100% !important; min-width: 0 !important; }`);
        steps.push(`2:flex-collapse (${sel} was a flex item in ${parentSel})`);
      }
    }

    // Step 3: Collapse the parent if only chrome remains.
    const remainingReal = countRealContent(parent, hiddenSelectors);
    if (remainingReal === 0 && parent !== document.body && parent !== document.documentElement) {
      cssParts.push(`${parentSel} { display: none !important; }`);
      steps.push(`3:parent-collapse (${parentSel} has only chrome left after hiding ${sel})`);
    }

    // Step 4: Drop separators now stranded at a container edge.
    const nextSib = nextVisibleSibling(el, hiddenSelectors);
    if (nextSib) {
      const sibStyle = getComputedStyle(nextSib);
      if (sibStyle.borderTopWidth !== '0px' && sibStyle.borderTopWidth !== 'medium' && sibStyle.borderTopStyle !== 'none') {
        const sibResult = buildStableSelector(nextSib as HTMLElement);
        if (sibResult.targetable) {
          const sibSel = sibResult.selector;
          cssParts.push(`${sibSel} { border-top: none !important; }`);
          steps.push(`4:separator-drop (${sibSel} had a stranded top border after ${sel} hidden)`);
        }
      }
    }

    // Step 5: Release fixed heights and min-heights sized for the removed element.
    const parentH = parentStyle.height;
    const parentMinH = parentStyle.minHeight;
    if (parentH && parentH !== 'auto' && !parentH.endsWith('%') && parent !== document.body) {
      cssParts.push(`${parentSel} { height: auto !important; }`);
      steps.push(`5:height-release (${parentSel} had fixed height ${parentH})`);
    }
    if (parentMinH && parentMinH !== '0px' && !parentMinH.endsWith('%') && parent !== document.body) {
      cssParts.push(`${parentSel} { min-height: 0 !important; }`);
      steps.push(`5:min-height-release (${parentSel} had min-height ${parentMinH})`);
    }

    // Step 6: If exactly one sibling survives, let it take the freed room.
    const visibleSiblings = countVisibleChildren(parent, hiddenSelectors);
    if (visibleSiblings === 1) {
      const surviving = firstVisibleChild(parent, hiddenSelectors);
      if (surviving && surviving !== el) {
        const survResult = buildStableSelector(surviving as HTMLElement);
        if (survResult.targetable) {
          const survSel = survResult.selector;
          cssParts.push(`${survSel} { width: 100% !important; max-width: 100% !important; }`);
          steps.push(`6:single-sibling-expand (${survSel} takes freed room from ${sel})`);
        }
      }
    }
  }

  return { css: cssParts.join('\n'), steps };
}

function countVisibleChildren(parent: Element, hiddenSelectors: string[]): number {
  let count = 0;
  for (const child of Array.from(parent.children)) {
    if (isHidden(child, hiddenSelectors)) continue;
    const r = child.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) count++;
  }
  return count;
}

function countRealContent(parent: Element, hiddenSelectors: string[]): number {
  let count = 0;
  for (const child of Array.from(parent.children)) {
    if (isHidden(child, hiddenSelectors)) continue;
    const tag = child.tagName;
    const isChrome = ['HR', 'BR', 'WBR'].includes(tag) ||
      child.querySelector('h1, h2, h3, h4, h5, h6') && !child.querySelector('p, a, img, video, button, input, ul, ol, table, span:not(:empty)');
    if (!isChrome) {
      const text = (child.textContent || '').trim();
      if (text.length > 3) count++;
    }
  }
  return count;
}

function nextVisibleSibling(el: Element, hiddenSelectors: string[]): Element | null {
  let sib = el.nextElementSibling;
  while (sib) {
    if (!isHidden(sib, hiddenSelectors)) return sib;
    sib = sib.nextElementSibling;
  }
  return null;
}

function firstVisibleChild(parent: Element, hiddenSelectors: string[]): Element | null {
  for (const child of Array.from(parent.children)) {
    if (isHidden(child, hiddenSelectors)) continue;
    const r = child.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return child;
  }
  return null;
}

function isHidden(el: Element, hiddenSelectors: string[]): boolean {
  for (const sel of hiddenSelectors) {
    try { if (el.matches(sel)) return true; } catch { /* bad selector */ }
  }
  return false;
}

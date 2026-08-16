/**
 * core/identity-dom — the live-DOM IdentityDom adapter.
 *
 * The real implementation of core/identity's IdentityDom, reading the live page.
 * Mirrors core/ops/liveDom.ts (the DomAdapter for the transaction layer): keep
 * the pure identity logic DOM-agnostic so it is unit-testable with a fake tree.
 */

import { fingerprint, type IdentityDom } from './identity';

export const liveIdentityDom: IdentityDom = {
  querySelectorAll(selector) {
    try { return Array.from(document.querySelectorAll(selector)); }
    catch { return []; }
  },
  tagName(el) {
    return el.tagName.toLowerCase();
  },
  attrs(el) {
    // Stable order: by attribute name. Live NamedNodeMap iteration order is
    // source order; sort for determinism across re-render.
    return Array.from(el.attributes)
      .map((a) => [a.name, a.value] as [string, string])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  },
  text(el) {
    return el.textContent ?? '';
  },
  childElementCount(el) {
    return el.childElementCount;
  },
  depthFromRoot(el) {
    let depth = 0;
    let n: Element | null = el;
    while (n && n !== document.documentElement) {
      n = n.parentElement;
      if (n === null) break;
      depth++;
      if (depth > 1000) break; // ponytail: cycle guard for detached subtrees
    }
    return depth;
  },
  parent(el) {
    return el.parentElement;
  },
  fingerprintOfRef(el) {
    return fingerprint(el, liveIdentityDom);
  },
};

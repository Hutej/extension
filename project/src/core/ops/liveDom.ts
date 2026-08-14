/**
 * core/ops/liveDom — the live DOM adapter for the op transaction layer.
 *
 * Ported from archive/project/src/core/ops/execute.ts. undoAll goes through
 * this so the inverse logic in txn.ts is DOM-agnostic and unit-testable.
 * The handle is the [data-rv-c] attribute the perception layer stamps.
 */

import type { DomAdapter } from './txn';
import { fingerprint, type IdentityDom } from '../identity';
import { liveIdentityDom } from '../identity-dom';

export const liveDom: DomAdapter = {
  resolve(handle) {
    return document.querySelector<HTMLElement>(`[data-rv-c="${handle}"]`);
  },
  querySelector(selector) {
    return document.querySelector<HTMLElement>(selector);
  },
  parent(node) { return node.parentNode; },
  nextSibling(node) { return node.nextSibling; },
  insertBefore(parent, node, ref) { parent.insertBefore(node, ref); },
  appendChild(parent, node) { parent.appendChild(node); },
  removeChild(parent, node) { parent.removeChild(node); },
  createElement(tag) { return document.createElement(tag); },
  resolveDestination(to) {
    return to ? document.querySelector<HTMLElement>(`[data-rv-c="${to}"]`) : null;
  },
  handleOf(node) {
    return node instanceof HTMLElement ? node.getAttribute('data-rv-c') : null;
  },
  // F1: structural fingerprint of a live node, for the setText undo verify.
  fingerprintOf(node) {
    if (!(node instanceof Element)) return '';
    return fingerprint(node, liveIdentityDom as IdentityDom);
  },
  replaceWith(node, replacement) {
    // Element.replaceWith is the native inverse for a cloned-node setText restore.
    (node as Element).replaceWith(replacement);
  },
};

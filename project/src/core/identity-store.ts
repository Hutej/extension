/**
 * core/identity-store — the content-script session identity map.
 *
 * F1's observe→act bridge that did not exist before. describePage/findElements
 * REGISTER an element's fingerprint (keyed by the selector the model is shown);
 * the act tools CONSULT it before mutating. Keyed by selector because that is
 * the token the model already echoes — no new model-emitted token is required
 * (rule 1: no saved action, but identity is evidence, not an action).
 *
 * Session-only (like the TransactionLog). Lost on reload is correct: a reload
 * must re-perceive (the DOM may have changed), and describePage re-populates on
 * the next loop. This is NOT a second rollback system — it is read-only identity
 * evidence; on a verify-fail the act tool refuses and records no inverse.
 *
 * Pure-in-spirit but holds state: a Map. reset() clears on each "on" (re-apply)
 * alongside resetTxnLog so a fresh cycle re-registers fresh fingerprints.
 */

import { fingerprint, type Fingerprint, type IdentityDom } from './identity';

/** The identity surface the store needs to capture a fingerprint. Same shape
 *  as IdentityDom (the store calls fingerprint(el, dom)). The real one is
 *  liveIdentityDom; tests inject a fake. */
export type IdentityStoreDom = IdentityDom;

/** Keyed by selector (the model-facing token) → observe-time fingerprint. */
const store = new Map<string, Fingerprint>();

/** Register the identity of a region the model can target. Idempotent — the
 *  last observe wins (a re-describePage refreshes the fingerprint). */
export function registerIdentity(selector: string, el: Element, dom: IdentityStoreDom): void {
  if (!selector) return;
  store.set(selector, fingerprint(el, dom));
}

/** Look up the observe-time fingerprint for a selector. null if the model
 *  is using a selector describePage never returned (the resolveTarget guard
 *  refuses this as `no-fingerprint`). */
export function getIdentity(selector: string): Fingerprint | null {
  return store.get(selector) ?? null;
}

/** Clear the map — called on each "on" (re-apply) so a fresh cycle re-registers
 *  fresh fingerprints (mirrors resetTxnLog). */
export function resetIdentityStore(): void {
  store.clear();
}

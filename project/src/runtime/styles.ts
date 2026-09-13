/**
 * runtime/styles — runtime token activation/disarm primitives (S2.2).
 *
 * plan/08 §4: delivered sheets target unique runtime token membership — a
 * namespace is INERT until the runtime attaches its token attribute to the
 * target elements (activation), and inert again the moment it is disarmed.
 * This is what makes a delayed broker ack harmless: an inserted candidate
 * sheet whose namespace was revoked can never bite, because activation
 * refuses revoked namespaces (I07) and disarm strips the attribute before
 * asynchronous cleanup.
 *
 * plan/08 §4 also fixes namespace construction (installation id + resource
 * path, persisted, non-secret); the S4 compiler generates them. These
 * primitives only enforce shape, uniqueness-of-active-namespace and the
 * revoke guard. Exact-match bookkeeping: only attributes this ledger wrote
 * are removed by disarm — page-written attributes are never touched
 * (plan/08: self-mutations matched against exact resource writes).
 *
 * DOM-free core logic is trivial; the class takes a Document so unit and
 * browser tests exercise the same code path.
 */

export const TOKEN_ATTRIBUTE = 'data-rv2-ns';
/** plan/08 §44: "Rules target unique runtime token membership" — the member
 *  attribute scopes each generated rule to ITS OWN resolved target, so two
 *  rules targeting different elements never override each other through the
 *  shared batch token. Revueon-owned prefix (never a site attribute). */
export const MEMBER_ATTRIBUTE = 'data-rv2-m';
const NAMESPACE_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;

export interface TokenScope {
  /** Attach the namespace token to connected elements. Refuses revoked
   *  namespaces entirely (I07: a cancelled namespace cannot reactivate).
   *  Returns the number of elements activated. */
  activate(namespace: string, elements: Element[]): number;
  /** Remove the token attribute from the given elements (exact match: only
   *  elements whose attribute equals this namespace). Returns removed count. */
  disarm(namespace: string, elements: Element[]): number;
  /** Mark a namespace revoked BEFORE asynchronous cleanup (I07 ordering). */
  revoke(namespace: string): void;
  revoked(): ReadonlySet<string>;
  active(): readonly string[];
  isActive(namespace: string): boolean;
}

export function createTokenScope(doc: Document): TokenScope {
  const active = new Set<string>();
  const revokedSet = new Set<string>();

  return {
    activate(namespace, elements) {
      if (!NAMESPACE_PATTERN.test(namespace) || revokedSet.has(namespace)) return 0;
      let count = 0;
      for (const el of elements) {
        if (!el.isConnected) continue;
        el.setAttribute(TOKEN_ATTRIBUTE, namespace);
        count += 1;
      }
      if (count > 0) active.add(namespace);
      return count;
    },

    disarm(namespace, elements) {
      let count = 0;
      for (const el of elements) {
        if (el.getAttribute(TOKEN_ATTRIBUTE) === namespace) {
          el.removeAttribute(TOKEN_ATTRIBUTE);
          count += 1;
        }
      }
      // A namespace with no remaining attribute is inert — drop it from the
      // active set even if some elements were never passed (they keep no
      // activation semantics: the sheet matches nothing without the token).
      // The namespace pattern is attribute-selector safe, so no escaping.
      if (NAMESPACE_PATTERN.test(namespace) &&
          ![...doc.querySelectorAll(`[${TOKEN_ATTRIBUTE}="${namespace}"]`)].length) {
        active.delete(namespace);
      }
      return count;
    },

    revoke(namespace) {
      revokedSet.add(namespace);
      active.delete(namespace);
    },

    revoked: () => revokedSet,
    active: () => [...active],
    isActive: (namespace) => active.has(namespace),
  };
}

/** The bounded membership identity for a declared target: the targetRef or
 *  localRef sanitized to attribute-safe characters ([A-Za-z0-9_-], ≤ 100).
 *  An target without either ref has no membership scoping (it matches by the
 *  batch token alone). Deterministic from the persisted operation record, so
 *  recompiles derive the identical membership. */
export function memberIdOf(spec: { targetRef?: string; localRef?: string }): string {
  const raw = spec?.targetRef ?? spec?.localRef ?? '';
  const sanitized = raw.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 100);
  return /^[A-Za-z0-9_-]+$/.test(sanitized) ? sanitized : '';
}

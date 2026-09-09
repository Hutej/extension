/**
 * token-scope.test — S2.2 runtime token activation/disarm primitives
 * (plan/08 §4 token membership; I07 revoke guard).
 *
 * The DOM seam is a minimal faithful stub of the four operations the scope
 * uses (setAttribute/getAttribute/removeAttribute/isConnected) so the exact
 * activation/disarm semantics are provable in plain Node.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTokenScope, TOKEN_ATTRIBUTE } from '../../src/runtime/styles.ts';

interface StubElement {
  attrs: Map<string, string>;
  isConnected: boolean;
}

function makeDoc(...elements: StubElement[]): { doc: Document; els: StubElement[] } {
  const els = elements;
  const doc = {
    querySelectorAll: (sel: string) => {
      const m = sel.match(/\[data-rv2-ns="(.*)"\]/);
      if (!m) return [];
      return els.filter((e) => e.attrs.get(TOKEN_ATTRIBUTE) === m[1]) as unknown as NodeListOf<Element>;
    },
  } as unknown as Document;
  for (const el of els) {
    (el as unknown as Record<string, unknown>).setAttribute = (k: string, v: string) => { el.attrs.set(k, v); };
    (el as unknown as Record<string, unknown>).getAttribute = (k: string) => el.attrs.get(k) ?? null;
    (el as unknown as Record<string, unknown>).removeAttribute = (k: string) => { el.attrs.delete(k); };
  }
  return { doc, els };
}

const el = (isConnected = true): StubElement => ({ attrs: new Map(), isConnected });

const asElements = (els: StubElement[]): Element[] => els as unknown as Element[];

test('activate attaches the token attribute to connected elements only', () => {
  const a = el(true);
  const b = el(false); // detached target — the sheet must not activate on it
  const { doc, els } = makeDoc(a, b);
  const scope = createTokenScope(doc);
  assert.equal(scope.activate('rv2.i.c.r.g.d', asElements(els)), 1);
  assert.equal(a.attrs.get(TOKEN_ATTRIBUTE), 'rv2.i.c.r.g.d');
  assert.equal(b.attrs.has(TOKEN_ATTRIBUTE), false);
  assert.equal(scope.isActive('rv2.i.c.r.g.d'), true);
});

test('I07: a revoked namespace can never be activated', () => {
  const { doc, els } = makeDoc(el());
  const scope = createTokenScope(doc);
  scope.revoke('rv2.i.c.r.g.d');
  assert.equal(scope.activate('rv2.i.c.r.g.d', asElements(els)), 0);
  assert.equal(els[0].attrs.has(TOKEN_ATTRIBUTE), false);
  assert.equal(scope.isActive('rv2.i.c.r.g.d'), false);
});

test('a malformed namespace is refused', () => {
  const { doc, els } = makeDoc(el());
  const scope = createTokenScope(doc);
  assert.equal(scope.activate('bad namespace', asElements(els)), 0);
});

test('disarm removes exactly the matching attribute — foreign tokens untouched', () => {
  const a = el();
  const foreign = el();
  const { doc, els } = makeDoc(a, foreign);
  const scope = createTokenScope(doc);
  scope.activate('rv2.i.c.r.g.d1', [a as unknown as Element]);
  foreign.attrs.set(TOKEN_ATTRIBUTE, 'page-written-value'); // the page owns this one
  assert.equal(scope.disarm('rv2.i.c.r.g.d1', asElements(els)), 1);
  assert.equal(a.attrs.has(TOKEN_ATTRIBUTE), false, 'own token removed');
  assert.equal(foreign.attrs.get(TOKEN_ATTRIBUTE), 'page-written-value', 'the page attribute is never touched');
  assert.equal(scope.isActive('rv2.i.c.r.g.d1'), false);
});

test('revocation takes effect immediately (disarm-before-cleanup ordering)', () => {
  const a = el();
  const { doc, els } = makeDoc(a);
  const scope = createTokenScope(doc);
  scope.activate('rv2.i.c.r.g.d', [a as unknown as Element]);
  scope.revoke('rv2.i.c.r.g.d');
  assert.equal(scope.revoked().has('rv2.i.c.r.g.d'), true);
  assert.equal(scope.isActive('rv2.i.c.r.g.d'), false);
  // Even though the attribute is still present (async cleanup pending), a
  // re-activation for the same namespace is refused.
  assert.equal(scope.activate('rv2.i.c.r.g.d', asElements(els)), 0);
});

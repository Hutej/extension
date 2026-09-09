/**
 * targets.test — S3.1 identity/root registry (plan/07 §3, A2; I15/I26).
 *
 * The registry's DOM surface is six operations (isConnected, tagName,
 * getAttribute, getRootNode, querySelectorAll); the stub reproduces exactly
 * those so the refusal semantics are provable in plain Node.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTargetRegistry, MAX_DISCOVER_MATCHES } from '../../src/runtime/targets.ts';

const EPOCH = { routeEpoch: 0, domRevision: 0, customizationRevision: 0, viewportRevision: 0 };

interface StubNode {
  tag: string;
  attrs: Map<string, string>;
  isConnected: boolean;
  rootNode: unknown;
  children: StubNode[];
}

function stub(tag: string, rootNode: unknown, attrs: Record<string, string> = {}): StubNode {
  const node: StubNode = { tag, attrs: new Map(Object.entries(attrs)), isConnected: true, rootNode, children: [] };
  return node;
}

function stubRoot(): { root: unknown; query: (selector: string) => Element[]; raw: StubNode[]; wrap: (n: StubNode) => Element } {
  const raw: StubNode[] = [];
  const wrappers = new Map<StubNode, Element>();
  const wrap = (n: StubNode): Element => {
    let w = wrappers.get(n);
    if (!w) {
      w = asElement(n);
      wrappers.set(n, w);
    }
    return w; // stable wrapper identity, like real DOM nodes
  };
  const root = { theRoot: true };
  const query = (selector: string): Element[] => {
    // Minimal evaluator: '#id' → id attr; '.cls' → class; tag → tag name.
    // Malformed selectors throw like a real browser evaluator would.
    if (selector.trim().startsWith('>') || selector.includes('>>>')) {
      throw new SyntaxError(`'${selector}' is not a valid selector`);
    }
    const match = (c: StubNode): boolean => {
      if (selector.startsWith('#')) return c.attrs.get('id') === selector.slice(1);
      if (selector.startsWith('.')) {
        const cls = selector.slice(1);
        return (c.attrs.get('class') ?? '').split(/\s+/).includes(cls);
      }
      return c.tag === selector;
    };
    return raw.filter(match).map(wrap);
  };
  return { root, query, raw, wrap };
}

function asElement(n: StubNode): Element {
  // Live getters: tag/connection changes on the stub must be visible through
  // the wrapper, exactly as a real Element reflects DOM changes.
  const el = {
    get tagName() { return n.tag.toUpperCase(); },
    get isConnected() { return n.isConnected; },
    getRootNode: () => n.rootNode,
    getAttribute: (k: string) => n.attrs.get(k) ?? null,
    querySelectorAll: () => [],
  };
  return el as unknown as Element;
}

const docRoot = { isDocument: true };

test('registration issues opaque refs and resolves the exact recorded node', () => {
  const registry = createTargetRegistry();
  registry.registerRoot(docRoot as unknown as Document);
  const a = stub('button', docRoot);
  const el = asElement(a);
  const ref = registry.register(el, 'document', 'button', 0);
  assert.match(ref, /^t\d+$/);
  const resolved = registry.resolve(ref, EPOCH);
  assert.ok(resolved.ok);
  if (resolved.ok) {
    assert.equal(resolved.node === el, true, 'resolution returns the exact recorded node reference');
    assert.equal(resolved.predicates.tag, 'button');
  }
});

test('an unknown ref is missing, never a guess', () => {
  const registry = createTargetRegistry();
  const resolved = registry.resolve('t999', EPOCH);
  assert.equal(resolved.ok, false);
  if (!resolved.ok) assert.equal(resolved.reason, 'missing');
});

test('a disconnected node resolves missing; a moved node resolves stale', () => {
  const registry = createTargetRegistry();
  registry.registerRoot(docRoot as unknown as Document); // first root = 'document'
  const otherRoot = { other: true };
  const otherRootId = registry.registerRoot(otherRoot as unknown as ShadowRoot);
  assert.match(String(otherRootId), /^root-/);
  const a = stub('div', otherRoot);
  const el = asElement(a);
  const ref = registry.register(el, 'root-1', undefined, 0);
  a.isConnected = false; // the stub's isConnected backs the wrapper's view
  assert.equal(registry.resolve(ref, EPOCH).ok, false);
  a.isConnected = true;
  a.rootNode = docRoot; // the node MOVED to the document root
  const moved = registry.resolve(ref, EPOCH);
  assert.ok(!moved.ok && moved.reason === 'stale', 'a node that left its registered root is stale');
  if (!moved.ok) assert.match(moved.detail, /left its registered root/);
  const b = stub('button', docRoot);
  const el2 = asElement(b);
  const ref2 = registry.register(el2, 'document', 'button', 0);
  b.tag = 'span'; // tagName now disagrees with the recorded predicate
  const stale = registry.resolve(ref2, EPOCH);
  assert.ok(!stale.ok && stale.reason === 'stale');
  if (!stale.ok) assert.match(stale.detail, /declared tag changed/);
});

test('a declared role change is stale — identity predicates are re-checked, not assumed', () => {
  const registry = createTargetRegistry();
  registry.registerRoot(docRoot as unknown as Document);
  const a = stub('div', docRoot, { role: 'dialog' });
  const ref = registry.register(asElement(a), 'document', 'dialog', 0, true);
  a.attrs.set('role', 'alert');
  const resolved = registry.resolve(ref, EPOCH);
  assert.ok(!resolved.ok && resolved.reason === 'stale');
  if (!resolved.ok) assert.match(resolved.detail, /declared role changed/);
});

test('A2 discovery is root-local, bounded, and never a first-match', () => {
  const { root, query, raw, wrap } = stubRoot();
  const registry = createTargetRegistry();
  const rootId = registry.registerRoot(root as unknown as ShadowRoot);
  for (let i = 0; i < 3; i++) raw.push(stub('li', root, { class: 'card' }));
  // Wire querySelectorAll through the root record: the registry queries the
  // ROOT object, so the stub root must expose querySelectorAll itself.
  (root as { querySelectorAll?: (s: string) => Element[] }).querySelectorAll = query;
  const found = registry.discover(rootId, '.card', EPOCH);
  assert.ok(found.ok && found.matches.length === 3, 'all bounded matches are returned, not the first');
  if (found.ok) {
    assert.ok(found.matches.every((m) => m.node === wrap(raw[found.matches.indexOf(m)])), 'returned nodes keep stable identity');
  }
  const missing = registry.discover(rootId, '.nothing', EPOCH);
  assert.ok(!missing.ok && missing.reason === 'missing');
  const bad = registry.discover(rootId, '>>>', EPOCH);
  assert.ok(!bad.ok && bad.reason === 'unsupported');
  const unknownRoot = registry.discover('root-999', '.x', EPOCH);
  assert.ok(!unknownRoot.ok && unknownRoot.reason === 'unsupported');
});

test(`A2 discovery refuses unbounded candidate sets (cap ${MAX_DISCOVER_MATCHES})`, () => {
  const { root, query, raw } = stubRoot();
  const registry = createTargetRegistry();
  const rootId = registry.registerRoot(root as unknown as ShadowRoot);
  (root as { querySelectorAll?: (s: string) => Element[] }).querySelectorAll = query;
  for (let i = 0; i < MAX_DISCOVER_MATCHES + 1; i++) raw.push(stub('li', root));
  const over = registry.discover(rootId, 'li', EPOCH);
  assert.ok(!over.ok && over.reason === 'unsupported');
  if (!over.ok) assert.match(over.detail, /exceed the/);
});

test('dispose drops all refs — nothing survives document teardown', () => {
  const registry = createTargetRegistry();
  registry.registerRoot(docRoot as unknown as Document);
  const a = stub('div', docRoot);
  const ref = registry.register(asElement(a), 'document', undefined, 0);
  assert.ok(registry.resolve(ref, EPOCH).ok, 'no role predicate → tag-only check');
  registry.dispose();
  const after = registry.resolve(ref, EPOCH);
  assert.ok(!after.ok && after.reason === 'missing');
  assert.equal(registry.size(), 0);
});

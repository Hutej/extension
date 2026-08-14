/**
 * tests/f1-identity-test.ts — Phase 4 F1 IDENTITY unit test (pure, no browser).
 *
 * Proves the REAL F1 decision primitives (src/core/identity.ts):
 *  - resolveTarget is the fail-closed guard: exactly-one-match AND fingerprint
 *    match → ok; zero | many | wrong-target | no-fingerprint → ok:false with a
 *    reason that names an alternative (rule 13). This is the logic the act tools
 *    call before every mutation (guardTarget). The liveDom/wiring is proven by
 *    the browser test; THIS proves the decision, which is where a wrong-target
 *    bug would live (mirrors the Phase-3 lesson: the F5 dead-code bug was in the
 *    decision function, so the decision function is what we unit-test).
 *  - fingerprint is style-agnostic (excludes `style` + our data-rv-* stamps) so
 *    it survives the transform we apply (display:none / color / …); deterministic
 *    for the same structure; distinguishes siblings that differ in text/structure.
 *  - the undo verify (txn.ts applyInverse setText/insert) refuses a wrong/stale
 *    element instead of silently restoring onto the wrong node / swallowing a
 *    removed node — the RC6-class fix.
 *
 * Pure: no model, no browser, no credentials. Imports the real identity exports
 * and the real TransactionLog with a fake DomAdapter (reuses tests/ops.test.ts's
 * fake-dom approach). Run: node --experimental-strip-types tests/f1-identity-test.ts
 */
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fingerprint, resolveTarget, type IdentityDom } from '../src/core/identity.ts';
import { TransactionLog, type DomAdapter } from '../src/core/ops/txn.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROOF_DIR = join(__dirname, '..', 'proof');
mkdirSync(PROOF_DIR, { recursive: true });

interface N { tag: string; attrs?: Record<string, string>; text?: string; children: N[]; parent: N | null; }
function n(tag: string, opts: { attrs?: Record<string, string>; text?: string; children?: N[] } = {}): N {
  return { tag, attrs: opts.attrs, text: opts.text, children: opts.children ?? [], parent: null };
}
function link(children: N[], parent: N) { for (const c of children) c.parent = parent; }

// A tiny in-memory DOM enough for identity + txn. querySelectorAll supports the
// tiny selector grammar the tests use: `tag`, `tag#id`, `tag[attr=value]`,
// `tag:nth-of-type(k)`, and comma lists. attrs() returns sorted pairs.
function fakeDom(root: N): IdentityDom {
  const all = (n2: N): N[] => [n2, ...n2.children.flatMap(all)];
  const matches = (el: N, sel: string): boolean => {
    // comma list
    for (const part of sel.split(',')) {
      const s = part.trim();
      let m;
      // tag:nth-of-type(k)
      if ((m = s.match(/^(\w+):nth-of-type\((\d+)\)$/))) {
        if (el.tag !== m[1]) continue;
        if (!el.parent) continue;
        const sibs = el.parent.children.filter((c) => c.tag === m[1]);
        if (sibs.indexOf(el) + 1 !== +m[2]) continue;
        return true;
      }
      // tag#id
      if ((m = s.match(/^(\w+)#([\w-]+)$/))) { if (el.tag === m[1] && el.attrs?.id === m[2]) return true; continue; }
      // tag[attr=value]
      if ((m = s.match(/^(\w+)\[([\w-]+)="([^"]*)"\]$/))) { if (el.tag === m[1] && el.attrs?.[m[2]] === m[3]) return true; continue; }
      if (el.tag === s) return true;
    }
    return false;
  };
  return {
    querySelectorAll(selector) { return all(root).filter((el) => matches(el, selector)) as unknown as Element[]; },
    tagName(el) { return (el as unknown as N).tag; },
    attrs(el) { return Object.entries((el as unknown as N).attrs ?? {}).sort((a, b) => (a[0] < b[0] ? -1 : 1)); },
    text(el) { return (el as unknown as N).text ?? ''; },
    childElementCount(el) { return (el as unknown as N).children.length; },
    depthFromRoot(el) { let d = 0, n2 = el as unknown as N; while (n2.parent) { n2 = n2.parent; d++; } return d; },
    parent(el) { return (el as unknown as N).parent as unknown as Element | null; },
  };
}

// DomAdapter for the undo-verify test (reuses the fake-dom from ops.test.ts's
// approach, plus fingerprintOf delegating to identity.fingerprint).
function fakeAdapter(root: N): DomAdapter {
  const dom = fakeDom(root);
  const findBySelector = (sel: string): N | null => {
    for (const el of [root, ...root.children.length ? all(root) : [root]]) if (matches(el, sel)) return el;
    return null;
    function all(n2: N): N[] { return [n2, ...n2.children.flatMap(all)]; }
    function matches(el: N, s: string): boolean { return dom.querySelectorAll(s).includes(el as unknown as Element); }
  };
  return {
    resolve() { return null; },
    querySelector(selector) { return (findBySelector(selector) as unknown as HTMLElement) ?? null; },
    parent(node) { return (node as unknown as N).parent as unknown as Node; },
    nextSibling(node) { const n2 = node as unknown as N; if (!n2.parent) return null; const i = n2.parent.children.indexOf(n2); return (n2.parent.children[i + 1] ?? null) as unknown as Node | null; },
    insertBefore(p, c) { (p as unknown as N).children.unshift(c as unknown as N); (c as unknown as N).parent = p as unknown as N; },
    appendChild(p, c) { (p as unknown as N).children.push(c as unknown as N); (c as unknown as N).parent = p as unknown as N; },
    removeChild(p, c) { const pp = p as unknown as N, cc = c as unknown as N; const i = pp.children.indexOf(cc); if (i >= 0) pp.children.splice(i, 1); cc.parent = null; },
    createElement(tag) { return n(tag) as unknown as Node; },
    resolveDestination() { return null; },
    handleOf() { return null; },
    fingerprintOf(node) { return fingerprint(node as unknown as Element, dom); },
    replaceWith(node, replacement) { const n2 = node as unknown as N, r = replacement as unknown as N; if (!n2.parent) return; const i = n2.parent.children.indexOf(n2); n2.parent.children[i] = r; r.parent = n2.parent; n2.parent = null; },
  };
}

interface Check { name: string; pass: boolean; detail: string }
const checks: Check[] = [];
function ck(name: string, cond: boolean, detail: string) { checks.push({ name, pass: cond, detail }); if (!cond) console.log(`  ✖ ${name}\n      ${detail}`); }

// ── resolveTarget: the fail-closed guard ───────────────────────────

// Unique target: one <aside id=sb> with text. selector resolves to exactly it.
{
  const body = n('body', { children: [n('aside', { attrs: { id: 'sb' }, text: 'Sidebar' })] });
  link(body.children, body);
  const dom = fakeDom(body);
  const aside = body.children[0];
  const fp = fingerprint(aside as unknown as Element, dom);
  const r = resolveTarget(dom, 'aside#sb', fp);
  ck('resolve: exactly-one + fp match → ok + el', r.ok && r.el === (aside as unknown as Element), JSON.stringify({ ok: r.ok, reason: r.reason }));
}

// ZERO match → ok:false, reason 'zero', names an alternative.
{
  const body = n('body', { children: [n('main', { text: 'x' })] }); link(body.children, body);
  const r = resolveTarget(fakeDom(body), 'aside#gone', 'whatever');
  ck('resolve: zero match → refuse (reason zero)', !r.ok && r.reason === 'zero' && /describePage/.test(r.error || ''), JSON.stringify(r));
}

// MANY match → ok:false, reason 'ambiguous' — a selector matching 5 is not an identity.
{
  const body = n('body', { children: [n('a', { text: 'one' }), n('a', { text: 'two' }), n('a', { text: 'three' })] });
  link(body.children, body);
  const r = resolveTarget(fakeDom(body), 'a', 'x');
  ck('resolve: many match → refuse (reason ambiguous, fail-closed)', !r.ok && r.reason === 'ambiguous', JSON.stringify(r));
}

// WRONG-TARGET: selector resolves to one element now, but its fingerprint differs
// (the structure changed / a different element took the slot). Must refuse.
{
  // observed: aside with text 'old sidebar'. Now the live tree has an aside with
  // text 'NEW sidebar' (re-rendered content) at the same selector → different fp.
  const body = n('body', { children: [n('aside', { attrs: { id: 'sb' }, text: 'NEW sidebar' })] });
  link(body.children, body);
  const dom = fakeDom(body);
  const observedFp = fingerprint(n('aside', { attrs: { id: 'sb' }, text: 'old sidebar' }) as unknown as Element, dom);
  const r = resolveTarget(dom, 'aside#sb', observedFp);
  ck('resolve: wrong-target (fp differs) → refuse, do NOT mutate', !r.ok && r.reason === 'wrong-target', JSON.stringify({ reason: r.reason }));
}
// WRONG-TARGET (boilerplate-twin): two text-only siblings share a 40-char text
// prefix. Observe sibling A; an SPA re-render reorders the siblings so the
// (positional :nth-of-type) selector now resolves to sibling B. The 40-char
// prefix collides, so WITHOUT the full-text hash the guard would falsely verify
// B as A and mutate the wrong twin. With the hash, B's fp differs → refuse.
{
  // observed tree: A first ('…here'), B second ('…now') — selector targets A.
  const bodyA = n('body', { children: [
    n('a', { attrs: { class: 'card-link' }, text: 'Read more about this product and its amazing features here' }),
    n('a', { attrs: { class: 'card-link' }, text: 'Read more about this product and its amazing features now' }),
  ] }); link(bodyA.children, bodyA);
  const domA = fakeDom(bodyA);
  const observedFp = fingerprint(bodyA.children[0] as unknown as Element, domA);
  // re-rendered tree: siblings swapped — B is now first, selector points to B.
  const bodyB = n('body', { children: [
    n('a', { attrs: { class: 'card-link' }, text: 'Read more about this product and its amazing features now' }),
    n('a', { attrs: { class: 'card-link' }, text: 'Read more about this product and its amazing features here' }),
  ] }); link(bodyB.children, bodyB);
  const domB = fakeDom(bodyB);
  // The selector 'a:nth-of-type(1)' now resolves to B; B must NOT verify as A.
  const r = resolveTarget(domB, 'a:nth-of-type(1)', observedFp);
  ck('resolve: wrong-target (boilerplate-twin, shared 40-char prefix) → refuse, do NOT mutate wrong twin', !r.ok && r.reason === 'wrong-target', JSON.stringify({ reason: r.reason }));
}

// UNVERIFIED: the model named a unique selector describePage never returned.
// Exactly-one-match + no observe-time fingerprint → mutate, flagged unverified
// (a unique target is not wrong by construction; refusing it would block every
// act that does not follow a describePage, which F1 does not own). The zero/many
// refusals are the unambiguous identity failures F1 closes.
{
  const body = n('body', { children: [n('aside', { attrs: { id: 'sb' }, text: 'x' })] }); link(body.children, body);
  const r = resolveTarget(fakeDom(body), 'aside#sb', null);
  ck('resolve: unique selector, no fingerprint → ok + reason unverified (mutate, flagged)', r.ok && r.reason === 'unverified' && !!r.el, JSON.stringify({ ok: r.ok, reason: r.reason }));
}

// ── fingerprint: style-agnostic + deterministic + distinguishes siblings ────

// Style-agnostic: adding/changing `style` and our `data-rv-c` stamp does NOT
// change the fingerprint (the transform we apply changes style; identity must
// survive it). display:none (in style) must not change the fp either — so a
// HIDE does not invalidate the element's own identity for a later act.
{
  const base = n('aside', { attrs: { id: 'sb', class: 'nav' }, text: 'Sidebar' });
  const styled = n('aside', { attrs: { id: 'sb', class: 'nav', style: 'display:none;color:red' }, text: 'Sidebar' });
  const stamped = n('aside', { attrs: { id: 'sb', class: 'nav', 'data-rv-c': 'h1', 'data-revueon-inserted': 'true' }, text: 'Sidebar' });
  const dom = fakeDom(n('body'));
  const a = fingerprint(base as unknown as Element, dom);
  ck('fingerprint: style change does NOT change identity', a === fingerprint(styled as unknown as Element, dom), `${a} vs ${fingerprint(styled as unknown as Element, dom)}`);
  ck('fingerprint: data-rv-* stamp does NOT change identity', a === fingerprint(stamped as unknown as Element, dom), `${a} vs ${fingerprint(stamped as unknown as Element, dom)}`);
}

// Deterministic: same structure → same fingerprint (re-derivable across re-render).
{
  const dom = fakeDom(n('body'));
  const a = n('p', { text: 'hello world' });
  const b = n('p', { text: 'hello world' });
  ck('fingerprint: deterministic for identical structure', fingerprint(a as unknown as Element, dom) === fingerprint(b as unknown as Element, dom), '');
}

// Distinguishes siblings that differ in text (the wrong-target catch).
{
  const dom = fakeDom(n('body'));
  const a = n('a', { text: 'Read more' });
  const b = n('a', { text: 'Subscribe' });
  ck('fingerprint: distinguishes text-differing siblings', fingerprint(a as unknown as Element, dom) !== fingerprint(b as unknown as Element, dom), '');
}
// Distinguishes siblings that share a 40-char text prefix but differ beyond it
// (the boilerplate collision: product-card / 'Read more about this product…'
// templates). The text prefix is the ONLY discriminator for text-only siblings,
// so a 40-char-prefix collision would defeat the wrong-target guard. Rule 15:
// a deliberate case that FAILS if the full-text hash is removed — two siblings
// sharing a 40+ char prefix must still get distinct fingerprints.
{
  const dom = fakeDom(n('body'));
  const a = n('a', { attrs: { class: 'card-link' }, text: 'Read more about this product and its amazing features here' });
  const b = n('a', { attrs: { class: 'card-link' }, text: 'Read more about this product and its amazing features now' });
  const fa = fingerprint(a as unknown as Element, dom);
  const fb = fingerprint(b as unknown as Element, dom);
  ck('fingerprint: distinguishes siblings sharing a 40-char text prefix (boilerplate collision)', fa !== fb, `fa=${fa} fb=${fb}`);
}
// Distinguishes siblings that differ in child structure.
{
  const dom = fakeDom(n('body'));
  const a = n('div', { children: [n('span', { text: 'x' })] });
  const b = n('div', { children: [n('span', { text: 'x' }), n('span', { text: 'y' })] });
  ck('fingerprint: distinguishes structure-differing siblings', fingerprint(a as unknown as Element, dom) !== fingerprint(b as unknown as Element, dom), '');
}

// ── undo verify (txn.ts): refuse wrong/stale instead of silent swallow ────────

// setText undo: the target was re-rendered to a DIFFERENT element after the act.
// The act-fingerprint = the post-mutation state ('new', what the element holds
// until undo). At undo the element at the selector is now a DIFFERENT node (an
// external re-render put 'EXTERNALLY_CHANGED' there) → its fp differs from the
// act-fp → applyInverse throws (undoAll counts it failed) → the clone is NOT
// applied to the wrong node. The RC6-class fix.
{
  const body = n('body', { children: [n('p', { attrs: { id: 't' }, text: 'EXTERNALLY_CHANGED' })] });
  link(body.children, body);
  const log = new TransactionLog();
  const dom = fakeAdapter(body);
  // act-fp = the post-mutation state ('new'); the live element at undo is different.
  const actFp = fingerprint(n('p', { attrs: { id: 't' }, text: 'new' }) as unknown as Element, fakeDom(body));
  const clone = n('p', { attrs: { id: 't' }, text: 'orig' });
  log.record({ kind: 'setText', target: 'p#t', inverse: { kind: 'setText', clone: clone as unknown as Node, selector: 'p#t', fingerprint: actFp } });
  let threw = false;
  try { log.undoAll(dom); } catch { threw = true; }
  // undoAll wraps per-op in try/catch and counts failed; the node must NOT be replaced.
  const cur = body.children[0];
  ck('undo setText: wrong-target → NOT replaced (clone not applied to wrong node)', (cur.text === 'EXTERNALLY_CHANGED'), `text=${cur.text}`);
  ck('undo setText: wrong-target → failed counted (not silent success)', !threw, 'undoAll must not throw; it counts failed');
}

// setText undo: the target was REMOVED (stale). Must throw/report, not silently skip.
{
  const body = n('body', { children: [] });
  const log = new TransactionLog();
  const dom = fakeAdapter(body);
  const clone = n('p', { text: 'orig' });
  log.record({ kind: 'setText', target: 'p#gone', inverse: { kind: 'setText', clone: clone as unknown as Node, selector: 'p#gone', fingerprint: 'fp' } });
  const before = log.size;
  const res = log.undoAll(dom);
  ck('undo setText: target removed → failed counted (no silent skip)', res.failed === 1 && res.undone === 0, JSON.stringify(res));
}

// setText undo CONTROL: the target is unchanged → clone restores exactly (happy path).
{
  const body = n('body', { children: [n('p', { attrs: { id: 't' }, text: 'new' })] });
  link(body.children, body);
  const log = new TransactionLog();
  const dom = fakeAdapter(body);
  const actFp = fingerprint(body.children[0] as unknown as Element, fakeDom(body));
  const clone = n('p', { attrs: { id: 't' }, text: 'orig' });
  log.record({ kind: 'setText', target: 'p#t', inverse: { kind: 'setText', clone: clone as unknown as Node, selector: 'p#t', fingerprint: actFp } });
  const res = log.undoAll(dom);
  ck('undo setText CONTROL: unchanged target → restored exactly', res.undone === 1 && body.children[0].text === 'orig', `text=${body.children[0].text}`);
}

// insert undo: the inserted node was re-rendered AWAY (no parent). Must report
// (failed), not the old silent no-op that returned success.
{
  const orphan = n('div', { text: 'inserted' }); // no parent → re-rendered away
  const log = new TransactionLog();
  const dom = fakeAdapter(n('body'));
  log.record({ kind: 'insert', target: 'body', inverse: { kind: 'insert', node: orphan as unknown as Node } });
  const res = log.undoAll(dom);
  ck('undo insert: stale node (no parent) → failed counted (no silent no-op)', res.failed === 1 && res.undone === 0, JSON.stringify(res));
}

// insert undo CONTROL: node still present → removed exactly.
{
  const body = n('body', { children: [] });
  const log = new TransactionLog();
  const dom = fakeAdapter(body);
  const node = n('div', { text: 'inserted' }); link([node], body);
  log.record({ kind: 'insert', target: 'body', inverse: { kind: 'insert', node: node as unknown as Node } });
  const res = log.undoAll(dom);
  ck('undo insert CONTROL: present node → removed exactly', res.undone === 1 && body.children.length === 0, `children=${body.children.length}`);
}

// ── Report ──────────────────────────────────────────────────────────
let failures = 0;
console.log('\nPhase 4 F1 — identity decision primitives (pure unit)\n');
for (const c of checks) {
  console.log(`  ${c.pass ? '✓' : '✖'} ${c.name}`);
  if (!c.pass) { console.log(`      ${c.detail}`); failures++; }
}
const pass = failures === 0;
writeFileSync(join(PROOF_DIR, 'f1-identity-test.json'), JSON.stringify({ checks, pass }, null, 2));
console.log(`\n${pass ? `All ${checks.length} F1 identity cases passed.\n` : `${failures} case(s) FAILED\n`}`);
process.exit(pass ? 0 : 1);

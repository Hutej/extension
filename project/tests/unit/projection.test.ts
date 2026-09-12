/**
 * Unit suite for runtime/projection (S8.1, plan/09 §4): the bounded field
 * extraction, canonical item keys, board column planning and the session
 * local-organization semantics. The full DOM view (render, drag, observer
 * slices) lives in the browser suite against a real page.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PAGE_SIZE, RENDER_CAP, UNSORTED_COLUMN,
  canonicalKeyOf, extractFields, organizationFor, planColumns,
} from '../../src/runtime/projection.ts';

const ORIGIN = 'http://127.0.0.1:8123';

// ── canonical item keys ───────────────────────────────────────────────────

test('canonicalKeyOf: same-origin keys are origin-relative; cross-origin keeps the full URL', () => {
  assert.equal(canonicalKeyOf(`${ORIGIN}/pull/12?foo=1`, ORIGIN), '/pull/12?foo=1');
  assert.equal(canonicalKeyOf('https://other.example/p/1', ORIGIN), 'https://other.example/p/1');
});

test('canonicalKeyOf: sensitive query parameters and fragments never identify an item', () => {
  assert.equal(canonicalKeyOf(`${ORIGIN}/pull/12?token=abc&q=2`, ORIGIN), '/pull/12?q=2');
  assert.equal(canonicalKeyOf(`${ORIGIN}/pull/12?session=x#anchor`, ORIGIN), '/pull/12');
  assert.equal(canonicalKeyOf(`${ORIGIN}/pull/12?access_token=z`, ORIGIN), '/pull/12');
  // A business parameter stays: two items differing only in `q` stay distinct.
  assert.notEqual(canonicalKeyOf(`${ORIGIN}/x?q=1`, ORIGIN), canonicalKeyOf(`${ORIGIN}/x?q=2`, ORIGIN));
});

test('canonicalKeyOf: only http(s) links can identify an item', () => {
  assert.equal(canonicalKeyOf('javascript:void(0)', ORIGIN), null);
  assert.equal(canonicalKeyOf('data:text/plain,x', ORIGIN), null);
  assert.equal(canonicalKeyOf('not a url', ORIGIN), null);
});

// ── bounded field extraction ──────────────────────────────────────────────

test('extractFields: title is the item text, redacted and capped', () => {
  // Query-shaped secrets are redacted (the shared evidence redaction policy).
  const item = makeEl({ text: 'Fix login bug?token=sk-123 now', attrs: {} });
  const f = extractFields(item as unknown as Element, ['title']);
  assert.equal(f.title.includes('sk-123'), false, 'sensitive text is redacted');
  assert.ok(f.title.includes('token=[redacted]'));
  assert.ok(f.title.startsWith('Fix login bug'));
  const long = makeEl({ text: 'x'.repeat(500), attrs: {} });
  assert.equal(extractFields(long as unknown as Element, ['title']).title.length, 200);
});

test('extractFields: label is the explicit accessible name only', () => {
  const labeled = makeEl({ text: 'Body text', attrs: { 'aria-label': 'Open pull request #12' } });
  assert.equal(extractFields(labeled as unknown as Element, ['label']).label, 'Open pull request #12');
  const titled = makeEl({ text: 'Body text', attrs: { title: 'Tooltip name' } });
  assert.equal(extractFields(titled as unknown as Element, ['label']).label, 'Tooltip name');
  const plain = makeEl({ text: 'Body text', attrs: {} });
  assert.equal(extractFields(plain as unknown as Element, ['label']).label, null);
});

test('extractFields: link resolves to an absolute http(s) href; unsafe schemes are dropped', () => {
  const linked = makeEl({ text: '', attrs: {}, html: '<a href="/pull/7">PR 7</a>' });
  const f = extractFields(linked as unknown as Element, ['link']);
  assert.equal(f.link, `${ORIGIN}/pull/7`);
  const js = makeEl({ text: '', attrs: {}, html: '<a href="javascript:void(0)">x</a>' });
  assert.equal(extractFields(js as unknown as Element, ['link']).link, null);
  const bare = makeEl({ text: '', attrs: {} });
  assert.equal(extractFields(bare as unknown as Element, ['link']).link, null);
  // An item that IS the anchor works too.
  const selfLink = makeEl({ text: 'self', attrs: { href: '/self/1' }, tag: 'a' });
  assert.equal(extractFields(selfLink as unknown as Element, ['link']).link, `${ORIGIN}/self/1`);
});

test('extractFields: category reads explicit site-declared markers in priority order', () => {
  const both = makeEl({ text: '', attrs: { 'data-status': 'Open', 'data-label': 'bug' } });
  assert.equal(extractFields(both as unknown as Element, ['category']).category, 'Open');
  const onlyLabel = makeEl({ text: '', attrs: { 'data-label': 'bug' } });
  assert.equal(extractFields(onlyLabel as unknown as Element, ['category']).category, 'bug');
  const none = makeEl({ text: '', attrs: { 'data-anything': 'x' } });
  assert.equal(extractFields(none as unknown as Element, ['category']).category, null);
});

// ── board column planning ─────────────────────────────────────────────────

test('planColumns: observed categories in source order, Unsorted last, then user columns', () => {
  const plan = planColumns(['Open', 'Merged'], ['Done'], 12);
  assert.deepEqual(plan.columns, ['Open', 'Merged', UNSORTED_COLUMN, 'Done']);
  assert.equal(plan.displayOf('Merged', null), 'Merged');
  assert.equal(plan.displayOf(null, null), UNSORTED_COLUMN);
  // The user's explicit bucket wins over the observed category.
  assert.equal(plan.displayOf('Open', 'Done'), 'Done');
});

test('planColumns: at the cap, overflow categories fold into the last column', () => {
  const plan = planColumns(['a', 'b', 'c', 'd'], [], 3);
  assert.deepEqual(plan.columns, ['a', 'b', 'c']);
  assert.equal(plan.displayOf('d', null), 'c', 'overflow folds into the last planned column');
  const roomy = planColumns(['a', 'b', 'c'], [], 12);
  assert.deepEqual(roomy.columns, ['a', 'b', 'c', UNSORTED_COLUMN]);
  assert.equal(roomy.displayOf('zz', null), UNSORTED_COLUMN);
});

// ── session local organization ────────────────────────────────────────────

test('organizationFor: one session-scoped organization per customization, surviving re-asks', () => {
  const a = organizationFor('t17-org');
  a.buckets.set('k:/pull/1', 'Done');
  a.seq.set('k:/pull/1', ++a.counter);
  const again = organizationFor('t17-org');
  assert.equal(again, a, 'the same customization re-uses its organization');
  assert.equal(again.buckets.get('k:/pull/1'), 'Done');
  assert.notEqual(organizationFor('t17-org-2'), a, 'different customizations do not share');
});

// ── constants ─────────────────────────────────────────────────────────────

test('render bounds match plan/09 §4 (200 rendered, pagination first)', () => {
  assert.equal(RENDER_CAP, 200);
  assert.equal(PAGE_SIZE, 50);
});

// ── minimal DOM stub for extraction ───────────────────────────────────────

function makeEl(opts: { tag?: string; text?: string; attrs: Record<string, string>; html?: string }): {
  tagName: string; textContent: string; attrs: Map<string, string>; ownerDocument: { URL: string };
  matches(sel: string): boolean; hasAttribute(n: string): boolean; querySelector(sel: string): { getAttribute(n: string): string | null } | null;
  getAttribute(n: string): string | null;
} {
  const attrs = new Map(Object.entries(opts.attrs));
  // Parse the tiny html fragment enough for the one-anchor cases.
  const anchor = opts.html?.match(/href="([^"]*)"/);
  return {
    tagName: (opts.tag ?? 'div').toUpperCase(),
    textContent: opts.text ?? '',
    attrs,
    ownerDocument: { URL: `${ORIGIN}/list` },
    matches: (sel) => sel === 'a[href]' && opts.tag === 'a' || /^\[data-/.test(sel) && attrs.has(sel.slice(1, -1)),
    querySelector: (sel: string) => {
      if (anchor) return { getAttribute: (n: string) => (n === 'href' ? anchor[1] : null) };
      const m = sel.match(/^\[([^\]]+)\]$/);
      if (m && attrs.has(m[1])) return { getAttribute: (n: string) => attrs.get(n) ?? null };
      return null;
    },
    getAttribute: (n) => attrs.get(n) ?? null,
    hasAttribute: (n) => attrs.has(n),
  };
}

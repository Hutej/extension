/**
 * compile.test — S4.1 CSS/content compiler and policy (T07 corpus; I01/I17/I18).
 *
 * The compiler under test is src/runtime/compile.ts: one pinned-parser
 * (css-tree) + policy path. No regex validation replaces the AST; the lexer
 * rejects unsupported syntax; the value policy rejects network-capable
 * constructs; generated selectors are token-scoped :where() wrappers.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileStyleOperation, compileInsertUi, selectorForRule } from '../../src/runtime/compile.ts';
import type { StyleOperation, InsertUiOperation } from '../../src/contracts.ts';

const resolveToken = (t: { targetRef?: string; localRef?: string }): { ok: true; token: string } | { ok: false; detail: string } =>
  t.targetRef === 't1' || t.localRef === 'local-panel'
    ? { ok: true, token: 'tok-1' }
    : { ok: false, detail: `target ${t.targetRef ?? t.localRef} is not observed in this session` };

const compile = (operation: StyleOperation, observedSafeVars?: ReadonlySet<string>) =>
  compileStyleOperation({ operation, namespace: 'rv2.inst.cust.rev.g.doc', resolveToken, observedSafeVars });

const styleOp = (rules: StyleOperation['rules'], keyframes?: StyleOperation['keyframes']): StyleOperation => ({
  kind: 'style',
  rules,
  ...(keyframes ? { keyframes } : {}),
});

const rule = (declarations: StyleOperation['rules'][number]['declarations'], over: Partial<StyleOperation['rules'][number]> = {}) => ({
  target: { targetRef: 't1' },
  surface: 'element' as const,
  state: 'none' as const,
  declarations,
  conditions: [],
  ...over,
});

// ── modern visual syntax compiles (plan/22 AC-03) ────────────────────────

test('T07: modern visual values compile through one parser+policy path', () => {
  const result = compile(styleOp([
    rule([
      { property: 'color', value: 'color-mix(in oklab, red 30%, blue)' },
      { property: 'width', value: 'clamp(240px, 50%, 480px)' },
      { property: 'text-wrap', value: 'balance' },
      { property: 'background', value: 'linear-gradient(to right, rgb(0 0 0 / 50%), transparent)' },
      { property: 'grid-template-columns', value: 'repeat(auto-fit, minmax(120px, 1fr))' },
      { property: 'filter', value: 'drop-shadow(0 1px 2px rgb(0 0 0 / 0.3))' },
      { property: 'clip-path', value: 'inset(10px round 4px)' },
    ]),
  ]));
  assert.ok(result.ok, `modern corpus must compile: ${JSON.stringify(result)}`);
});

test('T22: a fixed responsive mini-player is not rejected by a pixel-ratio heuristic', () => {
  const result = compile(styleOp([
    rule([
      { property: 'position', value: 'fixed' },
      { property: 'width', value: '48px' },
      { property: 'height', value: '48px' },
      { property: 'inset', value: 'auto 16px 16px auto' },
    ]),
  ]));
  assert.ok(result.ok, `fixed 48px player must compile: ${JSON.stringify(result)}`);
  assert.ok(result.ok && result.sheet.highImpact.some((h) => h.risk === 'positions-overlay'),
    'the overlay position claim is surfaced, not silently accepted');
});

// ── network-capable constructs are rejected (I18) ────────────────────────

const UNSAFE_VALUES: Array<[string, string]> = [
  ['url(https://evil.test/x.png)', 'plain url()'],
  ['url("data:image/png;base64,AAAA")', 'data-URI escape hatch'],
  ['image-set("a.png" 1x, "b.png" 2x)', 'image-set strings'],
  ['paint(worklet-name)', 'paint worklet reference'],
  ['attr(data-leak)', 'attr() exfiltration'],
  ['element(#other-node)', 'element() page snapshot'],
  ['cross-fade(url(a.png), url(b.png))', 'cross-fade with urls'],
  ['calc(1px + url(https://x.test))', 'url nested in calc'],
];

for (const [value, label] of UNSAFE_VALUES) {
  test(`T07: ${label} is rejected`, () => {
    const result = compile(styleOp([rule([{ property: 'background', value }])]));
    assert.ok(!result.ok, `unsafe value must be rejected: ${value}`);
    if (!result.ok) {
      assert.equal(result.diagnostics[0].code, 'unsafe-value');
      assert.match(result.diagnostics[0].path, /^rules\[0\]\.declarations\[0\]$/);
    }
  });
}

test('T07: var() laundering is rejected — only --rv-* or observed safe tokens', () => {
  const unknown = compile(styleOp([rule([{ property: 'color', value: 'var(--unknown-site-token)' }])]));
  assert.ok(!unknown.ok, 'an unapproved site token must be rejected');
  const rv = compile(styleOp([rule([{ property: 'color', value: 'var(--rv-accent, red)' }])]));
  assert.ok(rv.ok, '--rv-* tokens are always allowed');
  const observed = compile(styleOp([rule([{ property: 'color', value: 'var(--site-accent)' }])]), new Set(['--site-accent']));
  assert.ok(observed.ok, 'an explicitly observed safe token is allowed');
});

test('I18: the global reset "all" is rejected on website nodes', () => {
  const result = compile(styleOp([rule([{ property: 'all', value: 'unset' }])]));
  assert.ok(!result.ok);
  if (!result.ok) {
    assert.equal(result.diagnostics[0].code, 'policy');
    assert.match(result.diagnostics[0].message, /global reset/);
  }
});

test('I18: legacy executable properties (behavior) are rejected', () => {
  const result = compile(styleOp([rule([{ property: 'behavior', value: 'url(#default#time2)' }])]));
  assert.ok(!result.ok);
});

test('T07: unsupported syntax is rejected explicitly (lexer), never silently kept', () => {
  const result = compile(styleOp([rule([{ property: 'width', value: '10fakemeasure!!' }])]));
  assert.ok(!result.ok);
  if (!result.ok) assert.ok(['unsupported-syntax', 'unsafe-value'].includes(result.diagnostics[0].code));
});

test('T07: unsafe CSS is rejected as a group, never stripped and re-authored', () => {
  const result = compile(styleOp([
    rule([
      { property: 'color', value: 'red' },
      { property: 'background', value: 'url(https://evil.test/x.png)' },
    ]),
  ]));
  assert.ok(!result.ok, 'one unsafe declaration rejects the whole operation');
  if (!result.ok) assert.ok(result.diagnostics.length >= 1);
});

// ── high-impact claims surface the same risk as named operations (I17) ───

test('I17: hiding/cutting declarations compile but are surfaced as high-impact claims', () => {
  const result = compile(styleOp([
    rule([
      { property: 'display', value: 'none' },
      { property: 'pointer-events', value: 'none' },
      { property: 'opacity', value: '0' },
    ]),
  ]));
  assert.ok(result.ok, 'the declarations compile (they are refused at the transaction/risk layer, not silently here)');
  if (result.ok) {
    const risks = result.sheet.highImpact.map((h) => `${h.property}:${h.risk}`).sort();
    assert.deepEqual(risks, ['display:hides-content', 'opacity:hides-content', 'pointer-events:block-interaction'.replace('block-', 'blocks-')].sort());
  }
});

// ── generated selectors: tokens, :where, pseudo placement ────────────────

test('T07: generated selectors are :where token wrappers; pseudo-elements go outside', () => {
  assert.equal(selectorForRule('tok-1', '', 'none', 'element'), ':where([data-rv2-ns="tok-1"])');
  assert.equal(selectorForRule('tok-1', 't3', 'none', 'element'), ':where([data-rv2-ns="tok-1"][data-rv2-m="t3"])');
  assert.equal(selectorForRule('tok-1', '', 'hover', 'element'), ':where([data-rv2-ns="tok-1"]:hover)');
  assert.equal(selectorForRule('tok-1', '', 'none', 'before'), ':where([data-rv2-ns="tok-1"])::before');
  const result = compile(styleOp([
    rule([{ property: 'color', value: 'red' }], { state: 'hover', surface: 'element' }),
    rule([{ property: 'content', value: '"→"' }], { surface: 'after' }),
  ]));
  assert.ok(result.ok);
  if (result.ok) {
    assert.match(result.sheet.css, /:where\(\[data-rv2-ns="tok-1"\]:hover\)/);
    assert.match(result.sheet.css, /:where\(\[data-rv2-ns="tok-1"\]\)::after/);
    // Uniform zero specificity: no id/class selectors of our own.
    assert.equal(result.sheet.css.includes('#'), false, 'no id selectors are generated');
  }
});

test('plan/08 §92: a style rule defaults to important — an intentional override wins the site cascade', () => {
  const result = compile(styleOp([
    rule([{ property: 'background-color', value: '#ffffff' }, { property: 'margin', value: '0' }]),
    rule([{ property: 'background-color', value: 'rebeccapurple' }], { state: 'none', surface: 'element' }),
  ]));
  assert.ok(result.ok);
  if (result.ok) {
    // Omitted priority renders !important (default important for intentional
    // override); the site's own body rules otherwise beat zero specificity.
    const importantCount = (result.sheet.css.match(/!important/g) ?? []).length;
    assert.equal(importantCount, 3, 'three omitted-priority declarations ride important');
    assert.match(result.sheet.css, /background-color: #ffffff !important;/);
    assert.match(result.sheet.css, /margin: 0 !important;/);
  }
});

test('plan/08 §92: an explicit "normal" is the deliberate deference — no important', () => {
  const result = compile(styleOp([
    rule([{ property: 'color', value: 'red', priority: 'normal' }]),
  ]));
  assert.ok(result.ok);
  if (result.ok) {
    assert.equal(result.sheet.css.includes('!important'), false, 'explicit normal defers to the site');
    assert.match(result.sheet.css, /color: red;/);
  }
});

test('T07: content is refused on the element surface, allowed on ::after', () => {
  const bad = compile(styleOp([rule([{ property: 'content', value: '"x"' }])]));
  assert.ok(!bad.ok, 'content on a real element would replace its text');
  const good = compile(styleOp([rule([{ property: 'content', value: '"→"' }], { surface: 'after' })]));
  assert.ok(good.ok);
});

test('unknown targets produce target diagnostics, not guesses', () => {
  const result = compile(styleOp([{ ...rule([{ property: 'color', value: 'red' }]), target: { targetRef: 't999' } }]));
  assert.ok(!result.ok);
  if (!result.ok) assert.equal(result.diagnostics[0].code, 'target');
});

// ── keyframes: namespaced names, never important, reduced-motion gate ────

test('T07: motion with a reduced-motion counterpart compiles; namespaced names are used', () => {
  const result = compileStyleOperation({
    operation: {
      kind: 'style',
      rules: [
        rule([
          { property: 'animation-name', value: 'fade-in' },
          { property: 'animation-duration', value: '300ms' },
        ], { conditions: [] }),
        rule(
          [{ property: 'animation', value: 'none' }],
          { conditions: [{ type: 'prefers-reduced-motion', reduce: true }] },
        ),
      ],
      keyframes: [{
        name: 'fade-in',
        frames: [
          { at: 'from', declarations: [{ property: 'opacity', value: '0' }] },
          { at: 'to', declarations: [{ property: 'opacity', value: '1' }] },
        ],
      }],
    },
    namespace: 'rv2.inst.cust.rev.g.doc',
    resolveToken,
  });
  assert.ok(result.ok, `motion with counterpart must compile: ${JSON.stringify(result)}`);
  if (result.ok) {
    assert.match(result.sheet.css, /@keyframes rv2-rv2-inst-cust-rev-g-doc-fade-in/);
    assert.match(result.sheet.css, /animation-name: rv2-rv2-inst-cust-rev-g-doc-fade-in/);
    assert.equal(result.sheet.css.includes('animation-name: fade-in'), false, 'the bare model name never reaches the sheet');
    assert.match(result.sheet.css, /@media \(prefers-reduced-motion: reduce\)/);
  }
});

test('plan/08: motion without a reduced-motion counterpart is rejected', () => {
  const result = compile(styleOp([
    rule([{ property: 'animation-name', value: 'fade-in' }]),
  ], [{ name: 'fade-in', frames: [{ at: 'from', declarations: [{ property: 'opacity', value: '0' }] }, { at: 'to', declarations: [{ property: 'opacity', value: '1' }] }] }]));
  assert.ok(!result.ok);
  if (!result.ok) assert.match(result.diagnostics[0].message, /prefers-reduced-motion counterpart/);
});

test('plan/08: keyframe declarations are never important; offsets are from/to/percent', () => {
  const important = compile(styleOp([rule([{ property: 'color', value: 'red' }])], [{
    name: 'f',
    frames: [{ at: 'from', declarations: [{ property: 'opacity', value: '0', priority: 'important' }] }],
  }]));
  assert.ok(!important.ok);
  if (!important.ok) assert.match(important.diagnostics[0].message, /never important/);
  const badAt = compile(styleOp([rule([{ property: 'color', value: 'red' }])], [{
    name: 'f',
    frames: [{ at: '50vp', declarations: [{ property: 'opacity', value: '0' }] }],
  }]));
  assert.ok(!badAt.ok);
  if (!badAt.ok) assert.match(badAt.diagnostics[0].message, /from, to or a percentage/);
});

// ── conditions ───────────────────────────────────────────────────────────

test('T07: viewport/color-scheme conditions compile into nested media queries', () => {
  const result = compile(styleOp([
    rule([{ property: 'color', value: 'red' }], {
      conditions: [
        { type: 'viewport', minInlineSize: 480 },
        { type: 'prefers-color-scheme', scheme: 'dark' },
      ],
    }),
  ]));
  assert.ok(result.ok);
  if (result.ok) {
    // plan/08: conditions compile as documented NESTED conditions, preserving
    // per-rule structure (not a flattened 'and' join).
    assert.match(result.sheet.css, /@media \(min-width: 480px\) \{ @media \(prefers-color-scheme: dark\) \{ :where/);
  }
});

test('T07: a supports condition validates its declaration pair through the same policy', () => {
  const ok = compile(styleOp([rule([{ property: 'color', value: 'red' }], { conditions: [{ type: 'supports', property: 'display', value: 'grid' }] })]));
  assert.ok(ok.ok, 'a supported pair compiles');
  const bad = compile(styleOp([rule([{ property: 'color', value: 'red' }], { conditions: [{ type: 'supports', property: 'background', value: 'url(https://x.test)' }] })]));
  assert.ok(!bad.ok, 'an unsafe supported pair is rejected');
});

// ── bounds ───────────────────────────────────────────────────────────────

test('I21: the sheet ceiling and rule bounds are enforced', () => {
  const many = compile(styleOp(
    Array.from({ length: 300 }, () => rule([{ property: 'color', value: 'red' }])),
  ));
  assert.ok(!many.ok, 'more than maxStyleRules rules are refused');
  const giant = compile(styleOp([rule([{ property: 'box-shadow', value: '0 0 0 ' + '1px '.repeat(3000) }])]));
  assert.ok(!giant.ok || (giant.ok && giant.sheet.bytes <= 262_144), 'giant sheets are bounded');
});

// ── insertUI creation plan (T31/T30 compile half) ────────────────────────

const insertOp = (nodes: InsertUiOperation['nodes'], target: InsertUiOperation['target'] = { targetRef: 't1' }): InsertUiOperation => ({
  kind: 'insertUI',
  target,
  position: 'last-child',
  nodes,
});

test('T31: a safe owned tree compiles to a creation plan; buttons are forced type=button', () => {
  const result = compileInsertUi(insertOp([{
    localId: 'panel',
    tag: 'div',
    attributes: { 'aria-label': 'Saved cards' },
    children: [
      { tag: 'button', text: 'Toggle', localId: 'toggle' },
      { tag: 'label', text: 'Filter', attributes: {} as never, labelFor: 'filter-input' } as never,
      { tag: 'input', attributes: { type: 'search', placeholder: 'Filter cards' }, localId: 'filter-input' },
    ],
  }]));
  assert.ok(result.ok, `safe tree must compile: ${JSON.stringify(result)}`);
  if (result.ok) {
    const button = result.plan.trees[0].children![0];
    assert.equal(button.attrs?.type, 'button', 'buttons are always type=button');
    const label = result.plan.trees[0].children![1];
    assert.deepEqual(label.refTargets, [{ attr: 'for', localId: 'filter-input' }], 'local a11y refs are recorded for S4.2 rewriting');
  }
});

test('T31: unsafe nodes/attributes are refused — no script sink, no events, no external targets', () => {
  const cases: Array<{ node: InsertUiOperation['nodes'][number]; match: RegExp }> = [
    { node: { tag: 'script', text: 'alert(1)' }, match: /supported insert set/ },
    { node: { tag: 'div', attributes: { onclick: 'alert(1)' } }, match: /inline event/ },
    { node: { tag: 'img', attributes: { src: 'https://evil.test/x.png' } }, match: /supported insert set/ },
    { node: { tag: 'a', attributes: { href: 'https://evil.test' } }, match: /not allowed on owned nodes/ },
    { node: { tag: 'iframe', attributes: { srcdoc: '<b>x</b>' } }, match: /supported insert set/ },
    { node: { tag: 'input', attributes: { type: 'password' } }, match: /never password\/file\/submit/ },
    { node: { tag: 'input', attributes: { type: 'file' } }, match: /never password\/file\/submit/ },
    { node: { tag: 'div', attributes: { style: 'background:url(https://x.test)' } }, match: /not allowed on owned nodes/ },
  ];
  for (const { node, match } of cases) {
    const result = compileInsertUi(insertOp([node]));
    assert.ok(!result.ok, `unsafe insert node must be refused: ${JSON.stringify(node)}`);
    if (!result.ok) assert.match(result.diagnostics[0].message, match);
  }
});

test('T31: structural nesting is validated — the browser never repairs silently', () => {
  const badList = compileInsertUi(insertOp([{ tag: 'ul', children: [{ tag: 'div', text: 'not an li' }] }]));
  assert.ok(!badList.ok);
  if (!badList.ok) assert.match(badList.diagnostics[0].message, /children must be li/);
  const badDetails = compileInsertUi(insertOp([{ tag: 'details', children: [{ tag: 'div', text: 'no summary first' }] }]));
  assert.ok(!badDetails.ok);
  if (!badDetails.ok) assert.match(badDetails.diagnostics[0].message, /summary/);
  const badRow = compileInsertUi(insertOp([{ tag: 'tr', children: [{ tag: 'div' }] }]));
  assert.ok(!badRow.ok);
  if (!badRow.ok) assert.match(badRow.diagnostics[0].message, /th\/td/);
});

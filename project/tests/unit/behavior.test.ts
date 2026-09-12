/**
 * Unit suite for runtime/behavior (S7.1, plan/09 §1/§2): the chord grammar,
 * the reserved/plain-typing policy, per-target action validation, the pure
 * event-time eligibility decision, and the registry's exact-listener
 * ownership semantics. The full trusted-key path (CDP input) lives in the
 * browser suite; here the decision logic runs against descriptor stubs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BIND_ACTIONS, CONSEQUENTIAL_BIND_ACTIONS, MAX_BINDINGS_PER_DOCUMENT,
  createBehavior, decideBinding, eventChord, executeBindAction, isBindActionId,
  parseChord, plainTypingChord, reservedChord, validateBindAction,
  type BindingSpec, type KeyEventDescriptor,
} from '../../src/runtime/behavior.ts';

// ── chord grammar ─────────────────────────────────────────────────────────

test('chord grammar: modifiers normalize case-insensitively; keys take ev.key forms', () => {
  const expect = (input: string, normalized: string): void => {
    const r = parseChord(input);
    assert.ok(r.ok, `${input} parses`);
    assert.equal(r.chord.normalized, normalized, input);
  };
  expect('Alt+G', 'alt+g');
  expect('ctrl+shift+p', 'ctrl+shift+p');
  expect('Mod+Shift+P', 'shift+meta+p');
  expect('Ctrl+Alt+Delete', 'ctrl+alt+Delete');
  expect('F5', 'F5');
  expect('Escape', 'Escape');
  expect('Ctrl+Space', 'ctrl+ ');
  expect('meta+arrowdown', 'meta+ArrowDown');
  // Modifier order in the input does not matter; the output is canonical.
  expect('shift+ctrl+a', 'ctrl+shift+a');
});

test('chord grammar: unbindable chords refuse with actionable reasons', () => {
  for (const bad of ['', '+', 'Ctrl', 'Ctrl++', 'Ctrl+Hello', 'F13', 'F0', 'alt+enter+x', 'ß', 'Ctrl+ß']) {
    const r = parseChord(bad);
    assert.equal(r.ok, false, `"${bad}" must refuse`);
  }
  const mod = parseChord('Nope+G');
  assert.ok(!mod.ok && /not a recognized modifier/.test(mod.reason));
  const key = parseChord('Ctrl+Käse');
  assert.ok(!key.ok && /not a bindable key/.test(key.reason));
});

test('chord grammar: a live keyboard event normalizes to the same registry form', () => {
  const ev = eventChord({ key: 'G', ctrlKey: true, altKey: true, shiftKey: true, metaKey: false });
  assert.ok(ev && ev.normalized === 'ctrl+alt+shift+g');
  const space = eventChord({ key: ' ', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false });
  assert.ok(space && space.normalized === ' ');
  const unbindable = eventChord({ key: 'Dead', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false });
  assert.equal(unbindable, null, 'dead keys are not bindable');
});

// ── reserved + plain-typing policy ────────────────────────────────────────

test('browser-reserved chords are identified under Ctrl and Meta alike (plan/09 §2)', () => {
  const reserved = ['Ctrl+T', 'Ctrl+W', 'Ctrl+N', 'Ctrl+Shift+N', 'Ctrl+Shift+T', 'Ctrl+Q', 'Ctrl+Shift+Q',
    'Cmd+W', 'Meta+N', 'Ctrl+Tab', 'Ctrl+PageUp', 'Ctrl+PageDown', 'Alt+F4'];
  for (const chord of reserved) {
    const r = parseChord(chord);
    assert.ok(r.ok);
    assert.equal(reservedChord(r.chord), true, `${chord} is reserved`);
  }
  const usable = ['Alt+G', 'Ctrl+B', 'Ctrl+Shift+P', 'F5', 'Escape', 'Alt+F2', 'Meta+K', 'Alt+Home'];
  for (const chord of usable) {
    const r = parseChord(chord);
    assert.ok(r.ok);
    assert.equal(reservedChord(r.chord), false, `${chord} is bindable`);
  }
});

test('plain typing keys (no Ctrl/Alt/Meta, single character) conflict with editable surfaces', () => {
  for (const chord of ['a', 'G', '5', 'Space']) {
    const r = parseChord(chord);
    assert.ok(r.ok);
    assert.equal(plainTypingChord(r.chord), true, `${chord} is plain typing`);
  }
  for (const chord of ['Alt+A', 'Ctrl+G', 'F5', 'Enter', 'ArrowDown', 'Meta+K', 'shift+insert']) {
    const r = parseChord(chord);
    assert.ok(r.ok);
    assert.equal(plainTypingChord(r.chord), false, `${chord} is not plain typing`);
  }
});

// ── action catalog ────────────────────────────────────────────────────────

test('the action catalog is finite and the consequential set is exactly activation', () => {
  assert.deepEqual([...BIND_ACTIONS], ['focus', 'scrollIntoView', 'activate', 'followLink', 'toggleDisclosure']);
  assert.equal(isBindActionId('activate'), true);
  assert.equal(isBindActionId('selfDestruct'), false);
  assert.equal(isBindActionId('a1'), false, 'observed action ids are evidence, not catalog entries');
  assert.deepEqual([...CONSEQUENTIAL_BIND_ACTIONS], ['activate', 'followLink', 'toggleDisclosure']);
  assert.equal(MAX_BINDINGS_PER_DOCUMENT, 20, 'plan/09 §2');
});

const htmlEl = (tag: string, extra: Record<string, unknown> = {}): Element =>
  ({
    tagName: tag.toUpperCase(), getAttribute: () => null, focus() {}, click() {}, scrollIntoView() {},
    contains(other: Element | null): boolean {
      let n: Element | null = other;
      while (n) {
        if (n === (this as unknown as Element)) return true;
        n = (n as unknown as { parentElement?: Element | null }).parentElement ?? null;
      }
      return false;
    },
    ...(extra as object),
  }) as unknown as Element;
/** An element WITHOUT the native activation methods (non-HTML node). */
const bareEl = (tag: string, extra: Record<string, unknown> = {}): Element =>
  ({ tagName: tag.toUpperCase(), getAttribute: () => null, ...(extra as object) }) as unknown as Element;
const stubEl = htmlEl;

test('action validation: focus requires a focusable target', () => {
  assert.ok(validateBindAction('focus', stubEl('button')).ok);
  assert.ok(validateBindAction('focus', stubEl('a')).ok);
  assert.ok(validateBindAction('focus', stubEl('input')).ok);
  assert.ok(validateBindAction('focus', stubEl('summary')).ok);
  assert.ok(validateBindAction('focus', stubEl('div', { getAttribute: (n: string) => n === 'tabindex' ? '0' : null })).ok);
  assert.equal(validateBindAction('focus', bareEl('div')).ok, false, 'a plain div is not keyboard-focusable');
  assert.equal(validateBindAction('focus', bareEl('svg')).ok, false, 'non-HTML elements cannot focus');
});

test('action validation: followLink only follows real http(s) site links', () => {
  const link = (href: string): Element => stubEl('a', { getAttribute: (n: string) => n === 'href' ? href : null });
  assert.ok(validateBindAction('followLink', link('https://example.com/x')).ok);
  assert.ok(validateBindAction('followLink', link('/relative/page')).ok);
  for (const href of ['javascript:alert(1)', 'data:text/html,x', ''] as const) {
    const r = validateBindAction('followLink', link(href));
    assert.equal(r.ok, false, `${href} is not followable`);
  }
  assert.equal(validateBindAction('followLink', stubEl('button')).ok, false);
});

test('action validation: toggleDisclosure needs a native disclosure; activate/scroll need HTML', () => {
  const summary = stubEl('summary', { parentElement: stubEl('details') });
  assert.ok(validateBindAction('toggleDisclosure', summary).ok);
  assert.ok(validateBindAction('toggleDisclosure', stubEl('details')).ok);
  assert.equal(validateBindAction('toggleDisclosure', stubEl('div')).ok, false);
  assert.equal(validateBindAction('toggleDisclosure', stubEl('summary', { parentElement: stubEl('section') })).ok, false);
  assert.ok(validateBindAction('activate', stubEl('button')).ok);
  assert.ok(validateBindAction('scrollIntoView', stubEl('div')).ok);
});

// ── event-time eligibility (pure decision) ────────────────────────────────

const target = { tagName: 'BUTTON', getAttribute: () => null, getClientRects: () => [{}], isConnected: true } as unknown as Element;
const baseSpec = (over: Partial<BindingSpec> = {}): BindingSpec => ({
  customizationId: 'c1', key: 'g', ctrl: false, alt: true, shift: false, meta: false, normalized: 'alt+g',
  target, actions: ['activate'], scope: 'document', repeat: false, editablePolicy: 'ignore', modalPolicy: 'ignore',
  ...over,
});
const altG = (over: Partial<KeyEventDescriptor> = {}): KeyEventDescriptor => ({
  key: 'g', ctrlKey: false, altKey: true, shiftKey: false, metaKey: false, repeat: false, isComposing: false, path: [],
  ...over,
});

test('T15: an eligible trusted-style event fires; the disqualifiers each skip without consuming', () => {
  assert.equal(decideBinding(baseSpec(), altG(), null), true);
  assert.equal(decideBinding(baseSpec(), altG({ repeat: true }), null), false, 'unwanted repeat');
  assert.equal(decideBinding(baseSpec(), altG({ isComposing: true }), null), false, 'IME composition');
  assert.equal(decideBinding(baseSpec(), altG({ key: 'h' }), null), false, 'a different chord never matches');
  assert.equal(decideBinding(baseSpec({ repeat: true }), altG({ repeat: true }), null), true, 'an approved repeat policy fires');
  const hidden = { ...target, getClientRects: () => [] } as unknown as Element;
  assert.equal(decideBinding(baseSpec({ target: hidden }), altG(), null), false, 'invisible target');
  const gone = { ...target, isConnected: false } as unknown as Element;
  assert.equal(decideBinding(baseSpec({ target: gone }), altG(), null), false, 'disconnected target');
  const disabled = { ...target, disabled: true } as unknown as Element;
  assert.equal(decideBinding(baseSpec({ target: disabled }), altG(), null), false, 'disabled control is not activated');
  // Non-consequential actions on a disabled control are fine (focus is honest).
  assert.equal(decideBinding(baseSpec({ target: disabled, actions: ['scrollIntoView'] }), altG(), null), true);
});

test('T15: password editing is never intercepted — editablePolicy allow or not', () => {
  const password = { tagName: 'INPUT', getAttribute: (n: string) => n === 'type' ? 'password' : null, isContentEditable: false } as unknown as Element;
  const editor = { tagName: 'TEXTAREA', getAttribute: () => null, isContentEditable: false } as unknown as Element;
  assert.equal(decideBinding(baseSpec(), altG({ path: [password] }), null), false, 'password always skips');
  assert.equal(decideBinding(baseSpec({ editablePolicy: 'allow' }), altG({ path: [password] }), null), false, 'allow does not override password');
  assert.equal(decideBinding(baseSpec(), altG({ path: [editor] }), null), false, 'editor skips by default');
  assert.equal(decideBinding(baseSpec({ editablePolicy: 'allow' }), altG({ path: [editor] }), null), true, 'approved narrow opt-in fires in editors');
  const contentEditable = { tagName: 'DIV', getAttribute: () => null, isContentEditable: true } as unknown as Element;
  assert.equal(decideBinding(baseSpec(), altG({ path: [contentEditable] }), null), false, 'contenteditable counts as editing');
});

test('T15: modal focus keeps its keys unless the binding opted in', () => {
  const inDialog = { closest: () => ({}) } as unknown as Element;
  assert.equal(decideBinding(baseSpec(), altG(), inDialog), false, 'default modal policy skips');
  assert.equal(decideBinding(baseSpec({ modalPolicy: 'allow' }), altG(), inDialog), true, 'approved modal opt-in fires');
  assert.equal(decideBinding(baseSpec(), altG(), null), true, 'no active element is not modal');
});

test('T15: target scope fires only from inside the bound target', () => {
  const inside = { tagName: 'SECTION', getAttribute: () => null } as unknown as Element;
  assert.equal(decideBinding(baseSpec({ scope: 'target' }), altG({ path: [inside, target] }), null), true);
  assert.equal(decideBinding(baseSpec({ scope: 'target' }), altG({ path: [inside] }), null), false);
  assert.equal(decideBinding(baseSpec({ scope: 'document' }), altG({ path: [inside] }), null), true);
});

// ── execution ─────────────────────────────────────────────────────────────

test('execution is native and synchronous: focus/scroll/click and the details toggle', () => {
  const calls: string[] = [];
  let open = false;
  const el = {
    tagName: 'BUTTON',
    getAttribute: () => null,
    hasAttribute: (n: string) => n === 'open' && open,
    setAttribute: () => { open = true; calls.push('set-open'); },
    removeAttribute: () => { open = false; calls.push('rm-open'); },
    focus: () => { calls.push('focus'); }, click: () => { calls.push('click'); }, scrollIntoView: () => { calls.push('scroll'); },
  } as unknown as Element;
  executeBindAction('focus', el);
  executeBindAction('scrollIntoView', el);
  executeBindAction('activate', el);
  executeBindAction('followLink', el);
  assert.deepEqual(calls, ['focus', 'scroll', 'click', 'click']);
  // A <details> flips its open attribute natively (no synthetic click).
  const details = { ...el, tagName: 'DETAILS' } as unknown as Element;
  executeBindAction('toggleDisclosure', details);
  executeBindAction('toggleDisclosure', details);
  assert.deepEqual(calls, ['focus', 'scroll', 'click', 'click', 'set-open', 'rm-open']);
});

// ── registry: exact listener ownership (AC-11) ────────────────────────────

test('the behavior core installs/disposes entries exactly; a stale predecessor handle removes nothing', () => {
  const listeners: Array<[string, unknown]> = [];
  const doc = {
    addEventListener: (type: string, fn: unknown) => { listeners.push([type, fn]); },
    removeEventListener: (type: string, fn: unknown) => {
      const i = listeners.findIndex(([t, f]) => t === type && f === fn);
      if (i !== -1) listeners.splice(i, 1);
    },
    activeElement: null,
  } as unknown as Document;
  const behavior = createBehavior({ doc });

  assert.equal(listeners.filter(([t]) => t === 'keydown').length, 1, 'exactly one document keydown listener');
  const first = behavior.install(baseSpec());
  assert.ok(behavior.isBound('alt+g'));
  assert.deepEqual([...behavior.boundChords()], [['alt+g', 'c1']]);

  // Same-chord successor (replacement revision): the stale handle no-ops.
  const second = behavior.install(baseSpec({ actions: ['focus'] }));
  assert.equal(listeners.filter(([t]) => t === 'keydown').length, 1, 'installing never adds listeners');
  first.dispose();
  assert.ok(behavior.isBound('alt+g'), 'the stale predecessor handle removed nothing');
  second.dispose();
  assert.equal(behavior.isBound('alt+g'), false, 'the owning handle removes the entry');

  behavior.dispose();
  assert.equal(listeners.length, 0, 'dispose removes the exact listener');
});

// ── S7.2: finite local behavior rules ─────────────────────────────────────

import { COLLAPSED_ATTRIBUTE, disclosureState, evaluateRule, wireCollapseToggle, type RuleSpec } from '../../src/runtime/behavior.ts';

const toggle = (expanded: string | null): Element => stubEl('button', { getAttribute: (n: string) => n === 'aria-expanded' ? expanded : null });
const detailsEl = (open: boolean): Element => stubEl('details', { hasAttribute: (n: string) => n === 'open' && open });

const ruleSpec = (over: Partial<RuleSpec> = {}): RuleSpec => ({
  customizationId: 'r1', actionId: 'activateDisclosure', predicates: [], affordance: null, ...over,
});
const t0 = 1_000_000;

test('T16: disclosureState reads aria-expanded and native details/summary state', () => {
  assert.equal(disclosureState(toggle('true')), true);
  assert.equal(disclosureState(toggle('false')), false);
  assert.equal(disclosureState(toggle(null)), null, 'no observable state');
  assert.equal(disclosureState(detailsEl(true)), true);
  assert.equal(disclosureState(detailsEl(false)), false);
  const summary = stubEl('summary', { parentElement: detailsEl(true) });
  assert.equal(disclosureState(summary), true);
});

test('T16: a rule fires ONCE per instance — a user expansion afterwards is never re-collapsed', () => {
  const instance = stubEl('article', { textContent: 'A comment' });
  const aff = toggle('true');
  const clicks: string[] = [];
  const clickAff = { ...aff, click: () => { clicks.push('x'); } } as unknown as Element;
  const rule = ruleSpec({ affordance: clickAff });
  assert.equal(evaluateRule(rule, instance, clickAff, t0), true);
  assert.equal(clicks.length, 1);
  assert.equal(evaluateRule(rule, instance, clickAff, t0 + 10_000), false, 'once per instance, sticky');
  assert.equal(clicks.length, 1, 'the user-expanded instance is never re-acted on');
});

test('T16: the runtime-controlled cooldown bounds re-fires within 500ms (different instances unaffected)', () => {
  const a = stubEl('article');
  const b = stubEl('article');
  const aff = { ...toggle('true'), click: () => {} } as unknown as Element;
  const rule = ruleSpec({ affordance: aff });
  assert.equal(evaluateRule(rule, a, aff, t0), true);
  assert.equal(evaluateRule(rule, a, aff, t0 + 100), false, 'inside the cooldown');
  assert.equal(evaluateRule(rule, a, aff, t0 + 600), false, 'cooldown passed but once-per-instance holds');
  assert.equal(evaluateRule(rule, b, aff, t0 + 100), true, 'another instance is independent');
});

test('T16: predicates are a conjunction — member-of, expanded-equals, text-contains', () => {
  const container = stubEl('section');
  const inside = stubEl('article', { textContent: 'spam comment', parentElement: container });
  const outside = stubEl('article', { textContent: 'spam comment' });
  const aff = { ...toggle('true'), click: () => {} } as unknown as Element;
  const rule = ruleSpec({
    predicates: [
      { type: 'member-of', element: container },
      { type: 'expanded-equals', value: true },
      { type: 'text-contains', literal: 'spam' },
    ],
    affordance: aff,
  });
  assert.equal(evaluateRule(rule, inside, aff, t0), true, 'all predicates hold');
  assert.equal(evaluateRule(rule, outside, aff, t0), false, 'member-of fails');
  const collapsedAff = { ...toggle('false'), click: () => {} } as unknown as Element;
  assert.equal(evaluateRule(rule, inside, collapsedAff, t0 + 1000), false, 'expanded-equals fails (already collapsed)');
  const noState = stubEl('button', { getAttribute: () => null });
  assert.equal(evaluateRule(rule, inside, noState, t0 + 1000), false, 'no observable state never matches');
});

test('T16: a throwing site handler consumes the one attempt without throwing', () => {
  const instance = stubEl('article');
  const aff = { ...toggle('true'), click: () => { throw new Error('site handler broke'); } } as unknown as Element;
  assert.doesNotThrow(() => evaluateRule(ruleSpec({ affordance: aff }), instance, aff, t0));
  assert.equal(evaluateRule(ruleSpec({ affordance: aff }), instance, aff, t0 + 10_000), false, 'never re-fires');
});

// ── S7.2: owned collapse toggle wiring ────────────────────────────────────

test('the owned toggle flips aria-expanded and the collapsed-state attribute exactly', () => {
  const listeners: Array<[string, () => void]> = [];
  const toggleEl = {
    tagName: 'BUTTON', getAttribute: (n: string) => n === 'aria-expanded' ? 'true' : null,
    setAttribute: () => {}, removeAttribute: () => {},
    addEventListener: (t: string, fn: () => void) => { listeners.push([t, fn]); },
    removeEventListener: (t: string, fn: () => void) => {
      const i = listeners.findIndex(([tt, f]) => tt === t && f === fn);
      if (i !== -1) listeners.splice(i, 1);
    },
  } as unknown as HTMLElement;
  const targetAttrs = new Map<string, string>();
  const target = {
    tagName: 'ARTICLE',
    getAttribute: (n: string) => targetAttrs.get(n) ?? null,
    setAttribute: (n: string, v: string) => { targetAttrs.set(n, v); },
    removeAttribute: (n: string) => { targetAttrs.delete(n); },
  } as unknown as Element;

  const wiring = wireCollapseToggle(toggleEl, target);
  assert.equal(listeners.length, 1);
  listeners[0][1](); // click → collapse
  assert.equal(targetAttrs.get(COLLAPSED_ATTRIBUTE), '1');
  wiring.dispose();
  assert.equal(listeners.length, 0, 'exact listener uninstall');
});

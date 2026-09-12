/**
 * runtime/behavior — finite local interaction rules (S7.1, plan/03
 * `runtime/behavior`, plan/09 §1/§2).
 *
 * One per-document executor for APPROVED keyboard bindings. Inputs are the
 * finite action catalog and the approved bindKey operation; there are no
 * model calls, no remote endpoints and no arbitrary expression evaluation.
 *
 * Contract highlights (plan/09 §2):
 * - Only a TRUSTED key event can fire a binding; composition (isComposing)
 *   and dead keys are ignored, unwanted repeats are skipped.
 * - Password editing is NEVER intercepted, regardless of policy. Other
 *   editable surfaces are skipped by default (editablePolicy 'allow' is a
 *   narrow, user-approved opt-in).
 * - No key is consumed until an eligible action has been selected: the
 *   listener returns before preventDefault whenever anything is off.
 * - Generic activation is potentially consequential: it is approved through
 *   the workspace review and executed synchronously while the gesture is
 *   current. There are no synthetic retries, and the external effect (the
 *   site's own action) is explicitly NOT reversible by Revueon.
 * - The event path stays sync and tiny (plan/03: ≤4ms excluding website
 *   handler time): one map lookup, pure checks, native calls.
 *
 * Listener ownership (AC-11): the behavior core owns ONE document keydown
 * listener for the runtime session's lifetime; each binding is one registry
 * entry with an exact dispose(). Install/uninstall/replay can never
 * duplicate listeners because there is exactly one listener and the
 * registry is keyed by normalized chord — a chord cannot be bound twice
 * (the transaction refuses conflicts before any side effect).
 */

// ── finite action catalog (plan/09 §1) ───────────────────────────────────

export const BIND_ACTIONS = ['focus', 'scrollIntoView', 'activate', 'followLink', 'toggleDisclosure'] as const;
export type BindAction = (typeof BIND_ACTIONS)[number];

/** Actions that can trigger the site's own behavior (plan/09 §1: all generic
 *  activation is potentially consequential; the approval UI must say so). */
export const CONSEQUENTIAL_BIND_ACTIONS: ReadonlySet<BindAction> = new Set(['activate', 'followLink', 'toggleDisclosure']);

export function isBindActionId(id: string): id is BindAction {
  return (BIND_ACTIONS as readonly string[]).includes(id);
}

/** plan/09 §2: at most 20 bindings per document. */
export const MAX_BINDINGS_PER_DOCUMENT = 20;

// ── chord grammar (pure) ─────────────────────────────────────────────────

export interface ParsedChord {
  /** Normalized KeyboardEvent.key form ('g', 'F5', 'Enter', ' ' …). */
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  /** Canonical text form used as the registry key ('ctrl+alt+g'). */
  normalized: string;
}

export type ChordResult = { ok: true; chord: ParsedChord } | { ok: false; reason: string; suggestion?: string };

const MODIFIERS: Record<string, 'ctrl' | 'alt' | 'shift' | 'meta'> = {
  ctrl: 'ctrl', control: 'ctrl',
  alt: 'alt', option: 'alt',
  shift: 'shift',
  meta: 'meta', cmd: 'meta', command: 'meta', super: 'meta', win: 'meta', mod: 'meta',
};

const NAMED_KEYS: Record<string, string> = {
  space: ' ', enter: 'Enter', esc: 'Escape', escape: 'Escape', tab: 'Tab',
  backspace: 'Backspace', delete: 'Delete', del: 'Delete', insert: 'Insert',
  home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown',
  arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
};

const normalizeKey = (raw: string): string | null => {
  const token = raw.toLowerCase();
  if (/^[a-z]$/.test(token)) return token;
  if (/^[0-9]$/.test(token)) return token;
  if (/^f([1-9]|1[0-2])$/.test(token)) return `F${token.slice(1).toUpperCase()}`;
  if (NAMED_KEYS[token] !== undefined) return NAMED_KEYS[token];
  return null; // no arbitrary unicode/printables: the chord grammar is finite
};

/** Parse and normalize a chord string. Modifiers are case-insensitive
 *  ('Ctrl+Alt+g', 'mod+shift+P'); the key must be a letter, a digit, F1..F12
 *  or one of the named keys. */
export function parseChord(input: string): ChordResult {
  const tokens = input.split('+').map((t) => t.trim()).filter((t) => t.length > 0);
  if (tokens.length === 0) return { ok: false, reason: 'the chord is empty' };
  const mods = { ctrl: false, alt: false, shift: false, meta: false };
  for (const token of tokens.slice(0, -1)) {
    const mod = MODIFIERS[token.toLowerCase()];
    if (mod === undefined) return { ok: false, reason: `"${token}" is not a recognized modifier (Ctrl, Alt, Shift, Meta/Cmd/Mod)` };
    mods[mod] = true;
  }
  const key = normalizeKey(tokens[tokens.length - 1]);
  if (key === null) {
    return { ok: false, reason: `"${tokens[tokens.length - 1]}" is not a bindable key (single letter, digit, F1..F12, or a named key like Enter)`, suggestion: 'bind modifier chords like Alt+G or named keys like F5' };
  }
  return { ok: true, chord: chordOf(key, mods) };
}

const chordOf = (key: string, mods: { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }): ParsedChord => ({
  key,
  ctrl: mods.ctrl,
  alt: mods.alt,
  shift: mods.shift,
  meta: mods.meta,
  normalized: `${mods.ctrl ? 'ctrl+' : ''}${mods.alt ? 'alt+' : ''}${mods.shift ? 'shift+' : ''}${mods.meta ? 'meta+' : ''}${key}`,
});

/** Normalize a live keyboard event to the same registry form; null when the
 *  event's key is not a bindable chord key. */
export function eventChord(ev: { key: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }): ParsedChord | null {
  const key = normalizeKey(ev.key === ' ' ? 'space' : ev.key);
  if (key === null) return null;
  return chordOf(key, { ctrl: ev.ctrlKey, alt: ev.altKey, shift: ev.shiftKey, meta: ev.metaKey });
}

/** Browser-reserved combinations that a page cannot intercept (plan/09 §2:
 *  they may not be promised). Ctrl and Meta are treated alike — the same
 *  combos are reserved under Cmd on macOS. */
const RESERVED_KEYS = new Set(['t', 'w', 'n', 'q', 'Tab', 'PageUp', 'PageDown']);

export function reservedChord(chord: ParsedChord): boolean {
  const main = chord.ctrl || chord.meta;
  if (main && RESERVED_KEYS.has(chord.key)) {
    // Ctrl/Cmd+Shift+N, +Shift+T and +Shift+Q are the window/incognito
    // variants of the same reserved keys; plain +n/+t/+q already refuse.
    if (chord.key === 'n' || chord.key === 't' || chord.key === 'q') return true;
    if (!chord.shift && !chord.alt) return true;
  }
  if (chord.alt && chord.key === 'F4') return true; // OS-level close
  return false;
}

/** A chord with no Ctrl/Alt/Meta modifier and a single-character key is plain
 *  typing: it conflicts with every editable surface (plan/09 §2 — reject and
 *  offer a modifier alternative). Bare F1..F12 and named keys are allowed. */
export function plainTypingChord(chord: ParsedChord): boolean {
  if (chord.ctrl || chord.alt || chord.meta) return false;
  return chord.key.length === 1;
}

// ── per-target action validation (pure, duck-typed) ──────────────────────

const FOCUSABLE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary', 'iframe']);

export type ActionValidation = { ok: true } | { ok: false; detail: string };

/** Validate one catalog action against the concrete resolved element at
 *  prepare time — an unsupported pairing refuses the whole batch BEFORE any
 *  side effect, with the exact reason. */
export function validateBindAction(action: BindAction, el: Element, baseHref = 'https://example.invalid/'): ActionValidation {
  const tag = (el.tagName ?? '').toLowerCase();
  switch (action) {
    case 'focus': {
      if (typeof (el as HTMLElement).focus !== 'function') return { ok: false, detail: 'the target is not an HTML element with a native focus() method' };
      const tabindex = el.getAttribute('tabindex');
      if (FOCUSABLE_TAGS.has(tag) || (tabindex !== null && Number.parseInt(tabindex, 10) >= 0) || (el as HTMLElement).isContentEditable === true) return { ok: true };
      return { ok: false, detail: `a <${tag}> without tabindex is not keyboard-focusable` };
    }
    case 'scrollIntoView': {
      if (typeof (el as HTMLElement).scrollIntoView !== 'function') return { ok: false, detail: 'the target has no native scrollIntoView' };
      return { ok: true };
    }
    case 'activate': {
      if (typeof (el as HTMLElement).click !== 'function') return { ok: false, detail: 'the target is not an HTML element with a native click() method' };
      return { ok: true };
    }
    case 'followLink': {
      if (tag !== 'a') return { ok: false, detail: `followLink targets a link, but the target is a <${tag}>` };
      const href = el.getAttribute('href');
      if (href === null || href === '') return { ok: false, detail: 'the link has no href to follow' };
      let url: URL;
      try {
        url = new URL(href, baseHref);
      } catch {
        return { ok: false, detail: 'the link href does not resolve to a URL' };
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return { ok: false, detail: `the link href protocol "${url.protocol}" is not followable (only http/https site links are)` };
      }
      return { ok: true };
    }
    case 'toggleDisclosure': {
      if (tag === 'summary' && (el.parentElement?.tagName ?? '').toLowerCase() === 'details') return { ok: true };
      if (tag === 'details') return { ok: true };
      return { ok: false, detail: `toggleDisclosure targets a native disclosure (<summary> in <details>, or <details>), not a <${tag}>` };
    }
  }
}

// ── event-time eligibility (pure, exported for tests) ────────────────────

export interface BindingSpec {
  customizationId: string;
  /** Parsed chord parts + registry key. */
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  normalized: string;
  /** The exact resolved element the actions act on (site target or an owned
   *  node from the same batch). */
  target: Element;
  actions: BindAction[];
  scope: 'document' | 'target';
  repeat: boolean;
  editablePolicy: 'ignore' | 'allow';
  modalPolicy: 'ignore' | 'allow';
}

export interface KeyEventDescriptor {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  repeat: boolean;
  isComposing: boolean;
  /** Bounded composedPath() elements (the listener pre-filters). */
  path: Element[];
}

const isTag = (el: Element, tag: string): boolean => (el.tagName ?? '').toLowerCase() === tag;

const isPasswordInput = (el: Element): boolean =>
  isTag(el, 'input') && ((el.getAttribute('type') ?? 'text').toLowerCase() === 'password');

const isEditableSurface = (el: Element): boolean =>
  isTag(el, 'input') || isTag(el, 'textarea') || isTag(el, 'select') || (el as HTMLElement).isContentEditable === true;

/** Modal focus: an open native dialog or a dialog/menu region containing the
 *  active element (plan/09 §2). Best-effort cheap check, no observability. */
const inModalContext = (activeElement: Element | null): boolean => {
  if (!activeElement) return false;
  try {
    return activeElement.closest('dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"]') !== null;
  } catch {
    return false;
  }
};

const visibleEl = (el: Element): boolean => {
  try {
    return el.getClientRects().length > 0;
  } catch {
    return false;
  }
};

const controlDisabled = (el: Element): boolean =>
  (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true';

/** Eligibility decision — pure. Returns true ONLY when the binding fires
 *  (the listener then calls preventDefault and executes, in that order). */
export function decideBinding(spec: BindingSpec, ev: KeyEventDescriptor, activeElement: Element | null): boolean {
  if (ev.isComposing) return false; // IME composition is never intercepted
  const chord = eventChord(ev);
  if (chord === null || chord.normalized !== spec.normalized) return false;
  if (ev.repeat && !spec.repeat) return false;

  // Editable surfaces: password NEVER (no policy can opt in); others skip
  // under the default 'ignore' policy (plan/09 §2.2).
  for (const el of ev.path) {
    if (isPasswordInput(el)) return false;
    if (spec.editablePolicy === 'ignore' && isEditableSurface(el)) return false;
  }

  // Modal focus: dialogs and menus keep their keys by default.
  if (spec.modalPolicy === 'ignore' && inModalContext(activeElement)) return false;

  // Activation scope: 'target' fires only from inside the bound target.
  if (spec.scope === 'target' && !ev.path.includes(spec.target)) return false;

  // The action target must be live, visible and — for activation-class
  // actions on controls — enabled (plan/09 §2.3). No first-match activation.
  if (spec.target.isConnected === false || !visibleEl(spec.target)) return false;
  for (const action of spec.actions) {
    if (CONSEQUENTIAL_BIND_ACTIONS.has(action) && controlDisabled(spec.target)) return false;
  }
  return true;
}

/** Execute the approved action sequence synchronously, while the trusted
 *  gesture is current (plan/09 §2.5). Actions were validated at prepare
 *  time; each is a native call on the exact element. */
export function executeBindAction(action: BindAction, el: Element): void {
  switch (action) {
    case 'focus':
      (el as HTMLElement).focus();
      return;
    case 'scrollIntoView':
      (el as HTMLElement).scrollIntoView({ block: 'nearest', inline: 'nearest' });
      return;
    case 'activate':
    case 'followLink':
      (el as HTMLElement).click(); // native activation of the site's own control
      return;
    case 'toggleDisclosure':
      if ((el.tagName ?? '').toLowerCase() === 'details') {
        if (el.hasAttribute('open')) el.removeAttribute('open');
        else el.setAttribute('open', '');
      } else {
        (el as HTMLElement).click(); // <summary>: native disclosure toggle
      }
      return;
  }
}

// ── finite rule engine (S7.2, plan/09 §3, plan/08 §7) ──────────────────

/** Rule actions are FINITE: the automatic trigger (target-appeared) may only
 *  use local presentation actions — the approved native disclosure (with an
 *  observable expanded/open state) or focus. Generic consequential
 *  activation is NOT in the rule catalog (plan/08 §7 compatibility rule). */
export const RULE_ACTIONS = ['activateDisclosure', 'focus'] as const;
export type RuleAction = (typeof RULE_ACTIONS)[number];

export function isRuleActionId(id: string): id is RuleAction {
  return (RULE_ACTIONS as readonly string[]).includes(id);
}

/** plan/08 §7: runtime-controlled, not model-disableable. */
export const RULE_COOLDOWN_MS = 500;

/** The observable expanded/open state of a disclosure affordance; null when
 *  the element exposes none (the predicate could never hold). */
export function disclosureState(el: Element): boolean | null {
  const aria = el.getAttribute('aria-expanded');
  if (aria === 'true') return true;
  if (aria === 'false') return false;
  const tag = (el.tagName ?? '').toLowerCase();
  if (tag === 'details') return el.hasAttribute('open');
  if (tag === 'summary') {
    const parent = el.parentElement;
    if (parent && (parent.tagName ?? '').toLowerCase() === 'details') return parent.hasAttribute('open');
  }
  return null;
}

/** Resolved predicates (refs resolved to exact elements at prepare). */
export type RulePredicate =
  | { type: 'member-of'; element: Element }
  | { type: 'expanded-equals'; value: boolean }
  | { type: 'text-contains'; literal: string };

export interface RuleSpec {
  /** The once-per-instance key — sticky for the session so a re-apply or
   *  re-enable never re-acts on an instance (user overrides win). Replay
   *  expands one saved rule into per-member copies that SHARE this key:
   *  one action per instance per rule, regardless of re-applies. */
  customizationId: string;
  actionId: RuleAction;
  predicates: RulePredicate[];
  /** Seed affordance for the live batch (the observed disclosure of the
   *  seed instance). Replay-expanded rules carry one per member. */
  affordance: Element | null;
}

export interface RuleHandle {
  dispose(): void;
}

/** One attempt per instance per rule, sticky for the SESSION (plan/09 §3:
 *  "one attempt per instance"; AC-11: user later expansion is retained).
 *  Survives disable/re-enable — a re-enabled rule never re-acts on an
 *  instance it (or the user) already handled. Cleared only when the runtime
 *  disposes. */
const ruleOnce = new WeakMap<Element, Set<string>>();
/** Cooldown per (instance, rule): plan/08 §7 runtime-controlled 500ms. */
const ruleLastRun = new WeakMap<Element, Map<string, number>>();

/** Evaluate one rule against one instance; returns true ONLY when the action
 *  ran. Pure control flow; the action itself is a native call. */
export function evaluateRule(rule: RuleSpec, instance: Element, affordance: Element | null, now: number): boolean {
  let once = ruleOnce.get(instance);
  if (once === undefined) {
    once = new Set();
    ruleOnce.set(instance, once);
  }
  if (once.has(rule.customizationId)) return false;
  const last = ruleLastRun.get(instance)?.get(rule.customizationId);
  if (last !== undefined && now - last < RULE_COOLDOWN_MS) return false;

  for (const predicate of rule.predicates) {
    switch (predicate.type) {
      case 'member-of':
        if (!predicate.element.contains(instance)) return false;
        break;
      case 'expanded-equals': {
        const state = disclosureState(affordance ?? instance);
        if (state !== predicate.value) return false;
        break;
      }
      case 'text-contains':
        if (!(instance.textContent ?? '').includes(predicate.literal)) return false;
        break;
    }
  }

  // Mark the attempt BEFORE acting: a failed site handler counts as the one
  // attempt (plan/09 §3 — no spam-clicking until it happens).
  once.add(rule.customizationId);
  let times = ruleLastRun.get(instance);
  if (times === undefined) {
    times = new Map();
    ruleLastRun.set(instance, times);
  }
  times.set(rule.customizationId, now);

  if (rule.actionId === 'activateDisclosure') {
    try {
      (affordance as HTMLElement | null)?.click?.(); // the site's own disclosure toggle
    } catch {
      /* a throwing site handler consumed the attempt; never re-fires */
    }
    return true;
  }
  try {
    (instance as HTMLElement).focus?.();
  } catch {
    /* ignore */
  }
  return true;
}

// ── owned collapse wiring (S7.2, plan/08 §1/§7 collapse row) ─────────────

export interface CollapseWiring {
  /** Exact uninstall of the toggle's click listener. */
  dispose(): void;
}

/** The owned collapsed-state attribute on the TARGET (never a site
 *  attribute; baseline recorded and restored by the transaction). */
export const COLLAPSED_ATTRIBUTE = 'data-rv2-collapsed';

/** Wire the owned disclosure toggle: clicking flips aria-expanded on the
 *  toggle and the collapsed-state attribute on the target. Runtime-owned
 *  listener on an OWNED node — no model-supplied handler source. */
export function wireCollapseToggle(toggle: HTMLElement, target: Element): CollapseWiring {
  const onClick = (): void => {
    const expanded = toggle.getAttribute('aria-expanded') !== 'false';
    if (expanded) {
      toggle.setAttribute('aria-expanded', 'false');
      target.setAttribute(COLLAPSED_ATTRIBUTE, '1');
    } else {
      toggle.setAttribute('aria-expanded', 'true');
      target.removeAttribute(COLLAPSED_ATTRIBUTE);
    }
  };
  toggle.addEventListener('click', onClick);
  return {
    dispose() {
      toggle.removeEventListener('click', onClick);
    },
  };
}

/** The owned minimized-state attribute on the floated TARGET (S8.2; the
 *  baseline is recorded and restored by the transaction like collapse). */
export const FLOAT_MIN_ATTRIBUTE = 'data-rv2-float-min';
export const FLOAT_BTN_ATTRIBUTE = 'data-rv2-float-btn';

/** Wire the owned float minimize/restore button: clicking toggles the
 *  minimized-state attribute on the floated target and the button's own
 *  label/pressed state. Runtime-owned listener on an OWNED node. */
export function wireFloatButton(button: HTMLElement, target: Element): CollapseWiring {
  const onClick = (): void => {
    const minimized = target.getAttribute(FLOAT_MIN_ATTRIBUTE) === '1';
    if (minimized) {
      target.removeAttribute(FLOAT_MIN_ATTRIBUTE);
      button.setAttribute('aria-expanded', 'true');
      button.setAttribute('aria-label', 'Minimize floated surface');
    } else {
      target.setAttribute(FLOAT_MIN_ATTRIBUTE, '1');
      button.setAttribute('aria-expanded', 'false');
      button.setAttribute('aria-label', 'Restore floated surface');
    }
  };
  button.addEventListener('click', onClick);
  return {
    dispose() {
      button.removeEventListener('click', onClick);
    },
  };
}

// ── per-document behavior core ────────────────────────────────────────────

export interface BehaviorDeps {
  doc: Document;
}

export interface BindingHandle {
  /** Exact uninstall: removes THIS binding's registry entry — a stale handle
   *  (predecessor replaced by a successor) removes nothing. */
  dispose(): void;
}

export interface BehaviorCore {
  install(spec: BindingSpec): BindingHandle;
  /** normalized chord → owning customizationId (conflict preview + cap). */
  boundChords(): Map<string, string>;
  /** Measured postcondition for verification: this chord is live. */
  isBound(normalized: string): boolean;
  /** S7.2: install one local rule; the seed instance is evaluated by the
   *  caller (the transaction's write section). */
  installRule(spec: RuleSpec): RuleHandle;
  /** Measured postcondition for verification: this rule is live. */
  hasRule(customizationId: string): boolean;
  dispose(): void;
}

export function createBehavior(deps: BehaviorDeps): BehaviorCore {
  const registry = new Map<string, BindingSpec>();
  const rules = new Map<string, { customizationId: string; handle: RuleHandle }>();
  let ruleSeq = 0;
  const listener = (ev: KeyboardEvent): void => {
    // ≤4ms event budget: trusted/composition checks, one map lookup, the
    // pure decision, then — only on eligibility — preventDefault + actions.
    if (!ev.isTrusted || ev.isComposing || ev.key === 'Dead') return;
    if (ev.defaultPrevented) return; // the site already consumed this key
    const chord = eventChord(ev);
    if (chord === null) return;
    const spec = registry.get(chord.normalized);
    if (spec === undefined) return; // no key consumed until a chord matches
    let path: Element[] = [];
    try {
      const raw = ev.composedPath();
      path = raw.filter((n): n is Element => n instanceof Element).slice(0, 64);
    } catch {
      path = [];
    }
    if (!decideBinding(spec, {
      key: ev.key,
      ctrlKey: ev.ctrlKey,
      altKey: ev.altKey,
      shiftKey: ev.shiftKey,
      metaKey: ev.metaKey,
      repeat: ev.repeat,
      isComposing: ev.isComposing,
      path,
    }, deps.doc.activeElement as Element | null)) return;
    ev.preventDefault(); // consumed only now (plan/09 §2.4)
    for (const action of spec.actions) executeBindAction(action, spec.target);
  };
  deps.doc.addEventListener('keydown', listener, false);

  return {
    install(spec) {
      registry.set(spec.normalized, spec);
      return {
        dispose() {
          if (registry.get(spec.normalized) === spec) registry.delete(spec.normalized);
        },
      };
    },
    boundChords() {
      const out = new Map<string, string>();
      for (const [normalized, spec] of registry) out.set(normalized, spec.customizationId);
      return out;
    },
    isBound(normalized) {
      return registry.has(normalized);
    },
    installRule(spec) {
      const key = `${spec.customizationId}#${ruleSeq++}`;
      const handle = { dispose: () => rules.delete(key) };
      rules.set(key, { customizationId: spec.customizationId, handle });
      return handle;
    },
    hasRule(customizationId) {
      for (const entry of rules.values()) if (entry.customizationId === customizationId) return true;
      return false;
    },
    dispose() {
      registry.clear();
      rules.clear();
      deps.doc.removeEventListener('keydown', listener, false);
    },
  };
}

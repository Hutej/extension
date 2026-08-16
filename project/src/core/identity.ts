/**
 * core/identity — F1 IDENTITY primitives. Pure, DOM-only, no model.
 *
 * The central F1 invariant (roadmap Phase 4): a transformation must be applied to
 * the INTENDED target, not merely to an element that happens to match the current
 * selector. Identity must be a STRUCTURAL DESCRIPTOR RE-RESOLVED AT USE TIME, not
 * a stamped attribute that must survive a re-render (old RC4).
 *
 * A `fingerprint` is the structural descriptor. It is:
 *  - DETERMINISTIC: same element → same fingerprint (across re-render, since it
 *    derives only from structure, not from a live Node ref or a stamped attribute).
 *  - STYLE-AGNOSTIC: the transform we apply changes style (display, color, …);
 *    `style`, our `data-rv-c`/`data-revueon-inserted` stamps, and transient
 *    attributes are EXCLUDED so the fingerprint survives our own mutation.
 *  - RE-RESOLVABLE: computed from a fresh element at act/undo time, then compared
 *    to the one captured at observe time — so a selector that now points to a
 *    DIFFERENT element is caught, not silently mutated.
 *  - HONEST ABOUT AMBIGUITY: two genuinely-identical siblings (same tag, attrs,
 *    children, text) produce the same fingerprint. For those F1's answer is
 *    FAIL-CLOSED (the loop sees a non-unique resolve and refuses), never
 *    "pick the first one" — a selector matching twins is not an identity.
 *
 * The fail-closed guard:
 *   resolveTarget(dom, selector, expectedFp)
 *     -> { ok, el }        exactly one match AND its fingerprint == expectedFp
 *     -> { ok:false, error, reason }  zero | many | wrong-target | fingerprint-changed
 * Every error names an alternative (rule 13) so the model recovers in one step.
 *
 * This file is pure (no chrome.* , no module state) so it is unit-testable with a
 * fake DOM and reusable by both the inventory path (describePage) and the act
 * path (act.ts). It does NOT create a second rollback system: the guard runs
 * BEFORE a mutation, so on failure no inverse is recorded (nothing happened).
 */

/** A structural fingerprint. Style-agnostic; re-derivable from any element. */
export type Fingerprint = string;

const EXCLUDED_ATTRS = new Set([
  'style', 'data-rv-c', 'data-revueon-inserted',
  // transient layout-state attributes a site may toggle; not identity
  'aria-hidden', 'hidden', 'tabindex', 'data-rv-target',
]);

/** The live DOM surface fingerprint/resolveTarget use. Injected so the pure
 *  logic is unit-testable with a fake tree (mirrors core/ops/txn DomAdapter). */
export interface IdentityDom {
  querySelectorAll(selector: string): Element[];
  /** Read the tag name of an element (lowercased by the adapter). */
  tagName(el: Element): string;
  /** Read the attributes of an element as [name, value][] (stable order). */
  attrs(el: Element): Array<[string, string]>;
  text(el: Element): string;
  childElementCount(el: Element): number;
  depthFromRoot(el: Element): number;
  parent(el: Element): Element | null;
  /** F1 IDENTICAL-TWIN: the fingerprint of a live element, used to count twins
   *  in the flippable set. Delegates to fingerprint(el, dom) so the adapter stays
   *  a thin shim (the real one and the fake both supply it via fingerprint). */
  fingerprintOfRef(el: Element): Fingerprint;
}

/** Capture a structural fingerprint of an element.
 *  Excludes style + Revueon stamps so it survives our own mutations and a
 *  re-render that preserves structure. */
export function fingerprint(el: Element, dom: IdentityDom): Fingerprint {
  const tag = dom.tagName(el);
  const attrs = dom
    .attrs(el)
    .filter(([k]) => !EXCLUDED_ATTRS.has(k) && !k.startsWith('data-rv-'))
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  // Normalize the attribute values: collapse internal whitespace so a site
  // toggling a class list ordering or whitespace does not change identity.
  const attrStr = attrs.map(([k, v]) => `${k}=${norm(v)}`).join(',');
  // A SHORT, normalized text prefix is part of identity (siblings that differ
  // only in text content must differ). Capped at 40 chars so a giant text
  // node does not bloat the fingerprint; trimmed + whitespace-collapsed.
  // The prefix alone collides for boilerplate siblings sharing a 40-char text
  // prefix (product-card / 'Read more…' templates) — and that prefix is the
  // ONLY discriminator for text-only siblings, so a collision defeats the
  // wrong-target guard (resolveTarget would verify the wrong twin). Append a
  // short hash of the FULL normalized text so two texts that share a prefix
  // but differ anywhere still produce distinct fingerprints, without bloat.
  const fullText = norm(dom.text(el));
  const text = fullText.slice(0, 40);
  const childCount = dom.childElementCount(el);
  const depth = dom.depthFromRoot(el);
  return `${tag}|${attrStr}|c${childCount}|d${depth}|${text}|${shortHash(fullText)}`;
}

function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** A tiny deterministic hash (FNV-1a, 32-bit) as 8 hex chars. Used so two
 *  elements whose normalized text shares the 40-char prefix but differs
 *  anywhere beyond it still get distinct fingerprints. Pure, no dependency,
 *  deterministic for the same input string. Uses the full 32-bit result: a
 *  prior .slice(0,7) dropped the top nibble to ~28 effective bits, and for
 *  text-only siblings that share the 40-char prefix this hash is the ONLY
 *  discriminator — so ~28 bits made a real (if rare) collision plausible
 *  (≈C(k,2)·2^-28 per page), producing a false twin-negative (two genuinely
 *  distinct siblings treated as identical twins → resolveTarget refuses a
 *  legit target) with no truncated:true signal. Keep all 8 hex chars (32
 *  bits): the cost is one char, the collision space is 16× larger. */
function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // h *= 0x01000193 (FNV-1a prime), kept a 32-bit unsigned int via >>> 0.
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Why a target failed to resolve — surfaced to the model (rule 13). */
export type ResolveReason =
  | 'zero'                 // selector matched nothing
  | 'ambiguous'            // selector matched >1 element (not an identity)
  | 'wrong-target'         // the matched element's fingerprint differs (a different element)
  | 'indistinguishable-twin' // the resolved element has an identical structural fingerprint elsewhere in the set a sibling/div reorder could route the selector to — F1 cannot tell which physical element is intended
  | 'unverified';          // exactly one match but no observe-time fingerprint (model used a selector describePage never returned)

export interface ResolveResult {
  ok: boolean;
  el?: HTMLElement;
  reason?: ResolveReason;
  error?: string;
  /** The live match count, surfaced for diagnostics/teaching the model. */
  matched?: number;
}

/** The fail-closed identity guard. Re-resolve `selector` against the LIVE DOM
 *  at use time and verify the (single) match is the element we observed.
 *  - exactly one match AND fingerprint == expectedFp  -> { ok, el }            (verified)
 *  - exactly one match AND no expectedFp              -> { ok, el, reason: 'unverified' } (a unique target the model named directly; F1 cannot verify it against a prior observe, but it is a single element, not wrong by construction — mutate, flagged low-confidence)
 *  - zero / many / wrong-target                      -> { ok:false, error, reason } (fail-closed)
 *  Every refusal error names an alternative so the model recovers in one step.
 *
 *  Why "unverified" mutates rather than refuses: the roadmap's F1 invariant is
 *  "a transformation must be applied to the intended TARGET, not merely to an
 *  element that matches the selector." The wrong-target risk is a selector the
 *  model GOT FROM describePage now pointing elsewhere — that is the `wrong-target`
 *  refusal (fingerprint present + differs). A selector the model invented that
 *  resolves to exactly one element is a model-judgment call (F1 cannot know the
 *  intent without a prior observe); refusing it would block every act that does
 *  not follow a describePage (a tooling/test/legacy constraint F1 does not own).
 *  The zero/many refusals are the unambiguous identity failures F1 must close. */
export function resolveTarget(
  dom: IdentityDom,
  selector: string,
  expectedFp: Fingerprint | null,
): ResolveResult {
  let live: Element[];
  try { live = dom.querySelectorAll(selector); }
  catch { return { ok: false, reason: 'zero', matched: 0, error: `invalid selector "${selector}" — check syntax and call describePage to see available regions` }; }

  const matched = live.length;
  if (matched === 0) {
    return { ok: false, reason: 'zero', matched: 0,
      error: `selector "${selector}" matched nothing on the page now. The element may have been removed or re-rendered. Call describePage again to find the current region, then retry.` };
  }
  if (matched > 1) {
    return { ok: false, reason: 'ambiguous', matched,
      error: `selector "${selector}" matched ${matched} elements — that is not a unique identity. Refine the selector with a stable anchor (id, data-testid, role) or a parent that uniquely contains the target. If the matches are structurally identical twins (same tag, attrs, text), no selector can distinguish them — ask the user which one, or target a parent that uniquely contains it. Call describePage to see the regions and their selectors.` };
  }
  // Exactly one match. Compute the live fingerprint ONCE — it is used for both
  // the observe-time verify (if we have one) and the identical-twin check below.
  const el = live[0] as HTMLElement;
  const liveFp = fingerprint(el, dom);

  // F1 IDENTICAL-TWIN fail-closed: run BEFORE the observe-time verify and before
  // the unverified branch, so the twin ambiguity is caught in BOTH paths. If
  // another element in the set a sibling/div reorder could route this selector
  // to has the SAME fingerprint, identity is genuinely ambiguous — F1 cannot
  // tell which physical element is intended (Phase-4 review finding; the reorder
  // case is the attack). Refuse rather than mutate either. This runs on the
  // UNVERIFIED path too: otherwise `unverified` would be the twin bypass.
  if (!isUniqueInFlippableSet(el, liveFp, selector, dom)) {
    return { ok: false, reason: 'indistinguishable-twin', matched: 1,
      error: `target "${selector}" is structurally indistinguishable from another element (identical tag, attributes, text, and children). Revueon cannot determine which one you mean, so it refuses to change either. Give the target a stable distinguishing anchor (a unique id, data-testid, role, or aria-label) or target a parent that uniquely contains the one you want, then call describePage and retry.` };
  }

  if (!expectedFp) {
    // No prior observe for this selector: a unique target, but unverified. Mutate
    // (single element is not wrong by construction), flagged unverified.
    return { ok: true, el, reason: 'unverified', matched: 1 };
  }
  if (liveFp !== expectedFp) {
    return { ok: false, reason: 'wrong-target', matched: 1,
      error: `selector "${selector}" now resolves to a different element than the one describePage described (structure changed). Call describePage again to get the current selector for that region, then retry.` };
  }
  return { ok: true, el };
}

/** Strip the positional pseudo-classes (`:nth-of-type(k)`, `:nth-child(k)`,
 *  `:first|last|only-of-type|-child`) from a selector. These are the ONLY parts
 *  that can silently reroute to a different physical element under a sibling/div
 *  reorder — the identical-twin attack. What remains ("the flippable set") is the
 *  set of elements the selector could resolve to AFTER a reorder of equivalent
 *  structure: an id-anchored descendant chain (e.g. `main#main > article`), a
 *  role-anchored chain, or — for a bare positional selector — the bare tag. A
 *  bare selector matching one element (e.g. `aside#sb`) relaxes to itself and is
 *  its own flippable set of size 1 → never trips. Returns '' if the selector is
 *  ONLY positional (a bare `:nth-of-type(k)` with no compound) — in that case the
 *  bare tag must be derived from the element instead (caller falls back to tag). */
function stripPositional(sel: string): string {
  // Comma lists: relax each part and re-join. (A twin in any part's flippable set
  // is reachable by a reorder through that part, so each part is relaxed on its own.)
  const relaxed = sel.split(',').map((raw) => {
    let s = raw.trim();
    s = s.replace(/:nth-of-type\(([^)]*)\)/g, '');
    s = s.replace(/:nth-child\(([^)]*)\)/g, '');
    s = s.replace(/:nth-last-of-type\(([^)]*)\)/g, '');
    s = s.replace(/:nth-last-child\(([^)]*)\)/g, '');
    s = s.replace(/:first-of-type/g, '');
    s = s.replace(/:last-of-type/g, '');
    s = s.replace(/:only-of-type/g, '');
    s = s.replace(/:first-child/g, '');
    s = s.replace(/:last-child/g, '');
    s = s.replace(/:only-child/g, '');
    return s.replace(/\s+/g, ' ').trim();
  }).filter((s) => s.length > 0);
  return relaxed.length > 0 ? relaxed.join(',') : '';
}

/** Is `el` uniquely identifiable by its fingerprint within the set of elements a
 *  reorder of equivalent structure could route its selector to? The flippable set
 *  is the selector with positional pseudo-classes stripped (the parts a reorder
 *  re-routes). If another element in that set shares `el`'s fingerprint, identity
 *  is genuinely ambiguous → NOT unique. Excludes elements we may have inserted
 *  (`[data-revueon-inserted]`) and our `[data-rv-c]` stamps are already
 *  fingerprint-agnostic, so a twin set never counts our own nodes. */
function isUniqueInFlippableSet(
  el: Element, elFp: Fingerprint, selector: string, dom: IdentityDom,
): boolean {
  let flippableSel = stripPositional(selector);
  // A selector that was ONLY positional (bare :nth-of-type(k)) has nothing left
  // to relax to. Derive the flippable set from the element itself: its same-tag
  // siblings — the set a reorder routes through. (buildStableSelector always
  // emits an anchored chain, so this branch is defensive, not the common path.)
  let flippable: Element[];
  if (flippableSel) {
    try { flippable = dom.querySelectorAll(flippableSel); }
    catch { return false; } // malformed relaxed selector (e.g. a bare positional that was the right-hand compound of a combinator relaxes to a dangling combinator): a parse quirk is exactly when 'unique' is unsafe — fail-closed
  } else {
    const p = dom.parent(el);
    if (!p) return true; // no parent: the root element; nothing to flip to
    flippable = dom.querySelectorAll('*').filter((e) => dom.parent(e) === p);
  }
  // Count how many elements in the flippable set share el's fingerprint. A twin
  // (a distinct element with the same fp) means a reorder reroutes the selector
  // to it with an identical fp → the guard would verify the wrong twin. Exclude
  // our own inserted nodes (they are not user content and never a legit twin).
  let twinCount = 0;
  for (const e of flippable) {
    if (isOurInsertedNode(e, dom)) continue;
    if (dom.fingerprintOfRef(e) === elFp) twinCount++;
  }
  // Fail-closed when the flippable set is empty: a relaxed selector that matched
  // nothing (e.g. a bare positional that was the right-hand compound of a
  // combinator relaxes to a dangling combinator, which the live adapter swallows
  // to []) could not be evaluated — identity is uncertain, so refuse rather than
  // assume unique (twinCount 0 would otherwise read as 'no twin' → false-unique,
  // bypassing the guard for the exact reorder attack it exists to stop).
  return flippable.length > 0 && twinCount <= 1;
}

/** Our own inserted nodes (carry [data-revueon-inserted]) are not user content
 *  and never a legitimate twin. Read via attrs so it works on the fake DOM too. */
function isOurInsertedNode(el: Element, dom: IdentityDom): boolean {
  return dom.attrs(el).some(([k]) => k === 'data-revueon-inserted');
}

/**
 * tools/act — action tools. Scoped, reversible. Every action records its inverse.
 *
 * A: CSS is inserted at the USER origin via chrome.scripting.insertCSS from
 * the background. No style node, no @layer wrapping. User origin beats
 * author origin. The content script sends a message; the background inserts.
 *
 * B: The emitter takes structured rules. !important is appended at
 * serialisation from a flag, never by scanning a value. At-rules never
 * receive !important on their inner declarations.
 *
 * C: assertApplied — the computed style must move. Every act tool returns
 * { applied, before, after, matched }. A run where every act returned
 * applied: false is a FAILED run.
 */

import type { ToolDef, ToolResult } from './index';
import { sanitizeCss } from '../core/sanitize';
import { applyHealing } from '../core/heal';
import { parseCss, serializeEmit, primaryTarget, allSelectors, allRuleTargets, type EmitItem } from '../core/emit';
import { recordStructural } from '../core/ops/recorder';
import { resolveTarget, fingerprint, type IdentityDom } from '../core/identity';
import { fixedPxDominates, findLayoutMotion, buildReducedMotionCss } from '../core/responsive';
import { liveIdentityDom } from '../core/identity-dom';
import { getIdentity } from '../core/identity-store';
import { digestOfElement } from '../core/persist/digest.ts';

// ── F1 IDENTITY: fail-closed target guard ───────────────────────────
// The act tools re-resolve the model's selector against the LIVE DOM at use
// time and verify the (single) match is the element describePage described —
// via the structural fingerprint captured at observe time. On zero/many/
// wrong-target the tool REFUSES (ok:false, names an alternative per rule 13)
// and records NO inverse (no mutation happened — this is not a second rollback
// system; the guard runs before the mutation). This is the gap F5's geometry
// check could not close: F5 checks the page AFTER an act; F1 refuses a bad
// target BEFORE it. CSS acts (applyCss/hide/heal) target the cascade, so the
// guard verifies the primary selector the CSS will hit.

/** Re-resolve + verify a selector against the live DOM. Returns the element on
 *  success, or a refusal ToolResult (ok:false) on a verify failure. On the
 *  'unverified' success path (exactly one match but no observe-time
 *  fingerprint — the model named a selector describePage never returned) the
 *  reason is surfaced so the caller can set a low confidence. That confidence
 *  is informational (shown to the model in the journal); it gates nothing — the
 *  mutate-or-refuse decision here is the real gate. This fulfils identity.ts's
 *  documented "mutate, flagged low-confidence" promise; the mutate-or-refuse
 *  decision is unchanged (locked by tests/f1-identity-test.ts). */
function guardTarget(selector: string): { ok: true; el: HTMLElement; unverified?: boolean } | { ok: false; result: ToolResult } {
  const expectedFp = getIdentity(selector);
  const r = resolveTarget(liveIdentityDom as IdentityDom, selector, expectedFp);
  if (!r.ok || !r.el) {
    return { ok: false, result: { ok: false, error: r.error, confidence: 0.1, costMs: 0 } };
  }
  return { ok: true, el: r.el, unverified: r.reason === 'unverified' };
}

/** Capture the post-resolve fingerprint of the element we are about to mutate,
 *  for the setText/insert undo verify (the RC6-class fix). */
function actFingerprint(el: Element): string {
  return fingerprint(el, liveIdentityDom as IdentityDom);
}

// ── A: CSS origin helpers (content script → background) ───────────

function sendInsertCSS(css: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'insertCSS', css }, (response) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(response || { ok: false, error: 'no response' });
    });
  });
}

function sendRemoveCSS(css: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'removeCSS', css }, (response) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(response || { ok: false, error: 'no response' });
    });
  });
}

// ── C: assertApplied — computed style must move ────────────────────
// Compares ALL declared longhand properties before→after (not just the first).
// CSSOM expands shorthands: `background: red` → background-image (stays 'none')
// first, then background-color (turns red). Asserting only declarations[0]
// reads background-image and reports applied:false on a successful application.
//
// Phase 2.5 TASK3: getComputedStyle DURING a CSS transition returns the
// INTERPOLATED value, not the final. A single requestAnimationFrame after the
// insert (the old mechanism) would read the mid-transition value and treat it
// as the result — confirmed by tests/assert-applied-timing-test.ts: with
// `transition: width 2s`, getComputedStyle at 1 rAF returns ~101px (interpolated),
// not the settled 300px. Fix: detect an active transition on the asserted
// element and, if present, wait for transitionend (bounded — the smallest
// reliable browser sync, not an arbitrary sleep) before reading. If no
// transition, one rAF is enough (Investigation A: synchronous application).

function readComputed(selector: string, properties: string[]): string {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) return '';
  const cs = getComputedStyle(el);
  return properties.map((p) => cs.getPropertyValue(p)).join('|');
}

/** TASK3: does the element have a NON-ZERO transition on any property? If so
 *  assertApplied must wait for it to settle before reading the final value.
 *  Returns the max transition-duration in ms (0 if none / all-zero). */
function activeTransitionMs(el: Element): number {
  const cs = getComputedStyle(el);
  // transitionDuration may be "0s, 0.2s, 2s" (per-property). Parse all, take max.
  const durations = cs.transitionDuration.split(',').map((d) => d.trim());
  let maxMs = 0;
  for (const d of durations) {
    const s = parseFloat(d);
    if (!isNaN(s) && s > 0) maxMs = Math.max(maxMs, s * 1000);
  }
  return maxMs;
}

/** TASK3: wait for an active transition to settle. Smallest reliable sync:
 *  a bounded transitionend listener; if it doesn't fire within maxMs+500ms,
 *  fall through (read whatever the computed value is — honest, not a guess).
 *  No-op if no active transition. */
function waitForTransition(el: Element, maxMs: number): Promise<void> {
  if (maxMs <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    el.addEventListener('transitionend', finish, { once: true });
    // ponytail: cap at the transition duration + 500ms grace. If transitionend
    // never fires (e.g. the transition was overridden or the property is
    // discrete/non-animatable), don't hang — fall through after the cap.
    setTimeout(finish, maxMs + 500);
  });
}

interface AssertResult {
  applied: boolean; before: string; after: string; matched: number; transitioned: boolean;
}

async function assertApplied(selector: string, properties: string[], before: string): Promise<AssertResult> {
  const els = document.querySelectorAll(selector);
  const matched = els.length;
  if (matched === 0) return { applied: false, before, after: '', matched: 0, transitioned: false };
  const el = els[0] as HTMLElement;
  // TASK3: if an active transition is in flight, wait for it to settle before
  // reading — otherwise we capture an interpolated mid-transition value.
  const tMs = activeTransitionMs(el);
  if (tMs > 0) await waitForTransition(el, tMs);
  const cs = getComputedStyle(el);
  const after = properties.map((p) => cs.getPropertyValue(p)).join('|');
  return { applied: after !== before && after !== '', before, after, matched, transitioned: tMs > 0 };
}

// ── Core: emit, insert, assert, re-emit important if needed ────────

/** T5 typography visual truth: did the page's RENDERED TEXT change?
 *  The perSelector assert is rule-level — a sheet scoped to `body` reports
 *  applied:true when body's computed font moves even while the site's text is
 *  painted by descendant author rules (HN: news.css sets font-family on body
 *  AND td; the body-scoped sheet changed body's computed value and NOTHING
 *  visible — baseline hn-body shipped a visual no-op as success with
 *  byte-identical before/after screenshots). Typography's truth is the
 *  rendered text: sample leaf text elements, compare their computed
 *  typography before/after the sheet settles, and report which changed.
 *  Evidence, never a decision — the model sees "text unchanged" + the stock
 *  values and re-scopes (invariant 3). */
const TEXT_SAMPLE_SEL = 'p, li, td, a, h1, h2, h3, span';
const TEXT_SAMPLE_CAP = 8;

interface TextEffect {
  sampled: number;
  changed: number;
  /** first unchanged samples (element tag + computed signature) — the stock
   *  values the model can re-scope against. */
  unchanged: string[];
}

function sampleTextEls(): Element[] {
  const out: Element[] = [];
  try {
    const all = Array.from(document.querySelectorAll(TEXT_SAMPLE_SEL)).filter((el) =>
      Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? '').trim().length > 2) &&
      (el as HTMLElement).offsetWidth > 0);
    // stride-sample across the WHOLE page (DOM-order-first-N would over-sample
    // the header on list pages: a td.title-scoped sheet read changed:0 there
    // while the titles visibly changed) — every ceil(n/cap)th element, ≤cap.
    const stride = Math.max(1, Math.ceil(all.length / TEXT_SAMPLE_CAP));
    for (let i = 0; i < all.length && out.length < TEXT_SAMPLE_CAP; i += stride) out.push(all[i]);
  } catch { /* best-effort evidence */ }
  return out;
}

function textSignature(el: Element): string {
  const cs = getComputedStyle(el);
  return `${el.tagName.toLowerCase()}: ${[cs.fontFamily, cs.fontSize, cs.lineHeight, cs.letterSpacing].join(' | ')}`;
}

// ── R1: visual effect truth — did ANYTHING visibly change? ──────────
// T5's textEffect covers typography only. T6 shipped a byte-identical
// SPACING no-op as done (wiki-content-area): geometry moves are invisible
// to the text sampler. This generalizes it: sample text leaves AND
// layout containers, compare geometry / visibility / paint / type, and
// report one honest line — VISIBLE or NO VISIBLE CHANGE. Evidence for the
// model (rule 3), never a gate: the model reads it and re-scopes.
const CONTAINER_SAMPLE_SEL = 'div, section, article, header, nav, main, aside, ul, table, form';
const CONTAINER_SAMPLE_CAP = 24;
// ponytail: fixed px deltas, not ratios — ratio thresholds misfire on tiny
// elements; 8px is the smallest spacing change a user would call visible.
const MOVE_PX = 8;
const RESIZE_PX = 8;

interface VisualSample {
  x: number; y: number; w: number; h: number;
  visible: boolean;
  color: string; bg: string; font: string;
}

function visualSignature(el: Element): VisualSample {
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  return {
    x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
    visible: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none',
    color: cs.color, bg: cs.backgroundColor,
    font: `${cs.fontFamily} ${cs.fontSize}/${cs.lineHeight}`,
  };
}

function sampleContainerEls(): Element[] {
  const out: Element[] = [];
  try {
    const all = Array.from(document.querySelectorAll(CONTAINER_SAMPLE_SEL)).filter((el) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    const stride = Math.max(1, Math.ceil(all.length / CONTAINER_SAMPLE_CAP));
    for (let i = 0; i < all.length && out.length < CONTAINER_SAMPLE_CAP; i += stride) out.push(all[i]);
  } catch { /* best-effort evidence */ }
  return out;
}

export interface VisualEffect {
  sampled: number;
  moved: number;
  resized: number;
  hiddenNow: number;
  paintChanged: number;
  textChanged: number;
  visibleChange: boolean;
  /** the model-facing line (rule 13: a no-op names the alternative). */
  summary: string;
}

function diffVisual(els: Element[], before: VisualSample[]): VisualEffect | undefined {
  if (!els.length) return undefined;
  let moved = 0, resized = 0, hiddenNow = 0, paintChanged = 0, textChanged = 0;
  for (let i = 0; i < els.length; i++) {
    const a = visualSignature(els[i]);
    const b = before[i];
    if (b.visible && !a.visible) hiddenNow++;
    if (Math.abs(a.x - b.x) > MOVE_PX || Math.abs(a.y - b.y) > MOVE_PX) moved++;
    if (Math.abs(a.w - b.w) > RESIZE_PX || Math.abs(a.h - b.h) > RESIZE_PX) resized++;
    if (a.color !== b.color || a.bg !== b.bg) paintChanged++;
    if (a.font !== b.font) textChanged++;
  }
  const visibleChange = moved + resized + hiddenNow + paintChanged + textChanged > 0;
  const buckets = [
    resized && `${resized} resized`,
    moved && `${moved} moved`,
    paintChanged && `${paintChanged} repainted`,
    textChanged && `${textChanged} restyled text`,
    hiddenNow && `${hiddenNow} hidden`,
  ].filter(Boolean).join(', ');
  const summary = visibleChange
    ? `VISIBLE — ${buckets} (of ${els.length} sampled)`
    : `NO VISIBLE CHANGE — geometry, text and paint all unchanged on ${els.length} sampled elements. The sheet landed but is shadowed or already at target: the elements that actually paint this content are targeted by other rules. Call findElements on the region you want to change, then scope the CSS to those elements.`;
  return { sampled: els.length, moved, resized, hiddenNow, paintChanged, textChanged, visibleChange, summary };
}

/** C: emit normal first, measure EVERY rule the sheet carries, re-emit
 *  important if ANY rule's computed value did not move. For hide, default to
 *  important. Returns the exact CSS string inserted, the primary assert, and
 *  the per-selector verdict.
 *
 *  T4 (evidence: proof/T4_DECISION.md §C-1): the sheet is inserted at USER
 *  origin, and per CSS Cascading L4 §6.4 author-normal beats user-normal —
 *  site CSS or a presentational bgcolor attribute silently defeats an
 *  un-important rule. The old code measured only the PRIMARY selector
 *  (primaryTarget): a sheet whose primary landed shipped as "applied" even
 *  when every secondary rule was defeated — hn-accents' coordinated blue-gray
 *  theme delivered exactly one background (the roadmap's named failure:
 *  "changing only one background"). The retry now triggers when ANY rule
 *  failed to move, and the result reports which rules landed. */
async function emitAndInsert(
  rawCss: string,
  defaultImportant: boolean,
  withTextEffect: boolean = false,
): Promise<{ css: string; assert: AssertResult | null; perSelector?: Array<{ selector: string; applied: boolean; note?: string }>; textEffect?: TextEffect; visualEffect?: VisualEffect; error?: string }> {
  const { css: sanitized } = sanitizeCss(rawCss);
  if (!sanitized.trim()) return { css: '', assert: null, error: 'CSS was entirely rejected by sanitizer.' };

  const items = parseCss(sanitized);
  if (!items.length) return { css: '', assert: null, error: 'No valid CSS rules after parsing.' };

  const target = primaryTarget(items);
  // T4: measure every style rule (capped — model sheets are typically <10
  // rules; beyond 24 the dominant rules are measured and the rest noted).
  const targets = allRuleTargets(items).slice(0, 24);

  const summarize = (results: Array<AssertResult | null>): Array<{ selector: string; applied: boolean; note?: string }> =>
    targets.map((t, i) => {
      const r = results[i];
      if (!r) return { selector: t.selector, applied: false, note: 'unmeasured' };
      if (r.matched === 0) return { selector: t.selector, applied: false, note: 'no measurable match (state-dependent or absent)' };
      if (r.applied) return { selector: t.selector, applied: true };
      return { selector: t.selector, applied: false, note: 'unchanged — already at target, or page styles override even !important' };
    });

  const measureAll = async (befores: string[]): Promise<Array<AssertResult | null>> => {
    const out: Array<AssertResult | null> = [];
    for (let i = 0; i < targets.length; i++) {
      out.push(await assertApplied(targets[i].selector, targets[i].properties, befores[i]));
    }
    return out;
  };

  // Phase 1: emit at the specified importance level.
  const cssPhase = serializeEmit(defaultImportant
    ? items.map(i => i.kind === 'style' ? { ...i, important: true } : i)
    : items,
  );

  // T5: typography visual truth — sample the rendered text BEFORE the sheet
  // inserts (the sheet may then change body/td values; the samples measure
  // what the page's text actually renders after the sheet settles).
  // R1: containers too — geometry/paint deltas (the T6 spacing no-op class).
  const textEls = withTextEffect ? sampleTextEls() : [];
  const textBefore = textEls.map(textSignature);
  const visEls = withTextEffect ? sampleContainerEls() : [];
  const visBefore = visEls.map(visualSignature);
  // Compute both effects against the SAME pre-insert baseline (net effect vs
  // the original page — the !important re-emit path measures against befores2
  // for rule delivery, but the VISUAL truth is original-page vs final state).
  const effectOf = () => ({
    textEffect: buildTextEffect(textEls, textBefore),
    visualEffect: diffVisual(visEls, visBefore),
  });

  if (target) {
    const befores = targets.map((t) => readComputed(t.selector, t.properties));
    const insRes = await sendInsertCSS(cssPhase);
    if (!insRes.ok) return { css: cssPhase, assert: null, error: insRes.error };
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    const results = await measureAll(befores);
    // A rule with no measurable match (e.g. :hover in a fresh profile) cannot
    // fail — it is skipped by the summarize() note, not by the gate.
    const allApplied = results.every((r, i) => r === null ? true : (r.matched === 0 ? true : r.applied));

    if (allApplied) return { css: cssPhase, assert: results[0], perSelector: summarize(results), ...effectOf() };

    // Phase 2: SOME rule did not move — re-emit the WHOLE sheet with
    // !important (if we didn't already). The retry is idempotent for genuine
    // no-ops (same computed value, now cascade-enforced).
    if (!defaultImportant) {
      // Adversarial review (wf_e3e50d92, skeptic claim_3): the return of
      // sendRemoveCSS was IGNORED. If it silently fails, BOTH the normal and
      // the !important sheets would be applied, but the inverse records only
      // the !important sheet — so a later removeCSS(inverse) would leave the
      // normal sheet permanently on the page (a silent reversal leak). Fix:
      // check the removal; if it failed, do NOT proceed to the !important
      // insert (return an error so the loop rolls back the normal sheet it
      // DID insert — a clean, single-sheet failure, not a split-brain one).
      const rmRes = await sendRemoveCSS(cssPhase);
      if (!rmRes.ok) return { css: cssPhase, assert: results[0], perSelector: summarize(results), ...effectOf(), error: `failed to remove the normal sheet before re-emitting !important: ${rmRes.error || 'unknown'}` };
      const cssImportant = serializeEmit(items.map(i => i.kind === 'style' ? { ...i, important: true } : i));
      const befores2 = targets.map((t) => readComputed(t.selector, t.properties));
      const insRes2 = await sendInsertCSS(cssImportant);
      if (!insRes2.ok) return { css: cssImportant, assert: null, error: insRes2.error };
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      const results2 = await measureAll(befores2);
      return { css: cssImportant, assert: results2[0], perSelector: summarize(results2), ...effectOf() };
    }
    return { css: cssPhase, assert: results[0], perSelector: summarize(results), ...effectOf() };
  }

  // No targetable selector — insert without measurement.
  const insRes = await sendInsertCSS(cssPhase);
  if (!insRes.ok) return { css: cssPhase, assert: null, error: insRes.error };
  await new Promise<void>((r) => requestAnimationFrame(() => r()));
  return { css: cssPhase, assert: null, ...effectOf() };
}

/** T5: compare the sampled text signatures — evidence for the model. */
function buildTextEffect(textEls: Element[], before: string[]): TextEffect | undefined {
  if (!textEls.length) return undefined;
  const unchanged: string[] = [];
  let changed = 0;
  for (let i = 0; i < textEls.length; i++) {
    const after = textSignature(textEls[i]);
    if (after !== before[i]) changed++;
    else if (unchanged.length < 3) unchanged.push(after);
  }
  return { sampled: textEls.length, changed, unchanged };
}

// ── applyCss — the primary action ──────────────────────────────────

/**
 * State-dependent pseudo-classes match zero elements in a fresh environment
 * (no history → `:visited` matches nothing; nothing hovered → `:hover`
 * matches nothing) while being perfectly valid cascade CSS. Verified T2: HN
 * dark-mode died 6 acts deep because every sheet carrying `a:visited` was
 * refused as "matched nothing". These selectors skip the zero-match check;
 * structural selectors (`td:nth-child(2)`) and hallucinated classes
 * (`.commtext`) still refuse, and the refusal message still guides.
 */
const STATE_PSEUDO = /:(hover|visited|active|focus(-with|-visible)?|target|link|fullscreen|checked|disabled|enabled)\b/i;

/**
 * R3a: how ONE selector-part of a stylesheet fares against the live page.
 * Replaces the old refuse-the-whole-sheet guard (guardCssSelector), whose
 * blast radius the protocol experiment proved fatal to large coherent
 * authoring: 100% of bold sheets died on a single unmatched selector
 * (proof/2026-09-02-transformation-protocol-experiment.md, unfiltered
 * sub-run). Classification, not veto:
 *
 *   ok            — matches now (store-known identity verified, or an
 *                   unknown selector — flagged unverified, as before)
 *   unmatched-now — zero current matches. KEPT, not dropped: rule 8 — the
 *                   cascade applies to elements that do not exist yet
 *                   (SPA re-renders, lazily created content); the selector
 *                   lies dormant until its element appears. Reported so the
 *                   model knows what is currently inert.
 *   broad         — store-known selector matching several elements, or an
 *                   identical twin. Styling N elements is the POINT of a
 *                   stylesheet rule; the strict one-target guard (guardTarget)
 *                   still protects hide/insert/setText. Reported with count.
 *   drop          — invalid syntax (can never match anything), or a stale
 *                   identity (wrong-target: the selector describePage
 *                   verified now resolves to a different element — the one
 *                   verdict that must not be allowed to style).
 */
type CssSelectorVerdict =
  | { kind: 'ok'; verified: boolean }
  | { kind: 'unmatched-now' }
  | { kind: 'broad'; matched: number }
  | { kind: 'drop'; reason: string };

function classifyCssSelector(selector: string): CssSelectorVerdict {
  let matched = 0;
  try { matched = document.querySelectorAll(selector).length; }
  catch { return { kind: 'drop', reason: 'invalid syntax (can never match)' }; }
  if (matched === 0) {
    // State pseudos cannot be statically evaluated (`a:hover` matches nothing
    // unless hovered) — exempt from the unmatched report, as the old guard was.
    if (STATE_PSEUDO.test(selector)) return { kind: 'ok', verified: false };
    return { kind: 'unmatched-now' };
  }
  const expectedFp = getIdentity(selector);
  if (!expectedFp) return { kind: 'ok', verified: false };
  const r = resolveTarget(liveIdentityDom as IdentityDom, selector, expectedFp);
  if (r.ok) return { kind: 'ok', verified: true };
  if (r.reason === 'wrong-target') return { kind: 'drop', reason: 'stale identity — selector now resolves to a different element than the one observed' };
  return { kind: 'broad', matched: r.matched ?? matched };
}

/**
 * Paren-aware selector-list split. `:is(a, b)`, `:not(.x, .y)` must never be
 * torn at inner commas — the CSSOM already parsed the rule (parseCss); this
 * only re-splits the selector LIST it hands back, at depth-zero commas.
 */
function splitSelectorParts(selector: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of selector) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) { parts.push(current); current = ''; continue; }
    current += ch;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** What happened to every selector-part of a sheet — the diagnostics contract
 *  (rule 12: nothing silently clipped; rule 13: every diagnostic names its
 *  reason). Capped lists keep the journal bounded on 100-selector sheets. */
interface SelectorReport {
  applied: number;
  unmatchedNow: string[];
  dropped: Array<{ selector: string; reason: string }>;
  broad: Array<{ selector: string; count: number }>;
}

/**
 * Filter a parsed sheet to its verified selectors, rule by rule, collecting
 * the report. @keyframes passes untouched (its inner selectors are keyText —
 * timing tokens, not DOM selectors); @media/@supports recurse (their inner
 * rules apply to real elements); a rule whose every part dropped is removed.
 * The returned items serialize back to the exact sheet the runtime can stand
 * behind. Mirrors hide's healing-rule drop (act.ts hide) — the established
 * drop-not-refuse precedent.
 */
function filterSheetSelectors(items: EmitItem[], report: SelectorReport, unverifiedRef: { value: boolean }): EmitItem[] {
  const out: EmitItem[] = [];
  for (const item of items) {
    if (item.kind === 'at') {
      if (item.prelude.startsWith('@keyframes')) { out.push(item); continue; }
      const inner = filterSheetSelectors(item.items, report, unverifiedRef);
      if (inner.length > 0) out.push({ ...item, items: inner });
      continue;
    }
    if (item.kind !== 'style' || item.declarations.length === 0) { out.push(item); continue; }
    const kept: string[] = [];
    for (const part of splitSelectorParts(item.selector)) {
      const v = classifyCssSelector(part);
      if (v.kind === 'ok') {
        kept.push(part);
        report.applied++;
        if (!v.verified) unverifiedRef.value = true;
      } else if (v.kind === 'unmatched-now') {
        kept.push(part); // dormant, not dead — applies when the element appears
        if (report.unmatchedNow.length < 12 && !report.unmatchedNow.includes(part)) report.unmatchedNow.push(part);
      } else if (v.kind === 'broad') {
        kept.push(part);
        report.applied++;
        if (report.broad.length < 6) report.broad.push({ selector: part, count: v.matched });
      } else if (report.dropped.length < 6) {
        report.dropped.push({ selector: part, reason: v.reason });
      }
    }
    if (kept.length > 0) out.push({ ...item, selector: kept.join(', ') });
  }
  return out;
}

async function applyCss(args: any): Promise<ToolResult> {
  let css = args?.css as string;
  if (!css || !css.trim()) return { ok: false, error: 'missing or empty "css" argument. Provide valid CSS rules as a string.' };

  // R3a (T2 revision, experiment-corrected): a stylesheet is CASCADE INTENT.
  // Verify every selector-part against the live page — but classify and keep
  // the verified remainder instead of refusing the whole sheet over one bad
  // part (the old all-or-nothing loop is the single failure class that made
  // large coherent transformations impossible; see classifyCssSelector).
  // Iterating every style rule's every comma-part recursing into @media/
  // @supports is inherited from allSelectors — no rule dodges the check.
  const items = parseCss((sanitizeCss(css).css));
  const selectorReport: SelectorReport = { applied: 0, unmatchedNow: [], dropped: [], broad: [] };
  const unverifiedRef = { value: false };
  const filteredItems = filterSheetSelectors(items, selectorReport, unverifiedRef);
  if (filteredItems.length === 0) {
    return {
      ok: false,
      error: `every selector in the sheet was dropped (${selectorReport.dropped.map((d) => `"${d.selector}": ${d.reason}`).join('; ')}). Call describePage to see the page's current regions and their selectors, then author against them.`,
      confidence: 0.1,
      costMs: 0,
    };
  }
  const unverified = unverifiedRef.value;
  css = serializeEmit(filteredItems);

  // Phase 7: refuse fixed-pixel LAYOUT DOMINANCE before emitting. A restyle
  // reconstructed from measurements (position:absolute/fixed, fixed px on
  // width/height/offsets) breaks on resize — Law 6. Count fixed-px layout
  // signals vs responsive signals; if fixed DOMINATES, refuse before any
  // mutation (nothing to roll back — the model retries with responsive CSS).
  // px is NOT banned: borders/spacing/typography/shadows/radii pass (only the
  // LAYOUT-sizing/positioning properties count). A colour/typography-only
  // restyle (no layout decls) has fixedCount=0 and passes. See core/responsive.ts.
  const dominance = fixedPxDominates(filteredItems);
  if (dominance) {
    return {
      ok: false,
      error: `[responsive] this CSS uses fixed-pixel layout (${dominance.fixedCount} fixed signal(s): ${dominance.fixed.join(', ')}) but only ${dominance.responsiveCount} responsive signal(s). A layout rebuilt from measured pixels breaks when the viewport changes. Rewrite it with responsive sizing: percentages, fr, auto, minmax(), clamp(), fit-content, aspect-ratio, Flexbox (display:flex), or CSS Grid (display:grid) instead of fixed px on width/height/position and position:absolute. Fixed px is fine for borders, spacing, typography, and shadows.`,
      confidence: 0.1,
      costMs: 0,
    };
  }

  // T3 motion guard: transitions/animations on layout properties reflow the
  // page on every frame — refuse before any mutation (nothing to roll back).
  // Same position and shape as the dominance gate above.
  const motion = findLayoutMotion(filteredItems);
  if (motion.length > 0) {
    return {
      ok: false,
      error: `[motion] this CSS animates layout properties (${motion.join('; ')}). Layout transitions reflow the page on every animation frame and make the site lag. Animate compositor-friendly properties instead — transform, opacity — or color/filters; e.g. "transition: opacity 200ms" rather than "transition: width 2s". Never use "transition: all" (it silently includes layout properties).`,
      confidence: 0.1,
      costMs: 0,
    };
  }

  // T3 reduced-motion respect: a sheet that declares motion gets a mechanical
  // wrap neutralising OUR motion under prefers-reduced-motion (same selectors,
  // no design decision — the box-sizing of motion). Appended to the raw CSS so
  // it travels through the same sanitize/parse/emit path.
  const motionSelectors = allSelectors(filteredItems).filter((sel) => {
    // A selector needs the wrap only if one of ITS rules declared motion.
    return filteredItems.some((it) => it.kind === 'style' && it.declarations.some((d) => /^(transition|animation)/.test(d.property.toLowerCase())) && it.selector.split(',').some((p) => p.trim() === sel));
  });
  if (motionSelectors.length > 0) {
    css = css + '\n' + buildReducedMotionCss(motionSelectors);
  }

  // B/C: emit normal first, measure, re-emit important only if not applied.
  // T5: applyCss carries typography visual truth (the rendered-text sample) —
  // hide's result shape is unchanged.
  const { css: insertedCss, assert, perSelector, textEffect, visualEffect, error } = await emitAndInsert(css, false, true);
  if (error) return { ok: false, error };
  if (!insertedCss) return { ok: false, error: 'No CSS after sanitization and parsing.' };

  // F4: persisted identity digest of the primary target element (style-agnostic
  // — a display:none / recoloured element still verifies on replay). The act
  // verified EVERY selector above; the primary is the one replay re-verifies
  // for wrong-target detection. null if the sheet had no single targetable
  // selector (e.g. pure at-rules) — replay then falls back to unverified.
  const primarySel = primaryTarget(filteredItems);
  let identityDigest: string | undefined;
  if (primarySel) {
    const el = document.querySelector(primarySel.selector);
    if (el) identityDigest = await digestOfElement(el, liveIdentityDom as IdentityDom);
  }

  return {
    ok: true,
    result: { chars: insertedCss.length, css: insertedCss, applied: assert?.applied ?? null, before: assert?.before, after: assert?.after, matched: assert?.matched ?? null, perSelector, textEffect, visualEffect, selectorReport, unverified },
    identityDigest,
    inverse: { kind: 'removeCss', css: insertedCss },
    confidence: unverified ? 0.45 : undefined,
    costMs: 0,
  };
}

// ── hide — display:none via CSS, default important ─────────────────

async function hide(args: any): Promise<ToolResult> {
  const selector = args?.selector as string;
  if (!selector) return { ok: false, error: 'missing "selector" argument. Call describePage or findElements to get a selector, then pass it here.' };

  // F1: verify identity before the hide. hide already refused zero/over-broad;
  // add the wrong-target guard so a selector that now points to a different
  // element is refused, not hidden. A verified unique target only.
  const g = guardTarget(selector);
  if (!g.ok) return g.result;
  const unverified = g.unverified;

  try {
    const els = document.querySelectorAll(selector);
    if (els.length === 0) return { ok: false, error: `selector "${selector}" matched nothing — call describePage or findElements to find the right element` };
    if (els.length > 200) return { ok: false, error: `selector "${selector}" matched ${els.length} elements — too broad. Refine your selector to target fewer elements.` };
  } catch { return { ok: false, error: `invalid selector "${selector}" — check syntax and call describePage to see available regions` }; }

  const hideCss = `${selector} { display: none }`;

  // F5: always heal — a removal that leaves a hole is an unfinished job.
  const hiddenEls = Array.from(document.querySelectorAll(selector));
  const healResult = applyHealing([selector], hiddenEls);
  const rawFullCss = healResult.css.trim() ? hideCss + '\n' + healResult.css : hideCss;

  // F1: guard EVERY selector the emitted sheet will match, not just the primary.
  // applyHealing builds parent/sibling selectors via buildStableSelector (heal.ts
  // steps 2–6), which are positional (nth-of-type) when the sibling has no anchor
  // of its own — a page reorder of identical twins then reroutes that positional
  // healing selector onto the wrong twin via the cascade (the indistinguishable-
  // twin attack F1 refuses for the primary). Guarding only the primary selector
  // (line 269) leaves the healing selectors unguarded — the gap applyCss already
  // closes via its allSelectors loop. Mirror that here: parse the full sheet,
  // guard each style rule's selectors, and DROP any healing rule whose selector
  // refuses (fail-closed — refuse to emit it unguarded) rather than refusing the
  // whole hide (the primary target is already verified; losing cosmetic healing
  // is preferable to a wrong-twin mutation, and preferable to blocking the hide).
  const healedItems = parseCss((sanitizeCss(rawFullCss).css));
  const guardedItems: EmitItem[] = [];
  for (const item of healedItems) {
    if (item.kind !== 'style' || item.declarations.length === 0) { guardedItems.push(item); continue; }
    // Keep the rule only if EVERY one of its selectors verifies. Split the comma
    // list; if any part refuses, drop the whole rule (healing rules are
    // single-selector, so this is exact — no partial-comma heal rules exist).
    let allOk = true;
    for (const sel of item.selector.split(',')) {
      const s = sel.trim();
      if (!s) continue;
      const hg = guardTarget(s);
      if (!hg.ok) { allOk = false; break; }
    }
    if (allOk) guardedItems.push(item);
  }
  const guardedCss = serializeEmit(guardedItems);
  // ponytail: fall back to the bare hide rule if every healing rule was dropped
  // and the sheet ended up empty (the hide rule itself always survives — it was
  // guarded at line 269 — so this branch is defensive, not reachable in practice).
  const fullCss = guardedCss.trim() ? guardedCss : hideCss;

  // B/C: hide defaults to important.
  const { css: insertedCss, assert, error } = await emitAndInsert(fullCss, true);
  if (error) return { ok: false, error };
  if (!insertedCss) return { ok: false, error: 'No CSS after sanitization and parsing.' };

  // F4: persisted identity digest of the hidden element (style-agnostic — a
  // display:none element still verifies on replay). guardTarget already
  // verified `selector`; the digest lets replay re-verify the SAME element.
  let identityDigest: string | undefined;
  const hiddenEl = document.querySelector(selector);
  if (hiddenEl) identityDigest = await digestOfElement(hiddenEl, liveIdentityDom as IdentityDom);

  return {
    ok: true,
    result: { chars: insertedCss.length, css: insertedCss, healed: healResult.steps, applied: assert?.applied ?? null, before: assert?.before, after: assert?.after, matched: assert?.matched ?? null, unverified },
    identityDigest,
    inverse: { kind: 'removeCss', css: insertedCss },
    confidence: unverified ? 0.45 : undefined,
    costMs: 0,
  };
}

// ── setText — DOM mutation, requires a reason ──────────────────────

const TEXT_MUTATION_REASONS = new Set(['summarise', 'summarize', 'rewrite', 'translate', 'annotate', 'explain', 'replace-content']);

function hasMarkdown(text: string): boolean {
  if (/^#{1,6}\s/m.test(text)) return true;
  if (/\*\*[^*]+\*\*/.test(text)) return true;
  if (/`[^`]+`/.test(text)) return true;
  if (/^\s*[-*]\s/m.test(text)) return true;
  if (/\[.+?\]\(.+?\)/.test(text)) return true;
  return false;
}

async function setText(args: any): Promise<ToolResult> {
  const selector = args?.selector as string;
  const text = args?.text as string;
  const reason = args?.reason as string;

  if (!selector) return { ok: false, error: 'missing "selector" argument. Call describePage or findElements to get a selector, then pass it here.' };
  if (!text) return { ok: false, error: 'missing "text" argument. Provide the new text as a plain string.' };
  if (!reason || !TEXT_MUTATION_REASONS.has(reason.toLowerCase())) {
    return { ok: false, error: `mutation refused: no valid reason. Provide one of: ${[...TEXT_MUTATION_REASONS].join(', ')}. The reason declares why this is a DOM mutation, not CSS.` };
  }

  // F1: re-resolve + verify identity before the mutation. setText is a DOM
  // mutation (textContent), so a wrong target is irreversible without the clone.
  const g = guardTarget(selector);
  if (!g.ok) return g.result;
  const el = g.el;
  const unverified = g.unverified;

  if (el.children.length > 0) {
    return { ok: false, error: `target has ${el.children.length} element children — replacing them would destroy the layout. Use insert instead to add content alongside the existing structure.` };
  }

  if (hasMarkdown(text)) {
    return { ok: false, error: 'plain text only — markdown syntax is rejected. Use insert for formatted content.' };
  }

  const prevHtml = el.innerHTML;
  // F4: capture the persisted identity digest of the PRE-mutation element so a
  // reload/SPA-render can re-verify this is the same element before re-applying.
  // REPLAY finds the element as reload left it — the ORIGINAL (pre-mutation)
  // text — so the digest must describe the pre-mutation state, NOT the post-
  // mutation one. (The undo re-verify path is separate: it uses the session
  // `actFp` captured post-mutation below, NOT this persisted digest. The two
  // checks have opposite timing needs and use different values — this digest is
  // for replay, actFp is for undo.) Must digest the LIVE ATTACHED element (not
  // the clone): the fingerprint includes depthFromRoot, which is 0 for a
  // detached clone but correct for the live element — replay re-resolves the
  // live element, so the digest must match the live geometry. Style-agnostic so
  // a hidden element still verifies. Only the SHA-256 hex is persisted. See
  // digest.ts.
  const identityDigest = await digestOfElement(el, liveIdentityDom as IdentityDom);

  // F3: capture a CLONED subtree BEFORE the textContent mutation. The in-session
  // exact inverse is replaceWith(clone) (handled by the content-script
  // TransactionLog's undoAll). The serializable restoreText below is the
  // POST-RELOAD fallback only (where the clone is gone — innerHTML re-parse is
  // the best available, a documented degradation; never used in-session).
  const clone = el.cloneNode(true);
  el.textContent = text;
  // F1: capture the act-time fingerprint AFTER the mutation. The undo verify
  // compares this to the element's fingerprint AT UNDO TIME — which is the
  // post-mutation state (the element still holds `text` until the clone restores
  // it). So the fp must be the post-mutation state, not the pre-mutation one
  // (a pre-mutation fp would never match at undo → every setText undo would
  // refuse). The verify confirms the element at the selector is STILL the one we
  // mutated (structure unchanged) before replaceWith(clone) — the RC6-class fix.
  const actFp = actFingerprint(el);
  recordStructural({ kind: 'setText', target: selector, inverse: { kind: 'setText', clone, selector, fingerprint: actFp } });

  await new Promise<void>((r) => requestAnimationFrame(() => r()));

  return {
    ok: true,
    result: { selector, textLength: text.length, reason, applied: true, before: prevHtml.slice(0, 50), after: text.slice(0, 50), matched: 1, unverified },
    identityDigest,
    inverse: { kind: 'restoreText', selector, prevHtml },
    confidence: unverified ? 0.45 : undefined,
    costMs: 0,
  };
}

// ── insert — add HTML at a position relative to a selector ─────────

function deriveContainerStyle(anchor: HTMLElement): string {
  const bodyStyle = getComputedStyle(document.body);
  const anchorStyle = getComputedStyle(anchor);

  const baseFont = parseFloat(bodyStyle.fontSize) || 16;
  const headingSize = `${Math.round(baseFont * 1.15)}px`;

  const textColor = bodyStyle.color || '#333';
  let bgEl: Element | null = anchor;
  let bgColor = '';
  while (bgEl && !bgColor) {
    const s = getComputedStyle(bgEl);
    bgColor = s.backgroundColor;
    if (!bgColor || bgColor === 'rgba(0, 0, 0, 0)') bgColor = '';
    if (!bgColor) bgEl = bgEl.parentElement;
  }
  bgColor = bgColor || '#ffffff';

  const tint = mixColors(bgColor, textColor, 0.04);
  const borderColor = mixColors(bgColor, textColor, 0.15);

  return [
    `display: block`,
    `margin: ${Math.round(baseFont * 0.75)}px 0`,
    `padding: ${Math.round(baseFont * 0.75)}px ${Math.round(baseFont)}px`,
    `border: 1px solid ${borderColor}`,
    `border-radius: ${Math.round(baseFont * 0.25)}px`,
    `background: ${tint}`,
    `color: ${textColor}`,
    `font-size: ${headingSize}`,
    `line-height: 1.5`,
  ].join('; ');
}

function mixColors(bg: string, fg: string, ratio: number): string {
  const bgRgb = parseRgb(bg);
  const fgRgb = parseRgb(fg);
  if (!bgRgb || !fgRgb) return bg;
  const r = Math.round(bgRgb[0] + (fgRgb[0] - bgRgb[0]) * ratio);
  const g = Math.round(bgRgb[1] + (fgRgb[1] - bgRgb[1]) * ratio);
  const b = Math.round(bgRgb[2] + (fgRgb[2] - bgRgb[2]) * ratio);
  return `rgb(${r}, ${g}, ${b})`;
}

function parseRgb(color: string): [number, number, number] | null {
  const hex = color.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (hex) return [parseInt(hex[1], 16), parseInt(hex[2], 16), parseInt(hex[3], 16)];
  const rgb = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (rgb) return [parseInt(rgb[1]), parseInt(rgb[2]), parseInt(rgb[3])];
  return null;
}

function sanitizeHtml(html: string): string {
  let r = html;
  r = r.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  r = r.replace(/\son\w+\s*=\s*"[^"]*"/gi, '');
  r = r.replace(/\son\w+\s*=\s*'[^']*'/gi, '');
  r = r.replace(/\son\w+\s*=\s*[^\s>]+/gi, '');
  r = r.replace(/javascript:/gi, '');
  r = r.replace(/<\/?(iframe|embed|object|script)[^>]*>/gi, '');
  return r.trim();
}

async function insert(args: any): Promise<ToolResult> {
  const selector = args?.selector as string;
  const html = args?.html as string;
  const where = (args?.where as string) || 'top';

  if (!selector) return { ok: false, error: 'missing "selector" argument. Call describePage or findElements to get a selector, then pass it here.' };
  if (!html?.trim()) return { ok: false, error: 'missing "html" argument. Provide HTML content to insert as a string.' };

  // F1: re-resolve + verify identity before the insert. insert targets an anchor
  // element by selector; a wrong anchor puts the inserted node in the wrong place.
  const g = guardTarget(selector);
  if (!g.ok) return g.result;
  const el = g.el;
  const unverified = g.unverified;

  const sanitized = sanitizeHtml(html);
  if (!sanitized.trim()) return { ok: false, error: 'HTML was entirely rejected by sanitizer. Remove script tags, event handlers, and javascript: URLs from your HTML.' };

  const containerStyle = deriveContainerStyle(el);
  const marked = `<div data-revueon-inserted="true" style="${containerStyle}">${sanitized}</div>`;

  const positions: Record<string, InsertPosition> = {
    top: 'afterbegin', bottom: 'beforeend',
    before: 'beforebegin', after: 'afterend',
  };
  const pos = positions[where];
  if (!pos) return { ok: false, error: `invalid "where": must be top, bottom, before, or after` };

  const isInside = where === 'top' || where === 'bottom';
  const prevHtml = isInside ? el.innerHTML : (el.parentElement?.innerHTML ?? '');

  // F4: persisted identity digest of the ANCHOR, captured BEFORE the insert —
  // for an INSIDE insert (top/bottom) the inserted node becomes a CHILD of the
  // anchor, changing its childCount (part of the fingerprint). Reload restores
  // the anchor WITHOUT the inserted child, so replay must compare against the
  // PRE-insert anchor digest (same timing rule as setText's pre-mutation
  // digest). For OUTSIDE inserts (before/after) the anchor is unchanged, so
  // pre/post would match — but pre is uniformly correct. Style-agnostic.
  const identityDigest = await digestOfElement(el, liveIdentityDom as IdentityDom);

  // F1 fix: the old code re-found the inserted node by the GENERIC marker
  // document.querySelector('[data-revueon-inserted="true"]') — a collision
  // (two inserts in one turn, or a prior marker not cleaned) attached the
  // inverse to the WRONG node. Build the node, insert it, and keep a DIRECT
  // reference (insertAdjacentElement returns the node; insertAdjacentHTML does
  // not, so we create a container and append the parsed content into it).
  const container = document.createElement('div');
  container.innerHTML = marked;
  const insertedNode = container.firstElementChild as HTMLElement | null;
  if (!insertedNode) return { ok: false, error: 'inserted content produced no element node' };
  el.insertAdjacentElement(pos, insertedNode);

  await new Promise<void>((r) => requestAnimationFrame(() => r()));

  // C: assertApplied for insert — the node is present and displayed. We hold a
  // direct ref, so no generic-marker re-query (no collision).
  const after = getComputedStyle(insertedNode).display;
  const applied = after !== 'none';

  // F3: record an exact in-session inverse — the inserted node itself (direct
  // ref, the F1 fix). undoAll removes it (no innerHTML re-parse). The
  // serializable restoreHtml below is the post-reload fallback only.
  recordStructural({ kind: 'insert', target: selector, inverse: { kind: 'insert', node: insertedNode } });

  return {
    ok: true,
    result: { selector, where, chars: marked.length, applied, before: '', after, matched: 1, unverified },
    identityDigest,
    inverse: { kind: 'restoreHtml', selector, prevHtml, isInside },
    confidence: unverified ? 0.45 : undefined,
    costMs: 0,
  };
}

// ── heal — close the gap from a hidden element ─────────────────────

async function heal(args: any): Promise<ToolResult> {
  const selectors = args?.selectors as string[];
  if (!selectors?.length) return { ok: false, error: 'missing "selectors" argument (array of CSS selectors). Pass the selector of the hidden element(s) so healing can close the gap they left.' };

  // F1: verify each healed selector is the intended (now-hidden) target. heal is
  // a follow-up to a prior hide on a verified target; re-verify so a stale
  // selector that now resolves to a different element is not healed. The
  // fingerprint is style-agnostic, so a display:none element still verifies —
  // being hidden does not change identity.
  let anyUnverified = false;
  for (const s of selectors) {
    const g = guardTarget(s);
    if (!g.ok) return g.result;
    if (g.unverified) anyUnverified = true;
  }

  const hiddenEls: Element[] = [];
  for (const s of selectors) {
    try { hiddenEls.push(...Array.from(document.querySelectorAll(s))); } catch { /* skip invalid */ }
  }
  if (!hiddenEls.length) return { ok: false, error: 'no elements found for given selectors' };

  const result = applyHealing(selectors, hiddenEls);
  if (!result.css.trim()) {
    return { ok: true, result: { steps: result.steps, cssChars: 0, applied: null, unverified: anyUnverified }, confidence: anyUnverified ? 0.45 : 0.6, costMs: 0 };
  }

  // B/C: heal emits normal first.
  const { css: insertedCss, assert, error } = await emitAndInsert(result.css, false);
  if (error) return { ok: false, error };
  if (!insertedCss) return { ok: false, error: 'No CSS after sanitization and parsing.' };

  // F4: persisted identity digest of the (now-hidden) healed target. heal is a
  // follow-up to a hide; the primary healed selector's element is what replay
  // re-verifies. Style-agnostic (hidden elements still verify).
  let identityDigest: string | undefined;
  if (selectors[0]) {
    const el = document.querySelector(selectors[0]);
    if (el) identityDigest = await digestOfElement(el, liveIdentityDom as IdentityDom);
  }

  return {
    ok: true,
    result: { steps: result.steps, chars: insertedCss.length, css: insertedCss, applied: assert?.applied ?? null, before: assert?.before, after: assert?.after, matched: assert?.matched ?? null, unverified: anyUnverified },
    identityDigest,
    inverse: { kind: 'removeCss', css: insertedCss },
    confidence: anyUnverified ? 0.45 : 0.7,
    costMs: 0,
  };
}

// ── stubs ─────────────────────────────────────────────────────────

function notImplemented(name: string): Promise<ToolResult> {
  return Promise.resolve({ ok: false, error: `${name} is not implemented in Stage 0.5. Available act tools: applyCss, hide, setText, insert, heal.` });
}

// ── exports ────────────────────────────────────────────────────────

export const actTools: ToolDef[] = [
  { name: 'applyCss', kind: 'act', description: 'apply CSS to the page (user-origin stylesheet)',
    args: { css: 'string' }, execute: applyCss },
  { name: 'hide', kind: 'act', description: 'hide an element and heal the gap (display:none + reflow)',
    args: { selector: 'string' }, execute: hide },
  { name: 'setText', kind: 'act', description: 'replace text in a text-only element (no element children, plain text, needs reason)',
    args: { selector: 'string', text: 'string', reason: 'string' }, execute: setText },
  { name: 'insert', kind: 'act', description: 'insert HTML at a position (top/bottom/before/after) relative to a selector',
    args: { selector: 'string', html: 'string', where: 'string' }, execute: insert },
  { name: 'heal', kind: 'act', description: 'close the layout gap from a hidden element',
    args: { selectors: 'string[]' }, execute: heal },
  { name: 'bindKey', kind: 'act', description: 'bind a keyboard shortcut',
    args: { key: 'string', action: 'string' }, execute: () => notImplemented('bindKey'), stub: true },
  { name: 'recomposePage', kind: 'act', description: 'whole-page structural recomposition (never default)',
    args: { goal: 'string' }, execute: () => notImplemented('recomposePage'), stub: true },
];

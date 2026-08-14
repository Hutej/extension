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
import { parseCss, serializeEmit, primaryTarget, allSelectors, type EmitItem } from '../core/emit';
import { recordStructural } from '../core/ops/recorder';
import { resolveTarget, fingerprint, type IdentityDom } from '../core/identity';
import { liveIdentityDom } from '../core/identity-dom';
import { getIdentity } from '../core/identity-store';

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

/** C: emit normal first, measure, re-emit important only if the computed
 *  value did not move. For hide, default to important. Returns the exact
 *  CSS string inserted and the assertApplied result. */
async function emitAndInsert(
  rawCss: string,
  defaultImportant: boolean,
): Promise<{ css: string; assert: AssertResult | null; error?: string }> {
  const { css: sanitized } = sanitizeCss(rawCss);
  if (!sanitized.trim()) return { css: '', assert: null, error: 'CSS was entirely rejected by sanitizer.' };

  const items = parseCss(sanitized);
  if (!items.length) return { css: '', assert: null, error: 'No valid CSS rules after parsing.' };

  const target = primaryTarget(items);

  // Phase 1: emit at the specified importance level.
  const cssPhase = serializeEmit(defaultImportant
    ? items.map(i => i.kind === 'style' ? { ...i, important: true } : i)
    : items,
  );

  if (target) {
    const before = readComputed(target.selector, target.properties);
    const insRes = await sendInsertCSS(cssPhase);
    if (!insRes.ok) return { css: cssPhase, assert: null, error: insRes.error };
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    const result = await assertApplied(target.selector, target.properties, before);

    if (result.applied) return { css: cssPhase, assert: result };

    // Phase 2: not applied — try with !important (if we didn't already).
    if (!defaultImportant) {
      // Adversarial review (wf_e3e50d92, skeptic claim_3): the return of
      // sendRemoveCSS was IGNORERED. If it silently fails, BOTH the normal and
      // the !important sheets would be applied, but the inverse records only
      // the !important sheet — so a later removeCSS(inverse) would leave the
      // normal sheet permanently on the page (a silent reversal leak). Fix:
      // check the removal; if it failed, do NOT proceed to the !important
      // insert (return an error so the loop rolls back the normal sheet it
      // DID insert — a clean, single-sheet failure, not a split-brain one).
      const rmRes = await sendRemoveCSS(cssPhase);
      if (!rmRes.ok) return { css: cssPhase, assert: result, error: `failed to remove the normal sheet before re-emitting !important: ${rmRes.error || 'unknown'}` };
      const cssImportant = serializeEmit(items.map(i => i.kind === 'style' ? { ...i, important: true } : i));
      const before2 = readComputed(target.selector, target.properties);
      const insRes2 = await sendInsertCSS(cssImportant);
      if (!insRes2.ok) return { css: cssImportant, assert: null, error: insRes2.error };
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      const result2 = await assertApplied(target.selector, target.properties, before2);
      return { css: cssImportant, assert: result2 };
    }
    return { css: cssPhase, assert: result };
  }

  // No targetable selector — insert without measurement.
  const insRes = await sendInsertCSS(cssPhase);
  if (!insRes.ok) return { css: cssPhase, assert: null, error: insRes.error };
  await new Promise<void>((r) => requestAnimationFrame(() => r()));
  return { css: cssPhase, assert: null };
}

// ── applyCss — the primary action ──────────────────────────────────

async function applyCss(args: any): Promise<ToolResult> {
  const css = args?.css as string;
  if (!css || !css.trim()) return { ok: false, error: 'missing or empty "css" argument. Provide valid CSS rules as a string.' };

  // F1: verify EVERY selector the emitted CSS will match BEFORE emitting.
  // applyCss targets the cascade (the sheet hits every matching element of every
  // rule), so a CSS block hides/moves not just its primary selector but every
  // secondary selector too. Guarding only primaryTarget (the first rule's first
  // comma-part) leaves the others unguarded — a model could verify `.a` and hide
  // `.b` in the same sheet with no identity check on `.b`. Iterate allSelectors
  // (every style rule's every comma-part, recursing into at-rules) and refuse the
  // whole act if any selector fails the identity check (zero/many/wrong-target),
  // naming which selector failed. A unique-but-unverified selector (model-named,
  // no observe-time fingerprint) is NOT a failure — it mutates flagged unverified
  // (the design decision locked by tests/f1-identity-test.ts); we only lower
  // confidence when ANY selector is unverified.
  const items = parseCss((sanitizeCss(css).css));
  const selectors = allSelectors(items);
  let unverified = false;
  for (const sel of selectors) {
    const g = guardTarget(sel);
    if (!g.ok) {
      // Append which CSS selector failed, so the model can fix it.
      return { ok: false, error: `[F1 identity] ${g.result.error} (in CSS selector "${sel}")`, confidence: 0.1, costMs: 0 };
    }
    if (g.unverified) unverified = true;
  }

  // B/C: emit normal first, measure, re-emit important only if not applied.
  const { css: insertedCss, assert, error } = await emitAndInsert(css, false);
  if (error) return { ok: false, error };
  if (!insertedCss) return { ok: false, error: 'No CSS after sanitization and parsing.' };

  return {
    ok: true,
    result: { chars: insertedCss.length, css: insertedCss, applied: assert?.applied ?? null, before: assert?.before, after: assert?.after, matched: assert?.matched ?? null, unverified },
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
  const fullCss = healResult.css.trim() ? hideCss + '\n' + healResult.css : hideCss;

  // B/C: hide defaults to important.
  const { css: insertedCss, assert, error } = await emitAndInsert(fullCss, true);
  if (error) return { ok: false, error };
  if (!insertedCss) return { ok: false, error: 'No CSS after sanitization and parsing.' };

  return {
    ok: true,
    result: { chars: insertedCss.length, css: insertedCss, healed: healResult.steps, applied: assert?.applied ?? null, before: assert?.before, after: assert?.after, matched: assert?.matched ?? null, unverified },
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

  return {
    ok: true,
    result: { steps: result.steps, chars: insertedCss.length, css: insertedCss, applied: assert?.applied ?? null, before: assert?.before, after: assert?.after, matched: assert?.matched ?? null, unverified: anyUnverified },
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

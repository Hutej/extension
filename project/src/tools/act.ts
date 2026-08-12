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
import { parseCss, serializeEmit, primaryTarget, type EmitItem } from '../core/emit';
import { recordStructural } from '../core/ops/recorder';

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

function readComputed(selector: string, properties: string[]): string {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) return '';
  const cs = getComputedStyle(el);
  return properties.map((p) => cs.getPropertyValue(p)).join('|');
}

function assertApplied(selector: string, properties: string[], before: string): {
  applied: boolean; before: string; after: string; matched: number;
} {
  const els = document.querySelectorAll(selector);
  const matched = els.length;
  if (matched === 0) return { applied: false, before, after: '', matched: 0 };
  const cs = getComputedStyle(els[0] as HTMLElement);
  const after = properties.map((p) => cs.getPropertyValue(p)).join('|');
  // applied = ANY declared property moved (before !== after) and is non-empty.
  // 'after' is the joined longhand string; a single property changing flips it.
  return { applied: after !== before && after !== '', before, after, matched };
}

// ── Core: emit, insert, assert, re-emit important if needed ────────

/** C: emit normal first, measure, re-emit important only if the computed
 *  value did not move. For hide, default to important. Returns the exact
 *  CSS string inserted and the assertApplied result. */
async function emitAndInsert(
  rawCss: string,
  defaultImportant: boolean,
): Promise<{ css: string; assert: ReturnType<typeof assertApplied> | null; error?: string }> {
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
    const result = assertApplied(target.selector, target.properties, before);

    if (result.applied) return { css: cssPhase, assert: result };

    // Phase 2: not applied — try with !important (if we didn't already).
    if (!defaultImportant) {
      await sendRemoveCSS(cssPhase);
      const cssImportant = serializeEmit(items.map(i => i.kind === 'style' ? { ...i, important: true } : i));
      const before2 = readComputed(target.selector, target.properties);
      const insRes2 = await sendInsertCSS(cssImportant);
      if (!insRes2.ok) return { css: cssImportant, assert: null, error: insRes2.error };
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      const result2 = assertApplied(target.selector, target.properties, before2);
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

  // B/C: emit normal first, measure, re-emit important only if not applied.
  const { css: insertedCss, assert, error } = await emitAndInsert(css, false);
  if (error) return { ok: false, error };
  if (!insertedCss) return { ok: false, error: 'No CSS after sanitization and parsing.' };

  return {
    ok: true,
    result: { chars: insertedCss.length, css: insertedCss, applied: assert?.applied ?? null, before: assert?.before, after: assert?.after, matched: assert?.matched ?? null },
    inverse: { kind: 'removeCss', css: insertedCss },
    costMs: 0,
  };
}

// ── hide — display:none via CSS, default important ─────────────────

async function hide(args: any): Promise<ToolResult> {
  const selector = args?.selector as string;
  if (!selector) return { ok: false, error: 'missing "selector" argument. Call describePage or findElements to get a selector, then pass it here.' };

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
    result: { chars: insertedCss.length, css: insertedCss, healed: healResult.steps, applied: assert?.applied ?? null, before: assert?.before, after: assert?.after, matched: assert?.matched ?? null },
    inverse: { kind: 'removeCss', css: insertedCss },
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

  const el = document.querySelector<HTMLElement>(selector);
  if (!el) return { ok: false, error: `selector "${selector}" did not resolve` };

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
  recordStructural({ kind: 'setText', target: selector, inverse: { kind: 'setText', clone, selector } });

  await new Promise<void>((r) => requestAnimationFrame(() => r()));

  return {
    ok: true,
    result: { selector, textLength: text.length, reason, applied: true, before: prevHtml.slice(0, 50), after: text.slice(0, 50), matched: 1 },
    inverse: { kind: 'restoreText', selector, prevHtml },
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

  const el = document.querySelector<HTMLElement>(selector);
  if (!el) return { ok: false, error: `selector "${selector}" did not resolve` };

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

  el.insertAdjacentHTML(pos, marked);

  await new Promise<void>((r) => requestAnimationFrame(() => r()));

  // C: assertApplied for insert — check that the element now has content.
  const insertedEl = document.querySelector('[data-revueon-inserted="true"]');
  const after = insertedEl ? getComputedStyle(insertedEl as HTMLElement).display : '';
  const applied = insertedEl !== null && after !== 'none';

  // F3: record an exact in-session inverse — the inserted node itself. undoAll
  // removes it (no innerHTML re-parse). The serializable restoreHtml below is
  // the post-reload fallback only (the inserted node is gone after reload).
  if (insertedEl) {
    recordStructural({ kind: 'insert', target: selector, inverse: { kind: 'insert', node: insertedEl } });
  }

  return {
    ok: true,
    result: { selector, where, chars: marked.length, applied, before: '', after, matched: insertedEl ? 1 : 0 },
    inverse: { kind: 'restoreHtml', selector, prevHtml, isInside },
    costMs: 0,
  };
}

// ── heal — close the gap from a hidden element ─────────────────────

async function heal(args: any): Promise<ToolResult> {
  const selectors = args?.selectors as string[];
  if (!selectors?.length) return { ok: false, error: 'missing "selectors" argument (array of CSS selectors). Pass the selector of the hidden element(s) so healing can close the gap they left.' };

  const hiddenEls: Element[] = [];
  for (const s of selectors) {
    try { hiddenEls.push(...Array.from(document.querySelectorAll(s))); } catch { /* skip invalid */ }
  }
  if (!hiddenEls.length) return { ok: false, error: 'no elements found for given selectors' };

  const result = applyHealing(selectors, hiddenEls);
  if (!result.css.trim()) {
    return { ok: true, result: { steps: result.steps, cssChars: 0, applied: null }, confidence: 0.6, costMs: 0 };
  }

  // B/C: heal emits normal first.
  const { css: insertedCss, assert, error } = await emitAndInsert(result.css, false);
  if (error) return { ok: false, error };
  if (!insertedCss) return { ok: false, error: 'No CSS after sanitization and parsing.' };

  return {
    ok: true,
    result: { steps: result.steps, chars: insertedCss.length, css: insertedCss, applied: assert?.applied ?? null, before: assert?.before, after: assert?.after, matched: assert?.matched ?? null },
    inverse: { kind: 'removeCss', css: insertedCss },
    confidence: 0.7,
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

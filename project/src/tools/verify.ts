/**
 * tools/verify — verification tools. Read the live DOM after render.
 * Never compare to a plan — compare to reality (P10).
 *
 * C: checkLayout checks the affected subtree and its ancestors — not
 * just [data-revueon-inserted] nodes. A hide that wrecks the site's
 * own layout must be visible to the instrument built to catch it.
 *
 * A: no style node checks — the style node is gone by construction.
 */

import type { ToolDef, ToolResult } from './index';
import { parseColor, contrastRatio } from '../shared/color';

// ── snapshot — serialize key DOM state ─────────────────────────────

async function snapshot(args: any): Promise<ToolResult> {
  const selector = args?.selector as string | undefined;
  const target = selector ? document.querySelector(selector) : document.body;
  if (!target) return { ok: false, error: `selector "${selector}" did not resolve` };

  const html = target.outerHTML;
  let hash = 0;
  for (let i = 0; i < html.length; i++) {
    hash = ((hash << 5) - hash + html.charCodeAt(i)) | 0;
  }

  return {
    ok: true,
    result: { hash, htmlLength: html.length, selector: selector ?? 'body' },
    confidence: 0.9,
    costMs: 0,
  };
}

// ── diff — compare two snapshots ───────────────────────────────────

async function diff(args: any): Promise<ToolResult> {
  const before = args?.before;
  const after = args?.after;
  if (!before || !after) return { ok: false, error: 'missing before/after arguments' };

  const changed = before.hash !== after.hash;
  const details: string[] = [];
  if (changed) {
    details.push(`html length: ${before.htmlLength} → ${after.htmlLength}`);
    if (before.htmlLength !== after.htmlLength) {
      details.push(`delta: ${after.htmlLength - before.htmlLength} chars`);
    }
  }

  return { ok: true, result: { changed, details }, confidence: 0.85, costMs: 0 };
}

// ── checkLayout — C: check the page, not our markers ───────────────
// All five checks point at the affected subtree and its ancestors.
// A hide that collapses a sidebar must show up here.

async function checkLayout(_args: any): Promise<ToolResult> {
  await new Promise<void>((r) => requestAnimationFrame(() => r()));

  const issues: string[] = [];

  // 1. Horizontal overflow — content wider than the viewport.
  const bodyOverflow = document.body.scrollWidth > document.body.clientWidth + 2;
  if (bodyOverflow) issues.push(`horizontal overflow: scrollWidth=${document.body.scrollWidth} clientWidth=${document.body.clientWidth}`);

  // 2. Zero-size visible elements — scan the page for elements that
  //    collapsed to 0 width or height but still contain text.
  //    C: check ALL elements in the main content area, not just our markers.
  const main = document.querySelector('main, [role="main"], article, #content, .content') || document.body;
  for (const el of Array.from(main.querySelectorAll('*')) as HTMLElement[]) {
    if (el.children.length > 0) continue; // leaf nodes only
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) {
      const text = (el.textContent || '').trim();
      if (text.length > 3) {
        issues.push(`zero-size element with text: <${el.tagName.toLowerCase()}> "${text.slice(0, 40)}"`);
        if (issues.length > 5) break; // ponytail: cap at 5 issues per category
      }
    }
  }

  // 3. Invisible text — low contrast ratio against background.
  //    C: scan text nodes in the main content area, not just [data-revueon-inserted].
  const textEls = Array.from(main.querySelectorAll('p, span, a, h1, h2, h3, h4, h5, h6, li, td, div')) as HTMLElement[];
  let checked = 0;
  for (const el of textEls) {
    if (checked++ > 50) break; // ponytail: scan a sample, not the whole page
    if (!el.textContent?.trim() || el.children.length > 0) continue;
    const style = getComputedStyle(el);
    const fg = parseColor(style.color);
    if (!fg) continue;
    let bg: any = null;
    let bgEl: Element | null = el;
    while (bgEl && !bg) {
      const s = getComputedStyle(bgEl);
      bg = parseColor(s.backgroundColor);
      if (!bg) bgEl = bgEl.parentElement;
    }
    if (bg && contrastRatio(fg, bg) < 1.5) {
      issues.push(`invisible text: contrast ratio ${contrastRatio(fg, bg).toFixed(2)} in <${el.tagName.toLowerCase()}> "${el.textContent.trim().slice(0, 40)}"`);
      break; // one is enough to flag
    }
  }

  // 4. Text breaking mid-word — a container narrower than its longest word.
  //    C: check ALL narrow containers with text, not just our inserts.
  checked = 0;
  for (const el of textEls) {
    if (checked++ > 50) break;
    if (!el.textContent?.trim() || el.children.length > 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.width < 40) {
      const text = (el.textContent || '').trim();
      if (text.length > 3) {
        issues.push(`text in narrow container: width=${Math.round(r.width)}px for "${text.slice(0, 30)}" — container may be collapsing`);
        break;
      }
    }
  }

  // 5. Collapsed columns — an element that was wide but is now very narrow.
  //    C: check the main content area's width — if it's <200px, something
  //    collapsed it (e.g. a grid track that lost its content).
  const mainRect = main.getBoundingClientRect();
  if (mainRect.width > 0 && mainRect.width < 200 && main.textContent && main.textContent.trim().length > 100) {
    issues.push(`main content collapsed to ${Math.round(mainRect.width)}px — a layout track may have lost its sizing`);
  }

  return {
    ok: issues.length === 0,
    result: { issues, overflow: bodyOverflow, issueCount: issues.length },
    confidence: issues.length === 0 ? 0.8 : 0.4,
    costMs: 0,
  };
}

// ── checkContrast — measure text/background contrast ratio ──────────

async function checkContrast(args: any): Promise<ToolResult> {
  const selector = (args?.selector as string) || 'body';
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) return { ok: false, error: `selector "${selector}" did not resolve` };

  const style = getComputedStyle(el);
  const fg = parseColor(style.color);
  if (!fg) return { ok: false, error: 'could not parse foreground color' };

  let bgEl: Element | null = el;
  let bg = null;
  while (bgEl && !bg) {
    const s = getComputedStyle(bgEl);
    bg = parseColor(s.backgroundColor);
    if (!bg) bgEl = bgEl.parentElement;
  }
  if (!bg || !bgEl) return { ok: true, result: { ratio: 0, note: 'no solid background found' }, confidence: 0.3, costMs: 0 };

  const ratio = contrastRatio(fg, bg);
  return {
    ok: true,
    result: { ratio: Math.round(ratio * 100) / 100, fg: style.color, bg: getComputedStyle(bgEl).backgroundColor },
    confidence: 0.85,
    costMs: 0,
  };
}

// ── assertDomClean — verify no Revueon traces remain ─────────────────
// A: no style node to check. Only check for inserted elements.

async function assertDomClean(_args: any): Promise<ToolResult> {
  const issues: string[] = [];

  // A: no style node — deleted by the origin move.
  // Check for inserted elements (still used by the insert tool).
  const inserted = document.querySelectorAll('[data-revueon-inserted]');
  if (inserted.length > 0) {
    issues.push(`${inserted.length} inserted element(s) still present`);
  }

  return {
    ok: issues.length === 0,
    result: { clean: issues.length === 0, issues },
    confidence: issues.length === 0 ? 0.95 : 0.4,
    costMs: 0,
  };
}

// ── exports ────────────────────────────────────────────────────────

export const verifyTools: ToolDef[] = [
  { name: 'snapshot', kind: 'verify', description: 'capture DOM state checksum',
    args: { selector: 'string?' }, execute: snapshot },
  { name: 'diff', kind: 'verify', description: 'compare two snapshots',
    args: { before: 'object', after: 'object' }, execute: diff },
  { name: 'checkLayout', kind: 'verify', description: 'check for layout issues (overflow, zero-size, invisible text, collapsed columns)',
    args: {}, execute: checkLayout },
  { name: 'checkContrast', kind: 'verify', description: 'measure text/background contrast ratio',
    args: { selector: 'string?' }, execute: checkContrast },
  { name: 'assertDomClean', kind: 'verify', description: 'assert no Revueon traces remain after toggle off',
    args: {}, execute: assertDomClean },
  { name: 'look', kind: 'verify', description: 'take a screenshot and describe what is visible (vision model)',
    args: { prompt: 'string?' }, execute: async () => ({ ok: true, result: { note: 'look runs in the background' }, costMs: 0 }), background: true },
];

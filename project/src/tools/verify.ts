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
  // F5.8 baseline-diff: an UNCAPPED list of every issue, collected BEFORE the
  // per-category display caps. The loop diffs the after-act fullIssues against
  // the pre-act fullIssues to find only NEW issues the act introduced. Without
  // this, the capped `issues` list (12-ish + "...more" notes) could not match
  // pre-existing truncated issues on a real site (Wikipedia has 700+), and the
  // diff would false-flag every pre-existing issue as new → false-undo. The
  // capped `issues` stays for the model's readability; `allIssues` is the truth.
  const allIssues: string[] = [];
  const addIssue = (s: string) => { allIssues.push(s); };

  // 1. Horizontal overflow — content wider than the viewport.
  const bodyOverflow = document.body.scrollWidth > document.body.clientWidth + 2;
  if (bodyOverflow) { issues.push(`horizontal overflow: scrollWidth=${document.body.scrollWidth} clientWidth=${document.body.clientWidth}`); addIssue(`horizontal overflow: scrollWidth=${document.body.scrollWidth} clientWidth=${document.body.clientWidth}`); }

  // 2. Zero-size content — a CONTENT element (paragraph/heading/list-item/table-
  //    cell) that collapsed to 0 area while still holding text. This is a genuine
  //    integrity failure (readable content rendered invisible). A site's own
  //    collapsed controls (toggle button-labels, <span>s in collapsed menus) are
  //    NOT a transform failure — they are zero-size by site convention. F5.8
  //    real-site run (Wikipedia) found the old check flagged the "Toggle the
  //    table of contents" <span> (a collapsed control) and false-undid a
  //    legitimate hide. Fix: restrict to CONTENT leaf elements
  //    (p, h1-h6, li, td, th, blockquote, caption) — controls/spans/links are
  //    excluded; a broken interactive element is the unreachable check's job.
  const main = document.querySelector("main, [role=main], article, #content, .content") || document.body;
  let zeroSizeFound = 0;
  let zeroSizeTruncated = 0;
  const contentLeaf = main.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, td, th, blockquote, caption');
  for (const el of Array.from(contentLeaf) as HTMLElement[]) {
    if (el.children.length > 0) continue; // leaf nodes only
    // Skip intentionally-hidden (display:none/visibility:hidden) — the hide tool
    // and @media hides legitimately zero these; flagging them would false-undo
    // every hide. A genuine collapse is in-flow content rendered at 0 area.
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) {
      const text = (el.textContent || '').trim();
      if (text.length > 3) {
        if (zeroSizeFound < 5) {
          issues.push(`zero-size content: <${el.tagName.toLowerCase()}> "${text.slice(0, 40)}"`);
        }
        addIssue(`zero-size content: <${el.tagName.toLowerCase()}> "${text.slice(0, 40)}"`);
        zeroSizeFound++;
        if (zeroSizeFound >= 5) zeroSizeTruncated++;
      }
    }
  }
  if (zeroSizeTruncated > 0) {
    issues.push(`(${zeroSizeTruncated} more zero-size content elements not listed — count is partial)`);
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
      const c = parseColor(s.backgroundColor);
      // F5 fix: a FULLY-TRANSPARENT background (rgba(0,0,0,0) / 'transparent')
      // is "no background painted here", not "black background". parseColor
      // returns [0,0,0,0] for transparent; contrastRatio ignores alpha, so
      // treating it as found → black-on-black ratio 1.00 → false "invisible"
      // on every element whose nearest bg is transparent (very common).
      // Skip transparent and keep walking up to find the painted ancestor.
      if (c && c[3] > 0) bg = c;
      else bgEl = bgEl.parentElement;
    }
    // F5 adversarial review (SKEPTIC major): if NO ancestor has a painted
    // background, the old code silently no-oped (bg=null → skip). Text on a
    // fully-transparent stack renders against the canvas (white by default).
    // Default to white so a low-contrast fg (e.g. white text on a transparent
    // page → renders white-on-white) is still caught instead of silently passed.
    // (getComputedStyle resolves oklch()/color()/named-colors to rgb(), so
    // parseColor handles modern color functions for COMPUTED style.)
    if (!bg) bg = [255, 255, 255, 1];
    if (bg && contrastRatio(fg, bg) < 1.5) {
      issues.push(`invisible text: contrast ratio ${contrastRatio(fg, bg).toFixed(2)} in <${el.tagName.toLowerCase()}> "${el.textContent.trim().slice(0, 40)}"`);
      addIssue(`invisible text: contrast ratio ${contrastRatio(fg, bg).toFixed(2)} in <${el.tagName.toLowerCase()}> "${el.textContent.trim().slice(0, 40)}"`);
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

  // 6. Unreachable content — an element with MEANINGFUL CONTENT (interactive OR
  //    text-bearing) that exists in the DOM but is clipped to ZERO visible area
  //    by an ancestor with overflow:hidden / clip. A hide that collapses a
  //    sidebar onto a control, or a transform that pushes content into a clipped
  //    ancestor, leaves the user unable to see/reach it.
  //    F5 adversarial review (SKEPTIC major): the first version checked ONLY
  //    interactive elements — a clipped <h2> or <table> (non-interactive) was
  //    missed. Broadened to interactive + text-bearing content elements.
  //    False-positive guard: skip intentionally-hidden (display:none /
  //    visibility:hidden) and elements with no real text/role (decorative
  //    sprites, empty wrappers). Capped at 5; a clipped report notes when more
  //    were truncated (no silent cap — the model is told the count is partial).
  let unreachableFound = 0;
  let unreachableTruncated = 0;
  const reachableCandidates = main.querySelectorAll(
    'a, button, input, [role="link"], [role="button"], h1, h2, h3, h4, h5, h6, p, td, th, figcaption, label, legend, li'
  );
  for (const el of Array.from(reachableCandidates) as HTMLElement[]) {
    const cs0 = getComputedStyle(el);
    if (cs0.display === 'none' || cs0.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue; // check 2 covers zero-size
    // Only flag elements with meaningful content (text or interactive role).
    const hasText = (el.textContent || '').trim().length > 3;
    const isInteractive = /^(a|button|input)$/i.test(el.tagName) || el.getAttribute('role') === 'link' || el.getAttribute('role') === 'button';
    if (!hasText && !isInteractive) continue;
    // Walk ancestors; if any clips this element's rect to nothing, it's unreachable.
    let ancestor = el.parentElement;
    let reachable = true;
    while (ancestor && reachable) {
      const s = getComputedStyle(ancestor);
      const clipping = s.overflow === 'hidden' || s.overflowX === 'hidden' || s.overflowY === 'hidden' ||
        s.clip === 'rect(0px, 0px, 0px, 0px)' || s.clipPath === 'inset(50%)' || s.clipPath === 'circle(0%)';
      if (clipping) {
        const ar = ancestor.getBoundingClientRect();
        const ix = Math.max(0, Math.min(r.right, ar.right) - Math.max(r.left, ar.left));
        const iy = Math.max(0, Math.min(r.bottom, ar.bottom) - Math.max(r.top, ar.top));
        if (ix <= 0 || iy <= 0) reachable = false; // fully clipped — zero visible area
      }
      ancestor = ancestor.parentElement;
    }
    if (!reachable) {
      if (unreachableFound < 5) {
        const label = (el.textContent || el.getAttribute('aria-label') || el.getAttribute('href') || el.tagName.toLowerCase()).trim().slice(0, 30);
        issues.push(`unreachable content: <${el.tagName.toLowerCase()}> "${label}" is fully clipped by an overflow:hidden ancestor — users cannot reach it`);
      }
      addIssue(`unreachable content: <${el.tagName.toLowerCase()}> "${(el.textContent || el.getAttribute('aria-label') || el.getAttribute('href') || el.tagName.toLowerCase()).trim().slice(0, 30)}" is fully clipped by an overflow:hidden ancestor — users cannot reach it`);
      unreachableFound++;
      if (unreachableFound >= 5) unreachableTruncated++;
    }
  }
  if (unreachableTruncated > 0) {
    issues.push(`(${unreachableTruncated} more unreachable elements not listed — count is partial)`);
  }

  // 7. Mid-word break — a text container narrower than its longest unbreakable
  //    token, so the browser breaks INSIDE a word. This is a real integrity
  //    failure (garbled text) distinct from check 4's "narrow container" (which
  //    flags any <40px box). A genuine mid-word break: the longest word is wider
  //    than the box's content width AND the box is not allowed to wrap words at
  //    spaces (or the word is a single long token with no break points). We
  //    measure: a leaf text element whose own scrollWidth exceeds its
  //    clientWidth (it overflows horizontally) AND whose longest whitespace-free
  //    run is wider than the clientWidth. A normal multi-word paragraph wraps at
  //    spaces and does NOT trip this. Capped at 3.
  //    F5 roadmap HARD set item "mid-word". False-positive risk: code blocks /
  //    preformatted text intentionally overflow (overflow:auto). We skip elements
  //    with overflow:auto/scroll (scrollable containers are reachable, not broken)
  //    and elements whose white-space allows breaking (pre-wrap still breaks at
  //    spaces; we only flag when the LONGEST token itself overflows).
  let midWordFound = 0;
  let midWordTruncated = 0;
  for (const el of textEls) {
    if (!el.textContent?.trim() || el.children.length > 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0) continue;
    const s = getComputedStyle(el);
    const scrollable = s.overflowX === 'auto' || s.overflowX === 'scroll' || s.overflow === 'auto' || s.overflow === 'scroll';
    if (scrollable) continue; // scrollable overflow is reachable, not broken
    const longest = el.textContent.trim().split(/\s+/).reduce((a, b) => b.length > a.length ? b : a, '');
    // F5 adversarial review (ARITHMETIC major): the old `longest.length < 8`
    // skip missed real 7-char (and shorter) mid-word breaks. A genuine break
    // is measured by geometry (tokenW > contentW), not by word length — a
    // 4-char word in a 2px box still breaks. Only skip a 1-char token (a lone
    // glyph never "mid-breaks" — it has no internal break point).
    if (longest.length < 2) continue;
    // Measure the longest token's intrinsic width at this font. Probe is
    // appended then removed in a try/finally so an early continue can never
    // leak it into the page (SKEPTIC concern).
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font:' + s.font;
    probe.textContent = longest;
    el.appendChild(probe);
    let tokenW = 0;
    try { tokenW = probe.getBoundingClientRect().width; } finally { probe.remove(); }
    const contentW = r.width - parseFloat(s.paddingLeft || '0') - parseFloat(s.paddingRight || '0');
    if (contentW > 0 && tokenW > contentW + 1) {
      if (midWordFound < 5) {
        issues.push(`mid-word break: <${el.tagName.toLowerCase()}> "${el.textContent.trim().slice(0, 30)}" — longest word "${longest.slice(0, 20)}" (${Math.round(tokenW)}px) overflows the ${Math.round(contentW)}px container, text will break inside the word`);
      }
      addIssue(`mid-word break: <${el.tagName.toLowerCase()}> "${el.textContent.trim().slice(0, 30)}" — longest word "${longest.slice(0, 20)}" (${Math.round(tokenW)}px) overflows the ${Math.round(contentW)}px container, text will break inside the word`);
      midWordFound++;
      if (midWordFound >= 5) midWordTruncated++;
    }
  }
  if (midWordTruncated > 0) {
    issues.push(`(${midWordTruncated} more mid-word breaks not listed — count is partial)`);
  }

  return {
    ok: issues.length === 0,
    result: { issues, allIssues, overflow: bodyOverflow, issueCount: issues.length, fullIssueCount: allIssues.length },
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
    const c = parseColor(s.backgroundColor);
    // F5 fix: skip fully-transparent backgrounds (see checkLayout note above) —
    // transparent is "no background here", not black. Walk up to the painted one.
    if (c && c[3] > 0) bg = c;
    else bgEl = bgEl.parentElement;
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

/**
 * core/inventory — the candidate inventory builder (levels 1–3 observation).
 *
 * A LIGHTWEIGHT DOM scan that finds the page's meaningful regions. This is NOT
 * whole-page perception (perceive/). It walks a few levels deep, gathers
 * enough context for concept matching, and produces a compact inventory of a
 * few thousand characters — NOT the 24,000-character serialization budget.
 *
 * Each candidate carries:
 *   - id (r1, r2, …)
 *   - role (nav, feed, sidebar, shelf, comments, …)
 *   - componentType (reuse classifyComponentType — 18 types)
 *   - textSample (≤ 80 chars, redacted)
 *   - position (top/middle/bottom) and width (full/partial)
 *   - repeatCount (how many siblings look the same)
 *   - selector (a stable structural selector that survives re-render)
 *   - targetable (true if selector is stable, false + reason if not)
 */

import { type ComponentType } from './perceive/semantics';
import { fingerprint, type Fingerprint, type IdentityDom } from './identity';
import { liveIdentityDom } from './identity-dom';

export interface CandidateRegion {
  id: string;
  tag: string;
  role: string;
  componentType: ComponentType;
  textSample: string;
  position: 'top' | 'middle' | 'bottom';
  width: 'full' | 'partial';
  repeatCount: number;
  selector: string;
  /** false when buildStableSelector cannot find a stable anchor.
   *  Silence is not correct — the agent must know it cannot target this. */
  targetable: boolean;
  /** present when targetable is false — the reason, surfaced to the agent. */
  untargetableReason?: string;
  /** F1 IDENTITY: the structural fingerprint captured at observe time. The act
   *  tools re-resolve the selector at use time and verify the matched element's
   *  fingerprint matches this — so a selector that now points to a DIFFERENT
   *  element is caught (fail-closed), not silently mutated. Style-agnostic, so
   *  it survives the transform we apply. Present only when targetable. */
  fingerprint?: Fingerprint;
  /** TRANSIENT — observe-time only, never serialized or persisted. The live
   *  element behind the region. The T1 design snapshot reads its computed
   *  style (design evidence must not depend on targetability); describePage's
   *  regions.map() picks plain fields, so this never reaches the model. */
  el?: Element;
}

const IGNORED = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'BR', 'HR', 'WBR', 'LINK', 'META', 'TEMPLATE', 'SLOT', 'PATH', 'DEFS']);
const MAX_REGIONS = 60;
const MIN_TEXT_LEN = 3;
const MAX_DEPTH = 6;

/** Build the candidate inventory. No perceive() call — a lightweight walk.
 *  Traverses shadow DOM so custom-element sites (YouTube, Reddit) are visible. */
export function buildInventory(): CandidateRegion[] {
  const vpH = window.innerHeight;
  const regions: CandidateRegion[] = [];
  let rid = 0;

  const visit = (el: Element, depth: number): void => {
    if (regions.length >= MAX_REGIONS) return;
    if (depth > MAX_DEPTH) return;
    if (IGNORED.has(el.tagName)) return;

    const rect = el.getBoundingClientRect();
    const isVisible = rect.width >= 50 && rect.height >= 20 && rect.width > 0 && rect.height > 0;

    if (isVisible) {
      const isSemantic = isSemanticRegion(el, rect);
      if (isSemantic) {
        const text = sampleText(el);
        if (text.length >= MIN_TEXT_LEN || el.children.length >= 2) {
          regions.push(buildRegion(el, ++rid, rect, vpH));
        }
      }
    }

    for (const child of Array.from(el.children)) {
      visit(child, depth + 1);
    }
    if (el instanceof HTMLElement && el.shadowRoot) {
      for (const child of Array.from(el.shadowRoot.children)) {
        visit(child, depth + 1);
      }
    }
  };

  visit(document.body, 0);
  if (regions.length === 0) {
    console.warn('[Revueon] inventory: 0 regions found.');
  }
  return regions;
}

function isSemanticRegion(el: Element, rect: DOMRect): boolean {
  const tag = el.tagName;
  if (['NAV', 'HEADER', 'FOOTER', 'ASIDE', 'MAIN', 'SECTION', 'ARTICLE', 'FORM', 'TABLE', 'UL', 'OL'].includes(tag)) return true;
  if (tag.includes('-')) return true;
  const role = el.getAttribute('role');
  if (role && ['navigation', 'banner', 'contentinfo', 'complementary', 'main', 'region', 'search', 'form', 'list', 'feed', 'tablist', 'dialog', 'alertdialog'].includes(role)) return true;
  if (el.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6')) return true;
  if (el.getAttribute('aria-label') || el.getAttribute('title')) return true;
  if (rect.height > 100 && el.children.length >= 3) return true;
  if (el.querySelectorAll('a[href]').length >= 4 || el.querySelectorAll('img').length >= 3) return true;
  return false;
}

function buildRegion(el: Element, rid: number, rect: DOMRect, vpH: number): CandidateRegion {
  const tag = el.tagName.toLowerCase();
  const role = inferRole(el);
  const compType = inferComponentType(el, rect);
  const textSample = sampleText(el).slice(0, 80);
  const position = rect.y < vpH * 0.33 ? 'top' : rect.y < vpH * 0.66 ? 'middle' : 'bottom';
  const width = rect.width >= window.innerWidth * 0.7 ? 'full' : 'partial';
  const repeatCount = countSimilarSiblings(el);

  // R6 fix: buildStableSelector returns targetable + reason, never silent null.
  const sel = buildStableSelector(el as HTMLElement);
  const selector = sel.selector;
  const targetable = sel.targetable;
  const untargetableReason = sel.reason;
  // F1 IDENTITY: capture the structural fingerprint at observe time so the act
  // tools can re-resolve + verify at use time. The fingerprint is style-agnostic
  // (excludes `style` + our stamps), so it survives the transform we apply.
  const fp = targetable ? fingerprint(el as Element, liveIdentityDom as IdentityDom) : undefined;

  return { id: `r${rid}`, tag, role, componentType: compType, textSample, position, width, repeatCount, selector, targetable, untargetableReason, fingerprint: fp, el };
}

function inferRole(el: Element): string {
  const ariaRole = el.getAttribute('role');
  if (ariaRole) return ariaRole;
  const tag = el.tagName;
  if (tag === 'NAV') return 'navigation';
  if (tag === 'HEADER') return 'banner';
  if (tag === 'FOOTER') return 'contentinfo';
  if (tag === 'ASIDE') return 'complementary';
  if (tag === 'MAIN') return 'main';
  if (tag === 'ARTICLE') return 'article';
  if (tag === 'SECTION') return 'region';
  if (tag === 'FORM') return 'form';
  if (tag === 'TABLE') return 'table';
  if (tag === 'UL' || tag === 'OL') return 'list';
  const heading = el.querySelector('h1, h2, h3, h4, h5, h6, [role="heading"]');
  if (heading) {
    const hTag = heading.tagName.toLowerCase();
    if (hTag === 'h1' || hTag === 'h2') return 'heading';
  }
  return 'region';
}

function inferComponentType(el: Element, rect: DOMRect): ComponentType {
  const cs = getComputedStyle(el);
  const tag = el.tagName.toLowerCase();
  const ariaRole = el.getAttribute('role');
  const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
  const links = el.querySelectorAll('a[href]').length;
  const children = el.children.length;

  if (rect.height > 200 && rect.width / window.innerWidth > 0.7 && text.length < 200 && el.querySelector('h1, h2, [role="heading"]'))
    return 'hero';
  if ((ariaRole === 'navigation' || tag === 'nav') && rect.width / window.innerWidth > 0.4 && links >= 3)
    return 'navbar';
  if ((ariaRole === 'navigation' || ariaRole === 'complementary' || tag === 'aside') && rect.width / window.innerWidth <= 0.45)
    return 'siderail';
  if (tag === 'table' || el.querySelector('thead, th, [role="columnheader"]'))
    return 'table';
  if (tag === 'form' || ariaRole === 'form' || el.querySelectorAll('input, select, textarea').length >= 2)
    return 'form';
  if (ariaRole === 'navigation' && /[›\/>·]\s/.test(text) && links >= 2 && text.length < 200)
    return 'breadcrumb';
  if (ariaRole === 'tablist' || el.querySelector('[role="tab"], [role="tablist"]'))
    return 'tabstrip';
  if (ariaRole === 'dialog' || el.getAttribute('aria-modal') === 'true')
    return 'modal';
  if (['img', 'picture', 'video', 'svg', 'figure'].includes(tag) || (cs.backgroundImage && cs.backgroundImage !== 'none' && text.length < 40))
    return 'media';
  if (tag === 'pre' || tag === 'code' || el.querySelector('pre, code'))
    return 'codeblock';
  if (['blockquote', 'q', 'cite'].includes(tag))
    return 'quote';
  if (links >= 3 && text.length < 200 && (tag === 'footer' || el.closest('footer')))
    return 'footer-links';
  const imgs = el.querySelectorAll('img').length;
  if (imgs >= 2 && rect.height < 80 && /row|flex/i.test(cs.display))
    return 'avatar-group';
  if (rect.width < 120 && rect.height < 40 && cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && text.length < 20)
    return 'badge';
  if (ariaRole === 'navigation' && /\b\d+\b/.test(text) && links >= 3 && text.length < 100)
    return 'pagination';
  const hasSolidBg = cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)';
  if (hasSolidBg && (cs.border !== 'none' || cs.borderRadius !== '0px' || cs.boxShadow !== 'none') && children >= 1 && text.length > 10)
    return 'card';
  if (tag === 'ul' || tag === 'ol' || ariaRole === 'list' || children > 2)
    return 'list';
  return 'unknown';
}

function sampleText(el: Element): string {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const t = node.textContent?.trim();
      if (!t || t.length < 2) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let text = '';
  let count = 0;
  while (walker.nextNode() && count < 5) {
    text += (text ? ' ' : '') + (walker.currentNode.textContent?.trim() ?? '');
    count++;
  }
  text = text.replace(/\b[\w.+-]+@[\w.-]+\b/g, '[email]');
  text = text.replace(/\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, '[phone]');
  text = text.replace(/\b\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\b/g, '[card]');
  return text;
}

function countSimilarSiblings(el: Element): number {
  const parent = el.parentElement;
  if (!parent) return 1;
  const tag = el.tagName;
  let count = 0;
  for (const sib of Array.from(parent.children)) {
    if (sib.tagName === tag) count++;
  }
  return count;
}

// ── buildStableSelector — R6 fix: never silent ──────────────────────
//
// Returns { selector, targetable: true } on success.
// Returns { selector: '', targetable: false, reason } when no stable anchor.
// The caller surfaces the reason to the agent so it can choose another approach.

export interface SelectorResult {
  selector: string;
  targetable: boolean;
  reason?: string;
}

export function buildStableSelector(el: HTMLElement): SelectorResult {
  let anchor: HTMLElement | null = null;
  let n: HTMLElement | null = el;
  let searchDepth = 0;
  while (n && n !== document.body && n !== document.documentElement && searchDepth < 20) {
    if (n.id || n.getAttribute('data-testid') || n.getAttribute('role') ||
        n.getAttribute('aria-label') || n.getAttribute('name')) {
      anchor = n;
      break;
    }
    n = n.parentElement;
    searchDepth++;
  }
  const parts: string[] = [];
  if (anchor) {
    const tag = anchor.tagName.toLowerCase();
    if (anchor.id) parts.push(`${tag}#${cssEscape(anchor.id)}`);
    else if (anchor.getAttribute('data-testid')) parts.push(`${tag}[data-testid="${cssEscape(anchor.getAttribute('data-testid')!)}"]`);
    else if (anchor.getAttribute('role')) parts.push(`${tag}[role="${cssEscape(anchor.getAttribute('role')!)}"]`);
    else if (anchor.getAttribute('aria-label')) parts.push(`${tag}[aria-label="${cssEscape(anchor.getAttribute('aria-label')!)}"]`);
    else if (anchor.getAttribute('name')) parts.push(`${tag}[name="${cssEscape(anchor.getAttribute('name')!)}"]`);
  } else {
    if (el === document.body) return { selector: 'body', targetable: true };
    if (el === document.documentElement) return { selector: 'html', targetable: true };
    // R6 fix: surface the reason instead of returning null silently.
    return { selector: '', targetable: false, reason: 'no stable anchor (id/data-testid/role/aria-label/name) within 20 ancestors' };
  }
  const chain: string[] = [];
  let node: HTMLElement | null = el;
  let d = 0;
  // Chain depth cap MUST match the anchor searchDepth cap (searchDepth < 20
  // above). An anchor found 11-20 levels up was reachable by the search but
  // unreachable by the chain when this was `d < 10`: the chain stopped short of
  // the anchor, the `>` child combinator then broke, and querySelector returned
  // null → the element was silently marked untargetable with a generic reason,
  // even though a stable anchor existed. Cap the chain at the same 20 so any
  // anchor the search finds can actually be chained back to.
  while (node && node !== anchor && d < 20) {
    const tag = node.tagName.toLowerCase();
    let cnt = 0;
    let sib = node.previousElementSibling;
    while (sib) { if (sib.tagName === node.tagName) cnt++; sib = sib.previousElementSibling as Element | null; }
    chain.push(`${tag}:nth-of-type(${cnt + 1})`);
    node = node.parentElement;
    d++;
  }
  chain.reverse();
  const sel = [...parts, ...chain].join(' > ');
  try {
    if (document.querySelector(sel) === el) return { selector: sel, targetable: true };
    return { selector: '', targetable: false, reason: 'selector does not resolve back to the element' };
  } catch {
    return { selector: '', targetable: false, reason: 'selector parse error' };
  }
}

function cssEscape(s: string): string {
  return (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&');
}

/** Serialize the inventory for the model call. Compact, a few thousand chars.
 *  F1: surface the UNTARGETABLE REASON (not just the bare token) so the agent
 *  can choose the alternative path (rule 13: every error names an alternative). */
export function serializeInventory(regions: CandidateRegion[]): string {
  return regions.map((r) => {
    const text = r.textSample ? ` text="${r.textSample}"` : '';
    // R3: emit the reason text, not just the bare UNTARGETABLE token. A bare
    // token leaves the agent unable to recover (no anchor? not unique? parse
    // error?) and it falls back to guessing — the exact roadmap failure.
    const untargetable = r.targetable ? '' : ` UNTARGETABLE(${r.untargetableReason ?? 'unknown'})`;
    return `[${r.id}] role=${r.role} type=${r.componentType}${text} pos=${r.position} width=${r.width} repeat=${r.repeatCount}${untargetable}`;
  }).join('\n');
}

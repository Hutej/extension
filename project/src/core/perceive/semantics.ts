/** core/perceive/semantics — D9 (landmarks, interactive inventory) +
 *  C4 (heading outline tree) + C7 (component-type taxonomy). */

import type { Cluster } from './index.ts';
import { deepQuerySelector } from './dom-utils.ts';

// ── C4 (carried from enrichment.ts): Heading outline tree ───────────

export interface HeadingNode {
  level: number;
  text: string;
  handle: string | null;
  depth: number;
  children: HeadingNode[];
}

/** Build a real document outline from h1-h6, ARIA headings, and role="heading". */
export function buildOutline(): { tree: HeadingNode[]; clusterByHeading: Map<string, string> } {
  const headings: { level: number; text: string; el: Element; depth: number }[] = [];
  const walk = (el: Element | ShadowRoot, depth: number): void => {
    for (const child of Array.from(el.children)) {
      const tag = child.tagName.toLowerCase();
      const role = child.getAttribute('role');
      let level: number | null = null;
      if (/^h([1-6])$/.test(tag)) level = parseInt(tag[1], 10);
      else if (role === 'heading') {
        const ariaLevel = child.getAttribute('aria-level');
        level = ariaLevel ? Math.max(1, Math.min(6, parseInt(ariaLevel, 10))) : 2;
      }
      if (level != null) {
        headings.push({ level, text: (child.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80), el: child, depth });
      }
      walk(child, depth + 1);
      if (child instanceof HTMLElement && child.shadowRoot) walk(child.shadowRoot, depth + 1);
    }
  };
  walk(document.body, 0);

  const tree: HeadingNode[] = [];
  const stack: HeadingNode[] = [];
  const clusterByHeading = new Map<string, string>();
  for (const h of headings) {
    const handle = h.el.getAttribute('data-wm-c') || null;
    const node: HeadingNode = { level: h.level, text: h.text, handle, depth: h.depth, children: [] };
    while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop();
    if (stack.length) stack[stack.length - 1].children.push(node);
    else tree.push(node);
    stack.push(node);
    if (handle) clusterByHeading.set(handle, h.text);
  }
  return { tree, clusterByHeading };
}

// ── C7 (carried from enrichment.ts): Component-type taxonomy ────────

export type ComponentType =
  | 'card' | 'list' | 'table' | 'form' | 'hero' | 'navbar' | 'siderail'
  | 'breadcrumb' | 'tabstrip' | 'modal' | 'media' | 'codeblock' | 'quote'
  | 'footer-links' | 'cta' | 'avatar-group' | 'badge' | 'pagination' | 'unknown';

export interface ComponentClassification {
  type: ComponentType;
  confidence: number;
}

/** Classify a cluster into a recognisable component type. */
export function classifyComponentType(cluster: Cluster, el: HTMLElement | null): ComponentClassification {
  if (!el) return { type: 'unknown', confidence: 0 };
  const tag = cluster.tag;
  const role = cluster.role;
  const designRole = cluster.designRole;
  const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
  const textLen = text.length;
  const links = el.querySelectorAll('a[href]').length;
  const children = el.children.length;

  if (designRole === 'page-title' || (cluster.rect.h > 200 && cluster.layout.widthRatio > 0.7 && textLen < 200 && el.querySelector('h1, h2, [role="heading"]')))
    return { type: 'hero', confidence: 0.7 };
  if ((role === 'navigation' || tag === 'nav') && cluster.layout.widthRatio > 0.4 && links >= 3)
    return { type: 'navbar', confidence: 0.85 };
  if ((role === 'navigation' || role === 'complementary' || tag === 'aside') && cluster.layout.widthRatio <= 0.45)
    return { type: 'siderail', confidence: 0.8 };
  if (tag === 'table' || role === 'table' || (el.querySelector('thead, th, [role="columnheader"]')))
    return { type: 'table', confidence: 0.9 };
  if (tag === 'form' || role === 'form' || el.querySelectorAll('input, select, textarea').length >= 2)
    return { type: 'form', confidence: 0.85 };
  if (role === 'navigation' && /[›\/>·]\s/.test(text) && links >= 2 && textLen < 200)
    return { type: 'breadcrumb', confidence: 0.75 };
  if (role === 'tablist' || el.querySelector('[role="tab"], [role="tablist"]'))
    return { type: 'tabstrip', confidence: 0.9 };
  if (role === 'dialog' || el.getAttribute('aria-modal') === 'true')
    return { type: 'modal', confidence: 0.9 };
  if (['img', 'picture', 'video', 'svg', 'figure'].includes(tag) || (cluster.style.hasBgImage && textLen < 40))
    return { type: 'media', confidence: 0.85 };
  if (tag === 'pre' || tag === 'code' || el.querySelector('pre, code'))
    return { type: 'codeblock', confidence: 0.85 };
  if (['blockquote', 'q', 'cite'].includes(tag))
    return { type: 'quote', confidence: 0.9 };
  if (designRole === 'footer-chrome' && links >= 3)
    return { type: 'footer-links', confidence: 0.8 };
  if (designRole === 'actions-primary' && cluster.hasSolidBg && textLen < 60)
    return { type: 'cta', confidence: 0.75 };
  const imgs = el.querySelectorAll('img').length;
  if (imgs >= 2 && cluster.rect.h < 80 && /row|flex/i.test(cluster.layout.display))
    return { type: 'avatar-group', confidence: 0.6 };
  if (cluster.rect.w < 120 && cluster.rect.h < 40 && cluster.hasSolidBg && textLen < 20)
    return { type: 'badge', confidence: 0.65 };
  if (role === 'navigation' && /\b\d+\b/.test(text) && links >= 3 && textLen < 100)
    return { type: 'pagination', confidence: 0.65 };
  if (cluster.hasSolidBg && (cluster.style.border !== 'none' || cluster.style.borderRadius !== '0px' || cluster.style.boxShadow !== 'none') && children >= 1 && textLen > 10)
    return { type: 'card', confidence: 0.7 };
  if (tag === 'ul' || tag === 'ol' || role === 'list' || cluster.count > 2)
    return { type: 'list', confidence: 0.7 };
  return { type: 'unknown', confidence: 0 };
}

// ── D9: landmarks + interactive inventory ────────────────────────────

// HTML5 sectioning elements that imply an ARIA landmark. 'search' has no
// HTML5 tag — it is role-only. Form maps to tag <form> / role="form".
const HTML5_LANDMARK_TAGS = new Set(['main', 'nav', 'aside', 'header', 'footer', 'article', 'section', 'form']);
// ARIA landmark roles (includes 'search' which is role-only).
const ARIA_LANDMARK_ROLES = new Set(['main', 'navigation', 'complementary', 'banner', 'contentinfo', 'article', 'region', 'form', 'search']);
// Map ARIA role -> our canonical landmark name (matches HTML5 tag names where they exist).
const ARIA_TO_LANDMARK: Record<string, string> = {
  main: 'main', navigation: 'nav', complementary: 'aside',
  banner: 'header', contentinfo: 'footer', article: 'article',
  region: 'section', form: 'form', search: 'search',
};

export interface LandmarkEntry {
  handle: string;
  landmark: string;
  declaredBy: 'html5' | 'aria';
}
export interface LandmarkMap {
  landmarks: LandmarkEntry[];
  hasMain: boolean;
  hasNav: boolean;
  hasHeader: boolean;
  hasFooter: boolean;
  hasAside: boolean;
}

/** Map ARIA landmarks and HTML5 sectioning elements onto regions.
 *  Free, author-declared, high-confidence structure (Law 0: informs, never emitted). */
export function mapLandmarks(clusters: Cluster[]): LandmarkMap {
  const landmarks: LandmarkEntry[] = [];
  for (const c of clusters) {
    // HTML5 tag wins as the declaration when both tag and role agree.
    if (HTML5_LANDMARK_TAGS.has(c.tag)) {
      landmarks.push({ handle: c.handle, landmark: c.tag, declaredBy: 'html5' });
      continue;
    }
    if (c.role && ARIA_LANDMARK_ROLES.has(c.role)) {
      landmarks.push({ handle: c.handle, landmark: ARIA_TO_LANDMARK[c.role], declaredBy: 'aria' });
    }
  }
  const names = new Set(landmarks.map((l) => l.landmark));
  return {
    landmarks,
    hasMain: names.has('main'),
    hasNav: names.has('nav'),
    hasHeader: names.has('header'),
    hasFooter: names.has('footer'),
    hasAside: names.has('aside'),
  };
}

export interface InteractiveSummary {
  handle: string;
  linkCount: number;
  buttonCount: number;
  inputCount: number;
  inputTypes: string[];
  labels: string[];
  ariaRole: string | null;
  ariaLabel: string | null;
  ariaHidden: boolean;
}
export interface InteractiveInventory {
  regions: InteractiveSummary[];
  focusableOrder: string[];
  ariaHiddenRegions: string[];
}

/** Resolve aria-labelledby to text, else aria-label. Null if neither present. */
function resolveAriaLabel(el: Element): string | null {
  const labelledby = el.getAttribute('aria-labelledby');
  if (labelledby) {
    const parts = labelledby.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean) as HTMLElement[];
    const text = parts.map((e) => (e.textContent || '').replace(/\s+/g, ' ').trim()).join(' ').trim();
    if (text) return text.slice(0, 120);
  }
  const al = el.getAttribute('aria-label');
  return al ? al.trim().slice(0, 120) : null;
}

const FOCUSABLE_SELECTOR = 'a[href], button, input, select, textarea, [tabindex]';

/** Per-region interactive inventory + a focus-order sweep across all regions.
 *  Author-declared facts only (counts, labels, roles) — never emitted as CSS. */
export function inventoryInteractive(clusters: Cluster[]): InteractiveInventory {
  const regions: InteractiveSummary[] = [];
  const ariaHiddenRegions: string[] = [];

  for (const c of clusters) {
    const el = deepQuerySelector<HTMLElement>(c.selector);
    if (!el) continue;

    const links = Array.from(el.querySelectorAll('a[href]'));
    const buttons = Array.from(el.querySelectorAll('button'));
    const inputs = Array.from(el.querySelectorAll('input, select, textarea'));
    const inputTypes = Array.from(new Set(inputs.map((i) => (i.tagName.toLowerCase() === 'input' ? (i.getAttribute('type') || 'text') : i.tagName.toLowerCase()))));

    // First 3 label texts: links first, then buttons — textContent or aria-label.
    const labelTexts: string[] = [];
    for (const e of [...links, ...buttons]) {
      const label = resolveAriaLabel(e) || (e.textContent || '').replace(/\s+/g, ' ').trim();
      if (label) labelTexts.push(label.slice(0, 80));
      if (labelTexts.length >= 3) break;
    }

    const ariaHidden = el.getAttribute('aria-hidden') === 'true';
    if (ariaHidden) ariaHiddenRegions.push(c.handle);

    regions.push({
      handle: c.handle,
      linkCount: links.length,
      buttonCount: buttons.length,
      inputCount: inputs.length,
      inputTypes,
      labels: labelTexts,
      ariaRole: c.role,
      ariaLabel: resolveAriaLabel(el),
      ariaHidden,
    });
  }

  // Focusable order: positive tabindex first (ascending), then tabindex 0 / native
  // in DOM order. Skip tabindex < 0. Map each focusable element to its cluster handle.
  const focusable = Array.from(document.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  let domOrder = 0;
  const ranked = focusable
    .map((e) => {
      // Skip elements hidden from focus: disabled, or aria-hidden ancestor.
      if ((e as HTMLInputElement).disabled || e.getAttribute('aria-hidden') === 'true') return null;
      const ti = e.tabIndex;
      if (ti < 0) return null;
      const handle = (e.closest('[data-wm-c]')?.getAttribute('data-wm-c')) ?? null;
      return { el: e, ti, dom: domOrder++, handle };
    })
    .filter((r): r is { el: HTMLElement; ti: number; dom: number; handle: string | null } => r !== null);

  ranked.sort((a, b) => {
    const pa = a.ti > 0 ? a.ti : Number.MAX_SAFE_INTEGER;
    const pb = b.ti > 0 ? b.ti : Number.MAX_SAFE_INTEGER;
    if (pa !== pb) return pa - pb;
    return a.dom - b.dom;
  });

  const focusableOrder = ranked.map((r) => r.handle).filter((h): h is string => h !== null);

  return { regions, focusableOrder, ariaHiddenRegions };
}

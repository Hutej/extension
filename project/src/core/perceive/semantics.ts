/** core/perceive/semantics — D9 (landmarks, interactive inventory) +
 *  C4 (heading outline tree) + C7 (component-type taxonomy). */

import type { Cluster } from './index.ts';

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

// ── D9 landmark mapping + interactive inventory will be added by subagent ──

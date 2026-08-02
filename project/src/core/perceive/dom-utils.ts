/** core/perceive/dom-utils — shadow-DOM-aware DOM query utilities.
 *  Extracted from index.ts so enrichment modules can import without circular deps. */

export function deepQuerySelector<T extends Element = HTMLElement>(selector: string): T | null {
  const el = document.querySelector<T>(selector);
  if (el) return el;
  const walk = (root: Element | ShadowRoot | Document): T | null => {
    for (const child of Array.from(root.querySelectorAll('*'))) {
      if (child.matches?.(selector)) return child as T;
      if (child instanceof HTMLElement && child.shadowRoot) {
        const found = walk(child.shadowRoot);
        if (found) return found;
      }
    }
    return null;
  };
  return walk(document);
}

export function deepQuerySelectorAll<T extends Element = HTMLElement>(selector: string): T[] {
  const results: T[] = [];
  const seen = new Set<Element>();
  for (const el of Array.from(document.querySelectorAll<T>(selector))) {
    results.push(el); seen.add(el);
  }
  const walk = (root: Element | ShadowRoot | Document): void => {
    for (const child of Array.from(root.querySelectorAll('*'))) {
      if (child.matches?.(selector) && !seen.has(child)) { results.push(child as T); seen.add(child); }
      if (child instanceof HTMLElement && child.shadowRoot) walk(child.shadowRoot);
    }
  };
  walk(document);
  return results;
}

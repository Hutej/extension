/**
 * Verify module — post-injection safety checks.
 * Runs AFTER theme CSS has been injected.
 * Returns pass/fail + details. On failure, caller should rollback.
 */

import { findPrimaryContentNode } from '../observe';
import { MAX_OVERFLOW_RATIO, MIN_CONTRAST_RATIO, CONTRAST_SAMPLE_COUNT } from '../config';

export interface VerifyResult {
  passed: boolean;
  checks: {
    notBlank: boolean;
    noOverflow: boolean;
    contrastOk: boolean;
  };
  details: string[];
}

/**
 * Parse an rgb/rgba color string into [r, g, b] components.
 */
function parseColor(color: string): [number, number, number] | null {
  const m = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (m) return [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])];
  return null;
}

/**
 * Compute relative luminance per WCAG 2.0.
 */
function relativeLuminance(r: number, g: number, b: number): number {
  const [rs, gs, bs] = [r / 255, g / 255, b / 255].map(c =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  );
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

/**
 * Compute contrast ratio between two RGB colors.
 */
function contrastRatio(fg: [number, number, number], bg: [number, number, number]): number {
  const l1 = relativeLuminance(...fg);
  const l2 = relativeLuminance(...bg);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Walk up from an element to find the first non-transparent background.
 */
function getEffectiveBackground(el: Element): [number, number, number] {
  let current: Element | null = el;
  while (current) {
    const bg = getComputedStyle(current).backgroundColor;
    const parsed = parseColor(bg);
    if (parsed) {
      // Check alpha — rgba(0,0,0,0) means transparent
      const alphaMatch = bg.match(/rgba\([^)]*,\s*([\d.]+)\s*\)/);
      if (alphaMatch && parseFloat(alphaMatch[1]) < 0.1) {
        current = current.parentElement;
        continue;
      }
      return parsed;
    }
    current = current.parentElement;
  }
  // Default to white if nothing found
  return [255, 255, 255];
}

/**
 * Run all verification checks on the current page state.
 * Call AFTER injecting theme CSS.
 */
export function verifyTheme(): VerifyResult {
  const details: string[] = [];

  // ── Check 1: Page not blank ──────────────────────────────────────
  const primaryNode = findPrimaryContentNode();
  let notBlank = false;
  if (primaryNode) {
    const rect = primaryNode.getBoundingClientRect();
    const text = (primaryNode.textContent || '').trim();
    notBlank = rect.width > 0 && rect.height > 0 && text.length > 0;
    if (!notBlank) {
      details.push(`Primary content node found but has zero box or empty text (${rect.width}x${rect.height}, textLen=${text.length})`);
    }
  } else {
    details.push('No primary content node found — page may be blank');
    notBlank = false;
  }

  // ── Check 2: No layout blow-out ──────────────────────────────────
  const scrollW = document.documentElement.scrollWidth;
  const innerW = window.innerWidth;
  const ratio = innerW > 0 ? scrollW / innerW : 1;
  const noOverflow = ratio <= MAX_OVERFLOW_RATIO;
  if (!noOverflow) {
    details.push(`Layout blow-out: scrollWidth=${scrollW}, innerWidth=${innerW}, ratio=${ratio.toFixed(2)} > ${MAX_OVERFLOW_RATIO}`);
  }

  // ── Check 3: Contrast sane ───────────────────────────────────────
  let contrastOk = true;
  const textEls = document.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, td, th, span, a, label, blockquote');
  let samplesChecked = 0;
  let failedSamples = 0;

  for (let i = 0; i < textEls.length && samplesChecked < CONTRAST_SAMPLE_COUNT; i++) {
    const el = textEls[i];
    if (el.hasAttribute('data-webmorph-ui') || el.closest('[data-webmorph-ui]')) continue;
    
    const text = (el.textContent || '').trim();
    if (text.length < 5) continue;

    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;

    const cs = getComputedStyle(el);
    const fgColor = parseColor(cs.color);
    if (!fgColor) continue;

    const bgColor = getEffectiveBackground(el);
    const cr = contrastRatio(fgColor, bgColor);

    samplesChecked++;
    if (cr < MIN_CONTRAST_RATIO) {
      failedSamples++;
      details.push(`Low contrast: ratio=${cr.toFixed(2)} (min=${MIN_CONTRAST_RATIO}) on "${text.substring(0, 30)}..." fg=${cs.color} bg=rgb(${bgColor.join(',')})`);
    }
  }

  // Fail if more than half of samples have bad contrast
  if (samplesChecked > 0 && failedSamples > samplesChecked / 2) {
    contrastOk = false;
  }

  const passed = notBlank && noOverflow && contrastOk;
  return { passed, checks: { notBlank, noOverflow, contrastOk }, details };
}

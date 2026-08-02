/** core/perceive/typography — D3 (type ramp, per-region typography) +
 *  C10 (text understanding: kind, direction, longest token, truncation). */

import type { Cluster } from './index.ts';

// ── C10 (carried from enrichment.ts): Text understanding ────────────

export interface TextProfile {
  readingLength: number;
  kind: 'prose' | 'label' | 'heading' | 'number' | 'code' | 'none';
  dir: 'ltr' | 'rtl' | 'auto';
  longestToken: number;  // chars in the longest unbreakable token (word/URL)
  truncated: boolean;     // text-overflow: ellipsis or -webkit-line-clamp in effect
}

/** Analyze the text of a cluster: reading length, kind, direction, longest
 *  unbreakable token, and DOM truncation state. The longest token decides whether
 *  a track can safely narrow — the browser needs that number and so does the solver. */
export function analyzeText(cluster: Cluster, el: HTMLElement | null): TextProfile {
  if (!el) return { readingLength: 0, kind: 'none', dir: 'auto', longestToken: 0, truncated: false };
  const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
  const readingLength = text.length;
  const tag = cluster.tag;
  let kind: TextProfile['kind'] = 'none';
  if (/^h[1-6]$/.test(tag) || cluster.role === 'heading') kind = 'heading';
  else if (tag === 'pre' || tag === 'code' || /mono/i.test(cluster.style.fontFamily)) kind = 'code';
  else if (/^\$?[\d.,]+%?$/.test(text) && text.length < 20) kind = 'number';
  else if (readingLength < 40 && !text.includes('.')) kind = 'label';
  else if (readingLength > 80) kind = 'prose';
  else kind = 'label';

  const rawDir = el.dir || getComputedStyle(el).direction || 'auto';
  const dir = (rawDir === 'ltr' || rawDir === 'rtl' ? rawDir : 'auto') as 'ltr' | 'rtl' | 'auto';

  const tokens = text.split(/\s+/).filter(Boolean);
  let longestToken = 0;
  for (const t of tokens) longestToken = Math.max(longestToken, t.length);

  const cs = getComputedStyle(el);
  const truncated =
    (cs.textOverflow === 'ellipsis' && (cs.overflowX === 'hidden' || cs.overflowX === 'clip' || cs.overflow === 'hidden')) ||
    cs.webkitLineClamp !== 'none' && cs.webkitLineClamp !== '';

  return { readingLength, kind, dir, longestToken, truncated };
}

// ── D3 type ramp + per-region typography will be added by subagent ──

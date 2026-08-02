/**
 * core/perceive/semantic — the deterministic semantic-role classifier + designer
 * signals. Phase 1 of the semantic-graph pivot.
 *
 * The senior-dev diagnosis: the model designs geometric rectangles, not meaning —
 * it must rediscover what the page IS on every run → run-to-run variance. The fix:
 * a deterministic classifier that maps each cluster onto a CLOSED design-role
 * vocabulary, plus designer signals (dominance, grouping, composition) that
 * designers actually use but the old serialization omitted.
 *
 * PURE: takes per-cluster signals + page context as DATA. No DOM access. The
 * signal-gathering lives in perceive/index.ts (where the live representative
 * element is); the CLASSIFICATION lives here so it's unit-testable without a page.
 *
 * Zero site-specific rules. Class/id TOKEN patterns (nav|search|comment|ad|footer
 * …) are universal conventions, not site recipes — a redesign targeting "the
 * cluster whose class contains 'search'" works on any site that follows the
 * convention, and the classifier falls back to geometric/text signals when the
 * tokens don't match.
 */

// ── The closed role vocabulary (the 14 design roles) ─────────────────

export type DesignRole =
  | 'page-title' | 'article-body' | 'nav-primary' | 'nav-local' | 'sidebar'
  | 'toolbar' | 'search' | 'actions-primary' | 'metadata' | 'media' | 'listing'
  | 'comments' | 'footer-chrome' | 'ad-or-void' | 'toc';

export const DESIGN_ROLES: readonly DesignRole[] = [
  'page-title', 'article-body', 'nav-primary', 'nav-local', 'sidebar',
  'toolbar', 'search', 'actions-primary', 'metadata', 'media', 'listing',
  'comments', 'footer-chrome', 'ad-or-void', 'toc',
] as const;

// ── Per-cluster signals (gathered in perceive/index.ts, classified here) ──

export interface ClusterSignals {
  ariaRole: string | null;        // explicit/landmark ARIA role (the strongest signal)
  tag: string;
  textLen: number;                // direct + descendant text length (prose measure)
  linkCount: number;              // <a[href]> descendant count
  headingLevel: number | null;    // 1-6 if the cluster IS a heading; else max heading inside
  hasHeading: boolean;            // contains h1-h6
  rectX: number; rectY: number; rectW: number; rectH: number;
  widthRatio: number;             // rectW / viewport.w
  widthFractionOfParent: number;  // rectW / parentClusterRect.w (1.0 when no parent cluster)
  normWidthFromParent: boolean;   // 1.6C — true when widthFractionOfParent < 1 (parent-relative path); false = viewport fallback (counted, never silent)
  count: number;                  // repeated members (a listing signal)
  classTokens: string;            // lowercased id + className (for convention tokens)
  emptinessScore: number;         // 0..1 (computed in perceive)
  hasBgImage: boolean;            // own bg is a url() image (a content image)
  fontSize: number;               // px
  isNativeControl: boolean;
  hasSolidBg: boolean;
  /** Phase 2 — the cluster IS or CONTAINS a code block: a <pre>/<code>/syntax-
   *  highlight element, or a class/id token like 'code'/'syntax'/'highlight'.
   *  A text-less+image-less code container must classify as article-body, never
   *  ad-or-void (the MDN code-example trap). Universal convention, not a site recipe. */
  codeHint: boolean;
  /** Phase 2 — the cluster sits inside article flow (a main/article ancestor). A
   *  text-less+image-less block with real height in article flow is content, not a
   *  void — it classifies as article-body, never ad-or-void. */
  inArticleFlow: boolean;
  /** Phase 5/X2 — TOC signal: the cluster is a table-of-contents — a nav/aside/ol/ul
   *  whose links are predominantly same-page fragment anchors (href^="#") pointing
   *  at headings in the main content. Detected in gatherSignals (needs DOM); scored
   *  here. Principled: no site names, no selectors. */
  tocHint: boolean;
}

export interface PageContext {
  viewport: { w: number; h: number };
}

export interface RoleClassification {
  role: DesignRole;
  confidence: number;             // 0..1 — the winning score (strength of match)
  scores: Partial<Record<DesignRole, number>>;  // per-role scores (for the honesty report)
}

// ── Classify ────────────────────────────────────────────────────────

/** Classify a cluster onto the closed role vocabulary. Each role scores 0..1 from
 *  deterministic, generic signals; the highest-scoring role wins; confidence = the
 *  winning score (low confidence flags a cluster the human should check). Pure. */
export function classifyRole(s: ClusterSignals, ctx: PageContext): RoleClassification {
  const vp = ctx.viewport;
  const textLen = s.textLen;
  const linkDensity = textLen > 0 ? s.linkCount / textLen : 0;
  const tok = s.classTokens;
  const has = (re: RegExp) => re.test(tok);
  // 1.5B/1.6C — normalized width: parent-relative when a parent cluster exists, viewport-relative
  // fallback for top-level elements. Stable under viewport resize (element + parent shrink
  // proportionally → ratio is constant). The raw viewport-relative widthRatio flips at the
  // 0.4/0.45/0.5 knife-edges under resize, causing nav-local <-> sidebar <-> nav-primary
  // role churn. 1.6C: the fallback is EXPLICIT and COUNTED via normWidthFromParent — no
  // silent reversion to the old viewport-coupled metric.
  const normWidth = s.normWidthFromParent ? s.widthFractionOfParent : s.widthRatio;
  const isTop = s.rectY < vp.h * 0.25;
  const isBottom = s.rectY > vp.h * 0.6;
  const isLeft = s.rectX < vp.w * 0.2;
  const isRight = s.rectX > vp.w * 0.7;
  const mediaTag = ['img', 'picture', 'video', 'svg', 'figure', 'canvas'].includes(s.tag);

  const scores: Partial<Record<DesignRole, number>> = {};

  // page-title: the page's primary heading — an h1, large, top, short. A short
  // top nav span/link ("Pricing", "Sign in", 4-7 chars at 16px) must NOT win
  // this — a page title is DISPLAY type. A non-h1 cluster needs large type
  // (≥20px) to score at all; without it the 0.3 from isTop+short would steal
  // page-title from the real h1 on GitHub/BBC.
  const isPageTitleShape = s.headingLevel === 1 || s.fontSize >= 20;
  scores['page-title'] = isPageTitleShape
    ? (s.headingLevel === 1 ? 0.5 : 0) +
      (s.fontSize >= 24 ? 0.2 : 0) +
      (isTop ? 0.2 : 0) +
      (textLen < 120 ? 0.1 : 0)
    : 0;

  // article-body: the main prose — main/article role OR high text + low link density.
  scores['article-body'] =
    (s.ariaRole === 'main' || s.ariaRole === 'article' ? 0.5 : 0) +
    (textLen > 400 ? 0.25 : textLen > 120 ? 0.15 : 0) +
    (linkDensity < 0.02 ? 0.2 : linkDensity < 0.06 ? 0.1 : 0) +
    (s.hasHeading ? 0.1 : 0);

  // nav-primary: horizontal nav band — nav/banner role, wide, top, link-dense.
  scores['nav-primary'] =
    (s.ariaRole === 'navigation' || s.ariaRole === 'banner' ? 0.4 : 0) +
    (normWidth >= 0.5 ? 0.2 : 0) +
    (isTop ? 0.2 : 0) +
    (s.linkCount >= 3 || linkDensity > 0.1 ? 0.2 : 0);

  // nav-local: vertical/side nav — nav role, narrow, on a side.
  // 1.6D: reverted 1.5B's widening (0.45 -> 0.40). Pure normalization, no band change.
  scores['nav-local'] =
    (s.ariaRole === 'navigation' ? 0.4 : 0) +
    (normWidth <= 0.40 && normWidth >= 0.1 ? 0.3 : 0) +
    ((isLeft || isRight) ? 0.2 : 0) +
    (s.linkCount >= 3 ? 0.1 : 0);

  // sidebar: aside/complementary content (not nav) — aside role, side-rail width.
  // 1.6D: reverted 1.5B's widening (0.50 -> 0.45). Pure normalization, no band change.
  scores['sidebar'] =
    (s.ariaRole === 'complementary' || s.tag === 'aside' ? 0.5 : 0) +
    (normWidth <= 0.45 && normWidth >= 0.1 ? 0.3 : 0) +
    (linkDensity < 0.1 ? 0.1 : 0) +
    (s.hasHeading ? 0.1 : 0);

  // toolbar: a horizontal action bar — interactive-dense, wide + short, low text.
  scores['toolbar'] =
    ((s.linkCount + (s.isNativeControl ? 1 : 0)) >= 3 ? 0.3 : 0) +
    (normWidth >= 0.4 && s.rectH < 120 ? 0.3 : 0) +
    (textLen < 100 ? 0.2 : 0) +
    (s.ariaRole === 'banner' || has(/toolbar/) ? 0.2 : 0);

  // search: a search input/form — search role, search input type, or 'search' token.
  scores['search'] =
    (has(/\bsearch\b/) ? 0.6 : 0) +
    (s.ariaRole === 'search' ? 0.3 : 0) +
    (s.tag === 'input' ? 0.1 : 0);

  // actions-primary: a small cluster of prominent action buttons (a CTA group) —
  // narrow, short, button/link-dense, a solid colorful surface.
  scores['actions-primary'] =
    (normWidth < 0.4 && s.rectH < 100 && (s.isNativeControl || s.linkCount >= 1) && textLen < 60 ? 0.3 : 0) +
    (s.hasSolidBg ? 0.2 : 0) +
    (s.rectH < 80 ? 0.2 : 0) +
    (s.ariaRole === 'button' ? 0.2 : 0);

  // metadata: small-text chrome — byline/date/tag/breadcrumb tokens, small font, very
  // short. Tightened: a recommendation-card TITLE is short but it is NOT metadata
  // (it's a listing item); the old loose thresholds grabbed short-text cards and
  // made the YouTube role distribution swing with the feed. Require the metadata
  // TOKENS (the real signal) OR very-small text + tiny height (a true chrome label),
  // and let `listing` win repeated short-text cards instead.
  const hasMetaToken = has(/(date|author|time|breadcrumb|meta\b|tag\b|byline|posted)/);
  scores['metadata'] =
    (hasMetaToken ? 0.5 : 0) +
    (s.fontSize < 13 && textLen < 60 && s.rectH < 40 ? 0.3 : 0) +
    (hasMetaToken && s.rectH < 60 ? 0.2 : 0);

  // media: image/video/figure — media tag, or a content-image bg, little text.
  // (Code blocks are NO LONGER media — X1: they are article-body content, not
  // photographs. The codeHint signal now boosts article-body, not media. The
  // ad-or-void guard still suppresses void for code blocks — that is unchanged.)
  scores['media'] =
    (mediaTag ? 0.6 : 0) +
    (s.hasBgImage ? 0.4 : 0) +
    (textLen < 40 ? 0.1 : 0);

  // article-body (continued): code blocks are content. A pre/code/syntax
  // cluster reads as article-body — code is prose in monospace, not media. The
  // codeHint boost is principled (universal convention tokens + monospace font +
  // syntax-highlight token density), no site names. This maps code to `main`.
  if (s.codeHint) {
    scores['article-body'] = Math.max(scores['article-body'] ?? 0, 0.5 +
      (textLen > 120 ? 0.15 : 0) +
      (s.hasHeading ? 0.1 : 0));
  }

  // listing: a repeated list of items — count > 2, list/listitem role. A repeated
  // short-text card (a recommendation feed row) reads as listing, not metadata — the
  // count + grouping are the signal. Count > 2 alone is a weak signal (a repeated
  // button cluster is not a listing), so combine with text-bearing + width.
  scores['listing'] =
    (s.count > 5 ? 0.5 : s.count > 2 ? 0.3 : 0) +
    (s.ariaRole === 'list' || s.ariaRole === 'listitem' ? 0.3 : 0) +
    (textLen > 0 && normWidth > 0.2 ? 0.15 : 0) +
    (s.count > 2 && textLen > 0 && textLen < 200 ? 0.2 : 0);   // repeated short-text cards → listing

  // comments: a comment section — 'comment' token or comments role.
  scores['comments'] =
    (has(/comment/) ? 0.7 : 0) +
    (s.ariaRole === 'comment' ? 0.3 : 0);

  // toc: a table-of-contents — a nav/aside/ol/ul landmark whose links are
  // predominantly same-page fragment anchors pointing at headings in main
  // content. The tocHint signal (detected in gatherSignals with DOM access)
  // is the sole driver. Decisive: 1.1 beats any nav score (max 1.0) so a TOC
  // is never misclassified as nav-local. Confidence is capped at 1.0 by the
  // classifier; 1.1 only affects the role-selection comparison.
  scores['toc'] = s.tocHint ? 1.1 : 0;

  // footer-chrome: the footer — contentinfo role / footer tag, bottom, short-ish.
  scores['footer-chrome'] =
    (s.ariaRole === 'contentinfo' || s.tag === 'footer' ? 0.6 : 0) +
    (isBottom ? 0.3 : 0) +
    (textLen < 300 ? 0.1 : 0);

  // ad-or-void: ad slots or empty/decorative — ad/sponsor/promo tokens, emptiness,
  // or a large text-less image-less region. GUARDED: a code container (pre/code/
  // syntax) or a text-less+image-less block with REAL height inside article flow is
  // content, NOT a void — it must classify article-body, never ad-or-void (the MDN
  // code-example trap). Suppress the void score in those cases — EXCEPT a genuine
  // void TOKEN (ad/sponsor/promo) wins regardless: an explicit ad slot is a void
  // even in article flow.
  const realHeight = s.rectH >= 60;
  const voidToken = has(/(advert|\bad\b|sponsor|promo)/);
  const isContentBlock = s.codeHint || (s.inArticleFlow && realHeight);
  if (voidToken) {
    // A genuine void TOKEN is a decisive signal — 0.6 beats the geometric ties
    // (toolbar/nav-primary at 0.4-0.5) the ad-or-void role would otherwise lose to
    // on DESIGN_ROLES tie-break order (ad-or-void is last in the array).
    scores['ad-or-void'] = 0.6 + (s.emptinessScore >= 0.7 ? 0.2 : s.emptinessScore >= 0.5 ? 0.1 : 0);
  } else if (isContentBlock) {
    scores['ad-or-void'] = 0;
  } else {
    scores['ad-or-void'] =
      (s.emptinessScore >= 0.7 ? 0.5 : s.emptinessScore >= 0.5 ? 0.3 : 0) +
      (textLen < 10 && !s.hasBgImage && normWidth > 0.3 ? 0.2 : 0);
  }

  // Pick the highest-scoring role. Ties broken by the order in DESIGN_ROLES (stable).
  let best: DesignRole = 'ad-or-void';
  let bestScore = -1;
  for (const r of DESIGN_ROLES) {
    const sc = scores[r] ?? 0;
    if (sc > bestScore) { bestScore = sc; best = r; }
  }
  const confidence = Math.max(0, Math.min(1, bestScore));
  return { role: best, confidence, scores };
}

// ── Dominance rank (area × position × contrast weight) ──────────────

export interface DominanceInputs {
  rectX: number; rectY: number; rectW: number; rectH: number;
  widthRatio: number;
  hasSolidBg: boolean; hasBorder: boolean; hasShadow: boolean; fontSize: number;
  isColorful: boolean;   // a colorful bg (accent) — a loud surface reads as dominant
}

/** Per-region dominance rank in 0..1 = area (0.5) + position (0.3) + contrast (0.2).
 *  Area: the fraction of the viewport the region covers (capped). Position: top of
 *  page is more dominant (a header band dominates a buried footer). Contrast: a
 *  solid, bordered, shadowed, large-type, colorful surface reads as louder.
 *  Pure — unit-testable. */
export function rankDominance(s: DominanceInputs, viewport: { w: number; h: number }): number {
  const area = Math.min(1, (s.rectW * s.rectH) / Math.max(1, viewport.w * viewport.h));
  const position = Math.max(0, 1 - s.rectY / Math.max(1, viewport.h));
  const contrast =
    (s.hasSolidBg ? 0.3 : 0) + (s.hasBorder ? 0.2 : 0) + (s.hasShadow ? 0.1 : 0) +
    (s.fontSize >= 20 ? 0.2 : 0) + (s.isColorful ? 0.2 : 0);
  return Math.max(0, Math.min(1, area * 0.5 + position * 0.3 + Math.min(1, contrast) * 0.2));
}

// ── Grouping (proximity/alignment — "these N regions read as one unit") ──

export interface GroupedCluster {
  handle: string;
  parentHandle: string | null;
  rectX: number; rectY: number; rectW: number; rectH: number;
}

/** Detect sibling groups — clusters sharing a parent, in a RUN of ≥2 with similar
 *  width (within 50%+40px) and adjacent (overlapping y-band for a row, or x-band for
 *  a column). A run breaks when the next sibling is too dissimilar in width or not
 *  adjacent — so a row of cards groups, while a disparate footer below the row does
 *  NOT join the group. A group = "these N regions read as one unit". Returns a handle
 *  → group-id map. Pure. */
export function detectGrouping(clusters: GroupedCluster[]): Map<string, string> {
  const out = new Map<string, string>();
  const byParent = new Map<string | null, GroupedCluster[]>();
  for (const c of clusters) {
    const arr = byParent.get(c.parentHandle);
    if (arr) arr.push(c); else byParent.set(c.parentHandle, [c]);
  }
  for (const [parent, sibs] of byParent) {
    if (sibs.length < 2) continue;
    // Sort by position (top-to-bottom, left-to-right) so adjacency is sequential.
    sibs.sort((a, b) => (a.rectY - b.rectY) || (a.rectX - b.rectX));
    // Walk runs: a run continues while the next sibling is similar-width AND adjacent
    // (y-band overlaps = a row, or x-band overlaps = a column). A break starts a new run.
    const similarWidth = (a: GroupedCluster, b: GroupedCluster): boolean =>
      Math.max(a.rectW, b.rectW) <= Math.min(a.rectW, b.rectW) * 1.5 + 40;
    const adjacent = (a: GroupedCluster, b: GroupedCluster): boolean => {
      const yOv = Math.min(a.rectY + a.rectH, b.rectY + b.rectH) - Math.max(a.rectY, b.rectY);
      const xOv = Math.min(a.rectX + a.rectW, b.rectX + b.rectW) - Math.max(a.rectX, b.rectX);
      return yOv > 0 || xOv > 0;     // row OR column adjacency
    };
    let runStart = 0;
    for (let i = 1; i <= sibs.length; i++) {
      const prev = sibs[i - 1], cur = sibs[i];
      const breaks = !cur || !similarWidth(prev, cur) || !adjacent(prev, cur);
      if (breaks) {
        const run = sibs.slice(runStart, i);
        if (run.length >= 2) {
          const gid = 'g' + hash((parent ?? 'root') + ':' + run.map((s) => s.handle).join(','));
          for (const s of run) out.set(s.handle, gid);
        }
        runStart = i;
      }
    }
  }
  return out;
}

// ── Page-level composition summary ───────────────────────────────────

export interface CompositionSummary {
  dominant: { role: DesignRole; handle: string; rank: number }[];  // top 5 by dominance
  columnCount: number;
  hasTopNav: boolean;       // a nav-primary in the top band
  hasRightRail: boolean;    // a sidebar/nav-local on the right
  hasLeftRail: boolean;     // a sidebar/nav-local on the left
  groupCount: number;       // sibling groups detected
  summary: string;          // a one-line natural-language composition
}

/** Build a page-level composition summary from the dominant regions + rails +
 *  groups. The model sees this UP FRONT (in the header) so it knows the page's
 *  macro shape before reading any node. Pure. */
export function summarizeComposition(
  ranked: { handle: string; role: DesignRole; rank: number; rectX: number; rectY: number; widthRatio: number }[],
  columnCount: number,
  groupCount: number,
  viewport: { w: number; h: number },
): CompositionSummary {
  const dominant = [...ranked].sort((a, b) => b.rank - a.rank).slice(0, 5);
  const hasTopNav = dominant.some((d) => d.role === 'nav-primary' && d.rectY < viewport.h * 0.3);
  const rails = ranked.filter((d) => d.role === 'sidebar' || d.role === 'nav-local');
  const hasRightRail = rails.some((d) => d.rectX > viewport.w * 0.6);
  const hasLeftRail = rails.some((d) => d.rectX < viewport.w * 0.3);

  const parts: string[] = [];
  if (dominant.length) {
    const top = dominant[0];
    parts.push(`${top.role} is dominant`);
    const rest = dominant.slice(1).map((d) => `${d.role}${d.rectY < viewport.h * 0.3 ? '(top)' : d.rectX > viewport.w * 0.6 ? '(right)' : d.rectX < viewport.w * 0.3 ? '(left)' : ''}`);
    if (rest.length) parts.push(`+ ${rest.join(', ')}`);
  }
  const layoutBits: string[] = [];
  if (columnCount > 1) layoutBits.push(`${columnCount} columns`);
  if (hasTopNav) layoutBits.push('top nav band');
  if (hasRightRail) layoutBits.push('right rail');
  if (hasLeftRail) layoutBits.push('left rail');
  if (groupCount) layoutBits.push(`${groupCount} sibling group(s)`);
  const summary = `${parts.join(' ')}; ${layoutBits.join(', ') || 'single column'}`;

  return { dominant, columnCount, hasTopNav, hasRightRail, hasLeftRail, groupCount, summary };
}

// ── small helpers ────────────────────────────────────────────────────

/** FNV-1a hash → 6-char base36. Stable, deterministic (no Math.random). */
export function hash(str: string): string {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  // B8: .slice(-6) removed — drops the most significant digit for values >= 36^6.
  // Modulo 36^6 ensures the value fits in 6 base36 digits, matching perceive/index.ts.
  return ((h >>> 0) % 2176782336).toString(36).padStart(6, '0');
}

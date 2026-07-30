/**
 * Self-check for core/perceive/semantic — the deterministic role classifier +
 * designer signals. One runnable check (ponytail rule: non-trivial logic leaves
 * the smallest thing that fails if the logic breaks). Run:
 *   node --experimental-strip-types tests/probe/semantic.test.ts
 */
import { classifyRole, rankDominance, detectGrouping, summarizeComposition, type ClusterSignals, type PageContext } from '../../src/core/perceive/semantic.ts';

const ctx: PageContext = { viewport: { w: 1280, h: 800 } };

function sig(partial: Partial<ClusterSignals>): ClusterSignals {
  return {
    ariaRole: null, tag: 'div', textLen: 0, linkCount: 0, headingLevel: null,
    hasHeading: false, rectX: 0, rectY: 0, rectW: 100, rectH: 100, widthRatio: 0.1,
    count: 1, classTokens: '', emptinessScore: 0, hasBgImage: false, fontSize: 16,
    isNativeControl: false, hasSolidBg: false, codeHint: false, inArticleFlow: false,
    ...partial,
  };
}

let failures = 0;
const assert = (cond: boolean, msg: string) => { if (!cond) { console.log(`✗ ${msg}`); failures++; } };

// page-title: an h1, large, top, short.
assert(classifyRole(sig({ ariaRole: 'heading', headingLevel: 1, fontSize: 32, rectY: 0, rectH: 60, textLen: 40, widthRatio: 0.9, rectW: 1152 }), ctx).role === 'page-title', 'h1 large top → page-title');

// article-body: main role, high text, low link density.
const body = classifyRole(sig({ ariaRole: 'main', textLen: 2000, linkCount: 5, hasHeading: true, widthRatio: 0.7, rectW: 900, rectH: 4000 }), ctx);
assert(body.role === 'article-body', 'main + high text → article-body');
assert(body.confidence > 0.5, 'article-body confidence > 0.5');

// nav-primary: nav role, wide, top, link-dense.
const navP = classifyRole(sig({ ariaRole: 'navigation', widthRatio: 1.0, rectW: 1280, rectY: 0, rectH: 50, linkCount: 8, textLen: 200 }), ctx);
assert(navP.role === 'nav-primary', 'wide top nav → nav-primary');

// nav-local: nav role, narrow, side.
assert(classifyRole(sig({ ariaRole: 'navigation', widthRatio: 0.2, rectW: 256, rectX: 0, rectH: 800, linkCount: 8 }), ctx).role === 'nav-local', 'narrow side nav → nav-local');

// sidebar: aside role, side-rail width.
assert(classifyRole(sig({ ariaRole: 'complementary', tag: 'aside', widthRatio: 0.25, rectW: 320, rectH: 800, linkCount: 2, hasHeading: true, textLen: 300 }), ctx).role === 'sidebar', 'aside side → sidebar');

// search: search token.
assert(classifyRole(sig({ classTokens: 'search-box', tag: 'div' }), ctx).role === 'search', 'search token → search');

// media: img.
assert(classifyRole(sig({ tag: 'img', hasBgImage: false, textLen: 0, widthRatio: 0.3, rectW: 384, rectH: 256 }), ctx).role === 'media', 'img → media');

// listing: count > 5.
assert(classifyRole(sig({ count: 12, ariaRole: 'list', textLen: 200, widthRatio: 0.8, rectW: 1024, rectH: 600 }), ctx).role === 'listing', 'repeated list → listing');

// footer-chrome: contentinfo, bottom.
assert(classifyRole(sig({ ariaRole: 'contentinfo', tag: 'footer', rectY: 2000, rectH: 200, textLen: 200 }), ctx).role === 'footer-chrome', 'footer bottom → footer-chrome');

// ad-or-void: ad token.
assert(classifyRole(sig({ classTokens: 'ad-slot sponsor', textLen: 0, widthRatio: 0.5, rectW: 640 }), ctx).role === 'ad-or-void', 'ad token → ad-or-void');

// comments: comment token.
assert(classifyRole(sig({ classTokens: 'comment-section', textLen: 800, widthRatio: 0.8, rectW: 1024, rectH: 600 }), ctx).role === 'comments', 'comment token → comments');

// Phase 2 — the code-example trap: a bare <pre> without a figure parent, text-less
// + image-less, in article flow with real height, must classify media, NOT ad-or-void.
// (gatherSignals sets codeHint=true for a <pre>; the classifier reads it.)
const codePre = classifyRole(sig({ tag: 'pre', codeHint: true, textLen: 0, hasBgImage: false, rectH: 240, widthRatio: 0.6, rectW: 768, inArticleFlow: true }), ctx);
assert(codePre.role === 'media', 'bare <pre> in article flow → media, not ad-or-void (the MDN code-example trap)');
assert(codePre.role !== 'ad-or-void', 'code block never ad-or-void');
// A codeHint by class token alone (a div with class="code-example", in flow).
assert(classifyRole(sig({ classTokens: 'example code-example', codeHint: true, textLen: 0, rectH: 120, widthRatio: 0.5, rectW: 640, inArticleFlow: true }), ctx).role === 'media', 'code-hint class token in flow → media');
// A text-less+image-less block in article flow with real height but NO code hint
// is still content material, not a void (the trap's broader form).
assert(classifyRole(sig({ tag: 'div', textLen: 0, hasBgImage: false, rectH: 200, widthRatio: 0.5, rectW: 640, inArticleFlow: true }), ctx).role !== 'ad-or-void', 'real-height in-flow block not ad-or-void');
// A genuine ad token still wins ad-or-void even in flow (the void token beats the contentBlock guard).
assert(classifyRole(sig({ classTokens: 'ad-slot', textLen: 0, hasBgImage: false, rectH: 200, widthRatio: 0.5, rectW: 640, inArticleFlow: true }), ctx).role === 'ad-or-void', 'ad token in flow still ad-or-void');
// A near-empty text-less image-less block (the real MDN voids: h≈0, high emptiness)
// out of flow with an ad token stays ad-or-void.
assert(classifyRole(sig({ classTokens: 'ad-slot', textLen: 0, hasBgImage: false, rectH: 0, emptinessScore: 0.9, widthRatio: 0.4, rectW: 512 }), ctx).role === 'ad-or-void', 'near-empty ad-slot out of flow → ad-or-void');

// Phase 2 — page-title: a short top nav span/link must NOT win page-title. The
// BBC/GitHub trap: "Pricing"/"Sign in" (4-7 chars at 16px) stole page-title@0.3.
assert(classifyRole(sig({ tag: 'a', textLen: 7, fontSize: 16, rectY: 0, rectH: 32, widthRatio: 0.05 }), ctx).role !== 'page-title', 'short 16px nav link not page-title');
// The real page title (h1, large) still wins.
assert(classifyRole(sig({ tag: 'h1', headingLevel: 1, textLen: 30, fontSize: 32, rectY: 0, rectH: 48, widthRatio: 0.9, rectW: 1152 }), ctx).role === 'page-title', 'real h1 still page-title');
// A large non-h1 display heading (a styled div title, ≥20px) can be page-title.
assert(classifyRole(sig({ tag: 'div', textLen: 20, fontSize: 28, rectY: 0, rectH: 60, widthRatio: 0.9, rectW: 1152 }), ctx).role === 'page-title', 'large display-type div can be page-title');

// Dominance: a large top region ranks higher than a small buried one.
const big = rankDominance({ rectX: 0, rectY: 0, rectW: 1280, rectH: 400, widthRatio: 1, hasSolidBg: true, hasBorder: true, hasShadow: true, fontSize: 24, isColorful: true }, ctx.viewport);
const small = rankDominance({ rectX: 0, rectY: 600, rectW: 100, rectH: 50, widthRatio: 0.1, hasSolidBg: false, hasBorder: false, hasShadow: false, fontSize: 12, isColorful: false }, ctx.viewport);
assert(big > small, 'large top + contrast > small buried');
assert(big > 0.5, 'a dominant region ranks > 0.5');

// Grouping: two adjacent similar-width siblings group; disparate widths don't.
const grouped = detectGrouping([
  { handle: 'a', parentHandle: 'p', rectX: 0, rectY: 0, rectW: 300, rectH: 200 },
  { handle: 'b', parentHandle: 'p', rectX: 320, rectY: 0, rectW: 300, rectH: 200 },
  { handle: 'c', parentHandle: 'p', rectX: 0, rectY: 240, rectW: 800, rectH: 50 },   // too wide — not the same group
]);
assert(grouped.has('a') && grouped.has('b'), 'adjacent similar-width siblings group');
assert(!grouped.has('c'), 'disparate width not in the group');

// Composition summary: top nav + columns + a dominant.
const summary = summarizeComposition([
  { handle: 'h1', role: 'page-title', rank: 0.9, rectX: 0, rectY: 0, widthRatio: 1 },
  { handle: 'nav', role: 'nav-primary', rank: 0.7, rectX: 0, rectY: 60, widthRatio: 1 },
  { handle: 'body', role: 'article-body', rank: 0.8, rectX: 0, rectY: 120, widthRatio: 0.6 },
], 2, 1, ctx.viewport);
assert(summary.hasTopNav, 'top nav detected');
assert(summary.columnCount === 2, 'column count carried through');
assert(summary.summary.includes('page-title'), 'summary names the dominant role');

console.log(failures === 0 ? '\n✓ semantic self-check PASS' : `\n✗ semantic self-check FAIL: ${failures} assertion(s)`);
process.exit(failures === 0 ? 0 : 1);

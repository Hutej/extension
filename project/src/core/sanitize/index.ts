/**
 * Sanitizer core — pure module.
 * Strips dangerous vectors from CSS and HTML while preserving
 * legitimate styling and markup.
 *
 * CSS: strips @import, dangerous url(), expression(), javascript:,
 *      -moz-binding, behavior:, and external network references.
 * HTML: strips <script>, on* handlers, external script src/href,
 *       javascript: URLs, <iframe>/<object>/<embed>.
 *
 * All limits are GLOBAL constants.
 */

// ── Global constants ───────────────────────────────────────────────

/** Maximum CSS input length in characters */
export const MAX_CSS_INPUT_LENGTH = 512_000;

/** Maximum HTML input length in characters */
export const MAX_HTML_INPUT_LENGTH = 256_000;

// ── Types ──────────────────────────────────────────────────────────

export interface SanitizeReport {
  strippedCount: number;
  stripped: string[];
}

export interface SanitizeCssResult {
  css: string;
  report: SanitizeReport;
}

export interface SanitizeMarkupResult {
  html: string;
  report: SanitizeReport;
}

// ── CSS Sanitizer ──────────────────────────────────────────────────

/**
 * Sanitize CSS: parse and strip dangerous vectors while preserving
 * all legitimate CSS including backdrop-filter, box-shadow, gradients,
 * @keyframes, transforms, etc.
 *
 * Dangerous vectors stripped:
 * - @import rules (external stylesheet injection)
 * - url() with non-safe protocols (only data: and https: images allowed)
 * - expression() (IE CSS expressions)
 * - javascript: protocol in any value
 * - -moz-binding (XBL binding)
 * - behavior: property (IE HTC behaviors)
 * - External network references via url() to non-https/data sources
 */
export function sanitizeCss(css: string): SanitizeCssResult {
  const report: SanitizeReport = { strippedCount: 0, stripped: [] };

  if (!css || css.length === 0) {
    return { css: '', report };
  }

  // Enforce size limit
  let input = css;
  if (input.length > MAX_CSS_INPUT_LENGTH) {
    input = input.substring(0, MAX_CSS_INPUT_LENGTH);
    report.stripped.push(`Input truncated from ${css.length} to ${MAX_CSS_INPUT_LENGTH} chars`);
    report.strippedCount++;
  }

  let result = input;

  // 1. Strip @import rules (including with url() and media queries)
  result = result.replace(/@import\s+(?:url\s*\([^)]*\)|['"][^'"]*['"])[^;]*;?/gi, (match) => {
    report.stripped.push(`@import: ${match.substring(0, 100)}`);
    report.strippedCount++;
    return '/* [sanitized: @import removed] */';
  });

  // 2. Strip expression() — IE CSS expressions
  result = result.replace(/expression\s*\([^)]*\)/gi, (match) => {
    report.stripped.push(`expression(): ${match.substring(0, 80)}`);
    report.strippedCount++;
    return '/* [sanitized: expression() removed] */';
  });

  // 3. Strip -moz-binding
  result = result.replace(/-moz-binding\s*:\s*[^;}]*/gi, (match) => {
    report.stripped.push(`-moz-binding: ${match.substring(0, 80)}`);
    report.strippedCount++;
    return '/* [sanitized: -moz-binding removed] */';
  });

  // 4. Strip behavior: property (IE HTC behaviors)
  result = result.replace(/\bbehavior\s*:\s*url\s*\([^)]*\)[^;]*/gi, (match) => {
    report.stripped.push(`behavior: ${match.substring(0, 80)}`);
    report.strippedCount++;
    return '/* [sanitized: behavior removed] */';
  });

  // 5. Strip javascript: protocol in any value
  result = result.replace(/javascript\s*:/gi, (match) => {
    report.stripped.push(`javascript: protocol`);
    report.strippedCount++;
    return '/* [sanitized: javascript: removed] */';
  });

  // 6. Strip dangerous url() references — allow only data: and https: for images
  result = result.replace(/url\s*\(\s*(['"]?)(.*?)\1\s*\)/gi, (match, _quote, urlContent) => {
    const trimmed = urlContent.trim().toLowerCase();

    // Allow data: URIs (inline images)
    if (trimmed.startsWith('data:')) return match;

    // Allow https: image URLs
    if (trimmed.startsWith('https://')) return match;

    // Allow empty url() and CSS functions like url(#id) for SVG filters
    if (trimmed === '' || trimmed.startsWith('#')) return match;

    // Strip everything else (http:, ftp:, file:, relative paths that could be abused, etc.)
    report.stripped.push(`url(): ${match.substring(0, 100)}`);
    report.strippedCount++;
    return '/* [sanitized: unsafe url() removed] */';
  });

  return { css: result, report };
}

// ── HTML Sanitizer ─────────────────────────────────────────────────

/** Tags that are always stripped entirely (including content) */
const STRIPPED_TAGS = new Set(['script', 'iframe', 'object', 'embed']);

/** Tags that are stripped but content is preserved */
const UNWRAP_TAGS = new Set(['noscript']);

/**
 * Sanitize HTML markup: strip dangerous elements and attributes.
 *
 * Dangerous vectors stripped:
 * - <script> tags (including content)
 * - Inline on* event handlers (onclick, onerror, onload, etc.)
 * - External src/href pointing to scripts (javascript: URLs)
 * - <iframe>, <object>, <embed> tags
 * - javascript: protocol in any attribute
 *
 * Preserves benign markup: divs, spans, headings, paragraphs,
 * images with safe src, links with safe href, etc.
 */
export function sanitizeMarkup(html: string): SanitizeMarkupResult {
  const report: SanitizeReport = { strippedCount: 0, stripped: [] };

  if (!html || html.length === 0) {
    return { html: '', report };
  }

  // Enforce size limit
  let input = html;
  if (input.length > MAX_HTML_INPUT_LENGTH) {
    input = input.substring(0, MAX_HTML_INPUT_LENGTH);
    report.stripped.push(`Input truncated from ${html.length} to ${MAX_HTML_INPUT_LENGTH} chars`);
    report.strippedCount++;
  }

  let result = input;

  // 1. Strip dangerous tags entirely (including content)
  for (const tag of STRIPPED_TAGS) {
    const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
    result = result.replace(re, (match) => {
      report.stripped.push(`<${tag}>: ${match.substring(0, 80)}`);
      report.strippedCount++;
      return '';
    });
    // Also strip self-closing variants
    const reSelf = new RegExp(`<${tag}\\b[^>]*/?>`, 'gi');
    result = result.replace(reSelf, (match) => {
      report.stripped.push(`<${tag}> (self-closing): ${match.substring(0, 80)}`);
      report.strippedCount++;
      return '';
    });
  }

  // 2. Strip inline on* event handlers from any remaining tags
  result = result.replace(/<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (match, tagName, attrs) => {
    let cleanedAttrs = attrs;
    let hadHandler = false;

    // Remove on* attributes
    cleanedAttrs = cleanedAttrs.replace(/\s+on[a-zA-Z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, (handlerMatch: string) => {
      report.stripped.push(`Event handler: ${handlerMatch.trim().substring(0, 60)}`);
      report.strippedCount++;
      hadHandler = true;
      return '';
    });

    // Remove javascript: in href/src/action/formaction attributes
    cleanedAttrs = cleanedAttrs.replace(/((?:href|src|action|formaction)\s*=\s*(?:"|'))javascript:[^"']*(?:"|')/gi, (jsMatch: string) => {
      report.stripped.push(`javascript: URL: ${jsMatch.substring(0, 80)}`);
      report.strippedCount++;
      return '';
    });

    // Remove javascript: in unquoted attributes
    cleanedAttrs = cleanedAttrs.replace(/((?:href|src|action|formaction)\s*=\s*)javascript:[^\s>]*/gi, (jsMatch: string) => {
      report.stripped.push(`javascript: URL (unquoted): ${jsMatch.substring(0, 80)}`);
      report.strippedCount++;
      return '';
    });

    if (hadHandler || cleanedAttrs !== attrs) {
      return `<${tagName}${cleanedAttrs}>`;
    }
    return match;
  });

  return { html: result, report };
}

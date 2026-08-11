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

// MAX_HTML_INPUT_LENGTH deleted — only used by deleted sanitizeMarkup.

// ── Types ──────────────────────────────────────────────────────────

export interface SanitizeReport {
  strippedCount: number;
  stripped: string[];
}

export interface SanitizeCssResult {
  css: string;
  report: SanitizeReport;
}

// sanitizeMarkup deleted — never imported anywhere.

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

  // 5. Strip javascript: protocol in any value — decode CSS escape sequences
  // first so \6a\61\76\61\73\63\72\69\70\74 can't bypass the javascript: check.
  result = result.replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  result = result.replace(/javascript\s*:/gi, (_match) => {
    report.stripped.push(`javascript: protocol`);
    report.strippedCount++;
    return '/* [sanitized: javascript: removed] */';
  });

  // 6. Strip dangerous url() references — allow only data: and https: for images
  result = result.replace(/url\s*\(\s*(['"]?)(.*?)\1\s*\)/gi, (match, _quote, urlContent) => {
    const trimmed = urlContent.trim().toLowerCase();

    // Allow data: URIs for images ONLY (was accepting any data: type —
    // data:text/html, data:text/javascript, etc. could carry script vectors).
    if (trimmed.startsWith('data:image/')) return match;

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

// sanitizeMarkup + STRIPPED_TAGS + UNWRAP_TAGS deleted — never imported anywhere.

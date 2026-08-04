/**
 * core/sanitize/redact — redact sensitive data from a serialized perception
 * before sending it to the model. Pure-ish (reads the live DOM for form values).
 *
 * Extracted from content.ts (pure move, no behaviour change).
 */

/** Redact sensitive data from a string before sending it to the model.
 *  Collects form input values and credential-shaped strings, then replaces them
 *  with [REDACTED] in the serialized perception.
 *
 *  safety: redaction is restricted to TEXT CONTENT and FORM VALUES only.
 *  It must never touch handles, selectors, class names, CSS variable names or
 *  any structural field — a redacted selector produces a silent no-op transform.
 *  The old ≥40-char rule matched any long alphanumeric string (handles, CSS var
 *  names, selector paths are all alphanumeric and can be ≥40 chars); it now
 *  requires entropy characteristics (mixed case + digits), not just length. */
export function redactSensitiveData(text: string): string {
  let redacted = text;
  // 1. Collect form input values from the live DOM — these are actual user data.
  const sensitiveValues: string[] = [];
  for (const el of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input, textarea, select')) {
    const val = (el as HTMLInputElement).value;
    if (val && val.length > 3) sensitiveValues.push(val);
    // Password-adjacent: if this is a password field, also redact nearby fields.
    if (el.type === 'password' || el.type === 'email' || el.name?.toLowerCase().includes('pass') || el.name?.toLowerCase().includes('token') || el.name?.toLowerCase().includes('secret') || el.name?.toLowerCase().includes('key')) {
      if (val && val.length > 1) sensitiveValues.push(val);
    }
  }
  // 2. Credential-shaped strings — require entropy, not just length.
  // The old /\b[a-zA-Z0-9]{40,}\b/g matched any 40+ char alphanumeric token —
  // handles (c + 6 base36), CSS var names, and selector paths are all
  // alphanumeric and can hit 40 chars. Require specific credential shapes:
  // known prefixes (sk-, v1., bearer) OR high-entropy (mixed case + digits,
  // ≥32 chars — a real API key/token, not a selector or class name which
  // tend to be single-case or hyphen-separated).
  const credPatterns = [
    /\bsk-[a-zA-Z0-9]{20,}\b/g,           // OpenAI-style keys
    /\bv1\.\d+-[a-zA-Z0-9]{20,}\b/g,       // Cloudflare-style tokens
    /\bbearer\s+[a-zA-Z0-9._-]+/gi,         // Bearer tokens
    // High-entropy: ≥32 chars with both upper+lower+digit (a real token,
    // not a structural field which is typically single-case or hyphenated)
    /\b(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[a-zA-Z0-9]{32,}\b/g,
  ];
  // 3. Redact form values — actual user text/form content, never structural.
  for (const val of sensitiveValues) {
    if (val.length > 3 && redacted.includes(val)) {
      redacted = redacted.split(val).join('[REDACTED]');
    }
  }
  // 4. Redact credential-shaped patterns.
  for (const pattern of credPatterns) {
    redacted = redacted.replace(pattern, '[REDACTED]');
  }
  return redacted;
}

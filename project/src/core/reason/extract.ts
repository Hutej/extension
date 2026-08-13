/**
 * core/reason/extract — tolerant JSON extraction from a model response.
 *
 * Extracted into its own dependency-free module (Phase 2.5 TASK1, per the
 * adversarial review wf_e3e50d92 finding) so tests/parse-extract-test.ts can
 * import the REAL extractor instead of an inlined copy. Pure: no imports,
 * no DOM, no fetch — safe to load directly under Node --experimental-strip-types
 * (no directory imports, no config dependency).
 *
 * Built from REAL captured outputs (proof/parse-failures/REAL-*.txt +
 * proof/transport-capture*.json), NOT a guess. Across 14 real calls the model
 * almost always returns bare valid JSON; the only non-bare shapes observed
 * were: (a) pretty-printed multi-line JSON (JSON.parse handles), (b) a
 * ```json fence (the old code handled), and (c) timeouts (no content at all —
 * handled before this function). No prose-around-JSON, truncation, or
 * multiple objects appeared — but (c)/(d) below guard them cheaply anyway.
 *
 * Order (smallest correct fix; no giant regex over the whole response):
 *  1. JSON.parse(content) — the common case.
 *  2. Strip a ```json / ``` fence and parse the inner text.
 *  3. Find the first balanced {...} object (handles prose-around + trailing
 *     text) and parse it. Balanced scan (not a regex) so strings containing
 *     braces/quotes don't fool it.
 *  4. Give up — return {ok:false, error} so the loop's retry/failure path runs.
 */
export function extractJson(content: string): { ok: true; json: unknown } | { ok: false; error: string } {
  // 1. Bare JSON.
  try { return { ok: true, json: JSON.parse(content) }; } catch { /* try next */ }
  // 2. Markdown code fence (```json ... ``` or ``` ... ```).
  const mdMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (mdMatch) {
    try { return { ok: true, json: JSON.parse(mdMatch[1].trim()) }; } catch { /* try next */ }
  }
  // 3. First balanced {...} object — handles prose around JSON and trailing
  //    text. Scans for the first '{', then counts braces (respecting strings)
  //    to find the matching '}'. Bounded by content length.
  //    Adversarial review (wf_e3e50d92, skeptic claim_2): a '{...}' in PROSE
  //    before the real JSON (e.g. "I will use the {selector} pattern:\n{...real
  //    JSON...}") defeats a first-'{' strategy — balancedObject returns the
  //    prose brace, JSON.parse fails, and we never reach the valid object. Fix:
  //    try EVERY balanced object in order, not just the first. The real JSON
  //    is the first one that parses. (Bounded: a typical response has few.)
  let searchFrom = 0;
  while (true) {
    const start = content.indexOf('{', searchFrom);
    if (start < 0) break;
    const slice = balancedObject(content, start);
    if (slice) {
      try { return { ok: true, json: JSON.parse(slice) }; } catch { /* not JSON — try the next '{' */ }
    }
    searchFrom = start + 1; // advance past this '{' even if unbalanced, to find a later one
  }
  return { ok: false, error: 'Model output was not valid JSON.' };
}

/** Find the balanced '{...}' object starting at index `start` (which must be a
 *  '{'). Respects string literals (single/double/backtick) and escapes so a
 *  brace inside a string value doesn't end the object early. Returns the
 *  object substring, or null if unbalanced (e.g. truncated). */
export function balancedObject(s: string, start: number): string | null {
  let depth = 0;
  let inStr: false | '"' | "'" | '`' = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (inStr) {
      if (ch === inStr) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
      if (depth < 0) return null; // malformed
    }
  }
  return null; // unbalanced (truncated)
}

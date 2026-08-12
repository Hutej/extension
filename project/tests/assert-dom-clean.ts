/**
 * tests/assert-dom-clean — the canonical DOM comparison for F3 REVERSAL.
 *
 * assertDomClean verifies that on→off→on→off leaves the DOM byte-identical to
 * the original (at BOTH offs). The old check (harness.ts) only counted
 * [data-revueon-inserted] elements — it passed while text, attributes, children,
 * ordering, and CSS all changed. This one captures a normalized STRUCTURAL
 * fingerprint of the body and compares byte-identical.
 *
 * ── What the fingerprint INCLUDES (catches real changes) ──
 *   - tagName (lowercase)
 *   - all attributes EXCEPT a small denylist (see below) — catches class/id/
 *     role/href/src/alt/aria-* and non-revueon data-* changes
 *   - child count AND child ORDER (positional)
 *   - text content of text nodes (trimmed, whitespace-collapsed) — catches setText
 *   - the tag-tree shape (parent→child nesting)
 *
 * ── What the fingerprint EXCLUDES (runtime noise, not changes we made) ──
 *   - Revueon-owned nodes entirely: [data-revueon-inserted], [data-rv-c],
 *     [data-rv-wrap], #revueon-style, #revueon-escape-ui (a leftover inserted
 *     node is invisible here — a SEPARATE count-==0 assertion catches that)
 *   - the `style` attribute globally — Revueon's hide uses USER-origin CSS, not
 *     inline style, so a display:none we add never touches inline style. Excluding
 *     it avoids false failures from the site's own dynamic inline-style churn.
 *     (Documented gap: a third-party inline-style mutation would be missed.)
 *   - form control `value`/`checked` — autofill/user-input noise
 *   - <script> and <style> element TEXT (dynamic) — keep their presence/attrs
 *
 * The comparator is a normalized string: tag[attr,attr](child,child)[:text]
 * with sorted attrs. assertDomClean compares the baseline fingerprint to the
 * post-off fingerprint byte-identical. on→off→on→off requires the TWO off-
 * fingerprints to equal the baseline AND each other.
 *
 * Shared by tests/harness.ts (run6-toggle-cycle) and tests/phase2-reversal.ts.
 */

/** The fingerprint function, serialized for page.evaluate as an IIFE (a bare
 *  `return` at the top level is a SyntaxError; the IIFE wraps it). Self-contained
 *  — no closures, no imports — so it can be stringified and run in the page.
 *
 *  [data-revueon-inserted] nodes are INCLUDED (so an insert is detectable: the
 *  baseline has none, the on-state has one, the off-state after undoAll has
 *  none again == baseline). The perception/structural stamps data-rv-c and
 *  data-rv-wrap are excluded (they're Revueon's own markers, not mutations we
 *  test for byte-identity). The `style` attribute is excluded globally (CSS is
 *  at user origin; inline-style churn is noise). */
export const FINGERPRINT_FN = `
(function () {
function fingerprint(el) {
  // Exclude Revueon's own perception/structural stamps + UI nodes — but INCLUDE
  // [data-revueon-inserted] nodes so an insert is detectable.
  const b = el.getAttribute ? el.getAttribute('data-rv-c') : null;
  const c = el.getAttribute ? el.getAttribute('data-rv-wrap') : null;
  const id = el.id || '';
  if (b || c || id === 'revueon-style' || id === 'revueon-escape-ui') return '';
  const tag = (el.tagName || '').toLowerCase();
  // Attributes, except the denylist (style is global noise; rv stamps are ours).
  const deny = new Set(['style', 'data-rv-c', 'data-rv-wrap']);
  const attrs = [];
  if (el.attributes) {
    for (let i = 0; i < el.attributes.length; i++) {
      const an = el.attributes[i].name;
      if (deny.has(an)) continue;
      attrs.push(an + '=' + el.attributes[i].value);
    }
  }
  attrs.sort();
  const attrStr = attrs.length ? '[' + attrs.join(',') + ']' : '';
  // Text content of direct text nodes (trimmed, whitespace-collapsed) — catches
  // setText. <script>/<style> text is dynamic, so skip those tags' text.
  let text = '';
  if (tag !== 'script' && tag !== 'style' && el.childNodes) {
    const parts = [];
    for (let i = 0; i < el.childNodes.length; i++) {
      const n = el.childNodes[i];
      if (n.nodeType === 3) {
        const t = (n.textContent || '').replace(/\\s+/g, ' ').trim();
        if (t) parts.push(t);
      }
    }
    if (parts.length) text = ':' + parts.join(' ');
  }
  // Children (recursively), skipping excluded ones.
  const kids = [];
  if (el.children) {
    for (let i = 0; i < el.children.length; i++) {
      const k = fingerprint(el.children[i]);
      if (k) kids.push(k);
    }
  }
  const kidStr = kids.length ? '(' + kids.join(',') + ')' : '';
  return tag + attrStr + text + kidStr;
}
return fingerprint(document.body);
})();
`;

/** Count of Revueon-inserted nodes still in the DOM — must be 0 after an off.
 *  (The fingerprint excludes them, so this is the leakage check.) */
export const COUNT_INSERTED_FN = `
(function () { return document.querySelectorAll('[data-revueon-inserted]').length; })();
`;

/** Capture a body fingerprint in the page. */
export async function captureFingerprint(page: any): Promise<string> {
  return page.evaluate(FINGERPRINT_FN);
}

/** Count [data-revueon-inserted] nodes in the page. */
export async function countInserted(page: any): Promise<number> {
  return page.evaluate(COUNT_INSERTED_FN) as Promise<number>;
}

/** Assert the DOM is clean against a baseline fingerprint (byte-identical)
 *  AND that no Revueon-inserted node remains. Throws loudly on mismatch. */
export async function assertDomClean(page: any, baseline: string, label: string): Promise<void> {
  const fp = await captureFingerprint(page);
  const inserted = await countInserted(page);
  if (fp !== baseline) {
    // Show a bounded diff for diagnosis (first 600 chars of each).
    const a = baseline.slice(0, 600);
    const b = fp.slice(0, 600);
    throw new Error(
      `[${label}] DOM NOT CLEAN — fingerprint differs from baseline.\n` +
      `  baseline[0..600]: ${a}\n  current[0..600]:  ${b}`,
    );
  }
  if (inserted !== 0) {
    throw new Error(`[${label}] DOM NOT CLEAN — ${inserted} [data-revueon-inserted] node(s) remain.`);
  }
}

/** Stability check: capture two fingerprints ~1s apart with NO action. If they
 *  differ, the page has runtime noise the fingerprint doesn't exclude — the
 *  on→off→on→off test would false-fail, so this is a control pair. */
export async function assertFingerprintStable(page: any, label: string, waitMs = 1000): Promise<void> {
  const a = await captureFingerprint(page);
  await new Promise<void>((r) => setTimeout(r, waitMs));
  const b = await captureFingerprint(page);
  if (a !== b) {
    throw new Error(
      `[${label}] fingerprint is NOT stable without action — runtime noise not excluded.\n` +
      `  first[0..400]: ${a.slice(0, 400)}\n  second[0..400]: ${b.slice(0, 400)}\n` +
      `  (widen the exclude list in assert-dom-clean.ts or pick a more stable test region)`,
    );
  }
}

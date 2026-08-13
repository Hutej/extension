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
 *  AND that no Revueon-inserted node remains. Throws loudly on mismatch.
 *
 * ── BLIND SPOTS — what assertDomClean does NOT guarantee (Phase 2.5 TASK7) ──
 * assertDomClean() DOES NOT mean "the entire webpage is guaranteed unchanged."
 * It means: the structural fingerprint (tag + attrs-except-denylist + child-order
 * + trimmed-text) matches the baseline AND no [data-revueon-inserted] node
 * remains. The following mutations can therefore ESCAPE detection. Each is
 * verified against the code in FINGERPRINT_FN above; a known-blind test pins it
 * in tests/assert-dom-clean-blindspots-test.ts.
 *
 * 1. THE `style` ATTRIBUTE (globally excluded — denylist line ~58). Why: Revueon's
 *    hide uses USER-origin CSS, not inline style, so a display:none we add never
 *    touches inline style; excluding it avoids false failures from the site's
 *    own dynamic inline-style churn. Blind spot: a THIRD-PARTY (or a buggy
 *    Revueon act) that mutates an element's inline `style="..."` attribute is
 *    invisible to the fingerprint. Partial mitigation: insert leakage is
 *    caught by the count-==0 check; CSS-origin changes are caught at the
 *    computed-style level by assertApplied, not here.
 *
 * 2. FORM CONTROL VALUES (user input / JS-set .value / .checked). Why: the
 *    fingerprint captures ATTRIBUTES (so an HTML `value="..."` attribute or a
 *    `checked` attribute is included), but a user typing into an <input> updates
 *    the element's .value PROPERTY, not its attribute — and JS setting
 *    `el.value = 'x'` likewise does not update the attribute. Blind spot: any
 *    mutation that changes a form control's value/checked/capability via the
 *    property API (the common path) is invisible. This is the exclusion the
 *    header comment named "form control value/checked"; the code does not strip
 *    these attributes, so attribute-level values ARE caught but property-level
 *    values are not.
 *
 * 3. <script> / <style> ELEMENT TEXT (excluded — line ~72). Why: these are
 *    dynamic (script re-injects itself, CSS-in-JS churns inline stylesheets).
 *    Their PRESENCE, TAG, and ATTRIBUTES are fingerprinted; only their TEXT is
 *    not. Blind spot: a mutation that rewrites a <script>'s body or a <style>'s
 *    rules in place (same element, new text) is invisible.
 *
 * 4. Revueon's OWN MARKERS (data-rv-c, data-rv-wrap, #revueon-style,
 *    #revueon-escape-ui — excluded entirely, lines ~52-55). Why: these are
 *    Revueon's perception/structural stamps and UI chrome, not mutations under
 *    test. Blind spot: irrelevant for user-visible mutation, but a test that
 *    expected these stamps to be stable would not catch their churn.
 *    [data-revueon-inserted] is NOT excluded — it is INCLUDED so an insert is
 *    detectable (baseline has none → on has one → off has none == baseline).
 *
 * 5. TEXT-NODE WHITESPACE (collapsed — line ~77). The fingerprint collapses
 *    runs of whitespace to a single space and trims. Why: avoid false failures
 *    from reflow-induced whitespace changes. Blind spot: a mutation that only
 *    changes whitespace (indentation, line wrapping) is invisible.
 *
 * 6. ATTRIBUTE ORDER (sorted — line ~67). Attributes are sorted before
 *    fingerprinting. Why: round-tripping through HTML parsers can reorder
 *    attributes. Blind spot: a mutation that only reorders an element's
 *    attributes is invisible.
 *
 * The fingerprint DOES catch: tag changes, added/removed attributes (except
 * `style`), added/removed/REORDERED children, setText (direct text-node
 * content), and the tag-tree shape. The count-==0 check catches inserted-node
 * leakage that the fingerprint (which includes inserted nodes) would otherwise
 * show as a structural change.
 */
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

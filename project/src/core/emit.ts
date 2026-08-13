/**
 * core/emit — structured CSS emitter. No regex on CSS values.
 *
 * B: The emitter's input is structured rules, never a CSS string that gets
 * post-processed. !important is appended at serialisation, per declaration,
 * from the flag — never by scanning a value. At-rules are a separate type
 * and never receive !important on their inner declarations.
 *
 * A: CSS is inserted at the USER origin via chrome.scripting.insertCSS from
 * the background worker. No @layer wrapping — user origin beats author
 * origin unconditionally (for same importance level). No style node.
 */

// ── Types ─────────────────────────────────────────────────────────

export type EmitItem =
  | { kind: 'style'; selector: string; declarations: Array<{ property: string; value: string }>; important?: boolean }
  | { kind: 'at'; prelude: string; items: EmitItem[] };

// ── Serialiser ─────────────────────────────────────────────────────

/** Serialise EmitItem[] to a CSS string. !important comes from the flag. */
export function serializeEmit(items: EmitItem[]): string {
  return items.map(serializeItem).join('\n');
}

function serializeItem(item: EmitItem): string {
  if (item.kind === 'style') {
    const imp = item.important ? ' !important' : '';
    const decls = item.declarations
      .map(d => `  ${d.property}: ${d.value}${imp};`)
      .join('\n');
    return `${item.selector} {\n${decls}\n}`;
  }
  // at-rule: @media, @supports, @keyframes — inner rules never get !important
  const inner = item.items.map(serializeItem).join('\n');
  return `${item.prelude} {\n${inner}\n}`;
}

// ── Parser (CSSOM — the browser's real CSS parser) ────────────────

/** Parse a raw CSS string into EmitItem[] using the browser's CSSOM.
 *  Strips @layer wrappers — at user origin we don't need layers. */
export function parseCss(css: string): EmitItem[] {
  if (!css?.trim()) return [];
  const sheet = new CSSStyleSheet();
  try { sheet.replaceSync(css); } catch { return []; }
  return extractFromRules(sheet.cssRules);
}

function extractFromRules(rules: CSSRuleList): EmitItem[] {
  const items: EmitItem[] = [];
  for (const rule of rules as any) {
    if (rule instanceof CSSStyleRule) {
      const declarations: Array<{ property: string; value: string }> = [];
      let anyImportant = false;
      const style = rule.style;
      for (let i = 0; i < style.length; i++) {
        const prop = style.item(i);
        const value = style.getPropertyValue(prop);
        if (style.getPropertyPriority(prop) === 'important') anyImportant = true;
        declarations.push({ property: prop, value });
      }
      if (declarations.length > 0) {
        items.push({ kind: 'style', selector: rule.selectorText, declarations, important: anyImportant || undefined });
      }
    } else if (rule instanceof CSSLayerBlockRule) {
      // Strip @layer — flatten its inner rules into the top level.
      items.push(...extractFromRules(rule.cssRules));
    } else if (rule instanceof CSSMediaRule) {
      const inner = extractFromRules(rule.cssRules);
      if (inner.length) items.push({ kind: 'at', prelude: `@media ${rule.conditionText || rule.media.mediaText}`, items: inner });
    } else if (rule instanceof CSSSupportsRule) {
      const inner = extractFromRules(rule.cssRules);
      if (inner.length) items.push({ kind: 'at', prelude: `@supports ${rule.conditionText}`, items: inner });
    } else if (rule instanceof CSSKeyframesRule) {
      items.push({ kind: 'at', prelude: `@keyframes ${rule.name}`, items: extractKeyframes(rule) });
    }
    // ponytail: other at-rules (@font-face, @page) are rare; skip silently.
  }
  return items;
}

function extractKeyframes(rule: CSSKeyframesRule): EmitItem[] {
  const items: EmitItem[] = [];
  for (const kf of rule.cssRules as any) {
    if (kf instanceof CSSKeyframeRule) {
      const declarations: Array<{ property: string; value: string }> = [];
      const style = kf.style;
      for (let i = 0; i < style.length; i++) {
        const prop = style.item(i);
        declarations.push({ property: prop, value: style.getPropertyValue(prop) });
      }
      // Keyframe keyText can be "0", "100%", "from", "to", "0%, 50%"
      items.push({ kind: 'style', selector: kf.keyText, declarations });
    }
  }
  return items;
}

// ── Emit helpers ──────────────────────────────────────────────────
// (Phase 2.5: removed dead `emitCss`/`emitRules` wrappers — the live path is
// `parseCss` + `serializeEmit` + `primaryTarget`, called from tools/act.ts.
// The wrappers were exported but never imported; the widened audit-wiring
// caught them. Do not reintroduce convenience wrappers without a consumer.)

/** Pick the primary selector + ALL declared properties from EmitItem[] for
 *  assertApplied. Returns every longhand of the first style rule's first
 *  selector — because CSSOM expands shorthands (e.g. `background: red` → 10
 *  longhands with `background-image` first, which stays `none` while
 *  `background-color` turns red). Asserting only declarations[0] reads the
 *  wrong property and reports applied:false on a successful application. */
export function primaryTarget(items: EmitItem[]): { selector: string; properties: string[] } | null {
  for (const item of items) {
    if (item.kind === 'style' && item.declarations.length > 0) {
      return { selector: item.selector.split(',')[0].trim(), properties: item.declarations.map((d) => d.property) };
    }
    if (item.kind === 'at') {
      const inner = primaryTarget(item.items);
      if (inner) return inner;
    }
  }
  return null;
}

/**
 * core/compile — DesignSpec -> concrete, safe CSS. Pure.
 *
 * Enforces the safety laws as a pipeline stage:
 *   - only targets handles that exist in the live perception (or "canvas")
 *   - overrides :root variables first (specificity-war-free backdoor)
 *   - paints the canvas, then each discovered component
 *   - per rule, co-emits PAINT (capabilities/style) and LAYOUT (capabilities/structure)
 *     into the same selector block
 *   - base-coat harmonizer: ALL unaccounted clashing clusters get a safety-net
 *     repaint derived from the canvas (not just ≤12 skeleton regions)
 */

import type { DesignSpec, StyleDecls, LayoutDecls } from '../spec';
import type { Perception, Cluster } from '../perceive';
import { buildDeclarations } from '../capabilities/style/index.ts';
import { buildLayoutDeclarations } from '../capabilities/structure/index.ts';
import { isSafeValue, MAX_HIDDEN_WIDTH_RATIO, MAX_HIDDEN_HEIGHT_PX, MAX_HIDDEN_MEMBERS, MAX_ACCENT_FRACTION, luminanceCompatible, assertNoRawPxSizing } from '../laws/index.ts';
import { parseColor, colorfulness, pickReadableText } from '../../shared/color.ts';

export interface CompileOptions {
  forceContrast?: boolean;
  dropPadding?: boolean;
  dropSizing?: boolean;
  dropLayout?: boolean;   // last-resort overflow repair: paint only, no structural CSS (design collapses)
  dropHides?: boolean;    // repair: strip hide rules when primary content vanished
  trimAccent?: boolean;   // repair: strip accent bg from repeated/low-prominence clusters (over-accent)
  clampTargets?: string[]; // targeted overflow repair: strip growth-sizing on ONLY these offending clusters
  contrastTargets?: string[]; // targeted contrast repair: force readable text on ONLY these flagged handles
  contrastTargetBgs?: Record<string, string>; // effective bg each flagged handle's text sits on (from verify's parent-chain walk)
  wordBreakTargets?: string[]; // targeted bleed repair: overflow-wrap on ONLY these bleeding clusters (Mech 3)
  clipOverflowTargets?: string[]; // targeted bleed repair: overflow-x:clip on clusters where word-break didn't fix the bleed
  squeezeTargets?: string[];  // targeted squeeze repair: drop columnCount + relax width on ONLY these squeezed clusters (Fix 3)
  collapseTargets?: string[]; // targeted collapse repair: drop layout on ONLY these collapsed regions (preserves the rest of the design)
  paletteMode?: 'restrained' | 'vivid'; // declared palette intent — vivid lifts the area cap (Mech 4)
}

const ACCENT_STRIP_KEYS = ['background', 'backgroundColor', 'backgroundImage', 'color'];

export interface CompileResult {
  css: string;
  rulesEmitted: number;
  invalidTargets: string[];
  droppedProps: string[];
  baseCoatCount: number;       // clusters base-coated by the harmonizer
}

const PADDING_KEYS = ['padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'];

export function compileSpec(spec: DesignSpec, perception: Perception, opts: CompileOptions = {}): CompileResult {
  const byHandle = new Map<string, Cluster>();
  for (const c of perception.clusters) byHandle.set(c.handle, c);

  const blocks: string[] = [];
  const invalidTargets: string[] = [];
  const droppedProps: string[] = [];
  let rulesEmitted = 0;
  let baseCoatCount = 0;

  const canvasText = firstNonEmpty(spec.canvas?.color, perception.canvas.color);
  // Effective page backdrop: the spec's chosen canvas bg, else the site's original.
  // Used both for the forceContrast text floor and rule-level contrast repair.
  const canvasBg = firstNonEmpty(spec.canvas?.background, perception.canvas.bg);
  // Which accent-painting clusters keep their background (over-accent repair).
  const accentKeep = opts.trimAccent ? planAccentKeep(spec, byHandle, perception, opts) : null;

  // 1) :root variable overrides.
  if (spec.variables) {
    const varDecls: string[] = [];
    for (const [name, value] of Object.entries(spec.variables)) {
      if (!name.startsWith('--')) continue;
      const v = String(value).trim();
      if (!isSafeValue(v)) continue;
      varDecls.push(`  ${name}: ${v} !important;`);
    }
    if (varDecls.length) blocks.push(`:root {\n${varDecls.join('\n')}\n}`);
  }

  // 2) Canvas (html/body): paint + base layout.
  // Also emitted when forceContrast is set (even with no spec.canvas) so the
  // body-level text floor below always has a home.
  if (spec.canvas || spec.canvasLayout || opts.forceContrast) {
    const decls: string[] = [];
    if (spec.canvas) {
      const styles = opts.dropPadding ? stripKeys(spec.canvas, PADDING_KEYS) : spec.canvas;
      const r = buildDeclarations(styles, { mode: 'base', defaultText: canvasText, forceContrast: opts.forceContrast, contrastBg: canvasBg, containerWidthPx: perception.viewport.w, varMap: perception.cssVarMap });
      droppedProps.push(...r.dropped);
      decls.push(...r.decls);
    }
    if (spec.canvasLayout && !opts.dropLayout) {
      const r = buildLayoutDeclarations(spec.canvasLayout, { isConstraintOwner: true, ownsTarget: false, dropSizing: opts.dropSizing });
      droppedProps.push(...r.dropped);
      decls.push(...r.decls);
    }
    // forceContrast body floor: text that inherits from body (i.e. NOT covered by
    // any cluster rule) must be readable against the canvas backdrop. Root cause
    // of the old no-op: forceContrast only touched rules that set a background, so
    // uncovered text stayed dark-on-dark. Appended last -> wins the block's color.
    if (opts.forceContrast) {
      const parsed = parseColor(canvasBg);
      const readable = parsed ? pickReadableText(parsed) : canvasText;
      if (readable) decls.push(`color: ${readable} !important;`);
    }
    // ponytail: overflow-x:clip prevents horizontal scrollbar WITHOUT affecting
    // overflow-y (unlike overflow-x:hidden which forces overflow-y:auto per CSS
    // spec, potentially clipping content). clip is supported in Chrome 90+.
    if (spec.canvas?.background) {
      decls.push('overflow-x: clip !important;');
    }
    if (decls.length) { blocks.push(`html, body {\n${indent(decls)}\n}`); rulesEmitted++; }

    // Opaque-wrapper neutralization: when a deliberate canvas background is set,
    // any large solid-bg wrapper covering the full viewport would hide it. Make
    // those transparent so the backdrop shows through.
    // Reason to override: the research docs said "don't touch layout / keep minimal"
    // but this is exactly what makes glass/backdrop aesthetics work on wrapper sites.
    if (spec.canvas?.background && perception.opaqueWrappers.size > 0) {
      const selectors = [...perception.opaqueWrappers]
        .map((h) => byHandle.get(h)?.selector)
        .filter(Boolean) as string[];
      if (selectors.length) {
        blocks.push(`${selectors.join(',\n')} {\n  background: transparent !important;\n}`);
      }
    }
  }

  // 2.5) Composition rules — region-level proportions, compiled FIRST so the
  // macro structure is established before component paint. Same laws pipeline as
  // component rules; just earlier in the cascade so component rules can override.
  const hideSelectors: string[] = [];
  if (spec.composition && !opts.dropLayout) {
    for (const rule of spec.composition) {
      const cluster = byHandle.get(rule.target);
      if (!cluster) { invalidTargets.push(rule.target); continue; }
      if (rule.hide && !opts.dropHides) {
        const refusal = hideRefusal(cluster);
        if (refusal) { droppedProps.push(`composition.hide(${rule.target}:${refusal})`); }
        else { hideSelectors.push(cluster.selector); }
        continue;
      }
      const decls: string[] = [];
      if (rule.styles) {
        const styles = stripImageBg(rule.styles, cluster.style.hasBgImage, droppedProps, rule.target);
        const r = buildDeclarations(styles, { mode: 'base', defaultText: canvasText, forceContrast: opts.forceContrast, contrastBg: canvasBg, containerWidthPx: cluster.rect.w, varMap: perception.cssVarMap });
        droppedProps.push(...r.dropped);
        decls.push(...r.decls);
      }
      if (rule.layout && !opts.collapseTargets?.includes(rule.target)) {
        const clampThis = opts.dropSizing || (opts.clampTargets?.includes(rule.target) ?? false) || (opts.squeezeTargets?.includes(rule.target) ?? false);
        const r = buildLayoutDeclarations(rule.layout, {
          isConstraintOwner: cluster.layout.isContainer ?? false,
          ownsTarget: cluster.layout.constraintOwnerHandle != null,
          isPassiveWrapper: cluster.layout.isPassiveWrapper ?? false,
          dropSizing: clampThis,
          containerWidthPx: cluster.rect.w,
        });
        droppedProps.push(...r.dropped);
        decls.push(...r.decls);
        // ponytail: NO preventive overflow-wrap on narrowed containers. `anywhere`
        // collapses min-content to 1 char, letting flex/grid squeeze text columns
        // to a few characters and break every word ("PROTES TS IN UKRAIN E's").
        // Genuine bleeds are caught by verify's bleedTargets and repaired with
        // break-word (last-resort only) — see the wordBreakTargets block below.
      }
      if (decls.length) { blocks.push(`${cluster.selector} {\n${indent(decls)}\n}`); rulesEmitted++; }
    }
  }

  // 3) Component rules.
  for (const rule of spec.rules) {
    const isCanvas = rule.target === 'canvas' || rule.target === 'root';
    const cluster = isCanvas ? undefined : byHandle.get(rule.target);
    if (!isCanvas && !cluster) { invalidTargets.push(rule.target); continue; }
    const selector = isCanvas ? 'html, body' : cluster!.selector;
    const cl = cluster?.layout;

    // Hide channel — removal is a design decision, with guards so the model can
    // prune chrome but never delete the page. Refusals are logged like dropped
    // props; verify's notBlank + coverage back these guards up at runtime.
    if (rule.hide && !opts.dropHides) {
      if (isCanvas || !cluster) {
        droppedProps.push(`hide(${rule.target}:canvas-refused)`);
      } else {
        const refusal = hideRefusal(cluster);
        if (refusal) {
          droppedProps.push(`hide(${rule.target}:${refusal})`);
        } else {
          hideSelectors.push(selector);
          continue; // hidden — paint/layout on this rule is moot
        }
      }
    }

    const decls: string[] = [];

    if (rule.styles) {
      let styles = opts.dropPadding ? stripKeys(rule.styles, PADDING_KEYS) : rule.styles;
      // Over-accent repair: this cluster is not in the keep-set — strip its accent
      // background (and the coupled text color, which would be unreadable on the
      // canvas). Deliberate accent blocks stay; repeated/low-prominence ones calm down.
      if (accentKeep && !accentKeep.has(rule.target)) { styles = stripKeys(styles, ACCENT_STRIP_KEYS); droppedProps.push(`trimAccent(${rule.target})`); }
      // Content-image protection: a cluster whose own bg is a url() image (thumbnail)
      // must never receive a solid background (would paint over the image).
      styles = stripImageBg(styles, cluster?.style.hasBgImage ?? false, droppedProps, rule.target);
      const r = buildDeclarations(styles, {
        mode: 'base',
        isNativeControl: cluster?.isNativeControl,
        isCheckboxRadio: cluster?.isCheckboxRadio,
        defaultText: canvasText,
        forceContrast: opts.forceContrast,
        contrastBg: canvasBg,
        containerWidthPx: cluster?.rect.w,
        varMap: perception.cssVarMap,
      });
      droppedProps.push(...r.dropped);
      decls.push(...r.decls);
    }

    if (rule.layout && !opts.dropLayout && !opts.collapseTargets?.includes(rule.target)) {
      // Targeted overflow repair: strip growth-sizing on ONLY the offending
      // clusters, leaving every other cluster's layout intact (vs the blanket
      // dropLayout that collapsed the whole redesign into a recolor).
      // Squeeze targets: also strip columnCount (the squeeze cause) and relax width.
      const clampThis = opts.dropSizing || (opts.clampTargets?.includes(rule.target) ?? false);
      const squeezeThis = opts.squeezeTargets?.includes(rule.target) ?? false;
      let layoutInput = rule.layout;
      if (squeezeThis) {
        layoutInput = stripKeys(layoutInput, ['columnCount', 'width', 'maxWidth', 'minWidth', 'flexBasis']);
        droppedProps.push(`squeeze(${rule.target})`);
      }
      const r = buildLayoutDeclarations(layoutInput, {
        isConstraintOwner: cl?.isContainer ?? false,
        ownsTarget: cl?.constraintOwnerHandle != null,
        isPassiveWrapper: cl?.isPassiveWrapper ?? false,
        dropSizing: clampThis,
        containerWidthPx: cluster?.rect.w,
      });
      droppedProps.push(...r.dropped);
      decls.push(...r.decls);
      // ponytail: NO preventive overflow-wrap on narrowed containers (see
      // composition-rule note above). `anywhere` was destroying prose by
      // collapsing min-content; bleeds are repaired targeted, post-verify.
    }

    if (decls.length) { blocks.push(`${selector} {\n${indent(decls)}\n}`); rulesEmitted++; }

    if (rule.hover) {
      const r = buildDeclarations(withTransition(rule.hover), { mode: 'interaction', defaultText: canvasText });
      droppedProps.push(...r.dropped);
      if (r.decls.length) { blocks.push(`${selector}:hover {\n${indent(r.decls)}\n}`); rulesEmitted++; }
    }
    if (rule.focusVisible) {
      const r = buildDeclarations(rule.focusVisible, { mode: 'interaction', defaultText: canvasText });
      droppedProps.push(...r.dropped);
      if (r.decls.length) { blocks.push(`${selector}:focus-visible {\n${indent(r.decls)}\n}`); rulesEmitted++; }
    }
  }

  // 3b) Emit accepted hides as one block.
  if (hideSelectors.length) {
    blocks.push(`${hideSelectors.join(',\n')} {\n  display: none !important;\n}`);
    rulesEmitted += hideSelectors.length;
  }

  // 3c) Targeted contrast repair (Fix 2). The sampler flagged these SPECIFIC
  // handles as still low-contrast after the body floor — a text element sitting
  // on a dark block the model painted, whose own color stayed dark. Force a
  // readable text color computed against that cluster's ACTUAL painted background
  // (rule bg > original bg > canvas). Emitted LAST so it wins source-order over
  // the cluster's own color rule.
  if (opts.forceContrast && opts.contrastTargets?.length) {
    const specBg = new Map<string, string>();
    for (const rule of spec.rules) {
      const bg = rule.styles?.background ?? rule.styles?.backgroundColor ?? rule.styles?.backgroundImage;
      if (bg) specBg.set(rule.target, bg);
    }
    const canvasParsed = parseColor(canvasBg);
    for (const h of new Set(opts.contrastTargets)) {
      const cl = byHandle.get(h);
      if (!cl) continue;
      // Priority: the EFFECTIVE bg verify's parent-chain walk captured (the real
      // surface the text sits on — usually an ancestor's painted panel, not the
      // handle's own bg), then the rule's bg, then the cluster's original bg, then canvas.
      const parsed = parseColor(opts.contrastTargetBgs?.[h] ?? specBg.get(h) ?? cl.style.background) ?? canvasParsed;
      const readable = parsed ? pickReadableText(parsed) : '#111111';
      blocks.push(`${cl.selector} {\n  color: ${readable} !important;\n}`);
      rulesEmitted++;
    }
  }

  // 3d) Targeted word-break repair. Bleeding clusters (long unbreakable strings
  // in a narrowed container with overflow:visible) get overflow-wrap:break-word
  // directly on their selector. break-word breaks a word ONLY as a last resort
  // (when it cannot fit on its own line) and PRESERVES min-content = longest
  // word, so it fixes genuine unbreakable tokens (URLs, code identifiers) without
  // destroying normal prose and without re-introducing the column squeeze.
  // Emitted late so it wins source-order. Free, deterministic, before structural
  // repair. `anywhere` was used here before — it collapsed min-content to 1 char
  // and let flex/grid squeeze every column to a few characters (BBC mutilation).
  if (opts.wordBreakTargets?.length) {
    for (const h of new Set(opts.wordBreakTargets)) {
      const cl = byHandle.get(h);
      if (!cl) continue;
      blocks.push(`${cl.selector} {\n  overflow-wrap: break-word !important;\n}`);
      rulesEmitted++;
    }
  }

  // 3d-b) Targeted clip repair. When word-break didn't fix the bleed (caused by
  // white-space:nowrap children or fixed-width elements that can't wrap), clip
  // the overflow on those clusters. Less destructive than dropLayout — preserves
  // the entire layout, only clips the bleeding cluster's horizontal overflow.
  if (opts.clipOverflowTargets?.length) {
    for (const h of new Set(opts.clipOverflowTargets)) {
      const cl = byHandle.get(h);
      if (!cl) continue;
      blocks.push(`${cl.selector} {\n  overflow-x: clip !important;\n}`);
      rulesEmitted++;
    }
  }

  // 3e) Base-coat harmonizer. After all model rules, for each cluster NOT
  // addressed (rule/hide/composition) AND not luminance-compatible with the
  // canvas, emit a safety-net repaint. All clashing unaccounted clusters get
  // the same base tone + readable text, grouped into ONE CSS rule for efficiency.
  // No border/shadow/radius stripping — preserve original character. Model rules
  // are earlier in the cascade so they win source-order. This kills white strips
  // on dark canvases where the model didn't target that cluster.
  if (spec.canvas?.background && !opts.dropLayout) {
    const addressed = new Set<string>();
    for (const rule of spec.rules) {
      if (rule.styles || rule.layout || rule.hover || rule.focusVisible || rule.hide) addressed.add(rule.target);
    }
    if (spec.composition) {
      for (const rule of spec.composition) {
        if (rule.styles || rule.layout || rule.hide) addressed.add(rule.target);
      }
    }
    const baseTone = deriveBaseTone(canvasBg);
    const baseText = pickReadableText(parseColor(baseTone) ?? [255, 255, 255, 1]);
    const coatSelectors: string[] = [];
    for (const cl of perception.clusters) {
      if (addressed.has(cl.handle)) continue;
      if (!cl.hasSolidBg) continue;               // transparent — shows canvas, no clash
      if (cl.style.hasBgImage) continue;          // content image — never paint over it
      if (cl.rect.w < 24 || cl.rect.h < 24) continue;  // too small to read as a "strip"
      if (luminanceCompatible(cl.style.background, canvasBg)) continue;  // blends with canvas
      coatSelectors.push(cl.selector);
      baseCoatCount++;
    }
    if (coatSelectors.length) {
      blocks.push(`${coatSelectors.join(',\n')} {\n  background: ${baseTone} !important;\n  color: ${baseText} !important;\n}`);
      rulesEmitted++;
    }
  }

  // WS2 fluid guard: post-compile safety net. The structure path already wraps
  // fixed px in min(X,100%) by construction; this catches any leak from any path
  // and logs it so a frozen-one-viewport value can never reach emitted CSS.
  const rawPxLeaks = assertNoRawPxSizing(blocks.join('\n\n'));
  for (const leak of rawPxLeaks) droppedProps.push(`rawPxSizing(${leak} — banned, fluidize)`);

  return { css: blocks.join('\n\n'), rulesEmitted, invalidTargets, droppedProps, baseCoatCount };
}

function indent(decls: string[]): string { return decls.map((d) => '  ' + d).join('\n'); }

/**
 * Deterministic accent trim (over-accent repair, before spending a paid reReason).
 * Decides which accent-painting clusters KEEP their background. Two rules:
 *  1. ABSOLUTE LAW (both modes): never identical accent on every member of a
 *     repeated cluster — strip accent from ALL repeated clusters, always.
 *  2. Area budget (restrained only): after stripping repeated accents, trim
 *     non-repeated accents largest-area-first until the painted accent area
 *     falls under MAX_ACCENT_FRACTION. Vivid mode skips the area budget — large
 *     saturated fields are permitted, only the repeated-accent law applies.
 */
function planAccentKeep(spec: DesignSpec, byHandle: Map<string, Cluster>, perception: Perception, opts: CompileOptions): Set<string> {
  const vpArea = Math.max(1, perception.viewport.w * perception.viewport.h);
  interface A { handle: string; prominence: number; area: number; repeated: boolean; }
  const accents: A[] = [];
  for (const rule of spec.rules) {
    if (rule.hide || !rule.styles) continue;
    const bg = rule.styles.background ?? rule.styles.backgroundColor ?? rule.styles.backgroundImage;
    if (!bg) continue;
    const rgba = parseColor(bg);
    if (!rgba || colorfulness(rgba) < 0.35) continue; // not a loud accent (mirror verify's threshold)
    const cl = byHandle.get(rule.target);
    if (!cl) continue;
    const area = Math.min(cl.rect.w * cl.rect.h, vpArea) * Math.max(1, cl.count);
    accents.push({ handle: rule.target, prominence: cl.prominence, area, repeated: cl.count > 3 });
  }
  const keep = new Set(accents.map((a) => a.handle));
  if (accents.length <= 1) return keep;

  // Absolute law: strip accent from ALL repeated clusters regardless of mode.
  for (const a of accents) if (a.repeated) keep.delete(a.handle);

  // Vivid: the area budget does not apply — only the absolute law. Done.
  if (opts.paletteMode === 'vivid') return keep;

  // Restrained: also enforce the area budget on the surviving (non-repeated) accents.
  // Protect the 2 most-prominent single-instance accent blocks (a hero band, a
  // section header). Everything else is eligible to strip.
  const protectedH = new Set(
    accents.filter((a) => !a.repeated).sort((a, b) => b.prominence - a.prominence).slice(0, 2).map((a) => a.handle),
  );
  const budget = MAX_ACCENT_FRACTION * vpArea;
  let total = accents.filter((a) => keep.has(a.handle)).reduce((s, a) => s + a.area, 0);
  const eligible = accents.filter((a) => keep.has(a.handle) && !protectedH.has(a.handle)).sort((a, b) => b.area - a.area);
  for (const a of eligible) {
    if (total <= budget) break;
    keep.delete(a.handle);
    total -= a.area;
  }
  return keep;
}

/**
 * Why a hide must be refused, or null if safe. The ghost-column law bans
 * display:none as a LAYOUT op; the hide channel is different — an explicit,
 * guarded removal of peripheral chrome. Never primary content, never wrappers
 * (they contain the page), never page-scale containers or huge repeated
 * clusters (likely content lists).
 */
function hideRefusal(c: Cluster): string | null {
  if (c.role === 'main' || c.role === 'article') return 'primary-content';
  if (c.layout.isPassiveWrapper || c.layout.isOpaqueWrapper) return 'wrapper';
  if (c.layout.widthRatio >= MAX_HIDDEN_WIDTH_RATIO && c.rect.h > MAX_HIDDEN_HEIGHT_PX) return 'page-scale';
  if (c.rect.h > 300) return 'tall-content'; // content sections are tall; chrome is short
  if (c.count > MAX_HIDDEN_MEMBERS) return 'repeated-content';
  return null;
}

function withTransition(decls: StyleDecls): StyleDecls {
  if ('transition' in decls) return decls;
  return { ...decls, transition: 'transform 0.15s ease, box-shadow 0.15s ease, background 0.15s ease, color 0.15s ease' };
}

function stripKeys(decls: StyleDecls | LayoutDecls, keys: string[]): StyleDecls {
  const out: StyleDecls = { ...decls };
  for (const k of keys) delete out[k];
  return out;
}

/** Keys that would REPLACE a content image (background shorthand resets background-image;
 *  backgroundImage would swap it). Refused on clusters whose own bg is a url() image. */
const IMAGE_BG_KEYS = ['background', 'backgroundColor', 'backgroundImage'];

/** Protect content images: on a cluster whose own background is a url() image (a
 *  thumbnail), drop any background/backgroundImage the model set — a solid
 *  `background` shorthand would paint over the image. The model shapes images via
 *  filter/border/radius/shadow/aspect/objectFit instead (prompt-enforced + now
 *  compiler-enforced). Returns the (possibly stripped) styles bag. */
function stripImageBg(styles: StyleDecls, hasBgImage: boolean, droppedProps: string[], handle: string): StyleDecls {
  if (!hasBgImage) return styles;
  let out = styles;
  for (const k of IMAGE_BG_KEYS) {
    if (k in out) {
      if (out === styles) out = { ...styles };
      delete out[k];
      droppedProps.push(`imageBg(${handle}:${k} dropped — content image protected)`);
    }
  }
  return out;
}

function firstNonEmpty(...vals: (string | undefined)[]): string {
  for (const v of vals) if (v && v.trim()) return v.trim();
  return '';
}

/**
 * Derive a solid base-coat tone from the canvas background (Fix 4). If the canvas
 * is a solid color, use it directly. If it's a gradient/keyword, extract the first
 * parseable color — the base coat just needs to be luminance-compatible with the
 * canvas, not an exact match.
 */
function deriveBaseTone(canvasBg: string): string {
  const parsed = parseColor(canvasBg);
  if (parsed) return canvasBg; // solid color — use directly
  // gradient/keyword — extract first hex/rgb color from the string
  const m = canvasBg.match(/#[0-9a-f]{3,8}|rgba?\([^)]+\)/i);
  return m ? m[0] : canvasBg;
}

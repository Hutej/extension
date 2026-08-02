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

import type { DesignSpec, DesignRule, StyleDecls, LayoutDecls } from '../spec';
import type { Perception, Cluster } from '../perceive';
import { buildDeclarations } from '../capabilities/style/index.ts';
import { buildLayoutDeclarations } from '../capabilities/structure/index.ts';
import { isSafeValue, MAX_HIDDEN_WIDTH_RATIO, MAX_HIDDEN_HEIGHT_PX, MAX_HIDDEN_MEMBERS, MAX_ACCENT_FRACTION, fluidizeRawPxSizing, MIN_CHARS_PER_LINE, MIN_CONTENT_WIDTH_FRACTION } from '../laws/index.ts';
import { parseColor, colorfulness, pickReadableText, extractGradientStops, pickReadableTextForGradient } from '../../shared/color.ts';
import { validateOps, type ValidatedOp } from '../ops/index.ts';
import { expandIntents } from './expand.ts';

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
  pixelInvisibleTargets?: string[]; // pixel-invisible clusters: force a readable bg+text PAIR (not just text) — guards hasBgImage
  wordBreakTargets?: string[]; // targeted bleed repair: overflow-wrap on ONLY these bleeding clusters
  collapseTargets?: string[]; // targeted collapse repair: drop layout on ONLY these collapsed regions (preserves the rest of the design)
  paletteMode?: 'restrained' | 'vivid'; // declared palette intent — vivid lifts the area cap
}

const ACCENT_STRIP_KEYS = ['background', 'backgroundColor', 'backgroundImage', 'color'];

export interface CompileResult {
  css: string;
  rulesEmitted: number;
  invalidTargets: string[];
  droppedProps: string[];
  baseCoatCount: number;       // A6: always 0 now (base-coat deleted) — kept for compat
  /** A6: forceContrast is a last-resort safety net, reported — never silent.
   *  Each handle where forceContrast applied a readable pair is listed here so
   *  the run report names the colour-constraint failures. */
  forceContrastReport: string[];
  /** Structural ops accepted by the guard laws (content.ts executes them live).
   *  Refused ops are in droppedProps as `kind(target:reason)`. */
  ops: ValidatedOp[];
  /** Phase 2 — handles the model ALSO gave raw rules for (the escape hatch).
   *  Logged loudly; the count + the FRACTION = the vocabulary-gap metric. */
  escapeHatchUses?: string[];
  escapeHatchFraction?: number;
  /** Phase 2 — every handle the intents resolved to (the expander's allTargets).
   *  The model coverage gate + the escape-hatch denominator count these — Phase 2
   *  moved the model's output from raw rules to intents, so pre-expansion spec.rules
   *  (the raw escape-hatch only) undercount what the model addressed. */
  expandedTargets?: string[];
  /** Phase 2 — the expander's per-intent notes (refusals, topbar/collapse
   *  derivations). Surfaced on the run report. */
  expandNotes?: string[];
}

const PADDING_KEYS = ['padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'];

export function compileSpec(specIn: DesignSpec, perception: Perception, opts: CompileOptions = {}): CompileResult {
  const byHandle = new Map<string, Cluster>();
  for (const c of perception.clusters) byHandle.set(c.handle, c);

  const blocks: string[] = [];
  const invalidTargets: string[] = [];
  const droppedProps: string[] = [];
  let rulesEmitted = 0;
  let baseCoatCount = 0;

  // Phase 2 — the expander: if the spec has intents (the primary model output),
  // map intents + the pack + the Phase 1 semantic graph to concrete
  // rules/composition/ops. Merge with the spec's raw escape-hatch rules (raw
  // wins per-handle — the escape hatch is the model's explicit override). The
  // expander is pure, deterministic, free (0 model calls).
  let escapeHatchUses: string[] = [];
  let escapeHatchFraction = 0;
  let expandNotes: string[] = [];
  let expandedTargets: string[] = [];
  let spec = specIn;
  if (specIn.intents && specIn.intents.length) {
    const exp = expandIntents(specIn, perception);
    escapeHatchUses = exp.escapeHatchUses;
    escapeHatchFraction = exp.escapeHatchFraction;
    expandNotes = exp.notes;
    expandedTargets = exp.expandedTargets;
    // Merge: expanded rules are the base; raw escape-hatch rules override per
    // handle (the model's explicit low-level override beats the derived intent).
    const rulesByHandle = new Map<string, DesignRule>();
    for (const r of exp.rules) rulesByHandle.set(r.target, { ...r });
    for (const r of specIn.rules) {
      const existing = rulesByHandle.get(r.target);
      if (existing) {
        // Raw wins: the escape hatch overrides the expanded intent on its handle.
        if (r.styles) existing.styles = { ...(existing.styles ?? {}), ...r.styles };
        if (r.layout) existing.layout = { ...(existing.layout ?? {}), ...r.layout };
        if (r.hover) existing.hover = { ...r.hover };
        if (r.focusVisible) existing.focusVisible = { ...r.focusVisible };
        if (r.hide) existing.hide = true;
      } else {
        rulesByHandle.set(r.target, { ...r });
      }
    }
    // Composition: expanded composition is the base; raw composition overrides.
    const compByHandle = new Map<string, DesignRule>();
    for (const r of exp.composition) compByHandle.set(r.target, { ...r });
    if (specIn.composition) for (const r of specIn.composition) {
      const existing = compByHandle.get(r.target);
      if (existing) {
        if (r.styles) existing.styles = { ...(existing.styles ?? {}), ...r.styles };
        if (r.layout) existing.layout = { ...(existing.layout ?? {}), ...r.layout };
        if (r.hide) existing.hide = true;
      } else compByHandle.set(r.target, { ...r });
    }
    // Ops: expanded ops first, then raw ops (raw wins by target+kind; validateOps
    // dedups by target+kind, first wins — so put the model's raw ops first).
    const ops = [...(specIn.ops ?? []), ...exp.ops];
    spec = {
      ...specIn,
      rules: [...rulesByHandle.values()].filter((r) => r.styles || r.layout || r.hover || r.focusVisible || r.hide),
      composition: [...compByHandle.values()].filter((r) => r.styles || r.layout || r.hide),
      ops,
    };
  }

  // Structural ops: validate against guard laws (pure). content.ts executes the
  // accepted ops against the live DOM; refusals land in droppedProps like any
  // refused declaration. Ops + CSS join into ONE apply (ops are not paints).
  const { ops: validatedOps, refused: opRefusals } = validateOps(spec.ops, perception);
  droppedProps.push(...opRefusals);

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
      // Refuse page-narrowing AND px-anchored width: on a wide page (content
      // ≥70% of viewport) a fixed-px maxWidth is wrong twice — it can leave a
      // dead-margin band (the "whole site shrank" look), and it freezes the
      // proportion at ONE zoom level. Browser zoom rescales the CSS viewport
      // (Ctrl-minus at 80% makes a 1280px window report ~1600px), so a px cap
      // that was ~90% of the page at 100% zoom becomes ~65% of it zoomed out —
      // the design shrinks while the site around it grows. A PERCENTAGE keeps
      // the same proportion at every zoom and window size. Convert the model's
      // px cap to a viewport-relative percentage, floored at
      // MIN_CONTENT_WIDTH_FRACTION of the natural content width; ≥97% of the
      // viewport is treated as full width.
      let canvasLayout = spec.canvasLayout;
      const cmw = perception.skeleton.contentMaxWidthPx;
      const vpWidth = perception.viewport.w;
      if (cmw != null && vpWidth > 0 && cmw >= vpWidth * 0.7 && canvasLayout.maxWidth) {
        const pxVals = [...canvasLayout.maxWidth.matchAll(/(\d+(?:\.\d+)?)\s*px/gi)].map((m) => parseFloat(m[1]));
        const modelPx = pxVals.length ? Math.max(...pxVals) : null;
        if (modelPx != null) {
          const effectivePx = Math.max(modelPx, cmw * MIN_CONTENT_WIDTH_FRACTION);
          const pct = Math.min(100, Math.round((effectivePx / vpWidth) * 100));
          const pctValue = pct >= 97 ? '100%' : `${pct}%`;
          canvasLayout = { ...canvasLayout, maxWidth: pctValue };
          droppedProps.push(`refusePageNarrowing: canvasLayout.maxWidth ${modelPx}px -> ${pctValue} (zoom-proof percentage; floor = ${Math.round(MIN_CONTENT_WIDTH_FRACTION * 100)}% of ${cmw}px natural content on a wide page)`);
        }
      } else if (canvasLayout.maxWidth) {
        // A4: percentify DELETED. A px cap is zoom-hostile, but converting it to
        // a viewport percentage is the exact failure Law 0 describes. The
        // structure path's min(X, 100%) wrapping provides relational sizing.
      }
      const r = buildLayoutDeclarations(canvasLayout, { isConstraintOwner: true, ownsTarget: false, dropSizing: opts.dropSizing });
      droppedProps.push(...r.dropped);
      decls.push(...r.decls);
    }
    // forceContrast body floor: text that inherits from body (i.e. NOT covered by
    // any cluster rule) must be readable against the canvas backdrop. Root cause
    // of the old no-op: forceContrast only touched rules that set a background, so
    // uncovered text stayed dark-on-dark. Appended last -> wins the block's color.
    // For a GRADIENT canvas, pick text readable against every stop (a dark text on
    // a light→dark gradient is invisible at the light end; this is the washed-text
    // bug, and it holds the contrast at every zoom where the gradient renders
    // against a different stop).
    if (opts.forceContrast) {
      const parsed = parseColor(canvasBg);
      let readable: string;
      if (parsed) {
        readable = pickReadableText(parsed);
      } else {
        const stops = extractGradientStops(canvasBg);
        readable = stops.length ? pickReadableTextForGradient(stops) : canvasText;
      }
      if (readable) decls.push(`color: ${readable} !important;`);
    }
    // A6: overflow-x: clip DELETED. Bleed means the layout was over-constrained.
    // Fix the constraint, don't clip the symptom.
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
        const clampThis = opts.dropSizing || (opts.clampTargets?.includes(rule.target) ?? false);
        // A4: percentify DELETED. Converting a desired pixel width into a
        // percentage of the captured viewport is the exact failure Law 0
        // describes. The structure path's min(X, 100%) wrapping provides
        // relational sizing without measurement-derived percentages.
        const r = buildLayoutDeclarations(rule.layout, {
          isConstraintOwner: cluster.layout.isContainer ?? false,
          ownsTarget: cluster.layout.constraintOwnerHandle != null,
          isPassiveWrapper: cluster.layout.isPassiveWrapper ?? false,
          dropSizing: clampThis,
          containerWidthPx: cluster.rect.w,
        });
        droppedProps.push(...r.dropped);
        decls.push(...r.decls);
        // NO preventive overflow-wrap on narrowed containers. `anywhere`
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
      // Decorative-void refusal: a rule that grows a TEXT-LESS, IMAGE-LESS cluster
      // into a large framed box (big padding + border + boxShadow, no content) is a
      // decorative void — the empty-capsule bug (a header that was removed leaves a
      // big empty framed box). Cap the padding and drop the framing on such clusters
      // so a void can't be grown. A text/image-bearing cluster keeps its framing.
      styles = stripDecorativeVoidGrowth(styles, cluster, droppedProps, rule.target);
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
      // A6: squeeze repair DELETED. If content is squeezed, a min-width or
      // WrapOnOverflow constraint is missing — fix the constraint, not the symptom.
      const clampThis = opts.dropSizing || (opts.clampTargets?.includes(rule.target) ?? false);
      let layoutInput = rule.layout;
      // Readable-measure refusal: a text-bearing cluster narrowed below a
      // readable measure (chars-per-line < floor) is the "sleeps in the washroom"
      // failure. Refuse the narrowing value instead of emitting a broken column.
      // The cluster's samples tell us it carries text; the layout value tells us
      // how narrow. Pure geometry — no aesthetic logic.
      layoutInput = refuseSubMeasure(layoutInput, cluster, droppedProps, rule.target);
      // A4: percentify DELETED — see composition-rule note above.
      const r = buildLayoutDeclarations(layoutInput, {
        isConstraintOwner: cl?.isContainer ?? false,
        ownsTarget: cl?.constraintOwnerHandle != null,
        isPassiveWrapper: cl?.isPassiveWrapper ?? false,
        dropSizing: clampThis,
        containerWidthPx: cluster?.rect.w,
      });
      droppedProps.push(...r.dropped);
      decls.push(...r.decls);
      // NO preventive overflow-wrap on narrowed containers (see
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

  // 3c) Targeted contrast repair. The sampler flagged these SPECIFIC
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
    // pixel-invisible handles get a full bg+text pair below — skip them here so the
    // text-only bump doesn't double-emit (the bg-aware block wins source-order anyway).
    const pixelInvisSet = new Set(opts.pixelInvisibleTargets ?? []);
    for (const h of new Set(opts.contrastTargets)) {
      if (pixelInvisSet.has(h)) continue;
      const cl = byHandle.get(h);
      if (!cl) { droppedProps.push(`contrast(${h}:handle-vanished — cascade-loss: the handle dropped from the live perception, no text-only bump emitted)`); continue; }
      // Priority: the EFFECTIVE bg verify's parent-chain walk captured (the real
      // surface the text sits on — usually an ancestor's painted panel, not the
      // handle's own bg), then the rule's bg, then the cluster's original bg, then canvas.
      const parsed = parseColor(opts.contrastTargetBgs?.[h] ?? specBg.get(h) ?? cl.style.background) ?? canvasParsed;
      const readable = parsed ? pickReadableText(parsed) : '#111111';
      blocks.push(`${forceContrastSelector(h)} {\n  color: ${readable} !important;\n}`);
      // Force the color onto descendants too: text often lives in a child (<a>/<span>)
      // whose own `color` overrides the inherited parent color, leaving link text
      // invisible even after the cluster's color is bumped (the "unknown" class —
      // opaque bg painted, text still invisible). Localized to this cluster only.
      blocks.push(`${forceContrastSelector(h)} * {\n  color: ${readable} !important;\n}`);
      rulesEmitted++;
    }
    // BG-aware contrast: for pixel-invisible clusters (text invisible against its
    // bg), a text-only bump is insufficient when the bg itself is the cause (the
    // model painted a dark surface and left text dark). Set a readable bg+text PAIR —
    // derive a solid tone from the canvas bg (matches the design) and pick a text
    // color readable against it. Guard: skip clusters with background images (thumbnails)
    // so content images are never painted over.
    if (opts.pixelInvisibleTargets?.length) {
      // Phase-1 root-cause fix (wrong-bg failure class): the OLD code derived ONE
      // bg+text pair for ALL pixel-invisible clusters from `deriveBaseTone(canvasBg)`
      // — the CANVAS bg, not the surface each cluster's text actually sits on. A
      // cluster on a dark ancestor-painted panel got a canvas-derived pair (light bg
      // + dark text), which stays invisible against the dark panel it really lives
      // on. Per-handle: derive the readable bg from the cluster's EFFECTIVE bg
      // (verify's parent-chain walk captured it as contrastTargetBgs[h]), then the
      // rule's own bg, then the cluster's original bg, then the canvas tone. Each
      // invisible cluster now gets a pair painted on its REAL surface.
      const canvasTone = deriveBaseTone(canvasBg);
      const canvasParsed = parseColor(canvasTone);
      for (const h of new Set(opts.pixelInvisibleTargets)) {
        const cl = byHandle.get(h);
        if (!cl) { droppedProps.push(`pixelInvisible(${h}:handle-vanished — cascade-loss: the handle dropped from the live perception, possibly an op removed it or an SPA re-render stripped [data-wm-c])`); continue; }
        if (cl.style.hasBgImage) { droppedProps.push(`pixelInvisible(${h}:image-bg — protected, no pair emitted)`); continue; }
        const effBg = opaqueOr(opts.contrastTargetBgs?.[h]) ?? opaqueOr(specBg.get(h)) ?? opaqueOr(cl.style.background) ?? canvasTone;
        const baseTone = deriveBaseTone(effBg);
        const baseParsed = parseColor(baseTone) ?? canvasParsed;
        const readableBg = baseParsed ? baseTone : '#ffffff';
        const readableText = baseParsed ? pickReadableText(baseParsed) : '#111111';
        blocks.push(`${forceContrastSelector(h)} {\n  background: ${readableBg} !important;\n  background-image: none !important;\n  color: ${readableText} !important;\n}`);
        // Force the color onto descendants too: the text is often in a child <a>/<span>
        // with its own `color` that overrides the inherited parent color — so the opaque
        // bg is painted but the link text stays invisible (the "unknown" class). The bg
        // stays on the cluster only (children transparent, showing the opaque surface);
        // only `color` is pushed onto descendants. Localized to this invisible cluster.
        blocks.push(`${forceContrastSelector(h)} * {\n  color: ${readableText} !important;\n}`);
        rulesEmitted++;
      }
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
  // and let flex/grid squeeze every column to a few characters (word-mutilation bug).
  if (opts.wordBreakTargets?.length) {
    for (const h of new Set(opts.wordBreakTargets)) {
      const cl = byHandle.get(h);
      if (!cl) continue;
      blocks.push(`${cl.selector} {\n  overflow-wrap: break-word !important;\n}`);
      rulesEmitted++;
    }
  }

  // A6: clip overflow repair DELETED. Bleed means the layout was over-constrained.
  // Fix the constraint, don't clip the symptom.

  // A6: base-coat harmonizer DELETED. Fifty unaddressed clusters receiving an
  // identical background and text colour is flat uniformity, not design. Each
  // cluster gets its own constraint-driven styling. The constraint that now
  // carries the load: FillParent + MaxWidth + StackVertically per slot.
  // (The baseCoatCount stays 0 — reported for backward compat.)

  // Fluid guard: post-compile safety net. The structure path already wraps
  // fixed px in min(X,100%)/min(X,100vh) by construction; this REWRITES any leak
  // from any path so a frozen-one-viewport value can never reach emitted CSS.
  // Bare `height` leaks are logged (not rewritten — the model can't set it).
  const { css: fluidCss, leaks: rawPxLeaks } = fluidizeRawPxSizing(blocks.join('\n\n'));
  for (const leak of rawPxLeaks) droppedProps.push(`fluidize(${leak})`);

  // A6: forceContrast reporting — a last-resort safety net, never silent.
  // Collect the handles where forceContrast applied a readable pair.
  const forceContrastReport: string[] = opts.forceContrast
    ? [...new Set([...(opts.contrastTargets ?? []), ...(opts.pixelInvisibleTargets ?? [])])]
    : [];

  return {
    css: fluidCss, rulesEmitted, invalidTargets, droppedProps, baseCoatCount, forceContrastReport, ops: validatedOps,
    ...(escapeHatchUses.length || specIn.intents?.length ? { escapeHatchUses, escapeHatchFraction, expandNotes, expandedTargets } : {}),
  };
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
 *
 * HARD SAFETY RULE (Phase 2, permanent): a destructive intent (hide) is
 * FORBIDDEN on any role below the confidence threshold — the classifier is less
 * than coin-flip sure what this region is, so deleting it risks removing content
 * it misread. Low-confidence roles get conservative treatment only. The
 * threshold (0.5) is the value below which a role is "uncertain"; a confident
 * ad-or-void/nav-chrome stays hideable. Enforced here (the expander), not just
 * the prompt.
 */
const DESTRUCTIVE_CONFIDENCE_FLOOR = 0.5;
function hideRefusal(c: Cluster): string | null {
  if (c.role === 'main' || c.role === 'article') return 'primary-content';
  if (c.layout.isPassiveWrapper || c.layout.isOpaqueWrapper) return 'wrapper';
  if (c.layout.widthRatio >= MAX_HIDDEN_WIDTH_RATIO && c.rect.h > MAX_HIDDEN_HEIGHT_PX) return 'page-scale';
  if (c.rect.h > 300) return 'tall-content'; // content sections are tall; chrome is short
  // Confidence gate: refuse hide on an uncertain role (the classifier is < 0.5
  // sure what this is). The one role hide exists to prune — ad-or-void — is only
  // hideable when the classifier is confident it's really a void/ad.
  if (c.designRoleConfidence < DESTRUCTIVE_CONFIDENCE_FLOOR) return 'low-confidence-role';
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
 * Readable-measure refusal. For a text-bearing cluster (samples hold ≥80 chars),
 * a width/maxWidth/minWidth whose fixed-px value yields < MIN_CHARS_PER_LINE chars
 * per line (width ÷ (16×0.5)) would wrap every word — the narrow-column failure.
 * Refuse the offending sizing keys; the cluster keeps its other layout. Pure
 * geometry: only fixed px values are checked (%, clamp(), min() are already fluid).
 * `16px default font + 0.5 avg-char-width ratio — same heuristic as
 *  verify.findSqueezeTargets; a real font-measure would be tighter, but this
 *  matches the verify side so the two gates agree`.
 */
function refuseSubMeasure(layout: LayoutDecls, cluster: Cluster | undefined, droppedProps: string[], handle: string): LayoutDecls {
  if (!cluster) return layout;
  const textLen = cluster.samples.reduce((s, t) => s + (t || '').length, 0);
  if (textLen < 80) return layout;                 // not a prose container — leave alone
  let out = layout;
  for (const k of ['width', 'maxWidth', 'minWidth'] as const) {
    const v = (layout as Record<string, unknown>)[k];
    if (typeof v !== 'string') continue;
    const m = v.trim().match(/^([\d.]+)px$/i);
    if (!m) continue;                               // fluid values are fine
    const px = parseFloat(m[1]);
    const cpl = px / (16 * 0.5);
    if (cpl < MIN_CHARS_PER_LINE) {
      if (out === layout) out = { ...layout };
      delete (out as Record<string, unknown>)[k];
      droppedProps.push(`measure(${handle}:${k}=${v} — ${cpl.toFixed(1)}cpl < ${MIN_CHARS_PER_LINE})`);
    }
  }
  return out;
}

/**
 * Percentage geometry law, cluster level. A fixed-px width/maxWidth/minWidth on a
 * cluster is zoom-hostile — browser zoom rescales the CSS viewport, so a px cap
 * frozen at compile time changes proportion at every zoom level. Convert it to a
 * percentage of the measured parent width (the cluster's own parent when known,
 * else the viewport). A percentage tracks its parent, which tracks the viewport,
 * at every zoom and window size.
 *
 * The room law extends one level down: a WIDE child (widthFractionOfParent ≥ 0.7)
 * may not be emitted below MIN_COMPONENT_WIDTH_FRACTION of that fraction — the
 * "all my components shrank" dead-margin band, inside its parent. Floor the
 * converted percentage there; a narrow child (e.g. a sidebar) is left to the
 * model's value. Pure geometry — no aesthetic logic. The structure path's
 * min(X, 100%) wrap then receives a fluid % value and leaves it untouched.
 *
 * `parentWidth falls back to the viewport when no parent cluster is
/**
 * Decorative-void refusal. A rule that grows a TEXT-LESS, IMAGE-LESS cluster into a
 * large framed box (big padding + a thick border/boxShadow) is a decorative void —
 * the empty-capsule bug: a header/section that was removed leaves a big empty framed
 * box where it was. Refuse the GROWTH on such a cluster: cap large padding and drop
 * the heavy framing so a void can't be grown into a visible capsule. A text-bearing
 * or image cluster keeps its framing (it has content to show). A normal card with a
 * modest border + small padding is NOT a void — only LARGE padding + THICK framing on
 * a content-less cluster is.
 * `the void signal is a heuristic (no text + large pad + thick frame); a
 *  real content measure would catch the edge case of a content-less card, but the
 *  large-pad + thick-frame gate avoids false positives on normal framed cards.`
 */
const VOID_PAD_CAP_PX = 24;
const VOID_LARGE_PAD_PX = 40;
const VOID_THICK_BORDER_PX = 3;
function stripDecorativeVoidGrowth(styles: StyleDecls, cluster: Cluster | undefined, droppedProps: string[], handle: string): StyleDecls {
  if (!cluster) return styles;
  // Only a content-less, image-less cluster can become a decorative void. A cluster
  // with text samples, a content image, OR a primary-content role (main/article) has
  // something to show — keep its framing.
  const hasText = cluster.samples.reduce((s, t) => s + (t || '').length, 0) > 0;
  const isContentRole = cluster.role === 'main' || cluster.role === 'article';
  if (hasText || cluster.style.hasBgImage || isContentRole) return styles;
  // Only a WIDE content-less cluster reads as a void (a header/section that was
  // removed). A narrow card — even a content-less one — keeps its framing; the
  // void bug is a big empty band, not a small box.
  if (cluster.layout.widthRatio < 0.5) return styles;
  // Only refuse if the rule GROWS the void: large padding (≥40px) AND/OR a thick
  // border + boxShadow together. A modest border alone on a card isn't a void.
  const hasLargePad = ['padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'].some((k) => {
    const v = styles[k];
    const m = v?.match(/^([\d.]+)px/i);
    return m && parseFloat(m[1]) >= VOID_LARGE_PAD_PX;
  });
  const hasThickBorder = ['border', 'borderTop', 'borderRight', 'borderBottom', 'borderLeft'].some((k) => {
    const v = styles[k];
    const m = v?.match(/^([\d.]+)px/i);
    return m && parseFloat(m[1]) >= VOID_THICK_BORDER_PX;
  });
  const hasShadow = 'boxShadow' in styles;
  const growsVoid = hasLargePad || (hasThickBorder && hasShadow);
  if (!growsVoid) return styles;
  let out = styles;
  // Cap large padding down so the void doesn't balloon.
  for (const k of ['padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft']) {
    if (!(k in out)) continue;
    const v = out[k];
    const m = v?.match(/^([\d.]+)px/i);
    if (m && parseFloat(m[1]) > VOID_PAD_CAP_PX) {
      if (out === styles) out = { ...styles };
      out[k] = `${VOID_PAD_CAP_PX}px`;
      droppedProps.push(`voidGrowth(${handle}:${k} capped to ${VOID_PAD_CAP_PX}px)`);
    }
  }
  // Drop the heavy framing (thick border + boxShadow) — a frame around nothing.
  if (hasThickBorder && hasShadow) {
    for (const k of ['border', 'borderTop', 'borderRight', 'borderBottom', 'borderLeft', 'boxShadow']) {
      if (!(k in out)) continue;
      if (out === styles) out = { ...styles };
      delete out[k];
      droppedProps.push(`voidGrowth(${handle}:${k} dropped — decorative void)`);
    }
  }
  return out;
}

/**
 * Derive a solid base-coat tone from the canvas background. If the canvas
 * is a solid color, use it directly. If it's a gradient/keyword, extract the first
 * parseable color — the base coat just needs to be luminance-compatible with the
 * canvas, not an exact match.
 */
export function deriveBaseTone(canvasBg: string): string {
  const parsed = parseColor(canvasBg);
  if (parsed) return canvasBg; // solid color — use directly
  // gradient/keyword — extract first hex/rgb color from the string
  const m = canvasBg.match(/#[0-9a-f]{3,8}|rgba?\([^)]+\)/i);
  return m ? m[0] : canvasBg;
}

/**
 * Cascade-proof selector for the deterministic forceContrast pair. The base
 * cluster selector `[data-wm-c="…"]` is specificity (0,1,0); a site rule with a
 * higher-specificity selector + !important beats our pair — the cascade-loss
 * failure class (the pair is emitted but loses the cascade, so the cluster stays
 * invisible). Doubling the attribute selector lifts specificity to (0,2,0) +
 * !important, beating class-level site !important (the common case). Emitted last
 * in the cascade, so it also wins source-order.
 * `id-level site !important (1,1,0+) still wins; the severe-invisible
 *  Critic escalation (repair/index.ts) redesigns the surface for those — an
 *  inline-style fallback (inline + !important beats any stylesheet rule) is the
 *  upgrade path if a real run shows id-level cascade-loss survivors persist.` */
function forceContrastSelector(handle: string): string {
  return `[data-wm-c="${handle}"][data-wm-c="${handle}"]`;
}

/** Transparent/empty bg is "no surface" — returns null so the effBg `??` chain
 *  falls through to the opaque canvas tone. Without this, `deriveBaseTone` returns
 *  translucent strings verbatim (parseColor accepts any alpha) and the backstop
 *  paints `background: rgba(…,0.5) !important` — a translucent bg the dark surface
 *  bleeds through, so the text (sized for the opaque color) is invisible on the
 *  rendered composite (the wrong-bg failure class). Requires FULL opacity (a===1):
 *  translucent model washes are "no reliable surface" → fall to the opaque canvas. */
function opaqueOr(bg?: string | null): string | null {
  if (!bg) return null;
  const p = parseColor(bg);
  return p && p[3] === 1 ? bg : null;
}

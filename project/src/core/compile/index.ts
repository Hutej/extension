/**
 * core/compile — DesignSpec -> concrete, safe CSS (+ planned moves). Pure.
 *
 * Enforces the safety laws as a pipeline stage:
 *   - only targets handles that exist in the live perception (or "canvas")
 *   - overrides :root variables first (specificity-war-free backdoor)
 *   - paints the canvas, then each discovered component
 *   - per rule, co-emits PAINT (capabilities/style) and LAYOUT (capabilities/structure)
 *     into the same selector block
 *   - validates + plans `moves[]` but does NOT execute them (deferred slice):
 *     execution seam lives in core/execute; content applies CSS only.
 */

import type { DesignSpec, StyleDecls, LayoutDecls } from '../spec';
import type { Perception, Cluster } from '../perceive';
import { buildDeclarations } from '../capabilities/style/index.ts';
import { buildLayoutDeclarations } from '../capabilities/structure/index.ts';
import { isSafeValue } from '../laws/index.ts';

export interface PlannedMove {
  target: string;
  into: string;
  position: 'append' | 'prepend';
}

export interface CompileOptions {
  forceContrast?: boolean;
  dropPadding?: boolean;
  dropSizing?: boolean;
  dropLayout?: boolean;   // strongest overflow/overlap repair: paint only, no structural CSS
}

export interface CompileResult {
  css: string;
  ops: PlannedMove[];          // planned only this slice (execution deferred)
  rulesEmitted: number;
  invalidTargets: string[];
  droppedProps: string[];
}

const PADDING_KEYS = ['padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'];

export function compileSpec(spec: DesignSpec, perception: Perception, opts: CompileOptions = {}): CompileResult {
  const byHandle = new Map<string, Cluster>();
  for (const c of perception.clusters) byHandle.set(c.handle, c);

  const blocks: string[] = [];
  const invalidTargets: string[] = [];
  const droppedProps: string[] = [];
  let rulesEmitted = 0;

  const canvasText = firstNonEmpty(spec.canvas?.color, perception.canvas.color);

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
  if (spec.canvas || spec.canvasLayout) {
    const decls: string[] = [];
    if (spec.canvas) {
      const styles = opts.dropPadding ? stripKeys(spec.canvas, PADDING_KEYS) : spec.canvas;
      const r = buildDeclarations(styles, { mode: 'base', defaultText: canvasText, forceContrast: opts.forceContrast });
      droppedProps.push(...r.dropped);
      decls.push(...r.decls);
    }
    if (spec.canvasLayout && !opts.dropLayout) {
      const r = buildLayoutDeclarations(spec.canvasLayout, { isConstraintOwner: true, ownsTarget: false, dropSizing: opts.dropSizing });
      droppedProps.push(...r.dropped);
      decls.push(...r.decls);
    }
    if (decls.length) { blocks.push(`html, body {\n${indent(decls)}\n}`); rulesEmitted++; }
  }

  // 3) Component rules.
  for (const rule of spec.rules) {
    const isCanvas = rule.target === 'canvas' || rule.target === 'root';
    const cluster = isCanvas ? undefined : byHandle.get(rule.target);
    if (!isCanvas && !cluster) { invalidTargets.push(rule.target); continue; }
    const selector = isCanvas ? 'html, body' : cluster!.selector;
    const cl = cluster?.layout;

    const decls: string[] = [];

    if (rule.styles) {
      const styles = opts.dropPadding ? stripKeys(rule.styles, PADDING_KEYS) : rule.styles;
      const r = buildDeclarations(styles, {
        mode: 'base',
        isNativeControl: cluster?.isNativeControl,
        isCheckboxRadio: cluster?.isCheckboxRadio,
        defaultText: canvasText,
        forceContrast: opts.forceContrast,
      });
      droppedProps.push(...r.dropped);
      decls.push(...r.decls);
    }

    if (rule.layout && !opts.dropLayout) {
      const r = buildLayoutDeclarations(rule.layout, {
        isConstraintOwner: cl?.isContainer ?? false,
        ownsTarget: cl?.constraintOwnerHandle != null,
        isPassiveWrapper: cl?.isPassiveWrapper ?? false,
        dropSizing: opts.dropSizing,
      });
      droppedProps.push(...r.dropped);
      decls.push(...r.decls);
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

  // 4) Plan moves — validate handles, prefer CSS (drop same-owner reorders), keep survivors.
  const ops: PlannedMove[] = [];
  if (spec.moves) {
    for (const m of spec.moves) {
      if (!perception.handles.has(m.target) || !perception.handles.has(m.into)) continue;
      const a = byHandle.get(m.target)?.layout?.constraintOwnerHandle;
      const b = byHandle.get(m.into)?.layout?.constraintOwnerHandle;
      if (a && b && a === b) continue; // CSS `order` on that owner can express this — drop the DOM move
      ops.push({ target: m.target, into: m.into, position: m.position ?? 'append' });
    }
  }

  return { css: blocks.join('\n\n'), ops, rulesEmitted, invalidTargets, droppedProps };
}

// ── helpers ────────────────────────────────────────────────────────

function indent(decls: string[]): string { return decls.map((d) => '  ' + d).join('\n'); }

function withTransition(decls: StyleDecls): StyleDecls {
  if ('transition' in decls) return decls;
  return { ...decls, transition: 'transform 0.15s ease, box-shadow 0.15s ease, background 0.15s ease, color 0.15s ease' };
}

function stripKeys(decls: StyleDecls | LayoutDecls, keys: string[]): StyleDecls {
  const out: StyleDecls = { ...decls };
  for (const k of keys) delete out[k];
  return out;
}

function firstNonEmpty(...vals: (string | undefined)[]): string {
  for (const v of vals) if (v && v.trim()) return v.trim();
  return '';
}

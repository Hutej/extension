/**
 * core/compile/transform — the deterministic transformation engine.
 *
 * Replaces the old enum-based expansion logic (now deleted). The
 * model emits RELATIONAL STATEMENTS (not enum picks); the engine resolves each
 * relation against the page's own measured reality and produces the concrete
 * DesignRule[]/DesignOp[] the compiler consumes.
 *
 * Deterministic: the same relation against the same perception always produces
 * the same output. It resolves relations against the page's own measured
 * reality — "three times the body" resolves against the actual body size,
 * "one level above" against the actual elevation model. It reports any
 * relation it could not satisfy, and why, rather than silently dropping it.
 * It never invents structure the relation did not ask for.
 *
 * Pure: takes the spec + perception as data, returns the transformation. 0
 * model calls. The caller (compile/index.ts) merges these with any raw
 * escape-hatch rules (raw wins on a specific handle) then runs the existing
 * compile path.
 *
 * The relation switch is split into per-domain resolver modules
 * (compile/relations/*.ts); this file builds the shared context (helpers +
 * mutable accumulators) and dispatches each relation to its domain handler in
 * the SAME order the inline switch ran, so accent-budget allocation and style
 * merging are behaviour-identical.
 */

import type { DesignSpec, DesignRule, DesignOp, StyleDecls, LayoutDecls } from '../spec/index.ts';
import type { Perception, Cluster } from '../perceive/index.ts';
import type { DesignRole } from '../perceive/semantic.ts';
import { resolvePack, type DesignPack, type TypeRole, type SurfaceTier } from '../design/packs.ts';
import { parseColor, contrastRatio } from '../../shared/color.ts';
import { MIN_CONTRAST_RATIO } from '../laws/index.ts';
import type { Subject, RelationStatement } from '../design/vocabulary.ts';
import { COMPOSITION_RELATIONS, resolveComposition } from './relations/composition.ts';
export { resolveComposition };
import type { RelationContext, RelationHandlerMap } from './relations/context.ts';
import { spacingHandlers } from './relations/spacing.ts';
import { typographyHandlers } from './relations/typography.ts';
import { hierarchyHandlers } from './relations/hierarchy.ts';
import { surfaceHandlers } from './relations/surface.ts';
import { colorHandlers } from './relations/color.ts';
import { layoutHandlers } from './relations/layout.ts';
import { motionHandlers } from './relations/motion.ts';
import { opsHandlers } from './relations/ops.ts';
import { interactionHandlers } from './relations/interaction.ts';

/** The destructive-confidence floor: a destructive relation (hide/remove) is
 *  forbidden on a role the classifier is < this sure about. */
export const DESTRUCTIVE_CONFIDENCE_FLOOR = 0.5;

export interface TransformResult {
  rules: DesignRule[];
  composition: DesignRule[];
  ops: DesignOp[];
  escapeHatchUses: string[];
  escapeHatchFraction: number;
  expandedTargets: string[];
  pack: DesignPack;
  notes: string[];
}

/** The merged per-domain handler map. Built once (module-level — pure data). */
const RELATION_HANDLERS: RelationHandlerMap = {
  ...spacingHandlers,
  ...typographyHandlers,
  ...hierarchyHandlers,
  ...surfaceHandlers,
  ...colorHandlers,
  ...layoutHandlers,
  ...motionHandlers,
  ...opsHandlers,
  ...interactionHandlers,
};

/**
 * Transform relational statements into concrete rules/composition/ops. The PRIMARY
 * model output path. Pure: takes the spec + perception as data, returns the
 * transformation. The caller (compile/index.ts) merges these with raw
 * escape-hatch rules (raw wins per-handle).
 */
export function transformIntent(spec: DesignSpec, perception: Perception): TransformResult {
  const pack = resolvePack(spec.pack, spec.packOverrides);
  const relations = spec.relations ?? [];

  const byHandle = new Map<string, Cluster>();
  for (const c of perception.clusters) byHandle.set(c.handle, c);
  const byRole = new Map<DesignRole, Cluster[]>();
  for (const c of perception.clusters) {
    const arr = byRole.get(c.designRole);
    if (arr) arr.push(c); else byRole.set(c.designRole, [c]);
  }
  const byGroup = new Map<string, Cluster[]>();
  for (const c of perception.clusters) {
    if (!c.group) continue;
    const arr = byGroup.get(c.group);
    if (arr) arr.push(c); else byGroup.set(c.group, [c]);
  }

  const rulesByHandle = new Map<string, DesignRule>();
  const compositionByHandle = new Map<string, DesignRule>();
  const ops: DesignOp[] = [];
  const notes: string[] = [];
  const allTargets = new Set<string>();
  const escapeHatchUses = new Set<string>();
  for (const rule of spec.rules) escapeHatchUses.add(rule.target);

  // Accent tracking for the pack's maxAccentCount principle. Mutable holder so
  // the domain resolvers can increment it through the shared context.
  const accent = { count: 0 };

  /** Resolve a subject string to cluster handles. A handle matches one cluster;
   *  a role fans out to every cluster of that role; a group fans out to every
   *  cluster in that group; keywords resolve specially. */
  const resolveSubject = (subj: Subject, contextCluster?: Cluster): Cluster[] => {
    if (subj === 'parent') {
      if (contextCluster?.layout.parentHandle) {
        const parent = byHandle.get(contextCluster.layout.parentHandle);
        return parent ? [parent] : [];
      }
      return [];
    }
    if (subj === 'body') {
      // The page's body text: the article-body role, or the most common font size.
      const bodies = byRole.get('article-body');
      if (bodies?.length) return [bodies[0]];
      // Fallback: the cluster with the most text.
      const textClusters = [...perception.clusters].filter((c) => c.samples.reduce((s, t) => s + t.length, 0) > 50);
      if (textClusters.length) return [textClusters.sort((a, b) => b.prominence - a.prominence)[0]];
      return [];
    }
    if (subj === 'canvas') return [];
    if (/^c[0-9a-z]{6}$/.test(subj)) {
      const c = byHandle.get(subj);
      return c ? [c] : [];
    }
    if (/^g[0-9a-z]{6}$/.test(subj)) return byGroup.get(subj) ?? [];
    // Role name — fan out to every cluster of that role.
    return byRole.get(subj as DesignRole) ?? [];
  };

  /** Resolve a reference for a relation (like resolveSubject but with context). */
  const resolveReference = (ref: Subject, subjectCluster: Cluster): Cluster[] => resolveSubject(ref, subjectCluster);

  const ruleFor = (handle: string): DesignRule => {
    let r = rulesByHandle.get(handle);
    if (!r) { r = { target: handle }; rulesByHandle.set(handle, r); }
    return r;
  };
  const compFor = (handle: string): DesignRule => {
    let r = compositionByHandle.get(handle);
    if (!r) { r = { target: handle }; compositionByHandle.set(handle, r); }
    return r;
  };
  const addStyles = (r: DesignRule, styles: StyleDecls): void => {
    r.styles = { ...(r.styles ?? {}), ...styles };
  };
  const addLayout = (r: DesignRule, layout: LayoutDecls): void => {
    r.layout = { ...(r.layout ?? {}), ...layout };
  };

  /** Get the effective font size (px) of a cluster from perception. */
  const fontSizePx = (c: Cluster): number => parseFloat(c.style.fontSize) || 16;

  /** Get the effective padding (px) of a cluster from perception. */
  const paddingPx = (c: Cluster): number => {
    const m = c.style.padding.match(/^([\d.]+)px/);
    return m ? parseFloat(m[1]) : 0;
  };

  /** Get the effective line-height (unitless) of a cluster from perception. */
  const lineHeightValue = (c: Cluster): number => {
    const typ = c.typography?.lineHeight;
    if (typ && typ !== 'normal') {
      const n = parseFloat(typ);
      if (!isNaN(n)) return n;
    }
    return pack.lineHeight.body;
  };

  /** Get the shadow tier (0-based index into shadowScale) of a cluster. */
  const shadowTier = (c: Cluster): number => {
    if (c.style.boxShadow === 'none' || !c.style.boxShadow) return 0;
    // Find the closest match in the pack's shadowScale.
    for (let i = pack.shadowScale.length - 1; i >= 1; i--) {
      if (pack.shadowScale[i] !== 'none' && c.style.boxShadow.includes('rgba')) return i;
    }
    return 1;
  };

  /** Find the index in a numeric scale closest to a target px. Law 0:
   *  the measurement informs WHICH step, the step's value is the output.
   *  Legitimately discrete scales (radius, border, shadow) use this.
   *  Continuous quantities (size, spacing, lineHeight) use the generate-and-
   *  clamp helpers below instead. */
  const closestStep = (scale: number[], targetPx: number): number => {
    let best = 0, bestDiff = Infinity;
    scale.forEach((px, i) => {
      const d = Math.abs(px - targetPx);
      if (d < bestDiff) { bestDiff = d; best = i; }
    });
    return best;
  };

  /** Generate a fine-grained type ramp from the pack's base + scale character.
   *  The pack constrains (min ratio between levels, max display size, min small)
   *  but does NOT enumerate the only four sizes a page may use. The model's ratio
   *  produces the actual step on this generated ramp. Law 0: the ramp is derived
   *  from pack tokens (base × scaleCharacter^n), not from measurement. */
  const generateTypeRamp = (): number[] => {
    const base = pack.typeRamp.body;
    const scaleChar = pack.principles?.minTypeScaleRatio ?? 1.2;
    const maxSize = pack.typeRamp.display;
    const minSize = pack.typeRamp.small;
    const ramp: number[] = [];
    // Walk DOWN from body to small (negative steps).
    let v = base / scaleChar;
    const downSteps: number[] = [];
    while (v >= minSize * 0.95 && downSteps.length < 10) { downSteps.push(Math.round(v * 10) / 10); v /= scaleChar; }
    ramp.push(...downSteps.reverse());
    ramp.push(base);
    // Walk UP from body to display (positive steps).
    v = base * scaleChar;
    while (v <= maxSize * 1.05 && ramp.length < 30) { ramp.push(Math.round(v * 10) / 10); v *= scaleChar; }
    // Ensure display is included exactly.
    if (ramp[ramp.length - 1] < maxSize) ramp.push(maxSize);
    return ramp;
  };
  const fineRampPx = generateTypeRamp();

  /** Find the nearest value on a fine-grained ramp. For continuous quantities
   *  (size) the ramp is generated from pack tokens; the measurement informs
   *  which step, the step's value is the output. */
  const closestRampValue = (ramp: number[], targetPx: number): number => {
    let best = ramp[0], bestDiff = Infinity;
    for (const px of ramp) {
      const d = Math.abs(px - targetPx);
      if (d < bestDiff) { bestDiff = d; best = px; }
    }
    return best;
  };

  /** Compute a continuous spacing value clamped to the pack's spacing scale range.
   *  Law 0: the measurement (refSize × ratio) INFORMS the value; the pack
   *  constrains the range and grid. The output is a grid-aligned value within
   *  [min, max] of the pack's spacingScale — a generated ramp, not a raw
   *  measurement. The grid base is the first non-zero step. */
  const continuousSpacing = (targetPx: number): number => {
    const scale = pack.spacingScale;
    const min = scale[0] ?? 0;
    const max = scale[scale.length - 1] ?? 64;
    const gridBase = scale[1] ?? 4; // first non-zero step = grid unit
    const clamped = Math.max(min, Math.min(max, targetPx));
    // Snap to the nearest grid multiple — a pack-derived value, not a raw measurement.
    return Math.round(clamped / gridBase) * gridBase;
  };

  /** Compute a continuous line-height value clamped to the pack's lineHeightScale range.
   *  Law 0: snaps to the nearest generated step on a fine-grained ramp built from
   *  the pack's lineHeightScale endpoints, not a raw measurement. */
  const continuousLineHeight = (targetVal: number): number => {
    const scale = pack.lineHeightScale ?? [pack.lineHeight.body];
    const min = scale[0] ?? 1.0;
    const max = scale[scale.length - 1] ?? 2.0;
    const clamped = Math.max(min, Math.min(max, targetVal));
    // Generate a fine-grained ramp at 0.05 steps within [min, max].
    const ramp: number[] = [];
    for (let v = min; v <= max + 0.001; v += 0.05) ramp.push(Math.round(v * 100) / 100);
    // Find nearest step — a generated token, not a raw measurement.
    return ramp.reduce((best, v) => Math.abs(v - clamped) < Math.abs(best - clamped) ? v : best, ramp[0]);
  };

  /** Type ramp as an array aligned to TypeRole order: [display, heading, body, small]. */
  const rampRoles: TypeRole[] = ['display', 'heading', 'body', 'small'];
  const rampPx = rampRoles.map((r) => pack.typeRamp[r]);

  /** Map a type rank (0-3) to a TypeRole. */
  const rankToTypeRole = (rank: number): TypeRole => {
    return rampRoles[Math.min(3, Math.max(0, Math.round(rank)))];
  };

  /** Map a surface tier number to a SurfaceTier name. */
  const tierToSurface = (tier: number): SurfaceTier => {
    const tiers: SurfaceTier[] = ['flat', 'raised', 'overlay'];
    return tiers[Math.min(2, Math.max(0, Math.round(tier)))];
  };

  /** Derive a real MutationReason from the subject's and reference's actual
   *  situation. Never a constant — always grounded in the perception. If none
   *  of the four reasons apply, returns null (the op is correctly refused).
   *  F6: wired real reasons from the transformation engine. */
  const deriveMutationReason = (subject: Cluster, reference: Cluster | undefined, byHandle: Map<string, Cluster>): string | null => {
    // escape-overflow-hidden: subject is inside a container that clips it.
    // Walk the ancestor chain; if any ancestor is a scrollable or has
    // containment, the subject may be clipped.
    let cur: Cluster | undefined = subject;
    let depth = 0;
    while (cur && depth < 10) {
      if (cur.safety?.contained) return 'escape-overflow-hidden';
      cur = cur.layout.parentHandle ? byHandle.get(cur.layout.parentHandle) : undefined;
      depth++;
    }

    // escape-stacking-context: subject is position:fixed/sticky but trapped
    // behind a transformed/filtered ancestor, OR the subject's position is
    // non-static but its parent creates a stacking context.
    if (subject.layout.position === 'fixed' || subject.layout.position === 'sticky') {
      // A fixed/sticky element inside a transformed/filtered ancestor is trapped.
      // We don't have transform/filter in the ClusterStyle, but a non-static
      // parent with high depth is a reasonable proxy.
      let p = subject.layout.parentHandle ? byHandle.get(subject.layout.parentHandle) : undefined;
      while (p) {
        if (p.layout.position === 'fixed' || p.layout.position === 'sticky' || p.layout.position === 'absolute') {
          return 'escape-stacking-context';
        }
        p = p.layout.parentHandle ? byHandle.get(p.layout.parentHandle) : undefined;
      }
    }

    // cross-layout-regions: subject and reference are in different layout
    // regions (different parent containers, or different design roles that
    // imply different layout areas — e.g. sidebar→main).
    if (reference && subject.layout.parentHandle !== reference.layout.parentHandle) {
      // Different parents = different layout regions. A sidebar moving
      // to the main area, or a nav item moving to a different nav bar.
      return 'cross-layout-regions';
    }

    // impossible-ancestry: the subject's parent is a flex/grid container
    // and reordering within it would require `order` (which we refuse —
    // reading order is inviolable). CSS cannot express a source-order
    // change without DOM mutation.
    if (subject.layout.ownedByFlexGrid || (subject.layout.parentHandle && byHandle.get(subject.layout.parentHandle)?.layout.isContainer)) {
      return 'impossible-ancestry';
    }

    return null;
  };

  // ── The shared context handed to every domain resolver ──
  const ctx: RelationContext = {
    pack,
    byHandle,
    resolveSubject,
    resolveReference,
    ruleFor,
    compFor,
    addStyles,
    addLayout,
    fontSizePx,
    paddingPx,
    lineHeightValue,
    shadowTier,
    closestStep,
    closestRampValue,
    continuousSpacing,
    continuousLineHeight,
    deriveMutationReason,
    rankToTypeRole,
    tierToSurface,
    rampRoles,
    rampPx,
    fineRampPx,
    ops,
    notes,
    accent,
  };

  // ── Dispatch each relation to its domain handler ──
  // Iterates relations in the ORIGINAL order (not grouped by domain) so the
  // order-sensitive accent budget and the last-wins style merge are identical
  // to the inline switch. Composition relations are resolved by
  // resolveComposition, not here.
  for (const rel of relations) {
    if (COMPOSITION_RELATIONS.has(rel.relation)) continue;
    const subjects = resolveSubject(rel.subject);
    if (!subjects.length) {
      notes.push(`${rel.relation} ${rel.subject}: no clusters matched`);
      continue;
    }

    for (const c of subjects) {
      allTargets.add(c.handle);
      const handler = RELATION_HANDLERS[rel.relation];
      if (handler) handler(rel, c, ctx);
      else notes.push(`unknown relation: ${(rel as RelationStatement).relation}`);
    }
  }

  // Colour coverage: a cluster with no explicit text colour inherits its
  // author text colour. Assigning the pack text colour unconditionally is the
  // invisible-text defect: a cluster inheriting a LIGHT background gets the pack
  // text colour (e.g. #d8dde3 on white). The structural rule: never emit a text
  // colour unless we can PROVE contrast against a background we actually know —
  // one we set on the cluster (handled: those rules set their own bg+text), or
  // the cluster's effective background from the surface model. If the cluster's
  // effective background does not contrast with the pack text, leave the author
  // text colour alone (it already contrasts with the author background).
  const packText = parseColor(pack.colors.text);
  for (const handle of allTargets) {
    const r = rulesByHandle.get(handle);
    if (!r || !r.styles) continue;
    if ('color' in r.styles) continue;
    if ('background' in r.styles || 'backgroundColor' in r.styles || 'backgroundImage' in r.styles) continue;
    // No known background to prove contrast against -> leave the author colour.
    const cluster = byHandle.get(handle);
    const effBg = cluster?.background?.effectiveColor;
    if (!effBg || !packText) continue;
    const bg = parseColor(effBg);
    if (!bg) continue;
    if (contrastRatio(packText, bg) < MIN_CONTRAST_RATIO) continue; // would be invisible
    r.styles.color = pack.colors.text;
  }

  const rules = [...rulesByHandle.values()].filter((r) => r.styles || r.layout || r.hover || r.focusVisible || r.hide);
  const composition = [...compositionByHandle.values()].filter((r) => r.styles || r.layout || r.hide);

  const escapeCount = [...escapeHatchUses].filter((h) => allTargets.has(h) || byHandle.has(h)).length;
  const totalTargets = allTargets.size || 1;
  const escapeHatchFraction = escapeCount / totalTargets;

  return { rules, composition, ops, escapeHatchUses: [...escapeHatchUses], escapeHatchFraction, expandedTargets: [...allTargets], pack, notes };
}

/** Resolve a pack from a spec (for conformance). */
export function packForSpec(spec: DesignSpec): DesignPack {
  return resolvePack(spec.pack, spec.packOverrides);
}

export type { DesignPack, TypeRole, SurfaceTier };
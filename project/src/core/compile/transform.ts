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
 */

import type { DesignSpec, DesignRule, DesignOp, StyleDecls, LayoutDecls } from '../spec/index.ts';
import type { Perception, Cluster } from '../perceive/index.ts';
import type { DesignRole } from '../perceive/semantic.ts';
import { resolvePack, type DesignPack, type TypeRole, type SurfaceTier } from '../design/packs.ts';
import type { RelationStatement, Subject, AlignmentEdge } from '../design/vocabulary.ts';
import { COMPOSITION_RELATIONS, resolveComposition } from './relations/composition.ts';
export { resolveComposition };

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

  // Accent tracking for the pack's maxAccentCount principle.
  let accentCount = 0;

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

  for (const rel of relations) {
    // Composition relations are resolved by resolveComposition, not here.
    if (COMPOSITION_RELATIONS.has(rel.relation)) continue;
    const subjects = resolveSubject(rel.subject);
    if (!subjects.length) {
      notes.push(`${rel.relation} ${rel.subject}: no clusters matched`);
      continue;
    }

    for (const c of subjects) {
      allTargets.add(c.handle);

      switch (rel.relation) {
        // ── Size relations ──
        case 'sizeRatio': {
          const refs = resolveReference(rel.reference, c);
          if (!refs.length) { notes.push(`sizeRatio ${rel.subject}: reference "${rel.reference}" not found`); break; }
          // Enforce minTypeScaleRatio: the model's ratio must produce at least
          // the pack's minimum type-scale step (a ratio below this is a no-op visually).
          const minRatio = pack.principles?.minTypeScaleRatio ?? 1;
          const effectiveRatio = rel.ratio < minRatio && rel.ratio >= 1
            ? (notes.push(`sizeRatio ${rel.subject}: ratio ${rel.ratio} < minTypeScaleRatio ${minRatio}, clamped`) || minRatio)
            : rel.ratio;
          // F2 fix: generate the ramp from the pack's base + scale character
          // instead of snapping to a fixed 4-value ramp. The measurement
          // (refSize × ratio) informs which step; the generated step value
          // (derived from pack tokens) is the output — Law 0 preserved.
          const targetPx = fontSizePx(refs[0]) * effectiveRatio;
          const fontSize = closestRampValue(fineRampPx, targetPx);
          // Find the matching lineHeight from the pack's named roles: the
          // closest named role to the generated font-size gets its lineHeight.
          const tr = rampRoles[closestStep(rampPx, fontSize)];
          addLayout(ruleFor(c.handle), {
            fontSize: `${fontSize}px`,
            lineHeight: String(pack.lineHeight[tr]),
          });
          break;
        }
        case 'typeRank': {
          const tr = rankToTypeRole(rel.rank);
          addLayout(ruleFor(c.handle), {
            fontSize: `${pack.typeRamp[tr]}px`,
            lineHeight: String(pack.lineHeight[tr]),
          });
          break;
        }

        // ── Rank and hierarchy ──
        case 'outranks': {
          const refs = resolveReference(rel.reference, c);
          if (!refs.length) { notes.push(`outranks ${rel.subject}: reference "${rel.reference}" not found`); break; }
          // Law 0: find the reference's current ramp rank, step up one;
          // emit the pack token at the new rank.
          const refRank = closestStep(rampPx, fontSizePx(refs[0]));
          const newRank = Math.max(0, refRank - 1);
          const tr = rampRoles[newRank];
          addLayout(ruleFor(c.handle), {
            fontSize: `${pack.typeRamp[tr]}px`,
            lineHeight: String(pack.lineHeight[tr]),
          });
          break;
        }
        case 'emphasisRank': {
          // Emphasis hierarchy: rank 0 = highest, progressively de-emphasised.
          // Every rank emits real CSS — the vocabulary promised it.
          const wScale = pack.fontWeightScale;
          // Map rank to a weight index (0=highest emphasis → 4=lightest).
          const wi = Math.min(wScale.length - 1, Math.max(0, rel.rank));
          addLayout(ruleFor(c.handle), { fontWeight: String(wScale[Math.max(0, wScale.length - 1 - wi)]) });
          // Ranks 3+ also get the pack's muted colour — visual de-emphasis.
          if (rel.rank >= 3) {
            addStyles(ruleFor(c.handle), { color: pack.colors.subtle });
          }
          break;
        }

        // ── Spacing relations ──
        case 'spacingStep': {
          const step = Math.max(pack.principles.densityRange[0], Math.min(pack.principles.densityRange[1], rel.step));
          const px = pack.spacingScale[step] ?? 0;
          addStyles(ruleFor(c.handle), { padding: `${px}px` });
          break;
        }
        case 'spacingRatio': {
          const refs = resolveReference(rel.reference, c);
          if (!refs.length) { notes.push(`spacingRatio ${rel.subject}: reference not found`); break; }
          // F2 fix: continuous spacing — compute the actual value and clamp
          // to the pack's spacing range + grid. No more snapping to 9 fixed steps.
          const targetPx = paddingPx(refs[0]) * rel.ratio;
          const px = continuousSpacing(targetPx);
          addStyles(ruleFor(c.handle), { padding: `${px}px` });
          break;
        }
        case 'gapStep': {
          const step = Math.max(pack.principles.densityRange[0], Math.min(pack.principles.densityRange[1], rel.step));
          const px = pack.spacingScale[step] ?? 0;
          addLayout(ruleFor(c.handle), { gap: `${px}px` });
          break;
        }
        case 'gapRatio': {
          const refs = resolveReference(rel.reference, c);
          if (!refs.length) { notes.push(`gapRatio ${rel.subject}: reference not found`); break; }
          // F2 fix: continuous gap — compute the actual value and clamp.
          const targetPx = (refs[0].layout.siblingGapPx ?? pack.spacingScale[3] ?? 12) * rel.ratio;
          const px = continuousSpacing(targetPx);
          addLayout(ruleFor(c.handle), { gap: `${px}px` });
          break;
        }
        case 'marginStep': {
          const px = pack.spacingScale[rel.step] ?? 0;
          addLayout(ruleFor(c.handle), { margin: `${px}px` });
          break;
        }
        case 'marginEquals': {
          const refs = resolveReference(rel.reference, c);
          if (!refs.length) { notes.push(`marginEquals ${rel.subject}: reference not found`); break; }
          // F2 fix: continuous margin — compute the actual value and clamp.
          const targetPx = refs[0].layout.siblingGapPx ?? 0;
          const px = continuousSpacing(targetPx);
          addLayout(ruleFor(c.handle), { margin: `${px}px` });
          break;
        }
        case 'paddingSide': {
          // Clamp to densityRange like spacingStep — per-side override, same density limits.
          const [dMin, dMax] = pack.principles?.densityRange ?? [0, 20];
          const step = Math.max(dMin, Math.min(dMax, rel.step));
          const px = pack.spacingScale[step] ?? 0;
          const key = rel.side === 'all' ? 'padding' : `padding${rel.side.charAt(0).toUpperCase()}${rel.side.slice(1)}`;
          addStyles(ruleFor(c.handle), { [key]: `${px}px` });
          break;
        }

        // ── Alignment relations ──
        case 'alignsWith': {
          // Emit the alignment edge as a layout property.
          const edgeMap: Record<AlignmentEdge, string> = {
            start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch',
          };
          addLayout(ruleFor(c.handle), { alignItems: edgeMap[rel.edge] });
          break;
        }

        // ── Elevation relations ──
        case 'elevationAbove': {
          const refs = resolveReference(rel.reference, c);
          if (!refs.length) { notes.push(`elevationAbove ${rel.subject}: reference not found`); break; }
          const refTier = shadowTier(refs[0]);
          const newTier = Math.min(pack.shadowScale.length - 1, refTier + rel.levels);
          const shadow = pack.shadowScale[newTier] ?? 'none';
          addStyles(ruleFor(c.handle), { boxShadow: shadow });
          break;
        }
        case 'elevationStep': {
          const step = Math.min(pack.shadowScale.length - 1, Math.max(0, rel.step));
          addStyles(ruleFor(c.handle), { boxShadow: pack.shadowScale[step] ?? 'none' });
          break;
        }

        // ── Colour role assignment ──
        case 'accentRole': {
          const limit = Math.min(rel.maxCount, pack.principles.maxAccentCount);
          if (accentCount >= limit) {
            notes.push(`accentRole ${rel.subject}: REFUSED — accent budget exhausted (${accentCount}/${limit})`);
            break;
          }
          const color = pack.colors.accents[rel.role];
          if (!color) { notes.push(`accentRole ${rel.subject}: accent "${rel.role}" not found in pack`); break; }
          accentCount++;
          addStyles(ruleFor(c.handle), { background: color });
          break;
        }
        case 'accentOn': {
          if (accentCount >= pack.principles.maxAccentCount) {
            notes.push(`accentOn ${rel.subject}: REFUSED — accent budget exhausted (${accentCount}/${pack.principles.maxAccentCount})`);
            break;
          }
          const color = pack.colors.accents[rel.role];
          if (!color) { notes.push(`accentOn ${rel.subject}: accent "${rel.role}" not found in pack`); break; }
          accentCount++;
          if (rel.target === 'text') addStyles(ruleFor(c.handle), { color });
          else if (rel.target === 'border') addStyles(ruleFor(c.handle), { borderColor: color, borderStyle: 'solid', borderWidth: `${pack.borderScale[1] ?? 1}px` });
          else addStyles(ruleFor(c.handle), { background: color });
          break;
        }

        // ── Proportional width allocation ──
        case 'widthFraction': {
          const refs = resolveReference(rel.reference, c);
          if (!refs.length) { notes.push(`widthFraction ${rel.subject}: reference not found`); break; }
          const pct = Math.round(rel.fraction * 100);
          const r = compFor(c.handle);
          addLayout(r, { width: `${pct}%` });
          break;
        }

        // ── Grouping ──
        case 'groupWith': {
          // Advisory: set display:flex on the parent so children share a
          // formatting context. Direction and wrapping are declared via
          // composition relations (stackDirection, wrapBehavior), not
          // assumed here — Law 0 rule 2: don't impose a direction on
          // something that already had one.
          const parent = resolveSubject('parent', c);
          if (parent.length) {
            const r = compFor(parent[0].handle);
            addLayout(r, { display: 'flex' });
          }
          notes.push(`groupWith ${rel.subject} → ${rel.reference}: parent set to flex (advisory)`);
          break;
        }

        // ── Typography details ──
        case 'letterSpacingStep': {
          const val = pack.letterSpacingScale[rel.step] ?? '0em';
          addStyles(ruleFor(c.handle), { letterSpacing: val });
          break;
        }
        case 'wordSpacingStep': {
          const val = pack.wordSpacingScale[rel.step] ?? '0em';
          addStyles(ruleFor(c.handle), { wordSpacing: val });
          break;
        }
        case 'fontWeightRank': {
          const w = pack.fontWeightScale[rel.rank - 1] ?? 400;
          addLayout(ruleFor(c.handle), { fontWeight: String(w) });
          break;
        }
        case 'textTransform': {
          addStyles(ruleFor(c.handle), { textTransform: rel.transform });
          break;
        }
        case 'lineHeightStep': {
          const val = pack.lineHeightScale[rel.step] ?? pack.lineHeight.body;
          addLayout(ruleFor(c.handle), { lineHeight: String(val) });
          break;
        }
        case 'lineHeightRatio': {
          // F2 fix: continuous line-height — compute the actual value and clamp
          // to the pack's lineHeightScale range. No more snapping to fixed steps.
          const refs = resolveReference(rel.reference, c);
          if (!refs.length) { notes.push(`lineHeightRatio ${rel.subject}: reference not found`); break; }
          const targetVal = lineHeightValue(refs[0]) * rel.ratio;
          const lh = continuousLineHeight(targetVal);
          addLayout(ruleFor(c.handle), { lineHeight: String(lh) });
          break;
        }

        // ── Surface details ──
        case 'radiusCorner': {
          const rv = pack.radiusScale[rel.step] ?? 0;
          const radius = rv >= 999 ? '9999px' : `${rv}px`;
          if (rel.corner === 'all') {
            addStyles(ruleFor(c.handle), { borderRadius: radius });
          } else {
            const map: Record<string, string> = { tl: 'borderTopLeftRadius', tr: 'borderTopRightRadius', br: 'borderBottomRightRadius', bl: 'borderBottomLeftRadius' };
            addStyles(ruleFor(c.handle), { [map[rel.corner]]: radius });
          }
          break;
        }
        case 'borderWeight': {
          const w = pack.borderScale[rel.step] ?? 0;
          addStyles(ruleFor(c.handle), { borderWidth: `${w}px`, borderStyle: 'solid', borderColor: pack.colors.subtle });
          break;
        }
        case 'surfaceTier': {
          const p = pack.principles;
          // raiseSurface gate: refuse raising when the pack forbids it.
          if (p.raiseSurface === 'never' && rel.tier > 0) {
            notes.push(`surfaceTier ${rel.subject}: REFUSED — raiseSurface=never, tier ${rel.tier} > 0`);
            break;
          }
          if (p.raiseSurface === 'on-overlay' && rel.tier === 1) {
            notes.push(`surfaceTier ${rel.subject}: REFUSED — raiseSurface=on-overlay, raised (tier 1) not allowed`);
            break;
          }
          const surf = pack.surfaces[tierToSurface(rel.tier)];
          if (!surf) { notes.push(`surfaceTier ${rel.subject}: tier ${rel.tier} has no surface in pack`); break; }
          addStyles(ruleFor(c.handle), { background: surf.bg });
          // surfaceDefinition gate: border-only, shadow-only, or both.
          const useBorder = p.surfaceDefinition !== 'shadow' && !!surf.border;
          const useShadow = p.surfaceDefinition !== 'border' && !!surf.shadow;
          if (useBorder && surf.border) {
            const bm = surf.border.match(/^(\d+px)\s+(solid)\s+(.+)$/);
            if (bm) addStyles(ruleFor(c.handle), { borderWidth: bm[1], borderStyle: bm[2], borderColor: bm[3] });
            else addStyles(ruleFor(c.handle), { border: surf.border });
          }
          if (useShadow && surf.shadow) addStyles(ruleFor(c.handle), { boxShadow: surf.shadow });
          break;
        }

        // ── Layout ──
        case 'proseColumns': {
          addLayout(ruleFor(c.handle), { columnCount: String(rel.count) });
          break;
        }

        // ── Structural ops ──
        case 'hide': {
          if (c.designRoleConfidence < DESTRUCTIVE_CONFIDENCE_FLOOR) {
            notes.push(`hide ${rel.subject} (${c.handle}): REFUSED — role ${c.designRole}@${c.designRoleConfidence.toFixed(2)} < ${DESTRUCTIVE_CONFIDENCE_FLOOR} (hard-safety rule)`);
            break;
          }
          // Safety gates (same as the old hideRefusal).
          if (c.role === 'main' || c.role === 'article') { notes.push(`hide ${c.handle}: REFUSED — primary-content`); break; }
          if (c.layout.isPassiveWrapper || c.layout.isOpaqueWrapper) { notes.push(`hide ${c.handle}: REFUSED — wrapper`); break; }
          if (c.rect.h > 300) { notes.push(`hide ${c.handle}: REFUSED — tall-content`); break; }
          ruleFor(c.handle).hide = true;
          break;
        }
        case 'reorderBefore': {
          const refs = resolveReference(rel.reference, c);
          if (!refs.length) { notes.push(`reorderBefore ${rel.subject}: reference not found`); break; }
          if (c.moveSafety !== 'safe') { notes.push(`reorderBefore ${c.handle}: REFUSED — moveSafety=${c.moveSafety}`); break; }
          // F6: derive a real MutationReason from the actual situation.
          const reason = deriveMutationReason(c, refs[0], byHandle);
          if (!reason) {
            notes.push(`reorderBefore ${c.handle}: REFUSED — no MutationReason applies (CSS can express this without DOM mutation)`);
            break;
          }
          ops.push({ kind: 'reorder', target: c.handle, before: refs[0].handle, reason });
          break;
        }
        case 'moveTo': {
          const refs = resolveReference(rel.reference, c);
          if (!refs.length) { notes.push(`moveTo ${rel.subject}: reference not found`); break; }
          if (c.moveSafety === 'forbidden') { notes.push(`moveTo ${c.handle}: REFUSED — forbidden`); break; }
          // F6: derive a real MutationReason from the actual situation.
          const reason = deriveMutationReason(c, refs[0], byHandle);
          if (!reason) {
            notes.push(`moveTo ${c.handle}: REFUSED — no MutationReason applies (CSS can express this without DOM mutation)`);
            break;
          }
          ops.push({ kind: 'move', target: c.handle, to: refs[0].handle, reason });
          break;
        }

        // ── Motion (F4) ──
        // All motion CSS is transform/opacity only — never triggers reflow.
        // prefers-reduced-motion is honoured absolutely: the entire motion layer
        // is wrapped in @media (prefers-reduced-motion: no-preference) at compile.
        case 'transitionTier': {
          if (!pack.motionAnimated) { notes.push(`transitionTier ${c.handle}: REFUSED — pack is not animated`); break; }
          const dur = pack.motionDurationScale[Math.min(pack.motionDurationScale.length - 1, Math.max(0, rel.tier))] ?? 0;
          if (dur === 0) break; // tier 0 = no transition
          addStyles(ruleFor(c.handle), {
            transition: `transform ${dur}ms var(--rv-easing, ease-out), opacity ${dur}ms var(--rv-easing, ease-out), box-shadow ${dur}ms var(--rv-easing, ease-out)`,
          });
          break;
        }
        case 'transitionEasing': {
          if (!pack.motionAnimated) { notes.push(`transitionEasing ${c.handle}: REFUSED — pack is not animated`); break; }
          const easing = pack.motionEasing[rel.easing] ?? 'ease-out';
          addStyles(ruleFor(c.handle), { ['--rv-easing' as string]: easing });
          break;
        }
        case 'entranceDelay': {
          if (!pack.motionAnimated) { notes.push(`entranceDelay ${c.handle}: REFUSED — pack is not animated`); break; }
          const delayScale = pack.motionDurationScale;
          const delay = delayScale[Math.min(delayScale.length - 1, Math.max(0, rel.tier))] ?? 0;
          // Entrance: opacity 0→1 + translateY(8px→0). Transform+opacity only.
          // The stagger is driven by the tier (reading order → tier mapping).
          addStyles(ruleFor(c.handle), {
            animation: `rv-enter ${delayScale[delayScale.length - 1] ?? 300}ms var(--rv-easing, ease-out) ${delay}ms both`,
          });
          break;
        }
        case 'hoverElevate': {
          if (!pack.motionAnimated) { notes.push(`hoverElevate ${c.handle}: REFUSED — pack is not animated`); break; }
          const newTier = Math.min(pack.shadowScale.length - 1, shadowTier(c) + rel.levels);
          const shadow = pack.shadowScale[newTier] ?? 'none';
          const r = ruleFor(c.handle);
          // Hover: transform-based lift (no layout movement) + shadow. Step from pack.
          const lift = pack.spacingScale[1] ?? 4;
          r.hover = { ...(r.hover ?? {}), transform: `translateY(-${lift}px)`, boxShadow: shadow };
          break;
        }
        case 'focusRing': {
          const color = pack.colors.accents[rel.role];
          if (!color) { notes.push(`focusRing ${c.handle}: accent "${rel.role}" not found in pack`); break; }
          const r = ruleFor(c.handle);
          // Outline width from pack borderScale, offset from pack spacingScale.
          const ow = pack.borderScale[2] ?? 2;
          const oo = pack.spacingScale[1] ?? 4;
          r.focusVisible = { ...(r.focusVisible ?? {}), outline: `${ow}px solid ${color}`, outlineOffset: `${oo}px` };
          break;
        }

        // ── Interaction (F5) ──
        case 'movable': {
          // Opt-in movable capability. Transform-based: no DOM mutation.
          // The compile layer adds cursor:grab + touch-action:none + a CSS class
          // that enables the runtime drag handler. The drag handler applies
          // transform: translate() only — never mutates style.position, never
          // moves DOM nodes. Fully reversible: clear the transform.
          const step = pack.spacingScale[1] ?? 4;
          addStyles(ruleFor(c.handle), {
            cursor: 'grab',
            ['--rv-movable' as string]: '1',
            ['--rv-movable-step' as string]: `${step}px`,
            touchAction: 'none',
          });
          break;
        }

        default: {
          notes.push(`unknown relation: ${(rel as RelationStatement).relation}`);
        }
      }
    }
  }

  // Colour coverage: every addressed cluster gets a text colour from the pack.
  for (const handle of allTargets) {
    const r = rulesByHandle.get(handle);
    if (!r || !r.styles) continue;
    if ('color' in r.styles) continue;
    if ('background' in r.styles || 'backgroundColor' in r.styles || 'backgroundImage' in r.styles) continue;
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

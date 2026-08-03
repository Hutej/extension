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
   *  the measurement informs WHICH step, the step's value is the output. */
  const closestStep = (scale: number[], targetPx: number): number => {
    let best = 0, bestDiff = Infinity;
    scale.forEach((px, i) => {
      const d = Math.abs(px - targetPx);
      if (d < bestDiff) { bestDiff = d; best = i; }
    });
    return best;
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

  for (const rel of relations) {
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
          // Law 0: measurement (refSize × ratio) INFORMS which ramp step;
          // the pack token at that step is the output — never the raw px.
          const targetPx = fontSizePx(refs[0]) * effectiveRatio;
          const tr = rampRoles[closestStep(rampPx, targetPx)];
          addLayout(ruleFor(c.handle), {
            fontSize: `${pack.typeRamp[tr]}px`,
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
          // Pure emphasis: bold for high-emphasis ranks (0-1). Does NOT emit
          // fontSize/lineHeight — typeRank owns type-size; emphasisRank owns weight.
          if (rel.rank <= 1) {
            addLayout(ruleFor(c.handle), { fontWeight: String(pack.fontWeightScale[3]) });
          } else {
            notes.push(`emphasisRank rank=${rel.rank} on "${rel.subject}" — no style emitted (only ranks 0-1 bold)`);
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
          // Law 0: measurement (refPadding × ratio) INFORMS which scale step;
          // the pack token at that step is the output.
          const targetPx = paddingPx(refs[0]) * rel.ratio;
          const step = Math.max(pack.principles.densityRange[0], Math.min(pack.principles.densityRange[1], closestStep(pack.spacingScale, targetPx)));
          addStyles(ruleFor(c.handle), { padding: `${pack.spacingScale[step] ?? 0}px` });
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
          // Law 0: measurement (refGap × ratio) INFORMS which scale step.
          const targetPx = (refs[0].layout.siblingGapPx ?? pack.spacingScale[3] ?? 12) * rel.ratio;
          const step = Math.max(pack.principles.densityRange[0], Math.min(pack.principles.densityRange[1], closestStep(pack.spacingScale, targetPx)));
          addLayout(ruleFor(c.handle), { gap: `${pack.spacingScale[step] ?? 0}px` });
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
          // Law 0: measurement (sibling gap proxy) INFORMS which scale step.
          const targetPx = refs[0].layout.siblingGapPx ?? 0;
          const step = closestStep(pack.spacingScale, targetPx);
          addLayout(ruleFor(c.handle), { margin: `${pack.spacingScale[step] ?? 0}px` });
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
          // Emit display:flex on the subject's parent so the children
          // (subject + reference siblings) align as a row.
          const parent = resolveSubject('parent', c);
          if (parent.length) {
            addLayout(compFor(parent[0].handle), { display: 'flex' });
          }
          notes.push(`groupWith ${rel.subject} → ${rel.reference}: parent set to flex`);
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
          // Law 0: measurement (ref lineHeight × ratio) INFORMS which pack
          // lineHeightScale step; the pack token at that step is the output.
          const refs = resolveReference(rel.reference, c);
          if (!refs.length) { notes.push(`lineHeightRatio ${rel.subject}: reference not found`); break; }
          const targetVal = lineHeightValue(refs[0]) * rel.ratio;
          const scale = pack.lineHeightScale ?? [pack.lineHeight.body];
          const closestLh = scale.reduce((best, v) => Math.abs(v - targetVal) < Math.abs(best - targetVal) ? v : best, scale[0]);
          addLayout(ruleFor(c.handle), { lineHeight: String(closestLh) });
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
        case 'columnCount': {
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
          ops.push({ kind: 'reorder', target: c.handle, before: refs[0].handle });
          break;
        }
        case 'moveTo': {
          const refs = resolveReference(rel.reference, c);
          if (!refs.length) { notes.push(`moveTo ${rel.subject}: reference not found`); break; }
          if (c.moveSafety === 'forbidden') { notes.push(`moveTo ${c.handle}: REFUSED — forbidden`); break; }
          ops.push({ kind: 'move', target: c.handle, to: refs[0].handle });
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

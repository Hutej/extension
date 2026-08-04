/**
 * compile/relations/surface — surface & elevation relations: radiusCorner,
 * borderWeight, surfaceTier, elevationAbove, elevationStep.
 *
 * Extracted from transform.ts (pure move, no behaviour change).
 */

import type { RelationHandlerMap, RelOf } from './context.ts';

export const surfaceHandlers: RelationHandlerMap = {
  radiusCorner(rel, c, ctx) {
    const { pack, ruleFor, addStyles } = ctx;
    const r = rel as RelOf<'radiusCorner'>;
    const rv = pack.radiusScale[r.step] ?? 0;
    const radius = rv >= 999 ? '9999px' : `${rv}px`;
    if (r.corner === 'all') {
      addStyles(ruleFor(c.handle), { borderRadius: radius });
    } else {
      const map: Record<string, string> = { tl: 'borderTopLeftRadius', tr: 'borderTopRightRadius', br: 'borderBottomRightRadius', bl: 'borderBottomLeftRadius' };
      addStyles(ruleFor(c.handle), { [map[r.corner]]: radius });
    }
  },
  borderWeight(rel, c, ctx) {
    const { pack, ruleFor, addStyles } = ctx;
    const r = rel as RelOf<'borderWeight'>;
    const w = pack.borderScale[r.step] ?? 0;
    addStyles(ruleFor(c.handle), { borderWidth: `${w}px`, borderStyle: 'solid', borderColor: pack.colors.subtle });
  },
  surfaceTier(rel, c, ctx) {
    const { pack, tierToSurface, ruleFor, addStyles, notes } = ctx;
    const r = rel as RelOf<'surfaceTier'>;
    const p = pack.principles;
    // raiseSurface gate: refuse raising when the pack forbids it.
    if (p.raiseSurface === 'never' && r.tier > 0) {
      notes.push(`surfaceTier ${r.subject}: REFUSED — raiseSurface=never, tier ${r.tier} > 0`);
      return;
    }
    if (p.raiseSurface === 'on-overlay' && r.tier === 1) {
      notes.push(`surfaceTier ${r.subject}: REFUSED — raiseSurface=on-overlay, raised (tier 1) not allowed`);
      return;
    }
    const surf = pack.surfaces[tierToSurface(r.tier)];
    if (!surf) { notes.push(`surfaceTier ${r.subject}: tier ${r.tier} has no surface in pack`); return; }
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
  },
  elevationAbove(rel, c, ctx) {
    const { resolveReference, shadowTier, pack, ruleFor, addStyles, notes } = ctx;
    const r = rel as RelOf<'elevationAbove'>;
    const refs = resolveReference(r.reference, c);
    if (!refs.length) { notes.push(`elevationAbove ${r.subject}: reference not found`); return; }
    const refTier = shadowTier(refs[0]);
    const newTier = Math.min(pack.shadowScale.length - 1, refTier + r.levels);
    const shadow = pack.shadowScale[newTier] ?? 'none';
    addStyles(ruleFor(c.handle), { boxShadow: shadow });
  },
  elevationStep(rel, c, ctx) {
    const { pack, ruleFor, addStyles } = ctx;
    const r = rel as RelOf<'elevationStep'>;
    const step = Math.min(pack.shadowScale.length - 1, Math.max(0, r.step));
    addStyles(ruleFor(c.handle), { boxShadow: pack.shadowScale[step] ?? 'none' });
  },
};

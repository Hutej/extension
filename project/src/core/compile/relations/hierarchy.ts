/**
 * compile/relations/hierarchy — rank & hierarchy relations: outranks, emphasisRank.
 *
 * Extracted from transform.ts (pure move, no behaviour change).
 */

import type { RelationHandlerMap, RelOf } from './context.ts';

export const hierarchyHandlers: RelationHandlerMap = {
  outranks(rel, c, ctx) {
    const { resolveReference, closestStep, rampPx, fontSizePx, rampRoles, pack, ruleFor, addLayout, notes } = ctx;
    const r = rel as RelOf<'outranks'>;
    const refs = resolveReference(r.reference, c);
    if (!refs.length) { notes.push(`outranks ${r.subject}: reference "${r.reference}" not found`); return; }
    // Law 0: find the reference's current ramp rank, step up one;
    // emit the pack token at the new rank.
    const refRank = closestStep(rampPx, fontSizePx(refs[0]));
    const newRank = Math.max(0, refRank - 1);
    const tr = rampRoles[newRank];
    addLayout(ruleFor(c.handle), {
      fontSize: `${pack.typeRamp[tr]}px`,
      lineHeight: String(pack.lineHeight[tr]),
    });
  },
  emphasisRank(rel, c, ctx) {
    const { pack, ruleFor, addLayout, addStyles } = ctx;
    const r = rel as RelOf<'emphasisRank'>;
    // Emphasis hierarchy: rank 0 = highest, progressively de-emphasised.
    // Every rank emits real CSS — the vocabulary promised it.
    const wScale = pack.fontWeightScale;
    // Map rank to a weight index (0=highest emphasis → 4=lightest).
    const wi = Math.min(wScale.length - 1, Math.max(0, r.rank));
    addLayout(ruleFor(c.handle), { fontWeight: String(wScale[Math.max(0, wScale.length - 1 - wi)]) });
    // Ranks 3+ also get the pack's muted colour — visual de-emphasis.
    if (r.rank >= 3) {
      addStyles(ruleFor(c.handle), { color: pack.colors.subtle });
    }
  },
};

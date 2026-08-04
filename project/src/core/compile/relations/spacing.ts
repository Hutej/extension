/**
 * compile/relations/spacing — spacing relations: spacingStep, spacingRatio,
 * gapStep, gapRatio, marginStep, marginEquals, paddingSide.
 *
 * Extracted from transform.ts (pure move, no behaviour change). The case bodies
 * are verbatim; only `ctx.*` access (via destructuring) and a type-only cast of
 * `rel` to its narrowed variant were added.
 */

import type { RelationHandlerMap, RelOf } from './context.ts';

export const spacingHandlers: RelationHandlerMap = {
  spacingStep(rel, c, ctx) {
    const { pack, ruleFor, addStyles } = ctx;
    const r = rel as RelOf<'spacingStep'>;
    const step = Math.max(pack.principles.densityRange[0], Math.min(pack.principles.densityRange[1], r.step));
    const px = pack.spacingScale[step] ?? 0;
    addStyles(ruleFor(c.handle), { padding: `${px}px` });
  },
  spacingRatio(rel, c, ctx) {
    const { resolveReference, paddingPx, continuousSpacing, ruleFor, addStyles, notes } = ctx;
    const r = rel as RelOf<'spacingRatio'>;
    const refs = resolveReference(r.reference, c);
    if (!refs.length) { notes.push(`spacingRatio ${r.subject}: reference not found`); return; }
    // F2 fix: continuous spacing — compute the actual value and clamp
    // to the pack's spacing range + grid. No more snapping to 9 fixed steps.
    const targetPx = paddingPx(refs[0]) * r.ratio;
    const px = continuousSpacing(targetPx);
    addStyles(ruleFor(c.handle), { padding: `${px}px` });
  },
  gapStep(rel, c, ctx) {
    const { pack, ruleFor, addLayout } = ctx;
    const r = rel as RelOf<'gapStep'>;
    const step = Math.max(pack.principles.densityRange[0], Math.min(pack.principles.densityRange[1], r.step));
    const px = pack.spacingScale[step] ?? 0;
    addLayout(ruleFor(c.handle), { gap: `${px}px` });
  },
  gapRatio(rel, c, ctx) {
    const { resolveReference, pack, continuousSpacing, ruleFor, addLayout, notes } = ctx;
    const r = rel as RelOf<'gapRatio'>;
    const refs = resolveReference(r.reference, c);
    if (!refs.length) { notes.push(`gapRatio ${r.subject}: reference not found`); return; }
    // F2 fix: continuous gap — compute the actual value and clamp.
    const targetPx = (refs[0].layout.siblingGapPx ?? pack.spacingScale[3] ?? 12) * r.ratio;
    const px = continuousSpacing(targetPx);
    addLayout(ruleFor(c.handle), { gap: `${px}px` });
  },
  marginStep(rel, c, ctx) {
    const { pack, ruleFor, addLayout } = ctx;
    const r = rel as RelOf<'marginStep'>;
    const px = pack.spacingScale[r.step] ?? 0;
    addLayout(ruleFor(c.handle), { margin: `${px}px` });
  },
  marginEquals(rel, c, ctx) {
    const { resolveReference, continuousSpacing, ruleFor, addLayout, notes } = ctx;
    const r = rel as RelOf<'marginEquals'>;
    const refs = resolveReference(r.reference, c);
    if (!refs.length) { notes.push(`marginEquals ${r.subject}: reference not found`); return; }
    // F2 fix: continuous margin — compute the actual value and clamp.
    const targetPx = refs[0].layout.siblingGapPx ?? 0;
    const px = continuousSpacing(targetPx);
    addLayout(ruleFor(c.handle), { margin: `${px}px` });
  },
  paddingSide(rel, c, ctx) {
    const { pack, ruleFor, addStyles } = ctx;
    const r = rel as RelOf<'paddingSide'>;
    // Clamp to densityRange like spacingStep — per-side override, same density limits.
    const [dMin, dMax] = pack.principles?.densityRange ?? [0, 20];
    const step = Math.max(dMin, Math.min(dMax, r.step));
    const px = pack.spacingScale[step] ?? 0;
    const key = r.side === 'all' ? 'padding' : `padding${r.side.charAt(0).toUpperCase()}${r.side.slice(1)}`;
    addStyles(ruleFor(c.handle), { [key]: `${px}px` });
  },
};

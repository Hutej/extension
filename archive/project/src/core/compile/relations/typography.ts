/**
 * compile/relations/typography — type & typography-detail relations: sizeRatio,
 * typeRank, lineHeightStep, lineHeightRatio, letterSpacingStep, wordSpacingStep,
 * fontWeightRank, textTransform.
 *
 * Extracted from transform.ts (pure move, no behaviour change).
 */

import type { RelationHandlerMap, RelOf } from './context.ts';

export const typographyHandlers: RelationHandlerMap = {
  sizeRatio(rel, c, ctx) {
    const { resolveReference, fontSizePx, closestRampValue, fineRampPx, rampRoles, closestStep, rampPx, pack, ruleFor, addLayout, notes } = ctx;
    const r = rel as RelOf<'sizeRatio'>;
    const refs = resolveReference(r.reference, c);
    if (!refs.length) { notes.push(`sizeRatio ${r.subject}: reference "${r.reference}" not found`); return; }
    // Enforce minTypeScaleRatio: the model's ratio must produce at least
    // the pack's minimum type-scale step (a ratio below this is a no-op visually).
    const minRatio = pack.principles?.minTypeScaleRatio ?? 1;
    const effectiveRatio = r.ratio < minRatio && r.ratio >= 1
      ? (notes.push(`sizeRatio ${r.subject}: ratio ${r.ratio} < minTypeScaleRatio ${minRatio}, clamped`) || minRatio)
      : r.ratio;
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
  },
  typeRank(rel, c, ctx) {
    const { rankToTypeRole, pack, ruleFor, addLayout } = ctx;
    const r = rel as RelOf<'typeRank'>;
    const tr = rankToTypeRole(r.rank);
    addLayout(ruleFor(c.handle), {
      fontSize: `${pack.typeRamp[tr]}px`,
      lineHeight: String(pack.lineHeight[tr]),
    });
  },
  lineHeightStep(rel, c, ctx) {
    const { pack, ruleFor, addLayout } = ctx;
    const r = rel as RelOf<'lineHeightStep'>;
    const val = pack.lineHeightScale[r.step] ?? pack.lineHeight.body;
    addLayout(ruleFor(c.handle), { lineHeight: String(val) });
  },
  lineHeightRatio(rel, c, ctx) {
    const { resolveReference, lineHeightValue, continuousLineHeight, ruleFor, addLayout, notes } = ctx;
    const r = rel as RelOf<'lineHeightRatio'>;
    // F2 fix: continuous line-height — compute the actual value and clamp
    // to the pack's lineHeightScale range. No more snapping to fixed steps.
    const refs = resolveReference(r.reference, c);
    if (!refs.length) { notes.push(`lineHeightRatio ${r.subject}: reference not found`); return; }
    const targetVal = lineHeightValue(refs[0]) * r.ratio;
    const lh = continuousLineHeight(targetVal);
    addLayout(ruleFor(c.handle), { lineHeight: String(lh) });
  },
  letterSpacingStep(rel, c, ctx) {
    const { pack, ruleFor, addStyles } = ctx;
    const r = rel as RelOf<'letterSpacingStep'>;
    const val = pack.letterSpacingScale[r.step] ?? '0em';
    addStyles(ruleFor(c.handle), { letterSpacing: val });
  },
  wordSpacingStep(rel, c, ctx) {
    const { pack, ruleFor, addStyles } = ctx;
    const r = rel as RelOf<'wordSpacingStep'>;
    const val = pack.wordSpacingScale[r.step] ?? '0em';
    addStyles(ruleFor(c.handle), { wordSpacing: val });
  },
  fontWeightRank(rel, c, ctx) {
    const { pack, ruleFor, addLayout } = ctx;
    const r = rel as RelOf<'fontWeightRank'>;
    const w = pack.fontWeightScale[r.rank - 1] ?? 400;
    addLayout(ruleFor(c.handle), { fontWeight: String(w) });
  },
  textTransform(rel, c, ctx) {
    const { ruleFor, addStyles } = ctx;
    const r = rel as RelOf<'textTransform'>;
    addStyles(ruleFor(c.handle), { textTransform: r.transform });
  },
};
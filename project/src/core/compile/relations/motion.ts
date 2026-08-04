/**
 * compile/relations/motion — motion relations (F4): transitionTier,
 * transitionEasing, entranceDelay, hoverElevate, focusRing.
 *
 * All motion CSS is transform/opacity only — never triggers reflow.
 * prefers-reduced-motion is honoured absolutely: the entire motion layer is
 * wrapped in @media (prefers-reduced-motion: no-preference) at compile.
 * Extracted from transform.ts (pure move, no behaviour change).
 */

import type { RelationHandlerMap, RelOf } from './context.ts';

export const motionHandlers: RelationHandlerMap = {
  transitionTier(rel, c, ctx) {
    const { pack, ruleFor, addStyles, notes } = ctx;
    const r = rel as RelOf<'transitionTier'>;
    if (!pack.motionAnimated) { notes.push(`transitionTier ${c.handle}: REFUSED — pack is not animated`); return; }
    const dur = pack.motionDurationScale[Math.min(pack.motionDurationScale.length - 1, Math.max(0, r.tier))] ?? 0;
    if (dur === 0) return; // tier 0 = no transition
    addStyles(ruleFor(c.handle), {
      transition: `transform ${dur}ms var(--rv-easing, ease-out), opacity ${dur}ms var(--rv-easing, ease-out), box-shadow ${dur}ms var(--rv-easing, ease-out)`,
    });
  },
  transitionEasing(rel, c, ctx) {
    const { pack, ruleFor, addStyles, notes } = ctx;
    const r = rel as RelOf<'transitionEasing'>;
    if (!pack.motionAnimated) { notes.push(`transitionEasing ${c.handle}: REFUSED — pack is not animated`); return; }
    const easing = pack.motionEasing[r.easing] ?? 'ease-out';
    addStyles(ruleFor(c.handle), { ['--rv-easing' as string]: easing });
  },
  entranceDelay(rel, c, ctx) {
    const { pack, ruleFor, addStyles, notes } = ctx;
    const r = rel as RelOf<'entranceDelay'>;
    if (!pack.motionAnimated) { notes.push(`entranceDelay ${c.handle}: REFUSED — pack is not animated`); return; }
    const delayScale = pack.motionDurationScale;
    const delay = delayScale[Math.min(delayScale.length - 1, Math.max(0, r.tier))] ?? 0;
    // Entrance: opacity 0→1 + translateY(8px→0). Transform+opacity only.
    // The stagger is driven by the tier (reading order → tier mapping).
    addStyles(ruleFor(c.handle), {
      animation: `rv-enter ${delayScale[delayScale.length - 1] ?? 300}ms var(--rv-easing, ease-out) ${delay}ms both`,
    });
  },
  hoverElevate(rel, c, ctx) {
    const { pack, shadowTier, ruleFor, notes } = ctx;
    const r = rel as RelOf<'hoverElevate'>;
    if (!pack.motionAnimated) { notes.push(`hoverElevate ${c.handle}: REFUSED — pack is not animated`); return; }
    const newTier = Math.min(pack.shadowScale.length - 1, shadowTier(c) + r.levels);
    const shadow = pack.shadowScale[newTier] ?? 'none';
    const rule = ruleFor(c.handle);
    // Hover: transform-based lift (no layout movement) + shadow. Step from pack.
    const lift = pack.spacingScale[1] ?? 4;
    rule.hover = { ...(rule.hover ?? {}), transform: `translateY(-${lift}px)`, boxShadow: shadow };
  },
  focusRing(rel, c, ctx) {
    const { pack, ruleFor, notes } = ctx;
    const r = rel as RelOf<'focusRing'>;
    const color = pack.colors.accents[r.role];
    if (!color) { notes.push(`focusRing ${c.handle}: accent "${r.role}" not found in pack`); return; }
    const rule = ruleFor(c.handle);
    // Outline width from pack borderScale, offset from pack spacingScale.
    const ow = pack.borderScale[2] ?? 2;
    const oo = pack.spacingScale[1] ?? 4;
    rule.focusVisible = { ...(rule.focusVisible ?? {}), outline: `${ow}px solid ${color}`, outlineOffset: `${oo}px` };
  },
};

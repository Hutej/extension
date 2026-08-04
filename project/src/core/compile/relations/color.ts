/**
 * compile/relations/color — colour role assignment relations: accentRole, accentOn.
 *
 * Extracted from transform.ts (pure move, no behaviour change). The shared accent
 * counter (ctx.accent.count) preserves the order-sensitive accent budget: the
 * first relations to hit the budget win, exactly as the inline switch did.
 */

import type { RelationHandlerMap, RelOf } from './context.ts';

export const colorHandlers: RelationHandlerMap = {
  accentRole(rel, c, ctx) {
    const { pack, ruleFor, addStyles, notes, accent } = ctx;
    const r = rel as RelOf<'accentRole'>;
    const limit = Math.min(r.maxCount, pack.principles.maxAccentCount);
    if (accent.count >= limit) {
      notes.push(`accentRole ${r.subject}: REFUSED — accent budget exhausted (${accent.count}/${limit})`);
      return;
    }
    const color = pack.colors.accents[r.role];
    if (!color) { notes.push(`accentRole ${r.subject}: accent "${r.role}" not found in pack`); return; }
    accent.count++;
    addStyles(ruleFor(c.handle), { background: color });
  },
  accentOn(rel, c, ctx) {
    const { pack, ruleFor, addStyles, notes, accent } = ctx;
    const r = rel as RelOf<'accentOn'>;
    if (accent.count >= pack.principles.maxAccentCount) {
      notes.push(`accentOn ${r.subject}: REFUSED — accent budget exhausted (${accent.count}/${pack.principles.maxAccentCount})`);
      return;
    }
    const color = pack.colors.accents[r.role];
    if (!color) { notes.push(`accentOn ${r.subject}: accent "${r.role}" not found in pack`); return; }
    accent.count++;
    if (r.target === 'text') addStyles(ruleFor(c.handle), { color });
    else if (r.target === 'border') addStyles(ruleFor(c.handle), { borderColor: color, borderStyle: 'solid', borderWidth: `${pack.borderScale[1] ?? 1}px` });
    else addStyles(ruleFor(c.handle), { background: color });
  },
};

/**
 * compile/relations/interaction — interaction capability relations (F5): movable.
 *
 * Opt-in movable capability. Transform-based: no DOM mutation. The compile layer
 * adds cursor:grab + touch-action:none + a CSS class that enables the runtime
 * drag handler. The drag handler applies transform: translate() only — never
 * mutates style.position, never moves DOM nodes. Fully reversible: clear the
 * transform. Extracted from transform.ts (pure move, no behaviour change).
 */

import type { RelationHandlerMap } from './context.ts';

export const interactionHandlers: RelationHandlerMap = {
  movable(_rel, c, ctx) {
    const { pack, ruleFor, addStyles } = ctx;
    const step = pack.spacingScale[1] ?? 4;
    addStyles(ruleFor(c.handle), {
      cursor: 'grab',
      ['--rv-movable' as string]: '1',
      ['--rv-movable-step' as string]: `${step}px`,
      touchAction: 'none',
    });
  },
};

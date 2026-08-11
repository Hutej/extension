/**
 * compile/relations/layout — layout relations: widthFraction, groupWith,
 * proseColumns, alignsWith.
 *
 * alignsWith was not named in the domain split brief; it emits a layout property
 * (alignItems) so it lives here with the other layout relations. Extracted from
 * transform.ts (pure move, no behaviour change).
 */

import type { RelationHandlerMap, RelOf } from './context.ts';
import type { AlignmentEdge } from '../../design/vocabulary.ts';

export const layoutHandlers: RelationHandlerMap = {
  widthFraction(rel, c, ctx) {
    const { resolveReference, compFor, addLayout, notes } = ctx;
    const r = rel as RelOf<'widthFraction'>;
    const refs = resolveReference(r.reference, c);
    if (!refs.length) { notes.push(`widthFraction ${r.subject}: reference not found`); return; }
    const pct = Math.round(r.fraction * 100);
    const rule = compFor(c.handle);
    addLayout(rule, { width: `${pct}%` });
  },
  groupWith(rel, c, ctx) {
    const { resolveSubject, compFor, addLayout, notes } = ctx;
    const r = rel as RelOf<'groupWith'>;
    // Advisory: set display:flex on the parent so children share a
    // formatting context. Direction and wrapping are declared via
    // composition relations (stackDirection, wrapBehavior), not
    // assumed here — Law 0 rule 2: don't impose a direction on
    // something that already had one.
    const parent = resolveSubject('parent', c);
    if (parent.length) {
      const rule = compFor(parent[0].handle);
      addLayout(rule, { display: 'flex' });
    }
    notes.push(`groupWith ${r.subject} → ${r.reference}: parent set to flex (advisory)`);
  },
  proseColumns(rel, c, ctx) {
    const { ruleFor, addLayout } = ctx;
    const r = rel as RelOf<'proseColumns'>;
    addLayout(ruleFor(c.handle), { columnCount: String(r.count) });
  },
  alignsWith(rel, c, ctx) {
    const { ruleFor, addLayout } = ctx;
    const r = rel as RelOf<'alignsWith'>;
    // Emit the alignment edge as a layout property.
    const edgeMap: Record<AlignmentEdge, string> = {
      start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch',
    };
    addLayout(ruleFor(c.handle), { alignItems: edgeMap[r.edge] });
  },
};
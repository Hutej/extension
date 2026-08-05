/**
 * core/layout/languages/bento — the Bento layout language.
 *
 * STUB: slot skeleton only. To be authored with full allowedRoles, constraint
 * priorities, archetypes and perception-suit signals. Tiles, no prose column.
 */

import type { LayoutLanguage } from './types.ts';

export const BENTO: LayoutLanguage = {
  id: 'bento',
  name: 'Bento',
  description: 'A bento grid of tiles: one hero tile, feature tiles, and filler tiles. No prose column.',
  archetypes: ['grid-3', 'grid-4'],
  suits: { roles: ['media', 'listing', 'page-title'], componentTypes: ['card', 'hero', 'media'], cardCount: 'high', mediaCount: 'high', proseVolume: 'sparse' },
  slots: [
    { id: 'hero-tile', allowedRoles: ['page-title', 'media'], preferredWidth: 'content', flow: 'column', ordering: 'source', minWidth: 320, constraints: [{ kind: 'FillParent', priority: 'required' }] },
    { id: 'feature-tiles', allowedRoles: ['listing', 'media', 'article-body'], preferredWidth: 'content', flow: 'row', ordering: 'source', minWidth: 240, constraints: [{ kind: 'FillParent', priority: 'required' }, { kind: 'WrapOnOverflow', priority: 'preferred' }] },
    { id: 'filler-tiles', allowedRoles: ['metadata', 'comments'], preferredWidth: 'content', flow: 'row', ordering: 'source', minWidth: 160, constraints: [{ kind: 'WrapOnOverflow', priority: 'preferred' }] },
    { id: 'overflow', allowedRoles: [], preferredWidth: 'full', flow: 'column', ordering: 'source', minWidth: 0, constraints: [{ kind: 'FillParent', priority: 'required' }] },
  ],
};

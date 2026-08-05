/**
 * core/layout/languages/editorial — the Editorial layout language.
 *
 * STUB: slot skeleton only. To be authored with full allowedRoles, constraint
 * priorities, archetypes and perception-suit signals.
 */

import type { LayoutLanguage } from './types.ts';

export const EDITORIAL: LayoutLanguage = {
  id: 'editorial',
  name: 'Editorial',
  description: 'A magazine-style reading page: a masthead, a lede, a prose column, a pull-aside, and a figure band.',
  archetypes: ['single-column', 'two-column-rail-right'],
  suits: { roles: ['article-body', 'page-title', 'media', 'metadata'], componentTypes: ['hero', 'quote', 'media'], cardCount: 'low', mediaCount: 'medium', proseVolume: 'dense' },
  slots: [
    { id: 'masthead', allowedRoles: ['page-title', 'nav-primary', 'search'], preferredWidth: 'full', flow: 'row', ordering: 'source', minWidth: 0, constraints: [{ kind: 'FillParent', priority: 'required' }] },
    { id: 'lede', allowedRoles: ['page-title', 'media'], preferredWidth: 'full', flow: 'column', ordering: 'source', minWidth: 0, constraints: [{ kind: 'FillParent', priority: 'preferred' }] },
    { id: 'prose-column', allowedRoles: ['article-body', 'metadata', 'toc'], preferredWidth: 'content', flow: 'column', ordering: 'source', minWidth: 320, constraints: [{ kind: 'MaxWidth', priority: 'preferred', value: 'prose' }, { kind: 'StackVertically', priority: 'required' }] },
    { id: 'pull-aside', allowedRoles: ['sidebar', 'nav-local', 'comments'], preferredWidth: 'side', flow: 'column', ordering: 'source', minWidth: 200, constraints: [{ kind: 'MaxWidth', priority: 'preferred', value: 'compact' }] },
    { id: 'figure-band', allowedRoles: ['media', 'listing'], preferredWidth: 'full', flow: 'row', ordering: 'source', minWidth: 0, constraints: [{ kind: 'FillParent', priority: 'preferred' }] },
    { id: 'overflow', allowedRoles: [], preferredWidth: 'full', flow: 'column', ordering: 'source', minWidth: 0, constraints: [{ kind: 'FillParent', priority: 'required' }] },
  ],
};

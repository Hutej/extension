/**
 * core/layout/languages/gallery — the Gallery layout language.
 *
 * STUB: slot skeleton only. To be authored with full allowedRoles, constraint
 * priorities, archetypes and perception-suit signals.
 */

import type { LayoutLanguage } from './types.ts';

export const GALLERY: LayoutLanguage = {
  id: 'gallery',
  name: 'Gallery',
  description: 'A media-first grid: a header, a media grid, and a caption strip.',
  archetypes: ['grid-3', 'grid-4'],
  suits: { roles: ['media', 'page-title', 'listing'], componentTypes: ['media', 'card', 'hero'], cardCount: 'high', mediaCount: 'high', proseVolume: 'sparse' },
  slots: [
    { id: 'header', allowedRoles: ['page-title', 'nav-primary', 'search'], preferredWidth: 'full', flow: 'row', ordering: 'source', minWidth: 0, constraints: [{ kind: 'FillParent', priority: 'required' }] },
    { id: 'media-grid', allowedRoles: ['media', 'listing', 'article-body'], preferredWidth: 'content', flow: 'row', ordering: 'source', minWidth: 240, constraints: [{ kind: 'FillParent', priority: 'required' }, { kind: 'WrapOnOverflow', priority: 'preferred' }] },
    { id: 'caption-strip', allowedRoles: ['metadata', 'comments', 'footer-chrome'], preferredWidth: 'full', flow: 'row', ordering: 'source', minWidth: 0, constraints: [{ kind: 'FillParent', priority: 'preferred' }] },
    { id: 'overflow', allowedRoles: [], preferredWidth: 'full', flow: 'column', ordering: 'source', minWidth: 0, constraints: [{ kind: 'FillParent', priority: 'required' }] },
  ],
};

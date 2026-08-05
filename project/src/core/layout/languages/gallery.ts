/**
 * core/layout/languages/gallery — the Gallery layout language.
 *
 * A media-first grid: a header, a media grid, and a caption strip. Media tiles
 * fill the grid; captions sit below. Pure data.
 */

import type { LayoutLanguage } from './types.ts';

export const GALLERY: LayoutLanguage = {
  id: 'gallery',
  name: 'Gallery',
  description: 'A media-first grid: a header, a media grid, and a caption strip.',
  archetypes: ['grid-3', 'grid-4', 'grid-2'],
  suits: {
    roles: ['media', 'page-title', 'listing'],
    componentTypes: ['media', 'card', 'hero'],
    cardCount: 'high',
    mediaCount: 'high',
    proseVolume: 'sparse',
  },
  slots: [
    {
      id: 'header',
      allowedRoles: ['page-title', 'nav-primary', 'search', 'toolbar'],
      preferredWidth: 'full',
      flow: 'row',
      ordering: 'source',
      minWidth: 0,
      constraints: [
        { kind: 'FillParent', priority: 'required' },
        { kind: 'Alignment', priority: 'preferred', value: 'start' },
      ],
    },
    {
      id: 'media-grid',
      allowedRoles: ['media', 'listing', 'article-body'],
      preferredWidth: 'content',
      flow: 'row',
      ordering: 'source',
      minWidth: 240,
      constraints: [
        { kind: 'FillParent', priority: 'required' },
        { kind: 'WrapOnOverflow', priority: 'preferred' },
        { kind: 'Gap', priority: 'preferred', value: 's' },
      ],
    },
    {
      id: 'caption-strip',
      allowedRoles: ['metadata', 'comments', 'footer-chrome'],
      preferredWidth: 'full',
      flow: 'row',
      ordering: 'source',
      minWidth: 0,
      constraints: [
        { kind: 'FillParent', priority: 'preferred' },
        { kind: 'WrapOnOverflow', priority: 'preferred' },
      ],
    },
    {
      id: 'overflow',
      allowedRoles: [],
      preferredWidth: 'full',
      flow: 'column',
      ordering: 'source',
      minWidth: 0,
      constraints: [
        { kind: 'FillParent', priority: 'required' },
        { kind: 'StackVertically', priority: 'preferred' },
      ],
    },
  ],
};

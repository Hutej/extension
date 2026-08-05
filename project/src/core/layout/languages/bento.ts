/**
 * core/layout/languages/bento — the Bento layout language.
 *
 * A bento grid of tiles: one hero tile, feature tiles, and filler tiles. No
 * prose column — bento is tiles, not reading flow. Pure data.
 */

import type { LayoutLanguage } from './types.ts';

export const BENTO: LayoutLanguage = {
  id: 'bento',
  name: 'Bento',
  description: 'A bento grid of tiles: one hero tile, feature tiles, and filler tiles. No prose column.',
  archetypes: ['grid-3', 'grid-4', 'grid-2'],
  suits: {
    roles: ['media', 'listing', 'page-title'],
    componentTypes: ['card', 'hero', 'media'],
    cardCount: 'high',
    mediaCount: 'high',
    proseVolume: 'sparse',
  },
  slots: [
    {
      id: 'hero-tile',
      allowedRoles: ['page-title', 'media'],
      preferredWidth: 'full',
      flow: 'column',
      ordering: 'source',
      minWidth: 320,
      constraints: [
        { kind: 'FillParent', priority: 'required' },
        { kind: 'AspectRatio', priority: 'preferred' },
      ],
    },
    {
      id: 'feature-tiles',
      allowedRoles: ['listing', 'media', 'article-body'],
      preferredWidth: 'content',
      flow: 'row',
      ordering: 'source',
      minWidth: 240,
      constraints: [
        { kind: 'FillParent', priority: 'required' },
        { kind: 'WrapOnOverflow', priority: 'preferred' },
        { kind: 'Gap', priority: 'preferred', value: 'm' },
      ],
    },
    {
      id: 'filler-tiles',
      allowedRoles: ['metadata', 'comments', 'footer-chrome'],
      preferredWidth: 'content',
      flow: 'row',
      ordering: 'source',
      minWidth: 160,
      constraints: [
        { kind: 'FillParent', priority: 'preferred' },
        { kind: 'WrapOnOverflow', priority: 'preferred' },
        { kind: 'Gap', priority: 'preferred', value: 's' },
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

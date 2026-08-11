/**
 * core/layout/languages/feed — the Feed layout language.
 *
 * A stream of items: a header, a filter bar, an item stream, and a side-meta
 * column. A vertical list with optional side metadata. Pure data.
 */

import type { LayoutLanguage } from './types.ts';

export const FEED: LayoutLanguage = {
  id: 'feed',
  name: 'Feed',
  description: 'A stream of items: a header, a filter bar, an item stream, and a side meta column.',
  archetypes: ['single-column', 'two-column-rail-right', 'three-column'],
  suits: {
    roles: ['listing', 'article-body', 'nav-primary', 'metadata'],
    componentTypes: ['list', 'card'],
    cardCount: 'high',
    mediaCount: 'medium',
    proseVolume: 'moderate',
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
      id: 'filter-bar',
      allowedRoles: ['nav-local', 'actions-primary'],
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
      id: 'item-stream',
      allowedRoles: ['listing', 'article-body', 'media', 'comments'],
      preferredWidth: 'content',
      flow: 'column',
      ordering: 'source',
      minWidth: 320,
      constraints: [
        { kind: 'FillParent', priority: 'required' },
        { kind: 'StackVertically', priority: 'preferred' },
        { kind: 'Gap', priority: 'preferred', value: 's' },
      ],
    },
    {
      id: 'side-meta',
      allowedRoles: ['sidebar', 'metadata', 'toc'],
      preferredWidth: 'side',
      flow: 'column',
      ordering: 'source',
      minWidth: 200,
      constraints: [
        { kind: 'MaxWidth', priority: 'preferred', value: 'compact' },
        { kind: 'StackVertically', priority: 'required' },
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
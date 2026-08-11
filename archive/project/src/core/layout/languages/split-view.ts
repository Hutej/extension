/**
 * core/layout/languages/split-view — the Split-view layout language.
 *
 * A master-detail surface: a nav list, a list pane, and a detail pane side by
 * side. The canonical app-shell pattern. Pure data.
 */

import type { LayoutLanguage } from './types.ts';

export const SPLIT_VIEW: LayoutLanguage = {
  id: 'split-view',
  name: 'Split-view',
  description: 'A master-detail surface: a nav list, a list pane, and a detail pane side by side.',
  archetypes: ['split-list-detail', 'three-column', 'two-column-rail-left'],
  suits: {
    roles: ['nav-local', 'listing', 'article-body'],
    componentTypes: ['list', 'siderail', 'card'],
    cardCount: 'medium',
    mediaCount: 'low',
    proseVolume: 'moderate',
  },
  slots: [
    {
      id: 'nav-list',
      allowedRoles: ['nav-primary', 'nav-local'],
      preferredWidth: 'side',
      flow: 'column',
      ordering: 'source',
      minWidth: 180,
      constraints: [
        { kind: 'StackVertically', priority: 'required' },
        { kind: 'MaxWidth', priority: 'preferred', value: 'side' },
      ],
    },
    {
      id: 'list-pane',
      allowedRoles: ['listing', 'media', 'metadata'],
      preferredWidth: 'side',
      flow: 'column',
      ordering: 'source',
      minWidth: 240,
      constraints: [
        { kind: 'StackVertically', priority: 'required' },
        { kind: 'WrapOnOverflow', priority: 'preferred' },
      ],
    },
    {
      id: 'detail-pane',
      allowedRoles: ['article-body', 'comments', 'page-title'],
      preferredWidth: 'content',
      flow: 'column',
      ordering: 'source',
      minWidth: 320,
      constraints: [
        { kind: 'FillParent', priority: 'required' },
        { kind: 'StackVertically', priority: 'preferred' },
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
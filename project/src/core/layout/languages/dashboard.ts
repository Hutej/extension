/**
 * core/layout/languages/dashboard — the Dashboard layout language.
 *
 * An analytics + control surface: a toolbar across the top, a side filter rail,
 * a metric strip, a panel grid of cards/tables, and a detail drawer. Pure data.
 */

import type { LayoutLanguage } from './types.ts';

export const DASHBOARD: LayoutLanguage = {
  id: 'dashboard',
  name: 'Dashboard',
  description: 'Analytics + control surfaces: a toolbar, a filter rail, a metric strip, a panel grid, and a detail drawer.',
  archetypes: ['two-column-rail-left', 'grid-3'],
  suits: {
    roles: ['toolbar', 'actions-primary', 'nav-primary', 'metadata', 'listing'],
    componentTypes: ['card', 'table', 'navbar', 'form'],
    cardCount: 'high',
    mediaCount: 'low',
    proseVolume: 'sparse',
  },
  slots: [
    {
      id: 'toolbar',
      allowedRoles: ['toolbar', 'actions-primary', 'search', 'nav-primary'],
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
      id: 'filter-rail',
      allowedRoles: ['nav-local', 'sidebar'],
      preferredWidth: 'side',
      flow: 'column',
      ordering: 'source',
      minWidth: 200,
      constraints: [
        { kind: 'MaxWidth', priority: 'preferred', value: 'side' },
        { kind: 'StackVertically', priority: 'required' },
      ],
    },
    {
      id: 'metric-strip',
      allowedRoles: ['metadata'],
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
      id: 'panel-grid',
      allowedRoles: ['listing', 'media', 'article-body', 'comments'],
      preferredWidth: 'content',
      flow: 'row',
      ordering: 'source',
      minWidth: 320,
      constraints: [
        { kind: 'FillParent', priority: 'required' },
        { kind: 'WrapOnOverflow', priority: 'preferred' },
        { kind: 'Gap', priority: 'preferred', value: 'm' },
      ],
    },
    {
      id: 'detail-drawer',
      allowedRoles: ['sidebar', 'nav-local', 'comments'],
      preferredWidth: 'side',
      flow: 'column',
      ordering: 'source',
      minWidth: 280,
      constraints: [
        { kind: 'MaxWidth', priority: 'preferred', value: 'side' },
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

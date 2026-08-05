/**
 * core/layout/languages/dashboard — the Dashboard layout language.
 *
 * STUB: slot skeleton only. To be authored with full allowedRoles, constraint
 * priorities, archetypes and perception-suit signals.
 */

import type { LayoutLanguage } from './types.ts';

export const DASHBOARD: LayoutLanguage = {
  id: 'dashboard',
  name: 'Dashboard',
  description: 'Analytics + control surfaces: a toolbar, a filter rail, a metric strip, a panel grid, and a detail drawer.',
  archetypes: ['two-column-rail-left', 'grid-3'],
  suits: { roles: ['toolbar', 'actions-primary', 'nav-primary'], componentTypes: ['card', 'table', 'navbar'], cardCount: 'high', mediaCount: 'low', proseVolume: 'sparse' },
  slots: [
    { id: 'toolbar', allowedRoles: ['toolbar', 'actions-primary', 'search'], preferredWidth: 'full', flow: 'row', ordering: 'source', minWidth: 0, constraints: [{ kind: 'FillParent', priority: 'required' }] },
    { id: 'filter-rail', allowedRoles: ['nav-local'], preferredWidth: 'side', flow: 'column', ordering: 'source', minWidth: 200, constraints: [{ kind: 'StackVertically', priority: 'required' }] },
    { id: 'metric-strip', allowedRoles: ['metadata'], preferredWidth: 'content', flow: 'row', ordering: 'source', minWidth: 0, constraints: [{ kind: 'FillParent', priority: 'preferred' }] },
    { id: 'panel-grid', allowedRoles: ['listing', 'media', 'article-body'], preferredWidth: 'content', flow: 'row', ordering: 'source', minWidth: 320, constraints: [{ kind: 'FillParent', priority: 'required' }, { kind: 'WrapOnOverflow', priority: 'preferred' }] },
    { id: 'detail-drawer', allowedRoles: ['sidebar'], preferredWidth: 'side', flow: 'column', ordering: 'source', minWidth: 280, constraints: [{ kind: 'MaxWidth', priority: 'preferred', value: 'side' }] },
    { id: 'overflow', allowedRoles: [], preferredWidth: 'full', flow: 'column', ordering: 'source', minWidth: 0, constraints: [{ kind: 'FillParent', priority: 'required' }] },
  ],
};

/**
 * core/layout/plan-assert — assert the solver's emit-time plan against the
 * rendered DOM. Deterministic, no pixels.
 *
 * Extracted from content.ts (pure move, no behaviour change).
 */

import type { SolverPlan } from './solve.ts';

/** assert the solver's emit-time plan against the rendered DOM — deterministic,
 *  no pixels. Checks: (1) the number of distinct VISUAL column x-positions among
 *  non-full-width placed proxies === plan.expectedColumns; (2) for each slot in the
 *  plan, at least one proxy with that slot has the expected grid-column-start.
 *  If the plan and the rendered result disagree, the run FAILS (planHonoured hard gate).
 *  Using visual x-positions (not grid-column-start) for (1) catches the case where
 *  the grid-column says "2" but the element renders at x=0 (track inheritance, or
 *  auto-placement putting items in different rows so they look like 1 column). */
export function assertPlanHonoured(plan: SolverPlan): boolean {
  const proxies = document.querySelectorAll<HTMLElement>('[data-rv-plan-slot]');
  if (proxies.length === 0) return true;
  // (1) measured distinct visual columns = distinct left-edge x-positions (bucketed
  // to 40px) among non-full-width proxies (grid-column-end !== "-1").
  const xBuckets = new Set<number>();
  for (const el of proxies) {
    const cs = getComputedStyle(el);
    if (cs.gridColumnEnd === '-1') continue;  // skip full-width proxies
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    xBuckets.add(Math.round(rect.left / 40) * 40);
  }
  const measuredColumns = xBuckets.size || 1;
  if (measuredColumns !== plan.expectedColumns) return false;
  // (2) each expected column must have at least one proxy at that grid-column-start.
  const expectedTracks = new Set<number>();
  for (const col of Object.values(plan.handleToColumn)) {
    if (col > 0) expectedTracks.add(col);
  }
  for (const expectedTrack of expectedTracks) {
    let found = false;
    for (const el of proxies) {
      const start = parseInt(getComputedStyle(el).gridColumnStart, 10);
      if (start === expectedTrack) { found = true; break; }
    }
    if (!found) return false;
  }
  return true;
}

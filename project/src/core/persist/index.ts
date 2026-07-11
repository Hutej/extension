/**
 * core/persist — save a site's transform, re-identify, re-apply on reload.
 *
 * Phase 1 stores the compiled CSS AND the spec. On reload we re-run perceive()
 * (which re-stamps the SAME cluster handles, because handles are hashes of the
 * elements' stable visual signatures) and inject the stored CSS — so the
 * transform survives navigation without a fresh model call.
 *
 * SiteState is intentionally extensible: Phase 2+ add an `ops` log beside `style`.
 */

import type { StyleSpec } from '../spec';

export interface StyleRecord {
  id: string;
  intent: string;
  spec: StyleSpec;
  css: string;
  reasoning: string;
  createdAt: number;
}

export interface SiteState {
  enabled: boolean;
  style?: StyleRecord | null;
  // ops?: OpRecord[]  // reserved for Phase 2+ (structure/augment/act)
}

const DEFAULT_STATE: SiteState = { enabled: true, style: null };

export async function loadSiteState(origin: string): Promise<SiteState> {
  const result = await browser.storage.local.get([origin]);
  const stored = result[origin] as SiteState | undefined;
  if (stored) return { ...DEFAULT_STATE, ...stored };
  return { ...DEFAULT_STATE };
}

export async function saveSiteState(origin: string, state: SiteState): Promise<void> {
  await browser.storage.local.set({ [origin]: state });
}

export async function clearSiteState(origin: string): Promise<void> {
  await browser.storage.local.remove([origin]);
}

export function hasTransform(state: SiteState): boolean {
  return !!state.style;
}

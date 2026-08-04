/**
 * core/persist — save a site's transform, re-identify, re-apply on reload.
 *
 * Persist the ACTUALLY APPLIED CSS (not a re-compiled version) +
 * compileOptions (so SPA re-compile has repair options). Per-URL scoping
 * (origin + normalized pathname) with origin-level fallback.
 */

import type { DesignSpec } from '../spec';
import type { CompileOptions } from '../compile';

export interface StyleRecord {
  id: string;
  intent: string;
  spec: DesignSpec;
  css: string;
  /** the solver's grid + display:contents structural CSS. Stored separately so
   *  reapplyStored + restyleDynamic can re-apply it alongside re-compiled Painter
   *  CSS. Without this, a re-apply loses the grid layout (only Painter CSS survives). */
  structuralCss?: string;
  reasoning: string;
  compileOptions?: CompileOptions;
  createdAt: number;
}

export interface SiteState {
  enabled: boolean;
  style?: StyleRecord | null;
}

const DEFAULT_STATE: SiteState = { enabled: true, style: null };

/** Per-URL storage key: origin + normalized pathname (strip query/hash/trailing-slash). */
export function storageKey(url?: string): string {
  const u = new URL(url ?? window.location.href);
  const path = u.pathname.replace(/\/+$/, '') || '/';
  return u.origin + path;
}

export async function loadSiteState(key: string): Promise<SiteState> {
  const result = await browser.storage.local.get([key]);
  const stored = result[key] as SiteState | undefined;
  if (stored) return { ...DEFAULT_STATE, ...stored };
  return { ...DEFAULT_STATE };
}

export async function saveSiteState(key: string, state: SiteState): Promise<void> {
  await browser.storage.local.set({ [key]: state });
}

export async function clearSiteState(key: string): Promise<void> {
  await browser.storage.local.remove([key]);
}

/**
 * core/persist — per-origin persistence. Saves the journal so a user's
 * modifications hold across page reloads and SPA navigations.
 *
 * Keyed by origin only (no path, no query, no fragment — never a full URL).
 * This means "hide the sidebar" on Wikipedia applies to every Wikipedia
 * article, which is the product requirement. The privacy commitment
 * (05_BROWSER_CRAFT §9) is: never store or transmit a full URL. The key
 * is just the origin — no session tokens, no personal data.
 */

export interface JournalState {
  enabled: boolean;
  origin: string;
  goal: string;
  /** The compact journal entries — replayable to re-apply the modifications. */
  entries: JournalEntry[];
  createdAt: number;
}

export interface JournalEntry {
  tool: string;
  kind: 'observe' | 'act' | 'verify' | 'control';
  args: Record<string, unknown>;
  result: Record<string, unknown>;
  confidence?: number;
  inverse?: Record<string, unknown>;
  reasoning?: string;
  costMs: number;
  timestamp: number;
}

const PREFIX = 'rv_';
const DEFAULT_STATE: JournalState = { enabled: true, origin: '', goal: '', entries: [], createdAt: 0 };

/** Per-origin storage key. Origin only — no path, no query, no fragment. */
export function originKey(url?: string): string {
  const u = new URL(url ?? window.location.href);
  return u.origin;
}

export async function loadJournalState(key: string): Promise<JournalState> {
  const result = await browser.storage.local.get([PREFIX + key]);
  const stored = result[PREFIX + key] as JournalState | undefined;
  if (stored) return { ...DEFAULT_STATE, ...stored };
  return { ...DEFAULT_STATE };
}

export async function saveJournalState(key: string, state: JournalState): Promise<void> {
  await browser.storage.local.set({ [PREFIX + key]: state });
}
// (Phase 2.5: removed dead `clearJournalState` — exported but never imported.
// Journal clearing uses saveJournalState with an empty entry, not a remove.
// Caught by the widened audit-wiring; do not reintroduce without a consumer.)

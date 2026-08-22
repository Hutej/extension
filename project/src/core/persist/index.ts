/**
 * core/persist — per-scope persistence. Saves the journal so a user's
 * modifications hold across page reloads and SPA navigations.
 *
 * F4 CONTINUITY (Phase 5): keyed by **origin + pathname** — NOT origin only.
 * Path, never query, never fragment: tokens and personal data live there, and
 * origin+path is what makes "hide the sidebar on article A survives a reload
 * AND does not corrupt article B" work without leaking a full URL (privacy
 * rule 14 / product req 6: never store or transmit a full URL). /wiki/CSS and
 * /wiki/HTML are different scopes.
 *
 * Each persisted act entry carries an `identityDigest` (SHA-256 of the F1
 * structural fingerprint) so a reload/SPA-render can re-verify the target is
 * the same element before re-applying. The digest is a cryptographic hash —
 * no cleartext page content (the 40-char text prefix, attribute values) is
 * persisted. See core/persist/digest.ts. identity.ts / resolveTarget / fingerprint
 * are UNCHANGED by F4 — F4 owns only the digest conversion.
 *
 * No migration of legacy origin-only journals (pre-launch; approved Q5).
 */

export interface JournalState {
  enabled: boolean;
  origin: string;
  /** F4: the pathname persisted with the origin — the scope key is
   *  origin + pathname. Present so the replay path and the background CSS
   *  re-insert path compute the same key the run persisted under. */
  path: string;
  goal: string;
  /** The compact journal entries — replayable to re-apply the modifications. */
  entries: JournalEntry[];
  createdAt: number;
}

export interface JournalEntry {
  tool: string;
  kind: 'observe' | 'act' | 'verify' | 'control';
  args: Record<string, unknown>;
  /** The tool's confirmation (applied/before/after…). Present in the SESSION
   *  journal (the model sees it; the act's guardTarget uses it). STRIPPED from
   *  the PERSISTED state (Journal.toPersistableState) — it carries cleartext
   *  page-content slices, and replay never reads it. Optional for that reason. */
  result?: Record<string, unknown>;
  confidence?: number;
  inverse?: Record<string, unknown>;
  /** F4: SHA-256 of the act's target fingerprint, captured at act time so
   *  reload/SPA-render can re-verify the target is the same element (wrong-
   *  target detection on replay) WITHOUT persisting cleartext page content.
   *  Only act entries with a single selector target carry it (applyCss/hide/
   *  heal setText insert). Undefined for observe/verify/control and for acts
   *  whose target could not be resolved at capture time. See digest.ts. */
  identityDigest?: string;
  reasoning?: string;
  costMs: number;
  timestamp: number;
}

const PREFIX = 'rv_';
const DEFAULT_STATE: JournalState = { enabled: true, origin: '', path: '', goal: '', entries: [], createdAt: 0 };

/** F4: per-scope storage key. Origin + pathname only — no search, no hash.
 *  `?token=SECRET` and `#section` are stripped; they hold tokens/personal data.
 *  /wiki/CSS and /wiki/HTML are different keys. */
export function scopeKey(url?: string): string {
  const u = new URL(url ?? window.location.href);
  return u.origin + u.pathname; // NO search, NO hash
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

// F4: re-export the persisted-identity digest so the act path (capture) and
// the replay path (re-verify) import it from one place.
export { digestOfElement, sha256Hex, type IdentityDigest } from './digest.ts';


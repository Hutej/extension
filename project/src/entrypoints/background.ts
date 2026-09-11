/**
 * entrypoints/background — thin service worker (plan/19 §3.2 cutover).
 *
 * The worker is a HOST only: it installs the one runtime (broker + document
 * registry + origin store + transaction owner) and wires browser entry
 * points. Every command path lives behind the broker; there is no second
 * dispatcher, no legacy `action` surface here (rule 16: wire it — do not
 * reimplement it). The agent-era machinery (run loop, budget, tools,
 * recovery, per-tab CSS reinsert) was deleted with its tests in S6.3;
 * plan/19 §4 records the removals.
 */
import { installBroker } from '../background/broker.ts';

/** plan/19 §3.4 (legacy CSS migration attempt): the OLD background tracked
 *  every USER-origin sheet it inserted per tab under this session-storage
 *  key. On the cutover build's first start we exact-remove those sheets with
 *  the tracker's own bytes and clear the tracker — the v2 style delivery
 *  owns all style state from here on. Best effort by design: a sheet whose
 *  tab is gone died with the tab; a failure never blocks the v2 boot, and
 *  the tracker is cleared either way so the attempt is never repeated. */
const LEGACY_TABS_KEY = 'rv_insertedCssByTab';

async function exactRemoveLegacySheets(): Promise<void> {
  try {
    const stored = await chrome.storage.session.get(LEGACY_TABS_KEY);
    const tracker = stored[LEGACY_TABS_KEY] as Record<string, string[]> | undefined;
    if (tracker !== undefined) {
      for (const [id, sheets] of Object.entries(tracker)) {
        const tabId = Number(id);
        if (!Number.isInteger(tabId) || !Array.isArray(sheets)) continue;
        for (const css of sheets) {
          if (typeof css !== 'string' || css === '') continue;
          try {
            await chrome.scripting.removeCSS({ target: { tabId }, css, origin: 'USER' });
          } catch { /* tab gone or closed — its sheets died with it */ }
        }
      }
    }
    await chrome.storage.session.remove(LEGACY_TABS_KEY);
  } catch { /* storage unavailable — nothing to migrate */ }
}

export default defineBackground(() => {
  // S6.2: the toolbar button opens the shared workspace side panel (Chrome
  // 116+). Where the panel is unavailable, the same page runs as an extension
  // tab (the in-page "Open this workspace in a tab" button).
  chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);

  // S2.1: the one v2 document broker — synchronous envelope listener,
  // hydration barrier, route-epoch fencing, one run owner per document.
  // Its store quarantines legacy v0 `rv_*` journals untouched (S5.1).
  installBroker();

  void exactRemoveLegacySheets();
});

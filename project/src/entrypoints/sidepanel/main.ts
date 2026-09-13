/**
 * entrypoints/sidepanel — thin bootstrap for the shared workspace
 * (plan/02 §3: sidepanel and extension tab reuse the SAME workspace page).
 *
 * WXT maps this entrypoint to the manifest side_panel.default_path and adds
 * the sidePanel permission. The identical page opened as a tab is the
 * extension-tab fallback (plan/14 Workspace fallback row) — the in-page
 * "Open this workspace in a tab" button covers that direction.
 */

import { mountWorkspace, WORKSPACE_SETTINGS_KEY } from '../../ui/workspace.ts';

/** The last activated ordinary web tab — the workspace-as-tab fallback. */
let lastWebTabId: number | null = null;
let ownTabId: number | undefined;
void chrome.tabs.getCurrent?.().then((t) => { ownTabId = t?.id; }).catch(() => undefined);
chrome.tabs?.onActivated?.addListener((activeInfo) => {
  // Remember non-self activations so the fallback target tracks the page
  // the user was actually on (never this workspace's own tab).
  if (activeInfo.tabId !== ownTabId) lastWebTabId = activeInfo.tabId;
});

const root = document.getElementById('workspace');
if (root !== null) {
  mountWorkspace(root, {
    now: () => Date.now(),
    randomId: () => (typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`),
    sendToBroker: (raw) => chrome.runtime.sendMessage(raw) as Promise<unknown>,
    onMessage: (handler) => {
      chrome.runtime.onMessage.addListener(handler);
      return () => chrome.runtime.onMessage.removeListener(handler);
    },
    listTabs: async () => {
      const tabs = await chrome.tabs.query({});
      return tabs.map((t) => ({ id: t.id as number, ...(t.url !== undefined ? { url: t.url } : {}), ...(t.title !== undefined ? { title: t.title } : {}) }));
    },
    // The page the user is on IS the target (no manual picking). In the
    // side panel the active tab of this window is the web page. When this
    // page runs as a tab (the fallback), tabs.query reports THIS tab with
    // an EMPTY url (extension pages are not disclosed to tabs.query) — so
    // identify our own tab with tabs.getCurrent() and fall back to the last
    // real web tab the user activated.
    activeTabId: async () => {
      try {
        const own = await chrome.tabs.getCurrent?.();
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const t = tabs[0];
        if (t?.id === undefined) return lastWebTabId;
        if (own?.id === t.id) return lastWebTabId;
        lastWebTabId = t.id;
        return t.id;
      } catch {
        return lastWebTabId;
      }
    },
    loadSettings: async () => {
      const stored = await chrome.storage.local.get(WORKSPACE_SETTINGS_KEY);
      return stored[WORKSPACE_SETTINGS_KEY];
    },
    saveSettings: async (settings) => {
      await chrome.storage.local.set({ [WORKSPACE_SETTINGS_KEY]: settings });
    },
  });
}

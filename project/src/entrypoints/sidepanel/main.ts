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
    loadSettings: async () => {
      const stored = await chrome.storage.local.get(WORKSPACE_SETTINGS_KEY);
      return stored[WORKSPACE_SETTINGS_KEY];
    },
    saveSettings: async (settings) => {
      await chrome.storage.local.set({ [WORKSPACE_SETTINGS_KEY]: settings });
    },
  });
}

import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  manifest: {
    name: 'Revueon',
    description: 'An AI agent that lives in the browser',
    permissions: ['activeTab', 'storage', 'scripting', 'webNavigation', 'sidePanel'],
    host_permissions: ['<all_urls>'],
    // plan/12 §1: the proposed support floor. The v2 surface needs the side
    // panel API (114+); 120 is the plan's declared minimum.
    minimum_chrome_version: '120',
    action: {
      default_title: 'Open the Revueon workspace',
    },
  },
});

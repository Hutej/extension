import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  manifest: {
    name: 'Revueon',
    description: 'An AI agent that lives in the browser',
    permissions: ['activeTab', 'storage', 'scripting', 'webNavigation', 'sidePanel'],
    host_permissions: ['<all_urls>'],
    action: {
      default_title: 'Open the Revueon workspace',
    },
  },
  vite: () => ({
    // Pass model envs through at build time. Without this, process.env is not
    // available in the browser context (`process is not defined`). Every
    // process.env reference in config/index.ts must be listed here — a missing
    // one leaves a raw `process.env.X` in the bundle, which throws at load time
    // (the whole content script fails to load → no onMessage listener →
    // "Could not establish connection" → 130s timeout). audit-env.ts enforces this.
    define: {
      'process.env.RV_MODEL_STRONG': process.env.RV_MODEL_STRONG ? JSON.stringify(process.env.RV_MODEL_STRONG) : 'undefined',
      'process.env.RV_DEBUG': process.env.RV_DEBUG ? JSON.stringify(process.env.RV_DEBUG) : 'undefined',
    },
  }),
});

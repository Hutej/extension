import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  manifest: {
    name: 'Revueon',
    description: 'Reshape any website at runtime',
    permissions: ['activeTab', 'storage'],
    host_permissions: ['<all_urls>'],
  },
  vite: () => ({
    // Pass the per-role model envs through at build time (bake-off overrides;
    // undefined when not set -> config defaults). Without this, process.env is not
    // available in the browser context (`process is not defined`). EVERY process.env
    // reference in config/index.ts must be listed here — a missing one leaves a raw
    // `process.env.X` in the bundle, which throws `process is not defined` in the
    // content script at load time (the whole content script fails to load → no
    // onMessage listener → "Could not establish connection. Receiving end does not
    // exist." → the popup's "Cannot reach the page" + the harness 130s timeout).
    define: {
      'process.env.RV_MODEL': process.env.RV_MODEL ? JSON.stringify(process.env.RV_MODEL) : 'undefined',
      'process.env.RV_MODEL_ARCHITECT': process.env.RV_MODEL_ARCHITECT ? JSON.stringify(process.env.RV_MODEL_ARCHITECT) : 'undefined',
      'process.env.RV_MODEL_PAINTER': process.env.RV_MODEL_PAINTER ? JSON.stringify(process.env.RV_MODEL_PAINTER) : 'undefined',
      'process.env.RV_MODEL_CRITIC': process.env.RV_MODEL_CRITIC ? JSON.stringify(process.env.RV_MODEL_CRITIC) : 'undefined',
      'process.env.RV_EFFORT': process.env.RV_EFFORT ? JSON.stringify(process.env.RV_EFFORT) : 'undefined',
      'process.env.RV_LAYOUT_COMPILER': process.env.RV_LAYOUT_COMPILER ? JSON.stringify(process.env.RV_LAYOUT_COMPILER) : 'undefined',
      'process.env.RV_DEBUG': process.env.RV_DEBUG ? JSON.stringify(process.env.RV_DEBUG) : 'undefined',
      // S6.1: fixture mode (test-only). Inlined at build time. 'off' (default)
      // → dead branch tree-shaken in production. 'record'/'replay' → fixture code
      // active. File I/O is node:fs in the test harness, never in the extension.
      'process.env.RV_FIXTURES': process.env.RV_FIXTURES ? JSON.stringify(process.env.RV_FIXTURES) : 'undefined',
    },
  }),
});

import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  manifest: {
    name: 'WebMorph',
    description: 'Reshape any website at runtime',
    permissions: ['activeTab', 'storage'],
    host_permissions: ['<all_urls>'],
  },
  vite: () => ({
    // Pass the per-role model envs through at build time (bake-off overrides;
    // undefined when not set -> config defaults). Without this, process.env is not
    // available in the browser context (`process is not defined`).
    define: {
      'process.env.WM_MODEL': process.env.WM_MODEL ? JSON.stringify(process.env.WM_MODEL) : 'undefined',
      'process.env.WM_MODEL_ARCHITECT': process.env.WM_MODEL_ARCHITECT ? JSON.stringify(process.env.WM_MODEL_ARCHITECT) : 'undefined',
      'process.env.WM_MODEL_PAINTER': process.env.WM_MODEL_PAINTER ? JSON.stringify(process.env.WM_MODEL_PAINTER) : 'undefined',
      'process.env.WM_MODEL_CRITIC': process.env.WM_MODEL_CRITIC ? JSON.stringify(process.env.WM_MODEL_CRITIC) : 'undefined',
    },
  }),
});

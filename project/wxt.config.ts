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
    // Pass WM_MODEL through at build time (bake-off env override; undefined when
    // not set -> config defaults to 'gpt-5.1'). Without this, process.env is not
    // available in the browser context.
    define: {
      'process.env.WM_MODEL': process.env.WM_MODEL ? JSON.stringify(process.env.WM_MODEL) : 'undefined',
    },
  }),
});

import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  manifest: {
    name: 'WebMorph',
    description: 'Reshape any website at runtime',
    permissions: ['activeTab', 'storage'],
    host_permissions: ['<all_urls>'],
  },
});

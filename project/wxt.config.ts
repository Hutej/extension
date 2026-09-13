import { loadEnv } from 'vite';
import { defineConfig } from 'wxt';

/**
 * Owner-directed building-phase convenience (2026-09-13): the Cloudflare
 * Workers AI model is preconfigured from this machine's environment at BUILD
 * time, so a fresh load works with zero provider entry. The project .env
 * holds CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN (loaded here — WXT does
 * not inject .env into process.env itself); real shell env wins.
 *
 * ponytail: the token is baked into this machine's build artifact — move to
 * a proper provider-entry/secret flow before ever sharing a build.
 */
const env = loadEnv('', process.cwd(), '');
const cloudflare = {
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? env.CLOUDFLARE_ACCOUNT_ID ?? '',
  token: process.env.CLOUDFLARE_API_TOKEN ?? env.CLOUDFLARE_API_TOKEN ?? env.CLOUDFLARE_API_KEY ?? '',
  model: process.env.CLOUDFLARE_MODEL ?? env.CLOUDFLARE_MODEL ?? '@cf/deepseek-ai/deepseek-v4-flash-0731',
};

export default defineConfig({
  srcDir: 'src',
  vite: () => ({
    define: {
      __RV2_CLOUDFLARE__: JSON.stringify(cloudflare),
    },
  }),
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

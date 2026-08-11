/**
 * Playwright config for the Revueon harness.
 * Tests goals, not routes. Real extension, real browser, real model calls.
 *
 * The harness runs directly: node --experimental-strip-types tests/harness.ts
 * This config is for `npx playwright test` if that path is needed later.
 */
// This config is a plain object, not wrapped in defineConfig.

const extensionPath = new URL('.output/chrome-mv3', import.meta.url).pathname;

export default {
  testDir: './tests',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  use: {
    launchOptions: {
      headless: false,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    },
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
};

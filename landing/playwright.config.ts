import { defineConfig, devices } from '@playwright/test';

// Uses the pre-installed Chromium when PLAYWRIGHT_CHROMIUM_PATH is set
// (e.g. CI images that ship a browser); otherwise Playwright's own.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;

export default defineConfig({
  testDir: './tests',
  use: {
    baseURL: 'http://localhost:4173',
    ...devices['iPhone 13'],
    browserName: 'chromium',
    launchOptions: executablePath ? { executablePath } : {},
  },
  webServer: {
    command: 'node serve.mjs 4173', // run from this config's directory
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
  },
});

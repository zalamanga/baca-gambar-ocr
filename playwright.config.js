import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  outputDir: '.local/playwright-results',
  reporter: [
    ['line'],
    ['json', { outputFile: '.local/browser-results.json' }],
    ['html', { outputFolder: '.local/playwright-report', open: 'never' }],
  ],
  use: {
    baseURL: 'http://127.0.0.1:8124',
    browserName: 'chromium',
    channel: process.env.BROWSER_CHANNEL || undefined,
    viewport: { width: 1_440, height: 1_000 },
    locale: 'id-ID',
    serviceWorkers: 'block',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    actionTimeout: 15_000,
  },
  webServer: {
    command: 'python scripts/serve.py --port 8124',
    url: 'http://127.0.0.1:8124',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});

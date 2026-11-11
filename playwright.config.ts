import { defineConfig, devices } from '@playwright/test';
import { DEFAULT_E2E_REPORT_PATH } from './scripts/lib/e2e-flakes.mjs';

const PORT = 4173;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  // CI writes a JSON report so scripts/check-e2e-flakes.mjs can fail the job
  // when the guarded mobile-webkit case only passes after a retry.
  reporter: process.env.CI
    ? [['github'], ['list'], ['json', { outputFile: DEFAULT_E2E_REPORT_PATH }]]
    : [['list']],
  outputDir: 'test-results',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    reducedMotion: 'reduce',
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: /.*\.(?:mobile|webkit)\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } },
    },
    {
      name: 'mobile',
      testMatch: /.*\.mobile\.spec\.ts/,
      testIgnore: /.*\.webkit\.spec\.ts/,
      use: { ...devices['Pixel 7'] },
    },
    {
      name: 'mobile-webkit',
      testMatch: /.*\.webkit\.spec\.ts/,
      use: { ...devices['iPhone SE (3rd gen)'] },
    },
  ],
  webServer: {
    command: `npm run preview -- --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});

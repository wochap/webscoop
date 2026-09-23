import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  timeout: 90_000,
  retries: 1,
  // Each test launches a headed Chromium through the CLI; keep the desktop calm.
  workers: 2,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  outputDir: '../test-results',
});

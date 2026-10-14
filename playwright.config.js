import { defineConfig } from '@playwright/test';
const baseURL = 'http://127.0.0.1:8790';

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  use: { baseURL, trace: 'retain-on-failure' },
  webServer: {
    command: 'node scripts/test-server.js',
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 60000,
    env: { WRANGLER_SEND_METRICS: 'false' }
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }, { name: 'webkit', use: { browserName: 'webkit' } }],
  reporter: [['list'], ['html', { open: 'never' }]]
});

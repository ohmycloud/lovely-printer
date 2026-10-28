import { defineConfig } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A fresh database per run; never unlink a database a server may already have open.
const db = join(tmpdir(), `lovely-printer-playwright-${process.pid}-${Date.now()}.db`);
export default defineConfig({
  testDir: './tests/browser',
  workers: 1,
  fullyParallel: false,
  timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:3918', viewport: { width: 1200, height: 800 }, trace: 'retain-on-failure' },
  webServer: {
    command: 'cargo run -- serve --bind 127.0.0.1:3918',
    env: { DATABASE_URL: 'sqlite://' + db },
    url: 'http://127.0.0.1:3918/health',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});

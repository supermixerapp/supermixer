/*
 * End-to-end tests: `make e2e` (from the repository root) makes a fresh
 * database and settings file, then runs these against their own Supermixer
 * (:8091) and web app (127.0.0.1:5176), in the Chrome installed on this
 * machine. Nothing touches `make dev`'s servers or data.
 */
import { defineConfig } from '@playwright/test'

const config = process.env.SUPERMIXER_E2E_CONFIG
if (!config) throw new Error('run the end-to-end tests with `make e2e`, which sets SUPERMIXER_E2E_CONFIG')

export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:5176',
    channel: 'chrome',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: `go run ./cmd/supermixer --config ${config}`,
      cwd: '../backend',
      url: 'http://127.0.0.1:8091/api/v1/health',
      timeout: 180_000,
      reuseExistingServer: false,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: 'pnpm exec vite --host 127.0.0.1 --port 5176 --strictPort',
      url: 'http://127.0.0.1:5176',
      timeout: 60_000,
      reuseExistingServer: false,
      env: { SUPERMIXER_DEV_BACKEND: 'http://127.0.0.1:8091', SUPERMIXER_CONFIG: config },
    },
  ],
})

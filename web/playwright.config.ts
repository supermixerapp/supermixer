/*
 * End-to-end tests: `make e2e` (from the repository root) makes a fresh
 * database and settings file, then runs these against their own Supermixer
 * (:8091) and web app (127.0.0.1:5176), in the Chrome installed on this
 * machine. Nothing touches `make dev`'s servers or data.
 */
import { defineConfig } from '@playwright/test'

const config = process.env.SUPERMIXER_E2E_CONFIG
if (!config) throw new Error('run the end-to-end tests with `make e2e`, which sets SUPERMIXER_E2E_CONFIG')

// E2E_TLS=1 make e2e: the same tests over HTTPS (see e2e/setup.sh), plus
// e2e/tls.spec.ts. Chrome doesn't trust the throwaway CA, so certificate
// errors are ignored; Vite's proxy does trust it.
const tls = process.env.E2E_TLS === '1'
const devTLS = new URL('../deploy/dev-tls/out/', import.meta.url).pathname
const web = tls ? 'https://127.0.0.1:5176' : 'http://127.0.0.1:5176'

export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: web,
    ignoreHTTPSErrors: tls,
    channel: 'chrome',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  // Screenshots are named by test file, name and platform only.
  snapshotPathTemplate: '{testDir}/{testFileName}-snapshots/{arg}-{platform}{ext}',
  // The walk-through signs in the first admin and chooses their password;
  // the others run after it.
  projects: [
    { name: 'walkthrough', testMatch: 'walkthrough.spec.ts' },
    { name: 'after', testIgnore: 'walkthrough.spec.ts', dependencies: ['walkthrough'] },
  ],
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
      url: web,
      ignoreHTTPSErrors: tls,
      timeout: 60_000,
      reuseExistingServer: false,
      env: tls
        ? {
            SUPERMIXER_DEV_BACKEND: 'https://127.0.0.1:8491',
            SUPERMIXER_CONFIG: config,
            SUPERMIXER_DEV_HTTPS_CERT: devTLS + 'fullchain.pem',
            SUPERMIXER_DEV_HTTPS_KEY: devTLS + 'key.pem',
            NODE_EXTRA_CA_CERTS: devTLS + 'ca.pem',
          }
        : { SUPERMIXER_DEV_BACKEND: 'http://127.0.0.1:8091', SUPERMIXER_CONFIG: config },
    },
  ],
})

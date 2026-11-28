/*
 * Supermixer over HTTPS: run with `E2E_TLS=1 make e2e`, which gives the
 * test server a certificate from a throwaway CA (deploy/dev-tls). Skipped
 * otherwise.
 */
import { readFileSync } from 'node:fs'
import { request as http, type Page, expect, test } from '@playwright/test'

import { ADMIN_PASSWORD } from './accounts'

test.skip(process.env.E2E_TLS !== '1', 'needs E2E_TLS=1 make e2e')

async function signIn(page: Page) {
  await page.goto('/sign-in')
  await page.getByLabel('Username').fill('admin')
  await page.getByLabel('Password', { exact: true }).fill(ADMIN_PASSWORD)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.waitForURL((u) => !u.pathname.startsWith('/sign-in') && u.pathname !== '/dashboard')
}

test('signing in over HTTPS, with Secure cookies and no HSTS for an IP address', async ({ page }) => {
  const config = page.waitForResponse((r) => r.url().endsWith('/api/v1/ui-config'))
  await signIn(page)
  expect(page.url()).toMatch(/^https:/)
  const cookies = await page.context().cookies()
  for (const name of ['sm_session', 'sm_csrf']) {
    const c = cookies.find((c) => c.name === name)
    expect(c, name).toBeTruthy()
    expect(c!.secure, `${name} is Secure`).toBe(true)
  }
  // HSTS would pin every port of 127.0.0.1 to HTTPS: never sent to an IP.
  expect((await config).headers()['strict-transport-security']).toBeUndefined()
})

test('plain HTTP to Supermixer only redirects, except health checks', async () => {
  const plain = await http.newContext({ baseURL: 'http://127.0.0.1:8091' })
  try {
    const page = await plain.get('/projects?x=1', { maxRedirects: 0, headers: { Host: 'evil.example' } })
    expect(page.status()).toBe(308)
    expect(page.headers()['location']).toBe('https://127.0.0.1:5176/projects?x=1')
    expect((await plain.get('/api/v1/health')).status()).toBe(200)
  } finally {
    await plain.dispose()
  }
})

test('anyone can download the CA, to trust it', async ({ playwright, baseURL }) => {
  const anon = await playwright.request.newContext({ baseURL, ignoreHTTPSErrors: true })
  try {
    const res = await anon.get('/api/v1/tls/ca.pem')
    expect(res.status()).toBe(200)
    const ca = readFileSync(new URL('../../deploy/dev-tls/out/ca.pem', import.meta.url), 'utf8')
    expect(await res.text()).toBe(ca)
  } finally {
    await anon.dispose()
  }
})

test('Instance › Overview shows the certificate', async ({ page }) => {
  await signIn(page)
  await page.goto('/admin')
  const section = page.locator('section', { has: page.getByRole('heading', { name: 'Certificate', exact: true }) })
  await expect(section.getByText('Your own files')).toBeVisible()
  await expect(section.getByText('your own CA')).toBeVisible()
  await expect(section.getByText('127.0.0.1', { exact: true })).toBeVisible()
  await expect(section.getByText('Served on')).toBeVisible()
})

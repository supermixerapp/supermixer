/*
 * Per-organization single sign-on, through Dex (make sso): an owner
 * connects Dex, signs in with it and requires it; a password session is
 * shown the way in; and someone new joins by signing in with Dex. Skipped
 * unless Dex is running (setup.sh then adds it to the test's settings).
 */
import { expect, test, type Page } from '@playwright/test'

import { ADMIN_PASSWORD, DEX_PASSWORD } from './accounts'

const DEX = 'http://localhost:5556/dex'

async function dexRunning() {
  try {
    return (await fetch(`${DEX}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(3000) })).ok
  } catch {
    return false
  }
}

/** Signs in at Dex's login page (this Dex keeps no session, so it always
 * asks) and waits to be back in Supermixer. */
async function atDex(page: Page, email: string, backTo: RegExp) {
  await page.waitForURL((u) => u.host === 'localhost:5556')
  await page.locator('#login').fill(email)
  await page.locator('#password').fill(DEX_PASSWORD)
  await page.locator('#submit-login').click()
  await page.waitForURL((u) => u.host === '127.0.0.1:5176' && backTo.test(u.pathname))
}

async function signIn(page: Page) {
  await page.goto('/sign-in')
  await page.getByLabel('Username').fill('admin')
  await page.getByLabel('Password', { exact: true }).fill(ADMIN_PASSWORD)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  // The dashboard: one organization's projects, or the list.
  await page.waitForURL((u) => !u.pathname.startsWith('/sign-in') && u.pathname !== '/dashboard')
}

test('an organization requires Dex, and people join by signing in with it', async ({ page, browser }) => {
  test.skip(!(await dexRunning()), 'needs Dex running (make sso) when make e2e starts')

  await test.step('the owner connects Dex to their account', async () => {
    await signIn(page)
    const csrf = (await page.context().cookies()).find((c) => c.name === 'sm_csrf')?.value ?? ''
    const res = await page.request.post('/api/v1/organizations', {
      headers: { 'X-CSRF-Token': decodeURIComponent(csrf) },
      data: { name: 'SSO Labs' },
    })
    expect(res.status()).toBe(201)
    await page.goto('/account/security')
    await page.getByRole('button', { name: 'Connect', exact: true }).click()
    await page.getByRole('dialog').getByLabel('Password').fill(ADMIN_PASSWORD)
    await page.getByRole('dialog').getByRole('button', { name: 'Continue' }).click()
    await atDex(page, 'ada@example.test', /^\/account\/security$/)
    await expect(page.getByText('Connected Dex')).toBeVisible()
  })

  await test.step('signs in with Dex, then requires it and lets people join', async () => {
    await page.goto('/org/sso-labs/sso')
    const pickDex = async () => {
      await page.getByRole('combobox', { name: 'Provider' }).click()
      await page.getByRole('option', { name: 'Dex' }).click()
    }
    await pickDex()
    // Requiring it needs a session that came through it.
    await expect(page.getByRole('switch', { name: 'Require signing in with the provider' })).toBeDisabled()
    await page.getByRole('link', { name: 'Sign in with Dex' }).click()
    await atDex(page, 'ada@example.test', /^\/org\/sso-labs\/sso$/)
    await pickDex()
    await page.getByRole('switch', { name: 'Require signing in with the provider' }).click()
    await page.getByRole('switch', { name: 'Let people join by signing in' }).click()
    await page.getByLabel('Email domains').fill('example.test')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText('Single sign-on settings saved')).toBeVisible()
  })

  await test.step('a password session is shown the way in', async () => {
    const ctx = await browser.newContext()
    const other = await ctx.newPage()
    await signIn(other)
    await other.goto('/org/sso-labs')
    await expect(other.getByRole('heading', { name: 'SSO Labs requires signing in with Dex' })).toBeVisible()
    await other.getByRole('link', { name: 'Sign in with Dex' }).click()
    await atDex(other, 'ada@example.test', /^\/org\/sso-labs$/)
    await expect(other.getByRole('heading', { name: 'Projects' })).toBeVisible()
    await ctx.close()
  })

  await test.step('someone new signs in with Dex and joins', async () => {
    const ctx = await browser.newContext()
    const bea = await ctx.newPage()
    await bea.goto('/sign-in')
    await bea.getByRole('link', { name: 'Continue with Dex' }).click()
    // Their only organization: straight to its projects.
    await atDex(bea, 'bea@example.test', /^\/org\/sso-labs$/)
    await expect(bea.getByRole('heading', { name: 'Projects' })).toBeVisible()
    await ctx.close()
  })
})

/*
 * The end-to-end walk-through:
 * sign in as the first admin, create an organization, register the dev
 * Supabase stack (make stack) and see it healthy, invite a Read-only member
 * who signs up through the link, check they can't see secret keys or change
 * settings, and check the audit log recorded it all.
 *
 * Run with `make e2e`, which gives it its own Supermixer and database.
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { expect, test, type Page } from '@playwright/test'

const stackEnvPath =
  process.env.SUPERMIXER_E2E_STACK_ENV ?? fileURLToPath(new URL('../../deploy/dev-stacks/.stack/.env', import.meta.url))

// Throwaway passwords, for this test's own database only.
const FIRST_ADMIN_PASSWORD = 'e2e-first-admin-password' // from web/e2e/setup.sh
const ADMIN_PASSWORD = 'e2e-admin-chosen-password'
const READER_PASSWORD = 'e2e-reader-password-1'

/** The dev stack's .env, if it's there and the stack answers. */
async function devStackEnv(): Promise<string | null> {
  if (!existsSync(stackEnvPath)) return null
  const env = readFileSync(stackEnvPath, 'utf8')
  const url = env.match(/^SUPABASE_PUBLIC_URL=(.*)$/m)?.[1]?.trim()
  if (!url) return null
  try {
    await fetch(`${url}/auth/v1/health`, { signal: AbortSignal.timeout(5000) })
    return env
  } catch {
    return null
  }
}

async function signIn(page: Page, username: string, password: string) {
  await page.goto('/sign-in')
  await page.getByLabel('Username').fill(username)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
}

test('the first admin sets up an organization, a project and a Read-only member', async ({ page, browser }) => {
  const env = await devStackEnv()
  test.skip(env === null, `needs the dev Supabase stack running (make stack); its settings are read from ${stackEnvPath}`)

  await test.step('sign in as the first admin, who must choose a new password', async () => {
    await signIn(page, 'admin', FIRST_ADMIN_PASSWORD)
    await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible()
    await page.getByLabel('Password you signed in with').fill(FIRST_ADMIN_PASSWORD)
    await page.getByLabel('New password', { exact: true }).fill(ADMIN_PASSWORD)
    await page.getByLabel('Confirm new password').fill(ADMIN_PASSWORD)
    await page.getByRole('button', { name: 'Set password and continue' }).click()
    await expect(page).toHaveURL(/\/organizations$/)
  })

  let slug = ''
  await test.step('create an organization', async () => {
    await page.getByRole('button', { name: 'New organization' }).first().click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Name').fill('E2E Labs')
    await dialog.getByRole('button', { name: 'Create organization' }).click()
    await expect(page).toHaveURL(/\/org\/[^/]+$/)
    slug = new URL(page.url()).pathname.split('/')[2]
  })

  let ref = ''
  await test.step('register the dev stack; Test connection passes', async () => {
    await page.goto(`/new/${slug}`)
    await page.getByRole('button', { name: 'Fill from Supabase .env' }).click()
    await page.getByLabel('Supabase .env contents').fill(env!)
    await page.getByRole('button', { name: 'Fill in form' }).click()
    await page.getByLabel('Project name').fill('Dev stack')
    await page.getByRole('button', { name: 'Test connection' }).click()
    const result = page.getByText('Connection test').locator('..')
    await expect(result.getByText('Healthy', { exact: true })).toBeVisible({ timeout: 30_000 })
    await page.getByRole('button', { name: 'Create project' }).click()
    await expect(page).toHaveURL(/\/project\/[a-z]{20}/)
    ref = new URL(page.url()).pathname.split('/')[2]
  })

  await test.step("the organization's projects show it healthy", async () => {
    const health = await (await page.request.get(`/api/v1/projects/${ref}/health`)).json()
    expect(health.status, JSON.stringify(health, null, 2)).toBe('healthy')
    await page.goto(`/org/${slug}`)
    const card = page.getByRole('link').filter({ hasText: 'Dev stack' })
    await expect(card.getByText('Healthy', { exact: true })).toBeVisible({ timeout: 30_000 })
  })

  let invite = ''
  await test.step('invite a Read-only member', async () => {
    await page.goto(`/org/${slug}/team`)
    await page.getByRole('button', { name: 'Invite members' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('combobox').first().click()
    await page.getByRole('option', { name: 'Read-only' }).click()
    await dialog.getByRole('button', { name: 'Create invitation link' }).click()
    await expect(dialog.getByRole('heading', { name: 'Share the invitation link' })).toBeVisible()
    invite = (await dialog.locator('code').first().textContent()) ?? ''
    expect(invite).toMatch(/\/join\?token=/)
    await dialog.getByRole('button', { name: 'Done' }).click()
  })

  // The member, in a browser of their own.
  const reader = await (await browser.newContext()).newPage()
  await test.step('they sign up through the link and join', async () => {
    await reader.goto(invite)
    await reader.getByLabel('Username').fill('reader')
    await reader.getByLabel('Password').fill(READER_PASSWORD)
    await reader.getByRole('button', { name: 'Create account and join' }).click()
    await expect(reader).toHaveURL(/\/organizations$/)
    await expect(reader.getByText('E2E Labs')).toBeVisible()
  })

  await test.step("they can't see secret keys", async () => {
    await reader.goto(`/project/${ref}/settings/api-keys`)
    const reveal = reader.getByRole('button', { name: 'Reveal' })
    await expect(reveal.first()).toBeVisible()
    for (const b of await reveal.all()) await expect(b).toBeDisabled()
    // Nor through the API.
    const res = await reader.request.get(`/api/v1/projects/${ref}/api-keys?reveal=true`)
    expect(res.status()).toBe(403)
  })

  await test.step("they can't change settings", async () => {
    await reader.goto(`/project/${ref}/settings/general`)
    await expect(reader.getByLabel('Project name')).toBeDisabled()
    const csrf = (await reader.context().cookies()).find((c) => c.name === 'sm_csrf')?.value ?? ''
    const res = await reader.request.patch(`/api/v1/projects/${ref}`, {
      headers: { 'X-CSRF-Token': decodeURIComponent(csrf) },
      data: { name: 'Renamed' },
    })
    expect(res.status()).toBe(403)
  })

  await test.step('the audit log recorded each step', async () => {
    await page.goto(`/org/${slug}/audit`)
    const table = page.getByRole('table')
    for (const action of ['organization.created', 'project.created', 'invitation.created', 'member.joined']) {
      await expect(table.getByText(action, { exact: true }).first()).toBeVisible()
    }
    await expect(table.getByRole('row').filter({ hasText: 'member.joined' }).getByText('reader')).not.toHaveCount(0)
  })

  await reader.context().close()
})

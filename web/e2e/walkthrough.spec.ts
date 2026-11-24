/*
 * The end-to-end walk-through:
 * sign in as the first admin, create an organization, register the dev
 * Supabase stack (make stack) and see it healthy, invite a Read-only member
 * who signs up through the link, check they can't see secret keys or change
 * settings, and check the audit log recorded it all. Along the way, nothing
 * the browser loads may come from anywhere but Supermixer (no font, icon or
 * script CDNs), and at the end key pages are compared with screenshots in
 * light and dark (update them with `make e2e ARGS=--update-snapshots`).
 *
 * Run with `make e2e`, which gives it its own Supermixer and database.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'

import { expect, test, type BrowserContext, type Page } from '@playwright/test'

const stackEnvPath =
  process.env.SUPERMIXER_E2E_STACK_ENV ?? fileURLToPath(new URL('../../deploy/dev-stacks/.stack/.env', import.meta.url))

import { ADMIN_PASSWORD, FIRST_ADMIN_PASSWORD, READER_PASSWORD } from './accounts'

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

const APP_HOST = '127.0.0.1:5176'

/** Records requests that go anywhere but Supermixer. */
function watchRequests(ctx: BrowserContext, outside: string[]) {
  ctx.on('request', (r) => {
    const u = new URL(r.url())
    if (['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol) && u.host !== APP_HOST) outside.push(r.url())
  })
}

async function setTheme(page: Page, theme: 'light' | 'dark') {
  const csrf = (await page.context().cookies()).find((c) => c.name === 'sm_csrf')?.value ?? ''
  const res = await page.request.patch('/api/v1/profile', { headers: { 'X-CSRF-Token': decodeURIComponent(csrf) }, data: { theme } })
  expect(res.ok()).toBe(true)
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
  const outside: string[] = []
  watchRequests(page.context(), outside)

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
  const readerContext = await browser.newContext()
  watchRequests(readerContext, outside)
  const reader = await readerContext.newPage()
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

  await readerContext.close()

  await test.step('an owner adds a webhook and it receives signed events', async () => {
    // A receiver that checks each request's signature.
    const received: { event: string; body: { type: string; organization: string; target: { name: string } } }[] = []
    let secret = ''
    const receiver = createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        const sig = String(req.headers['x-supermixer-signature'] ?? '')
        const t = sig.match(/t=(\d+)/)?.[1] ?? ''
        const v1 = Buffer.from(sig.match(/v1=([0-9a-f]+)/)?.[1] ?? '', 'hex')
        const want = createHmac('sha256', secret).update(`${t}.${raw}`).digest()
        if (v1.length !== want.length || !timingSafeEqual(v1, want)) {
          res.writeHead(401).end()
          return
        }
        received.push({ event: String(req.headers['x-supermixer-event']), body: JSON.parse(raw) })
        res.writeHead(204).end()
      })
    })
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hooks`
    try {
      await page.goto(`/org/${slug}/webhooks`)
      await page.getByRole('button', { name: 'Add webhook' }).click()
      const dialog = page.getByRole('dialog')
      await dialog.getByLabel('URL').fill(url)
      await dialog.getByRole('button', { name: 'Add webhook' }).click()
      // The secret, shown once.
      const shown = page.getByRole('dialog').filter({ hasText: 'Signing secret' })
      secret = ((await shown.locator('code').first().textContent()) ?? '').trim()
      expect(secret).toMatch(/^whsec_/)
      await shown.getByRole('button', { name: 'Done' }).click()

      await page.getByRole('button', { name: 'Send test event' }).click()
      await expect.poll(() => received.map((r) => r.event)).toContain('webhook.test')

      // A real event: the default kinds are projects and members.
      await page.goto(`/org/${slug}/team`)
      await page.getByRole('button', { name: 'Invite members' }).click()
      const invite = page.getByRole('dialog')
      await invite.getByRole('button', { name: 'Create invitation link' }).click()
      const link = ((await invite.locator('code').first().textContent()) ?? '').trim()
      await invite.getByRole('button', { name: 'Done' }).click()
      const joiner = await browser.newContext()
      watchRequests(joiner, outside)
      const p = await joiner.newPage()
      await p.goto(link)
      await p.getByLabel('Username').fill('hooked')
      await p.getByLabel('Password').fill(READER_PASSWORD)
      await p.getByRole('button', { name: 'Create account and join' }).click()
      await expect(p).toHaveURL(/\/organizations$/)
      await joiner.close()
      await expect
        .poll(() => received.find((r) => r.event === 'member.joined')?.body, { timeout: 30_000 })
        .toMatchObject({ type: 'member.joined', organization: slug, target: { name: 'hooked' } })

      await page.goto(`/org/${slug}/webhooks`)
      await expect(page.getByText('Delivering', { exact: true })).toBeVisible()
    } finally {
      receiver.close()
    }
  })

  await test.step('the SSO settings page loads', async () => {
    await page.goto(`/org/${slug}/sso`)
    // With Dex running (make sso), sso.spec.ts tests it properly.
    await expect(page.getByText('No sign-in providers on this instance').or(page.getByLabel('Provider'))).toBeVisible()
  })

  await test.step('key pages look as before, light and dark', async () => {
    const shot = { fullPage: true, maxDiffPixelRatio: 0.01 }
    // The sign-in page has a button per single sign-on provider (Dex, with make sso).
    const ui = await (await page.request.get('/api/v1/ui-config')).json()
    const sso = ui.sso_providers.length > 0 ? '-sso' : ''
    for (const theme of ['light', 'dark'] as const) {
      // Signed out: the browser's choice.
      const fresh = await browser.newContext()
      watchRequests(fresh, outside)
      await fresh.addInitScript((t) => localStorage.setItem('supermixer.theme', t), theme)
      const signedOut = await fresh.newPage()
      await signedOut.goto('/sign-in')
      await expect(signedOut.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
      await expect(signedOut).toHaveScreenshot(`sign-in-${theme}${sso}.png`, shot)
      await fresh.close()

      // Signed in: the account's choice.
      await setTheme(page, theme)
      await page.goto(`/org/${slug}`)
      await expect(page.getByRole('link').filter({ hasText: 'Dev stack' }).getByText('Healthy', { exact: true })).toBeVisible({
        timeout: 30_000,
      })
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
      await expect(page).toHaveScreenshot(`projects-${theme}.png`, shot)
      await page.goto('/account/me')
      await expect(page.getByRole('heading', { name: 'Preferences' })).toBeVisible()
      await expect(page).toHaveScreenshot(`account-${theme}.png`, shot)
    }
  })

  expect(outside, 'requests to anywhere but Supermixer').toEqual([])
})

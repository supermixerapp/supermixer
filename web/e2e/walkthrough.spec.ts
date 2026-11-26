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

  await test.step('with one organization, signing in opens its projects; the list is still there', async () => {
    const ctx = await browser.newContext()
    const again = await ctx.newPage()
    await signIn(again, 'admin', ADMIN_PASSWORD)
    await expect(again).toHaveURL(new RegExp(`/org/${slug}$`))
    await again.goto('/organizations')
    await expect(again.getByRole('heading', { name: 'Your Organizations' })).toBeVisible()
    await ctx.close()
  })

  await test.step('the homepage: Sign in for visitors; Dashboard, search and the account menu once signed in', async () => {
    const ctx = await browser.newContext()
    watchRequests(ctx, outside)
    const visitor = await ctx.newPage()
    await visitor.goto('/')
    await expect(visitor.getByRole('heading', { name: /All your Supabase projects/ })).toBeVisible()
    const nav = visitor.getByRole('banner')
    await expect(nav.getByRole('link', { name: 'Dashboard' })).toHaveCount(0)
    await expect(nav.getByRole('button', { name: 'Account menu' })).toHaveCount(0)
    await nav.getByRole('link', { name: 'Sign in' }).click()
    await expect(visitor).toHaveURL(/\/sign-in$/)
    await ctx.close()

    await page.goto('/')
    const header = page.getByRole('banner')
    await expect(header.getByRole('button', { name: 'Account menu' })).toBeVisible()
    await expect(header.getByRole('button', { name: /^Search\.\.\./ })).toBeVisible()
    await expect(header.getByRole('link', { name: 'Sign in' })).toHaveCount(0)
    await header.getByRole('link', { name: 'Dashboard' }).click()
    await expect(page).toHaveURL(new RegExp(`/org/${slug}$`))
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
    // What the card itself is given, to say why if it isn't healthy.
    // (The org page's request, not one the project page made before it.)
    const cardHealth = page.waitForResponse(
      (r) => r.url().includes(`/api/v1/projects/${ref}/health`) && (r.request().headers()['referer'] ?? '').endsWith(`/org/${slug}`)
    )
    await page.goto(`/org/${slug}`)
    const seen = await (await cardHealth).json()
    expect(seen.status, `the card's health: ${JSON.stringify(seen, null, 2)}`).toBe('healthy')
    const card = page.getByRole('link').filter({ hasText: 'Dev stack' })
    await expect(card.getByText('Healthy', { exact: true })).toBeVisible({ timeout: 30_000 })
  })

  await test.step('projects show as a list too, and the choice is remembered', async () => {
    await page.getByRole('button', { name: 'Toggle list view' }).click()
    await expect(page.getByRole('button', { name: 'Toggle list view' })).toHaveAttribute('aria-pressed', 'true')
    const row = page.getByRole('row').filter({ hasText: 'Dev stack' })
    await expect(row.getByText('Healthy', { exact: true })).toBeVisible({ timeout: 30_000 })
    await page.reload()
    await expect(page.getByRole('row').filter({ hasText: 'Dev stack' })).toBeVisible()
    await page.getByRole('row').filter({ hasText: 'Dev stack' }).getByText('localhost:8100').click()
    await expect(page).toHaveURL(new RegExp(`/project/${ref}$`))
    await page.goto(`/org/${slug}`)
    // Each row's Settings button goes straight to the project's settings.
    await page.getByRole('link', { name: 'Settings for Dev stack' }).click()
    await expect(page).toHaveURL(new RegExp(`/project/${ref}/settings/general$`))
    await page.goto(`/org/${slug}`)
    await page.getByRole('button', { name: 'Toggle grid view' }).click()
    await expect(page.getByRole('link').filter({ hasText: 'Dev stack' })).toBeVisible()
    // So does each card's menu.
    await page.getByRole('button', { name: 'Actions for Dev stack' }).click()
    await page.getByRole('menuitem', { name: 'Settings' }).click()
    await expect(page).toHaveURL(new RegExp(`/project/${ref}/settings/general$`))
    await page.goto(`/org/${slug}`)
  })

  let invite = ''
  await test.step('New organization from the breadcrumb switcher opens its dialog', async () => {
    await page.goto(`/org/${slug}`)
    await page.getByRole('button', { name: 'Show organizations' }).click()
    await page.getByRole('option', { name: 'New organization' }).click()
    // Right away, without reopening the switcher (it used to vanish with it).
    const dialog = page.getByRole('dialog', { name: 'Create a new organization' })
    await expect(dialog).toBeVisible({ timeout: 2000 })
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
  })

  await test.step('sign-up stays closed without email', async () => {
    // This Supermixer can't send email, so sign-up can't be turned on.
    await page.goto('/admin/sign-up')
    await expect(page.getByText("This Supermixer can't send email")).toBeVisible()
    await expect(page.getByRole('switch', { name: 'Allow people to create accounts' })).toBeDisabled()
    // Visitors aren't offered it, and the page says how to get an account.
    const visitor = await page.context().browser()!.newPage()
    await visitor.goto('/sign-in')
    await expect(visitor.getByText('No account yet? Ask your Supermixer admin')).toBeVisible()
    await visitor.goto('/sign-up')
    // With make sso, Dex makes accounts (create_users), so it's offered
    // there, without the email form; otherwise the page says it's closed.
    const ui = await (await page.request.get('/api/v1/ui-config')).json()
    const creating = ui.sso_providers.filter((p: { creates_accounts: boolean }) => p.creates_accounts)
    if (creating.length > 0) {
      await expect(visitor.getByRole('link', { name: `Continue with ${creating[0].name}` })).toBeVisible()
      await expect(visitor.getByLabel('Email')).toHaveCount(0)
    } else {
      await expect(visitor.getByText("You can't create your own account on this Supermixer")).toBeVisible()
    }
    await visitor.close()
  })

  await test.step('resource limits: one project per organization blocks New project', async () => {
    await page.goto('/admin/limits')
    await page.getByRole('switch', { name: 'Limit projects per organization' }).click()
    await page.locator('#max-projects').fill('1')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText('Resource limits saved')).toBeVisible()

    await page.goto(`/org/${slug}`)
    await expect(page.getByText('1 of 1 project', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'New project' })).toBeDisabled()
    await page.goto(`/org/${slug}/general`)
    await expect(page.getByText('1 of 1 project used')).toBeVisible()
    // An organization can't go above the instance's limit.
    await page.getByRole('switch', { name: 'Limit project limit' }).click()
    await page.locator('#org-max-projects').fill('2')
    await expect(page.getByText('Enter a whole number from 1 to 1')).toBeVisible()

    await page.goto('/admin/limits')
    await page.getByRole('switch', { name: 'Limit projects per organization' }).click()
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText('Resource limits saved')).toBeVisible()
    await page.goto(`/org/${slug}`)
    await expect(page.getByRole('button', { name: 'New project' })).toBeEnabled()
  })

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
    // Their only organization: straight to its projects.
    await expect(reader).toHaveURL(new RegExp(`/org/${slug}$`))
    await expect(reader.getByRole('heading', { name: 'Projects' })).toBeVisible()
  })

  await test.step('the account menu shows each person their role where they are', async () => {
    await reader.getByRole('button', { name: 'Account menu' }).click()
    const readerMenu = reader.getByRole('menu')
    await expect(readerMenu.getByText('Read-only', { exact: true })).toBeVisible()
    await expect(readerMenu.getByText('Instance admin', { exact: true })).toHaveCount(0)
    await reader.keyboard.press('Escape')

    await page.goto(`/project/${ref}`)
    await page.getByRole('button', { name: 'Account menu' }).click()
    const menu = page.getByRole('menu')
    await expect(menu.getByText('Owner', { exact: true })).toBeVisible()
    await expect(menu.getByText('in Dev stack')).toBeVisible()
    // The badge, and the menu item leading to Instance.
    await expect(menu.getByText('Instance admin', { exact: true })).toHaveCount(2)
    await page.keyboard.press('Escape')
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

  await test.step('an instance admin posts a global notice; everyone sees it above the header', async () => {
    // With the Markdown a notice may use: bold, and a link.
    const message = 'Supermixer will be down on **Saturday, 22:00–23:00 UTC**. [Your account](/account/me)'
    const shown = 'Supermixer will be down on Saturday, 22:00–23:00 UTC. Your account'
    await page.goto('/admin/notice')
    await expect(page.getByText('Write a message to see the notice.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Take down' })).toHaveCount(0)
    await page.getByRole('combobox', { name: 'Notice type' }).click()
    await page.getByRole('option', { name: 'Warning' }).click()
    await page.getByLabel('Message').fill('x'.repeat(257))
    await expect(page.getByText('1 characters too many')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Post notice' })).toBeDisabled()
    await page.getByLabel('Message').fill(message)
    await expect(page.getByText(`${message.length} / 256`)).toBeVisible()
    await page.getByRole('button', { name: 'Post notice' }).click()
    await expect(page.getByText('Notice posted')).toBeVisible()

    // Visitors who aren't signed in see it on the homepage and the sign-in pages too.
    const anon = await browser.newContext()
    const visitor = await anon.newPage()
    await visitor.goto('/')
    await expect(visitor.getByRole('status', { name: 'Warning notice' })).toHaveText(shown)
    for (const path of ['/sign-in', '/forgot-password']) {
      await visitor.goto(path)
      await expect(visitor.getByRole('status', { name: 'Warning notice' })).toHaveText(shown)
    }
    await anon.close()

    // The member: after a reload (otherwise within a minute), on any page, as tall as the header.
    await reader.goto(`/org/${slug}`)
    const band = reader.getByRole('status', { name: 'Warning notice' })
    await expect(band).toHaveText(shown)
    await expect(band.locator('strong')).toHaveText('Saturday, 22:00–23:00 UTC')
    const bandBox = await band.boundingBox()
    const headerBox = await reader.locator('header').first().boundingBox()
    expect(bandBox?.y).toBe(0)
    expect(bandBox?.height).toBe(headerBox?.height)
    // A path in Supermixer opens in place.
    await band.getByRole('link', { name: 'Your account' }).click()
    await expect(reader).toHaveURL(/\/account\/me$/)
    await expect(reader.getByRole('heading', { name: 'Preferences' })).toBeVisible()
    await reader.goto(`/org/${slug}`)
    const csrf = (await reader.context().cookies()).find((c) => c.name === 'sm_csrf')?.value ?? ''
    const res = await reader.request.put('/api/v1/admin/notice', {
      headers: { 'X-CSRF-Token': decodeURIComponent(csrf) },
      data: { type: 'info', message: 'Not mine to post' },
    })
    expect(res.status()).toBe(403)

    // Critical, then taken down.
    await page.getByRole('combobox', { name: 'Notice type' }).click()
    await page.getByRole('option', { name: 'Critical' }).click()
    await page.getByRole('button', { name: 'Update notice' }).click()
    await expect(page.getByText('Notice updated')).toBeVisible()
    await reader.reload()
    await expect(reader.getByRole('alert', { name: 'Critical notice' })).toHaveText(shown)
    await expect(page.getByText(/^Showing now; posted by admin/)).toBeVisible()
    await page.getByLabel('Message').fill('Edited')
    await expect(page.getByText('Not posted yet: admin’s notice shows until you update it.')).toBeVisible()
    await page.getByRole('button', { name: 'Cancel' }).click()
    await page.getByRole('button', { name: 'Take down' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Take down' }).click()
    await expect(page.getByText('Not posted yet: nobody sees it until you post it.')).toBeVisible()
    await reader.reload()
    await expect(reader.getByRole('heading', { name: 'Projects' })).toBeVisible()
    await expect(reader.getByRole('status', { name: /notice$/ })).toHaveCount(0)
    await expect(reader.getByRole('alert', { name: /notice$/ })).toHaveCount(0)
  })

  await test.step('filter the instance users by name, email and status', async () => {
    await page.goto('/admin/users')
    const rows = page.getByRole('table').getByRole('row')
    await expect(rows.filter({ hasText: 'reader' })).toHaveCount(1)
    await page.getByPlaceholder('Search by username or email').fill('READ')
    await expect(rows.filter({ hasText: 'reader' })).toHaveCount(1)
    await expect(rows.filter({ hasText: 'Administrator' })).toHaveCount(0)
    await page.getByPlaceholder('Search by username or email').fill('')
    await page.getByRole('combobox', { name: 'Status' }).click()
    await page.getByRole('option', { name: 'Instance admins' }).click()
    await expect(rows.filter({ hasText: 'Administrator' })).toHaveCount(1)
    await expect(rows.filter({ hasText: 'reader' })).toHaveCount(0)
    await page.getByPlaceholder('Search by username or email').fill('nobody-like-this')
    await expect(page.getByText('No users match these filters.')).toBeVisible()
    await page.getByRole('button', { name: 'Clear filters' }).click()
    await expect(rows.filter({ hasText: 'reader' })).toHaveCount(1)
  })

  await test.step('instance reports list every organization and project, without a way into them', async () => {
    await page.goto('/admin/organizations')
    const org = page.getByRole('table').getByRole('row').filter({ hasText: slug })
    await expect(org).toHaveCount(1)
    await expect(org.getByText('admin', { exact: true })).toBeVisible() // its owner

    await page.goto('/admin/projects')
    const rows = page.getByRole('table').getByRole('row')
    const dev = rows.filter({ hasText: 'Dev stack' })
    await expect(dev.getByText('Connected', { exact: true })).toBeVisible()
    await expect(page.getByRole('table').getByRole('link')).toHaveCount(0)
    await page.getByRole('combobox', { name: 'State' }).click()
    await page.getByRole('option', { name: 'Paused' }).click()
    await expect(page.getByText('No projects match these filters.')).toBeVisible()
    await page.getByRole('button', { name: 'Clear filters' }).click()
    await page.getByPlaceholder('Search projects').fill(slug)
    await expect(dev).toHaveCount(1)

    const download = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Export CSV' }).click()
    const file = await download
    expect(file.suggestedFilename()).toMatch(/^supermixer-projects-\d{4}-\d{2}-\d{2}\.csv$/)
    const text = readFileSync(await file.path(), 'utf8')
    expect(text.startsWith('\uFEFF')).toBe(true) // so Excel reads it as UTF-8
    const csv = text.slice(1).split('\n')
    expect(csv[0]).toMatch(/^Project,Ref,Organization,/)
    expect(csv.find((l) => l.startsWith('Dev stack,'))).toContain(',Connected,')
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
      await expect(p).toHaveURL(new RegExp(`/org/${slug}$`))
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

  await test.step('an owner posts the organization\'s events to a chat channel', async () => {
    // A Mattermost-style incoming webhook: {"text": "..."} at a secret path.
    const messages: string[] = []
    const paths: string[] = []
    const receiver = createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        paths.push(req.url ?? '')
        messages.push(String(JSON.parse(raw).text ?? ''))
        res.writeHead(200).end('ok')
      })
    })
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve))
    const host = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`
    try {
      await page.goto(`/org/${slug}/integrations`)
      await expect(page.getByRole('link', { name: /Chat notifications/ })).toContainText('Not set up')
      await expect(page.getByRole('link', { name: /Webhooks/ })).toContainText('1 webhook')
      await page.screenshot({ path: 'e2e/.tmp/integrations.png', fullPage: true })
      await page.getByRole('link', { name: /Chat notifications/ }).click()
      await expect(page).toHaveURL(new RegExp(`/org/${slug}/integrations/chat$`))
      await page.getByRole('button', { name: 'Add channel' }).click()
      const dialog = page.getByRole('dialog')
      await dialog.getByLabel('App').click()
      await page.getByRole('option', { name: 'Mattermost' }).click()
      await dialog.getByLabel('Incoming webhook URL').fill(`${host}/hooks/s3cr3t`)
      await dialog.getByLabel('Description (optional)').fill('#ops')
      await page.screenshot({ path: 'e2e/.tmp/chat-dialog.png' })
      await dialog.getByRole('button', { name: 'Add channel' }).click()
      await expect(dialog).toBeHidden()
      // The address is a credential: only its host is shown from now on.
      await expect(page.getByText(host, { exact: true })).toBeVisible()
      await expect(page.getByText('s3cr3t')).toHaveCount(0)

      await page.getByRole('button', { name: 'Send test message' }).click()
      await expect.poll(() => messages.join('\n')).toContain('sent a test message')
      expect(paths).toEqual(['/hooks/s3cr3t'])
      // A test message doesn't count as delivering events (as for webhooks).
      await expect(page.getByText('Waiting for events', { exact: true })).toBeVisible()
      await page.screenshot({ path: 'e2e/.tmp/chat.png', fullPage: true })

      // Chat channels aren't listed with the webhooks.
      await page.goto(`/org/${slug}/webhooks`)
      await expect(page.getByText(host, { exact: true })).toHaveCount(0)
      await page.goto(`/org/${slug}/integrations`)
      await expect(page.getByRole('link', { name: /Chat notifications/ })).toContainText('1 channel')
    } finally {
      receiver.close()
    }
  })

  await test.step('organization security, and pages still to come', async () => {
    await page.goto(`/org/${slug}/security`)
    await expect(page.getByLabel('Require two-factor sign-in')).toBeVisible()
    await expect(page.getByText('Members may sign in with a password.')).toBeVisible()
    await page.goto(`/org/${slug}/apps`)
    await expect(page.getByText('Coming soon', { exact: true })).toBeVisible()
    await expect(page.getByText(/part of Stage/)).toHaveCount(0)
  })

  await test.step('Storage settings and S3 explain a stack Supermixer connects to', async () => {
    await page.goto(`/project/${ref}/storage/settings`)
    await expect(page.getByText('so its Storage settings are set where it runs')).toBeVisible()
    await page.goto(`/project/${ref}/storage/s3`)
    await expect(page.getByText('http://localhost:8100/storage/v1/s3').first()).toBeVisible()
    await expect(page.getByText('so its S3 keys are where it runs')).toBeVisible()
  })

  await test.step('the SSO settings page loads', async () => {
    await page.goto(`/org/${slug}/sso`)
    // With Dex running (make sso), sso.spec.ts tests it properly.
    await expect(page.getByText('No sign-in providers on this instance').or(page.getByLabel('Provider'))).toBeVisible()
  })

  await test.step('the user menu leads to the API endpoints, listed from the live spec', async () => {
    await page.getByRole('button', { name: 'Account menu' }).click()
    await page.getByRole('menuitem', { name: 'API endpoints' }).click()
    await expect(page).toHaveURL(/\/docs\/api$/)
    await expect(page.getByRole('heading', { name: 'API endpoints', level: 1 })).toBeVisible()
    // From the spec, so new endpoints appear by themselves; and the hand-written ones.
    await expect(page.getByRole('cell', { name: '/projects/{ref}/stack/logs', exact: true })).toBeVisible()
    await expect(page.getByRole('cell', { name: '/v1/projects/{ref}/pause', exact: true })).toBeVisible()
    await page.getByPlaceholder('Search endpoints').fill('backups restore')
    await expect(page.getByRole('cell', { name: '/projects/{ref}/backups/{id}/restore', exact: true })).toBeVisible()
    await expect(page.getByRole('cell', { name: '/projects/{ref}/stack/logs', exact: true })).toHaveCount(0)
  })

  await test.step('key pages look as before, light and dark', async () => {
    // Strict enough to notice a new button; renders on one machine match exactly.
    const shot = { fullPage: true, maxDiffPixels: 100 }
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
      // The greeting is picked at random, so it's masked.
      await expect(signedOut).toHaveScreenshot(`sign-in-${theme}${sso}.png`, {
        ...shot,
        mask: [signedOut.getByRole('heading', { level: 1 })],
      })
      await signedOut.goto('/')
      await expect(signedOut.getByRole('heading', { name: /All your Supabase projects/ })).toBeVisible()
      await expect(signedOut).toHaveScreenshot(`home-${theme}.png`, shot)
      await fresh.close()

      // Signed in: the account's choice.
      await setTheme(page, theme)
      await page.goto(`/org/${slug}`)
      await expect(page.getByRole('link').filter({ hasText: 'Dev stack' }).getByText('Healthy', { exact: true })).toBeVisible({
        timeout: 30_000,
      })
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
      await expect(page).toHaveScreenshot(`projects-${theme}.png`, shot)
      // The list shows each project's creation date: today's, so fixed here
      // (it would change the columns' widths from one day to the next).
      await page.route('**/api/v1/projects', async (route) => {
        const res = await route.fetch()
        const projects = (await res.json()) as { created_at: string }[]
        await route.fulfill({ response: res, json: projects.map((p) => ({ ...p, created_at: '2026-01-15T12:00:00Z' })) })
      })
      await page.reload()
      await page.getByRole('button', { name: 'Toggle list view' }).click()
      await expect(page.getByRole('row').filter({ hasText: 'Dev stack' }).getByText('Healthy', { exact: true })).toBeVisible()
      await expect(page.getByRole('cell', { name: new Date('2026-01-15T12:00:00Z').toLocaleDateString('en-US') })).toBeVisible()
      await expect(page).toHaveScreenshot(`projects-list-${theme}.png`, shot)
      await page.unroute('**/api/v1/projects')
      await page.getByRole('button', { name: 'Toggle grid view' }).click()
      await page.goto('/account/me')
      await expect(page.getByRole('heading', { name: 'Preferences' })).toBeVisible()
      await expect(page).toHaveScreenshot(`account-${theme}.png`, shot)
    }
  })

  expect(outside, 'requests to anywhere but Supermixer').toEqual([])
})

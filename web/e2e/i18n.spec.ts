/*
 * The app in another language: the language menu in the homepage navbar and
 * in the app header switches it in place, without a reload, the choice
 * follows the account into a fresh browser, and the main pages show no
 * missing text. Each page is saved as a
 * screenshot in e2e/.tmp/i18n/ (not compared; for looking at). Runs after
 * the walk-through, which made the organization and project it visits, and
 * puts the admin back in English for the tests after it.
 */
import { mkdirSync } from 'node:fs'

import { expect, test, type Page } from '@playwright/test'

import { ADMIN_PASSWORD } from './accounts'

const SHOTS = new URL('./.tmp/i18n/', import.meta.url).pathname

/** Chooses a language from the menu; the page switches to it in place. */
async function chooseLanguage(page: Page, current: string, name: string, lang: string) {
  // A reload would lose this mark.
  await page.evaluate(() => ((window as unknown as { e2eMark: boolean }).e2eMark = true))
  await page.getByRole('button', { name: current, exact: true }).first().click()
  await page.getByRole('menuitemradio', { name }).click()
  await expect(page.locator('html')).toHaveAttribute('lang', lang)
  expect(await page.evaluate(() => (window as unknown as { e2eMark?: boolean }).e2eMark)).toBe(true)
}

/** Missing keys log "i18n: missing key …" and show as ⟦key⟧. */
function watchMissing(page: Page) {
  const missing: string[] = []
  page.on('console', (m) => {
    if (m.text().includes('i18n: missing key')) missing.push(m.text())
  })
  return missing
}

test('the app speaks Japanese, from the navbar menu and the account', async ({ page, browser }) => {
  mkdirSync(SHOTS, { recursive: true })
  const missing = watchMissing(page)

  // Signed out: the homepage navbar's menu, beside Sign in.
  await page.goto('/')
  await chooseLanguage(page, 'Language', '日本語', 'ja')
  await expect(page.getByRole('link', { name: 'サインイン' }).first()).toBeVisible()
  await page.screenshot({ path: `${SHOTS}ja-home.png`, fullPage: true })
  await page.goto('/sign-in')
  await expect(page.getByRole('heading', { name: 'アカウントにサインイン' })).toBeVisible()
  await page.screenshot({ path: `${SHOTS}ja-sign-in.png` })
  await chooseLanguage(page, '言語', 'English', 'en')

  // Signed in, in English: the app header's menu, beside the account menu,
  // saves the choice on the account.
  await page.getByLabel('Username').fill('admin')
  await page.getByLabel('Password', { exact: true }).fill(ADMIN_PASSWORD)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).toHaveURL(/\/org\/|\/organizations/)
  await page.goto('/organizations')
  await chooseLanguage(page, 'Language', '日本語', 'ja')
  await expect(page.getByRole('heading', { name: '所属している組織' })).toBeVisible()

  // A fresh browser signed in to the same account comes up in Japanese.
  const fresh = await browser.newContext()
  const other = await fresh.newPage()
  await other.goto('/sign-in')
  await other.getByLabel('Username').fill('admin')
  await other.getByLabel('Password', { exact: true }).fill(ADMIN_PASSWORD)
  await other.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(other.locator('html')).toHaveAttribute('lang', 'ja')
  await fresh.close()

  // The main pages, in Japanese, with nothing missing.
  await page.screenshot({ path: `${SHOTS}ja-organizations.png` })
  await page.getByRole('link', { name: /E2E Labs/ }).first().click()
  await expect(page).toHaveURL(/\/org\/[^/]+$/)
  const slug = new URL(page.url()).pathname.split('/')[2]!
  const project = page.getByRole('link').filter({ hasText: 'Dev stack' }).first()
  const ref = (await project.getAttribute('href'))!.split('/')[2]!

  const pages: [string, string][] = [
    ['org-projects', `/org/${slug}`],
    ['org-team', `/org/${slug}/team`],
    ['org-general', `/org/${slug}/general`],
    ['org-integrations', `/org/${slug}/integrations`],
    ['project-overview', `/project/${ref}`],
    ['table-editor', `/project/${ref}/editor`],
    ['sql-editor', `/project/${ref}/sql`],
    ['database-tables', `/project/${ref}/database/tables`],
    ['database-roles', `/project/${ref}/database/roles`],
    ['auth-users', `/project/${ref}/auth/users`],
    ['storage-buckets', `/project/${ref}/storage/buckets`],
    ['functions', `/project/${ref}/functions`],
    ['advisors-security', `/project/${ref}/advisors/security`],
    ['integrations', `/project/${ref}/integrations`],
    ['settings-general', `/project/${ref}/settings/general`],
    ['settings-api-keys', `/project/${ref}/settings/api-keys`],
    ['account-preferences', '/account/me'],
    ['account-security', '/account/security'],
    ['admin-overview', '/admin'],
    ['admin-users', '/admin/users'],
    ['api-endpoints', '/docs/api'],
  ]
  for (const [name, path] of pages) {
    await page.goto(path)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('html')).toHaveAttribute('lang', 'ja')
    await expect(page.locator('body')).not.toContainText('⟦')
    await page.screenshot({ path: `${SHOTS}ja-${name}.png` })
  }

  // The Connect sheet, a long run of sentences with links and code inside.
  await page.goto(`/project/${ref}`)
  await page.getByRole('button', { name: '接続', exact: true }).click()
  await page.getByRole('tab', { name: 'psql で接続' }).click()
  await page.screenshot({ path: `${SHOTS}ja-connect-psql.png` })
  await page.keyboard.press('Escape')

  // The menu, each language with its flag.
  await page.getByRole('button', { name: '言語', exact: true }).first().click()
  await expect(page.getByRole('menuitemradio', { name: 'Deutsch' })).toBeVisible()
  await page.getByRole('menu').evaluate((m) => Promise.all(m.getAnimations({ subtree: true }).map((a) => a.finished)))
  await page.screenshot({ path: `${SHOTS}ja-language-menu.png` })
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toBeHidden()

  expect(missing).toEqual([])

  // Back to English, for the tests after this one, in place: the sidebar
  // and the page switch together, lists kept outside components too.
  await chooseLanguage(page, '言語', 'English', 'en')
  await expect(page.getByRole('link', { name: 'Table Editor' }).first()).toBeVisible()
  await expect(page.getByText('テーブルエディタ')).toHaveCount(0)
})

/*
 * appearance.brand_color is read when Supermixer starts and served as
 * /theme.css: changing it needs a restart, not a rebuild. This starts a
 * second Supermixer from the same code with another colour and checks the
 * page takes it from that server's /theme.css.
 */
import { execFileSync, spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

import { expect, test, type Page } from '@playwright/test'

const OTHER = { hex: '#e5484d', rgb: 'rgb(229, 72, 77)' }
const DEFAULT_RGB = 'rgb(0, 25, 168)' // #0019A8, the default brand colour

const buttonColor = (page: Page) =>
  page.getByRole('button', { name: 'Sign in', exact: true }).evaluate((b) => getComputedStyle(b).backgroundColor)

test('the brand colour comes from the settings, read at start-up', async ({ page }) => {
  await page.goto('/sign-in')
  expect(await buttonColor(page)).toBe(DEFAULT_RGB)

  // The same code, restarted with another brand_color (as a second server
  // on the same database, so the first keeps serving the other tests).
  const base = process.env.SUPERMIXER_E2E_CONFIG!
  const config = base.replace(/\.toml$/, '-brand.toml')
  writeFileSync(
    config,
    readFileSync(base, 'utf8').replace('listen = "127.0.0.1:8091"', 'listen = "127.0.0.1:8092"') +
      `\n[appearance]\nbrand_color = "${OTHER.hex.toUpperCase()}"\n`,
    { mode: 0o600 }
  )
  const bin = base.replace(/\.toml$/, '-supermixer')
  execFileSync('go', ['build', '-o', bin, './cmd/supermixer'], { cwd: '../backend', stdio: 'inherit' })
  const server = spawn(bin, ['--config', config], { stdio: 'ignore' })
  try {
    let css = ''
    await expect(async () => {
      css = await (await fetch('http://127.0.0.1:8092/theme.css')).text()
      expect(css).toContain(`--sm-brand: ${OTHER.hex};`)
    }).toPass({ timeout: 120_000 })

    // The page with that server's /theme.css: the new colour, same build.
    await page.route('**/theme.css', (route) => route.fulfill({ body: css, contentType: 'text/css' }))
    await page.reload()
    expect(await buttonColor(page)).toBe(OTHER.rgb)
  } finally {
    server.kill('SIGTERM')
  }
})

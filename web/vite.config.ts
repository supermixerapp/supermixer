/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { parse } from 'smol-toml'
import { defineConfig, type Plugin } from 'vite'
import svgr from 'vite-plugin-svgr'

// The Go backend serves the API, the generated /theme.css and /favicon.svg.
const backend = process.env.SUPERMIXER_DEV_BACKEND ?? 'http://localhost:8080'

// HTTPS for the dev server, when given a certificate (E2E_TLS=1 make e2e).
// An https:// backend's CA comes from NODE_EXTRA_CA_CERTS.
const https =
  process.env.SUPERMIXER_DEV_HTTPS_CERT && process.env.SUPERMIXER_DEV_HTTPS_KEY
    ? { cert: readFileSync(process.env.SUPERMIXER_DEV_HTTPS_CERT), key: readFileSync(process.env.SUPERMIXER_DEV_HTTPS_KEY) }
    : undefined

/**
 * In production the Go server replaces %SM_DEFAULT_THEME% in index.html with
 * appearance.default_theme. Do the same in dev, reading the repo-root
 * .env.toml (or $SUPERMIXER_CONFIG), with the same environment override.
 */
type DevConfig = { appearance?: { default_theme?: string }; server?: { dev_web_url?: string } }

function devConfig(): DevConfig {
  const path = process.env.SUPERMIXER_CONFIG ?? fileURLToPath(new URL('../.env.toml', import.meta.url))
  try {
    return parse(readFileSync(path, 'utf8')) as DevConfig
  } catch {
    return {}
  }
}

function devDefaultTheme(): string {
  // || : an empty override falls back to the config, as an unset one does.
  return process.env.SUPERMIXER_APPEARANCE_DEFAULT_THEME || devConfig().appearance?.default_theme || 'dark'
}

/**
 * With server.dev_web_url set, the Go server sends pages to that address, so
 * Vite must be exactly there: its port, and no moving to another if it's
 * taken (strictPort), or links would open whatever else is on that port.
 */
function devPort(): { port: number; strictPort: boolean } {
  const fallback = { port: 5173, strictPort: false }
  const value = process.env.SUPERMIXER_SERVER_DEV_WEB_URL || devConfig().server?.dev_web_url
  if (!value) return fallback
  try {
    const url = new URL(value)
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
    return Number.isInteger(port) && port > 0 ? { port, strictPort: true } : fallback
  } catch {
    // The Go server refuses a malformed value with a clear message.
    return fallback
  }
}

function defaultThemePlugin(): Plugin {
  return {
    name: 'supermixer-default-theme',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replaceAll('%SM_DEFAULT_THEME%', devDefaultTheme())
    },
  }
}

export default defineConfig({
  plugins: [
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
    tailwindcss(),
    svgr(),
    defaultThemePlugin(),
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    ...devPort(),
    https,
    proxy: {
      // ws: the Realtime Inspector's socket goes through the gateway too.
      '/api': { target: backend, ws: true },
      // The Supabase-style Management API (personal access tokens).
      '/v1': backend,
      '/theme.css': backend,
      '/favicon.svg': backend,
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    // e2e/ is Playwright's (make e2e), not Vitest's.
    exclude: ['**/node_modules/**', 'e2e/**'],
  },
})

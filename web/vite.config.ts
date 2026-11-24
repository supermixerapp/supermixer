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

/**
 * In production the Go server replaces %SM_DEFAULT_THEME% in index.html with
 * appearance.default_theme. Do the same in dev, reading the repo-root
 * .env.toml (or $SUPERMIXER_CONFIG), with the same environment override.
 */
function devDefaultTheme(): string {
  const override = process.env.SUPERMIXER_APPEARANCE_DEFAULT_THEME
  if (override) return override
  const path = process.env.SUPERMIXER_CONFIG ?? fileURLToPath(new URL('../.env.toml', import.meta.url))
  try {
    const cfg = parse(readFileSync(path, 'utf8')) as { appearance?: { default_theme?: string } }
    return cfg.appearance?.default_theme ?? 'dark'
  } catch {
    return 'dark'
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
    port: 5173,
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
  },
})

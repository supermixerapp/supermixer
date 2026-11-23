/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import svgr from 'vite-plugin-svgr'

// The Go backend serves the API, the generated /theme.css and /favicon.svg.
const backend = process.env.SUPERMIXER_DEV_BACKEND ?? 'http://localhost:8080'

/**
 * In production the Go server replaces %SM_DEFAULT_THEME% in index.html with
 * SUPERMIXER_DEFAULT_THEME. Do the same in dev, reading the repo-root .env.
 */
function defaultThemePlugin(): Plugin {
  return {
    name: 'supermixer-default-theme',
    apply: 'serve',
    transformIndexHtml(html) {
      const env = loadEnv('development', fileURLToPath(new URL('..', import.meta.url)), 'SUPERMIXER_')
      return html.replaceAll('%SM_DEFAULT_THEME%', env.SUPERMIXER_DEFAULT_THEME || 'dark')
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
      '/api': backend,
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

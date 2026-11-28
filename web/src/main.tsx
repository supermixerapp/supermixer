/*
 * The entry point: the language's text loads first, then the app, so that
 * everything is in one language from the first paint (see lib/i18n).
 */
import './styles/globals.css'

import i18next from 'i18next'

import { initI18n, t } from '@/lib/i18n'

void initI18n()
  .then(async () => {
    const { start } = await import('./app')
    start()
  })
  .catch((e: unknown) => {
    // Most often a tab left open across an upgrade, asking for files that
    // are gone: say so rather than leave the page blank.
    console.error('starting the app', e)
    showLoadError()
  })

function showLoadError() {
  const root = document.getElementById('root')
  if (!root) return
  const english = !i18next.isInitialized
  const box = document.createElement('div')
  box.className = 'flex min-h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-foreground-light'
  const text = document.createElement('p')
  text.textContent = english ? "Supermixer couldn't load. Reload the page to try again." : t('common:startup.couldNotLoad')
  const reload = document.createElement('button')
  reload.type = 'button'
  reload.className = 'raised-control-surface h-[26px] rounded-md px-2.5 text-xs text-foreground focus-ring'
  reload.textContent = english ? 'Reload' : t('common:startup.reload')
  reload.addEventListener('click', () => window.location.reload())
  box.append(text, reload)
  root.replaceChildren(box)
}

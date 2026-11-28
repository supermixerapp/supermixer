/*
 * The entry point: the language's text loads first, then the app, so that
 * everything is in one language from the first paint (see lib/i18n).
 */
import './styles/globals.css'

import { initI18n } from '@/lib/i18n'

void initI18n().then(async () => {
  const { start } = await import('./app')
  start()
})

/*
 * The web app's languages (i18next). Every word the app shows comes from
 * src/locales/<language>/<namespace>.json; English is the source, and the
 * others must have exactly the same keys (locales.test.ts checks).
 *
 * The language is chosen before the app's code loads (main.tsx), so the
 * first paint is in it. Changing it later loads the new text and draws the
 * app again (switchLanguage, routes/__root.tsx); nothing is translated when a
 * module loads, so nothing stays behind (localized). The choice is kept in
 * the browser, and on the account when signed in (LanguageSync); without
 * one, the browser's preferred languages decide, then English.
 */
import i18next, { type Resource } from 'i18next'
import { initReactI18next } from 'react-i18next'

export const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'ja', name: '日本語' },
  { code: 'fr', name: 'Français' },
  { code: 'es', name: 'Español' },
  { code: 'de', name: 'Deutsch' },
] as const

export type Language = (typeof LANGUAGES)[number]['code']

export const STORAGE_KEY = 'supermixer.language'

export const isLanguage = (v: unknown): v is Language => LANGUAGES.some((l) => l.code === v)

type Catalog = { default: Record<string, unknown> }

// English is part of the app; the others load when chosen.
const english = import.meta.glob<Catalog>('../../locales/en/*.json', { eager: true })
const others = import.meta.glob<Catalog>(['../../locales/*/*.json', '!../../locales/en/*.json'])

const namespaceOf = (path: string) => path.slice(path.lastIndexOf('/') + 1, -'.json'.length)

function bundle(modules: Record<string, Catalog>) {
  const out: Record<string, Record<string, unknown>> = {}
  for (const [path, mod] of Object.entries(modules)) out[namespaceOf(path)] = mod.default
  return out
}

export const NAMESPACES = Object.keys(bundle(english))

async function load(lng: Language) {
  const prefix = `../../locales/${lng}/`
  const entries = await Promise.all(
    Object.entries(others)
      .filter(([path]) => path.startsWith(prefix))
      .map(async ([path, load]) => [path, await load()] as const)
  )
  return bundle(Object.fromEntries(entries))
}

/** The language this browser keeps, if one was chosen here. */
export function storedLanguage(): Language | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    return isLanguage(v) ? v : null
  } catch {
    return null
  }
}

/** The first of the browser's preferred languages the app has, else English. */
export function browserLanguage(): Language {
  const preferred = typeof navigator === 'undefined' ? [] : (navigator.languages ?? [navigator.language])
  for (const tag of preferred) {
    const code = tag.toLowerCase().split('-')[0]
    if (isLanguage(code)) return code
  }
  return 'en'
}

/** A key with no text: loud in development and tests, quiet in production. */
function missing(key: string) {
  if (import.meta.env.DEV || import.meta.env.MODE === 'test') {
    console.error(`i18n: missing key ${key}`)
    return `⟦${key}⟧`
  }
  return key
}

/**
 * Sets up i18next in lng (the stored or browser language by default),
 * loading its catalogs first. Call it before rendering anything.
 */
export async function initI18n(lng: Language = storedLanguage() ?? browserLanguage()) {
  const resources: Resource = { en: bundle(english) }
  if (lng !== 'en') {
    try {
      resources[lng] = await load(lng)
    } catch {
      lng = 'en' // a chunk that didn't load: English rather than nothing
    }
  }
  await i18next.use(initReactI18next).init({
    lng,
    fallbackLng: 'en',
    supportedLngs: LANGUAGES.map((l) => l.code),
    resources,
    ns: NAMESPACES,
    defaultNS: 'common',
    // React escapes; i18next mustn't do it again.
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
    parseMissingKeyHandler: missing,
  })
  if (typeof document !== 'undefined') document.documentElement.lang = lng
  return i18next
}

// Set while inEnglish() runs.
let forced: Language | null = null

/** Translates a key: t('common:actions.save'), t('team.invite', { name }). */
const translate = i18next.t.bind(i18next) as unknown as (key: string | string[], options?: Record<string, unknown>) => string
export const t = ((key: string | string[], options?: Record<string, unknown>) =>
  translate(key, forced ? { ...options, lng: forced } : options)) as unknown as typeof i18next.t

/**
 * Runs make with t(), language() and localized() lists in English, for
 * output that must not change with the reader's language, such as the
 * column names and values of a CSV export.
 */
export function inEnglish<T>(make: () => T): T {
  const was = forced
  forced = 'en'
  try {
    return make()
  } finally {
    forced = was
  }
}

/**
 * Text worked out once per language, for lists and tables kept outside
 * components: `const ROLES = localized(() => [{ label: t('…') }])`, then
 * ROLES() where it's used. The value is made again after a switch, and
 * stays the same object until then. Never call t() when a module loads:
 * that text would stay in the first language (lazy-t.test.ts checks).
 */
export function localized<T>(make: () => T): () => T {
  let made: { lng: string; value: T } | undefined
  return () => {
    const lng = forced ?? i18next.language
    if (made?.lng !== lng) made = { lng, value: make() }
    return made.value
  }
}

/** The app's language now. */
export function language(): Language {
  if (forced) return forced
  return isLanguage(i18next.language) ? i18next.language : 'en'
}

/** Loads lng's text, if it isn't yet. */
async function ensureLoaded(lng: Language) {
  if (lng === 'en' || i18next.hasResourceBundle(lng, 'common')) return
  for (const [ns, resources] of Object.entries(await load(lng))) i18next.addResourceBundle(lng, ns, resources, true, true)
}

/**
 * Switches to lng in place: its text loads, then the app draws again in it
 * (routes/__root.tsx), and this browser keeps the choice. If the text
 * doesn't load, this throws and nothing changes. Saving it on the account
 * (signed in) is the caller's, after this succeeds.
 */
export async function switchLanguage(lng: Language) {
  if (lng !== language()) {
    await ensureLoaded(lng)
    await i18next.changeLanguage(lng)
    document.documentElement.lang = lng
  }
  keepLanguage(lng)
}

/** Draws again when the language changes (routes/__root.tsx). */
export function onLanguageChange(listener: () => void) {
  i18next.on('languageChanged', listener)
  return () => i18next.off('languageChanged', listener)
}

/** Keeps lng in this browser. */
function keepLanguage(lng: Language) {
  try {
    localStorage.setItem(STORAGE_KEY, lng)
  } catch {
    // storage unavailable: the browser's language applies next time
  }
}

/**
 * A language chosen from the menu while signed out, waiting to be saved to
 * the next account that signs in without one of its own. Kept apart from
 * the language this browser shows, which may have come from an account and
 * mustn't pass to the next person who signs in here.
 */
const CHOSEN_KEY = 'supermixer.language-chosen-signed-out'

export function rememberChosenSignedOut(lng: Language) {
  try {
    localStorage.setItem(CHOSEN_KEY, lng)
  } catch {
    // ignore
  }
}

/** The language chosen while signed out, if any; it's forgotten either way. */
export function takeChosenSignedOut(): Language | null {
  try {
    const v = localStorage.getItem(CHOSEN_KEY)
    localStorage.removeItem(CHOSEN_KEY)
    return isLanguage(v) ? v : null
  } catch {
    return null
  }
}

export default i18next
export { Trans } from './trans'

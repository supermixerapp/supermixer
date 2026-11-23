/*
 * The theme. A signed-in user's choice is saved on their account (Account ›
 * Appearance); ThemeSync adopts it when the profile loads and saves new
 * choices. The browser keeps a copy so index.html can paint the right theme
 * before anything loads. With no choice, the instance default applies
 * (appearance.default_theme), and failing that, light.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'

export type ThemePreference = 'dark' | 'light' | 'system'
export type ResolvedTheme = 'dark' | 'light'

const STORAGE_KEY = 'supermixer.theme'
export const FALLBACK_THEME: ThemePreference = 'light'

const isPreference = (v: unknown): v is ThemePreference => v === 'dark' || v === 'light' || v === 'system'

/** The instance default, from the meta tag the server fills in. */
export function defaultPreference(): ThemePreference {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="sm-default-theme"]')
  return isPreference(meta?.content) ? meta.content : FALLBACK_THEME
}

/** Same resolution order as the inline script in index.html. */
export function readPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (isPreference(stored)) return stored
  } catch {
    // storage unavailable (private mode); fall through
  }
  return defaultPreference()
}

function cache(p: ThemePreference | null) {
  try {
    if (p) localStorage.setItem(STORAGE_KEY, p)
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    // ignore; the theme still applies for this page
  }
}

const systemTheme = (): ResolvedTheme => (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')

function apply(theme: ResolvedTheme) {
  const root = document.documentElement
  root.setAttribute('data-theme', theme)
  root.style.colorScheme = theme
}

type Save = (p: ThemePreference) => void

interface ThemeContextValue {
  preference: ThemePreference
  resolved: ResolvedTheme
  /** The user picked a theme: apply it, and save it to their account. */
  setPreference: (p: ThemePreference) => void
  /** The account's saved choice arrived (null: none, so the default applies). */
  adopt: (p: ThemePreference | null) => void
  /** Signed out: drop this browser's copy, back to the default. */
  forget: () => void
  /** ThemeSync registers how to save a choice to the account. */
  registerSave: (save: Save | null) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPref] = useState<ThemePreference>(readPreference)
  const [system, setSystem] = useState<ResolvedTheme>(systemTheme)
  const save = useRef<Save | null>(null)
  const resolved = preference === 'system' ? system : preference

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const onChange = () => setSystem(mq.matches ? 'light' : 'dark')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  useEffect(() => apply(resolved), [resolved])

  const setPreference = useCallback((p: ThemePreference) => {
    cache(p)
    setPref(p)
    save.current?.(p)
  }, [])

  const adopt = useCallback((p: ThemePreference | null) => {
    cache(p)
    setPref(p ?? defaultPreference())
  }, [])

  const forget = useCallback(() => adopt(null), [adopt])

  const registerSave = useCallback((s: Save | null) => {
    save.current = s
  }, [])

  return (
    <ThemeContext.Provider value={{ preference, resolved, setPreference, adopt, forget, registerSave }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used inside ThemeProvider')
  return ctx
}

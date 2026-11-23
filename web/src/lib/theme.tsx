import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'

export type ThemePreference = 'dark' | 'light' | 'system'
export type ResolvedTheme = 'dark' | 'light'

const STORAGE_KEY = 'supermixer.theme'
const isPreference = (v: unknown): v is ThemePreference =>
  v === 'dark' || v === 'light' || v === 'system'

/** Same resolution order as the inline script in index.html. */
export function readPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (isPreference(stored)) return stored
  } catch {
    // storage unavailable (private mode); fall through
  }
  const meta = document.querySelector<HTMLMetaElement>('meta[name="sm-default-theme"]')
  return isPreference(meta?.content) ? meta.content : 'dark'
}

const systemTheme = (): ResolvedTheme =>
  window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'

function apply(theme: ResolvedTheme) {
  const root = document.documentElement
  root.setAttribute('data-theme', theme)
  root.style.colorScheme = theme
}

interface ThemeContextValue {
  preference: ThemePreference
  resolved: ResolvedTheme
  setPreference: (p: ThemePreference) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPref] = useState<ThemePreference>(readPreference)
  const [system, setSystem] = useState<ResolvedTheme>(systemTheme)
  const resolved = preference === 'system' ? system : preference

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const onChange = () => setSystem(mq.matches ? 'light' : 'dark')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  useEffect(() => apply(resolved), [resolved])

  const setPreference = useCallback((p: ThemePreference) => {
    try {
      localStorage.setItem(STORAGE_KEY, p)
    } catch {
      // ignore; the choice still applies for this session
    }
    setPref(p)
  }, [])

  return (
    <ThemeContext.Provider value={{ preference, resolved, setPreference }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used inside ThemeProvider')
  return ctx
}

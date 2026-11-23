import { useCallback, useState } from 'react'

/** useState persisted to localStorage; tolerates storage being unavailable. */
export function useLocalStorage<T extends string>(key: string, fallback: T, allowed: readonly T[]) {
  const [value, setValue] = useState<T>(() => {
    try {
      const v = localStorage.getItem(key)
      return v !== null && (allowed as readonly string[]).includes(v) ? (v as T) : fallback
    } catch {
      return fallback
    }
  })
  const set = useCallback(
    (next: T) => {
      try {
        localStorage.setItem(key, next)
      } catch {
        // ignore
      }
      setValue(next)
    },
    [key]
  )
  return [value, set] as const
}

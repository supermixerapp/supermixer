/*
 * Pages with work that isn't saved yet. Switching language draws every page
 * again from scratch, which would lose it, so the language menu asks first
 * while any page here has some.
 */
import { useEffect } from 'react'

const unsaved = new Set<symbol>()

/** Marks this page as having unsaved work while dirty is true. */
export function useUnsavedChanges(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return
    const page = Symbol()
    unsaved.add(page)
    return () => {
      unsaved.delete(page)
    }
  }, [dirty])
}

export const hasUnsavedChanges = () => unsaved.size > 0

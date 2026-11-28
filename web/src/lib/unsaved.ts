/*
 * Pages with work that isn't saved yet. Switching language draws every page
 * again from scratch, which would lose it, so the language menu asks first
 * while any page here has some.
 */
import { useEffect } from 'react'

import { language } from '@/lib/i18n'

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

/**
 * Runs forget when the page is left, but not when it's only drawn again
 * for a new language; for state kept outside a component so that a switch
 * doesn't lose it. forget must be the same function every time.
 */
export function useForgetOnLeave(forget: () => void) {
  useEffect(() => {
    const drawnIn = language()
    return () => {
      if (language() === drawnIn) forget()
    }
  }, [forget])
}

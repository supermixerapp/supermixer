import i18next from 'i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { inEnglish, language, localized, rememberChosenSignedOut, STORAGE_KEY, switchLanguage, t, takeChosenSignedOut } from '.'

afterEach(async () => {
  vi.restoreAllMocks()
  await switchLanguage('en')
  localStorage.clear()
})

describe('switching language in place', () => {
  it('changes the text, <html lang> and the kept choice', async () => {
    await switchLanguage('ja')
    expect(language()).toBe('ja')
    expect(t('common:language.label')).toBe('言語')
    expect(document.documentElement.lang).toBe('ja')
    expect(localStorage.getItem(STORAGE_KEY)).toBe('ja')
  })

  it('keeps nothing when the language fails to load', async () => {
    vi.spyOn(i18next, 'changeLanguage').mockRejectedValueOnce(new Error('offline'))
    await expect(switchLanguage('de')).rejects.toThrow('offline')
    expect(language()).toBe('en')
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('rebuilds localized lists once per language', async () => {
    const make = vi.fn(() => ({ label: t('common:language.label') }))
    const list = localized(make)
    expect(list()).toBe(list())
    expect(list().label).toBe('Language')
    await switchLanguage('fr')
    expect(list().label).toBe('Langue')
    expect(make).toHaveBeenCalledTimes(2)
  })

  it('writes English inside inEnglish, whatever the language', async () => {
    await switchLanguage('ja')
    const list = localized(() => t('common:language.label'))
    expect(inEnglish(() => [t('common:language.label'), list(), language()])).toEqual(['Language', 'Language', 'en'])
    expect(list()).toBe('言語')
    expect(language()).toBe('ja')
  })
})

describe('a choice made while signed out', () => {
  it('is handed over once, then forgotten', () => {
    expect(takeChosenSignedOut()).toBeNull()
    rememberChosenSignedOut('es')
    expect(takeChosenSignedOut()).toBe('es')
    expect(takeChosenSignedOut()).toBeNull()
  })

  it("isn't the language an account set in this browser", async () => {
    await switchLanguage('de') // as when an account's language is taken up
    expect(takeChosenSignedOut()).toBeNull()
  })
})

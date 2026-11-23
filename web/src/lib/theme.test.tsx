import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ThemeProvider, useTheme } from './theme'

function Probe({ save }: { save?: (p: string) => void }) {
  const { preference, resolved, setPreference, adopt, forget, registerSave } = useTheme()
  return (
    <div>
      <span data-testid="pref">{preference}</span>
      <span data-testid="resolved">{resolved}</span>
      <button onClick={() => setPreference('light')}>choose light</button>
      <button onClick={() => setPreference('dark')}>choose dark</button>
      <button onClick={() => adopt('dark')}>adopt dark</button>
      <button onClick={() => adopt(null)}>adopt none</button>
      <button onClick={() => forget()}>forget</button>
      <button onClick={() => registerSave(save ?? null)}>register</button>
    </div>
  )
}

describe('ThemeProvider', () => {
  beforeEach(() => {
    localStorage.clear()
    document.head.innerHTML = ''
    document.documentElement.removeAttribute('data-theme')
  })

  it('uses the server default from the meta tag when nothing is stored', () => {
    document.head.innerHTML = '<meta name="sm-default-theme" content="light">'
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>
    )
    expect(screen.getByTestId('pref')).toHaveTextContent('light')
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
  })

  it('ignores an unreplaced placeholder and falls back to light', () => {
    document.head.innerHTML = '<meta name="sm-default-theme" content="%SM_DEFAULT_THEME%">'
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>
    )
    expect(screen.getByTestId('pref')).toHaveTextContent('light')
  })

  it('persists the chosen theme and applies it to <html>', () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>
    )
    act(() => screen.getByText('choose dark').click())
    expect(localStorage.getItem('supermixer.theme')).toBe('dark')
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
  })

  it('resolves "system" using prefers-color-scheme (dark in jsdom)', () => {
    localStorage.setItem('supermixer.theme', 'system')
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>
    )
    expect(screen.getByTestId('pref')).toHaveTextContent('system')
    expect(screen.getByTestId('resolved')).toHaveTextContent('dark')
  })

  it("adopts the account's choice, and the default when there is none", () => {
    document.head.innerHTML = '<meta name="sm-default-theme" content="light">'
    localStorage.setItem('supermixer.theme', 'system') // another user's, or an old copy
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>
    )
    act(() => screen.getByText('adopt dark').click())
    expect(screen.getByTestId('pref')).toHaveTextContent('dark')
    expect(localStorage.getItem('supermixer.theme')).toBe('dark')
    act(() => screen.getByText('adopt none').click())
    expect(screen.getByTestId('pref')).toHaveTextContent('light')
    expect(localStorage.getItem('supermixer.theme')).toBeNull()
  })

  it('saves choices to the account, but not adopted ones', () => {
    const save = vi.fn()
    render(
      <ThemeProvider>
        <Probe save={save} />
      </ThemeProvider>
    )
    act(() => screen.getByText('register').click())
    act(() => screen.getByText('choose dark').click())
    act(() => screen.getByText('adopt dark').click())
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith('dark')
  })

  it('forgets the choice on sign-out', () => {
    document.head.innerHTML = '<meta name="sm-default-theme" content="light">'
    localStorage.setItem('supermixer.theme', 'dark')
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>
    )
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    act(() => screen.getByText('forget').click())
    expect(localStorage.getItem('supermixer.theme')).toBeNull()
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
  })
})

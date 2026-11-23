import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { ThemeProvider, useTheme } from './theme'

function Probe() {
  const { preference, resolved, setPreference } = useTheme()
  return (
    <div>
      <span data-testid="pref">{preference}</span>
      <span data-testid="resolved">{resolved}</span>
      <button onClick={() => setPreference('light')}>light</button>
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

  it('ignores an unreplaced placeholder and falls back to dark', () => {
    document.head.innerHTML = '<meta name="sm-default-theme" content="%SM_DEFAULT_THEME%">'
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>
    )
    expect(screen.getByTestId('pref')).toHaveTextContent('dark')
  })

  it('persists the chosen theme and applies it to <html>', () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>
    )
    act(() => screen.getByText('light').click())
    expect(localStorage.getItem('supermixer.theme')).toBe('light')
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
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
})

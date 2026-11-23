import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { AppIcon, HomeIcon } from './icons'

describe('two-tone icons', () => {
  it('renders decorative icons hidden from assistive tech, coloured by currentColor', () => {
    const { container } = render(<HomeIcon />)
    const svg = container.querySelector('svg')!
    expect(svg).toHaveAttribute('aria-hidden', 'true')
    expect(svg).toHaveAttribute('fill', 'currentColor')
    expect(svg).toHaveAttribute('width', '20')
    // Two-tone: a second path at 30% opacity.
    expect(Number(svg.querySelector('path[opacity]')?.getAttribute('opacity'))).toBeCloseTo(0.3)
  })

  it('exposes a label as an accessible image', () => {
    const { getByRole } = render(<HomeIcon label="Home" size={16} />)
    const svg = getByRole('img', { name: 'Home' })
    expect(svg).toHaveAttribute('width', '16')
  })

  it('ships the Graphic Eq app icon from the local SVG', () => {
    const { container } = render(<AppIcon />)
    expect(container.querySelector('svg')).toHaveAttribute('data-icon', 'graphic_eq')
    expect(container.querySelector('path')?.getAttribute('d')).toMatch(/^M7 18h2V6H7v12z/)
  })
})

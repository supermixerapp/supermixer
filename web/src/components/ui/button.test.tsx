import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { Button } from './button'

describe('Button', () => {
  it('defaults to the tiny size and default variant', () => {
    render(<Button>Save</Button>)
    const btn = screen.getByRole('button', { name: 'Save' })
    expect(btn).toHaveAttribute('data-size', 'tiny')
    expect(btn.className).toContain('h-[26px]')
    expect(btn.className).toContain('raised-control-surface')
  })

  it('uses the brand fill for primary buttons', () => {
    render(<Button variant="primary">Create</Button>)
    expect(screen.getByRole('button').className).toContain('bg-primary-solid')
  })

  it('is disabled and ignores clicks while loading', async () => {
    const onClick = vi.fn()
    render(
      <Button loading onClick={onClick}>
        Saving
      </Button>
    )
    const btn = screen.getByRole('button')
    expect(btn).toBeDisabled()
    await userEvent.click(btn)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('renders as its child element with asChild', () => {
    render(
      <Button asChild variant="link">
        <a href="/docs">Docs</a>
      </Button>
    )
    const link = screen.getByRole('link', { name: 'Docs' })
    expect(link).toHaveAttribute('href', '/docs')
    expect(link.className).toContain('text-primary')
  })
})

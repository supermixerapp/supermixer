import { describe, expect, it } from 'vitest'

import { passwordRule } from './passwords'

describe('passwordRule', () => {
  it('asks for 15 characters without two-factor sign-in, 8 with it', () => {
    expect(passwordRule(false).min).toBe(15)
    expect(passwordRule(true).min).toBe(8)
    expect(passwordRule(undefined).hint).toContain('15 characters, or 8 if two-factor sign-in is on')
    expect(passwordRule(false, 'their').hint).toContain('their username')
  })
})

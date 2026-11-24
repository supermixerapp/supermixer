import { describe, expect, it } from 'vitest'

import { safeRedirect } from './redirect'

describe('safeRedirect', () => {
  it('keeps same-origin paths', () => {
    expect(safeRedirect('/org/acme/team?x=1')).toBe('/org/acme/team?x=1')
  })
  it.each([undefined, 'https://evil.test', '//evil.test', '/\\evil.test', 'javascript:alert(1)'])(
    'rejects %s',
    (target) => {
      expect(safeRedirect(target)).toBe('/dashboard')
    }
  )
})

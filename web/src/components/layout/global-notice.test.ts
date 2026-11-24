import { describe, expect, it } from 'vitest'

import { noticeLength, noticeTypeOf, normalizeNotice } from './global-notice'

describe('global notice', () => {
  it('counts characters as the server does: one line, code points', () => {
    expect(noticeLength('  Down tonight,\n\n22:00 UTC  ')).toBe('Down tonight, 22:00 UTC'.length)
    expect(noticeLength('🚧 works')).toBe(7)
    expect(noticeLength('')).toBe(0)
    // Spaces as Go's strings.Fields sees them: U+FEFF isn't one, U+3000 is.
    expect(normalizeNotice('a\uFEFFb \u3000 c')).toBe('a\uFEFFb c')
    expect(noticeLength('a\uFEFFb')).toBe(3)
  })

  it('knows each type', () => {
    expect(noticeTypeOf('critical').label).toBe('Critical')
    expect(noticeTypeOf('warning').label).toBe('Warning')
  })
})

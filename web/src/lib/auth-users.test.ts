import { describe, expect, it } from 'vitest'

import { containsPattern, isBanned, relativeTime, usersSql } from './auth-users'

describe('users list SQL', () => {
  it('escapes LIKE wildcards in searches', () => {
    expect(containsPattern('a_b%c\\d')).toBe('%a\\_b\\%c\\\\d%')
  })

  it('only ever uses its fixed filters and sorts', () => {
    const sql = usersSql('unverified', 'last_sign_in_at', true)
    expect(sql).toContain('u.email_confirmed_at is null and u.phone_confirmed_at is null')
    expect(sql).toContain('order by u.last_sign_in_at desc nulls last, u.id')
    expect(sql).not.toMatch(/encrypted_password|_token/)
    expect(sql).toContain('u.id::text = lower($1)')
  })
})

describe('user helpers', () => {
  it('knows when a ban has run out', () => {
    expect(isBanned({ banned_until: new Date(Date.now() + 60_000).toISOString() })).toBe(true)
    expect(isBanned({ banned_until: new Date(Date.now() - 60_000).toISOString() })).toBe(false)
    expect(isBanned({})).toBe(false)
  })

  it('formats times relative to now', () => {
    const now = Date.parse('2026-11-23T12:00:00Z')
    expect(relativeTime('2026-11-23T11:57:00Z', now, 'en')).toBe('3 minutes ago')
    expect(relativeTime('2026-11-25T12:00:00Z', now, 'en')).toBe('in 2 days')
    expect(relativeTime(null, now)).toBe('—')
  })
})

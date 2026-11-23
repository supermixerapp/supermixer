import { describe, expect, it } from 'vitest'

import {
  alterRole,
  createRole,
  dateToExpiry,
  emptyRole,
  expiryToDate,
  parseConnectionLimit,
  roleNameProblem,
  saslPrep,
  scramVerifier,
} from './roles'

describe('role SQL', () => {
  it('creates a role mentioning only what differs from Postgres defaults', () => {
    expect(createRole({ ...emptyRole(), name: 'reporting', connectionLimit: 5 }, 'SCRAM-SHA-256$4096:abc$def:ghi')).toBe(
      `create role "reporting" with login connection limit 5 password 'SCRAM-SHA-256$4096:abc$def:ghi';`
    )
    expect(createRole({ ...emptyRole(), name: 'group', login: false }, null)).toBe('create role "group";')
  })

  it('alters only what changed, so replication and bypassrls are never mentioned needlessly', () => {
    const original = { ...emptyRole(), name: 'old', validUntil: '2027-01-01T23:00:00+00:00' }
    expect(alterRole(original, { ...original, connectionLimit: 3 }, null)).toBe('alter role "old" with connection limit 3;')
    expect(alterRole(original, { ...original, name: 'new', login: false }, null)).toBe(
      'alter role "old" rename to "new";\nalter role "new" with nologin;'
    )
    expect(alterRole(original, { ...original, validUntil: '' }, null)).toBe(`alter role "old" with valid until 'infinity';`)
    expect(alterRole(original, original, null)).toBe('')
  })

  it('checks role names', () => {
    expect(roleNameProblem('etl-loader')).toBeNull()
    expect(roleNameProblem('pg_reader')).toMatch(/reserved/)
    expect(roleNameProblem('')).toMatch(/Enter/)
    expect(roleNameProblem('x'.repeat(64))).toMatch(/63/)
  })
})

describe('form values', () => {
  it('treats a blank or partial connection limit as no limit, never 0', () => {
    expect(parseConnectionLimit('')).toBe(-1)
    expect(parseConnectionLimit('-')).toBe(-1)
    expect(parseConnectionLimit('-1')).toBe(-1)
    expect(parseConnectionLimit('0')).toBe(0)
    expect(parseConnectionLimit('12')).toBe(12)
  })

  it('makes a picked expiry date last to the end of that day', () => {
    const expiry = dateToExpiry('2027-01-01')
    expect(new Date(expiry).getHours()).toBe(23)
    expect(expiryToDate(expiry)).toBe('2027-01-01')
    expect(dateToExpiry('')).toBe('')
  })
})

describe('scramVerifier', () => {
  it('has the format Postgres stores, and is deterministic for a given salt', async () => {
    const salt = new Uint8Array(16).fill(7)
    const a = await scramVerifier('correct horse', salt)
    expect(a).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{44}:[A-Za-z0-9+/=]{44}$/)
    expect(await scramVerifier('correct horse', salt)).toBe(a)
    expect(await scramVerifier('correct horsE', salt)).not.toBe(a)
  })

  it('uses a fresh salt by default', async () => {
    expect(await scramVerifier('x')).not.toBe(await scramVerifier('x'))
  })

  it('applies SASLprep like libpq', async () => {
    expect(saslPrep('\uFF50\uFF41\uFF53\uFF53\uFF11')).toBe('pass1')
    expect(saslPrep('a\u00A0b\u00ADc')).toBe('a bc')
    expect(saslPrep('plain ascii')).toBe('plain ascii')
    const salt = new Uint8Array(16).fill(1)
    expect(await scramVerifier('\uFF50\uFF41\uFF53\uFF53\uFF11', salt)).toBe(await scramVerifier('pass1', salt))
  })
})

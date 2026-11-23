import { describe, expect, it } from 'vitest'

import { emptyConnection, parseSupabaseEnv, toConnectionPayload } from './connection-form'

describe('parseSupabaseEnv', () => {
  it('maps a self-hosted docker/.env onto the connection form', () => {
    const v = parseSupabaseEnv(`
# comment
SUPABASE_PUBLIC_URL=http://db.example.internal:8000
ANON_KEY=anon.jwt
SERVICE_ROLE_KEY="service.jwt"
JWT_SECRET='super-secret'
POSTGRES_PASSWORD=pw
POSTGRES_DB=postgres
POSTGRES_PORT=5432
POOLER_TENANT_ID=acme
`)
    expect(v).toMatchObject({
      api_url: 'http://db.example.internal:8000',
      host: 'db.example.internal',
      anon: 'anon.jwt',
      service_role: 'service.jwt',
      jwt_secret: 'super-secret',
      password: 'pw',
      port: '5432',
      user: 'postgres.acme',
    })
  })

  it('ignores unrelated text', () => {
    expect(parseSupabaseEnv('hello world\nFOO=bar')).toEqual({})
  })
})

describe('toConnectionPayload', () => {
  it('omits blank keys so updates keep stored secrets', () => {
    const p = toConnectionPayload({ ...emptyConnection, api_url: ' http://x ', user: 'u', anon: 'a' })
    expect(p.api_url).toBe('http://x')
    expect(p.keys).toEqual({ anon: 'a', service_role: undefined, publishable: undefined, secret: undefined, jwt_secret: undefined })
    expect(p.database.password).toBeUndefined()
    expect(p.database.port).toBe(5432)
  })
})

import { describe, expect, it } from 'vitest'

import {
  WRAPPER_TYPES,
  columnProblem,
  createWrapperSql,
  displayOptions,
  draftProblems,
  draftSecrets,
  dropWrapperSql,
  parseOptions,
  tableFromTemplate,
  typeOf,
  versionAtLeast,
  type WrapperDraft,
} from './wrappers'

const stripe = WRAPPER_TYPES.find((t) => t.name === 'stripe_wrapper')!
const SECRET = 'sk_test_do_not_leak'
const ID = '0b9c3c1e-4d7f-4f43-9d5a-1f0a2b3c4d5e'

const draft = (over: Partial<WrapperDraft> = {}): WrapperDraft => ({
  type: stripe,
  server: 'stripe_server',
  values: { api_key_id: SECRET },
  mode: 'tables',
  tables: [tableFromTemplate(stripe, 0)],
  targetSchema: '',
  sourceSchema: 'stripe',
  ...over,
})

describe('wrapper types', () => {
  it("come from Studio's definitions, without custom-form ones", () => {
    expect(WRAPPER_TYPES.length).toBeGreaterThan(10)
    expect(WRAPPER_TYPES.some((t) => t.name === 'iceberg_wrapper')).toBe(false)
    // Nothing to create: no table templates and no schema to import.
    expect(WRAPPER_TYPES.some((t) => t.name === 's3_vectors_wrapper')).toBe(false)
    expect(WRAPPER_TYPES.every((t) => t.tables.length > 0 || t.sourceSchemaOption)).toBe(true)
    expect(stripe.server.options.find((o) => o.name === 'api_key_id')?.encrypted).toBe(true)
  })

  it('compare extension versions', () => {
    expect(versionAtLeast('0.6.1', '0.4.0')).toBe(true)
    expect(versionAtLeast('0.3.9', '0.4.0')).toBe(false)
    expect(versionAtLeast('0.10.0', '0.9.9')).toBe(true)
    expect(versionAtLeast(null, '0.1.0')).toBe(false)
    expect(versionAtLeast(null, undefined)).toBe(true)
  })

  it('recognise servers by wrapper name, Wasm package or handler', () => {
    expect(typeOf({ fdw: 'stripe_wrapper', handler: 'stripe_fdw_handler', options: [] })?.label).toBe('Stripe')
    expect(typeOf({ fdw: 'my_fdw', handler: 'stripe_fdw_handler', options: [] })?.label).toBe('Stripe')
    expect(typeOf({ fdw: 'x', handler: 'wasm_fdw_handler', options: ['fdw_package_name=supabase:paddle-fdw'] })?.label).toBe('Paddle')
    expect(typeOf({ fdw: 'x', handler: 'wasm_fdw_handler', options: [] })).toBeUndefined()
  })
})

describe('creating a wrapper', () => {
  it('keeps secret values out of the SQL, using their Vault ids', () => {
    const d = draft()
    expect(draftSecrets(d)).toEqual([{ name: 'stripe_server_api_key_id', value: SECRET, option: 'api_key_id' }])
    const sql = createWrapperSql(d, { api_key_id: ID })
    expect(sql).not.toContain(SECRET)
    expect(sql).toContain(`"api_key_id" '${ID}'`)
    expect(sql).toContain("execute format('create foreign data wrapper %I handler %I validator %I', 'stripe_wrapper', 'stripe_fdw_handler', 'stripe_fdw_validator')")
    expect(sql).toContain('create foreign table "public"."stripe_accounts" (')
    expect(sql).toContain('"object" \'accounts\'')
    expect(sql).not.toContain('supabase_target_schema')
  })

  it('imports a schema into a new one', () => {
    const sql = createWrapperSql(draft({ mode: 'schema', targetSchema: 'stripe_data', tables: [] }), { api_key_id: ID })
    expect(sql).toContain('create schema if not exists "stripe_data";')
    expect(sql).toContain(`"supabase_target_schema" 'stripe_data'`)
    expect(sql).toContain(`import foreign schema "stripe" from server "stripe_server" into "stripe_data" options (strict 'true');`)
  })

  it('quotes option values', () => {
    const t = tableFromTemplate(stripe, 0)
    t.options.rowid_column = "id'; drop table x; --"
    const sql = createWrapperSql(draft({ tables: [t] }), { api_key_id: ID })
    expect(sql).toContain(`"rowid_column" 'id''; drop table x; --'`)
  })

  it('reports what blocks a draft', () => {
    const taken = { servers: ['stripe_server'], schemas: ['public'], secrets: [] as string[] }
    expect(draftProblems(draft(), taken)).toContain('A wrapper called stripe_server already exists')
    expect(draftProblems(draft({ values: {} }), { ...taken, servers: [] })).toContain('Enter Stripe Secret Key')
    expect(draftProblems(draft({ mode: 'schema', targetSchema: 'public' }), { ...taken, servers: [] })).toContain(
      'Schema public already exists; imported tables need a new one'
    )
    const bad = tableFromTemplate(stripe, 0)
    bad.columns.push({ name: 'x', type: 'text); drop table y; --' })
    expect(draftProblems(draft({ tables: [bad] }), { ...taken, servers: [] }).join('\n')).toMatch(/doesn't look like a Postgres type/)
    expect(draftProblems(draft(), { servers: [], schemas: [], secrets: ['stripe_server_api_key_id'] })[0]).toMatch(/Vault secret/)
    expect(draftProblems(draft(), { servers: [], schemas: [], secrets: [], relations: ['public.stripe_accounts'] })).toContain(
      'Table 1: public.stripe_accounts already exists'
    )
    const dup = tableFromTemplate(stripe, 0)
    dup.columns.push({ name: 'id', type: 'bigint' })
    expect(draftProblems(draft({ tables: [dup] }), { servers: [], schemas: [], secrets: [] })).toContain('Table 1: column id is listed twice')
    expect(draftProblems(draft(), { servers: [], schemas: [], secrets: [] })).toEqual([])
  })

  it('takes remote column names as they are', () => {
    expect(columnProblem('userId')).toBeNull()
    expect(columnProblem('Created At')).toBeNull()
    expect(columnProblem('')).toBe('Enter a column name')
    expect(columnProblem('a\0b')).toMatch(/NUL/)
    expect(columnProblem('x'.repeat(64))).toMatch(/63 bytes/)
    const t = tableFromTemplate(stripe, 0)
    t.columns = [{ name: 'userId', type: 'text' }]
    expect(createWrapperSql(draft({ tables: [t] }), { api_key_id: ID })).toContain('"userId" text')
  })
})

describe('dropping a wrapper', () => {
  const server = (options: string[]) => ({ id: 1, fdw: 'stripe_wrapper', server: 'stripe_server', handler: 'stripe_fdw_handler', options, tables: [] })

  it('drops the server and the wrapper once unused', () => {
    const sql = dropWrapperSql(server([`api_key_id=${ID}`, 'api_url=https://api.stripe.com/v1']))
    expect(sql).toContain('drop server "stripe_server" cascade;')
    expect(sql).toContain("execute format('drop foreign data wrapper %I', 'stripe_wrapper')")
    expect(sql).not.toContain('drop schema')
  })

  it('deletes secrets only when no other server refers to them', () => {
    const sql = dropWrapperSql(server([`api_key_id=${ID}`]))
    expect(sql).toContain(`delete from vault.secrets where id = '${ID}'::uuid`)
    expect(sql).toContain(`unnest(sv.srvoptions) o where substr(o, strpos(o, '=') + 1) = '${ID}'`)
  })

  it('drops the import schema only if it is empty', () => {
    const sql = dropWrapperSql(server([`api_key_id=${ID}`, 'supabase_target_schema=stripe_data']))
    expect(sql).toContain(`execute format('drop schema %I', 'stripe_data')`)
    expect(sql).toContain('exception when dependent_objects_still_exist then null')
  })

  it('parses option lists', () => {
    expect(parseOptions(['a=1', 'b=x=y', 'c'])).toEqual({ a: '1', b: 'x=y', c: '' })
  })
})

describe('showing settings', () => {
  it('shows plain settings and masks secrets and unknown options', () => {
    expect(displayOptions({ fdw: 'stripe_wrapper', handler: 'stripe_fdw_handler', options: [`api_key_id=${ID}`, 'api_url=https://x', 'api_key=sk_live_inline'] })).toEqual([
      { name: 'api_key_id', value: null, vault: true },
      { name: 'api_url', value: 'https://x', vault: false },
      { name: 'api_key', value: null, vault: false },
    ])
    // An unrecognised server: nothing is shown in clear.
    expect(displayOptions({ fdw: 'mystery', handler: 'mystery_handler', options: ['conn_string=tcp://u:p@h'] })).toEqual([
      { name: 'conn_string', value: null, vault: false },
    ])
  })
})

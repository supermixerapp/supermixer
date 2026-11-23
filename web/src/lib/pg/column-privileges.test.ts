import { describe, expect, it } from 'vitest'

import {
  columnGrant,
  lockedBy,
  PARTIAL_GRANT,
  setColumnPrivilege,
  setTablePrivilege,
  tableGrant,
  type TablePrivileges,
} from './column-privileges'

const target = { schema: 'public', table: 'profiles', role: 'authenticated' }

const col = (name: string, over: Partial<TablePrivileges['columns'][number]> = {}) => ({
  name,
  type: 'text',
  granted: [],
  public_granted: [],
  locked: [],
  locked_by: [],
  ...over,
})

const table = (over: Partial<TablePrivileges> = {}): TablePrivileges => ({
  kind: 'r',
  owner: 'postgres',
  granted: [],
  public_granted: [],
  locked: [],
  locked_by: [],
  columns: [col('id'), col('name', { granted: ['UPDATE'] }), col('is_admin', { public_granted: ['SELECT'] })],
  ...over,
})

describe('columnGrant', () => {
  it('says where a privilege comes from, PUBLIC first', () => {
    const t = table({ granted: ['SELECT'] })
    expect(columnGrant(t, 'is_admin', 'SELECT')).toBe('public')
    expect(columnGrant(t, 'id', 'SELECT')).toBe('table')
    expect(columnGrant(t, 'name', 'UPDATE')).toBe('column')
    expect(columnGrant(t, 'id', 'UPDATE')).toBe('none')
    expect(columnGrant(table({ public_granted: ['INSERT'] }), 'id', 'INSERT')).toBe('public')
  })

  it('locks grants another role made', () => {
    const t = table({
      granted: ['SELECT'],
      locked: ['SELECT'],
      locked_by: ['supabase_admin'],
      columns: [col('id'), col('secret', { granted: ['UPDATE'], locked: ['UPDATE'], locked_by: ['owner_role'] })],
    })
    expect(columnGrant(t, 'id', 'SELECT')).toBe('locked')
    expect(tableGrant(t, 'SELECT')).toBe('locked')
    expect(columnGrant(t, 'secret', 'UPDATE')).toBe('locked')
    expect(tableGrant(t, 'UPDATE')).toBe('none')
    expect(lockedBy(t, 'SELECT')).toEqual(['supabase_admin'])
    expect(lockedBy(t, 'UPDATE', 'secret')).toEqual(['owner_role'])
  })
})

describe('PARTIAL_GRANT', () => {
  it("spots Postgres's warnings", () => {
    expect(PARTIAL_GRANT.test('WARNING: no privileges could be revoked for "t"')).toBe(true)
    expect(PARTIAL_GRANT.test('WARNING: not all privileges were granted for "t"')).toBe(true)
    expect(PARTIAL_GRANT.test('NOTICE: something else')).toBe(false)
  })
})

describe('setTablePrivilege', () => {
  it('grants and revokes on the whole table', () => {
    expect(setTablePrivilege(target, 'SELECT', true)).toBe('grant select on table "public"."profiles" to "authenticated";')
    expect(setTablePrivilege(target, 'UPDATE', false)).toBe('revoke update on table "public"."profiles" from "authenticated";')
  })
})

describe('setColumnPrivilege', () => {
  it('grants on one column', () => {
    expect(setColumnPrivilege(target, 'INSERT', 'id', true, table())).toBe('grant insert ("id") on table "public"."profiles" to "authenticated";')
  })

  it('revokes a column grant directly', () => {
    expect(setColumnPrivilege(target, 'UPDATE', 'name', false, table())).toBe(
      'revoke update ("name") on table "public"."profiles" from "authenticated";'
    )
  })

  it('swaps a table grant for grants on the other columns, checking the revoke took', () => {
    const sql = setColumnPrivilege(target, 'UPDATE', 'is_admin', false, table({ granted: ['UPDATE'] }))
    const lines = sql.split('\n')
    expect(lines[0]).toBe('revoke update on table "public"."profiles" from "authenticated";')
    expect(sql).toContain(`c.oid = '"public"."profiles"'::regclass and e.grantee = '"authenticated"'::regrole and e.privilege_type = 'UPDATE'`)
    expect(sql).toContain(`raise exception '%', 'UPDATE on public.profiles was granted to authenticated by another role, so it can''t be revoked here';`)
    expect(lines.at(-1)).toBe('grant update ("id", "name") on table "public"."profiles" to "authenticated";')
  })

  it('only revokes when the table has a single column', () => {
    const sql = setColumnPrivilege(target, 'SELECT', 'id', false, table({ granted: ['SELECT'], columns: [col('id')] }))
    expect(sql).not.toContain('grant ')
  })

  it('quotes awkward names', () => {
    expect(setColumnPrivilege({ ...target, role: 'my"role' }, 'SELECT', 'a b', true, table())).toBe(
      'grant select ("a b") on table "public"."profiles" to "my""role";'
    )
  })
})

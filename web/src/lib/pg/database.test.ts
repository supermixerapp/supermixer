import { describe, expect, it } from 'vitest'

import { addEnumValue, createEnum, createFunction, createIndex, createPolicy, createTrigger, dollarTag, dropFunction, parseProconfig, setPublicationEvents } from './database'

describe('database DDL', () => {
  it('builds a function with a dollar tag the body does not use', () => {
    expect(dollarTag('select $sm$ $sm1$')).toBe('$sm2$')
    expect(
      createFunction({
        schema: 'public', name: 'touch', args: '', returns: 'trigger', language: 'plpgsql',
        body: 'begin new.updated_at = now(); return new; end;', securityDefiner: false, searchPath: '',
      })
    ).toBe(`create or replace function "public"."touch"()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $sm$
begin new.updated_at = now(); return new; end;
$sm$;`)
    expect(dropFunction('public', 'f', 'a integer, b text')).toBe('drop function "public"."f"(a integer, b text);')
  })

  it('keeps a function\'s settings when it is edited', () => {
    const parsed = parseProconfig(['search_path=public, extensions', 'statement_timeout=5s'])
    expect(parsed).toEqual({ searchPath: 'public, extensions', settings: [{ name: 'statement_timeout', value: '5s' }] })
    expect(parseProconfig(['search_path=""']).searchPath).toBe('')
    expect(parseProconfig(null)).toEqual({ searchPath: null, settings: [] })
    const sql = createFunction({
      schema: 'public', name: 'add', args: 'a integer, b integer DEFAULT 0', returns: 'integer', language: 'sql',
      body: 'select a + b', securityDefiner: true, ...parsed,
    })
    expect(sql).toContain('"public"."add"(a integer, b integer DEFAULT 0)')
    expect(sql).toContain('set search_path = public, extensions\nset "statement_timeout" = \'5s\'')
  })

  it('builds triggers, enums, indexes and publication changes', () => {
    expect(
      createTrigger({ schema: 'public', table: 'todos', name: 'set updated', timing: 'before', events: ['insert', 'update'], level: 'row', functionSchema: 'public', functionName: 'touch' })
    ).toBe('create trigger "set updated" before insert or update on "public"."todos"\nfor each row execute function "public"."touch"();')
    expect(createEnum('public', 'mood', ['ok', "it's fine"])).toBe(`create type "public"."mood" as enum ('ok', 'it''s fine');`)
    expect(addEnumValue('public', 'mood', 'sad')).toBe(`alter type "public"."mood" add value 'sad';`)
    expect(createIndex('public', 'todos', ['user_id', 'created_at'], 'btree', true)).toBe('create unique index on "public"."todos" using btree ("user_id", "created_at");')
    expect(setPublicationEvents('supabase_realtime', ['insert', 'update'])).toBe(`alter publication "supabase_realtime" set (publish = 'insert, update');`)
  })

  it('builds policies with only the clauses each command allows', () => {
    const base = { schema: 'public', table: 'todos', name: 'own rows', permissive: true, roles: ['authenticated'], using: 'a = b', check: 'c = d' }
    expect(createPolicy({ ...base, command: 'ALL' })).toBe(
      'create policy "own rows"\non "public"."todos"\nas permissive\nfor all\nto "authenticated"\nusing (a = b)\nwith check (c = d);'
    )
    expect(createPolicy({ ...base, command: 'INSERT' })).not.toContain('using')
    expect(createPolicy({ ...base, command: 'SELECT', roles: [] })).toBe(
      'create policy "own rows"\non "public"."todos"\nas permissive\nfor select\nto public\nusing (a = b);'
    )
  })
})

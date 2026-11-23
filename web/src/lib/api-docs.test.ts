import { describe, expect, it } from 'vitest'

import {
  authExamples,
  exampleValue,
  functionExample,
  jsVar,
  parseDescription,
  parseSpec,
  resourceExamples,
  shellQuote,
  type DocColumn,
  type DocResource,
  type PostgrestSpec,
} from './api-docs'

// Trimmed from a real PostgREST 14 response.
const spec: PostgrestSpec = {
  paths: {
    '/': {},
    '/notes': { get: { summary: 'Notes on todos' }, post: {}, patch: {}, delete: {} },
    '/todo_view': { get: {} },
    '/rpc/add': {
      get: {
        parameters: [
          { format: 'int32', in: 'query', name: 'a', required: true, type: 'integer' },
          { format: 'int32', in: 'query', name: 'b', required: false, type: 'integer' },
        ],
      },
      post: {
        summary: 'Adds two numbers',
        parameters: [
          {
            in: 'body',
            name: 'args',
            required: true,
            schema: { type: 'object', required: ['a'], properties: { a: { format: 'int32', type: 'integer' }, b: { format: 'int32', type: 'integer' } } },
          },
          { $ref: '#/parameters/preferParams' },
        ],
      },
    },
    '/rpc/bump': { post: { parameters: [{ in: 'body', name: 'args', required: true, schema: { type: 'object' } }] } },
  },
  definitions: {
    notes: {
      description: 'Notes on todos',
      required: ['id', 'body'],
      properties: {
        id: { default: 'gen_random_uuid()', description: 'Note:\nThis is a Primary Key.<pk/>', format: 'uuid', type: 'string' },
        todo_id: { description: "Note:\nThis is a Foreign Key to `todos.id`.<fk table='todos' column='id'/>", format: 'int64', type: 'integer' },
        body: { description: 'The note', format: 'jsonb' },
        tags: { format: 'text[]', items: { type: 'string' }, type: 'array' },
      },
    },
    todo_view: { properties: { task: { format: 'text', type: 'string' } } },
  },
}

const client = { url: 'http://localhost:8100/', key: 'anon-key' }

describe('parseDescription', () => {
  it('takes out the key notes', () => {
    expect(parseDescription('Note:\nThis is a Primary Key.<pk/>')).toEqual({ text: null, primaryKey: true, references: null })
    expect(parseDescription("Who wrote it\n\nNote:\nThis is a Foreign Key to `users.id`.<fk table='users' column='id'/>")).toEqual({
      text: 'Who wrote it',
      primaryKey: false,
      references: 'users.id',
    })
    expect(parseDescription(undefined).text).toBeNull()
  })
})

describe('parseSpec', () => {
  const { resources, functions } = parseSpec(spec)

  it('reads tables and views with their columns', () => {
    expect(resources.map((r) => r.name)).toEqual(['notes', 'todo_view'])
    const notes = resources[0]!
    expect(notes).toMatchObject({ description: 'Notes on todos', read: true, insert: true, update: true, delete: true })
    expect(notes.columns.map((c) => [c.name, c.format, c.required, c.primaryKey, c.references, c.hasDefault])).toEqual([
      ['id', 'uuid', true, true, null, true],
      ['todo_id', 'int64', false, false, 'todos.id', false],
      ['body', 'jsonb', true, false, null, false],
      ['tags', 'text[]', false, false, null, false],
    ])
    expect(resources[1]).toMatchObject({ read: true, insert: false, update: false, delete: false })
  })

  it('reads functions and their arguments', () => {
    expect(functions).toEqual([
      {
        name: 'add',
        description: 'Adds two numbers',
        get: true,
        params: [
          { name: 'a', format: 'int32', type: 'integer', required: true, enum: null },
          { name: 'b', format: 'int32', type: 'integer', required: false, enum: null },
        ],
      },
      { name: 'bump', description: null, get: false, params: [] },
    ])
  })
})

describe('examples', () => {
  const { resources, functions } = parseSpec(spec)

  it('picks example values by type', () => {
    expect(exampleValue('string', 'uuid')).toMatch(/^0{8}-/)
    expect(exampleValue('integer', 'int64')).toBe(1)
    expect(exampleValue('string', 'jsonb')).toEqual({})
    expect(exampleValue('string', 'text')).toBe('someValue')
  })

  it('writes table examples in both languages', () => {
    const ex = resourceExamples(resources[0]!, client)
    expect(ex.map((e) => e.title)).toEqual([
      'Read all rows',
      'Read specific columns',
      'With pagination',
      'Filtering',
      'Insert a row',
      'Insert many rows',
      'Upsert',
      'Update matching rows',
      'Delete matching rows',
      'Subscribe to changes',
    ])
    expect(ex[0]!.js).toBe("let { data: notes, error } = await supabase\n  .from('notes')\n  .select('*')")
    expect(ex[0]!.bash).toBe("curl 'http://localhost:8100/rest/v1/notes?select=*' \\\n  -H 'apikey: anon-key' \\\n  -H 'Authorization: Bearer anon-key'")
    // Filters on the primary key; writes the columns without defaults.
    expect(ex[3]!.js).toContain(".eq('id', '00000000-0000-0000-0000-000000000000')")
    // Inserts set every NOT NULL column without a default.
    expect(ex[4]!.js).toContain('{ body: {} }')
    expect(ex[8]!.bash).toContain("curl -X DELETE 'http://localhost:8100/rest/v1/notes?id=eq.00000000-0000-0000-0000-000000000000'")
  })

  it('only offers reads for a read-only view', () => {
    expect(resourceExamples(resources[1]!, client).map((e) => e.title)).toEqual([
      'Read all rows',
      'Read specific columns',
      'With pagination',
      'Filtering',
      'Subscribe to changes',
    ])
  })

  it('calls functions', () => {
    const ex = functionExample(functions[0]!, client)
    expect(ex.js).toBe("let { data, error } = await supabase\n  .rpc('add', {\n    a: 1,\n    b: 1,\n  })")
    expect(ex.bash).toContain("-d '{\"a\":1,\"b\":1}'")
    expect(functionExample(functions[1]!, client).js).toBe("let { data, error } = await supabase\n  .rpc('bump')")
  })

  it('gives values Postgres accepts for less common types', () => {
    expect(exampleValue('string', 'public.task_status', ['todo', 'done'])).toBe('todo')
    expect(exampleValue('string', 'time without time zone')).toBe('12:00:00')
    expect(exampleValue('string', 'interval')).toBe('1 day')
    expect(exampleValue('string', 'int4range')).toBe('[1,10)')
    expect(exampleValue('string', 'tstzrange')).toMatch(/^\[2026/)
    expect(exampleValue('string', 'date')).toBe('2026-01-01')
  })

  it('names row variables so they never clash', () => {
    expect(jsVar('todos')).toBe('todos')
    expect(jsVar('error')).toBe('errorRows')
    expect(jsVar('delete')).toBe('deleteRows')
    expect(jsVar('supabase')).toBe('supabaseRows')
    expect(jsVar('2fa codes')).toBe('_2fa_codes')
  })

  const column = (name: string, over: Partial<DocColumn> = {}): DocColumn => ({
    name,
    format: 'text',
    type: 'string',
    required: false,
    description: null,
    primaryKey: false,
    references: null,
    hasDefault: false,
    enum: null,
    ...over,
  })
  const resource = (columns: DocColumn[], over: Partial<DocResource> = {}): DocResource => ({
    name: 't',
    description: null,
    columns,
    read: true,
    insert: true,
    update: true,
    delete: true,
    ...over,
  })

  it('includes a primary key without a default in inserts, but not in updates', () => {
    const r = resource([column('id', { format: 'uuid', primaryKey: true, required: true }), column('username', { required: true })])
    const ex = resourceExamples(r, client)
    const insert = ex.find((e) => e.title === 'Insert a row')!
    expect(insert.js).toContain("{ id: '00000000-0000-0000-0000-000000000000', username: 'someValue' }")
    // Two rows can't share a key.
    expect(ex.find((e) => e.title === 'Insert many rows')!.bash).toContain(
      '{"id":"00000000-0000-0000-0000-000000000000","username":"someValue"}, {"id":"00000000-0000-0000-0000-000000000001","username":"otherValue"}'
    )
    const update = ex.find((e) => e.title === 'Update matching rows')!
    expect(update.js).toContain(".update({ username: 'someValue' })")
  })

  it('filters on a plain column and skips upserts without a primary key', () => {
    const r = resource([column('tags', { type: 'array', format: 'text[]' }), column('meta', { format: 'jsonb' }), column('name')])
    const ex = resourceExamples(r, client)
    expect(ex.find((e) => e.title === 'Filtering')!.js).toContain(".eq('name', 'someValue')")
    expect(ex.map((e) => e.title)).not.toContain('Upsert')
    const noScalar = resourceExamples(resource([column('tags', { type: 'array', format: 'text[]' })]), client).map((e) => e.title)
    expect(noScalar).not.toContain('Filtering')
    expect(noScalar).not.toContain('Delete matching rows')
  })

  it('offers Realtime only for tables', () => {
    const r = resource([column('name')], { insert: false, update: false, delete: false })
    expect(resourceExamples(r, client, { kind: 'v' }).map((e) => e.title)).not.toContain('Subscribe to changes')
    expect(resourceExamples(r, client, { kind: 'r' }).map((e) => e.title)).toContain('Subscribe to changes')
  })

  it('escapes awkward names in JavaScript', () => {
    const r = resource([column('a\\b', { required: true })])
    expect(resourceExamples(r, client).find((e) => e.title === 'Insert a row')!.js).toContain("{ 'a\\\\b': 'someValue' }")
  })

  it('quotes for the shell', () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'")
    expect(authExamples(client)[0]!.bash).toContain("curl -X POST 'http://localhost:8100/auth/v1/signup'")
  })
})

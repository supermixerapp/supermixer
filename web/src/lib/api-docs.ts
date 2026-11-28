/*
 * Data API docs: reads PostgREST's OpenAPI (Swagger 2.0) description and
 * writes supabase-js and curl examples for each table, view and function.
 */
import { t as tr } from '@/lib/i18n'

/** The parts of PostgREST's OpenAPI output the docs use. */
export interface PostgrestSpec {
  info?: { title?: string; description?: string }
  paths: Record<string, Partial<Record<'get' | 'post' | 'patch' | 'delete', SpecOperation>>>
  definitions?: Record<string, SpecSchema>
}

interface SpecOperation {
  summary?: string
  description?: string
  parameters?: ({ $ref: string } | { name: string; in: string; required?: boolean; type?: string; format?: string; enum?: unknown[]; schema?: SpecSchema })[]
}

interface SpecProperty {
  type?: string
  format?: string
  description?: string
  default?: unknown
  enum?: unknown[]
  items?: { type?: string }
}

interface SpecSchema {
  type?: string
  description?: string
  required?: string[]
  properties?: Record<string, SpecProperty>
}

export interface DocColumn {
  name: string
  /** Postgres type, e.g. "timestamp with time zone". */
  format: string
  /** JSON type, e.g. "string". */
  type: string
  required: boolean
  description: string | null
  primaryKey: boolean
  /** "table.column" for a foreign key. */
  references: string | null
  hasDefault: boolean
  /** An enum type's labels. */
  enum: string[] | null
}

export interface DocResource {
  name: string
  description: string | null
  columns: DocColumn[]
  /** What the service role may do; anon and authenticated may get less. */
  read: boolean
  insert: boolean
  update: boolean
  delete: boolean
}

export interface DocParam {
  name: string
  format: string
  type: string
  required: boolean
  enum: string[] | null
}

export interface DocFunction {
  name: string
  description: string | null
  params: DocParam[]
  /** Callable with GET (stable or immutable functions). */
  get: boolean
}

/** PostgREST appends notes like "Note:\nThis is a Primary Key.<pk/>"; take them out. */
export function parseDescription(raw: string | undefined): { text: string | null; primaryKey: boolean; references: string | null } {
  if (!raw) return { text: null, primaryKey: false, references: null }
  const primaryKey = raw.includes('<pk/>')
  const fk = /<fk table='([^']*)' column='([^']*)'\/>/.exec(raw)
  const text = raw.replace(/(Note:\n)?This is a (Primary|Foreign) Key[\s\S]*?<(pk|fk)[^>]*\/>/g, '').trim()
  return { text: text || null, primaryKey, references: fk ? `${fk[1]}.${fk[2]}` : null }
}

type QueryParam = { name: string; in: string; required?: boolean; type?: string; format?: string; enum?: unknown[] }

const enumOf = (values: unknown[] | undefined): string[] | null =>
  values?.length ? values.filter((v): v is string => typeof v === 'string') : null

export function parseSpec(spec: PostgrestSpec): { resources: DocResource[]; functions: DocFunction[] } {
  const resources: DocResource[] = []
  const functions: DocFunction[] = []
  for (const [path, ops] of Object.entries(spec.paths ?? {})) {
    if (path === '/') continue
    if (path.startsWith('/rpc/')) {
      const op = ops.post ?? ops.get
      const body = ops.post?.parameters?.find((p): p is { name: string; in: string; schema?: SpecSchema } => 'in' in p && p.in === 'body')
      const params: DocParam[] = body?.schema?.properties
        ? Object.entries(body.schema.properties).map(([name, p]) => ({
            name,
            format: p.format ?? p.type ?? '',
            type: p.type ?? 'string',
            required: !!body.schema?.required?.includes(name),
            enum: enumOf(p.enum),
          }))
        : (ops.get?.parameters ?? [])
            .filter((p): p is QueryParam => 'in' in p && p.in === 'query')
            .map((p) => ({ name: p.name, format: p.format ?? p.type ?? '', type: p.type ?? 'string', required: !!p.required, enum: enumOf(p.enum) }))
      functions.push({
        name: path.slice('/rpc/'.length),
        description: op?.summary?.trim() || op?.description?.trim() || null,
        params,
        get: !!ops.get,
      })
      continue
    }
    const name = path.slice(1)
    const def = spec.definitions?.[name]
    const columns: DocColumn[] = Object.entries(def?.properties ?? {}).map(([col, p]) => {
      const d = parseDescription(p.description)
      return {
        name: col,
        format: p.format ?? p.type ?? '',
        type: p.type ?? 'string',
        required: !!def?.required?.includes(col),
        description: d.text,
        primaryKey: d.primaryKey,
        references: d.references,
        hasDefault: p.default !== undefined,
        enum: enumOf(p.enum),
      }
    })
    resources.push({
      name,
      description: def?.description?.trim() || ops.get?.summary?.trim() || null,
      columns,
      read: !!ops.get,
      insert: !!ops.post,
      update: !!ops.patch,
      delete: !!ops.delete,
    })
  }
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)
  return { resources: resources.sort(byName), functions: functions.sort(byName) }
}

/* ------------------------------------------------------------- examples */

export interface Client {
  url: string
  key: string
}

/** A value Postgres accepts for a column or parameter, as JSON. `second` gives a different one, for a second row. */
export function exampleValue(type: string, format: string, enumValues?: string[] | null, second = false): unknown {
  if (enumValues?.length) return enumValues[second ? Math.min(1, enumValues.length - 1) : 0]
  if (format === 'uuid') return second ? '00000000-0000-0000-0000-000000000001' : '00000000-0000-0000-0000-000000000000'
  if (format === 'daterange') return '[2026-01-01,2026-02-01)'
  if (format === 'tsrange' || format === 'tstzrange') return '[2026-01-01 00:00,2026-01-02 00:00)'
  if (/range$/.test(format)) return '[1,10)'
  if (/^timestamp/.test(format)) return '2026-01-01T00:00:00Z'
  if (format === 'date') return '2026-01-01'
  if (/^time( |$)/.test(format)) return '12:00:00'
  if (format === 'interval') return '1 day'
  if (format === 'inet' || format === 'cidr') return '192.168.0.1'
  if (format === 'macaddr') return '08:00:2b:01:02:03'
  if (format === 'bytea') return '\\x00'
  if (type === 'integer') return second ? 2 : 1
  if (type === 'number') return second ? 2.5 : 1.5
  if (type === 'boolean') return true
  if (type === 'array') return []
  if (/json/.test(format)) return {}
  return second ? 'otherValue' : 'someValue'
}

const example = (c: { type: string; format: string; enum: string[] | null }, second = false) => exampleValue(c.type, c.format, c.enum, second)

/**
 * Columns for write examples: every one an insert must set (NOT NULL with no
 * default, primary keys included), or else a couple a client would usually set.
 */
function writable(columns: DocColumn[]): DocColumn[] {
  const needed = columns.filter((c) => c.required && !c.hasDefault)
  if (needed.length) return needed
  const own = columns.filter((c) => !c.hasDefault).slice(0, 2)
  return own.length ? own : columns.filter((c) => !c.primaryKey).slice(0, 1)
}

/** Filters need a plain value: arrays and JSON don't compare with eq. */
const scalar = (c: DocColumn) => c.type !== 'array' && c.type !== 'object' && !/json/.test(c.format)

function filterColumn(columns: DocColumn[]): DocColumn | undefined {
  return columns.find((c) => c.primaryKey && scalar(c)) ?? columns.find(scalar)
}

function jsObject(columns: DocColumn[], second = false): string {
  if (!columns.length) return '{}'
  return `{ ${columns.map((c) => `${jsKey(c.name)}: ${jsValue(example(c, second))}`).join(', ')} }`
}

const jsString = (s: string) =>
  `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')}'`
const jsKey = (name: string) => (/^[A-Za-z_$][\w$]*$/.test(name) ? name : jsString(name))
const jsValue = (v: unknown) => (typeof v === 'string' ? jsString(v) : JSON.stringify(v))

const RESERVED = new Set(
  (
    'break case catch class const continue debugger default delete do else enum export extends false finally for function if ' +
    'import in instanceof new null return super switch this throw true try typeof var void while with yield let static ' +
    'implements interface package private protected public await arguments eval undefined NaN Infinity ' +
    // names the snippets already use
    'data error supabase channel payload'
  ).split(' ')
)

/** A JavaScript variable name for a table's rows that can't clash with anything. */
export function jsVar(name: string): string {
  let v = name.replace(/[^\w$]/g, '_')
  if (!/^[A-Za-z_$]/.test(v)) v = `_${v}`
  return RESERVED.has(v) ? `${v}Rows` : v
}

function jsonBody(columns: DocColumn[], second = false): string {
  return JSON.stringify(Object.fromEntries(columns.map((c) => [c.name, example(c, second)])))
}

/** Single-quote for a POSIX shell. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

const restUrl = (c: Client, path: string) => `${c.url.replace(/\/+$/, '')}/rest/v1/${path}`
const urlValue = (v: unknown) => encodeURIComponent(typeof v === 'string' ? v : JSON.stringify(v))

function curl(c: Client, method: string, url: string, extra: string[] = [], body?: string): string {
  const lines = [`curl${method === 'GET' ? '' : ` -X ${method}`} ${shellQuote(url)}`, `-H ${shellQuote(`apikey: ${c.key}`)}`, `-H ${shellQuote(`Authorization: Bearer ${c.key}`)}`, ...extra]
  if (body !== undefined) lines.push(`-H 'Content-Type: application/json'`, `-d ${shellQuote(body)}`)
  return lines.join(' \\\n  ')
}

export interface Example {
  title: string
  description?: string
  js: string
  bash: string
}

/**
 * Examples for one table or view, in Studio's order. `kind` is the relation's
 * pg_class.relkind when known: Realtime only streams changes to tables.
 */
export function resourceExamples(r: DocResource, c: Client, { schema = 'public', kind }: { schema?: string; kind?: string } = {}): Example[] {
  const from = `supabase\n  .from(${jsString(r.name)})`
  const v = jsVar(r.name)
  const path = encodeURIComponent(r.name)
  const pick = r.columns.slice(0, 2)
  const f = filterColumn(r.columns)
  const fv = f ? example(f) : 'someValue'
  const fq = f ? `${encodeURIComponent(f.name)}=eq.${urlValue(fv)}` : ''
  const w = writable(r.columns)
  // Updates change ordinary columns, not the key the filter uses.
  const nonKey = w.filter((x) => !x.primaryKey)
  const u = nonKey.length ? nonKey : r.columns.filter((x) => !x.primaryKey).slice(0, 1)
  const pk = r.columns.filter((x) => x.primaryKey)
  const upsertCols = [...pk, ...w.filter((x) => !x.primaryKey)]
  const out: Example[] = []
  if (r.read) {
    out.push(
      {
        title: tr('integrations:apiDocsExamples.readAllRows'),
        js: `let { data: ${v}, error } = await ${from}\n  .select('*')`,
        bash: curl(c, 'GET', restUrl(c, `${path}?select=*`)),
      },
      {
        title: tr('integrations:apiDocsExamples.readSpecificColumns'),
        js: `let { data: ${v}, error } = await ${from}\n  .select(${jsString(pick.map((x) => x.name).join(','))})`,
        bash: curl(c, 'GET', restUrl(c, `${path}?select=${pick.map((x) => encodeURIComponent(x.name)).join(',')}`)),
      },
      {
        title: tr('integrations:apiDocsExamples.withPagination'),
        description: tr('integrations:apiDocsExamples.withPaginationDescription'),
        js: `let { data: ${v}, error } = await ${from}\n  .select('*')\n  .range(0, 9)`,
        bash: curl(c, 'GET', restUrl(c, `${path}?select=*`), [`-H 'Range: 0-9'`]),
      }
    )
    if (f) {
      out.push({
        title: tr('integrations:apiDocsExamples.filtering'),
        description: tr('integrations:apiDocsExamples.filteringDescription'),
        js: `let { data: ${v}, error } = await ${from}\n  .select('*')\n  .eq(${jsString(f.name)}, ${jsValue(fv)})`,
        bash: curl(c, 'GET', restUrl(c, `${path}?select=*&${fq}`)),
      })
    }
  }
  if (r.insert) {
    out.push(
      {
        title: tr('integrations:apiDocsExamples.insertARow'),
        js: `const { data, error } = await ${from}\n  .insert([\n    ${jsObject(w)},\n  ])\n  .select()`,
        bash: curl(c, 'POST', restUrl(c, path), [`-H 'Prefer: return=minimal'`], jsonBody(w)),
      },
      {
        title: tr('integrations:apiDocsExamples.insertManyRows'),
        js: `const { data, error } = await ${from}\n  .insert([\n    ${jsObject(w)},\n    ${jsObject(w, true)},\n  ])\n  .select()`,
        bash: curl(c, 'POST', restUrl(c, path), [], `[${jsonBody(w)}, ${jsonBody(w, true)}]`),
      }
    )
    if (pk.length) {
      out.push({
        title: tr('integrations:apiDocsExamples.upsert'),
        description: tr('integrations:apiDocsExamples.upsertDescription'),
        js: `const { data, error } = await ${from}\n  .upsert(${jsObject(upsertCols)})\n  .select()`,
        bash: curl(c, 'POST', restUrl(c, path), [`-H 'Prefer: resolution=merge-duplicates'`], jsonBody(upsertCols)),
      })
    }
  }
  if (r.update && f && u.length) {
    out.push({
      title: tr('integrations:apiDocsExamples.updateMatchingRows'),
      description: tr('integrations:apiDocsExamples.updateDescription'),
      js: `const { data, error } = await ${from}\n  .update(${jsObject(u)})\n  .eq(${jsString(f.name)}, ${jsValue(fv)})\n  .select()`,
      bash: curl(c, 'PATCH', restUrl(c, `${path}?${fq}`), [`-H 'Prefer: return=minimal'`], jsonBody(u)),
    })
  }
  if (r.delete && f) {
    out.push({
      title: tr('integrations:apiDocsExamples.deleteMatchingRows'),
      description: tr('integrations:apiDocsExamples.deleteDescription'),
      js: `const { error } = await ${from}\n  .delete()\n  .eq(${jsString(f.name)}, ${jsValue(fv)})`,
      bash: curl(c, 'DELETE', restUrl(c, `${path}?${fq}`)),
    })
  }
  if (kind !== undefined && kind !== 'r' && kind !== 'p') return out
  out.push({
    title: tr('integrations:apiDocsExamples.subscribeToChanges'),
    description: tr('integrations:apiDocsExamples.subscribeDescription'),
    js: `const channel = supabase\n  .channel(${jsString(`${r.name}-changes`)})\n  .on(\n    'postgres_changes',\n    { event: '*', schema: ${jsString(schema)}, table: ${jsString(r.name)} },\n    (payload) => console.log('Change received!', payload)\n  )\n  .subscribe()`,
    bash: '# Realtime uses WebSockets; use a client library.',
  })
  return out
}

export function functionExample(fn: DocFunction, c: Client): Example {
  const args = fn.params.map((p) => ({ name: p.name, value: example(p) }))
  const jsArgs = args.length ? `, {\n${args.map((a) => `    ${jsKey(a.name)}: ${jsValue(a.value)}`).join(',\n')},\n  }` : ''
  return {
    title: tr('integrations:apiDocsExamples.callTheFunction'),
    js: `let { data, error } = await supabase\n  .rpc(${jsString(fn.name)}${jsArgs})`,
    bash: curl(c, 'POST', restUrl(c, `rpc/${encodeURIComponent(fn.name)}`), [], JSON.stringify(Object.fromEntries(args.map((a) => [a.name, a.value])))),
  }
}

/** Studio's "Bash" examples for Auth, with placeholders the reader fills in. */
export function authExamples(c: Client): Example[] {
  const auth = (p: string) => `${c.url.replace(/\/+$/, '')}/auth/v1/${p}`
  const base = (method: string, url: string, body?: string, token = false) => {
    const lines = [`curl${method === 'GET' ? '' : ` -X ${method}`} ${shellQuote(url)}`, `-H ${shellQuote(`apikey: ${c.key}`)}`]
    if (token) lines.push(`-H 'Authorization: Bearer USER_TOKEN'`)
    if (body !== undefined) lines.push(`-H 'Content-Type: application/json'`, `-d ${shellQuote(body)}`)
    return lines.join(' \\\n  ')
  }
  return [
    {
      title: tr('integrations:apiDocsExamples.signUp'),
      description: tr('integrations:apiDocsExamples.signUpDescription'),
      js: `let { data, error } = await supabase.auth.signUp({\n  email: 'someone@email.com',\n  password: 'a-strong-password',\n})`,
      bash: base('POST', auth('signup'), JSON.stringify({ email: 'someone@email.com', password: 'a-strong-password' })),
    },
    {
      title: tr('integrations:apiDocsExamples.signInWithPassword'),
      js: `let { data, error } = await supabase.auth.signInWithPassword({\n  email: 'someone@email.com',\n  password: 'a-strong-password',\n})`,
      bash: base('POST', auth('token?grant_type=password'), JSON.stringify({ email: 'someone@email.com', password: 'a-strong-password' })),
    },
    {
      title: tr('integrations:apiDocsExamples.signInWithMagicLink'),
      description: tr('integrations:apiDocsExamples.magicLinkDescription'),
      js: `let { data, error } = await supabase.auth.signInWithOtp({\n  email: 'someone@email.com',\n})`,
      bash: base('POST', auth('magiclink'), JSON.stringify({ email: 'someone@email.com' })),
    },
    {
      title: tr('integrations:apiDocsExamples.signInWithPhoneCode'),
      description: tr('integrations:apiDocsExamples.phoneCodeDescription'),
      js: `let { data, error } = await supabase.auth.signInWithOtp({\n  phone: '+13334445555',\n})\n\n// then, with the code they received:\nlet { data: session, error: verifyError } = await supabase.auth.verifyOtp({\n  phone: '+13334445555',\n  token: '123456',\n  type: 'sms',\n})`,
      bash: `${base('POST', auth('otp'), JSON.stringify({ phone: '+13334445555' }))}\n\n# then, with the code they received:\n${base('POST', auth('verify'), JSON.stringify({ type: 'sms', phone: '+13334445555', token: '123456' }))}`,
    },
    {
      title: tr('integrations:apiDocsExamples.signInWithProvider'),
      description: tr('integrations:apiDocsExamples.providerDescription'),
      js: `let { data, error } = await supabase.auth.signInWithOAuth({\n  provider: 'github',\n})`,
      bash: `# Open in a browser:\n${auth('authorize?provider=github')}`,
    },
    {
      title: tr('integrations:apiDocsExamples.getSignedInUser'),
      js: `const { data: { user } } = await supabase.auth.getUser()`,
      bash: base('GET', auth('user'), undefined, true),
    },
    {
      title: tr('integrations:apiDocsExamples.sendPasswordReset'),
      js: `let { data, error } = await supabase.auth.resetPasswordForEmail('someone@email.com')`,
      bash: base('POST', auth('recover'), JSON.stringify({ email: 'someone@email.com' })),
    },
    {
      title: tr('integrations:apiDocsExamples.updateTheUser'),
      js: `const { data, error } = await supabase.auth.updateUser({\n  data: { hello: 'world' },\n})`,
      bash: base('PUT', auth('user'), JSON.stringify({ data: { hello: 'world' } }), true),
    },
    {
      title: tr('integrations:apiDocsExamples.signOut'),
      js: `let { error } = await supabase.auth.signOut()`,
      bash: base('POST', auth('logout'), undefined, true),
    },
  ]
}

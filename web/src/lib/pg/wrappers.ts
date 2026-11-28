/*
 * Wrappers: Supabase's foreign data wrappers (the `wrappers` extension),
 * which expose Stripe, S3, BigQuery and other services as Postgres tables.
 *
 * The wrapper types come from Supabase Studio's definitions (wrapper-types.json,
 * made by scripts/import-wrappers.mjs). The SQL follows Studio's: one foreign
 * data wrapper per type, one server per connection with its secrets in Vault,
 * then foreign tables or an imported foreign schema. Unlike Studio, secret
 * values go to Vault as bound parameters, so they never appear in SQL text.
 */
import data from './wrapper-types.json'
import { ident, literal, qualified } from './sql'
import { t as tr } from '@/lib/i18n'

export interface WrapperOption {
  name: string
  label: string
  description?: string
  required: boolean
  /** Stored in Vault; the server option holds the secret's id. */
  encrypted: boolean
  secureEntry: boolean
  hidden?: boolean
  isTextArea?: boolean
  urlHelper?: string
  defaultValue?: string
  readOnly?: boolean
}

export type TableOption = {
  name: string
  label?: string
  placeholder?: string
  defaultValue?: string
  editable: boolean
  required: boolean
} & ({ type: 'text' } | { type: 'select'; options: { label: string; value: string }[] })

export interface TableTemplate {
  label: string
  description?: string
  availableColumns?: Column[]
  options: TableOption[]
}

export interface Column {
  name: string
  type: string
}

export interface WrapperType {
  name: string
  label: string
  description: string
  handlerName: string
  validatorName: string
  docsUrl: string
  minimumExtensionVersion?: string
  canTargetSchema?: boolean
  sourceSchemaOption?: WrapperOption
  categories: string[]
  server: { options: WrapperOption[] }
  tables: TableTemplate[]
}

export const WRAPPER_TYPES = data.wrappers as WrapperType[]
export const WRAPPER_TYPES_SOURCE = data.source

/** Set on the server when it targets a whole schema (Studio's convention). */
const TARGET_SCHEMA_OPTION = 'supabase_target_schema'

/** Whether the type can import a whole remote schema. */
export const canImportSchema = (t: WrapperType) => !!t.canTargetSchema && !!t.sourceSchemaOption

/** Whether the installed extension (e.g. 0.6.1) is at least `min`. */
export function versionAtLeast(installed: string | null | undefined, min: string | undefined): boolean {
  if (!min) return true
  if (!installed) return false
  const a = installed.split('.').map((n) => parseInt(n, 10) || 0)
  const b = min.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  }
  return true
}

/** A foreign server whose wrapper comes from the wrappers extension. */
export interface WrapperServer {
  id: number
  fdw: string
  server: string
  handler: string
  options: string[] | null
  tables: { schema: string; name: string; columns: number; options: string[] | null }[]
}

export const WRAPPER_SERVERS_SQL = `
select s.oid::int as id, w.fdwname as fdw, s.srvname as server, h.proname as handler,
  to_json(s.srvoptions) as options,
  coalesce((
    select json_agg(json_build_object(
      'schema', c.relnamespace::regnamespace::text, 'name', c.relname,
      'columns', (select count(*) from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped),
      'options', to_json(t.ftoptions)) order by c.relnamespace::regnamespace::text, c.relname)
    from pg_foreign_table t join pg_class c on c.oid = t.ftrelid
    where t.ftserver = s.oid), '[]') as tables
from pg_foreign_server s
join pg_foreign_data_wrapper w on w.oid = s.srvfdw
join pg_proc h on h.oid = w.fdwhandler
where exists (
  select 1 from pg_depend d join pg_extension e on e.oid = d.refobjid
  where d.classid = 'pg_proc'::regclass and d.objid = h.oid and e.extname = 'wrappers')
order by s.srvname`

/** Parses Postgres's ["key=value", …] option lists. */
export function parseOptions(options: string[] | null | undefined): Record<string, string> {
  return Object.fromEntries(
    (options ?? []).map((o) => {
      const i = o.indexOf('=')
      return i === -1 ? [o, ''] : [o.slice(0, i), o.slice(i + 1)]
    })
  )
}

/** Which type a server is: by wrapper name, else by package (Wasm) or handler. */
export function typeOf(s: Pick<WrapperServer, 'fdw' | 'handler' | 'options'>): WrapperType | undefined {
  const byName = WRAPPER_TYPES.find((t) => t.name === s.fdw)
  if (byName) return byName
  const pkg = parseOptions(s.options).fdw_package_name
  if (pkg) return WRAPPER_TYPES.find((t) => t.server.options.some((o) => o.name === 'fdw_package_name' && o.defaultValue === pkg))
  return WRAPPER_TYPES.find((t) => t.handlerName === s.handler && t.handlerName !== 'wasm_fdw_handler')
}

/**
 * A server's options as they may be shown: values only for options its type
 * lists as plain settings; secrets (held in Vault) and anything else, such as
 * credentials written straight into the options, stay masked.
 */
export interface DisplayOption {
  name: string
  /** null when masked. */
  value: string | null
  /** Masked because the value is a Vault secret's id. */
  vault: boolean
}

export function displayOptions(s: Pick<WrapperServer, 'fdw' | 'handler' | 'options'>): DisplayOption[] {
  const type = typeOf(s)
  return Object.entries(parseOptions(s.options)).flatMap(([name, value]): DisplayOption[] => {
    const o = type?.server.options.find((x) => x.name === name)
    if (o?.hidden) return []
    if (o?.encrypted) return [{ name, value: null, vault: true }]
    return [{ name, value: o && !o.secureEntry ? value : null, vault: false }]
  })
}

/** The Vault secret ids a server's options hold. */
export function wrapperSecretIds(s: Pick<WrapperServer, 'fdw' | 'handler' | 'options'>): string[] {
  const type = typeOf(s)
  const options = parseOptions(s.options)
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  return (type?.server.options ?? []).filter((o) => o.encrypted && uuid.test(options[o.name] ?? '')).map((o) => options[o.name]!)
}

/** The schema a server's tables were imported into, if any. */
export const importedSchema = (s: Pick<WrapperServer, 'options'>): string | null => parseOptions(s.options)[TARGET_SCHEMA_OPTION] || null

/** The Vault secret name for a server's secret option (Studio's convention). */
export const secretName = (server: string, option: string) => `${server}_${option}`

const NAME = /^[a-z_][a-z0-9_]{0,62}$/
/** Problems with a wrapper's, schema's or table's name; null if fine. */
export function nameProblem(name: string, what: 'wrapper' | 'schema' | 'table'): string | null {
  if (!name) {
    if (what === 'wrapper') return tr('integrations:wrappers.enterAWrapperName')
    if (what === 'schema') return tr('integrations:wrappers.enterASchemaName')
    return tr('integrations:wrappers.enterATableName')
  }
  if (!NAME.test(name)) {
    if (what === 'wrapper') return tr('integrations:wrappers.wrapperNameRule')
    if (what === 'schema') return tr('integrations:wrappers.schemaNameRule')
    return tr('integrations:wrappers.tableNameRule')
  }
  return null
}

/** Column names must match the remote ones, so any case is fine; quoting does the rest. */
export function columnProblem(name: string): string | null {
  if (!name) return tr('integrations:wrappers.enterAColumnName')
  if (name.includes('\0')) return tr('integrations:wrappers.columnNamesCanTContainNul')
  if (new TextEncoder().encode(name).length > 63) return tr('integrations:wrappers.columnNameIsLongerThan63', { name })
  return null
}

// Type names: words, an optional (n) or (p,s), optional []. Not a parser; it
// keeps typed-in column types from carrying anything but a type.
const TYPE = /^[a-z_][a-z0-9_]*( [a-z_][a-z0-9_]*)*(\(\d+(, ?\d+)?\))?(\[\])?$/i
export function typeProblem(type: string): string | null {
  return TYPE.test(type.trim()) ? null : tr('integrations:wrappers.notAPostgresType', { type })
}

export interface TableDraft {
  template: number
  schema: string
  /** Create the schema first. */
  newSchema: boolean
  name: string
  columns: Column[]
  options: Record<string, string>
}

export interface WrapperDraft {
  type: WrapperType
  server: string
  /** Server option values, secrets included (they never go into SQL text). */
  values: Record<string, string>
  mode: 'tables' | 'schema'
  tables: TableDraft[]
  /** Schema mode: the new local schema, and the remote one to import. */
  targetSchema: string
  sourceSchema: string
}

/** The secrets to put in Vault first: [name, value, option]. */
export function draftSecrets(d: WrapperDraft): { name: string; value: string; option: string }[] {
  return d.type.server.options
    .filter((o) => o.encrypted && (d.values[o.name] ?? '') !== '')
    .map((o) => ({ name: secretName(d.server, o.name), value: d.values[o.name]!, option: o.name }))
}

/** $1 value, $2 name, $3 description; returns the secret's id. */
export const CREATE_WRAPPER_SECRET_SQL = `select vault.create_secret($1, $2, $3)::text as id`
/** $1 a JSON array of ids. */
export const DELETE_SECRETS_SQL = `delete from vault.secrets where id in (select json_array_elements_text($1::json)::uuid)`

function createTableSql(t: TableDraft, server: string): string {
  const options = Object.entries(t.options).filter(([, v]) => v !== '')
  return [
    `create foreign table ${qualified(t.schema, t.name)} (`,
    t.columns.map((c) => `  ${ident(c.name)} ${c.type.trim()}`).join(',\n'),
    `)`,
    `server ${ident(server)}`,
    options.length ? `options (${options.map(([k, v]) => `${ident(k)} ${literal(v)}`).join(', ')})` : '',
  ]
    .filter(Boolean)
    .join('\n')
    .concat(';')
}

/**
 * The script that creates the wrapper, server and tables, given the Vault ids
 * of its secrets. Holds no secret values. Runs as one transaction.
 */
export function createWrapperSql(d: WrapperDraft, secretIds: Record<string, string>): string {
  const { type } = d
  const parts: string[] = []
  const schemas = new Set<string>()
  if (d.mode === 'schema') schemas.add(d.targetSchema)
  else for (const t of d.tables) if (t.newSchema) schemas.add(t.schema)
  for (const s of schemas) parts.push(`create schema if not exists ${ident(s)};`)

  // One wrapper per type, shared by every server of that type.
  parts.push(`do $$
begin
  if not exists (select 1 from pg_foreign_data_wrapper where fdwname = ${literal(type.name)}) then
    execute format('create foreign data wrapper %I handler %I validator %I', ${literal(type.name)}, ${literal(type.handlerName)}, ${literal(type.validatorName)});
  end if;
end $$;`)

  const opts: [string, string][] = []
  for (const o of type.server.options) {
    if (o.name === TARGET_SCHEMA_OPTION) {
      if (d.mode === 'schema') opts.push([o.name, d.targetSchema])
      continue
    }
    if (o.encrypted) {
      const id = secretIds[o.name]
      if (id) opts.push([o.name, id])
      continue
    }
    const v = d.values[o.name] ?? o.defaultValue ?? ''
    if (v !== '') opts.push([o.name, v])
  }
  parts.push(
    `create server ${ident(d.server)} foreign data wrapper ${ident(type.name)}` +
      (opts.length ? ` options (${opts.map(([k, v]) => `${ident(k)} ${literal(v)}`).join(', ')})` : '') +
      ';'
  )

  if (d.mode === 'tables') {
    for (const t of d.tables) parts.push(createTableSql(t, d.server))
  } else if (canImportSchema(type) && d.sourceSchema) {
    parts.push(`import foreign schema ${ident(d.sourceSchema)} from server ${ident(d.server)} into ${ident(d.targetSchema)} options (strict 'true');`)
  }
  return parts.join('\n\n')
}

/** Problems that stop a draft being created; empty when it's ready. */
export function draftProblems(
  d: WrapperDraft,
  taken: { servers: string[]; schemas: string[]; secrets: string[]; /** schema.name of existing tables, views, … */ relations?: string[] }
): string[] {
  const out: string[] = []
  const server = nameProblem(d.server, 'wrapper')
  if (server) out.push(server)
  else if (taken.servers.includes(d.server)) out.push(tr('integrations:wrappers.aWrapperCalledAlreadyExists', { server: d.server }))
  for (const o of d.type.server.options) {
    if (o.hidden || o.readOnly || !o.required) continue
    if ((d.values[o.name] ?? o.defaultValue ?? '') === '') out.push(`Enter ${o.label}`)
  }
  for (const s of draftSecrets(d)) {
    if (taken.secrets.includes(s.name)) out.push(tr('integrations:wrappers.aVaultSecretCalledAlreadyExists', { name: s.name }))
  }
  if (d.mode === 'schema') {
    if (!canImportSchema(d.type)) out.push(`${d.type.label} can't import a schema; choose foreign tables`)
    const p = nameProblem(d.targetSchema, 'schema')
    if (p) out.push(p)
    else if (taken.schemas.includes(d.targetSchema)) out.push(tr('integrations:wrappers.schemaAlreadyExistsImportedTablesNeed', { targetSchema: d.targetSchema }))
  } else {
    if (d.tables.length === 0) out.push(tr('integrations:wrappers.addAtLeastOneTable'))
    const seen = new Set<string>()
    d.tables.forEach((t, i) => {
      const label = `Table ${i + 1}`
      const p = nameProblem(t.schema, 'schema') ?? nameProblem(t.name, 'table')
      if (p) out.push(`${label}: ${p}`)
      const key = `${t.schema}.${t.name}`
      if (seen.has(key)) out.push(`${label}: ${key} is used twice`)
      else if (taken.relations?.includes(key)) out.push(`${label}: ${key} already exists`)
      seen.add(key)
      if (t.columns.length === 0) out.push(`${label}: add at least one column`)
      const names = new Set<string>()
      for (const c of t.columns) {
        const cp = columnProblem(c.name) ?? typeProblem(c.type)
        if (cp) out.push(`${label}: ${cp}`)
        else if (names.has(c.name)) out.push(`${label}: column ${c.name} is listed twice`)
        names.add(c.name)
      }
      const template = d.type.tables[t.template]
      for (const o of template?.options ?? []) {
        if (o.required && (t.options[o.name] ?? '') === '') out.push(`${label}: enter ${o.label ?? o.name}`)
      }
    })
  }
  return out
}

/** A new table from a template: its defaults, every column it offers. */
export function tableFromTemplate(type: WrapperType, template: number, schema = 'public'): TableDraft {
  const t = type.tables[template]!
  const base = t.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return {
    template,
    schema,
    newSchema: false,
    name: base ? `${type.name.replace(/_wrapper$/, '')}_${base}` : '',
    columns: (t.availableColumns ?? []).map((c) => ({ ...c })),
    options: Object.fromEntries(t.options.map((o) => [o.name, o.defaultValue ?? ''])),
  }
}

/**
 * Drops a server and its tables, the wrapper once no server uses it, the
 * schema its tables were imported into once it's empty, and the server's
 * Vault secrets that no other server refers to. One transaction.
 */
export function dropWrapperSql(s: WrapperServer): string {
  const schema = importedSchema(s)
  return [
    `drop server ${ident(s.server)} cascade;`,
    `do $$
begin
  if not exists (select 1 from pg_foreign_server sv join pg_foreign_data_wrapper w on w.oid = sv.srvfdw where w.fdwname = ${literal(s.fdw)}) then
    execute format('drop foreign data wrapper %I', ${literal(s.fdw)});
  end if;
end $$;`,
    ...(schema
      ? [
          // Without cascade: anything else in the schema keeps it.
          `do $$
begin
  if exists (select 1 from pg_namespace where nspname = ${literal(schema)}) then
    execute format('drop schema %I', ${literal(schema)});
  end if;
exception when dependent_objects_still_exist then null;
end $$;`,
        ]
      : []),
    ...wrapperSecretIds(s).map(
      (id) => `delete from vault.secrets where id = ${literal(id)}::uuid
  and not exists (select 1 from pg_foreign_server sv, unnest(sv.srvoptions) o where substr(o, strpos(o, '=') + 1) = ${literal(id)});`
    ),
  ].join('\n\n')
}

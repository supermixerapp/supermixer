/*
 * Catalog queries and DDL for the Database pages. Reads go through the
 * read-only path; schema/table names are always quoted; expressions the user
 * writes (function bodies, policy conditions) are inserted as SQL on purpose.
 */
import { ident, literal, qualified } from './sql'

// ---------------------------------------------------------------- tables

export interface TableStat {
  id: number
  name: string
  comment: string | null
  rls: boolean
  estimate: number
  size: string
  columns: number
  realtime: boolean
}

/** Tables in a schema ($1) with size and Realtime status. */
export const TABLE_STATS_SQL = `
select c.oid::int as id, c.relname as name, obj_description(c.oid, 'pg_class') as comment, c.relrowsecurity as rls,
       greatest(c.reltuples, 0)::float8 as estimate, pg_size_pretty(pg_total_relation_size(c.oid)) as size,
       (select count(*)::int from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped) as columns,
       exists (select 1 from pg_publication_tables p where p.pubname = 'supabase_realtime' and p.schemaname = n.nspname and p.tablename = c.relname) as realtime
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = $1 and c.relkind in ('r', 'p')
order by c.relname`

// ------------------------------------------------------------- functions

export interface FunctionRow {
  id: number
  name: string
  /** Types only, for DROP and identifying the function. */
  args: string
  /** As declared, with names, defaults and OUT parameters, for editing. */
  full_args: string
  returns: string
  language: string
  security_definer: boolean
  kind: 'f' | 'p' | 'a' | 'w'
  /** null when the body can't be edited here (C, or a begin atomic SQL body). */
  definition: string | null
  config: string[] | null
}

export const FUNCTIONS_SQL = `
select p.oid::int as id, p.proname as name, pg_get_function_identity_arguments(p.oid) as args,
       pg_get_function_arguments(p.oid) as full_args,
       pg_get_function_result(p.oid) as returns, l.lanname as language, p.prosecdef as security_definer,
       p.prokind as kind,
       case when l.lanname in ('sql', 'plpgsql') and p.prosqlbody is null then p.prosrc end as definition,
       to_json(p.proconfig) as config
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
join pg_language l on l.oid = p.prolang
where n.nspname = $1 and p.prokind in ('f', 'p')
  and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
order by p.proname`

export interface FunctionDef {
  schema: string
  name: string
  args: string // e.g. "user_id uuid, amount numeric default 0"
  returns: string // e.g. "void", "trigger", "setof public.todos"
  language: 'plpgsql' | 'sql'
  body: string
  securityDefiner: boolean
  /** '' = empty search_path (Studio's default, names must be qualified); null = none set. */
  searchPath: string | null
  /** Other SET clauses the function already has, kept as they are. */
  settings?: { name: string; value: string }[]
}

/** Split pg_proc.proconfig ("search_path=public, extensions") into a FunctionDef's parts. */
export function parseProconfig(config: string[] | null): Pick<FunctionDef, 'searchPath' | 'settings'> {
  let searchPath: string | null = null
  const settings: { name: string; value: string }[] = []
  for (const entry of config ?? []) {
    const i = entry.indexOf('=')
    const name = entry.slice(0, i)
    const value = entry.slice(i + 1)
    if (name === 'search_path') searchPath = value === '""' || value === "''" ? '' : value
    else settings.push({ name, value })
  }
  return { searchPath, settings }
}

/** A dollar-quote tag that does not occur in body. */
export function dollarTag(body: string): string {
  let tag = '$sm$'
  for (let i = 1; body.includes(tag); i++) tag = `$sm${i}$`
  return tag
}

export function createFunction(f: FunctionDef): string {
  const tag = dollarTag(f.body)
  return [
    `create or replace function ${qualified(f.schema, f.name)}(${f.args})`,
    `returns ${f.returns}`,
    `language ${f.language}`,
    f.securityDefiner ? 'security definer' : 'security invoker',
    // search_path values come from the catalog or the form; they are a list of names.
    ...(f.searchPath === null ? [] : [`set search_path = ${f.searchPath === '' ? "''" : f.searchPath}`]),
    ...(f.settings ?? []).map((s) => `set ${ident(s.name)} = ${literal(s.value)}`),
    `as ${tag}`,
    f.body,
    `${tag};`,
  ].join('\n')
}

/** identityArgs comes from pg_get_function_identity_arguments, so it is valid SQL. */
export function dropFunction(schema: string, name: string, identityArgs: string, kind: 'f' | 'p' = 'f'): string {
  return `drop ${kind === 'p' ? 'procedure' : 'function'} ${qualified(schema, name)}(${identityArgs});`
}

// -------------------------------------------------------------- triggers

export interface TriggerRow {
  id: number
  name: string
  table: string
  function_schema: string
  function_name: string
  timing: 'BEFORE' | 'AFTER' | 'INSTEAD OF'
  events: string[]
  level: 'ROW' | 'STATEMENT'
  enabled: boolean
}

export const TRIGGERS_SQL = `
select t.oid::int as id, t.tgname as name, c.relname as "table", fn.nspname as function_schema, p.proname as function_name,
       case when t.tgtype & 2 = 2 then 'BEFORE' when t.tgtype & 64 = 64 then 'INSTEAD OF' else 'AFTER' end as timing,
       to_json(array_remove(array[
         case when t.tgtype & 4 = 4 then 'INSERT' end,
         case when t.tgtype & 16 = 16 then 'UPDATE' end,
         case when t.tgtype & 8 = 8 then 'DELETE' end,
         case when t.tgtype & 32 = 32 then 'TRUNCATE' end], null)) as events,
       case when t.tgtype & 1 = 1 then 'ROW' else 'STATEMENT' end as level,
       t.tgenabled <> 'D' as enabled
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
join pg_proc p on p.oid = t.tgfoid
join pg_namespace fn on fn.oid = p.pronamespace
where n.nspname = $1 and not t.tgisinternal
order by c.relname, t.tgname`

/** Functions returning trigger, for the trigger form. */
export const TRIGGER_FUNCTIONS_SQL = `
select n.nspname as schema, p.proname as name
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where p.prorettype = 'trigger'::regtype
  and n.nspname not in ('pg_catalog', 'information_schema')
order by 1, 2`

export interface TriggerDef {
  schema: string
  table: string
  name: string
  timing: 'before' | 'after'
  events: ('insert' | 'update' | 'delete')[]
  level: 'row' | 'statement'
  functionSchema: string
  functionName: string
}

export function createTrigger(t: TriggerDef): string {
  return `create trigger ${ident(t.name)} ${t.timing} ${t.events.join(' or ')} on ${qualified(t.schema, t.table)}
for each ${t.level} execute function ${qualified(t.functionSchema, t.functionName)}();`
}

export function dropTrigger(schema: string, table: string, name: string): string {
  return `drop trigger ${ident(name)} on ${qualified(schema, table)};`
}

export function setTriggerEnabled(schema: string, table: string, name: string, enabled: boolean): string {
  return `alter table ${qualified(schema, table)} ${enabled ? 'enable' : 'disable'} trigger ${ident(name)};`
}

// ----------------------------------------------------------------- enums

export interface EnumRow {
  id: number
  name: string
  values: string[]
}

export const ENUMS_SQL = `
select t.oid::int as id, t.typname as name, to_json(array_agg(e.enumlabel order by e.enumsortorder)) as values
from pg_type t join pg_namespace n on n.oid = t.typnamespace join pg_enum e on e.enumtypid = t.oid
where n.nspname = $1
group by t.oid, t.typname
order by t.typname`

export function createEnum(schema: string, name: string, values: string[]): string {
  return `create type ${qualified(schema, name)} as enum (${values.map(literal).join(', ')});`
}

export function addEnumValue(schema: string, name: string, value: string): string {
  return `alter type ${qualified(schema, name)} add value ${literal(value)};`
}

export function dropType(schema: string, name: string): string {
  return `drop type ${qualified(schema, name)};`
}

// ------------------------------------------------------------ extensions

export interface ExtensionRow {
  name: string
  default_version: string
  installed_version: string | null
  schema: string | null
  comment: string | null
  /** Schema the extension's control file insists on (e.g. pg_cron → pg_catalog). */
  required_schema: string | null
  relocatable: boolean
}

export const EXTENSIONS_SQL = `
select a.name, a.default_version, a.installed_version, n.nspname as schema, a.comment,
       v.schema as required_schema, coalesce(v.relocatable, false) as relocatable
from pg_available_extensions a
left join pg_available_extension_versions v on v.name = a.name and v.version = a.default_version
left join pg_extension e on e.extname = a.name
left join pg_namespace n on n.oid = e.extnamespace
order by a.name`

/** schema null: the extension installs into the schema its control file names. */
export function enableExtension(name: string, schema: string | null): string {
  return `create extension if not exists ${ident(name)}${schema ? ` with schema ${ident(schema)}` : ''};`
}

export function disableExtension(name: string): string {
  return `drop extension if exists ${ident(name)};`
}

// --------------------------------------------------------------- indexes

export interface IndexRow {
  id: number
  name: string
  table: string
  definition: string
  primary: boolean
  unique: boolean
  size: string
}

export const INDEXES_SQL = `
select i.indexrelid::int as id, ic.relname as name, tc.relname as "table", pg_get_indexdef(i.indexrelid) as definition,
       i.indisprimary as primary, i.indisunique as unique, pg_size_pretty(pg_relation_size(i.indexrelid)) as size
from pg_index i
join pg_class ic on ic.oid = i.indexrelid
join pg_class tc on tc.oid = i.indrelid
join pg_namespace n on n.oid = tc.relnamespace
where n.nspname = $1
order by tc.relname, ic.relname`

export const INDEX_METHODS = ['btree', 'hash', 'gin', 'gist', 'brin'] as const

export function createIndex(schema: string, table: string, columns: string[], method: (typeof INDEX_METHODS)[number], unique: boolean): string {
  return `create ${unique ? 'unique ' : ''}index on ${qualified(schema, table)} using ${method} (${columns.map(ident).join(', ')});`
}

export function dropIndex(schema: string, name: string): string {
  return `drop index ${qualified(schema, name)};`
}

// ---------------------------------------------------------- publications

export interface PublicationRow {
  name: string
  insert: boolean
  update: boolean
  delete: boolean
  truncate: boolean
  all_tables: boolean
  tables: string[]
}

export const PUBLICATIONS_SQL = `
select p.pubname as name, p.pubinsert as insert, p.pubupdate as update, p.pubdelete as delete, p.pubtruncate as truncate,
       p.puballtables as all_tables,
       coalesce((select json_agg(t.schemaname || '.' || t.tablename order by t.schemaname, t.tablename) from pg_publication_tables t where t.pubname = p.pubname), '[]') as tables
from pg_publication p
order by p.pubname`

export function setPublicationEvents(name: string, events: string[]): string {
  return `alter publication ${ident(name)} set (publish = ${literal(events.join(', '))});`
}

export function setPublicationTable(name: string, schema: string, table: string, add: boolean): string {
  return `alter publication ${ident(name)} ${add ? 'add' : 'drop'} table ${qualified(schema, table)};`
}

// ----------------------------------------------------------------- roles

export interface RoleRow {
  name: string
  login: boolean
  superuser: boolean
  create_role: boolean
  create_db: boolean
  replication: boolean
  bypass_rls: boolean
  connection_limit: number
  connections: number
  inherit: boolean
  /** Full timestamp (ISO), kept exact so saving doesn't move it. */
  valid_until: string | null
}

export const ROLES_SQL = `
select r.rolname as name, r.rolcanlogin as login, r.rolsuper as superuser, r.rolcreaterole as create_role,
       r.rolcreatedb as create_db, r.rolreplication as replication, r.rolbypassrls as bypass_rls,
       r.rolconnlimit as connection_limit, r.rolinherit as inherit,
       case when r.rolvaliduntil is null or r.rolvaliduntil = 'infinity' then null else to_json(r.rolvaliduntil) end as valid_until,
       (select count(*)::int from pg_stat_activity a where a.usename = r.rolname) as connections
from pg_roles r
where r.rolname not like 'pg\\_%'
order by r.rolname`

// -------------------------------------------------------------- policies

export interface PolicyRow {
  id: number
  table: string
  name: string
  command: 'ALL' | 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE'
  permissive: boolean
  roles: string[]
  using: string | null
  check: string | null
}

export interface PolicyTableRow {
  id: number
  name: string
  rls: boolean
  forced: boolean
}

export const POLICY_TABLES_SQL = `
select c.oid::int as id, c.relname as name, c.relrowsecurity as rls, c.relforcerowsecurity as forced
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = $1 and c.relkind in ('r', 'p')
order by c.relname`

export const POLICIES_SQL = `
select p.oid::int as id, c.relname as "table", p.polname as name,
       case p.polcmd when 'r' then 'SELECT' when 'a' then 'INSERT' when 'w' then 'UPDATE' when 'd' then 'DELETE' else 'ALL' end as command,
       p.polpermissive as permissive,
       to_json(case when p.polroles = '{0}' then array['public']::name[] else (select array_agg(rolname order by rolname) from pg_roles where oid = any(p.polroles)) end) as roles,
       pg_get_expr(p.polqual, p.polrelid) as using, pg_get_expr(p.polwithcheck, p.polrelid) as check
from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace
where n.nspname = $1
order by c.relname, p.polname`

export interface PolicyDef {
  schema: string
  table: string
  name: string
  command: PolicyRow['command']
  permissive: boolean
  roles: string[] // empty = public
  using: string
  check: string
}

export function createPolicy(p: PolicyDef): string {
  const lines = [
    `create policy ${ident(p.name)}`,
    `on ${qualified(p.schema, p.table)}`,
    `as ${p.permissive ? 'permissive' : 'restrictive'}`,
    `for ${p.command.toLowerCase()}`,
    `to ${p.roles.length ? p.roles.map(ident).join(', ') : 'public'}`,
  ]
  // INSERT policies only take WITH CHECK; SELECT and DELETE only USING.
  if (p.using.trim() && p.command !== 'INSERT') lines.push(`using (${p.using.trim()})`)
  if (p.check.trim() && p.command !== 'SELECT' && p.command !== 'DELETE') lines.push(`with check (${p.check.trim()})`)
  return `${lines.join('\n')};`
}

export function dropPolicy(schema: string, table: string, name: string): string {
  return `drop policy ${ident(name)} on ${qualified(schema, table)};`
}

/** Studio's policy templates, adapted. */
export interface PolicyTemplate {
  title: string
  /** Policy name to use; defaults to the title. */
  name?: string
  command: PolicyRow['command']
  roles: string[]
  using: string
  check: string
}

/**
 * "<bucket>: <what>", kept within Postgres's 63-byte identifier limit. A long
 * bucket name is shortened and given a short hash, so two long names that
 * share a beginning still get different policy names.
 */
export function bucketPolicyName(bucket: string, what: string): string {
  const enc = new TextEncoder()
  const full = `${bucket}: ${what}`
  if (enc.encode(full).length <= 63) return full
  let h = 5381
  for (const ch of bucket) h = ((h * 33) ^ ch.codePointAt(0)!) >>> 0
  const tag = `~${h.toString(36).slice(0, 5)}`
  const room = 63 - enc.encode(`${tag}: ${what}`).length
  let short = ''
  for (const ch of bucket) {
    if (enc.encode(short + ch).length > room) break
    short += ch
  }
  return `${short}${tag}: ${what}`
}

/** Storage policies for one bucket, as Studio offers them. */
export function storagePolicyTemplates(bucket: string): PolicyTemplate[] {
  const b = `bucket_id = ${literal(bucket)}`
  const ownFolder = `${b} and (select auth.uid()::text) = (storage.foldername(name))[1]`
  return [
    { title: `Allow public read access to ${bucket}`, name: bucketPolicyName(bucket, 'public read'), command: 'SELECT', roles: [], using: b, check: '' },
    {
      title: `Allow authenticated uploads to ${bucket}`,
      name: bucketPolicyName(bucket, 'authenticated uploads'),
      command: 'INSERT',
      roles: ['authenticated'],
      using: '',
      check: b,
    },
    {
      title: `Give users access to their own folder in ${bucket}`,
      name: bucketPolicyName(bucket, 'own folder'),
      command: 'ALL',
      roles: ['authenticated'],
      using: ownFolder,
      check: ownFolder,
    },
    {
      title: `Allow users to delete files they uploaded to ${bucket}`,
      name: bucketPolicyName(bucket, 'delete own files'),
      command: 'DELETE',
      roles: ['authenticated'],
      using: `${b} and owner_id = (select auth.uid()::text)`,
      check: '',
    },
  ]
}

export const POLICY_TEMPLATES: PolicyTemplate[] = [
  { title: 'Enable read access for all users', command: 'SELECT', roles: [], using: 'true', check: '' },
  { title: 'Enable insert for authenticated users only', command: 'INSERT', roles: ['authenticated'], using: '', check: 'true' },
  {
    title: 'Enable update for users based on user_id',
    command: 'UPDATE',
    roles: ['authenticated'],
    using: '(select auth.uid()) = user_id',
    check: '(select auth.uid()) = user_id',
  },
  { title: 'Enable delete for users based on user_id', command: 'DELETE', roles: ['authenticated'], using: '(select auth.uid()) = user_id', check: '' },
]

/** Realtime Authorization: policies on realtime.messages for private channels. */
export const REALTIME_POLICY_TEMPLATES: PolicyTemplate[] = [
  {
    title: 'Allow authenticated users to receive broadcasts',
    command: 'SELECT',
    roles: ['authenticated'],
    using: "realtime.messages.extension in ('broadcast')",
    check: '',
  },
  {
    title: 'Allow authenticated users to send broadcasts',
    command: 'INSERT',
    roles: ['authenticated'],
    using: '',
    check: "realtime.messages.extension in ('broadcast')",
  },
  {
    title: 'Allow authenticated users to listen to presence',
    command: 'SELECT',
    roles: ['authenticated'],
    using: "realtime.messages.extension in ('presence')",
    check: '',
  },
  {
    title: 'Allow authenticated users to track presence',
    command: 'INSERT',
    roles: ['authenticated'],
    using: '',
    check: "realtime.messages.extension in ('presence')",
  },
  {
    title: "Only on a channel named after the user's ID",
    name: 'Users can use their own channel',
    command: 'SELECT',
    roles: ['authenticated'],
    using: '(select realtime.topic()) = (select auth.uid())::text',
    check: '',
  },
]

// ------------------------------------------------------------ migrations

export interface MigrationRow {
  version: string
  name: string | null
  statements: number
}

/** Supabase CLI migrations, when the stack has the table. */
export const MIGRATIONS_SQL = `
select version, name, coalesce(array_length(statements, 1), 0) as statements
from supabase_migrations.schema_migrations
order by version desc`

export const HAS_MIGRATIONS_SQL = `select to_regclass('supabase_migrations.schema_migrations') is not null as present`

// -------------------------------------------------------------- settings

export interface DatabaseSettings {
  version: string
  size: string
  max_connections: number
  connections: number
  statement_timeout: string
  timezone: string
  ssl: string
  wal_level: string
  shared_buffers: string
}

export const SETTINGS_SQL = `
select current_setting('server_version') as version,
       pg_size_pretty(pg_database_size(current_database())) as size,
       current_setting('max_connections')::int as max_connections,
       (select count(*)::int from pg_stat_activity where datname = current_database()) as connections,
       current_setting('statement_timeout') as statement_timeout,
       current_setting('TimeZone') as timezone,
       current_setting('ssl') as ssl,
       current_setting('wal_level') as wal_level,
       current_setting('shared_buffers') as shared_buffers`

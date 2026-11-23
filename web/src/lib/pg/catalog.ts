/*
 * Catalog queries for the Table Editor, read through the read-only path.
 * Results come back as one JSON value so each needs a single round trip.
 */

/** Schemas Supabase manages; Studio shows them but discourages editing. */
export const PROTECTED_SCHEMAS = [
  'auth',
  'storage',
  'realtime',
  '_realtime',
  'extensions',
  'graphql',
  'graphql_public',
  'net',
  'pgbouncer',
  'pgsodium',
  'pgsodium_masks',
  'supabase_functions',
  'supabase_migrations',
  'vault',
  'cron',
  'pgmq',
  '_analytics',
]

export interface SchemaRow {
  name: string
}

export const SCHEMAS_SQL = `
select nspname as name from pg_namespace
where nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
  and nspname not like 'pg_temp%' and nspname not like 'pg_toast_temp%'
order by nspname`

export interface TableListRow {
  id: number
  name: string
  kind: 'r' | 'p' | 'v' | 'm' | 'f'
  rls: boolean
  estimate: number
  comment: string | null
}

/** Tables and views in one schema ($1). */
export const TABLES_SQL = `
select c.oid::int as id, c.relname as name, c.relkind as kind, c.relrowsecurity as rls,
       greatest(c.reltuples, 0)::bigint::text::int as estimate, obj_description(c.oid, 'pg_class') as comment
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = $1 and c.relkind in ('r', 'p', 'v', 'm', 'f')
order by c.relname`

export interface ColumnInfo {
  name: string
  type: string // format_type, e.g. "character varying(255)", "timestamp with time zone"
  udt: string // base type name, e.g. "varchar", "timestamptz", "_text"
  nullable: boolean
  default: string | null
  identity: boolean
  generated: boolean
  pk: boolean
  comment: string | null
  enum: string[] | null
  references: { schema: string; table: string; column: string } | null
}

export interface TableInfo {
  id: number
  schema: string
  name: string
  kind: TableListRow['kind']
  rls: boolean
  comment: string | null
  estimate: number
  columns: ColumnInfo[]
}

/** Everything the grid needs about one table, by oid ($1). */
export const TABLE_SQL = `
select json_build_object(
  'id', c.oid::int, 'schema', n.nspname, 'name', c.relname, 'kind', c.relkind, 'rls', c.relrowsecurity,
  'comment', obj_description(c.oid, 'pg_class'), 'estimate', greatest(c.reltuples, 0)::bigint,
  'columns', coalesce((
    select json_agg(json_build_object(
      'name', a.attname,
      'type', format_type(a.atttypid, a.atttypmod),
      'udt', t.typname,
      'nullable', not a.attnotnull,
      'default', pg_get_expr(d.adbin, d.adrelid),
      'identity', a.attidentity <> '',
      'generated', a.attgenerated <> '',
      'pk', coalesce(a.attnum = any(pk.conkey), false),
      'comment', col_description(c.oid, a.attnum),
      'enum', (select json_agg(e.enumlabel order by e.enumsortorder) from pg_enum e where e.enumtypid = a.atttypid),
      'references', (
        select json_build_object('schema', fn.nspname, 'table', fc.relname, 'column', fa.attname)
        from pg_constraint fk
        join pg_class fc on fc.oid = fk.confrelid
        join pg_namespace fn on fn.oid = fc.relnamespace
        join pg_attribute fa on fa.attrelid = fk.confrelid and fa.attnum = fk.confkey[1]
        where fk.conrelid = c.oid and fk.contype = 'f' and array_length(fk.conkey, 1) = 1 and fk.conkey[1] = a.attnum
        limit 1)
    ) order by a.attnum)
    from pg_attribute a
    join pg_type t on t.oid = a.atttypid
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    left join pg_constraint pk on pk.conrelid = c.oid and pk.contype = 'p'
    where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped), '[]'::json)
) as info
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where c.oid = $1::oid`

/** Types offered when adding a column: common built-ins plus enums. */
export const BUILTIN_TYPES = [
  'int8',
  'int4',
  'int2',
  'numeric',
  'float8',
  'float4',
  'text',
  'varchar',
  'uuid',
  'bool',
  'date',
  'time',
  'timetz',
  'timestamp',
  'timestamptz',
  'interval',
  'json',
  'jsonb',
  'bytea',
  'inet',
] as const

export const ENUM_TYPES_SQL = `
select n.nspname as schema, t.typname as name
from pg_type t join pg_namespace n on n.oid = t.typnamespace
where t.typtype = 'e' and n.nspname not in ('pg_catalog', 'information_schema')
order by 1, 2`

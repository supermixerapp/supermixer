/*
 * SQL for the Table Editor. Names are always quoted with ident(); values
 * always travel as $n parameters, so nothing typed into the grid becomes SQL.
 */
import { ident, literal, qualified } from './sql'

export type FilterOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'ilike' | 'is_null' | 'not_null' | 'in'

export const FILTER_OPS: { value: FilterOp; label: string; needsValue: boolean }[] = [
  { value: 'eq', label: '=', needsValue: true },
  { value: 'neq', label: '<>', needsValue: true },
  { value: 'gt', label: '>', needsValue: true },
  { value: 'gte', label: '>=', needsValue: true },
  { value: 'lt', label: '<', needsValue: true },
  { value: 'lte', label: '<=', needsValue: true },
  { value: 'like', label: 'like', needsValue: true },
  { value: 'ilike', label: 'ilike', needsValue: true },
  { value: 'in', label: 'in (a, b)', needsValue: true },
  { value: 'is_null', label: 'is null', needsValue: false },
  { value: 'not_null', label: 'is not null', needsValue: false },
]

export interface Filter {
  column: string
  op: FilterOp
  value: string
}

export interface Sort {
  column: string
  direction: 'asc' | 'desc'
}

export interface Built {
  sql: string
  params: (string | null)[]
}

const COMPARE: Partial<Record<FilterOp, string>> = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' }

/** WHERE clause for filters; parameters start at $start. */
export function whereClause(filters: Filter[], start = 1): Built {
  const params: (string | null)[] = []
  const parts = filters.map((f) => {
    const col = ident(f.column)
    const next = () => {
      params.push(f.value)
      return `$${start + params.length - 1}`
    }
    switch (f.op) {
      case 'is_null':
        return `${col} is null`
      case 'not_null':
        return `${col} is not null`
      case 'like':
        return `${col}::text like ${next()}`
      case 'ilike':
        return `${col}::text ilike ${next()}`
      case 'in': {
        const items = f.value.split(',').map((v) => v.trim()).filter(Boolean)
        if (items.length === 0) return 'false'
        return `${col}::text in (${items.map((v) => { params.push(v); return `$${start + params.length - 1}` }).join(', ')})`
      }
      default:
        return `${col} ${COMPARE[f.op]} ${next()}`
    }
  })
  return { sql: parts.length ? ` where ${parts.join(' and ')}` : '', params }
}

export function selectRows(schema: string, table: string, opts: { filters: Filter[]; sorts: Sort[]; limit: number; offset: number }): Built {
  const where = whereClause(opts.filters)
  const order = opts.sorts.length ? ` order by ${opts.sorts.map((s) => `${ident(s.column)} ${s.direction}`).join(', ')}` : ''
  return {
    sql: `select * from ${qualified(schema, table)}${where.sql}${order} limit ${Math.trunc(opts.limit)} offset ${Math.trunc(opts.offset)}`,
    params: where.params,
  }
}

export function countRows(schema: string, table: string, filters: Filter[]): Built {
  const where = whereClause(filters)
  return { sql: `select count(*)::text as count from ${qualified(schema, table)}${where.sql}`, params: where.params }
}

/** Primary key values identify a row; null-safe so rows with odd keys still match exactly. */
function pkWhere(pk: Record<string, string | null>, start: number): Built {
  const params: (string | null)[] = []
  const sql = Object.entries(pk)
    .map(([col, v]) => {
      params.push(v)
      return `${ident(col)} is not distinct from $${start + params.length - 1}`
    })
    .join(' and ')
  return { sql, params }
}

export function updateRow(schema: string, table: string, values: Record<string, string | null>, pk: Record<string, string | null>): Built {
  const cols = Object.keys(values)
  const set = cols.map((c, i) => `${ident(c)} = $${i + 1}`).join(', ')
  const where = pkWhere(pk, cols.length + 1)
  return {
    sql: `update ${qualified(schema, table)} set ${set} where ${where.sql}`,
    params: [...cols.map((c) => values[c] ?? null), ...where.params],
  }
}

/** Columns left out of values get their default. */
export function insertRow(schema: string, table: string, values: Record<string, string | null>): Built {
  const cols = Object.keys(values)
  if (cols.length === 0) return { sql: `insert into ${qualified(schema, table)} default values`, params: [] }
  return {
    sql: `insert into ${qualified(schema, table)} (${cols.map(ident).join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    params: cols.map((c) => values[c] ?? null),
  }
}

/** Delete rows by primary key, in one statement so it is all or nothing. */
export function deleteRows(schema: string, table: string, pks: Record<string, string | null>[]): Built {
  const params: (string | null)[] = []
  const conds = pks.map((pk) => {
    const w = pkWhere(pk, params.length + 1)
    params.push(...w.params)
    return `(${w.sql})`
  })
  return { sql: `delete from ${qualified(schema, table)} where ${conds.join(' or ') || 'false'}`, params }
}

// ------------------------------------------------------------------ schema

export interface ColumnDef {
  name: string
  type: string // a type name from the picker, or schema.enum
  isArray?: boolean
  nullable: boolean
  unique?: boolean
  primary?: boolean
  default?: string // SQL expression, e.g. now() or 'draft'
  identity?: boolean
  references?: { schema: string; table: string; column: string; onDelete?: 'no action' | 'cascade' | 'set null' | 'restrict' }
  comment?: string
}

/** A type name as SQL: built-ins bare, schema.enum quoted. */
export function typeSql(type: string, isArray?: boolean): string {
  const dot = type.indexOf('.')
  const base = dot > 0 ? qualified(type.slice(0, dot), type.slice(dot + 1)) : /^[a-z][a-z0-9_ ]*(\(\d+(,\s*\d+)?\))?$/.test(type) ? type : ident(type)
  return isArray ? `${base}[]` : base
}

function columnSql(c: ColumnDef): string {
  const parts = [ident(c.name), typeSql(c.type, c.isArray)]
  if (c.identity) parts.push('generated by default as identity')
  if (c.primary) parts.push('primary key')
  else {
    if (!c.nullable) parts.push('not null')
    if (c.unique) parts.push('unique')
  }
  if (c.default && !c.identity) parts.push(`default ${c.default}`)
  if (c.references) {
    const r = c.references
    parts.push(`references ${qualified(r.schema, r.table)} (${ident(r.column)})`)
    if (r.onDelete && r.onDelete !== 'no action') parts.push(`on delete ${r.onDelete}`)
  }
  return parts.join(' ')
}

function comments(target: string, schema: string, table: string, cols: ColumnDef[]): string[] {
  return cols
    .filter((c) => c.comment)
    .map((c) => `comment on column ${qualified(schema, table)}.${ident(c.name)} is ${literal(c.comment)};`)
    .concat(target ? [target] : [])
}

export function createTable(schema: string, name: string, columns: ColumnDef[], opts: { rls: boolean; comment?: string }): string {
  const t = qualified(schema, name)
  const lines = [`create table ${t} (\n  ${columns.map(columnSql).join(',\n  ')}\n);`]
  if (opts.rls) lines.push(`alter table ${t} enable row level security;`)
  return [...lines, ...comments(opts.comment ? `comment on table ${t} is ${literal(opts.comment)};` : '', schema, name, columns)].join('\n')
}

export function addColumn(schema: string, table: string, c: ColumnDef): string {
  return [`alter table ${qualified(schema, table)} add column ${columnSql(c)};`, ...comments('', schema, table, [c])].join('\n')
}

export function dropColumn(schema: string, table: string, column: string, cascade = false): string {
  return `alter table ${qualified(schema, table)} drop column ${ident(column)}${cascade ? ' cascade' : ''};`
}

export function renameTable(schema: string, from: string, to: string): string {
  return `alter table ${qualified(schema, from)} rename to ${ident(to)};`
}

export function dropTable(schema: string, table: string, cascade = false): string {
  return `drop table ${qualified(schema, table)}${cascade ? ' cascade' : ''};`
}

export function setRls(schema: string, table: string, enabled: boolean): string {
  return `alter table ${qualified(schema, table)} ${enabled ? 'enable' : 'disable'} row level security;`
}

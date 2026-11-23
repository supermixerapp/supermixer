/*
 * Schema Visualizer data: tables with their columns, and foreign keys, laid
 * out left to right so referenced tables sit before the tables that use them.
 */

export interface GraphColumn {
  name: string
  type: string
  nullable: boolean
  pk: boolean
  unique: boolean
  identity: boolean
}

export interface GraphTable {
  id: number
  name: string
  kind: 'r' | 'p' | 'v' | 'm' | 'f'
  columns: GraphColumn[]
}

export interface GraphForeignKey {
  name: string
  source: number
  target: number
  target_schema: string
  target_table: string
  source_columns: string[]
  target_columns: string[]
}

/** $1 = schema. Partitions are left out; their parent stands for them. */
export const GRAPH_TABLES_SQL = `
select c.oid::int as id, c.relname as name, c.relkind as kind,
       coalesce((
         select json_agg(json_build_object(
                  'name', a.attname,
                  'type', format_type(a.atttypid, a.atttypmod),
                  'nullable', not a.attnotnull,
                  -- key columns only, not a primary key's INCLUDE columns
                  'pk', exists (select 1 from pg_index i where i.indrelid = c.oid and i.indisprimary
                                 and a.attnum = any ((i.indkey::int2[])[0:i.indnkeyatts - 1])),
                  'unique', exists (select 1 from pg_index i where i.indrelid = c.oid and i.indisunique and not i.indisprimary
                                     and i.indnkeyatts = 1 and i.indkey[0] = a.attnum),
                  'identity', a.attidentity <> '' or a.attgenerated <> '') order by a.attnum)
         from pg_attribute a
         where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped), '[]') as columns
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = $1 and c.relkind in ('r', 'p', 'v', 'm', 'f') and not c.relispartition
order by c.relname`

/** $1 = schema: foreign keys from its tables, to any schema. */
export const GRAPH_FKS_SQL = `
select con.conname as name, con.conrelid::int as source, con.confrelid::int as target,
       tn.nspname as target_schema, tc.relname as target_table,
       (select json_agg(a.attname order by k.ord) from unnest(con.conkey) with ordinality k(attnum, ord)
          join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum) as source_columns,
       (select json_agg(a.attname order by k.ord) from unnest(con.confkey) with ordinality k(attnum, ord)
          join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.attnum) as target_columns
from pg_constraint con
join pg_class sc on sc.oid = con.conrelid
join pg_namespace sn on sn.oid = sc.relnamespace
join pg_class tc on tc.oid = con.confrelid
join pg_namespace tn on tn.oid = tc.relnamespace
-- conparentid = 0: skip the copies Postgres makes on each partition
where con.contype = 'f' and con.conparentid = 0 and sn.nspname = $1
order by con.conname`

export const NODE_WIDTH = 280
const HEADER = 40
const ROW = 26
const GAP_X = 120
const GAP_Y = 40

export const nodeHeight = (columns: number) => HEADER + Math.max(columns, 1) * ROW + 8

/**
 * Left-to-right layers: a table referenced by others sits to their left.
 * Tables without any foreign keys either way go in a grid after the rest.
 * Returns top-left positions keyed by node id.
 */
export function layoutGraph(
  nodes: { id: string; columns: number }[],
  edges: { from: string; to: string }[]
): Record<string, { x: number; y: number }> {
  // from = the referencing table, to = the referenced one.
  const refs = new Map<string, Set<string>>()
  const linked = new Set<string>()
  for (const e of edges) {
    if (e.from === e.to) continue
    if (!refs.has(e.from)) refs.set(e.from, new Set())
    refs.get(e.from)!.add(e.to)
    linked.add(e.from)
    linked.add(e.to)
  }
  const rank = new Map<string, number>()
  const visiting = new Set<string>()
  const rankOf = (id: string): number => {
    const known = rank.get(id)
    if (known !== undefined) return known
    if (visiting.has(id)) return 0 // a cycle: stop here
    visiting.add(id)
    let r = 0
    for (const t of refs.get(id) ?? []) r = Math.max(r, rankOf(t) + 1)
    visiting.delete(id)
    rank.set(id, r)
    return r
  }

  const pos: Record<string, { x: number; y: number }> = {}
  const columnsY = new Map<number, number>()
  let maxRank = -1
  for (const n of nodes.filter((n) => linked.has(n.id))) {
    const r = rankOf(n.id)
    maxRank = Math.max(maxRank, r)
    const y = columnsY.get(r) ?? 0
    pos[n.id] = { x: r * (NODE_WIDTH + GAP_X), y }
    columnsY.set(r, y + nodeHeight(n.columns) + GAP_Y)
  }

  // Unlinked tables: a grid of up to 4 columns to the right.
  const loose = nodes.filter((n) => !linked.has(n.id))
  const startX = (maxRank + 1) * (NODE_WIDTH + GAP_X)
  const perRow = 4
  let y = 0
  for (let i = 0; i < loose.length; i += perRow) {
    const row = loose.slice(i, i + perRow)
    row.forEach((n, j) => (pos[n.id] = { x: startX + j * (NODE_WIDTH + GAP_X), y }))
    y += Math.max(...row.map((n) => nodeHeight(n.columns))) + GAP_Y
  }
  return pos
}

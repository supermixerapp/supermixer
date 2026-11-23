/*
 * Observability › Database: live numbers from Postgres's own statistics
 * views. Reports built on request logs need Logflare; these don't.
 */

export interface DatabaseStats {
  db_bytes: number
  connections: number
  active: number
  max_connections: number
  commits: number
  rollbacks: number
  deadlocks: number
  temp_bytes: number
  /** Share of table reads served from memory, 0–1. */
  table_hit: number | null
  index_hit: number | null
  stats_reset: string | null
  at: string
}

export const DATABASE_STATS_SQL = `
select pg_database_size(current_database())::float8 as db_bytes,
  (select count(*) from pg_stat_activity where datname = current_database())::float8 as connections,
  (select count(*) from pg_stat_activity where datname = current_database() and state = 'active')::float8 as active,
  current_setting('max_connections')::float8 as max_connections,
  d.xact_commit::float8 as commits, d.xact_rollback::float8 as rollbacks, d.deadlocks::float8 as deadlocks,
  d.temp_bytes::float8 as temp_bytes,
  (select sum(heap_blks_hit)::float8 / nullif(sum(heap_blks_hit + heap_blks_read), 0) from pg_statio_user_tables) as table_hit,
  (select sum(idx_blks_hit)::float8 / nullif(sum(idx_blks_hit + idx_blks_read), 0) from pg_statio_user_indexes) as index_hit,
  d.stats_reset, now() as at
from pg_stat_database d where d.datname = current_database()`

export interface ConnectionGroup {
  state: string
  app: string
  role: string | null
  count: number
  oldest: string | null
}

export const CONNECTIONS_SQL = `
select coalesce(state, 'background') as state, coalesce(nullif(application_name, ''), backend_type) as app,
  usename as role, count(*)::float8 as count, min(backend_start) as oldest
from pg_stat_activity where datname = current_database()
group by 1, 2, 3 order by 4 desc, 2`

export interface TableSize {
  schema: string
  name: string
  bytes: number
  rows: number
  seq_scans: number | null
  index_scans: number | null
  dead_rows: number | null
  last_autovacuum: string | null
}

export const LARGEST_TABLES_SQL = `
select n.nspname as schema, c.relname as name, pg_total_relation_size(c.oid)::float8 as bytes,
  greatest(c.reltuples, 0)::float8 as rows, s.seq_scan::float8 as seq_scans, s.idx_scan::float8 as index_scans,
  s.n_dead_tup::float8 as dead_rows, s.last_autovacuum
from pg_class c join pg_namespace n on n.oid = c.relnamespace
left join pg_stat_user_tables s on s.relid = c.oid
where c.relkind in ('r', 'p', 'm') and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname !~ '^pg_toast'
order by bytes desc limit 15`

/** Transactions per second between two samples, or null when it can't be told. */
export function commitRate(prev: DatabaseStats | undefined, next: DatabaseStats): number | null {
  if (!prev) return null
  const seconds = (new Date(next.at).getTime() - new Date(prev.at).getTime()) / 1000
  const delta = next.commits + next.rollbacks - (prev.commits + prev.rollbacks)
  return seconds > 0 && delta >= 0 ? delta / seconds : null
}

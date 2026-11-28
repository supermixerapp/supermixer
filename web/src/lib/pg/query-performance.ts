/*
 * Query Performance: the statements that cost the database most, from the
 * pg_stat_statements extension (Studio's Advisors › Query Performance).
 */
import { ident } from './sql'
import { localized, t } from '@/lib/i18n'

/** Where pg_stat_statements is installed, if it is. */
export const STATEMENTS_SCHEMA_SQL = `
select n.nspname as schema from pg_extension e join pg_namespace n on n.oid = e.extnamespace
where e.extname = 'pg_stat_statements'`

export const QUERY_SORTS = localized(() => ({
  total: { label: t('database:queryPerformance.mostTimeConsuming'), column: 'total_exec_time' },
  calls: { label: t('database:queryPerformance.mostFrequent'), column: 'calls' },
  mean: { label: t('database:queryPerformance.slowestExecution'), column: 'mean_exec_time' },
}) as const)
export type QuerySort = keyof ReturnType<typeof QUERY_SORTS>

export interface QueryStat {
  id: string
  role: string | null
  query: string
  calls: number
  total_ms: number
  mean_ms: number
  min_ms: number
  max_ms: number
  rows: number
  /** Share of reads served from shared buffers, 0–1; null when nothing was read. */
  cache_hit: number | null
  /** Share of all statements' execution time, in percent. */
  share: number | null
}

/**
 * Top statements in this database, filtered by role ($1, '' for all) and
 * query text ($2, an ILIKE pattern, '' for all).
 */
export function queryStatsSql(schema: string, sort: QuerySort, limit = 100): string {
  return `
select s.queryid::text as id, r.rolname as role, s.query,
  s.calls::float8 as calls, s.total_exec_time as total_ms, s.mean_exec_time as mean_ms,
  s.min_exec_time as min_ms, s.max_exec_time as max_ms, s.rows::float8 as rows,
  case when s.shared_blks_hit + s.shared_blks_read = 0 then null
       else s.shared_blks_hit::float8 / (s.shared_blks_hit + s.shared_blks_read) end as cache_hit,
  -- Out of every statement in this database, not just the filtered ones.
  100 * s.total_exec_time / nullif((select sum(a.total_exec_time) from ${ident(schema)}.pg_stat_statements a
    where a.dbid = (select oid from pg_database where datname = current_database())), 0) as share
from ${ident(schema)}.pg_stat_statements s
left join pg_roles r on r.oid = s.userid
where s.dbid = (select oid from pg_database where datname = current_database())
  and ($1 = '' or r.rolname = $1)
  and ($2 = '' or s.query ilike $2)
order by s.${QUERY_SORTS()[sort].column} desc
limit ${Math.max(1, Math.floor(limit))}`
}

/** Roles that ran statements, for the filter. */
export function statementRolesSql(schema: string): string {
  return `
select distinct r.rolname as name from ${ident(schema)}.pg_stat_statements s join pg_roles r on r.oid = s.userid
where s.dbid = (select oid from pg_database where datname = current_database())
order by 1`
}

/** When the statistics were last cleared. */
export function statsResetSql(schema: string): string {
  return `select stats_reset from ${ident(schema)}.pg_stat_statements_info`
}

export function resetStatsSql(schema: string): string {
  return `select ${ident(schema)}.pg_stat_statements_reset();`
}

/** 0.42 ms, 12.3 ms, 4.56 s, 3.2 min */
export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—'
  if (ms < 1) return `${ms.toFixed(2)} ms`
  if (ms < 1000) return `${ms.toFixed(ms < 100 ? 1 : 0)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)} min`
  return `${(ms / 3_600_000).toFixed(1)} h`
}

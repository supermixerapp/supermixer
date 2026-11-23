/*
 * Organization usage: resource use of each project's stack, read from its
 * own database (Supermixer has no billing meters).
 */

export interface ProjectUsage {
  db_bytes: number
  /** null when the stack has no Storage (or Auth) tables. */
  storage_bytes: number | null
  storage_objects: number | null
  users: number | null
  connections: number
  max_connections: number
}

/**
 * A number from a table that may not exist. query_to_xml plans its query only
 * when called, so a missing table gives null instead of failing the row.
 */
function ifTable(table: string, sql: string): string {
  return `case when to_regclass('${table}') is not null
    then (xpath('/row/n/text()', query_to_xml('${sql.replace(/'/g, "''")}', false, true, '')))[1]::text::float8 end`
}

export const USAGE_SQL = `
select pg_database_size(current_database())::float8 as db_bytes,
  ${ifTable('storage.objects', "select coalesce(sum((metadata->>'size')::bigint), 0) as n from storage.objects")} as storage_bytes,
  ${ifTable('storage.objects', 'select count(*) as n from storage.objects')} as storage_objects,
  ${ifTable('auth.users', 'select count(*) as n from auth.users')} as users,
  (select count(*) from pg_stat_activity where datname = current_database())::float8 as connections,
  current_setting('max_connections')::float8 as max_connections`

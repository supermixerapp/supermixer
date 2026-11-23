/*
 * Logs: entries the stack's Logflare stores, read through Supermixer's API.
 */
import type { Schemas } from '@/lib/api/client'

export type LogSource = Schemas['LogSource']
export type LogEntry = Schemas['LogEntry']

/** Studio's log collection pages (logs/<path>) and where their entries come from. */
export const LOG_COLLECTIONS: Record<string, { title: string; source: LogSource; search?: string; description: string }> = {
  'edge-logs': { title: 'API Gateway', source: 'api_gateway', description: 'Every request through the API gateway.' },
  'postgres-logs': { title: 'Postgres', source: 'postgres', description: "The database server's log." },
  'postgrest-logs': { title: 'PostgREST', source: 'postgrest', description: 'The Data API server.' },
  'pooler-logs': { title: 'Pooler', source: 'pooler', description: 'The connection pooler. Self-hosted stacks only ship these when Vector is set up to collect them.' },
  'auth-logs': { title: 'Auth', source: 'auth', description: 'Sign-ups, sign-ins and the Auth server.' },
  'storage-logs': { title: 'Storage', source: 'storage', description: 'The Storage API.' },
  'realtime-logs': { title: 'Realtime', source: 'realtime', description: 'The Realtime server.' },
  'edge-functions-logs': { title: 'Edge Functions', source: 'functions', description: 'The Edge Runtime: function output and errors.' },
  'pgcron-logs': { title: 'Cron', source: 'postgres', search: 'cron job', description: "pg_cron's lines in the Postgres log." },
}

export const SOURCE_LABELS: Record<LogSource, string> = {
  api_gateway: 'API Gateway',
  auth: 'Auth',
  postgres: 'Postgres',
  postgrest: 'PostgREST',
  pooler: 'Pooler',
  storage: 'Storage',
  realtime: 'Realtime',
  functions: 'Edge Functions',
}

export const TIME_RANGES: { label: string; minutes: number }[] = [
  { label: 'Last 15 minutes', minutes: 15 },
  { label: 'Last hour', minutes: 60 },
  { label: 'Last 3 hours', minutes: 180 },
  { label: 'Last 24 hours', minutes: 1440 },
  { label: 'Last 7 days', minutes: 10080 },
]

/** What an API gateway entry says about the request, when it's there. */
export function requestOf(e: LogEntry): { method: string; path: string; status: number | null } | null {
  const m = e.metadata as { request?: { method?: unknown; path?: unknown }; response?: { status_code?: unknown } }
  if (!m.request || typeof m.request.path !== 'string') return null
  return {
    method: typeof m.request.method === 'string' ? m.request.method : '',
    path: m.request.path,
    status: typeof m.response?.status_code === 'number' ? m.response.status_code : null,
  }
}

/** A log level, from the entry's metadata or a [level] in its message. */
export function levelOf(e: LogEntry): string | null {
  const m = e.metadata as { level?: unknown; error_severity?: unknown; parsed?: { error_severity?: unknown } }
  for (const v of [m.level, m.error_severity, m.parsed?.error_severity]) if (typeof v === 'string' && v) return v.toLowerCase()
  const bracket = /\[(debug|info|notice|warn(?:ing)?|error|fatal|panic)\]/i.exec(e.message)
  return bracket ? bracket[1]!.toLowerCase() : null
}

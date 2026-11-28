/*
 * Logs: entries the stack's Logflare stores, read through Supermixer's API.
 */
import type { Schemas } from '@/lib/api/client'
import { localized, t } from '@/lib/i18n'

export type LogSource = Schemas['LogSource']
export type LogEntry = Schemas['LogEntry']

/** Studio's log collection pages (logs/<path>) and where their entries come from. */
export const LOG_COLLECTIONS = localized((): Record<string, { title: string; source: LogSource; search?: string; description: string }> => ({
  'edge-logs': { title: t('observability:logs.apiGateway'), source: 'api_gateway', description: t('observability:logs.everyRequestThroughTheApiGateway') },
  'postgres-logs': { title: 'Postgres', source: 'postgres', description: t('observability:logs.theDatabaseServerSLog') },
  'postgrest-logs': { title: 'PostgREST', source: 'postgrest', description: t('observability:logs.theDataApiServer') },
  'pooler-logs': { title: 'Pooler', source: 'pooler', description: t('observability:logs.theConnectionPoolerSelfHostedStacks') },
  'auth-logs': { title: 'Auth', source: 'auth', description: t('observability:logs.signUpsSignInsAndThe') },
  'storage-logs': { title: 'Storage', source: 'storage', description: t('observability:logs.theStorageApi') },
  'realtime-logs': { title: 'Realtime', source: 'realtime', description: t('observability:logs.theRealtimeServer') },
  'edge-functions-logs': { title: t('observability:logs.edgeFunctions'), source: 'functions', description: t('observability:logs.theEdgeRuntimeFunctionOutputAnd') },
  'pgcron-logs': { title: 'Cron', source: 'postgres', search: 'cron job', description: t('observability:logs.pgCronSLinesInThe') },
}))

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

export const TIME_RANGES = localized((): { label: string; minutes: number }[] => [
  { label: t('observability:logs.last15Minutes'), minutes: 15 },
  { label: t('observability:logs.lastHour'), minutes: 60 },
  { label: t('observability:logs.last3Hours'), minutes: 180 },
  { label: t('observability:logs.last24Hours'), minutes: 1440 },
  { label: t('observability:logs.last7Days'), minutes: 10080 },
])

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

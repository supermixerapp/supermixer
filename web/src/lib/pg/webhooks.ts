/*
 * Database Webhooks: row triggers that call supabase_functions.http_request,
 * which queues the request with pg_net once the transaction commits. Its
 * arguments are url, method, headers (JSON), params (JSON) and timeout (ms).
 */
import { ident, literal, qualified } from './sql'

export const WEBHOOK_EVENTS = ['INSERT', 'UPDATE', 'DELETE'] as const
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number]

export interface WebhookRow {
  name: string
  schema: string
  table: string
  events: WebhookEvent[]
  enabled: boolean
  /** tgargs as encode(…, 'escape') text; see decodeTriggerArgs. */
  args_escaped: string
}

/** Triggers on supabase_functions.http_request. */
export const WEBHOOKS_SQL = `
select t.tgname as name, n.nspname as schema, c.relname as "table",
  to_json(array_remove(array[
    case when t.tgtype & 4 <> 0 then 'INSERT' end,
    case when t.tgtype & 16 <> 0 then 'UPDATE' end,
    case when t.tgtype & 8 <> 0 then 'DELETE' end
  ], null)) as events,
  t.tgenabled <> 'D' as enabled,
  encode(t.tgargs, 'escape') as args_escaped
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
where t.tgfoid = to_regprocedure('supabase_functions.http_request()') and not t.tgisinternal
order by n.nspname, c.relname, t.tgname`

/**
 * pg_trigger.tgargs holds the arguments as NUL-terminated UTF-8 strings.
 * encode(…, 'escape') writes NUL and non-ASCII bytes as \nnn and doubles
 * backslashes; undo that, then split.
 */
export function decodeTriggerArgs(escaped: string): string[] {
  const bytes: number[] = []
  for (let i = 0; i < escaped.length; i++) {
    const ch = escaped[i]!
    if (ch === '\\' && escaped[i + 1] === '\\') {
      bytes.push(0x5c)
      i++
    } else if (ch === '\\' && /^[0-7]{3}$/.test(escaped.slice(i + 1, i + 4))) {
      bytes.push(parseInt(escaped.slice(i + 1, i + 4), 8))
      i += 3
    } else {
      bytes.push(ch.charCodeAt(0))
    }
  }
  const out: string[] = []
  let start = 0
  const decoder = new TextDecoder()
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) {
      out.push(decoder.decode(new Uint8Array(bytes.slice(start, i))))
      start = i + 1
    }
  }
  if (start < bytes.length) out.push(decoder.decode(new Uint8Array(bytes.slice(start))))
  return out
}

/** Whether this stack has Supabase's webhook function (its Postgres image sets it up). */
export const HAS_WEBHOOKS_SQL = `select to_regprocedure('supabase_functions.http_request()') is not null as present`

export interface WebhookDef {
  name: string
  schema: string
  table: string
  events: WebhookEvent[]
  method: 'GET' | 'POST'
  url: string
  /** JSON object. */
  headers: string
  /** JSON object of query parameters. */
  params: string
  timeoutMs: number
}

export function parseWebhook(row: WebhookRow): WebhookDef {
  const [url = '', method = 'POST', headers = '{}', params = '{}', timeout = '1000'] = decodeTriggerArgs(row.args_escaped)
  return {
    name: row.name,
    schema: row.schema,
    table: row.table,
    events: row.events,
    method: method === 'GET' ? 'GET' : 'POST',
    url,
    headers: headers === 'null' ? '{}' : headers,
    params: params === 'null' ? '{}' : params,
    timeoutMs: Number(timeout) || 1000,
  }
}

export function createWebhook(w: WebhookDef): string {
  const args = [w.url, w.method, w.headers.trim() || '{}', w.params.trim() || '{}', String(Math.trunc(w.timeoutMs))].map(literal).join(', ')
  return `create trigger ${ident(w.name)} after ${w.events.join(' or ')} on ${qualified(w.schema, w.table)}
for each row execute function supabase_functions.http_request(${args});`
}

export function dropWebhook(w: { name: string; schema: string; table: string }): string {
  return `drop trigger if exists ${ident(w.name)} on ${qualified(w.schema, w.table)};`
}

/** Replace a webhook, in one transaction (the script runs as one). */
export function replaceWebhook(original: { name: string; schema: string; table: string }, w: WebhookDef): string {
  return `${dropWebhook(original)}\n${createWebhook(w)}`
}

export interface WebhookCall {
  id: number
  created_at: string
  status_code: number | null
  timed_out: boolean | null
  error: string | null
}

/** Recent calls of webhook $1 on table oid $2; pg_net keeps responses for six hours. */
export const WEBHOOK_CALLS_SQL = `
select h.id::float8 as id, h.created_at, r.status_code, r.timed_out, r.error_msg as error
from supabase_functions.hooks h left join net._http_response r on r.id = h.request_id
where h.hook_name = $1 and h.hook_table_id = to_regclass($2)::oid
order by h.id desc limit 50`

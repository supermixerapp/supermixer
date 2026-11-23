/*
 * Cron integration: pg_cron jobs and their run history. Times are in the
 * database server's cron.timezone, which is GMT unless changed.
 */
import { literal, qualified } from './sql'

export interface CronJob {
  id: number
  name: string | null
  schedule: string
  command: string
  active: boolean
  username: string
  database: string
  last_status: string | null
  last_start: string | null
  last_end: string | null
  last_message: string | null
}

export const CRON_JOBS_SQL = `
select j.jobid::int as id, j.jobname as name, j.schedule, j.command, j.active, j.username, j.database,
  r.status as last_status, r.start_time as last_start, r.end_time as last_end, r.return_message as last_message
from cron.job j
left join lateral (
  select d.status, d.start_time, d.end_time, d.return_message from cron.job_run_details d
  where d.jobid = j.jobid order by d.start_time desc nulls last limit 1
) r on true
order by j.jobname nulls last, j.jobid`

export interface CronRun {
  id: number
  status: string
  start_time: string | null
  end_time: string | null
  message: string | null
}

/** The latest runs of job $1. */
export const CRON_RUNS_SQL = `
select runid::int as id, status, start_time, end_time, return_message as message
from cron.job_run_details where jobid = $1::bigint
order by start_time desc nulls last limit 100`

export function scheduleJob(name: string, schedule: string, command: string): string {
  return `select cron.schedule(${literal(name)}, ${literal(schedule)}, ${literal(command)});`
}

/** Change a job in place; cron.alter_job leaves out what isn't given. */
export function alterJob(id: number, change: { schedule?: string; command?: string; active?: boolean }): string {
  const args = [`job_id := ${Math.trunc(id)}`]
  if (change.schedule !== undefined) args.push(`schedule := ${literal(change.schedule)}`)
  if (change.command !== undefined) args.push(`command := ${literal(change.command)}`)
  if (change.active !== undefined) args.push(`active := ${change.active}`)
  return `select cron.alter_job(${args.join(', ')});`
}

export function unscheduleJob(id: number): string {
  return `select cron.unschedule(${Math.trunc(id)}::bigint);`
}

/** Save a job: a new one, an edit, or (pg_cron can't rename) a replacement under a new name. */
export function saveJob(original: CronJob | null, name: string, schedule: string, command: string): string {
  if (!original) return scheduleJob(name, schedule, command)
  if ((original.name ?? '') === name) return alterJob(original.id, { schedule, command })
  const lines = [unscheduleJob(original.id), scheduleJob(name, schedule, command)]
  if (!original.active) lines.push(`select cron.alter_job(job_id := (select jobid from cron.job where jobname = ${literal(name)}), active := false);`)
  return lines.join('\n')
}

// ---------------------------------------------------------------- commands

export function functionCommand(schema: string, fn: string): string {
  return `select ${qualified(schema, fn)}()`
}

export interface HttpJob {
  method: 'GET' | 'POST'
  url: string
  /** JSON object of header names to values. */
  headers: string
  /** JSON body, POST only. */
  body: string
  timeoutMs: number
}

/** An HTTP request through pg_net, which sends it after the job's transaction commits. */
export function httpCommand(h: HttpJob): string {
  const headers = `${literal(h.headers.trim() || '{}')}::jsonb`
  const timeout = Math.max(1, Math.trunc(h.timeoutMs))
  return h.method === 'GET'
    ? `select net.http_get(url := ${literal(h.url)}, headers := ${headers}, timeout_milliseconds := ${timeout})`
    : `select net.http_post(url := ${literal(h.url)}, body := ${literal(h.body.trim() || '{}')}::jsonb, headers := ${headers}, timeout_milliseconds := ${timeout})`
}

/** Whether a string is a JSON object, for headers and bodies. */
export function isJsonObject(s: string): boolean {
  if (!s.trim()) return true
  try {
    const v: unknown = JSON.parse(s)
    return typeof v === 'object' && v !== null && !Array.isArray(v)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------- schedules

export const SCHEDULE_PRESETS: { label: string; value: string }[] = [
  { label: 'Every 30 seconds', value: '30 seconds' },
  { label: 'Every minute', value: '* * * * *' },
  { label: 'Every 5 minutes', value: '*/5 * * * *' },
  { label: 'Every hour', value: '0 * * * *' },
  { label: 'Every day at midnight', value: '0 0 * * *' },
  { label: 'Every Monday at 09:00', value: '0 9 * * 1' },
  { label: 'First day of the month', value: '0 0 1 * *' },
]

const FIELD = /^[\d*,/\-A-Za-z#$LW]+$/

/** pg_cron's syntax: five cron fields, or "N seconds" (1–59). */
export function scheduleProblem(s: string): string | null {
  const t = s.trim()
  if (!t) return 'Enter a schedule'
  const secs = /^(\d+) seconds?$/.exec(t)
  if (secs) return Number(secs[1]) >= 1 && Number(secs[1]) <= 59 ? null : 'Seconds must be between 1 and 59'
  const parts = t.split(/\s+/)
  if (parts.length !== 5 || !parts.every((p) => FIELD.test(p))) return 'Use five cron fields (minute hour day month weekday), or "N seconds"'
  return null
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const pad = (n: string) => n.padStart(2, '0')

/** Plain words for common schedules; null for ones it doesn't recognise. */
export function describeSchedule(s: string): string | null {
  const t = s.trim()
  const secs = /^(\d+) seconds?$/.exec(t)
  if (secs) return secs[1] === '1' ? 'Every second' : `Every ${secs[1]} seconds`
  const parts = t.split(/\s+/)
  if (parts.length !== 5) return null
  const [m, h, dom, mon, dow] = parts as [string, string, string, string, string]
  const num = (x: string) => /^\d+$/.test(x)
  if (mon !== '*') return null
  if (m === '*' && h === '*' && dom === '*' && dow === '*') return 'Every minute'
  const every = /^\*\/(\d+)$/.exec(m)
  if (every && h === '*' && dom === '*' && dow === '*') return `Every ${every[1]} minutes`
  if (num(m) && h === '*' && dom === '*' && dow === '*') return m === '0' ? 'Every hour' : `Every hour at minute ${m}`
  if (!num(m) || !num(h)) return null
  const at = `at ${pad(h)}:${pad(m)}`
  if (dom === '*' && dow === '*') return `Every day ${at}`
  if (dom === '*' && num(dow) && Number(dow) <= 7) return `Every ${DAYS[Number(dow)]} ${at}`
  if (num(dom) && dow === '*') return `On day ${dom} of every month ${at}`
  return null
}

import { localized, t as tr, language } from '@/lib/i18n'

/*
 * Auth › Users. The list is read with SQL on auth.users, as Studio does, so it
 * can search, filter and sort freely; changes go through Auth's admin API so
 * its own rules and hooks apply. Password hashes and tokens are never read.
 */

export type UserFilter = 'all' | 'verified' | 'unverified' | 'anonymous'
export type UserSort = 'created_at' | 'last_sign_in_at' | 'email'

export interface UserListRow {
  id: string
  email: string | null
  phone: string | null
  display_name: string | null
  providers: string[]
  created_at: string
  last_sign_in_at: string | null
  email_confirmed_at: string | null
  phone_confirmed_at: string | null
  invited_at: string | null
  banned_until: string | null
  anonymous: boolean
  /** All matching users, for paging. */
  total: number
}

const FILTERS: Record<UserFilter, string> = {
  all: 'true',
  verified: '(u.email_confirmed_at is not null or u.phone_confirmed_at is not null)',
  unverified: `(u.email_confirmed_at is null and u.phone_confirmed_at is null and not ${anonymous()})`,
  anonymous: anonymous(),
}

// is_anonymous only exists on newer Auth versions; read it tolerantly.
function anonymous(): string {
  return `coalesce((to_jsonb(u) ->> 'is_anonymous')::boolean, false)`
}

const SORTS: Record<UserSort, string> = {
  created_at: 'u.created_at',
  last_sign_in_at: 'u.last_sign_in_at',
  email: 'u.email',
}

/** LIKE pattern that matches `s` literally anywhere. */
export function containsPattern(s: string): string {
  return `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

/**
 * Params: $1 search text ('' for none), $2 its LIKE pattern, $3 limit, $4 offset.
 * Filter and sort come from fixed lists, never from free text.
 */
export function usersSql(filter: UserFilter, sort: UserSort, descending: boolean): string {
  return `
select u.id, u.email, u.phone,
       coalesce(u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name') as display_name,
       coalesce(u.raw_app_meta_data -> 'providers',
                case when u.raw_app_meta_data ? 'provider' then jsonb_build_array(u.raw_app_meta_data ->> 'provider') end,
                '[]'::jsonb) as providers,
       to_json(u.created_at) as created_at, to_json(u.last_sign_in_at) as last_sign_in_at,
       to_json(u.email_confirmed_at) as email_confirmed_at, to_json(u.phone_confirmed_at) as phone_confirmed_at,
       to_json(u.invited_at) as invited_at,
       case when u.banned_until > now() then to_json(u.banned_until) end as banned_until,
       ${anonymous()} as anonymous,
       (count(*) over ())::int as total
from auth.users u
where u.deleted_at is null
  and ${FILTERS[filter]}
  and ($1 = '' or u.email ilike $2 or u.phone ilike $2 or u.id::text = lower($1)
       or u.raw_user_meta_data ->> 'full_name' ilike $2 or u.raw_user_meta_data ->> 'name' ilike $2)
order by ${SORTS[sort]} ${descending ? 'desc' : 'asc'} nulls last, u.id
limit $3::int offset $4::int`
}

/** A user as Auth's admin API returns it (only the fields we show). */
export interface AuthUser {
  id: string
  email?: string
  phone?: string
  role?: string
  created_at: string
  updated_at?: string
  last_sign_in_at?: string
  email_confirmed_at?: string
  phone_confirmed_at?: string
  confirmation_sent_at?: string
  recovery_sent_at?: string
  invited_at?: string
  banned_until?: string
  is_anonymous?: boolean
  is_sso_user?: boolean
  app_metadata?: Record<string, unknown>
  user_metadata?: Record<string, unknown>
  identities?: { id: string; provider: string; created_at?: string; last_sign_in_at?: string; identity_data?: Record<string, unknown> }[]
  factors?: { id: string; factor_type: string; friendly_name?: string; status: string; created_at: string }[]
}

/** Ban lengths offered, as Auth's ban_duration (Go durations). */
export const BAN_DURATIONS = localized((): { label: string; value: string; phrase: string }[] => [
  { label: tr('authentication:authUsers.oneHour'), value: '1h', phrase: tr('authentication:authUsers.for1Hour') },
  { label: tr('authentication:authUsers.hours24'), value: '24h', phrase: tr('authentication:authUsers.for24Hours') },
  { label: tr('authentication:authUsers.days7'), value: '168h', phrase: tr('authentication:authUsers.for7Days') },
  { label: tr('authentication:authUsers.days30'), value: '720h', phrase: tr('authentication:authUsers.for30Days') },
  { label: tr('authentication:authUsers.permanently100Years'), value: '876000h', phrase: tr('authentication:authUsers.permanently100Years2') },
])

/** Admin API path for one user; ids are UUIDs, but escape anyway. */
export const userPath = (id: string, rest = '') => `auth/v1/admin/users/${encodeURIComponent(id)}${rest}`

export function isBanned(u: { banned_until?: string | null }): boolean {
  return !!u.banned_until && new Date(u.banned_until).getTime() > Date.now()
}

export function isConfirmed(u: { email_confirmed_at?: string | null; phone_confirmed_at?: string | null }): boolean {
  return !!(u.email_confirmed_at || u.phone_confirmed_at)
}

/** "3 minutes ago", "in 2 days", or the date when far away. */
export function relativeTime(iso: string | null | undefined, now = Date.now(), locale: string = language()): string {
  if (!iso) return '—'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return '—'
  const diff = t - now
  const abs = Math.abs(diff)
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['second', 1000],
    ['minute', 60_000],
    ['hour', 3_600_000],
    ['day', 86_400_000],
  ]
  if (abs < 45_000) return rtf.format(0, 'second')
  for (let i = units.length - 1; i >= 0; i--) {
    const [unit, ms] = units[i]!
    if (abs >= ms) {
      if (unit === 'day' && abs > 30 * 86_400_000) return new Date(t).toLocaleDateString(locale)
      return rtf.format(Math.round(diff / ms), unit)
    }
  }
  return rtf.format(0, 'second')
}

// ------------------------------------------------------------- audit logs

export interface AuditEntry {
  id: string
  created_at: string
  ip_address: string
  action: string | null
  actor: string | null
  actor_id: string | null
  log_type: string | null
  traits: Record<string, unknown> | null
  total: number
}

/**
 * Auth's audit trail, newest first. Params: $1 action ('' for all), $2 a LIKE
 * pattern over the whole entry ('' for none), $3 limit, $4 offset.
 */
export const AUDIT_LOG_SQL = `
select e.id::text, e.created_at, e.ip_address,
  e.payload->>'action' as action, e.payload->>'actor_username' as actor,
  e.payload->>'actor_id' as actor_id, e.payload->>'log_type' as log_type,
  e.payload->'traits' as traits, (count(*) over ())::int as total
from auth.audit_log_entries e
where ($1 = '' or e.payload->>'action' = $1)
  and ($2 = '' or e.payload::text ilike $2 or e.ip_address ilike $2)
order by e.created_at desc nulls last, e.id
limit $3::int offset $4::int`

export const AUDIT_ACTIONS_SQL = `
select distinct payload->>'action' as action from auth.audit_log_entries where payload->>'action' is not null order by 1`

/** user_signedup → User signed up */
export function auditActionLabel(action: string | null): string {
  if (!action) return 'Unknown'
  const words = action.replace(/_/g, ' ').replace(/signedup/, 'signed up').replace(/loggedin/, 'logged in').replace(/loggedout/, 'logged out')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

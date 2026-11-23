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
export const BAN_DURATIONS: { label: string; value: string; phrase: string }[] = [
  { label: '1 hour', value: '1h', phrase: 'for 1 hour' },
  { label: '24 hours', value: '24h', phrase: 'for 24 hours' },
  { label: '7 days', value: '168h', phrase: 'for 7 days' },
  { label: '30 days', value: '720h', phrase: 'for 30 days' },
  { label: 'Permanently (100 years)', value: '876000h', phrase: 'permanently (100 years)' },
]

/** Admin API path for one user; ids are UUIDs, but escape anyway. */
export const userPath = (id: string, rest = '') => `auth/v1/admin/users/${encodeURIComponent(id)}${rest}`

export function isBanned(u: { banned_until?: string | null }): boolean {
  return !!u.banned_until && new Date(u.banned_until).getTime() > Date.now()
}

export function isConfirmed(u: { email_confirmed_at?: string | null; phone_confirmed_at?: string | null }): boolean {
  return !!(u.email_confirmed_at || u.phone_confirmed_at)
}

/** "3 minutes ago", "in 2 days", or the date when far away. */
export function relativeTime(iso: string | null | undefined, now = Date.now(), locale?: string): string {
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

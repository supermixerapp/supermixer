/*
 * Role management SQL. Passwords never leave the browser in clear text: like
 * psql's \password, we send a SCRAM-SHA-256 verifier, so the password can't
 * show up in Postgres's statement logs or pg_stat_activity.
 */
import { ident, literal } from './sql'

export interface RoleDef {
  name: string
  login: boolean
  inherit: boolean
  createDb: boolean
  createRole: boolean
  replication: boolean
  bypassRls: boolean
  /** -1 = no limit */
  connectionLimit: number
  /** A timestamp Postgres accepts (ISO), or '' for no expiry. */
  validUntil: string
}

/** What CREATE ROLE gives a role when an attribute isn't mentioned. */
const POSTGRES_DEFAULTS: RoleDef = {
  name: '',
  login: false,
  inherit: true,
  createDb: false,
  createRole: false,
  replication: false,
  bypassRls: false,
  connectionLimit: -1,
  validUntil: '',
}

export const emptyRole = (): RoleDef => ({ ...POSTGRES_DEFAULTS, login: true })

const FLAGS: [keyof RoleDef, string][] = [
  ['login', 'login'],
  ['inherit', 'inherit'],
  ['createDb', 'createdb'],
  ['createRole', 'createrole'],
  ['replication', 'replication'],
  ['bypassRls', 'bypassrls'],
]

/**
 * Only the attributes that differ from `base`. Postgres 15 makes a
 * non-superuser's ALTER ROLE fail if it so much as mentions REPLICATION or
 * BYPASSRLS, even unchanged, so we never repeat what is already true.
 */
function changedAttributes(base: RoleDef, r: RoleDef): string[] {
  const out: string[] = []
  for (const [key, word] of FLAGS) if (r[key] !== base[key]) out.push(r[key] ? word : `no${word}`)
  if (r.connectionLimit !== base.connectionLimit) out.push(`connection limit ${Math.trunc(r.connectionLimit)}`)
  if (r.validUntil !== base.validUntil) out.push(`valid until ${literal(r.validUntil || 'infinity')}`)
  return out
}

/** verifier: from scramVerifier(), or null for no password. */
export function createRole(r: RoleDef, verifier: string | null): string {
  const attrs = changedAttributes(POSTGRES_DEFAULTS, r)
  if (verifier) attrs.push(`password ${literal(verifier)}`)
  return `create role ${ident(r.name)}${attrs.length ? ` with ${attrs.join(' ')}` : ''};`
}

/** Rename if needed, then change only what differs from `original`. '' when nothing changed. */
export function alterRole(original: RoleDef, r: RoleDef, verifier: string | null): string {
  const lines: string[] = []
  if (r.name !== original.name) lines.push(`alter role ${ident(original.name)} rename to ${ident(r.name)};`)
  const attrs = changedAttributes(original, r)
  if (verifier) attrs.push(`password ${literal(verifier)}`)
  if (attrs.length) lines.push(`alter role ${ident(r.name)} with ${attrs.join(' ')};`)
  return lines.join('\n')
}

export function dropRole(name: string): string {
  return `drop role ${ident(name)};`
}

/** Why a role can't be given this name, or null if it can. */
export function roleNameProblem(name: string): string | null {
  if (!name) return 'Enter a name.'
  if (new TextEncoder().encode(name).length > 63) return 'Names can be at most 63 bytes long.'
  if (/^pg_/i.test(name)) return 'Names starting with pg_ are reserved by Postgres.'
  return null
}

// ------------------------------------------------------------------ SCRAM

const enc = new TextEncoder()

function b64(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let s = ''
  for (const b of arr) s += String.fromCharCode(b)
  return btoa(s)
}

async function hmac(key: ArrayBuffer, message: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return crypto.subtle.sign('HMAC', k, enc.encode(message))
}

/** RFC 3454 C.1.2: non-ASCII spaces, mapped to a plain space. */
const NON_ASCII_SPACE = new RegExp('[\\u00A0\\u1680\\u2000-\\u200B\\u202F\\u205F\\u3000]', 'g')

/** RFC 3454 B.1: characters "commonly mapped to nothing" (invisible joiners, selectors, soft hyphen). */
function mappedToNothing(cp: number): boolean {
  return (
    cp === 0x00ad || cp === 0x034f || cp === 0x1806 || (cp >= 0x180b && cp <= 0x180d) || (cp >= 0x200b && cp <= 0x200d) ||
    cp === 0x2060 || (cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0xfeff
  )
}

/**
 * SASLprep (RFC 4013), as clients like libpq apply it before SCRAM: map odd
 * spaces to a plain space, drop invisible characters, then NFKC. Like
 * Postgres, an ASCII password is used as is.
 */
export function saslPrep(password: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(password)) return password
  const kept = Array.from(password).filter((ch) => !mappedToNothing(ch.codePointAt(0)!)).join('')
  return kept.replace(NON_ASCII_SPACE, ' ').normalize('NFKC')
}

/** Whether this page may hash passwords (WebCrypto needs HTTPS or localhost). */
export function canHashPasswords(): boolean {
  return typeof crypto !== 'undefined' && !!crypto.subtle
}

/**
 * A Postgres SCRAM-SHA-256 password verifier (RFC 5802/7677), in the format
 * Postgres stores: SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>.
 */
export async function scramVerifier(password: string, salt?: Uint8Array, iterations = 4096): Promise<string> {
  if (!canHashPasswords()) {
    throw new Error('This browser only hashes passwords on HTTPS or localhost. Open Supermixer over HTTPS to set a password.')
  }
  const s = new Uint8Array(salt ?? crypto.getRandomValues(new Uint8Array(16))) // a plain ArrayBuffer copy
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(saslPrep(password)), 'PBKDF2', false, ['deriveBits'])
  const salted = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: s, iterations }, keyMaterial, 256)
  const clientKey = await hmac(salted, 'Client Key')
  const storedKey = await crypto.subtle.digest('SHA-256', clientKey)
  const serverKey = await hmac(salted, 'Server Key')
  return `SCRAM-SHA-256$${iterations}:${b64(s)}$${b64(storedKey)}:${b64(serverKey)}`
}

// ------------------------------------------------------------- expiry dates

/** The date part (YYYY-MM-DD, local time) of a stored expiry, for a date input. */
export function expiryToDate(validUntil: string): string {
  if (!validUntil) return ''
  const d = new Date(validUntil)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-CA')
}

/** A picked date means "works through the end of that day", in the viewer's time zone. */
export function dateToExpiry(date: string): string {
  return date ? new Date(`${date}T23:59:59.999`).toISOString() : ''
}

/** Connection limit as typed: blank or a lone minus means no limit. */
export function parseConnectionLimit(text: string): number {
  const n = Number.parseInt(text, 10)
  return Number.isNaN(n) || n < -1 ? -1 : n
}

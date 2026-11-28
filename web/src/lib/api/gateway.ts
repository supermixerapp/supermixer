/*
 * Calls to a project's own HTTP APIs (Auth admin, Storage, PostgREST spec,
 * Edge Functions, the Realtime socket)
 * through Supermixer's gateway proxy, which adds the stack's admin key.
 */
import { ApiError, readCookie } from './client'
import { t } from '@/lib/i18n'

/** The message from a Supermixer, GoTrue or Storage error body. */
function errorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>
    for (const k of ['msg', 'message', 'error_description', 'error']) {
      if (typeof b[k] === 'string' && b[k]) return b[k]
    }
  }
  return fallback
}

export interface GatewayInit {
  method?: string
  body?: BodyInit
  headers?: Record<string, string>
  signal?: AbortSignal
}

/** A request to `/projects/{ref}/gateway/{path}`, whatever its status. */
export function gatewayRaw(ref: string, path: string, init: GatewayInit = {}): Promise<Response> {
  const method = init.method ?? 'GET'
  const headers: Record<string, string> = { ...init.headers }
  // Always: some routes act on GET too (calling an Edge Function).
  const token = readCookie('sm_csrf')
  if (token) headers['X-CSRF-Token'] = decodeURIComponent(token)
  return fetch(`/api/v1/projects/${encodeURIComponent(ref)}/gateway/${path}`, {
    method,
    headers,
    credentials: 'same-origin',
    ...(init.body !== undefined && { body: init.body }),
    ...(init.signal && { signal: init.signal }),
  })
}

/** The gateway's WebSocket URL for a path, with the CSRF token browsers can't send as a header. */
export function gatewaySocketUrl(ref: string, path: string, query: Record<string, string> = {}): string {
  const token = readCookie('sm_csrf')
  const params = new URLSearchParams({ ...query, ...(token && { csrf: decodeURIComponent(token) }) })
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${scheme}//${location.host}/api/v1/projects/${encodeURIComponent(ref)}/gateway/${path}?${params}`
}

/** Any request to `/projects/{ref}/gateway/{path}`; throws ApiError with the stack's message. */
export async function gatewayFetch(ref: string, path: string, init: GatewayInit = {}): Promise<Response> {
  const res = await gatewayRaw(ref, path, init)
  if (!res.ok) {
    const text = await res.text()
    let body: unknown
    try {
      body = text ? JSON.parse(text) : undefined
    } catch {
      body = text
    }
    throw new ApiError(res.status, errorMessage(body, res.statusText || t('common:gateway.requestFailed', { status: res.status })))
  }
  return res
}

/** JSON request through the gateway. */
export async function gateway<T = unknown>(
  ref: string,
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {}
): Promise<T> {
  const res = await gatewayFetch(ref, path, {
    ...(init.method && { method: init.method }),
    ...(init.signal && { signal: init.signal }),
    headers: { Accept: 'application/json', ...(init.body !== undefined && { 'Content-Type': 'application/json' }) },
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
  })
  const text = await res.text()
  try {
    return (text ? JSON.parse(text) : undefined) as T
  } catch {
    return text as T
  }
}

/*
 * Calls to a project's own HTTP APIs (Auth admin, Storage, PostgREST spec)
 * through Supermixer's gateway proxy, which adds the stack's admin key.
 */
import { ApiError, readCookie } from './client'

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

/** JSON request to `/projects/{ref}/gateway/{path}`; throws ApiError with the stack's message. */
export async function gateway<T = unknown>(
  ref: string,
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {}
): Promise<T> {
  const method = init.method ?? 'GET'
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (init.body !== undefined) headers['Content-Type'] = 'application/json'
  if (method !== 'GET' && method !== 'HEAD') {
    const token = readCookie('sm_csrf')
    if (token) headers['X-CSRF-Token'] = decodeURIComponent(token)
  }
  const res = await fetch(`/api/v1/projects/${encodeURIComponent(ref)}/gateway/${path}`, {
    method,
    headers,
    credentials: 'same-origin',
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
    ...(init.signal && { signal: init.signal }),
  })
  const text = await res.text()
  let body: unknown
  try {
    body = text ? JSON.parse(text) : undefined
  } catch {
    body = text
  }
  if (!res.ok) throw new ApiError(res.status, errorMessage(body, res.statusText || `Request failed (${res.status})`))
  return body as T
}

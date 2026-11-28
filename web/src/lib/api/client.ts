import createClient, { type Middleware } from 'openapi-fetch'

import type { components, paths } from './schema.gen'
import { t } from '@/lib/i18n'

export type Schemas = components['schemas']

/** An API failure with the server's message (e.g. Studio-style permission errors). */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** The server's error code, for errors handled specially (e.g. password_change_required). */
    public code?: string
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export function readCookie(name: string): string | undefined {
  return document.cookie
    .split('; ')
    .find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1)
}

// State-changing requests echo the CSRF cookie in a header (double submit).
const csrf: Middleware = {
  onRequest({ request }) {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const token = readCookie('sm_csrf')
      if (token) request.headers.set('X-CSRF-Token', decodeURIComponent(token))
    }
    return request
  },
}

/** Typed client for the Supermixer REST API (generated from api/openapi.yaml). */
export const api = createClient<paths>({ baseUrl: '/api/v1' })
api.use(csrf)

/** Returns data, or throws ApiError with the server's message. */
export async function unwrap<T>(
  call: Promise<{ data?: T; error?: unknown; response: Response }>
): Promise<T> {
  const { data, error, response } = await call
  if (!response.ok) {
    let message = response.statusText || t('common:client.requestFailed')
    let code: string | undefined
    if (typeof error === 'object' && error !== null && 'message' in error) {
      message = String(error.message)
      if ('code' in error && typeof error.code === 'string') code = error.code
    } else if (typeof error === 'string' && error) message = error
    throw new ApiError(response.status, message, code)
  }
  return data as T
}

export const isApiError = (e: unknown, status?: number): e is ApiError =>
  e instanceof ApiError && (status === undefined || e.status === status)

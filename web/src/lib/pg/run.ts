import { queryOptions, useQuery } from '@tanstack/react-query'

import { api, ApiError, type Schemas } from '@/lib/api/client'

export type QueryResponse = Schemas['QueryResponse']
export type QueryResult = Schemas['QueryResult']

/** A Postgres error, with the details Studio shows under the editor. */
export class SqlError extends Error {
  code?: string
  detail?: string
  hint?: string
  position?: number
  constructor(e: Schemas['QueryError']) {
    super(e.message)
    this.name = 'SqlError'
    Object.assign(this, { code: e.code, detail: e.detail, hint: e.hint, position: e.position })
  }
}

export interface RunOptions {
  params?: (string | null)[]
  readOnly?: boolean
  maxRows?: number
  signal?: AbortSignal
}

/** Run SQL on a project's database. Throws SqlError or ApiError. */
export async function runSql(ref: string, query: string, opts: RunOptions = {}): Promise<QueryResponse> {
  const { data, error, response } = await api.POST('/projects/{ref}/query', {
    params: { path: { ref } },
    body: {
      query,
      ...(opts.params && { params: opts.params }),
      read_only: opts.readOnly ?? false,
      ...(opts.maxRows !== undefined && { max_rows: opts.maxRows }),
    },
    ...(opts.signal && { signal: opts.signal }),
  })
  if (data) return data
  if (response.status === 422) throw new SqlError(error as Schemas['QueryError'])
  throw new ApiError(response.status, (error as { message?: string } | undefined)?.message ?? response.statusText)
}

/** Rows of the last result as objects keyed by column name. */
export function rowsOf<T = Record<string, unknown>>(res: QueryResponse): T[] {
  const last = res.results[res.results.length - 1]
  if (!last) return []
  return last.rows.map((row) => Object.fromEntries(last.columns.map((c, i) => [c.name, row[i]])) as T)
}

/** A cached read of the project's catalog (tables, functions, …). */
export function pgQuery<T = Record<string, unknown>>(ref: string, key: readonly unknown[], sql: string, params?: (string | null)[]) {
  return queryOptions({
    queryKey: ['projects', ref, 'pg', ...key],
    queryFn: async ({ signal }) => rowsOf<T>(await runSql(ref, sql, { params, readOnly: true, maxRows: 10000, signal })),
    staleTime: 30_000,
  })
}

export function usePg<T = Record<string, unknown>>(ref: string, key: readonly unknown[], sql: string, params?: (string | null)[]) {
  return useQuery(pgQuery<T>(ref, key, sql, params))
}

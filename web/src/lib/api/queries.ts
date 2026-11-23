import { queryOptions } from '@tanstack/react-query'

import { api } from './client'

export const uiConfigQuery = queryOptions({
  queryKey: ['ui-config'],
  queryFn: async () => {
    const { data, error } = await api.GET('/ui-config')
    if (error) throw new Error(error.message)
    return data
  },
  staleTime: Infinity,
})

export const healthQuery = queryOptions({
  queryKey: ['health'],
  queryFn: async () => {
    // A 503 still carries a Health body describing what is down. Other
    // failures (proxy errors, plain-text bodies, network errors) throw.
    const { data, error } = await api.GET('/health')
    if (data) return data
    if (typeof error === 'object' && error !== null && 'status' in error && 'database' in error) {
      return error
    }
    const message =
      typeof error === 'object' && error !== null && 'message' in error ? String(error.message) : undefined
    throw new Error(message ?? 'Supermixer server is unreachable')
  },
  refetchInterval: 30_000,
})

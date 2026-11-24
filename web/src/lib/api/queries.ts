import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query'

import { api, unwrap } from './client'

export const uiConfigQuery = queryOptions({
  queryKey: ['ui-config'],
  queryFn: () => unwrap(api.GET('/ui-config')),
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

export const profileQuery = queryOptions({
  queryKey: ['profile'],
  queryFn: () => unwrap(api.GET('/profile')),
  staleTime: 60_000,
})

export const sessionsQuery = queryOptions({
  queryKey: ['profile', 'sessions'],
  queryFn: () => unwrap(api.GET('/profile/sessions')),
})

export const organizationsQuery = queryOptions({
  queryKey: ['organizations'],
  queryFn: () => unwrap(api.GET('/organizations')),
  staleTime: 30_000,
})

// Under ['organizations'], so adding or removing an organization or project
// (which refreshes that) refreshes these too.
export const organizationLimitsQuery = (slug: string) =>
  queryOptions({
    queryKey: ['organizations', slug, 'limits'],
    queryFn: () => unwrap(api.GET('/organizations/{slug}/limits', { params: { path: { slug } } })),
  })

/** How many organizations you've created, and may. */
export const myLimitsQuery = queryOptions({
  queryKey: ['organizations', '@my-limits'],
  queryFn: () => unwrap(api.GET('/profile/limits')),
})

export const resourceLimitsQuery = queryOptions({
  queryKey: ['admin', 'limits'],
  queryFn: () => unwrap(api.GET('/admin/limits')),
})

export const projectsQuery = queryOptions({
  queryKey: ['projects'],
  queryFn: () => unwrap(api.GET('/projects')),
  staleTime: 30_000,
})

export const projectQuery = (ref: string) =>
  queryOptions({
    queryKey: ['projects', ref],
    queryFn: () => unwrap(api.GET('/projects/{ref}', { params: { path: { ref } } })),
    staleTime: 30_000,
  })

export const projectHealthQuery = (ref: string) =>
  queryOptions({
    queryKey: ['projects', ref, 'health'],
    queryFn: () => unwrap(api.GET('/projects/{ref}/health', { params: { path: { ref } } })),
    refetchInterval: 30_000,
  })

export const apiKeysQuery = (ref: string, reveal = false) =>
  queryOptions({
    queryKey: ['projects', ref, 'api-keys', { reveal }],
    queryFn: () =>
      unwrap(api.GET('/projects/{ref}/api-keys', { params: { path: { ref }, query: { reveal } } })),
    // Revealed secrets are dropped from the cache as soon as nothing shows them.
    gcTime: reveal ? 0 : undefined,
    staleTime: reveal ? Infinity : undefined,
  })

export const membersQuery = (slug: string) =>
  queryOptions({
    queryKey: ['organizations', slug, 'members'],
    queryFn: () => unwrap(api.GET('/organizations/{slug}/members', { params: { path: { slug } } })),
  })

export const invitationsQuery = (slug: string) =>
  queryOptions({
    queryKey: ['organizations', slug, 'invitations'],
    queryFn: () => unwrap(api.GET('/organizations/{slug}/invitations', { params: { path: { slug } } })),
  })

export interface AuditFilters {
  action?: string
  actor_id?: string
  since?: string
}

export const auditLogsQuery = (slug: string, filters: AuditFilters) =>
  infiniteQueryOptions({
    queryKey: ['organizations', slug, 'audit-logs', filters],
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/organizations/{slug}/audit-logs', {
          params: {
            path: { slug },
            query: {
              action: filters.action || undefined,
              actor_id: filters.actor_id || undefined,
              since: filters.since || undefined,
              before: pageParam,
              limit: 50,
            },
          },
        })
      ),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.next_before ?? undefined,
  })

export const usersQuery = queryOptions({
  queryKey: ['admin', 'users'],
  queryFn: () => unwrap(api.GET('/admin/users')),
})

export const invitationQuery = (token: string) =>
  queryOptions({
    queryKey: ['invitations', token],
    queryFn: () => unwrap(api.GET('/invitations/{token}', { params: { path: { token } } })),
    retry: false,
  })

export const snippetsQuery = (ref: string) =>
  queryOptions({
    queryKey: ['projects', ref, 'snippets'],
    queryFn: () => unwrap(api.GET('/projects/{ref}/snippets', { params: { path: { ref } } })),
  })

export const snippetQuery = (ref: string, id: string) =>
  queryOptions({
    queryKey: ['projects', ref, 'snippets', id],
    queryFn: () => unwrap(api.GET('/projects/{ref}/snippets/{snippet_id}', { params: { path: { ref, snippet_id: id } } })),
    staleTime: Infinity, // the editor owns the content once loaded
  })

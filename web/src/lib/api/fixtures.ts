/*
 * Stage 0 placeholder data, so the app shell (switchers, sidebars, project
 * cards) can be exercised before the API exists. Stage 1 replaces these
 * query functions with calls to /api/v1/organizations and /api/v1/projects;
 * components already consume them through React Query.
 */
import { queryOptions } from '@tanstack/react-query'

export interface OrganizationSummary {
  slug: string
  name: string
}

export type ProjectStatus = 'healthy' | 'unhealthy' | 'unknown'

export interface ProjectSummary {
  ref: string
  name: string
  organizationSlug: string
  status: ProjectStatus
  apiUrl: string
}

const organizations: OrganizationSummary[] = [{ slug: 'demo', name: 'Demo organization' }]

const projects: ProjectSummary[] = [
  {
    ref: 'demoprojectref000001',
    name: 'Demo project',
    organizationSlug: 'demo',
    status: 'unknown',
    apiUrl: 'http://localhost:8000',
  },
]

export const organizationsQuery = queryOptions({
  queryKey: ['organizations'],
  queryFn: async () => organizations,
})

export const projectsQuery = queryOptions({
  queryKey: ['projects'],
  queryFn: async () => projects,
})

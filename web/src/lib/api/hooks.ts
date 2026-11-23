import { useQuery } from '@tanstack/react-query'
import { useParams } from '@tanstack/react-router'

import type { Schemas } from './client'
import { organizationsQuery, profileQuery, projectQuery, projectsQuery } from './queries'

export function useProfile() {
  return useQuery(profileQuery)
}

export function useOrganizations() {
  return useQuery(organizationsQuery)
}

export function useProjects() {
  return useQuery(projectsQuery)
}

/** The project in the URL (/project/$ref/...). */
export function useSelectedProject(): Schemas['Project'] | undefined {
  const { ref } = useParams({ strict: false }) as { ref?: string }
  const { data } = useQuery({ ...projectQuery(ref ?? ''), enabled: !!ref })
  return ref ? data : undefined
}

/** The organization in the URL, or the one owning the project in the URL. */
export function useSelectedOrganization(): Schemas['Organization'] | undefined {
  const { slug } = useParams({ strict: false }) as { slug?: string }
  const project = useSelectedProject()
  const { data: orgs } = useOrganizations()
  const target = slug ?? project?.organization_slug
  return target ? orgs?.find((o) => o.slug === target) : undefined
}

/** Whether a permission string (see backend/internal/rbac) is granted. */
export function can(subject: { permissions: string[] } | undefined, permission: string) {
  return !!subject?.permissions.includes(permission)
}

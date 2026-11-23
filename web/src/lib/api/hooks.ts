import { useQuery } from '@tanstack/react-query'
import { useParams } from '@tanstack/react-router'

import { organizationsQuery, projectsQuery } from './fixtures'

export function useOrganizations() {
  return useQuery(organizationsQuery)
}

export function useProjects() {
  return useQuery(projectsQuery)
}

/** The organization in the URL, or the one owning the project in the URL. */
export function useSelectedOrganization() {
  const params = useParams({ strict: false }) as { slug?: string; ref?: string }
  const { data: orgs } = useOrganizations()
  const { data: projects } = useProjects()
  const slug = params.slug ?? projects?.find((p) => p.ref === params.ref)?.organizationSlug
  return orgs?.find((o) => o.slug === slug)
}

export function useSelectedProject() {
  const params = useParams({ strict: false }) as { ref?: string }
  const { data: projects } = useProjects()
  return params.ref ? projects?.find((p) => p.ref === params.ref) : undefined
}

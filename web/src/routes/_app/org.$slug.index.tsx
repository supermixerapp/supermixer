import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'

import { AddIcon, DatabaseIcon, SearchIcon } from '@/components/icons'
import { PageContainer, PageHeader } from '@/components/layout/page'
import { PermissionButton } from '@/components/permission-button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import type { Schemas } from '@/lib/api/client'
import { can, useProjects, useSelectedOrganization } from '@/lib/api/hooks'
import { projectHealthQuery } from '@/lib/api/queries'

import { HealthBadge } from '@/components/health-badge'
import { StackBadge, stackBusy, stackQuery, stackUp, useStackGone } from '@/components/project/stack'

export const Route = createFileRoute('/_app/org/$slug/')({
  component: ProjectsPage,
})

function ProjectsPage() {
  const { slug } = Route.useParams()
  const org = useSelectedOrganization()
  const navigate = useNavigate()
  const { data: projects, isPending } = useProjects()
  const [search, setSearch] = useState('')
  const inOrg = (projects ?? []).filter((p) => p.organization_slug === slug)
  const visible = inOrg.filter((p) => p.name.toLowerCase().includes(search.toLowerCase()))
  const canCreate = can(org, 'projects:create')

  const newProject = (
    <PermissionButton
      allowed={canCreate}
      action="add projects"
      variant="primary"
      icon={<AddIcon />}
      onClick={() => navigate({ to: '/new/$slug', params: { slug } })}
    >
      New project
    </PermissionButton>
  )

  return (
    <>
      <PageHeader title="Projects" size="large" />
      <PageContainer size="large" className="flex flex-col gap-4 pb-12">
        <div className="flex items-center justify-between gap-2">
          <div className="relative w-full max-w-64">
            <SearchIcon
              size={14}
              className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-foreground-lighter"
            />
            <Input
              size="tiny"
              className="pl-7"
              placeholder="Search for a project"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {newProject}
        </div>
        {isPending ? (
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
            <Skeleton className="h-36" />
            <Skeleton className="h-36" />
          </div>
        ) : inOrg.length === 0 ? (
          <Card className="flex flex-col items-center gap-3 px-6 py-14 text-center">
            <DatabaseIcon size={28} className="text-foreground-lighter" />
            <p className="text-sm text-foreground">No projects yet</p>
            <p className="max-w-md text-sm text-foreground-lighter">
              A project is one self-hosted Supabase stack: its Postgres database plus Auth, Storage, Realtime and the
              rest. Register a running stack to manage it here.
            </p>
            <div className="mt-2">{newProject}</div>
          </Card>
        ) : (
          <ul className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
            {visible.map((p) => (
              <ProjectCard key={p.ref} project={p} />
            ))}
          </ul>
        )}
        {inOrg.length > 0 && visible.length === 0 && (
          <p className="py-12 text-center text-sm text-foreground-lighter">No projects match your search.</p>
        )}
      </PageContainer>
    </>
  )
}

function ProjectCard({ project }: { project: Schemas['Project'] }) {
  // Follow stacks that are changing, so the card doesn't go stale.
  const live = useQuery({ ...stackQuery(project.ref), enabled: stackBusy(project.stack) })
  const stack = live.data ?? project.stack
  useStackGone(live.error)
  // A paused, failed or still-starting stack has nothing to check yet.
  const health = useQuery({ ...projectHealthQuery(project.ref), enabled: stackUp(stack) })
  return (
    <li>
      <Link to="/project/$ref" params={{ ref: project.ref }} className="group block rounded-panel focus-ring">
        <Card className="flex h-36 flex-col justify-between px-5 py-4 transition-colors group-hover:border-strong group-hover:bg-surface-200">
          <div className="flex flex-col gap-0.5">
            <h5 className="font-sans text-sm font-normal text-foreground">{project.name}</h5>
            <p className="truncate font-mono text-xs text-foreground-lighter">{project.api_url}</p>
          </div>
          <div className="flex items-center gap-2">
            {stackUp(stack) ? (
              <HealthBadge status={health.data?.status} loading={health.isPending} />
            ) : (
              <StackBadge stack={stack!} />
            )}
            {stackUp(stack) && health.data?.postgres_version && (
              <span className="text-xs text-foreground-lighter">Postgres {health.data.postgres_version}</span>
            )}
          </div>
        </Card>
      </Link>
    </li>
  )
}

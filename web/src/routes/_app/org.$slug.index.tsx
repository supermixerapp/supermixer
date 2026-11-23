import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'

import { AddIcon, SearchIcon } from '@/components/icons'
import { PageContainer, PageHeader } from '@/components/layout/page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { ProjectStatus } from '@/lib/api/fixtures'
import { useProjects } from '@/lib/api/hooks'

export const Route = createFileRoute('/org/$slug/')({
  component: ProjectsPage,
})

const statusBadge: Record<ProjectStatus, { label: string; variant: 'success' | 'destructive' | 'default' }> = {
  healthy: { label: 'Healthy', variant: 'success' },
  unhealthy: { label: 'Unhealthy', variant: 'destructive' },
  unknown: { label: 'Not connected', variant: 'default' },
}

function ProjectsPage() {
  const { slug } = Route.useParams()
  const { data: projects = [] } = useProjects()
  const [search, setSearch] = useState('')
  const visible = projects.filter(
    (p) => p.organizationSlug === slug && p.name.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <>
      <PageHeader title="Projects" size="large" />
      <PageContainer size="large" className="flex flex-col gap-4 pb-12">
        <div className="flex items-center justify-between gap-2">
          <div className="relative w-full max-w-64">
            <SearchIcon size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-foreground-lighter" />
            <Input
              size="tiny"
              className="pl-7"
              placeholder="Search for a project"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <Button variant="primary" icon={<AddIcon />} disabled>
                  New project
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>Registering projects arrives in Stage 1</TooltipContent>
          </Tooltip>
        </div>
        <ul className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
          {visible.map((p) => (
            <li key={p.ref}>
              <Link to="/project/$ref" params={{ ref: p.ref }} className="group block rounded-panel focus-ring">
                <Card className="flex h-36 flex-col justify-between px-5 py-4 transition-colors group-hover:border-strong group-hover:bg-surface-200">
                  <div className="flex flex-col gap-0.5">
                    <h5 className="font-sans text-sm font-normal text-foreground">{p.name}</h5>
                    <p className="truncate font-mono text-xs text-foreground-lighter">{p.apiUrl}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={statusBadge[p.status].variant}>{statusBadge[p.status].label}</Badge>
                  </div>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
        {visible.length === 0 && (
          <p className="py-12 text-center text-sm text-foreground-lighter">No projects match your search.</p>
        )}
      </PageContainer>
    </>
  )
}

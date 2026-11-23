import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'

import { AddIcon, ProjectsIcon, SearchIcon } from '@/components/icons'
import { AppShell } from '@/components/layout/app-shell'
import { PageContainer, PageHeader } from '@/components/layout/page'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useOrganizations, useProjects } from '@/lib/api/hooks'

export const Route = createFileRoute('/organizations')({
  component: OrganizationsPage,
})

function OrganizationsPage() {
  const { data: orgs, isPending } = useOrganizations()
  const { data: projects = [] } = useProjects()
  const [search, setSearch] = useState('')
  const visible = (orgs ?? []).filter((o) => o.name.toLowerCase().includes(search.toLowerCase()))

  return (
    <AppShell>
      <div className="overflow-y-auto">
        <PageHeader title="Your Organizations" />
        <PageContainer className="flex flex-col gap-4 pb-12">
          <div className="flex items-center justify-between gap-2">
            <div className="relative w-full max-w-64">
              <SearchIcon size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-foreground-lighter" />
              <Input
                size="tiny"
                className="pl-7"
                placeholder="Search for an organization"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button variant="primary" icon={<AddIcon />} disabled>
                    New organization
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>Creating organizations arrives in Stage 1</TooltipContent>
            </Tooltip>
          </div>
          {isPending ? (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {visible.map((org) => {
                const count = projects.filter((p) => p.organizationSlug === org.slug).length
                return (
                  <Link key={org.slug} to="/org/$slug" params={{ slug: org.slug }} className="group rounded-panel focus-ring">
                    <Card className="flex items-center gap-3 px-4 py-4 transition-colors group-hover:border-strong group-hover:bg-surface-200">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border bg-surface-200">
                        <ProjectsIcon size={18} className="text-foreground-light" />
                      </div>
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate text-sm text-foreground">{org.name}</span>
                        <span className="text-xs text-foreground-lighter">
                          {count} {count === 1 ? 'project' : 'projects'}
                        </span>
                      </div>
                    </Card>
                  </Link>
                )
              })}
            </div>
          )}
        </PageContainer>
      </div>
    </AppShell>
  )
}

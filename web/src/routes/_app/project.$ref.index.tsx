import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import type { ReactNode } from 'react'

import { HealthBadge } from '@/components/health-badge'
import { ExternalLinkIcon } from '@/components/icons'
import { PageContainer, PageHeader } from '@/components/layout/page'
import { SettingsSection } from '@/components/layout/section'
import { HealthChecks } from '@/components/project/connection-form'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { CopyField } from '@/components/ui/copy'
import { Skeleton } from '@/components/ui/skeleton'
import { useSelectedProject } from '@/lib/api/hooks'
import { projectHealthQuery } from '@/lib/api/queries'
import { roleLabel } from '@/lib/roles'

export const Route = createFileRoute('/_app/project/$ref/')({
  component: ProjectOverview,
})

function ProjectOverview() {
  const { ref } = Route.useParams()
  const project = useSelectedProject()
  const health = useQuery(projectHealthQuery(ref))
  const queryClient = useQueryClient()
  if (!project) return null

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            {project.name}
            <HealthBadge status={health.data?.status} loading={health.isPending} />
          </span>
        }
        description={project.api_url}
        size="large"
        actions={
          project.studio_url && (
              <Button asChild variant="default" iconRight={<ExternalLinkIcon />}>
                <a href={project.studio_url} target="_blank" rel="noreferrer">
                  Open Studio
                </a>
              </Button>
          )
        }
      />
      <PageContainer size="large" className="grid gap-10 pb-16 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <SettingsSection
            title="Service health"
            description={
              health.data ? `Checked ${new Date(health.data.checked_at).toLocaleTimeString()}; refreshes every 30 seconds.` : undefined
            }
          >
            {health.isPending ? (
              <Skeleton className="h-56" />
            ) : health.data ? (
              <HealthChecks report={health.data} />
            ) : (
              <p className="text-sm text-destructive">{health.error?.message}</p>
            )}
            <Button
              variant="default"
              className="self-start"
              loading={health.isFetching}
              onClick={() => queryClient.invalidateQueries({ queryKey: projectHealthQuery(ref).queryKey })}
            >
              Check again
            </Button>
          </SettingsSection>
        </div>
        <div className="flex flex-col gap-10 lg:col-span-2">
          <SettingsSection title="Project details">
            <Card>
              <dl className="divide-y text-sm">
                <Detail label="Reference ID">
                  <span className="font-mono text-xs">{project.ref}</span>
                </Detail>
                <Detail label="Organization">{project.organization_name}</Detail>
                <Detail label="Your role">{roleLabel(project.role)}</Detail>
                <Detail label="Postgres">{health.data?.postgres_version ?? '—'}</Detail>
                <Detail label="Auth">{health.data?.auth_version ?? '—'}</Detail>
                <Detail label="Registered">{new Date(project.created_at).toLocaleDateString()}</Detail>
              </dl>
            </Card>
          </SettingsSection>
          <SettingsSection title="Project URL">
            <CopyField value={project.api_url} />
          </SettingsSection>
        </div>
      </PageContainer>
    </>
  )
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-2.5">
      <dt className="text-foreground-light">{label}</dt>
      <dd className="truncate text-right text-foreground">{children}</dd>
    </div>
  )
}

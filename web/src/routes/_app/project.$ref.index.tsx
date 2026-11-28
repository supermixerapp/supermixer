import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import type { ReactNode } from 'react'

import { HealthBadge } from '@/components/health-badge'
import { ExternalLinkIcon } from '@/components/icons'
import { PageContainer, PageHeader } from '@/components/layout/page'
import { SettingsSection } from '@/components/layout/section'
import { HealthChecks } from '@/components/project/connection-form'
import { RotationAdvice } from '@/components/project/rotation-advice'
import { StackBadge, StackProgress, stackUp } from '@/components/project/stack'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { CopyField } from '@/components/ui/copy'
import { Skeleton } from '@/components/ui/skeleton'
import { useSelectedProject } from '@/lib/api/hooks'
import { projectHealthQuery } from '@/lib/api/queries'
import { roleLabel } from '@/lib/roles'
import { t, language } from '@/lib/i18n'

export const Route = createFileRoute('/_app/project/$ref/')({
  component: ProjectOverview,
})

function ProjectOverview() {
  const { ref } = Route.useParams()
  const project = useSelectedProject()
  const up = !!project && stackUp(project.stack)
  const health = useQuery({ ...projectHealthQuery(ref), enabled: up })
  const queryClient = useQueryClient()
  if (!project) return null

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            {project.name}
            {stackUp(project.stack) ? (
              <HealthBadge status={health.data?.status} loading={health.isPending} />
            ) : (
              <StackBadge stack={project.stack!} />
            )}
          </span>
        }
        description={project.api_url}
        size="large"
        actions={
          // Not for a stack Supermixer created without Studio: it would answer 503.
          project.studio_url && project.stack?.studio !== false && (
              <Button asChild variant="default" iconRight={<ExternalLinkIcon />}>
                <a href={project.studio_url} target="_blank" rel="noreferrer">
                  {t('project:app.openStudio')}
                </a>
              </Button>
          )
        }
      />
      <PageContainer size="large" className="grid gap-10 pb-16 lg:grid-cols-5">
        <div className="empty:hidden lg:col-span-5">
          <RotationAdvice project={project} linkToKeys />
        </div>
        {project.stack && (
          <div className="empty:hidden lg:col-span-5">
            <StackProgress project={project} />
          </div>
        )}
        <div className="lg:col-span-3">
          <SettingsSection
            title={t('project:app.serviceHealth')}
            description={
              health.data ? t('project:app.checkedRefreshesEvery30Seconds', { localeTimeString: new Date(health.data.checked_at).toLocaleTimeString(language()) }) : undefined
            }
          >
            {!up ? (
              <p className="text-sm text-foreground-lighter">{t('project:app.healthChecksRunWhileTheStack')}</p>
            ) : health.isPending ? (
              <Skeleton className="h-56" />
            ) : health.data ? (
              <HealthChecks report={health.data} />
            ) : (
              <p className="text-sm text-destructive">{health.error?.message}</p>
            )}
            {up && (
              <Button
                variant="default"
                className="self-start"
                loading={health.isFetching}
                onClick={() => queryClient.invalidateQueries({ queryKey: projectHealthQuery(ref).queryKey })}
              >
                {t('project:app.checkAgain')}
              </Button>
            )}
          </SettingsSection>
        </div>
        <div className="flex flex-col gap-10 lg:col-span-2">
          <SettingsSection title={t('project:app.projectDetails')}>
            <Card>
              <dl className="divide-y text-sm">
                <Detail label={t('project:app.referenceId')}>
                  <span className="font-mono text-xs">{project.ref}</span>
                </Detail>
                <Detail label={t('project:app.organization')}>{project.organization_name}</Detail>
                <Detail label={t('project:app.yourRole')}>{roleLabel(project.role)}</Detail>
                <Detail label={t('project:app.postgres')}>{health.data?.postgres_version ?? '—'}</Detail>
                <Detail label={t('project:app.auth')}>{health.data?.auth_version ?? '—'}</Detail>
                <Detail label={t('project:app.registered')}>{new Date(project.created_at).toLocaleDateString(language())}</Detail>
              </dl>
            </Card>
          </SettingsSection>
          <SettingsSection title={t('project:app.projectUrl')}>
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

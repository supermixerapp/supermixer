import { createFileRoute } from '@tanstack/react-router'

import { PageContainer, PageHeader } from '@/components/layout/page'
import { LogDrains } from '@/components/project/log-drains'
import { Alert } from '@/components/ui/alert'
import { useSelectedProject } from '@/lib/api/hooks'
import { t } from '@/lib/i18n'

export const Route = createFileRoute('/_app/project/$ref/settings/log-drains')({
  component: LogDrainsPage,
})

function LogDrainsPage() {
  const project = useSelectedProject()
  return (
    <>
      <PageHeader title={t('project:settingsLogDrains.logDrains')} description={t('project:settingsLogDrains.sendThisProjectSLogsTo')} />
      <PageContainer className="flex flex-col gap-4 pb-16">
        {!project ? null : project.stack ? (
          <LogDrains project={project} />
        ) : (
          <Alert title={t('project:settingsLogDrains.supermixerConnectsToThisStackIt')}>
            {t('project:settingsLogDrains.itsLogsFlowWhereItRuns')}
          </Alert>
        )}
      </PageContainer>
    </>
  )
}

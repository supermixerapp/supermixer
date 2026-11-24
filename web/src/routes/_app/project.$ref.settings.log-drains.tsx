import { createFileRoute } from '@tanstack/react-router'

import { PageContainer, PageHeader } from '@/components/layout/page'
import { LogDrains } from '@/components/project/log-drains'
import { Alert } from '@/components/ui/alert'
import { useSelectedProject } from '@/lib/api/hooks'

export const Route = createFileRoute('/_app/project/$ref/settings/log-drains')({
  component: LogDrainsPage,
})

function LogDrainsPage() {
  const project = useSelectedProject()
  return (
    <>
      <PageHeader title="Log Drains" description="Send this project's logs to your own observability tools." />
      <PageContainer className="flex flex-col gap-4 pb-16">
        {!project ? null : project.stack ? (
          <LogDrains project={project} />
        ) : (
          <Alert title="Supermixer connects to this stack; it didn't create it">
            Its logs flow where it runs: add a sink to its Vector configuration there. Projects created with
            “Create a new stack” get log drains here.
          </Alert>
        )}
      </PageContainer>
    </>
  )
}

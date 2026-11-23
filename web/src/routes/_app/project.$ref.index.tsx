import { createFileRoute } from '@tanstack/react-router'

import { ComingSoon, PageHeader } from '@/components/layout/page'
import { useSelectedProject } from '@/lib/api/hooks'

export const Route = createFileRoute('/project/$ref/')({
  component: ProjectOverview,
})

function ProjectOverview() {
  const project = useSelectedProject()
  return (
    <>
      <PageHeader title={project?.name ?? 'Project'} description={project?.apiUrl} size="large" />
      <ComingSoon
        title="Project Overview"
        stage={1}
        description="Service health (Auth, REST, Storage, Realtime, pg-meta, Postgres), the API URL and connection details for this stack arrive in Stage 1."
      />
    </>
  )
}

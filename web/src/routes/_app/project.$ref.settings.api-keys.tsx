import { createFileRoute } from '@tanstack/react-router'

import { PageContainer, PageHeader } from '@/components/layout/page'
import { ApiKeyList } from '@/components/project/api-key-list'
import { RotateKeys } from '@/components/project/rotate-keys'
import { useSelectedProject } from '@/lib/api/hooks'

export const Route = createFileRoute('/_app/project/$ref/settings/api-keys')({
  component: ApiKeysPage,
})

function ApiKeysPage() {
  const { ref } = Route.useParams()
  const project = useSelectedProject()
  return (
    <>
      <PageHeader
        title="API Keys"
        description="Keys your apps use to call this project's APIs. Public keys are safe in a browser when Row Level Security is enabled; secret keys bypass it."
        size="small"
      />
      <PageContainer size="small" className="flex flex-col gap-10 pb-16">
        <ApiKeyList projectRef={ref} ids={['publishable', 'secret']} title="Publishable and secret keys" />
        <ApiKeyList projectRef={ref} ids={['anon', 'service_role']} title="Legacy API keys" />
        {project?.stack && <RotateKeys project={project} />}
      </PageContainer>
    </>
  )
}

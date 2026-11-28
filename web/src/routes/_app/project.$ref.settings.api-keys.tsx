import { createFileRoute } from '@tanstack/react-router'

import { PageContainer, PageHeader } from '@/components/layout/page'
import { ApiKeyList } from '@/components/project/api-key-list'
import { RotateKeys } from '@/components/project/rotate-keys'
import { RotationAdvice } from '@/components/project/rotation-advice'
import { useSelectedProject } from '@/lib/api/hooks'
import { t } from '@/lib/i18n'

export const Route = createFileRoute('/_app/project/$ref/settings/api-keys')({
  component: ApiKeysPage,
})

function ApiKeysPage() {
  const { ref } = Route.useParams()
  const project = useSelectedProject()
  return (
    <>
      <PageHeader
        title={t('project:settingsApiKeys.apiKeys')}
        description={t('project:settingsApiKeys.keysYourAppsUseToCall')}
        size="small"
      />
      <PageContainer size="small" className="flex flex-col gap-10 pb-16">
        {project && <RotationAdvice project={project} />}
        <ApiKeyList projectRef={ref} ids={['publishable', 'secret']} title={t('project:settingsApiKeys.publishableAndSecretKeys')} />
        <ApiKeyList projectRef={ref} ids={['anon', 'service_role']} title={t('project:settingsApiKeys.legacyApiKeys')} />
        {project?.stack && <RotateKeys project={project} />}
      </PageContainer>
    </>
  )
}

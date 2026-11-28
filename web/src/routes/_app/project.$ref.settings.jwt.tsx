import { createFileRoute } from '@tanstack/react-router'

import { PageContainer, PageHeader } from '@/components/layout/page'
import { ApiKeyList } from '@/components/project/api-key-list'
import { t } from '@/lib/i18n'

export const Route = createFileRoute('/_app/project/$ref/settings/jwt')({
  component: JwtKeysPage,
})

function JwtKeysPage() {
  const { ref } = Route.useParams()
  return (
    <>
      <PageHeader
        title={t('project:settingsJwt.jwtKeys')}
        description={t('project:settingsJwt.theSecretThatSignsThisStack')}
        size="small"
      />
      <PageContainer size="small" className="flex flex-col gap-10 pb-16">
        <ApiKeyList projectRef={ref} ids={['jwt_secret']} title={t('project:settingsJwt.legacyJwtSecret')} />
      </PageContainer>
    </>
  )
}

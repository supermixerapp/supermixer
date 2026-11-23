import { createFileRoute } from '@tanstack/react-router'

import { PageContainer, PageHeader } from '@/components/layout/page'
import { ApiKeyList } from '@/components/project/api-key-list'

export const Route = createFileRoute('/_app/project/$ref/settings/jwt')({
  component: JwtKeysPage,
})

function JwtKeysPage() {
  const { ref } = Route.useParams()
  return (
    <>
      <PageHeader
        title="JWT Keys"
        description="The secret that signs this stack's legacy API keys and user session tokens (JWT_SECRET)."
        size="small"
      />
      <PageContainer size="small" className="flex flex-col gap-10 pb-16">
        <ApiKeyList projectRef={ref} ids={['jwt_secret']} title="Legacy JWT secret" />
      </PageContainer>
    </>
  )
}

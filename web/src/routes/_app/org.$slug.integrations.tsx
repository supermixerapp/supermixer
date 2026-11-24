import { createFileRoute } from '@tanstack/react-router'

import { ComingSoon } from '@/components/layout/page'

export const Route = createFileRoute('/_app/org/$slug/integrations')({
  component: IntegrationsPage,
})

function IntegrationsPage() {
  return (
    <ComingSoon title="Integrations" soon description="Organization-level integrations (such as GitHub) are coming soon." />
  )
}

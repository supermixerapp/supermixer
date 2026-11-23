import { createFileRoute } from '@tanstack/react-router'

import { ComingSoon } from '@/components/layout/page'

export const Route = createFileRoute('/org/$slug/integrations')({
  component: IntegrationsPage,
})

function IntegrationsPage() {
  return (
    <ComingSoon
      title="Integrations"
      stage={5}
      description="Organization-level integrations. Arrives in Stage 5."
    />
  )
}

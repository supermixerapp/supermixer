import { createFileRoute } from '@tanstack/react-router'

import { ComingSoon } from '@/components/layout/page'

export const Route = createFileRoute('/org/$slug/general')({
  component: OrganizationSettingsPage,
})

function OrganizationSettingsPage() {
  return (
    <ComingSoon
      title="Organization Settings"
      stage={1}
      description="Rename or delete this organization. Arrives in Stage 1."
    />
  )
}

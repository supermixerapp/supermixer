import { createFileRoute } from '@tanstack/react-router'

import { ComingSoon } from '@/components/layout/page'

export const Route = createFileRoute('/org/$slug/team')({
  component: TeamPage,
})

function TeamPage() {
  return (
    <ComingSoon
      title="Team"
      stage={1}
      description="Members, invitations and roles (Owner, Administrator, Developer, Read-Only, No-access). Arrives in Stage 1."
    />
  )
}

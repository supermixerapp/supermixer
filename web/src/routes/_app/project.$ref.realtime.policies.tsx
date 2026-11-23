import { createFileRoute } from '@tanstack/react-router'

import { PoliciesView } from '@/components/database/policies-view'

export const Route = createFileRoute('/_app/project/$ref/realtime/policies')({
  component: RealtimePoliciesPage,
})

function RealtimePoliciesPage() {
  const { ref } = Route.useParams()
  return (
    <PoliciesView
      projectRef={ref}
      schema="realtime"
      realtime
      description="Policies on realtime.messages decide who can receive and send Broadcast and Presence messages on private channels. Public channels and Postgres Changes don't use them."
    />
  )
}

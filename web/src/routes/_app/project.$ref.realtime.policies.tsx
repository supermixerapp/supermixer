import { createFileRoute } from '@tanstack/react-router'

import { PoliciesView } from '@/components/database/policies-view'
import { t } from '@/lib/i18n'

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
      description={t('realtime:realtimePolicies.policiesOnRealtimeMessagesDecideWho')}
    />
  )
}

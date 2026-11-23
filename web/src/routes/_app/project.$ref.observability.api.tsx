import { createFileRoute } from '@tanstack/react-router'

import { DatabasePage } from '@/components/database/catalog-page'
import { RequestsReport } from '@/components/logs/requests-report'

export const Route = createFileRoute('/_app/project/$ref/observability/api')({
  component: ApiReportPage,
})

function ApiReportPage() {
  const { ref } = Route.useParams()
  return (
    <DatabasePage title="API Gateway" description="Requests through the stack's API gateway over the last 24 hours, from its logs. Refreshes every minute.">
      <RequestsReport projectRef={ref} />
    </DatabasePage>
  )
}

import { createFileRoute } from '@tanstack/react-router'

import { DatabasePage } from '@/components/database/catalog-page'
import { RequestsReport } from '@/components/logs/requests-report'
import { t } from '@/lib/i18n'

export const Route = createFileRoute('/_app/project/$ref/observability/api')({
  component: ApiReportPage,
})

function ApiReportPage() {
  const { ref } = Route.useParams()
  return (
    <DatabasePage title={t('observability:observabilityApi.apiGateway')} description={t('observability:observabilityApi.requestsThroughTheStackSApi')}>
      <RequestsReport projectRef={ref} />
    </DatabasePage>
  )
}

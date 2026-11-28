import { createFileRoute } from '@tanstack/react-router'

import { AdvisorPage } from '@/components/advisors/advisor-page'
import { t } from '@/lib/i18n'

export const Route = createFileRoute('/_app/project/$ref/advisors/performance')({
  component: PerformanceAdvisorPage,
})

function PerformanceAdvisorPage() {
  const { ref } = Route.useParams()
  return (
    <AdvisorPage
      projectRef={ref}
      category="PERFORMANCE"
      title={t('observability:advisorsPerformance.performanceAdvisor')}
      description={t('observability:advisorsPerformance.missingAndUnusedIndexesSlowPolicies')}
    />
  )
}

import { createFileRoute } from '@tanstack/react-router'

import { AdvisorPage } from '@/components/advisors/advisor-page'

export const Route = createFileRoute('/_app/project/$ref/advisors/performance')({
  component: PerformanceAdvisorPage,
})

function PerformanceAdvisorPage() {
  const { ref } = Route.useParams()
  return (
    <AdvisorPage
      projectRef={ref}
      category="PERFORMANCE"
      title="Performance Advisor"
      description="Missing and unused indexes, slow policies and other things that make queries slower than they need to be."
    />
  )
}

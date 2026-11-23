import { createFileRoute } from '@tanstack/react-router'

import { AdvisorPage } from '@/components/advisors/advisor-page'

export const Route = createFileRoute('/_app/project/$ref/advisors/security')({
  component: SecurityAdvisorPage,
})

function SecurityAdvisorPage() {
  const { ref } = Route.useParams()
  return (
    <AdvisorPage
      projectRef={ref}
      category="SECURITY"
      title="Security Advisor"
      description="Settings and objects that could expose data through the API, such as tables without Row Level Security."
    />
  )
}

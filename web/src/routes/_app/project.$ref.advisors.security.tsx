import { createFileRoute } from '@tanstack/react-router'

import { AdvisorPage } from '@/components/advisors/advisor-page'
import { t } from '@/lib/i18n'

export const Route = createFileRoute('/_app/project/$ref/advisors/security')({
  component: SecurityAdvisorPage,
})

function SecurityAdvisorPage() {
  const { ref } = Route.useParams()
  return (
    <AdvisorPage
      projectRef={ref}
      category="SECURITY"
      title={t('observability:advisorsSecurity.securityAdvisor')}
      description={t('observability:advisorsSecurity.settingsAndObjectsThatCouldExpose')}
    />
  )
}

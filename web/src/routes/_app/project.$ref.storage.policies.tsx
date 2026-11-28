import { createFileRoute } from '@tanstack/react-router'

import { PoliciesView } from '@/components/database/policies-view'
import { t } from '@/lib/i18n'

export const Route = createFileRoute('/_app/project/$ref/storage/policies')({
  component: StoragePoliciesPage,
})

function StoragePoliciesPage() {
  const { ref } = Route.useParams()
  return (
    <PoliciesView
      projectRef={ref}
      schema="storage"
      storage
      description={t('storage:storagePolicies.policiesOnStorageSTablesDecide')}
    />
  )
}

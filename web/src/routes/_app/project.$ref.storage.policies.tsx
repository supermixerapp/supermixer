import { createFileRoute } from '@tanstack/react-router'

import { PoliciesView } from '@/components/database/policies-view'

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
      description="Policies on Storage's tables decide who can read, upload, change and delete files through the API. Without any, only the service key can."
    />
  )
}

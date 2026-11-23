import { createFileRoute, useNavigate } from '@tanstack/react-router'

import { schemaSearch } from '@/components/database/catalog-page'
import { PoliciesView } from '@/components/database/policies-view'

export const Route = createFileRoute('/_app/project/$ref/auth/policies')({
  validateSearch: schemaSearch,
  component: AuthPoliciesPage,
})

function AuthPoliciesPage() {
  const { ref } = Route.useParams()
  const { schema = 'public' } = Route.useSearch()
  const navigate = useNavigate()
  return <PoliciesView projectRef={ref} schema={schema} onSchemaChange={(s) => void navigate({ to: '.', search: { schema: s } })} />
}

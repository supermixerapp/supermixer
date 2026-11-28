import { createFileRoute } from '@tanstack/react-router'

import { LogsView } from '@/components/logs/logs-view'
import { LOG_COLLECTIONS } from '@/lib/logs'

import { NotFoundContent } from '../__root'

export const Route = createFileRoute('/_app/project/$ref/logs/$collection')({
  component: LogCollectionPage,
})

function LogCollectionPage() {
  const { ref, collection } = Route.useParams()
  const c = LOG_COLLECTIONS()[collection]
  if (!c) return <NotFoundContent />
  // Keyed so switching collections starts with fresh filters.
  return <LogsView key={collection} projectRef={ref} title={c.title} description={c.description} source={c.source} {...(c.search && { search: c.search })} />
}

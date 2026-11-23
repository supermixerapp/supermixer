import { createFileRoute } from '@tanstack/react-router'

import { ComingSoon } from '@/components/layout/page'
import { describeProjectPath } from '@/lib/navigation'

import { NotFoundContent } from './__root'

/** Every project page not built yet: shows which stage brings it. */
export const Route = createFileRoute('/project/$ref/$')({
  component: ProjectPlaceholder,
})

function ProjectPlaceholder() {
  const { _splat } = Route.useParams()
  const page = describeProjectPath((_splat ?? '').replace(/\/+$/, ''))
  if (!page) return <NotFoundContent />
  return <ComingSoon title={page.label} stage={page.stage} />
}

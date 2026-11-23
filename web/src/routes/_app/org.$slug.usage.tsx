import { createFileRoute } from '@tanstack/react-router'

import { ComingSoon } from '@/components/layout/page'

export const Route = createFileRoute('/org/$slug/usage')({
  component: UsagePage,
})

function UsagePage() {
  return (
    <ComingSoon
      title="Usage"
      stage={3}
      description="Resource usage of each project: database size, connections and requests. Arrives in Stage 3."
    />
  )
}

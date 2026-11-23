import { createFileRoute } from '@tanstack/react-router'

import { LogsView } from '@/components/logs/logs-view'

export const Route = createFileRoute('/_app/project/$ref/logs/explorer')({
  component: LogsExplorerPage,
})

function LogsExplorerPage() {
  const { ref } = Route.useParams()
  return <LogsView projectRef={ref} title="Logs Explorer" description="Search the logs of every service in the stack." />
}

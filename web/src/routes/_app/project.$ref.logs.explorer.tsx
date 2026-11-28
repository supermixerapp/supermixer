import { createFileRoute } from '@tanstack/react-router'

import { LogsView } from '@/components/logs/logs-view'
import { t } from '@/lib/i18n'

export const Route = createFileRoute('/_app/project/$ref/logs/explorer')({
  component: LogsExplorerPage,
})

function LogsExplorerPage() {
  const { ref } = Route.useParams()
  return <LogsView projectRef={ref} title={t('observability:logsExplorer.logsExplorer')} description={t('observability:logsExplorer.searchTheLogsOfEveryService')} />
}

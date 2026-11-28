import { createFileRoute } from '@tanstack/react-router'

import { DatabasePage } from '@/components/database/catalog-page'
import { FunctionInvoker } from '@/components/functions/invoker'
import { FunctionList } from '@/components/functions/function-list'
import { Alert } from '@/components/ui/alert'
import { useSelectedProject } from '@/lib/api/hooks'
import { t } from '@/lib/i18n'

export const Route = createFileRoute('/_app/project/$ref/functions/')({
  component: EdgeFunctionsPage,
})

function EdgeFunctionsPage() {
  const { ref } = Route.useParams()
  const project = useSelectedProject()
  if (!project) return null
  if (project.stack) return <FunctionList project={project} />
  return (
    <DatabasePage title={t('functions:functions.edgeFunctions')} description={t('functions:functions.serverSideTypescriptFunctionsRunBy')}>
      <Alert title={t('functions:functions.supermixerConnectsToThisStackSo')}>
        {t('functions:functions.itsFunctionsAreFoldersUnderThe')}
      </Alert>
      <FunctionInvoker projectRef={ref} />
    </DatabasePage>
  )
}

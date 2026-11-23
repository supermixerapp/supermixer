import { createFileRoute } from '@tanstack/react-router'

import { DatabasePage } from '@/components/database/catalog-page'
import { FunctionInvoker } from '@/components/functions/invoker'
import { FunctionList } from '@/components/functions/function-list'
import { Alert } from '@/components/ui/alert'
import { useSelectedProject } from '@/lib/api/hooks'

export const Route = createFileRoute('/_app/project/$ref/functions/')({
  component: EdgeFunctionsPage,
})

function EdgeFunctionsPage() {
  const { ref } = Route.useParams()
  const project = useSelectedProject()
  if (!project) return null
  if (project.stack) return <FunctionList project={project} />
  return (
    <DatabasePage title="Edge Functions" description="Server-side TypeScript functions run by the stack's Edge Runtime.">
      <Alert title="Supermixer connects to this stack, so it can't see its functions folder">
        Its functions are folders under the stack&apos;s volumes/functions, served by its main function; deploy them where
        the stack runs. Here you can call any function by name. Stacks created with “Create a new stack” list, edit and
        deploy their functions here.
      </Alert>
      <FunctionInvoker projectRef={ref} />
    </DatabasePage>
  )
}

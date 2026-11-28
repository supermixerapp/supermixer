import { useMutation, useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'

import { useCanChange } from '@/components/database/catalog-page'
import { PlayIcon } from '@/components/icons'
import { IntegrationPage, useExtension } from '@/components/integrations/integration-page'
import { CodeEditor } from '@/components/sql/code-editor'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { CodeBlock } from '@/components/ui/code-block'
import { FormField } from '@/components/ui/form-field'
import { Textarea } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { collections, EXPLORER_QUERY, GRAPHQL_SQL, hasMutation, sampleQuery, variablesProblem, type ExplorerSchema } from '@/lib/pg/graphql'
import { rowsOf, runSql } from '@/lib/pg/run'
import { cn } from '@/lib/utils'
import { localized, t } from '@/lib/i18n'

export const Route = createFileRoute('/_app/project/$ref/integrations/graphiql')({
  component: GraphiqlPage,
})

const STARTER = localized(() => t('integrations:integrationsGraphiql.pickACollectionOnTheLeft'))

function GraphiqlPage() {
  const { ref } = Route.useParams()
  const ext = useExtension(ref, 'pg_graphql')
  const canChange = useCanChange()
  const [query, setQuery] = useState(STARTER())
  const [variables, setVariables] = useState('')
  const [picked, setPicked] = useState<string | null>(null)

  const resolve = async (q: string, vars: string, signal?: AbortSignal) =>
    rowsOf<{ result: unknown }>(await runSql(ref, GRAPHQL_SQL, { params: [q, vars, ''], readOnly: !canChange, ...(signal && { signal }) }))[0]?.result

  const explorer = useQuery({
    queryKey: ['projects', ref, 'pg', 'graphql-explorer', canChange],
    queryFn: async ({ signal }) => (await resolve(EXPLORER_QUERY, '', signal)) as { data?: ExplorerSchema; errors?: { message: string }[] },
    enabled: !!ext.state?.installed_version,
    staleTime: 60_000,
  })
  const schema = explorer.data?.data
  const run = useMutation<unknown, Error>({ mutationFn: () => resolve(query, variables) })
  const varsProblem = variablesProblem(variables)
  const blockedMutation = !canChange && hasMutation(query)

  return (
    <IntegrationPage
      projectRef={ref}
      title={t('integrations:integrationsGraphiql.graphiql')}
      description={t('integrations:integrationsGraphiql.queryTheDatabaseWithGraphqlThrough')}
      extension={{ name: 'pg_graphql', schema: null }}
      about={t('integrations:integrationsGraphiql.createsTheGraphqlSchemaTheApi')}
    >
      <div className="grid gap-4 lg:grid-cols-[14rem_minmax(0,1fr)]">
        <Card className="flex max-h-[36rem] flex-col overflow-hidden">
          <p className="border-b px-4 py-2 text-xs text-foreground-lighter">{t('integrations:integrationsGraphiql.collections')}</p>
          <div className="flex-1 overflow-y-auto p-2">
            {explorer.error ? (
              <p className="px-2 text-xs text-destructive">{explorer.error.message}</p>
            ) : !explorer.data ? (
              <Skeleton className="h-24" />
            ) : !schema ? (
              <p className="px-2 text-xs text-destructive">{explorer.data.errors?.[0]?.message ?? t('integrations:integrationsGraphiql.noSchema')}</p>
            ) : collections(schema).length === 0 ? (
              <p className="px-2 text-xs text-foreground-lighter">{t('integrations:integrationsGraphiql.noTablesAreExposedToGraphql')}</p>
            ) : (
              <ul>
                {collections(schema).map((c) => (
                  <li key={c.name}>
                    <button
                      title={c.description ?? undefined}
                      className={cn(
                        'w-full truncate rounded-md px-2 py-1 text-left font-mono text-xs focus-ring',
                        picked === c.name ? 'bg-sidebar-accent text-foreground' : 'text-foreground-light hover:bg-sidebar-accent/50 hover:text-foreground'
                      )}
                      onClick={() => {
                        setPicked(c.name)
                        setQuery(sampleQuery(schema, c.name))
                      }}
                    >
                      {c.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
        <div className="flex min-w-0 flex-col gap-3">
          <div className="h-72 overflow-hidden rounded-md border">
            <CodeEditor language="graphql" value={query} onChange={setQuery} onRun={() => !varsProblem && !blockedMutation && run.mutate()} />
          </div>
          <FormField label={t('integrations:integrationsGraphiql.variables')} htmlFor="gql-variables" description={varsProblem ? <span className="text-destructive">{varsProblem}</span> : t('integrations:integrationsGraphiql.optionalAsAJsonObject')}>
            <Textarea id="gql-variables" rows={3} className="font-mono text-xs" value={variables} onChange={(e) => setVariables(e.target.value)} placeholder={'{ "first": 10 }'} />
          </FormField>
          <div className="flex items-center gap-3">
            <Button variant="primary" icon={<PlayIcon />} loading={run.isPending} disabled={!!varsProblem || blockedMutation} onClick={() => run.mutate()}>
              {t('integrations:integrationsGraphiql.run')}
            </Button>
            {blockedMutation && <span className="text-xs text-foreground-lighter">{t('integrations:integrationsGraphiql.yourRoleCanOnlyRunQueries')}</span>}
          </div>
          {run.error ? (
            <Alert variant="destructive" title={run.error.message} />
          ) : run.data !== undefined ? (
            <CodeBlock code={JSON.stringify(run.data, null, 2)} className="[&_pre]:max-h-[32rem]" />
          ) : null}
        </div>
      </div>
    </IntegrationPage>
  )
}

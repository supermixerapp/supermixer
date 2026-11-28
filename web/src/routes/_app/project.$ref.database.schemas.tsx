import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMemo } from 'react'

import { SchemaPicker, schemaSearch } from '@/components/database/catalog-page'
import { SchemaDiagram } from '@/components/database/schema-diagram'
import { SchemaIcon } from '@/components/icons'
import { Alert } from '@/components/ui/alert'
import { Skeleton } from '@/components/ui/skeleton'
import { usePg } from '@/lib/pg/run'
import { GRAPH_FKS_SQL, GRAPH_TABLES_SQL, type GraphForeignKey, type GraphTable } from '@/lib/pg/schema-graph'
import { t as tr } from '@/lib/i18n'

export const Route = createFileRoute('/_app/project/$ref/database/schemas')({
  validateSearch: schemaSearch,
  component: SchemaVisualizerPage,
})

function SchemaVisualizerPage() {
  const { ref } = Route.useParams()
  const { schema = 'public' } = Route.useSearch()
  const navigate = useNavigate()
  const tables = usePg<GraphTable>(ref, ['graph-tables', schema], GRAPH_TABLES_SQL, [schema])
  const fks = usePg<GraphForeignKey>(ref, ['graph-fks', schema], GRAPH_FKS_SQL, [schema])
  const error = tables.error ?? fks.error
  // Query results keep their identity while unchanged (structural sharing),
  // so this only changes, and the diagram only remounts, when the schema does.
  const version = useMemo(() => (tables.data && fks.data ? hash(JSON.stringify([tables.data, fks.data])) : ''), [tables.data, fks.data])
  const counts = useMemo(() => {
    const t = tables.data ?? []
    const isTable = (k: string) => k === 'r' || k === 'p'
    return { tables: t.filter((x) => isTable(x.kind)).length, other: t.filter((x) => !isTable(x.kind)).length }
  }, [tables.data])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-(--header-height) shrink-0 flex-wrap items-center gap-3 border-b px-4 py-2">
        <h1 className="text-sm text-foreground">{tr('database:databaseSchemas.schemaVisualizer')}</h1>
        <SchemaPicker projectRef={ref} value={schema} onChange={(s) => void navigate({ to: '.', search: { schema: s } })} />
        {tables.data && (
          <span className="text-xs text-foreground-lighter">
            {tr('database:databaseSchemas.tables', { count: counts.tables })}
            {counts.other > 0 && ` · ${tr('database:databaseSchemas.views', { count: counts.other })}`} ·{' '}
            {tr('database:databaseSchemas.foreignKeys', { count: fks.data?.length ?? 0 })}
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1">
        {error ? (
          <div className="p-6">
            <Alert variant="destructive" title={error.message} />
          </div>
        ) : !tables.data || !fks.data ? (
          <div className="p-6">
            <Skeleton className="h-64" />
          </div>
        ) : tables.data.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <SchemaIcon size={28} className="text-foreground-lighter" />
            <p className="text-sm text-foreground">{tr('database:databaseSchemas.noTablesOrViewsIn', { schema })}</p>
            <p className="text-xs text-foreground-lighter">{tr('database:databaseSchemas.createOneInTheTableEditor')}</p>
          </div>
        ) : (
          // Remount on new data so the diagram starts from it.
          <SchemaDiagram key={`${schema}:${version}`} projectRef={ref} schema={schema} tables={tables.data} fks={fks.data} />
        )}
      </div>
    </div>
  )
}


/** A short, stable fingerprint of a string. */
function hash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
  return `${h.toString(36)}-${s.length}`
}

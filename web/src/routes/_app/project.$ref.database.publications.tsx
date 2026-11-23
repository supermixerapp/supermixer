import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'

import { CatalogTable, DatabasePage, SchemaPicker, useCanChange, useDdl } from '@/components/database/catalog-page'
import { Badge } from '@/components/ui/badge'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetSection, SheetTitle } from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { TABLES_SQL, type TableListRow } from '@/lib/pg/catalog'
import { PUBLICATIONS_SQL, setPublicationEvents, setPublicationTable, type PublicationRow } from '@/lib/pg/database'
import { usePg } from '@/lib/pg/run'

export const Route = createFileRoute('/_app/project/$ref/database/publications')({
  component: PublicationsPage,
})

const EVENTS = ['insert', 'update', 'delete', 'truncate'] as const

function PublicationsPage() {
  const { ref } = Route.useParams()
  const [managing, setManaging] = useState<string | null>(null)
  const publications = usePg<PublicationRow>(ref, ['publications'], PUBLICATIONS_SQL)
  const canChange = useCanChange()
  const ddl = useDdl(ref)
  const current = publications.data?.find((p) => p.name === managing)

  return (
    <DatabasePage
      title="Database Publications"
      description="Which tables and changes are streamed out. supabase_realtime drives Realtime's Postgres Changes."
    >
      <CatalogTable
        rows={publications.data}
        loading={publications.isPending}
        error={publications.error}
        rowKey={(p) => p.name}
        empty="No publications"
        columns={[
          { header: 'Name', cell: (p) => <span className="text-foreground">{p.name}</span> },
          ...EVENTS.map((e) => ({
            header: e[0]!.toUpperCase() + e.slice(1),
            cell: (p: PublicationRow) => (
              <Switch
                aria-label={`${e} on ${p.name}`}
                checked={p[e]}
                disabled={!canChange || ddl.isPending}
                onCheckedChange={(on) => {
                  const events = EVENTS.filter((x) => (x === e ? on : p[x]))
                  ddl.mutate({ sql: setPublicationEvents(p.name, events), done: `Updated ${p.name}` })
                }}
              />
            ),
          })),
          {
            header: 'Source',
            cell: (p) =>
              p.all_tables ? (
                <Badge>All tables</Badge>
              ) : (
                <button className="text-foreground-light underline-offset-2 hover:text-foreground hover:underline" onClick={() => setManaging(p.name)}>
                  {p.tables.length} table{p.tables.length === 1 ? '' : 's'}
                </button>
              ),
          },
        ]}
      />
      <Sheet open={!!current} onOpenChange={(o) => !o && setManaging(null)}>
        <SheetContent size="default" className="flex flex-col">
          {current && <PublicationTables projectRef={ref} publication={current} canChange={canChange} />}
        </SheetContent>
      </Sheet>
    </DatabasePage>
  )
}

function PublicationTables({ projectRef, publication, canChange }: { projectRef: string; publication: PublicationRow; canChange: boolean }) {
  const [schema, setSchema] = useState('public')
  const tables = usePg<TableListRow>(projectRef, ['tables', schema], TABLES_SQL, [schema])
  const ddl = useDdl(projectRef)
  return (
    <>
      <SheetHeader>
        <SheetTitle>Tables in {publication.name}</SheetTitle>
        <SheetDescription>Changes to these tables are published.</SheetDescription>
      </SheetHeader>
      <SheetSection className="flex flex-col gap-3">
        <SchemaPicker projectRef={projectRef} value={schema} onChange={setSchema} />
        <ul className="flex flex-col divide-y rounded-md border">
          {(tables.data ?? []).filter((t) => t.kind === 'r' || t.kind === 'p').map((t) => {
            const on = publication.tables.includes(`${schema}.${t.name}`)
            return (
              <li key={t.id} className="flex items-center justify-between px-3 py-2 text-sm">
                {t.name}
                <Switch
                  aria-label={`Publish ${t.name}`}
                  checked={on}
                  disabled={!canChange || ddl.isPending}
                  onCheckedChange={(add) => ddl.mutate({ sql: setPublicationTable(publication.name, schema, t.name, add), done: `${add ? 'Added' : 'Removed'} ${t.name}` })}
                />
              </li>
            )
          })}
        </ul>
      </SheetSection>
    </>
  )
}

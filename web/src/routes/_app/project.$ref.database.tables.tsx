import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'

import { AddIcon } from '@/components/icons'
import { CatalogTable, DatabasePage, SchemaPicker, SearchBox, schemaSearch, useCanChange, useDdl } from '@/components/database/catalog-page'
import { PermissionButton } from '@/components/permission-button'
import { CreateTableSheet } from '@/components/table-editor/sheets'
import { Badge } from '@/components/ui/badge'
import { setPublicationTable, TABLE_STATS_SQL, type TableStat } from '@/lib/pg/database'
import { usePg } from '@/lib/pg/run'
import { dropTable } from '@/lib/pg/table-sql'

export const Route = createFileRoute('/_app/project/$ref/database/tables')({
  validateSearch: schemaSearch,
  component: TablesPage,
})

function TablesPage() {
  const { ref } = Route.useParams()
  const { schema = 'public' } = Route.useSearch()
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [creating, setCreating] = useState(false)
  const tables = usePg<TableStat>(ref, ['table-stats', schema], TABLE_STATS_SQL, [schema])
  const canChange = useCanChange(schema)
  const ddl = useDdl(ref)
  const rows = tables.data?.filter((t) => t.name.toLowerCase().includes(search.toLowerCase()))

  return (
    <DatabasePage
      title="Tables"
      description="The tables in each schema, their size and whether Row Level Security and Realtime are on."
      toolbar={
        <>
          <SchemaPicker projectRef={ref} value={schema} onChange={(s) => void navigate({ to: '.', search: { schema: s } })} />
          <SearchBox value={search} onChange={setSearch} placeholder="Search for a table" />
        </>
      }
      actions={
        <PermissionButton allowed={canChange} action="create tables here" variant="primary" icon={<AddIcon />} onClick={() => setCreating(true)}>
          New table
        </PermissionButton>
      }
    >
      <CatalogTable
        rows={rows}
        loading={tables.isPending}
        error={tables.error}
        rowKey={(t) => t.name}
        empty={search ? 'No tables match your search' : `No tables in ${schema}`}
        columns={[
          {
            header: 'Name',
            cell: (t) => (
              <Link to="/project/$ref/editor/$id" params={{ ref, id: String(t.id) }} search={{ schema }} className="text-foreground hover:underline">
                {t.name}
              </Link>
            ),
          },
          { header: 'Description', cell: (t) => <span className="text-foreground-light">{t.comment ?? '—'}</span> },
          { header: 'Rows (estimated)', cell: (t) => t.estimate.toLocaleString(), className: 'text-right whitespace-nowrap' },
          { header: 'Size', cell: (t) => t.size, className: 'text-right whitespace-nowrap' },
          { header: 'Columns', cell: (t) => t.columns, className: 'text-right whitespace-nowrap' },
          {
            header: 'Security',
            cell: (t) => (
              <span className="flex gap-1">
                {t.rls ? <Badge variant="success">RLS on</Badge> : <Badge variant="warning">RLS off</Badge>}
                {t.realtime && <Badge>Realtime</Badge>}
              </span>
            ),
          },
        ]}
        actions={[
          {
            label: 'View in Table Editor',
            onSelect: (t) => void navigate({ to: '/project/$ref/editor/$id', params: { ref, id: String(t.id) }, search: { schema } }),
          },
          {
            label: 'Enable Realtime',
            hidden: (t) => !canChange || t.realtime,
            onSelect: (t) => ddl.mutate({ sql: setPublicationTable('supabase_realtime', schema, t.name, true), done: `Realtime enabled for ${t.name}` }),
          },
          {
            label: 'Disable Realtime',
            hidden: (t) => !canChange || !t.realtime,
            onSelect: (t) => ddl.mutate({ sql: setPublicationTable('supabase_realtime', schema, t.name, false), done: `Realtime disabled for ${t.name}` }),
          },
          {
            label: 'Delete table',
            hidden: () => !canChange,
            confirm: (t) => ({
              title: `Delete table ${t.name}?`,
              description: 'The table and its data are dropped. Views or foreign keys that depend on it make this fail.',
              confirmText: t.name,
            }),
            onSelect: (t) => ddl.mutate({ sql: dropTable(schema, t.name), done: `Deleted ${t.name}` }),
          },
        ]}
      />
      <CreateTableSheet projectRef={ref} schema={schema} open={creating} onOpenChange={setCreating} onCreated={() => {}} />
    </DatabasePage>
  )
}

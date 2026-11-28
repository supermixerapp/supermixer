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
import { t as tr, language } from '@/lib/i18n'

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
      title={tr('database:databaseTables.tables')}
      description={tr('database:databaseTables.theTablesInEachSchemaTheir')}
      toolbar={
        <>
          <SchemaPicker projectRef={ref} value={schema} onChange={(s) => void navigate({ to: '.', search: { schema: s } })} />
          <SearchBox value={search} onChange={setSearch} placeholder={tr('database:databaseTables.searchForATable')} />
        </>
      }
      actions={
        <PermissionButton allowed={canChange} action={tr('database:databaseTables.createTablesHere')} variant="primary" icon={<AddIcon />} onClick={() => setCreating(true)}>
          {tr('database:databaseTables.newTable')}
        </PermissionButton>
      }
    >
      <CatalogTable
        rows={rows}
        loading={tables.isPending}
        error={tables.error}
        rowKey={(t) => t.name}
        empty={search ? tr('database:databaseTables.noTablesMatchYourSearch') : tr('database:databaseTables.noTablesIn', { schema })}
        columns={[
          {
            header: tr('database:databaseTables.name'),
            cell: (t) => (
              <Link to="/project/$ref/editor/$id" params={{ ref, id: String(t.id) }} search={{ schema }} className="text-foreground hover:underline">
                {t.name}
              </Link>
            ),
          },
          { header: tr('database:databaseTables.description'), cell: (t) => <span className="text-foreground-light">{t.comment ?? '—'}</span> },
          { header: tr('database:databaseTables.rowsEstimated'), cell: (t) => t.estimate.toLocaleString(language()), className: 'text-right whitespace-nowrap' },
          { header: tr('database:databaseTables.size'), cell: (t) => t.size, className: 'text-right whitespace-nowrap' },
          { header: tr('database:databaseTables.columns'), cell: (t) => t.columns, className: 'text-right whitespace-nowrap' },
          {
            header: tr('database:databaseTables.security'),
            cell: (t) => (
              <span className="flex gap-1">
                {t.rls ? <Badge variant="success">{tr('database:databaseTables.rlsOn')}</Badge> : <Badge variant="warning">{tr('database:databaseTables.rlsOff')}</Badge>}
                {t.realtime && <Badge>{tr('database:databaseTables.realtime')}</Badge>}
              </span>
            ),
          },
        ]}
        actions={[
          {
            label: tr('database:databaseTables.viewInTableEditor'),
            onSelect: (t) => void navigate({ to: '/project/$ref/editor/$id', params: { ref, id: String(t.id) }, search: { schema } }),
          },
          {
            label: tr('database:databaseTables.enableRealtime'),
            hidden: (t) => !canChange || t.realtime,
            onSelect: (t) => ddl.mutate({ sql: setPublicationTable('supabase_realtime', schema, t.name, true), done: tr('database:databaseTables.realtimeEnabledFor', { name: t.name }) }),
          },
          {
            label: tr('database:databaseTables.disableRealtime'),
            hidden: (t) => !canChange || !t.realtime,
            onSelect: (t) => ddl.mutate({ sql: setPublicationTable('supabase_realtime', schema, t.name, false), done: tr('database:databaseTables.realtimeDisabledFor', { name: t.name }) }),
          },
          {
            label: tr('database:databaseTables.deleteTable'),
            hidden: () => !canChange,
            confirm: (t) => ({
              title: tr('database:databaseTables.deleteTable2', { name: t.name }),
              description: tr('database:databaseTables.theTableAndItsDataAre'),
              confirmText: t.name,
            }),
            onSelect: (t) => ddl.mutate({ sql: dropTable(schema, t.name), done: tr('database:databaseTables.deleted', { name: t.name }) }),
          },
        ]}
      />
      <CreateTableSheet projectRef={ref} schema={schema} open={creating} onOpenChange={setCreating} onCreated={() => {}} />
    </DatabasePage>
  )
}

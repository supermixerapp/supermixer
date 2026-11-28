import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'

import { AddIcon } from '@/components/icons'
import { CatalogTable, Code, DatabasePage, SchemaPicker, SearchBox, schemaSearch, useCanChange, useDdl } from '@/components/database/catalog-page'
import { PermissionButton } from '@/components/permission-button'
import { EditorSheet, SqlPreview } from '@/components/table-editor/sheets'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { FormField } from '@/components/ui/form-field'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { TABLE_SQL, TABLES_SQL, type TableInfo, type TableListRow } from '@/lib/pg/catalog'
import { createIndex, dropIndex, INDEX_METHODS, INDEXES_SQL, type IndexRow } from '@/lib/pg/database'
import { usePg } from '@/lib/pg/run'
import { t as tr, Trans } from '@/lib/i18n'

export const Route = createFileRoute('/_app/project/$ref/database/indexes')({
  validateSearch: schemaSearch,
  component: IndexesPage,
})

function IndexesPage() {
  const { ref } = Route.useParams()
  const { schema = 'public' } = Route.useSearch()
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [creating, setCreating] = useState(false)
  const indexes = usePg<IndexRow>(ref, ['indexes', schema], INDEXES_SQL, [schema])
  const canChange = useCanChange(schema)
  const ddl = useDdl(ref)
  const q = search.toLowerCase()
  const rows = indexes.data?.filter((i) => i.name.toLowerCase().includes(q) || i.table.toLowerCase().includes(q))

  return (
    <DatabasePage
      title={tr('database:databaseIndexes.indexes')}
      description={tr('database:databaseIndexes.speedUpQueriesThatFilterOr')}
      toolbar={
        <>
          <SchemaPicker projectRef={ref} value={schema} onChange={(s) => void navigate({ to: '.', search: { schema: s } })} />
          <SearchBox value={search} onChange={setSearch} placeholder={tr('database:databaseIndexes.searchForAnIndex')} />
        </>
      }
      actions={
        <PermissionButton allowed={canChange} action={tr('database:databaseIndexes.createIndexesHere')} variant="primary" icon={<AddIcon />} onClick={() => setCreating(true)}>
          {tr('database:databaseIndexes.createIndex')}
        </PermissionButton>
      }
    >
      <CatalogTable
        rows={rows}
        loading={indexes.isPending}
        error={indexes.error}
        rowKey={(i) => i.name}
        empty={search ? tr('database:databaseIndexes.noIndexesMatchYourSearch') : tr('database:databaseIndexes.noIndexesIn', { schema })}
        columns={[
          { header: tr('database:databaseIndexes.table'), cell: (i) => i.table },
          {
            header: tr('database:databaseIndexes.name'),
            cell: (i) => (
              <span className="flex items-center gap-2 text-foreground">
                {i.name}
                {i.primary ? <Badge>{tr('database:databaseIndexes.primaryKey')}</Badge> : i.unique ? <Badge>{tr('database:databaseIndexes.unique')}</Badge> : null}
              </span>
            ),
          },
          { header: tr('database:databaseIndexes.definition'), cell: (i) => <Code title={i.definition}>{i.definition}</Code> },
          { header: tr('database:databaseIndexes.size'), cell: (i) => i.size, className: 'text-right whitespace-nowrap' },
        ]}
        actions={[
          {
            label: tr('database:databaseIndexes.deleteIndex'),
            hidden: (i) => !canChange || i.primary,
            confirm: (i) => ({ title: tr('database:databaseIndexes.deleteIndex2', { name: i.name }), description: tr('database:databaseIndexes.queriesThatReliedOnItMay') }),
            onSelect: (i) => ddl.mutate({ sql: dropIndex(schema, i.name), done: tr('database:databaseIndexes.deleted', { name: i.name }) }),
          },
        ]}
      />
      {creating && <IndexSheet projectRef={ref} schema={schema} onClose={() => setCreating(false)} />}
    </DatabasePage>
  )
}

function IndexSheet({ projectRef, schema, onClose }: { projectRef: string; schema: string; onClose: () => void }) {
  const tables = usePg<TableListRow>(projectRef, ['tables', schema], TABLES_SQL, [schema])
  const [tableId, setTableId] = useState('')
  const info = usePg<{ info: TableInfo | null }>(projectRef, ['table', tableId], TABLE_SQL, [tableId || '0'])
  const table = tableId ? info.data?.[0]?.info : null
  const [columns, setColumns] = useState<string[]>([])
  const [method, setMethod] = useState<(typeof INDEX_METHODS)[number]>('btree')
  const [unique, setUnique] = useState(false)
  const ddl = useDdl(projectRef)
  const sql = table && columns.length ? createIndex(schema, table.name, columns, method, unique) : ''
  return (
    <EditorSheet
      open
      onOpenChange={(o) => !o && onClose()}
      title={tr('database:databaseIndexes.createANewIndex')}
      error={ddl.error}
      submitLabel={tr('database:databaseIndexes.createIndex')}
      submitting={ddl.isPending}
      disabled={!sql}
      onSubmit={() => ddl.mutate({ sql, done: tr('database:databaseIndexes.indexCreated') }, { onSuccess: onClose })}
    >
      <FormField label={tr('database:databaseIndexes.table')}>
        <Select value={tableId} onValueChange={(v) => { setTableId(v); setColumns([]) }}>
          <SelectTrigger>
            <SelectValue placeholder={tr('database:databaseIndexes.chooseATable')} />
          </SelectTrigger>
          <SelectContent>
            {(tables.data ?? []).filter((t) => t.kind === 'r' || t.kind === 'p' || t.kind === 'm').map((t) => (
              <SelectItem key={t.id} value={String(t.id)}>
                {schema}.{t.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>
      {table && (
        <FormField label={tr('database:databaseIndexes.columns')} description={tr('database:databaseIndexes.inIndexOrderTickTheLeading')}>
          <div className="flex flex-col gap-1.5 text-sm">
            {table.columns.map((c) => (
              <label key={c.name} className="flex items-center gap-2">
                <Checkbox checked={columns.includes(c.name)} onCheckedChange={(on) => setColumns(on ? [...columns, c.name] : columns.filter((x) => x !== c.name))} />
                {c.name}
                <span className="font-mono text-[11px] text-foreground-lighter">{c.type}</span>
                {columns.includes(c.name) && <span className="text-xs text-foreground-lighter">#{columns.indexOf(c.name) + 1}</span>}
              </label>
            ))}
          </div>
        </FormField>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label={tr('database:databaseIndexes.method')} description={tr('database:databaseIndexes.btreeSuitsMostColumnsGinFor')}>
          <Select value={method} onValueChange={(v) => setMethod(v as typeof method)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {INDEX_METHODS.map((m) => (
                <SelectItem key={m} value={m}>
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
        <label className="flex items-center gap-2 self-center text-sm">
          <Trans i18nKey="database:databaseIndexes.unique2" components={{ checkbox: <Checkbox checked={unique} onCheckedChange={(c) => setUnique(c === true)} /> }} />
        </label>
      </div>
      {sql && <SqlPreview sql={sql} />}
    </EditorSheet>
  )
}

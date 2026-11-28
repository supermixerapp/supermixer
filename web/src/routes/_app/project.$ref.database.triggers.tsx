import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'

import { AddIcon } from '@/components/icons'
import { CatalogTable, Code, DatabasePage, SchemaPicker, SearchBox, schemaSearch, useCanChange, useDdl } from '@/components/database/catalog-page'
import { PermissionButton } from '@/components/permission-button'
import { EditorSheet, SqlPreview } from '@/components/table-editor/sheets'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { TABLES_SQL, type TableListRow } from '@/lib/pg/catalog'
import {
  createTrigger,
  dropTrigger,
  setTriggerEnabled,
  TRIGGER_FUNCTIONS_SQL,
  TRIGGERS_SQL,
  type TriggerDef,
  type TriggerRow,
} from '@/lib/pg/database'
import { usePg } from '@/lib/pg/run'
import { t as tr } from '@/lib/i18n'

export const Route = createFileRoute('/_app/project/$ref/database/triggers')({
  validateSearch: schemaSearch,
  component: TriggersPage,
})

function TriggersPage() {
  const { ref } = Route.useParams()
  const { schema = 'public' } = Route.useSearch()
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [creating, setCreating] = useState(false)
  const triggers = usePg<TriggerRow>(ref, ['triggers', schema], TRIGGERS_SQL, [schema])
  const canChange = useCanChange(schema)
  const ddl = useDdl(ref)
  const q = search.toLowerCase()
  const rows = triggers.data?.filter((t) => t.name.toLowerCase().includes(q) || t.table.toLowerCase().includes(q))

  return (
    <DatabasePage
      title={tr('database:databaseTriggers.databaseTriggers')}
      description={tr('database:databaseTriggers.runAFunctionAutomaticallyWhenRows')}
      toolbar={
        <>
          <SchemaPicker projectRef={ref} value={schema} onChange={(s) => void navigate({ to: '.', search: { schema: s } })} />
          <SearchBox value={search} onChange={setSearch} placeholder={tr('database:databaseTriggers.searchForATrigger')} />
        </>
      }
      actions={
        <PermissionButton allowed={canChange} action={tr('database:databaseTriggers.createTriggersHere')} variant="primary" icon={<AddIcon />} onClick={() => setCreating(true)}>
          {tr('database:databaseTriggers.createANewTrigger')}
        </PermissionButton>
      }
    >
      <CatalogTable
        rows={rows}
        loading={triggers.isPending}
        error={triggers.error}
        rowKey={(t) => `${t.table}.${t.name}`}
        empty={search ? tr('database:databaseTriggers.noTriggersMatchYourSearch') : tr('database:databaseTriggers.noTriggersIn', { schema })}
        columns={[
          { header: tr('database:databaseTriggers.name'), cell: (t) => <span className="text-foreground">{t.name}</span> },
          { header: tr('database:databaseTriggers.table'), cell: (t) => t.table },
          { header: tr('database:databaseTriggers.function'), cell: (t) => <Code>{`${t.function_schema}.${t.function_name}()`}</Code> },
          { header: tr('database:databaseTriggers.events'), cell: (t) => `${t.timing} ${t.events.join(' / ')}` },
          { header: tr('database:databaseTriggers.orientation'), cell: (t) => t.level },
          { header: tr('database:databaseTriggers.enabled'), cell: (t) => (t.enabled ? <Badge variant="success">{tr('database:databaseTriggers.enabled')}</Badge> : <Badge>{tr('database:databaseTriggers.disabled')}</Badge>) },
        ]}
        actions={[
          {
            label: tr('database:databaseTriggers.enableTrigger'),
            hidden: (t) => !canChange || t.enabled,
            onSelect: (t) => ddl.mutate({ sql: setTriggerEnabled(schema, t.table, t.name, true), done: tr('database:databaseTriggers.enabled2', { name: t.name }) }),
          },
          {
            label: tr('database:databaseTriggers.disableTrigger'),
            hidden: (t) => !canChange || !t.enabled,
            onSelect: (t) => ddl.mutate({ sql: setTriggerEnabled(schema, t.table, t.name, false), done: tr('database:databaseTriggers.disabled2', { name: t.name }) }),
          },
          {
            label: tr('database:databaseTriggers.deleteTrigger'),
            hidden: () => !canChange,
            confirm: (t) => ({ title: tr('database:databaseTriggers.deleteTrigger2', { name: t.name }), description: tr('database:databaseTriggers.itStopsRunningOnTheFunction', { table: t.table }) }),
            onSelect: (t) => ddl.mutate({ sql: dropTrigger(schema, t.table, t.name), done: tr('database:databaseTriggers.deleted', { name: t.name }) }),
          },
        ]}
      />
      {creating && <TriggerSheet projectRef={ref} schema={schema} onClose={() => setCreating(false)} />}
    </DatabasePage>
  )
}

function TriggerSheet({ projectRef, schema, onClose }: { projectRef: string; schema: string; onClose: () => void }) {
  const tables = usePg<TableListRow>(projectRef, ['tables', schema], TABLES_SQL, [schema])
  const functions = usePg<{ schema: string; name: string }>(projectRef, ['trigger-functions'], TRIGGER_FUNCTIONS_SQL)
  const [t, setT] = useState<TriggerDef>({ schema, table: '', name: '', timing: 'before', events: ['insert'], level: 'row', functionSchema: '', functionName: '' })
  const ddl = useDdl(projectRef)
  const set = (patch: Partial<TriggerDef>) => setT((x) => ({ ...x, ...patch }))
  const valid = t.name.trim() && t.table && t.functionName && t.events.length > 0
  const sql = valid ? createTrigger({ ...t, name: t.name.trim() }) : ''
  const userFunctions = (functions.data ?? []).filter((f) => !['auth', 'storage', 'realtime', 'extensions', 'graphql', 'pgsodium', 'vault', 'supabase_functions'].includes(f.schema) || f.schema === schema)
  return (
    <EditorSheet
      open
      onOpenChange={(o) => !o && onClose()}
      title={tr('database:databaseTriggers.createANewTrigger')}
      description={tr('database:databaseTriggers.triggerFunctionsReturnTriggerCreateOne')}
      error={ddl.error}
      submitLabel={tr('database:databaseTriggers.createTrigger')}
      submitting={ddl.isPending}
      disabled={!sql}
      onSubmit={() => ddl.mutate({ sql, done: tr('database:databaseTriggers.created', { name: t.name }) }, { onSuccess: onClose })}
    >
      <FormField label={tr('database:databaseTriggers.name')} htmlFor="tg-name">
        <Input id="tg-name" autoFocus value={t.name} onChange={(e) => set({ name: e.target.value })} placeholder="set_updated_at" />
      </FormField>
      <FormField label={tr('database:databaseTriggers.table')}>
        <Select value={t.table} onValueChange={(table) => set({ table })}>
          <SelectTrigger>
            <SelectValue placeholder={tr('database:databaseTriggers.chooseATable')} />
          </SelectTrigger>
          <SelectContent>
            {(tables.data ?? []).filter((x) => x.kind === 'r' || x.kind === 'p').map((x) => (
              <SelectItem key={x.id} value={x.name}>
                {schema}.{x.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>
      <FormField label={tr('database:databaseTriggers.events')}>
        <div className="flex gap-4 text-sm">
          {(['insert', 'update', 'delete'] as const).map((e) => (
            <label key={e} className="flex items-center gap-1.5 uppercase">
              <Checkbox
                checked={t.events.includes(e)}
                onCheckedChange={(c) => set({ events: c ? [...t.events, e] : t.events.filter((x) => x !== e) })}
              />
              {e}
            </label>
          ))}
        </div>
      </FormField>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label={tr('database:databaseTriggers.fires')}>
          <Select value={t.timing} onValueChange={(v) => set({ timing: v as TriggerDef['timing'] })}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="before">{tr('database:databaseTriggers.beforeTheEvent')}</SelectItem>
              <SelectItem value="after">{tr('database:databaseTriggers.afterTheEvent')}</SelectItem>
            </SelectContent>
          </Select>
        </FormField>
        <FormField label={tr('database:databaseTriggers.orientation')}>
          <Select value={t.level} onValueChange={(v) => set({ level: v as TriggerDef['level'] })}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="row">{tr('database:databaseTriggers.forEachRow')}</SelectItem>
              <SelectItem value="statement">{tr('database:databaseTriggers.forEachStatement')}</SelectItem>
            </SelectContent>
          </Select>
        </FormField>
      </div>
      <FormField label={tr('database:databaseTriggers.function')}>
        <Select
          // Values are list positions: names may contain dots.
          value={(() => {
            const i = userFunctions.findIndex((x) => x.schema === t.functionSchema && x.name === t.functionName)
            return i >= 0 ? String(i) : ''
          })()}
          onValueChange={(v) => {
            const fn = userFunctions[Number(v)]
            if (fn) set({ functionSchema: fn.schema, functionName: fn.name })
          }}
        >
          <SelectTrigger>
            <SelectValue placeholder={tr('database:databaseTriggers.chooseATriggerFunction')} />
          </SelectTrigger>
          <SelectContent>
            {userFunctions.map((f, i) => (
              <SelectItem key={`${f.schema}.${f.name}`} value={String(i)}>
                {f.schema}.{f.name}()
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>
      {sql && <SqlPreview sql={sql} />}
    </EditorSheet>
  )
}

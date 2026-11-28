import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'

import { AddIcon } from '@/components/icons'
import { CatalogTable, Code, DatabasePage, SchemaPicker, SearchBox, schemaSearch, useCanChange, useDdl } from '@/components/database/catalog-page'
import { PermissionButton } from '@/components/permission-button'
import { CodeEditor } from '@/components/sql/code-editor'
import { EditorSheet, SqlPreview } from '@/components/table-editor/sheets'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { createFunction, dropFunction, FUNCTIONS_SQL, parseProconfig, type FunctionDef, type FunctionRow } from '@/lib/pg/database'
import { usePg } from '@/lib/pg/run'
import { t, Trans } from '@/lib/i18n'

export const Route = createFileRoute('/_app/project/$ref/database/functions')({
  validateSearch: schemaSearch,
  component: FunctionsPage,
})

const blank = (schema: string): FunctionDef => ({
  schema,
  name: '',
  args: '',
  returns: 'void',
  language: 'plpgsql',
  body: 'begin\n  \nend;',
  securityDefiner: false,
  searchPath: '',
  settings: [],
})

function FunctionsPage() {
  const { ref } = Route.useParams()
  const { schema = 'public' } = Route.useSearch()
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<FunctionDef | null>(null)
  const functions = usePg<FunctionRow>(ref, ['functions', schema], FUNCTIONS_SQL, [schema])
  const canChange = useCanChange(schema)
  const ddl = useDdl(ref)
  const rows = functions.data?.filter((f) => f.name.toLowerCase().includes(search.toLowerCase()))

  return (
    <DatabasePage
      title={t('database:databaseFunctions.databaseFunctions')}
      description={t('database:databaseFunctions.functionsAndProceduresYouWroteCallable')}
      toolbar={
        <>
          <SchemaPicker projectRef={ref} value={schema} onChange={(s) => void navigate({ to: '.', search: { schema: s } })} />
          <SearchBox value={search} onChange={setSearch} placeholder={t('database:databaseFunctions.searchForAFunction')} />
        </>
      }
      actions={
        <PermissionButton allowed={canChange} action={t('database:databaseFunctions.createFunctionsHere')} variant="primary" icon={<AddIcon />} onClick={() => setEditing(blank(schema))}>
          {t('database:databaseFunctions.createANewFunction')}
        </PermissionButton>
      }
    >
      <CatalogTable
        rows={rows}
        loading={functions.isPending}
        error={functions.error}
        rowKey={(f) => `${f.name}(${f.args})`}
        empty={search ? t('database:databaseFunctions.noFunctionsMatchYourSearch') : t('database:databaseFunctions.noFunctionsInExtensionFunctionsAre', { schema })}
        columns={[
          { header: t('database:databaseFunctions.name'), cell: (f) => <span className="text-foreground">{f.name}</span> },
          { header: t('database:databaseFunctions.arguments'), cell: (f) => <Code title={f.args}>{f.args || '–'}</Code> },
          { header: t('database:databaseFunctions.returnType'), cell: (f) => <Code>{f.returns ?? 'procedure'}</Code> },
          { header: t('database:databaseFunctions.language'), cell: (f) => f.language },
          {
            header: t('database:databaseFunctions.security'),
            cell: (f) => (f.security_definer ? <Badge variant="warning">{t('database:databaseFunctions.definer')}</Badge> : <Badge>{t('database:databaseFunctions.invoker')}</Badge>),
          },
        ]}
        actions={[
          {
            label: t('database:databaseFunctions.editFunction'),
            hidden: (f) => !canChange || f.definition === null || f.kind !== 'f',
            onSelect: (f) =>
              setEditing({
                schema,
                name: f.name,
                // The declared arguments, so defaults and OUT parameters survive.
                args: f.full_args,
                returns: f.returns,
                language: f.language === 'sql' ? 'sql' : 'plpgsql',
                body: f.definition?.replace(/^\n|\n$/g, '') ?? '',
                securityDefiner: f.security_definer,
                ...parseProconfig(f.config),
              }),
          },
          {
            label: t('database:databaseFunctions.deleteFunction'),
            hidden: () => !canChange,
            confirm: (f) => ({ title: `Delete ${f.name}(${f.args})?`, description: t('database:databaseFunctions.triggersOrPoliciesThatUseIt') }),
            onSelect: (f) => ddl.mutate({ sql: dropFunction(schema, f.name, f.args, f.kind === 'p' ? 'p' : 'f'), done: t('database:databaseFunctions.deleted', { name: f.name }) }),
          },
        ]}
      />
      {editing && (
        <FunctionSheet
          projectRef={ref}
          initial={editing}
          onClose={() => setEditing(null)}
        />
      )}
    </DatabasePage>
  )
}

function FunctionSheet({ projectRef, initial, onClose }: { projectRef: string; initial: FunctionDef; onClose: () => void }) {
  const [f, setF] = useState(initial)
  const ddl = useDdl(projectRef)
  const set = (patch: Partial<FunctionDef>) => setF((x) => ({ ...x, ...patch }))
  const sql = f.name.trim() ? createFunction({ ...f, name: f.name.trim() }) : ''
  return (
    <EditorSheet
      open
      onOpenChange={(o) => !o && onClose()}
      title={initial.name ? t('database:databaseFunctions.edit', { name: initial.name }) : t('database:databaseFunctions.createANewFunction')}
      description={t('database:databaseFunctions.savedWithCreateOrReplaceChanging')}
      error={ddl.error}
      submitLabel={t('database:databaseFunctions.saveFunction')}
      submitting={ddl.isPending}
      disabled={!sql}
      onSubmit={() => ddl.mutate({ sql, done: t('database:databaseFunctions.saved', { name: f.name }) }, { onSuccess: onClose })}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label={t('database:databaseFunctions.name')} htmlFor="fn-name">
          <Input id="fn-name" autoFocus value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="touch_updated_at" />
        </FormField>
        <FormField label={t('database:databaseFunctions.returnType')} htmlFor="fn-returns" description={t('database:databaseFunctions.eGVoidTriggerInt8Setof')}>
          <Input id="fn-returns" className="font-mono" value={f.returns} onChange={(e) => set({ returns: e.target.value })} />
        </FormField>
      </div>
      <FormField label={t('database:databaseFunctions.arguments')} htmlFor="fn-args" description={t('database:databaseFunctions.asInSqlEGUser')}>
        <Input id="fn-args" className="font-mono" value={f.args} onChange={(e) => set({ args: e.target.value })} />
      </FormField>
      <FormField label={t('database:databaseFunctions.language')}>
        <Select value={f.language} onValueChange={(v) => set({ language: v as FunctionDef['language'] })}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="plpgsql">{t('database:databaseFunctions.plpgsql')}</SelectItem>
            <SelectItem value="sql">{t('database:databaseFunctions.sql')}</SelectItem>
          </SelectContent>
        </Select>
      </FormField>
      <FormField label={t('database:databaseFunctions.definition')}>
        <div className="h-64 overflow-hidden rounded-md border">
          <CodeEditor value={f.body} onChange={(body) => set({ body })} />
        </div>
      </FormField>
      <div className="flex flex-col gap-2 text-sm">
        <label className="flex items-start gap-2">
          <Checkbox checked={f.securityDefiner} onCheckedChange={(c) => set({ securityDefiner: c === true })} className="mt-0.5" />
          <span>
            <Trans i18nKey="database:databaseFunctions.securityDefinerRunsWithTheOwner" components={{ span: <span className="block text-xs text-foreground-lighter" /> }} />
          </span>
        </label>
<SearchPathField value={f.searchPath} original={initial.searchPath} onChange={(searchPath) => set({ searchPath })} />
      </div>
      {(f.settings?.length ?? 0) > 0 && (
        <p className="text-xs text-foreground-lighter">
          {t('database:databaseFunctions.keepsItsOtherSettings')} {f.settings!.map((x) => `${x.name} = ${x.value}`).join(', ')}
        </p>
      )}
      {sql && <SqlPreview sql={sql} />}
    </EditorSheet>
  )
}

/** Empty search_path (recommended), or the function's own list, or none. */
function SearchPathField({ value, original, onChange }: { value: string | null; original: string | null; onChange: (v: string | null) => void }) {
  const custom = original !== null && original !== '' ? original : null
  return (
    <label className="flex items-start gap-2">
      <Checkbox checked={value === ''} onCheckedChange={(c) => onChange(c === true ? '' : custom)} className="mt-0.5" />
      <span>
        {t('database:databaseFunctions.emptySearchPathRecommended')}
        <span className="block text-xs text-foreground-lighter">
          {value === ''
            ? t('database:databaseFunctions.namesInTheBodyMustBe')
            : value
              ? t('database:databaseFunctions.keepsSearchPath', { value })
              : t('database:databaseFunctions.noSearchPathIsSetThe')}
        </span>
      </span>
    </label>
  )
}

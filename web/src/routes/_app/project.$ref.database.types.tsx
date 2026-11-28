import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'

import { AddIcon, CloseIcon } from '@/components/icons'
import { CatalogTable, DatabasePage, SchemaPicker, SearchBox, schemaSearch, useCanChange, useDdl } from '@/components/database/catalog-page'
import { PermissionButton } from '@/components/permission-button'
import { EditorSheet, SqlPreview } from '@/components/table-editor/sheets'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { addEnumValue, createEnum, dropType, ENUMS_SQL, type EnumRow } from '@/lib/pg/database'
import { usePg } from '@/lib/pg/run'
import { t } from '@/lib/i18n'

export const Route = createFileRoute('/_app/project/$ref/database/types')({
  validateSearch: schemaSearch,
  component: TypesPage,
})

function TypesPage() {
  const { ref } = Route.useParams()
  const { schema = 'public' } = Route.useSearch()
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [sheet, setSheet] = useState<{ adding?: EnumRow } | null>(null)
  const enums = usePg<EnumRow>(ref, ['enums', schema], ENUMS_SQL, [schema])
  const canChange = useCanChange(schema)
  const ddl = useDdl(ref)
  const rows = enums.data?.filter((e) => e.name.toLowerCase().includes(search.toLowerCase()))

  return (
    <DatabasePage
      title={t('database:databaseTypes.enumeratedTypes')}
      description={t('database:databaseTypes.typesWhoseValuesComeFromA')}
      toolbar={
        <>
          <SchemaPicker projectRef={ref} value={schema} onChange={(s) => void navigate({ to: '.', search: { schema: s } })} />
          <SearchBox value={search} onChange={setSearch} placeholder={t('database:databaseTypes.searchForAType')} />
        </>
      }
      actions={
        <PermissionButton allowed={canChange} action={t('database:databaseTypes.createTypesHere')} variant="primary" icon={<AddIcon />} onClick={() => setSheet({})}>
          {t('database:databaseTypes.createType')}
        </PermissionButton>
      }
    >
      <CatalogTable
        rows={rows}
        loading={enums.isPending}
        error={enums.error}
        rowKey={(e) => e.name}
        empty={search ? t('database:databaseTypes.noTypesMatchYourSearch') : t('database:databaseTypes.noEnumeratedTypesIn', { schema })}
        columns={[
          { header: t('database:databaseTypes.name'), cell: (e) => <span className="text-foreground">{e.name}</span> },
          {
            header: t('database:databaseTypes.values'),
            cell: (e) => (
              <span className="flex flex-wrap gap-1">
                {e.values.map((v) => (
                  <Badge key={v}>{v}</Badge>
                ))}
              </span>
            ),
          },
        ]}
        actions={[
          { label: t('database:databaseTypes.addAValue'), hidden: () => !canChange, onSelect: (e) => setSheet({ adding: e }) },
          {
            label: t('database:databaseTypes.deleteType'),
            hidden: () => !canChange,
            confirm: (e) => ({ title: t('database:databaseTypes.deleteType2', { name: e.name }), description: t('database:databaseTypes.columnsThatUseItMakeThis') }),
            onSelect: (e) => ddl.mutate({ sql: dropType(schema, e.name), done: t('database:databaseTypes.deleted', { name: e.name }) }),
          },
        ]}
      />
      {sheet && <EnumSheet projectRef={ref} schema={schema} adding={sheet.adding} onClose={() => setSheet(null)} />}
    </DatabasePage>
  )
}

function EnumSheet({ projectRef, schema, adding, onClose }: { projectRef: string; schema: string; adding?: EnumRow; onClose: () => void }) {
  const [name, setName] = useState('')
  const [values, setValues] = useState<string[]>(adding ? [''] : ['', ''])
  const ddl = useDdl(projectRef)
  const clean = values.map((v) => v.trim()).filter(Boolean)
  // Postgres adds one value per statement; several run as a script.
  const sql = adding
    ? clean.map((v) => addEnumValue(schema, adding.name, v)).join('\n')
    : name.trim() && clean.length
      ? createEnum(schema, name.trim(), clean)
      : ''
  return (
    <EditorSheet
      open
      onOpenChange={(o) => !o && onClose()}
      title={adding ? t('database:databaseTypes.addValuesTo', { name: adding.name }) : t('database:databaseTypes.createANewEnumeratedType')}
      description={adding ? t('database:databaseTypes.existingValuesCannotBeRemovedOr') : undefined}
      error={ddl.error}
      submitLabel={adding ? t('database:databaseTypes.addValues') : t('database:databaseTypes.createType')}
      submitting={ddl.isPending}
      disabled={!sql}
      onSubmit={() => ddl.mutate({ sql, done: adding ? t('database:databaseTypes.updated', { name: adding.name }) : t('database:databaseTypes.created', { name }) }, { onSuccess: onClose })}
    >
      {!adding && (
        <FormField label={t('database:databaseTypes.name')} htmlFor="enum-name">
          <Input id="enum-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="mood" />
        </FormField>
      )}
      <FormField label={t('database:databaseTypes.values')}>
        <div className="flex flex-col gap-2">
          {values.map((v, i) => (
            <div key={i} className="flex gap-2">
              <Input aria-label={t('database:databaseTypes.value', { i: i + 1 })} value={v} onChange={(e) => setValues(values.map((x, j) => (j === i ? e.target.value : x)))} />
              <Button variant="text" icon={<CloseIcon />} aria-label={t('database:databaseTypes.removeValue')} onClick={() => setValues(values.filter((_, j) => j !== i))} />
            </div>
          ))}
          <Button variant="dashed" size="tiny" icon={<AddIcon />} onClick={() => setValues([...values, ''])}>
            {t('database:databaseTypes.addValue')}
          </Button>
        </div>
      </FormField>
      {sql && <SqlPreview sql={sql} />}
    </EditorSheet>
  )
}

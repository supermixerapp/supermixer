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
      title="Enumerated Types"
      description="Types whose values come from a fixed list, usable as column types."
      toolbar={
        <>
          <SchemaPicker projectRef={ref} value={schema} onChange={(s) => void navigate({ to: '.', search: { schema: s } })} />
          <SearchBox value={search} onChange={setSearch} placeholder="Search for a type" />
        </>
      }
      actions={
        <PermissionButton allowed={canChange} action="create types here" variant="primary" icon={<AddIcon />} onClick={() => setSheet({})}>
          Create type
        </PermissionButton>
      }
    >
      <CatalogTable
        rows={rows}
        loading={enums.isPending}
        error={enums.error}
        rowKey={(e) => e.name}
        empty={search ? 'No types match your search' : `No enumerated types in ${schema}`}
        columns={[
          { header: 'Name', cell: (e) => <span className="text-foreground">{e.name}</span> },
          {
            header: 'Values',
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
          { label: 'Add a value', hidden: () => !canChange, onSelect: (e) => setSheet({ adding: e }) },
          {
            label: 'Delete type',
            hidden: () => !canChange,
            confirm: (e) => ({ title: `Delete type ${e.name}?`, description: 'Columns that use it make this fail.' }),
            onSelect: (e) => ddl.mutate({ sql: dropType(schema, e.name), done: `Deleted ${e.name}` }),
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
      title={adding ? `Add values to ${adding.name}` : 'Create a new enumerated type'}
      description={adding ? 'Existing values cannot be removed or renamed here.' : undefined}
      error={ddl.error}
      submitLabel={adding ? 'Add values' : 'Create type'}
      submitting={ddl.isPending}
      disabled={!sql}
      onSubmit={() => ddl.mutate({ sql, done: adding ? `Updated ${adding.name}` : `Created ${name}` }, { onSuccess: onClose })}
    >
      {!adding && (
        <FormField label="Name" htmlFor="enum-name">
          <Input id="enum-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="mood" />
        </FormField>
      )}
      <FormField label="Values">
        <div className="flex flex-col gap-2">
          {values.map((v, i) => (
            <div key={i} className="flex gap-2">
              <Input aria-label={`Value ${i + 1}`} value={v} onChange={(e) => setValues(values.map((x, j) => (j === i ? e.target.value : x)))} />
              <Button variant="text" icon={<CloseIcon />} aria-label="Remove value" onClick={() => setValues(values.filter((_, j) => j !== i))} />
            </div>
          ))}
          <Button variant="dashed" size="tiny" icon={<AddIcon />} onClick={() => setValues([...values, ''])}>
            Add value
          </Button>
        </div>
      </FormField>
      {sql && <SqlPreview sql={sql} />}
    </EditorSheet>
  )
}

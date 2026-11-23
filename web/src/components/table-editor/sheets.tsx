import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'

import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { FormField } from '@/components/ui/form-field'
import { Input, Textarea } from '@/components/ui/input'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetSection, SheetTitle } from '@/components/ui/sheet'
import type { ColumnInfo, TableInfo } from '@/lib/pg/catalog'
import { runSql, SqlError } from '@/lib/pg/run'
import { toText } from '@/lib/pg/sql'
import { addColumn, createTable, insertRow, updateRow, type ColumnDef } from '@/lib/pg/table-sql'

import { ColumnEditor, ColumnList, defaultColumns, newColumn } from './column-fields'

function SqlPreview({ sql }: { sql: string }) {
  return (
    <details className="rounded-md border bg-surface-100 text-xs">
      <summary className="cursor-pointer px-3 py-2 text-foreground-light select-none">SQL that will run</summary>
      <pre className="overflow-x-auto border-t px-3 py-2 font-mono leading-5 text-foreground">{sql}</pre>
    </details>
  )
}

function errorText(e: Error) {
  return e instanceof SqlError && e.hint ? `${e.message} (${e.hint})` : e.message
}

function EditorSheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  error,
  submitLabel,
  submitting,
  disabled,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  title: string
  description?: ReactNode
  children: ReactNode
  error?: Error | null
  submitLabel: string
  submitting: boolean
  disabled?: boolean
  onSubmit: () => void
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent size="lg" className="flex flex-col">
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          {description && <SheetDescription>{description}</SheetDescription>}
        </SheetHeader>
        <SheetSection className="flex flex-col gap-5">
          {children}
          {error && <Alert variant="destructive" title={errorText(error)} />}
        </SheetSection>
        <SheetFooter>
          <Button variant="default" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" loading={submitting} disabled={disabled} onClick={onSubmit}>
            {submitLabel}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

/** Refresh catalog-derived queries after a schema change. */
export function useRefreshCatalog(projectRef: string) {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: ['projects', projectRef, 'pg'] })
}

export function CreateTableSheet({
  projectRef,
  schema,
  open,
  onOpenChange,
  onCreated,
}: {
  projectRef: string
  schema: string
  open: boolean
  onOpenChange: (o: boolean) => void
  onCreated: (name: string) => void
}) {
  const [name, setName] = useState('')
  const [comment, setComment] = useState('')
  const [rls, setRls] = useState(true)
  const [columns, setColumns] = useState<ColumnDef[]>(defaultColumns)
  const refresh = useRefreshCatalog(projectRef)
  const valid = name.trim() !== '' && columns.length > 0 && columns.every((c) => c.name.trim())
  const sql = valid ? createTable(schema, name.trim(), columns, { rls, comment: comment.trim() || undefined }) : ''
  const create = useMutation({
    mutationFn: () => runSql(projectRef, sql),
    onSuccess: async () => {
      await refresh()
      onCreated(name.trim())
      onOpenChange(false)
      setName('')
      setComment('')
      setColumns(defaultColumns())
      setRls(true)
    },
  })
  return (
    <EditorSheet
      open={open}
      onOpenChange={onOpenChange}
      title={`Create a new table under ${schema}`}
      error={create.error}
      submitLabel="Save"
      submitting={create.isPending}
      disabled={!valid}
      onSubmit={() => create.mutate()}
    >
      <FormField label="Name" htmlFor="table-name">
        <Input id="table-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="todos" />
      </FormField>
      <FormField label="Description (optional)" htmlFor="table-comment">
        <Input id="table-comment" value={comment} onChange={(e) => setComment(e.target.value)} />
      </FormField>
      <label htmlFor="table-rls" className="flex items-start gap-2 text-sm">
        <Checkbox id="table-rls" checked={rls} onCheckedChange={(c) => setRls(c === true)} className="mt-0.5" />
        <span>
          <span className="text-foreground">Enable Row Level Security (recommended)</span>
          <span className="block text-xs text-foreground-lighter">
            Without policies, the anon and authenticated roles can&apos;t read or write the table through the API.
          </span>
        </span>
      </label>
      <div className="flex flex-col gap-2">
        <h4 className="text-sm text-foreground">Columns</h4>
        <ColumnList projectRef={projectRef} schema={schema} columns={columns} onChange={setColumns} />
      </div>
      {sql && <SqlPreview sql={sql} />}
    </EditorSheet>
  )
}

export function AddColumnSheet({
  projectRef,
  table,
  open,
  onOpenChange,
}: {
  projectRef: string
  table: TableInfo
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const [column, setColumn] = useState<ColumnDef>(newColumn)
  const [comment, setComment] = useState('')
  const refresh = useRefreshCatalog(projectRef)
  const def = { ...column, comment: comment.trim() || undefined }
  const sql = column.name.trim() ? addColumn(table.schema, table.name, def) : ''
  const add = useMutation({
    mutationFn: () => runSql(projectRef, sql),
    onSuccess: async () => {
      await refresh()
      onOpenChange(false)
      setColumn(newColumn())
      setComment('')
    },
  })
  return (
    <EditorSheet
      open={open}
      onOpenChange={onOpenChange}
      title={`Add a column to ${table.name}`}
      error={add.error}
      submitLabel="Save"
      submitting={add.isPending}
      disabled={!sql}
      onSubmit={() => add.mutate()}
    >
      <ColumnEditor projectRef={projectRef} schema={table.schema} value={column} onChange={setColumn} />
      <FormField label="Description (optional)" htmlFor="col-comment">
        <Input id="col-comment" value={comment} onChange={(e) => setComment(e.target.value)} />
      </FormField>
      {sql && <SqlPreview sql={sql} />}
    </EditorSheet>
  )
}

type Draft = Record<string, { value: string; isNull: boolean; useDefault: boolean }>

function initialDraft(columns: ColumnInfo[], row?: Record<string, unknown>): Draft {
  return Object.fromEntries(
    columns.map((c) => {
      if (row) {
        const v = toText(row[c.name])
        return [c.name, { value: v ?? '', isNull: v === null, useDefault: false }]
      }
      const hasDefault = c.default !== null || c.identity || c.generated
      return [c.name, { value: '', isNull: !hasDefault && c.nullable, useDefault: hasDefault }]
    })
  )
}

/** Insert a row, or edit one (row set). Values are sent as text parameters. */
export function RowSheet({
  projectRef,
  table,
  row,
  open,
  onOpenChange,
  onSaved,
}: {
  projectRef: string
  table: TableInfo
  row?: Record<string, unknown>
  open: boolean
  onOpenChange: (o: boolean) => void
  onSaved: () => void
}) {
  const [draft, setDraft] = useState<Draft>(() => initialDraft(table.columns, row))
  const editing = !!row
  const pk = table.columns.filter((c) => c.pk)
  const save = useMutation({
    mutationFn: () => {
      const values: Record<string, string | null> = {}
      for (const c of table.columns) {
        const d = draft[c.name]!
        if (c.generated || d.useDefault) continue
        const original = row ? toText(row[c.name]) : undefined
        const next = d.isNull ? null : d.value
        if (editing && next === original) continue
        values[c.name] = next
      }
      if (editing && Object.keys(values).length === 0) return Promise.resolve(null)
      const q = editing
        ? updateRow(table.schema, table.name, values, Object.fromEntries(pk.map((c) => [c.name, toText(row![c.name])])))
        : insertRow(table.schema, table.name, values)
      return runSql(projectRef, q.sql, { params: q.params })
    },
    onSuccess: () => {
      onSaved()
      onOpenChange(false)
    },
  })
  const set = (name: string, patch: Partial<Draft[string]>) => setDraft((d) => ({ ...d, [name]: { ...d[name]!, ...patch } }))

  return (
    <EditorSheet
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? `Update row in ${table.name}` : `Add a new row to ${table.name}`}
      error={save.error}
      submitLabel="Save"
      submitting={save.isPending}
      onSubmit={() => save.mutate()}
    >
      {table.columns.map((c) => {
        const d = draft[c.name]!
        const long = ['json', 'jsonb', 'text'].includes(c.udt) || c.udt.startsWith('_')
        // Typing replaces NULL or the default; the checkboxes bring them back.
        const disabled = c.generated
        const type = (value: string) => set(c.name, { value, isNull: false, useDefault: false })
        return (
          <FormField
            key={c.name}
            label={
              <span className="flex items-center gap-2">
                {c.name}
                <span className="font-mono text-[11px] text-foreground-lighter">{c.type}</span>
                {c.pk && <span className="text-[11px] text-brand-600">primary key</span>}
              </span>
            }
            htmlFor={`row-${c.name}`}
            description={c.comment ?? undefined}
          >
            {c.enum ? (
              <select
                id={`row-${c.name}`}
                className="h-[34px] rounded-md border bg-control px-2 text-sm disabled:opacity-50"
                value={d.value}
                disabled={disabled}
                onChange={(e) => type(e.target.value)}
              >
                <option value="" disabled>
                  Choose a value
                </option>
                {c.enum.map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            ) : long ? (
              <Textarea
                id={`row-${c.name}`}
                className="font-mono text-xs"
                disabled={disabled}
                placeholder={d.useDefault ? (c.default ?? 'default') : d.isNull ? 'NULL' : ''}
                value={d.isNull || d.useDefault ? '' : d.value}
                onChange={(e) => type(e.target.value)}
              />
            ) : (
              <Input
                id={`row-${c.name}`}
                disabled={disabled}
                placeholder={c.generated ? 'generated' : d.useDefault ? (c.default ?? (c.identity ? 'identity' : 'default')) : d.isNull ? 'NULL' : ''}
                value={d.isNull || d.useDefault ? '' : d.value}
                onChange={(e) => type(e.target.value)}
              />
            )}
            {!c.generated && (
              <div className="mt-1 flex gap-4 text-xs text-foreground-lighter">
                {c.nullable && (
                  <label className="flex items-center gap-1.5">
                    <Checkbox checked={d.isNull} onCheckedChange={(v) => set(c.name, { isNull: v === true, useDefault: false })} />
                    NULL
                  </label>
                )}
                {!editing && (c.default !== null || c.identity) && (
                  <label className="flex items-center gap-1.5">
                    <Checkbox checked={d.useDefault} onCheckedChange={(v) => set(c.name, { useDefault: v === true, isNull: false })} />
                    Use default
                  </label>
                )}
              </div>
            )}
          </FormField>
        )
      })}
    </EditorSheet>
  )
}

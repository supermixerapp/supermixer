import { AddIcon, CloseIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { BUILTIN_TYPES, ENUM_TYPES_SQL, TABLES_SQL, type TableListRow } from '@/lib/pg/catalog'
import { usePg } from '@/lib/pg/run'
import type { ColumnDef } from '@/lib/pg/table-sql'
import { t as tr, Trans } from '@/lib/i18n'

export const newColumn = (): ColumnDef => ({ name: '', type: 'text', nullable: true })

/** Studio's default columns for a new table. */
export const defaultColumns = (): ColumnDef[] => [
  { name: 'id', type: 'int8', nullable: false, primary: true, identity: true },
  { name: 'created_at', type: 'timestamptz', nullable: false, default: 'now()' },
]

function TypePicker({ projectRef, value, onChange }: { projectRef: string; value: string; onChange: (v: string) => void }) {
  const enums = usePg<{ schema: string; name: string }>(projectRef, ['enum-types'], ENUM_TYPES_SQL)
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger size="tiny" aria-label={tr('database:columnFields.type')}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel>{tr('database:columnFields.builtIn')}</SelectLabel>
          {BUILTIN_TYPES.map((t) => (
            <SelectItem key={t} value={t}>
              {t}
            </SelectItem>
          ))}
        </SelectGroup>
        {(enums.data?.length ?? 0) > 0 && (
          <SelectGroup>
            <SelectLabel>{tr('database:columnFields.enums')}</SelectLabel>
            {enums.data!.map((e) => (
              <SelectItem key={`${e.schema}.${e.name}`} value={`${e.schema}.${e.name}`}>
                {e.schema === 'public' ? e.name : `${e.schema}.${e.name}`}
              </SelectItem>
            ))}
          </SelectGroup>
        )}
      </SelectContent>
    </Select>
  )
}

/** Foreign key target: a table in the same or another schema, and its column. */
function ReferencePicker({
  projectRef,
  schema,
  value,
  onChange,
}: {
  projectRef: string
  schema: string
  value: ColumnDef['references']
  onChange: (v: ColumnDef['references']) => void
}) {
  const targetSchema = value?.schema ?? schema
  const tables = usePg<TableListRow>(projectRef, ['tables', targetSchema], TABLES_SQL, [targetSchema])
  const options = (tables.data ?? []).filter((t) => t.kind === 'r' || t.kind === 'p')
  const current = value ? `${value.schema}.${value.table}` : 'none'
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        value={current}
        onValueChange={(v) => {
          if (v === 'none') return onChange(undefined)
          const [s, ...rest] = v.split('.')
          onChange({ schema: s!, table: rest.join('.'), column: 'id', onDelete: value?.onDelete ?? 'no action' })
        }}
      >
        <SelectTrigger size="tiny" className="w-48" aria-label={tr('database:columnFields.references')}>
          <SelectValue placeholder={tr('database:columnFields.noForeignKey')} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">{tr('database:columnFields.noForeignKey')}</SelectItem>
          {options.map((t) => (
            <SelectItem key={t.id} value={`${targetSchema}.${t.name}`}>
              {targetSchema}.{t.name}
            </SelectItem>
          ))}
          {targetSchema !== 'auth' && <SelectItem value="auth.users">{'auth.users'}</SelectItem>}
        </SelectContent>
      </Select>
      {value && (
        <>
          <Input
            size="tiny"
            className="w-24"
            aria-label={tr('database:columnFields.referencedColumn')}
            value={value.column}
            onChange={(e) => onChange({ ...value, column: e.target.value })}
          />
          <Select value={value.onDelete ?? 'no action'} onValueChange={(v) => onChange({ ...value, onDelete: v as never })}>
            <SelectTrigger size="tiny" className="w-36" aria-label={tr('database:columnFields.onDelete')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(['no action', 'cascade', 'set null', 'restrict'] as const).map((o) => (
                <SelectItem key={o} value={o}>
                  {tr('database:columnFields.onDelete2', { o })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </>
      )}
    </div>
  )
}

/** One column's settings, as a card. */
export function ColumnEditor({
  projectRef,
  schema,
  value,
  onChange,
  onRemove,
}: {
  projectRef: string
  schema: string
  value: ColumnDef
  onChange: (c: ColumnDef) => void
  onRemove?: () => void
}) {
  const set = (patch: Partial<ColumnDef>) => onChange({ ...value, ...patch })
  const id = (k: string) => `col-${value.name || 'new'}-${k}`
  return (
    <div className="flex flex-col gap-3 rounded-md border bg-surface-100 p-3">
      <div className="grid grid-cols-[1fr_9rem_1fr_auto] items-center gap-2">
        <Input size="tiny" aria-label={tr('database:columnFields.columnName')} placeholder="column_name" value={value.name} onChange={(e) => set({ name: e.target.value })} />
        <TypePicker projectRef={projectRef} value={value.type} onChange={(type) => set({ type })} />
        <Input
          size="tiny"
          aria-label={tr('database:columnFields.defaultValue')}
          placeholder={value.identity ? 'identity' : tr('database:columnFields.defaultSqlEGNow')}
          disabled={value.identity}
          value={value.default ?? ''}
          onChange={(e) => set({ default: e.target.value || undefined })}
        />
        {onRemove ? <Button variant="text" size="tiny" icon={<CloseIcon />} aria-label={tr('database:columnFields.remove', { name: value.name || tr('database:columnFields.column') })} onClick={onRemove} /> : <span />}
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-foreground-light">
        {(
          [
            ['primary', tr('database:columnFields.primaryKey')],
            ['identity', tr('database:columnFields.identity')],
            ['unique', tr('database:columnFields.unique')],
            ['isArray', tr('database:columnFields.array')],
          ] as const
        ).map(([k, label]) => (
          <label key={k} htmlFor={id(k)} className="flex items-center gap-1.5">
            <Checkbox id={id(k)} checked={!!value[k]} onCheckedChange={(c) => set({ [k]: c === true })} />
            {label}
          </label>
        ))}
        <label htmlFor={id('nullable')} className="flex items-center gap-1.5">
          <Trans i18nKey="database:columnFields.nullable" components={{ checkbox: <Checkbox id={id('nullable')} checked={value.nullable && !value.primary} disabled={value.primary} onCheckedChange={(c) => set({ nullable: c === true })} /> }} />
        </label>
      </div>
      <ReferencePicker projectRef={projectRef} schema={schema} value={value.references} onChange={(references) => set({ references })} />
    </div>
  )
}

export function ColumnList({
  projectRef,
  schema,
  columns,
  onChange,
}: {
  projectRef: string
  schema: string
  columns: ColumnDef[]
  onChange: (c: ColumnDef[]) => void
}) {
  return (
    <div className="flex flex-col gap-2">
      {columns.map((c, i) => (
        <ColumnEditor
          key={i}
          projectRef={projectRef}
          schema={schema}
          value={c}
          onChange={(next) => onChange(columns.map((x, j) => (j === i ? next : x)))}
          onRemove={() => onChange(columns.filter((_, j) => j !== i))}
        />
      ))}
      <Button variant="dashed" size="tiny" icon={<AddIcon />} onClick={() => onChange([...columns, newColumn()])}>
        {tr('database:columnFields.addColumn')}
      </Button>
    </div>
  )
}

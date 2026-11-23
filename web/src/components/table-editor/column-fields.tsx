import { AddIcon, CloseIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { BUILTIN_TYPES, ENUM_TYPES_SQL, TABLES_SQL, type TableListRow } from '@/lib/pg/catalog'
import { usePg } from '@/lib/pg/run'
import type { ColumnDef } from '@/lib/pg/table-sql'

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
      <SelectTrigger size="tiny" aria-label="Type">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel>Built-in</SelectLabel>
          {BUILTIN_TYPES.map((t) => (
            <SelectItem key={t} value={t}>
              {t}
            </SelectItem>
          ))}
        </SelectGroup>
        {(enums.data?.length ?? 0) > 0 && (
          <SelectGroup>
            <SelectLabel>Enums</SelectLabel>
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
        <SelectTrigger size="tiny" className="w-48" aria-label="References">
          <SelectValue placeholder="No foreign key" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">No foreign key</SelectItem>
          {options.map((t) => (
            <SelectItem key={t.id} value={`${targetSchema}.${t.name}`}>
              {targetSchema}.{t.name}
            </SelectItem>
          ))}
          {targetSchema !== 'auth' && <SelectItem value="auth.users">auth.users</SelectItem>}
        </SelectContent>
      </Select>
      {value && (
        <>
          <Input
            size="tiny"
            className="w-24"
            aria-label="Referenced column"
            value={value.column}
            onChange={(e) => onChange({ ...value, column: e.target.value })}
          />
          <Select value={value.onDelete ?? 'no action'} onValueChange={(v) => onChange({ ...value, onDelete: v as never })}>
            <SelectTrigger size="tiny" className="w-36" aria-label="On delete">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(['no action', 'cascade', 'set null', 'restrict'] as const).map((o) => (
                <SelectItem key={o} value={o}>
                  on delete {o}
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
        <Input size="tiny" aria-label="Column name" placeholder="column_name" value={value.name} onChange={(e) => set({ name: e.target.value })} />
        <TypePicker projectRef={projectRef} value={value.type} onChange={(type) => set({ type })} />
        <Input
          size="tiny"
          aria-label="Default value"
          placeholder={value.identity ? 'identity' : 'Default (SQL), e.g. now()'}
          disabled={value.identity}
          value={value.default ?? ''}
          onChange={(e) => set({ default: e.target.value || undefined })}
        />
        {onRemove ? <Button variant="text" size="tiny" icon={<CloseIcon />} aria-label={`Remove ${value.name || 'column'}`} onClick={onRemove} /> : <span />}
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-foreground-light">
        {(
          [
            ['primary', 'Primary key'],
            ['identity', 'Identity'],
            ['unique', 'Unique'],
            ['isArray', 'Array'],
          ] as const
        ).map(([k, label]) => (
          <label key={k} htmlFor={id(k)} className="flex items-center gap-1.5">
            <Checkbox id={id(k)} checked={!!value[k]} onCheckedChange={(c) => set({ [k]: c === true })} />
            {label}
          </label>
        ))}
        <label htmlFor={id('nullable')} className="flex items-center gap-1.5">
          <Checkbox id={id('nullable')} checked={value.nullable && !value.primary} disabled={value.primary} onCheckedChange={(c) => set({ nullable: c === true })} />
          Nullable
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
        Add column
      </Button>
    </div>
  )
}

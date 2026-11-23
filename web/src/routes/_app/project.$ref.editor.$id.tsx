import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { SelectColumn, type Column, type RenderEditCellProps, type SortColumn } from 'react-data-grid'

import { ConfirmDialog } from '@/components/confirm-dialog'
import {
  AddIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  DeleteIcon,
  EditIcon,
  FilterIcon,
  KeyIcon,
  LinkIcon,
  MoreIcon,
  RefreshIcon,
} from '@/components/icons'
import { AddColumnSheet, RowSheet, useRefreshCatalog } from '@/components/table-editor/sheets'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CellValue, Grid } from '@/components/ui/data-grid'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogSection,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from '@/components/ui/toaster'
import { can, useSelectedProject } from '@/lib/api/hooks'
import { PROTECTED_SCHEMAS, TABLE_SQL, type ColumnInfo, type TableInfo } from '@/lib/pg/catalog'
import { rowsOf, runSql, usePg, type QueryResponse } from '@/lib/pg/run'
import { toText } from '@/lib/pg/sql'
import {
  countRows,
  deleteRows,
  dropColumn,
  dropTable,
  FILTER_OPS,
  renameTable,
  selectRows,
  setRls,
  updateRow,
  type Filter,
  type Sort,
} from '@/lib/pg/table-sql'

export const Route = createFileRoute('/_app/project/$ref/editor/$id')({
  component: TablePage,
})

const PAGE_SIZE = 100
/** Above this estimate, show Postgres's estimate instead of counting rows. */
const EXACT_COUNT_LIMIT = 50_000

type GridRow = Record<string, unknown>

function TablePage() {
  const { ref, id } = Route.useParams()
  const info = usePg<{ info: TableInfo | null }>(ref, ['table', id], TABLE_SQL, [id])
  const table = info.data?.[0]?.info
  if (info.isPending) {
    return (
      <div className="flex flex-col gap-2 p-4">
        <Skeleton className="h-8" />
        <Skeleton className="h-64" />
      </div>
    )
  }
  if (!table) {
    return <p className="p-6 text-sm text-foreground-lighter">{info.error?.message ?? 'This table no longer exists.'}</p>
  }
  // Remount per table so filters, sorts and paging start fresh.
  return <TableView key={table.id} projectRef={ref} table={table} />
}

function TableView({ projectRef, table }: { projectRef: string; table: TableInfo }) {
  const project = useSelectedProject()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const refreshCatalog = useRefreshCatalog(projectRef)
  const [filters, setFilters] = useState<Filter[]>([])
  const [sorts, setSorts] = useState<Sort[]>([])
  const [page, setPage] = useState(0)
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [rowSheet, setRowSheet] = useState<{ row?: GridRow } | null>(null)
  const [addingColumn, setAddingColumn] = useState(false)
  const [confirm, setConfirm] = useState<'rows' | 'table' | { column: string } | null>(null)
  const [renaming, setRenaming] = useState(false)

  const pk = table.columns.filter((c) => c.pk)
  const isTable = table.kind === 'r' || table.kind === 'p'
  const isProtected = PROTECTED_SCHEMAS.includes(table.schema)
  const canWrite = can(project, 'project:data:write') && !isProtected
  const editable = canWrite && isTable && pk.length > 0
  const keyOf = (row: GridRow) => JSON.stringify(pk.map((c) => toText(row[c.name])))

  const rowsKey = ['projects', projectRef, 'pg', 'rows', table.id, filters, sorts, page] as const
  const rows = useQuery({
    queryKey: rowsKey,
    queryFn: async ({ signal }) => {
      const q = selectRows(table.schema, table.name, { filters, sorts, limit: PAGE_SIZE, offset: page * PAGE_SIZE })
      return rowsOf<GridRow>(await runSql(projectRef, q.sql, { params: q.params, readOnly: true, maxRows: PAGE_SIZE, signal }))
    },
    placeholderData: keepPreviousData,
  })
  const exact = table.estimate < EXACT_COUNT_LIMIT || filters.length > 0
  const count = useQuery({
    queryKey: ['projects', projectRef, 'pg', 'count', table.id, filters],
    queryFn: async ({ signal }) => {
      const q = countRows(table.schema, table.name, filters)
      return Number(rowsOf<{ count: string }>(await runSql(projectRef, q.sql, { params: q.params, readOnly: true, signal }))[0]?.count ?? 0)
    },
    enabled: exact,
  })
  const total = exact ? count.data : table.estimate
  const pages = total === undefined ? undefined : Math.max(1, Math.ceil(total / PAGE_SIZE))

  const refreshRows = () => queryClient.invalidateQueries({ queryKey: ['projects', projectRef, 'pg', 'rows', table.id] })
  const refreshCounts = () => queryClient.invalidateQueries({ queryKey: ['projects', projectRef, 'pg', 'count', table.id] })

  const sql = useMutation<QueryResponse | null, Error, { sql: string; params?: (string | null)[]; done?: string }>({
    mutationFn: (q) => runSql(projectRef, q.sql, q.params ? { params: q.params } : {}),
    onSuccess: (_, q) => q.done && toast.success(q.done),
    onError: (e) => toast.error(e.message),
  })

  const updateCell = (row: GridRow, original: GridRow, column: string) => {
    const value = row[column] as string | null
    if (value === toText(original[column])) return
    const q = updateRow(table.schema, table.name, { [column]: value }, Object.fromEntries(pk.map((c) => [c.name, toText(original[c.name])])))
    // Show the new value straight away; the refetch brings back what Postgres stored.
    queryClient.setQueryData<GridRow[]>(rowsKey, (old) => old?.map((r) => (r === original ? row : r)))
    sql.mutate(q, { onSettled: () => void refreshRows() })
  }

  const columns = useMemo<Column<GridRow>[]>(() => {
    const cols: Column<GridRow>[] = table.columns.map((c) => ({
      key: c.name,
      name: c.name,
      resizable: true,
      sortable: true,
      minWidth: 90,
      width: c.udt.startsWith('json') || c.udt === 'text' ? 240 : undefined,
      renderHeaderCell: ({ sortDirection }) => (
        <HeaderCell
          column={c}
          sortDirection={sortDirection}
          canDrop={canWrite && isTable}
          onDrop={() => setConfirm({ column: c.name })}
        />
      ),
      renderCell: ({ row }) => <CellValue value={row[c.name]} />,
      editable: editable && !c.generated,
      renderEditCell: editable && !c.generated ? TextCellEditor : undefined,
    }))
    return editable ? [SelectColumn as Column<GridRow>, rowEditColumn((row) => setRowSheet({ row })), ...cols] : cols
  }, [table, editable, canWrite, isTable])

  const sortColumns: SortColumn[] = sorts.map((s) => ({ columnKey: s.column, direction: s.direction === 'asc' ? 'ASC' : 'DESC' }))

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-(--header-height) shrink-0 items-center gap-2 border-b px-3">
        <h2 className="mr-2 truncate font-sans text-sm text-foreground">
          <span className="text-foreground-lighter">{table.schema}.</span>
          {table.name}
        </h2>
        {isTable && !table.rls && !isProtected && <Badge variant="warning">RLS disabled</Badge>}
        {isTable && pk.length === 0 && <Badge>No primary key: read-only</Badge>}
        {!isTable && <Badge>{table.kind === 'v' ? 'View' : table.kind === 'm' ? 'Materialized view' : 'Foreign table'}</Badge>}
        <FilterPopover columns={table.columns} filters={filters} onApply={(f) => { setFilters(f); setPage(0) }} />
        <div className="ml-auto flex items-center gap-2">
          {selected.size > 0 && (
            <Button variant="danger" size="tiny" icon={<DeleteIcon />} onClick={() => setConfirm('rows')}>
              Delete {selected.size} row{selected.size === 1 ? '' : 's'}
            </Button>
          )}
          <Button variant="text" size="tiny" icon={<RefreshIcon />} aria-label="Refresh" onClick={() => { void refreshRows(); void refreshCounts() }} />
          {canWrite && isTable && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="primary" size="tiny" icon={<AddIcon />}>
                  Insert
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem disabled={!editable} onSelect={() => setRowSheet({})}>
                  Insert row
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setAddingColumn(true)}>Insert column</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {canWrite && isTable && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="text" size="tiny" icon={<MoreIcon />} aria-label="Table actions" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuItem onSelect={() => setRenaming(true)}>Rename table</DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() =>
                    sql.mutate(
                      { sql: setRls(table.schema, table.name, !table.rls), done: `Row Level Security ${table.rls ? 'disabled' : 'enabled'}` },
                      { onSuccess: () => void refreshCatalog() }
                    )
                  }
                >
                  {table.rls ? 'Disable Row Level Security' : 'Enable Row Level Security'}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setConfirm('table')}>Delete table</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {rows.error && <Alert variant="destructive" title={rows.error.message} className="m-3" />}
      <div className="min-h-0 flex-1">
        {rows.isPending ? (
          <div className="flex flex-col gap-2 p-3">
            <Skeleton className="h-6" />
            <Skeleton className="h-6" />
          </div>
        ) : (
          <Grid<GridRow, unknown, string>
            columns={columns}
            rows={rows.data ?? []}
            rowKeyGetter={pk.length ? keyOf : undefined}
            selectedRows={editable ? selected : undefined}
            onSelectedRowsChange={editable ? setSelected : undefined}
            sortColumns={sortColumns}
            onSortColumnsChange={(cols) => {
              setSorts(cols.slice(-1).map((c) => ({ column: c.columnKey, direction: c.direction === 'ASC' ? 'asc' : 'desc' })))
              setPage(0)
            }}
            onRowsChange={(next, { indexes, column }) => {
              for (const i of indexes) updateCell(next[i]!, rows.data![i]!, column.key)
            }}
            renderers={{
              noRowsFallback: (
                <div className="col-span-full p-8 text-center text-sm text-foreground-lighter">
                  {filters.length ? 'No rows match these filters' : 'This table is empty'}
                </div>
              ),
            }}
            className="h-full"
          />
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t px-3 py-1.5 text-xs text-foreground-lighter">
        <Button variant="text" size="tiny" icon={<ChevronLeftIcon />} aria-label="Previous page" disabled={page === 0} onClick={() => setPage((p) => p - 1)} />
        <span>
          Page {page + 1}
          {pages !== undefined && ` of ${pages}`}
        </span>
        <Button
          variant="text"
          size="tiny"
          icon={<ChevronRightIcon />}
          aria-label="Next page"
          disabled={(rows.data?.length ?? 0) < PAGE_SIZE}
          onClick={() => setPage((p) => p + 1)}
        />
        <span className="ml-2">
          {total === undefined ? 'Counting…' : `${exact ? '' : '~'}${total.toLocaleString()} record${total === 1 ? '' : 's'}`}
        </span>
        {rows.isFetching && <span>Loading…</span>}
        {!editable && isTable && !isProtected && can(project, 'project:data:write') && pk.length === 0 && (
          <span className="ml-auto">Add a primary key to edit rows here.</span>
        )}
        {!can(project, 'project:data:write') && <span className="ml-auto">Your role can view this table but not change it.</span>}
      </div>

      {rowSheet && (
        <RowSheet
          projectRef={projectRef}
          table={table}
          {...(rowSheet.row ? { row: rowSheet.row } : {})}
          open
          onOpenChange={(o) => !o && setRowSheet(null)}
          onSaved={() => {
            void refreshRows()
            void refreshCounts()
          }}
        />
      )}
      <AddColumnSheet projectRef={projectRef} table={table} open={addingColumn} onOpenChange={setAddingColumn} />
      {renaming && (
        <RenameDialog
          name={table.name}
          onClose={() => setRenaming(false)}
          onRename={(to) =>
            sql.mutate(
              { sql: renameTable(table.schema, table.name, to), done: `Renamed to ${to}` },
              { onSuccess: () => { setRenaming(false); void refreshCatalog() } }
            )
          }
          saving={sql.isPending}
        />
      )}
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={
          confirm === 'rows'
            ? `Delete ${selected.size} row${selected.size === 1 ? '' : 's'}?`
            : confirm === 'table'
              ? `Delete table ${table.name}?`
              : `Delete column ${typeof confirm === 'object' && confirm ? confirm.column : ''}?`
        }
        description={
          confirm === 'table'
            ? 'This drops the table and its data. Views or foreign keys that depend on it make this fail.'
            : 'This cannot be undone.'
        }
        confirmLabel="Delete"
        {...(confirm === 'table' ? { confirmText: table.name } : {})}
        loading={sql.isPending}
        onConfirm={() => {
          if (confirm === 'rows') {
            const keys = (rows.data ?? []).filter((r) => selected.has(keyOf(r)))
            const q = deleteRows(table.schema, table.name, keys.map((r) => Object.fromEntries(pk.map((c) => [c.name, toText(r[c.name])]))))
            sql.mutate(
              { ...q, done: `Deleted ${keys.length} row${keys.length === 1 ? '' : 's'}` },
              { onSettled: () => { setConfirm(null); setSelected(new Set()); void refreshRows(); void refreshCounts() } }
            )
          } else if (confirm === 'table') {
            sql.mutate(
              { sql: dropTable(table.schema, table.name), done: `Deleted ${table.name}` },
              {
                onSuccess: async () => {
                  setConfirm(null)
                  await refreshCatalog()
                  void navigate({ to: '/project/$ref/editor', params: { ref: projectRef }, search: { schema: table.schema } })
                },
                onError: () => setConfirm(null),
              }
            )
          } else if (confirm) {
            sql.mutate(
              { sql: dropColumn(table.schema, table.name, confirm.column), done: `Deleted column ${confirm.column}` },
              { onSettled: () => { setConfirm(null); void refreshCatalog() } }
            )
          }
        }}
      />
    </div>
  )
}

/** Opens the row editor; for long text, JSON and NULLs. */
function rowEditColumn(onEdit: (row: GridRow) => void): Column<GridRow> {
  return {
    key: '__edit',
    name: '',
    width: 32,
    minWidth: 32,
    frozen: true,
    resizable: false,
    renderCell: ({ row }) => (
      <button
        aria-label="Edit row"
        className="flex h-full w-full items-center justify-center text-foreground-lighter hover:text-foreground"
        onClick={() => onEdit(row)}
      >
        <EditIcon size={13} />
      </button>
    ),
  }
}

function HeaderCell({
  column,
  sortDirection,
  canDrop,
  onDrop,
}: {
  column: ColumnInfo
  sortDirection: 'ASC' | 'DESC' | undefined
  canDrop: boolean
  onDrop: () => void
}) {
  return (
    <span className="group flex h-full items-center gap-1.5">
      {column.pk && <KeyIcon size={12} className="shrink-0 text-brand-600" aria-label="primary key" />}
      {column.references && (
        <LinkIcon size={12} className="shrink-0 text-foreground-lighter" aria-label={`references ${column.references.table}`} />
      )}
      <span className="truncate text-foreground">{column.name}</span>
      <span className="truncate font-mono text-[11px] text-foreground-lighter">{column.type}</span>
      {sortDirection && <span className="text-foreground-lighter">{sortDirection === 'ASC' ? '↑' : '↓'}</span>}
      {canDrop && (
        <span className="ml-auto" onClick={(e) => e.stopPropagation()}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button aria-label={`Actions for ${column.name}`} className="rounded p-0.5 text-foreground-lighter opacity-0 group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100 data-[state=open]:opacity-100">
                <MoreIcon size={14} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuItem onSelect={onDrop}>Delete column</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      )}
    </span>
  )
}

/** Inline editor: Enter or leaving the cell saves, Escape cancels. */
function TextCellEditor({ row, column, onRowChange, onClose }: RenderEditCellProps<GridRow>) {
  const initial = toText(row[column.key]) ?? ''
  return (
    <input
      autoFocus
      aria-label={`Edit ${column.key}`}
      className="h-full w-full bg-control px-2 font-mono text-xs text-foreground outline-none"
      defaultValue={initial}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose(false)
        if (e.key === 'Enter') {
          onRowChange({ ...row, [column.key]: e.currentTarget.value }, true)
        }
      }}
      onBlur={(e) => {
        if (e.currentTarget.value !== initial) onRowChange({ ...row, [column.key]: e.currentTarget.value }, true)
        else onClose(false)
      }}
    />
  )
}

function FilterPopover({ columns, filters, onApply }: { columns: ColumnInfo[]; filters: Filter[]; onApply: (f: Filter[]) => void }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<Filter[]>(filters)
  const add = () => setDraft((d) => [...d, { column: columns[0]?.name ?? '', op: 'eq', value: '' }])
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o) setDraft(filters.length ? filters : [{ column: columns[0]?.name ?? '', op: 'eq', value: '' }])
      }}
    >
      <PopoverTrigger asChild>
        <Button variant={filters.length ? 'default' : 'text'} size="tiny" icon={<FilterIcon />}>
          {filters.length ? `Filtered by ${filters.length} rule${filters.length === 1 ? '' : 's'}` : 'Filter'}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[34rem] p-3">
        <div className="flex flex-col gap-2">
          {draft.map((f, i) => {
            const op = FILTER_OPS.find((o) => o.value === f.op)!
            const set = (patch: Partial<Filter>) => setDraft((d) => d.map((x, j) => (j === i ? { ...x, ...patch } : x)))
            return (
              <div key={i} className="grid grid-cols-[10rem_7rem_1fr_auto] items-center gap-2">
                <Select value={f.column} onValueChange={(column) => set({ column })}>
                  <SelectTrigger size="tiny" aria-label="Column">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {columns.map((c) => (
                      <SelectItem key={c.name} value={c.name}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={f.op} onValueChange={(v) => set({ op: v as Filter['op'] })}>
                  <SelectTrigger size="tiny" aria-label="Operator">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FILTER_OPS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  size="tiny"
                  aria-label="Value"
                  disabled={!op.needsValue}
                  placeholder={op.needsValue ? (f.op === 'like' || f.op === 'ilike' ? '%text%' : 'Value') : ''}
                  value={f.value}
                  onChange={(e) => set({ value: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      onApply(draft)
                      setOpen(false)
                    }
                  }}
                />
                <Button variant="text" size="tiny" aria-label="Remove filter" icon={<DeleteIcon />} onClick={() => setDraft((d) => d.filter((_, j) => j !== i))} />
              </div>
            )
          })}
          <div className="flex items-center justify-between pt-1">
            <Button variant="text" size="tiny" icon={<AddIcon />} onClick={add}>
              Add filter
            </Button>
            <div className="flex gap-2">
              {filters.length > 0 && (
                <Button variant="default" size="tiny" onClick={() => { onApply([]); setOpen(false) }}>
                  Clear
                </Button>
              )}
              <Button variant="primary" size="tiny" onClick={() => { onApply(draft); setOpen(false) }}>
                Apply filter
              </Button>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function RenameDialog({ name, onClose, onRename, saving }: { name: string; onClose: () => void; onRename: (to: string) => void; saving: boolean }) {
  const [value, setValue] = useState(name)
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="small">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (value.trim() && value.trim() !== name) onRename(value.trim())
          }}
        >
          <DialogHeader>
            <DialogTitle>Rename {name}</DialogTitle>
          </DialogHeader>
          <DialogSection className="border-t">
            <Input autoFocus aria-label="New table name" value={value} onChange={(e) => setValue(e.target.value)} />
          </DialogSection>
          <DialogFooter>
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={saving} disabled={!value.trim() || value.trim() === name}>
              Rename
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

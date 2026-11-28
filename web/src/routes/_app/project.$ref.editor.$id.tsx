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
import { t } from '@/lib/i18n'

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
    return <p className="p-6 text-sm text-foreground-lighter">{info.error?.message ?? t('database:editor.thisTableNoLongerExists')}</p>
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
        {isTable && !table.rls && !isProtected && <Badge variant="warning">{t('database:editor.rlsDisabled')}</Badge>}
        {isTable && pk.length === 0 && <Badge>{t('database:editor.noPrimaryKeyReadOnly')}</Badge>}
        {!isTable && <Badge>{table.kind === 'v' ? t('database:editor.view') : table.kind === 'm' ? t('database:editor.materializedView') : t('database:editor.foreignTable')}</Badge>}
        <FilterPopover columns={table.columns} filters={filters} onApply={(f) => { setFilters(f); setPage(0) }} />
        <div className="ml-auto flex items-center gap-2">
          {selected.size > 0 && (
            <Button variant="danger" size="tiny" icon={<DeleteIcon />} onClick={() => setConfirm('rows')}>
              {t('database:editor.deleteRows', { count: selected.size })}
            </Button>
          )}
          <Button variant="text" size="tiny" icon={<RefreshIcon />} aria-label={t('database:editor.refresh')} onClick={() => { void refreshRows(); void refreshCounts() }} />
          {canWrite && isTable && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="primary" size="tiny" icon={<AddIcon />}>
                  {t('database:editor.insert')}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem disabled={!editable} onSelect={() => setRowSheet({})}>
                  {t('database:editor.insertRow')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setAddingColumn(true)}>{t('database:editor.insertColumn')}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {canWrite && isTable && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="text" size="tiny" icon={<MoreIcon />} aria-label={t('database:editor.tableActions')} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuItem onSelect={() => setRenaming(true)}>{t('database:editor.renameTable')}</DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() =>
                    sql.mutate(
                      { sql: setRls(table.schema, table.name, !table.rls), done: (table.rls ? t('database:editor.rlsDisabled') : t('database:editor.rlsEnabled')) },
                      { onSuccess: () => void refreshCatalog() }
                    )
                  }
                >
                  {table.rls ? t('database:editor.disableRowLevelSecurity') : t('database:editor.enableRowLevelSecurity')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setConfirm('table')}>{t('database:editor.deleteTable')}</DropdownMenuItem>
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
                  {filters.length ? t('database:editor.noRowsMatchTheseFilters') : t('database:editor.thisTableIsEmpty')}
                </div>
              ),
            }}
            className="h-full"
          />
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t px-3 py-1.5 text-xs text-foreground-lighter">
        <Button variant="text" size="tiny" icon={<ChevronLeftIcon />} aria-label={t('database:editor.previousPage')} disabled={page === 0} onClick={() => setPage((p) => p - 1)} />
        <span>
          {pages !== undefined ? t('database:editor.pageOf', { page: page + 1, pages }) : t('database:editor.page', { page: page + 1 })}
        </span>
        <Button
          variant="text"
          size="tiny"
          icon={<ChevronRightIcon />}
          aria-label={t('database:editor.nextPage')}
          disabled={(rows.data?.length ?? 0) < PAGE_SIZE}
          onClick={() => setPage((p) => p + 1)}
        />
        <span className="ml-2">
          {total === undefined ? t('database:editor.counting') : t(exact ? 'database:editor.records' : 'database:editor.recordsAbout', { count: total })}
        </span>
        {rows.isFetching && <span>{t('database:editor.loading')}</span>}
        {!editable && isTable && !isProtected && can(project, 'project:data:write') && pk.length === 0 && (
          <span className="ml-auto">{t('database:editor.addAPrimaryKeyToEdit')}</span>
        )}
        {!can(project, 'project:data:write') && <span className="ml-auto">{t('database:editor.yourRoleCanViewThisTable')}</span>}
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
              { sql: renameTable(table.schema, table.name, to), done: t('database:editor.renamedTo', { value: to }) },
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
            ? t('database:editor.deleteRowsQuestion', { count: selected.size })
            : confirm === 'table'
              ? t('database:editor.deleteTable2', { name: table.name })
              : t('database:editor.deleteColumn', { value: typeof confirm === 'object' && confirm ? confirm.column : '' })
        }
        description={
          confirm === 'table'
            ? t('database:editor.thisDropsTheTableAndIts')
            : t('database:editor.thisCannotBeUndone')
        }
        confirmLabel={t('database:editor.delete')}
        {...(confirm === 'table' ? { confirmText: table.name } : {})}
        loading={sql.isPending}
        onConfirm={() => {
          if (confirm === 'rows') {
            const keys = (rows.data ?? []).filter((r) => selected.has(keyOf(r)))
            const q = deleteRows(table.schema, table.name, keys.map((r) => Object.fromEntries(pk.map((c) => [c.name, toText(r[c.name])]))))
            sql.mutate(
              { ...q, done: t('database:editor.deletedRows', { count: keys.length }) },
              { onSettled: () => { setConfirm(null); setSelected(new Set()); void refreshRows(); void refreshCounts() } }
            )
          } else if (confirm === 'table') {
            sql.mutate(
              { sql: dropTable(table.schema, table.name), done: t('database:editor.deleted', { name: table.name }) },
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
              { sql: dropColumn(table.schema, table.name, confirm.column), done: t('database:editor.deletedColumn', { column: confirm.column }) },
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
        aria-label={t('database:editor.editRow')}
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
      {column.pk && <KeyIcon size={12} className="shrink-0 text-brand-600" aria-label={t('database:editor.primaryKey')} />}
      {column.references && (
        <LinkIcon size={12} className="shrink-0 text-foreground-lighter" aria-label={t('database:editor.references', { table: column.references.table })} />
      )}
      <span className="truncate text-foreground">{column.name}</span>
      <span className="truncate font-mono text-[11px] text-foreground-lighter">{column.type}</span>
      {sortDirection && <span className="text-foreground-lighter">{sortDirection === 'ASC' ? '↑' : '↓'}</span>}
      {canDrop && (
        <span className="ml-auto" onClick={(e) => e.stopPropagation()}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button aria-label={t('database:editor.actionsFor', { name: column.name })} className="rounded p-0.5 text-foreground-lighter opacity-0 group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100 data-[state=open]:opacity-100">
                <MoreIcon size={14} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuItem onSelect={onDrop}>{t('database:editor.deleteColumn2')}</DropdownMenuItem>
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
      aria-label={t('database:editor.edit', { key: column.key })}
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
          {filters.length ? t('database:editor.filteredByRules', { count: filters.length }) : t('database:editor.filter')}
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
                  <SelectTrigger size="tiny" aria-label={t('database:editor.column')}>
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
                  <SelectTrigger size="tiny" aria-label={t('database:editor.operator')}>
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
                  aria-label={t('database:editor.value')}
                  disabled={!op.needsValue}
                  placeholder={op.needsValue ? (f.op === 'like' || f.op === 'ilike' ? '%text%' : t('database:editor.value')) : ''}
                  value={f.value}
                  onChange={(e) => set({ value: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      onApply(draft)
                      setOpen(false)
                    }
                  }}
                />
                <Button variant="text" size="tiny" aria-label={t('database:editor.removeFilter')} icon={<DeleteIcon />} onClick={() => setDraft((d) => d.filter((_, j) => j !== i))} />
              </div>
            )
          })}
          <div className="flex items-center justify-between pt-1">
            <Button variant="text" size="tiny" icon={<AddIcon />} onClick={add}>
              {t('database:editor.addFilter')}
            </Button>
            <div className="flex gap-2">
              {filters.length > 0 && (
                <Button variant="default" size="tiny" onClick={() => { onApply([]); setOpen(false) }}>
                  {t('database:editor.clear')}
                </Button>
              )}
              <Button variant="primary" size="tiny" onClick={() => { onApply(draft); setOpen(false) }}>
                {t('database:editor.applyFilter')}
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
            <DialogTitle>{t('database:editor.rename', { name })}</DialogTitle>
          </DialogHeader>
          <DialogSection className="border-t">
            <Input autoFocus aria-label={t('database:editor.newTableName')} value={value} onChange={(e) => setValue(e.target.value)} />
          </DialogSection>
          <DialogFooter>
            <Button variant="default" onClick={onClose}>
              {t('database:editor.cancel')}
            </Button>
            <Button type="submit" variant="primary" loading={saving} disabled={!value.trim() || value.trim() === name}>
              {t('database:editor.rename2')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

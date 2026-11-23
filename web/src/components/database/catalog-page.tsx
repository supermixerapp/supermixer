/*
 * Shared building blocks for the Database pages: a page frame with schema
 * picker and search, a results table, and a hook for schema changes.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { MoreIcon, SearchIcon } from '@/components/icons'
import { PageContainer, PageHeader } from '@/components/layout/page'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { toast } from '@/components/ui/toaster'
import { can, useSelectedProject } from '@/lib/api/hooks'
import { PROTECTED_SCHEMAS, SCHEMAS_SQL, type SchemaRow } from '@/lib/pg/catalog'
import { PARTIAL_GRANT } from '@/lib/pg/column-privileges'
import { runSql, SqlError, usePg } from '@/lib/pg/run'

/** ?schema= on Database pages; defaults to public. */
export function schemaSearch(search: Record<string, unknown>): { schema?: string } {
  return typeof search.schema === 'string' && search.schema ? { schema: search.schema } : {}
}

/** May the current member change this schema's objects? */
export function useCanChange(schema?: string) {
  const project = useSelectedProject()
  return can(project, 'project:data:write') && !(schema && PROTECTED_SCHEMAS.includes(schema))
}

/** Run DDL, report the outcome, and refresh everything read from the catalog. */
export function useDdl(projectRef: string) {
  const queryClient = useQueryClient()
  return useMutation<unknown, Error, { sql: string; done: string }>({
    mutationFn: async ({ sql }) => {
      const res = await runSql(projectRef, sql)
      // GRANT and REVOKE only warn when they change less than asked.
      const partial = res.results.flatMap((r) => r.notices ?? []).find((n) => PARTIAL_GRANT.test(n))
      if (partial) throw new Error(partial.replace(/^WARNING: /, ''))
      return res
    },
    onSuccess: async (_, { done }) => {
      toast.success(done)
      await queryClient.invalidateQueries({ queryKey: ['projects', projectRef, 'pg'] })
    },
    onError: (e) => toast.error(e instanceof SqlError && e.hint ? `${e.message} (${e.hint})` : e.message),
  })
}

export function SchemaPicker({ projectRef, value, onChange }: { projectRef: string; value: string; onChange: (s: string) => void }) {
  const schemas = usePg<SchemaRow>(projectRef, ['schemas'], SCHEMAS_SQL)
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger size="tiny" className="w-44" aria-label="Schema">
        <span className="text-foreground-lighter">schema</span>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {(schemas.data ?? [{ name: value }]).map((s) => (
          <SelectItem key={s.name} value={s.name}>
            {s.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="relative w-full max-w-56">
      <SearchIcon size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-foreground-lighter" />
      <Input size="tiny" className="pl-7" placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  )
}

export function DatabasePage({
  title,
  description,
  toolbar,
  actions,
  children,
}: {
  title: string
  description?: ReactNode
  toolbar?: ReactNode
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="h-full overflow-y-auto">
      <PageHeader title={title} description={description} size="large" />
      <PageContainer size="large" className="flex flex-col gap-4 pb-16">
        {(toolbar || actions) && (
          <div className="flex flex-wrap items-center gap-2">
            {toolbar}
            <div className="ml-auto flex items-center gap-2">{actions}</div>
          </div>
        )}
        {children}
      </PageContainer>
    </div>
  )
}

export interface ColumnSpec<T> {
  header: string
  cell: (row: T) => ReactNode
  className?: string
}

export interface RowAction<T> {
  label: string
  onSelect: (row: T) => void
  /** Ask before running; return the dialog's text. */
  confirm?: (row: T) => { title: string; description: string; confirmText?: string }
  hidden?: (row: T) => boolean
}

/** A catalog listing with loading, empty and error states, and a row menu. */
export function CatalogTable<T>({
  rows,
  error,
  loading,
  columns,
  rowKey,
  empty,
  actions,
}: {
  rows: T[] | undefined
  error?: Error | null
  loading: boolean
  columns: ColumnSpec<T>[]
  rowKey: (row: T) => string
  empty: ReactNode
  actions?: RowAction<T>[]
}) {
  const [confirming, setConfirming] = useState<{ row: T; action: RowAction<T> } | null>(null)
  if (error) return <Alert variant="destructive" title={error.message} />
  const visibleActions = (row: T) => (actions ?? []).filter((a) => !a.hidden?.(row))
  const dialog = confirming?.action.confirm?.(confirming.row)
  return (
    <Card>
      {loading ? (
        <div className="flex flex-col gap-2 p-4">
          <Skeleton className="h-6" />
          <Skeleton className="h-6" />
          <Skeleton className="h-6" />
        </div>
      ) : !rows || rows.length === 0 ? (
        <p className="px-4 py-10 text-center text-sm text-foreground-lighter">{empty}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {columns.map((c) => (
                <TableHead key={c.header} className={c.className}>
                  {c.header}
                </TableHead>
              ))}
              {actions && <TableHead className="w-12" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={rowKey(row)}>
                {columns.map((c) => (
                  <TableCell key={c.header} className={c.className}>
                    {c.cell(row)}
                  </TableCell>
                ))}
                {actions && (
                  <TableCell className="text-right">
                    {visibleActions(row).length > 0 && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="text" size="tiny" icon={<MoreIcon />} aria-label={`Actions for ${rowKey(row)}`} />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-48">
                          {visibleActions(row).map((a) => (
                            <DropdownMenuItem
                              key={a.label}
                              onSelect={() => (a.confirm ? setConfirming({ row, action: a }) : a.onSelect(row))}
                            >
                              {a.label}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <ConfirmDialog
        open={!!confirming}
        onOpenChange={(o) => !o && setConfirming(null)}
        title={dialog?.title ?? ''}
        description={dialog?.description ?? ''}
        confirmLabel={confirming?.action.label ?? 'Confirm'}
        {...(dialog?.confirmText ? { confirmText: dialog.confirmText } : {})}
        onConfirm={() => {
          if (confirming) confirming.action.onSelect(confirming.row)
          setConfirming(null)
        }}
      />
    </Card>
  )
}

/** Monospace snippet that stays on one line and truncates. */
export function Code({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <code title={title} className="block max-w-80 truncate font-mono text-xs text-foreground-light">
      {children}
    </code>
  )
}

import { useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, Outlet, useNavigate, useParams } from '@tanstack/react-router'
import { useState } from 'react'

import { AddIcon, LockIcon, SearchIcon, TableEditorIcon } from '@/components/icons'
import { CreateTableSheet } from '@/components/table-editor/sheets'
import { PermissionButton } from '@/components/permission-button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { can, useSelectedProject } from '@/lib/api/hooks'
import { PROTECTED_SCHEMAS, SCHEMAS_SQL, TABLES_SQL, type SchemaRow, type TableListRow } from '@/lib/pg/catalog'
import { pgQuery, usePg } from '@/lib/pg/run'
import { cn } from '@/lib/utils'
import { t as tr, Trans } from '@/lib/i18n'

export const Route = createFileRoute('/_app/project/$ref/editor')({
  validateSearch: (search: Record<string, unknown>): { schema?: string } =>
    typeof search.schema === 'string' && search.schema ? { schema: search.schema } : {},
  component: TableEditorLayout,
})

function TableEditorLayout() {
  const { ref } = Route.useParams()
  const { schema = 'public' } = Route.useSearch()
  const navigate = useNavigate()
  const project = useSelectedProject()
  const { id } = useParams({ strict: false })
  const [search, setSearch] = useState('')
  const [creating, setCreating] = useState(false)
  const queryClient = useQueryClient()
  const schemas = usePg<SchemaRow>(ref, ['schemas'], SCHEMAS_SQL)
  const tables = usePg<TableListRow>(ref, ['tables', schema], TABLES_SQL, [schema])
  const isProtected = PROTECTED_SCHEMAS.includes(schema)
  const visible = (tables.data ?? []).filter((t) => t.name.toLowerCase().includes(search.toLowerCase()))

  return (
    <div className="flex h-full min-h-0">
      <aside aria-label={tr('database:editor.tables')} className="hidden w-(--product-menu-width) shrink-0 flex-col border-r bg-dash-sidebar md:flex">
        <div className="flex min-h-(--header-height) shrink-0 items-center border-b px-4">
          <h4 className="font-sans text-sm font-normal">{tr('database:editor.tableEditor')}</h4>
        </div>
        <div className="flex flex-col gap-2 border-b p-3">
          <Select value={schema} onValueChange={(s) => void navigate({ to: '/project/$ref/editor', params: { ref }, search: { schema: s } })}>
            <SelectTrigger size="tiny" aria-label={tr('database:editor.schema')}>
              <span className="text-foreground-lighter">{tr('database:editor.schema2')}</span>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(schemas.data ?? [{ name: schema }]).map((s) => (
                <SelectItem key={s.name} value={s.name}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <PermissionButton
            allowed={can(project, 'project:data:write') && !isProtected}
            action={isProtected ? tr('database:editor.createTablesInManagedSchema') : tr('database:editor.createTables')}
            variant="default"
            size="tiny"
            icon={<AddIcon />}
            className="justify-start"
            onClick={() => setCreating(true)}
          >
            {tr('database:editor.newTable')}
          </PermissionButton>
        </div>
        <div className="p-3 pb-1">
          <div className="relative">
            <SearchIcon size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-foreground-lighter" />
            <Input size="tiny" className="pl-7" placeholder={tr('database:editor.searchTables')} value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>
        {isProtected && (
          <p className="mx-3 my-2 flex gap-1.5 rounded-md border bg-surface-100 px-2 py-1.5 text-xs text-foreground-light">
            <Trans i18nKey="database:editor.thisSchemaIsManagedBySupabase" components={{ lockicon: <LockIcon size={14} className="mt-px shrink-0 text-foreground-lighter" /> }} />
          </p>
        )}
        <ul className="grow overflow-y-auto px-2 py-2">
          {tables.isPending ? (
            <li className="flex flex-col gap-2 px-2">
              <Skeleton className="h-5" />
              <Skeleton className="h-5" />
            </li>
          ) : visible.length === 0 ? (
            <li className="px-2 py-4 text-center text-xs text-foreground-lighter">
              {search ? tr('database:editor.noTablesMatchYourSearch') : tr('database:editor.noTablesIn', { schema })}
            </li>
          ) : (
            visible.map((t) => {
              const active = id === String(t.id)
              return (
                <li key={t.id}>
                  <Link
                    to="/project/$ref/editor/$id"
                    params={{ ref, id: String(t.id) }}
                    search={{ schema }}
                    className={cn(
                      'flex items-center gap-2 rounded-md px-2 py-1 text-sm',
                      active ? 'bg-sidebar-accent text-foreground' : 'text-foreground-light hover:bg-sidebar-accent/50 hover:text-foreground'
                    )}
                  >
                    <TableEditorIcon size={14} className="shrink-0 text-foreground-lighter" />
                    <span className="truncate">{t.name}</span>
                    {t.kind !== 'r' && t.kind !== 'p' && (
                      <span className="ml-auto text-[10px] text-foreground-muted uppercase">{t.kind === 'v' ? 'view' : t.kind === 'm' ? tr('database:editor.matView') : 'foreign'}</span>
                    )}
                    {(t.kind === 'r' || t.kind === 'p') && !t.rls && !isProtected && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="ml-auto rounded bg-warning-200 px-1 text-[10px] text-warning-600">{tr('database:editor.rlsOff')}</span>
                        </TooltipTrigger>
                        <TooltipContent>{tr('database:editor.rowLevelSecurityIsDisabledAnyone')}</TooltipContent>
                      </Tooltip>
                    )}
                  </Link>
                </li>
              )
            })
          )}
        </ul>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <Outlet />
      </div>
      <CreateTableSheet
        projectRef={ref}
        schema={schema}
        open={creating}
        onOpenChange={setCreating}
        onCreated={async (name) => {
          // Open the new table once the refreshed list knows its id.
          const list = await queryClient.fetchQuery(pgQuery<TableListRow>(ref, ['tables', schema], TABLES_SQL, [schema]))
          const created = list.find((t) => t.name === name)
          if (created) void navigate({ to: '/project/$ref/editor/$id', params: { ref, id: String(created.id) }, search: { schema } })
        }}
      />
    </div>
  )
}


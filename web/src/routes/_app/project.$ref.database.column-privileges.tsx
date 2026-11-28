import { useQuery } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { DatabasePage, SchemaPicker, useCanChange, useDdl } from '@/components/database/catalog-page'
import { Alert } from '@/components/ui/alert'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  COLUMN_PRIVILEGES,
  columnGrant,
  lockedBy,
  tableGrant,
  PRIVILEGE_ROLES_SQL,
  PRIVILEGE_TABLES_SQL,
  setColumnPrivilege,
  setTablePrivilege,
  TABLE_PRIVILEGES_SQL,
  type ColumnPrivilege,
  type GrantSource,
  type PrivilegeRole,
  type TablePrivileges,
} from '@/lib/pg/column-privileges'
import { pgQuery, usePg } from '@/lib/pg/run'
import { localized, t as tr, Trans } from '@/lib/i18n'

interface Search {
  schema?: string
  table?: string
  role?: string
}

export const Route = createFileRoute('/_app/project/$ref/database/column-privileges')({
  validateSearch: (s: Record<string, unknown>): Search => {
    const out: Search = {}
    for (const k of ['schema', 'table', 'role'] as const) if (typeof s[k] === 'string' && s[k]) out[k] = s[k]
    return out
  },
  component: ColumnPrivilegesPage,
})

const SOURCE_TITLE = localized((): Record<GrantSource, string> => ({
  public: tr('database:databaseColumnPrivileges.grantedToPublicSoEveryRole'),
  locked: tr('database:databaseColumnPrivileges.grantedByAnotherRoleSoIt'),
  table: tr('database:databaseColumnPrivileges.grantedOnTheWholeTable'),
  column: tr('database:databaseColumnPrivileges.grantedOnThisColumn'),
  none: tr('database:databaseColumnPrivileges.notGranted'),
}))

/** A column covered by the table grant: ticked, but quieter than its own grant. */
const INHERITED = 'data-[state=checked]:border-foreground-lighter data-[state=checked]:bg-foreground-lighter data-[state=checked]:text-background'

interface Pending {
  sql: string
  title: string
  description: string
  confirmLabel: string
  done: string
}

function ColumnPrivilegesPage() {
  const { ref } = Route.useParams()
  const search = Route.useSearch()
  const navigate = useNavigate()
  const schema = search.schema ?? 'public'
  const setSearch = (next: Search) => void navigate({ to: '.', search: { ...search, ...next } })

  const tables = usePg<{ name: string; kind: string }>(ref, ['privilege-tables', schema], PRIVILEGE_TABLES_SQL, [schema])
  const roles = usePg<PrivilegeRole>(ref, ['privilege-roles'], PRIVILEGE_ROLES_SQL)
  const table = search.table ?? tables.data?.[0]?.name
  const roleName = search.role ?? (roles.data?.some((r) => r.name === 'authenticated') ? 'authenticated' : roles.data?.[0]?.name)
  const role = roles.data?.find((r) => r.name === roleName)
  // A ?role= that names no role (any more).
  const roleMissing = !!roles.data && !!roleName && !role
  const writable = useCanChange(schema)
  const privileges = useQuery({
    // Which grants are "locked" depends on who runs the REVOKE: the admin
    // user, not the read-only login that ordinary reads use.
    ...pgQuery<TablePrivileges>(ref, ['column-privileges', schema, table, roleName], TABLE_PRIVILEGES_SQL, [schema, table ?? '', roleName ?? ''], {
      readOnly: !writable,
    }),
    enabled: !!table && !!role,
  })
  const t = privileges.data?.[0]
  // A ?table= that isn't (or is no longer) in this schema.
  const missing = !!table && privileges.data?.length === 0

  const canChange = writable && !!role && !role.superuser
  const ddl = useDdl(ref)
  const [pending, setPending] = useState<Pending | null>(null)
  const target = { schema, table: table ?? '', role: roleName ?? '' }
  const applies = (p: ColumnPrivilege) => t?.kind !== 'm' || p === 'SELECT'

  const toggleTable = (p: ColumnPrivilege, on: boolean) => {
    if (!t) return
    const sql = setTablePrivilege(target, p, on)
    const done = tr(on ? 'database:databaseColumnPrivileges.grantedOnTable' : 'database:databaseColumnPrivileges.revokedOnTable', { p, table: target.table, role: target.role })
    if (on) return ddl.mutate({ sql, done })
    setPending({
      sql,
      done,
      title: tr('database:databaseColumnPrivileges.revokeOnAllOf', { p, table: target.table }),
      description: tr('database:databaseColumnPrivileges.losesOnEveryColumnOfIncluding', { role: target.role, p, schema, table: target.table }),
      confirmLabel: tr('database:databaseColumnPrivileges.revoke', { p }),
    })
  }

  const toggleColumn = (p: ColumnPrivilege, column: string, on: boolean) => {
    if (!t) return
    const sql = setColumnPrivilege(target, p, column, on, t)
    const done = tr(on ? 'database:databaseColumnPrivileges.grantedOnColumn' : 'database:databaseColumnPrivileges.revokedOnColumn', { p, column, role: target.role })
    if (on || columnGrant(t, column, p) !== 'table') return ddl.mutate({ sql, done })
    setPending({
      sql,
      done,
      title: tr('database:databaseColumnPrivileges.revokeOn', { p, column }),
      description: tr('database:databaseColumnPrivileges.hasOnTheWholeTableWhich', { role: target.role, p, column, length: t.columns.length - 1, p2: p }),
      confirmLabel: tr('database:databaseColumnPrivileges.revokeFromColumn'),
    })
  }

  const cell = (
    source: GrantSource,
    label: string,
    enabled: boolean,
    onChange: (on: boolean) => void,
    { title = SOURCE_TITLE()[source], quiet = source === 'table', grantors = [] as string[] } = {}
  ) => (
    <span title={source === 'locked' && grantors.length ? tr('database:databaseColumnPrivileges.grantedBySoItCanT', { join: grantors.join(', ') }) : title} className="inline-flex">
      <Checkbox
        aria-label={label}
        checked={source !== 'none'}
        disabled={!enabled || !canChange || ddl.isPending || source === 'public' || source === 'locked'}
        onCheckedChange={(c) => onChange(c === true)}
        className={quiet ? INHERITED : undefined}
      />
    </span>
  )

  return (
    <DatabasePage
      title={tr('database:databaseColumnPrivileges.columnPrivileges')}
      description={tr('database:databaseColumnPrivileges.chooseWhichColumnsOfATable')}
      toolbar={
        <>
          <SchemaPicker projectRef={ref} value={schema} onChange={(s) => setSearch({ schema: s, table: undefined })} />
          <Select value={table ?? ''} onValueChange={(v) => setSearch({ table: v })} disabled={!tables.data?.length}>
            <SelectTrigger size="tiny" className="w-48" aria-label={tr('database:databaseColumnPrivileges.table')}>
              <span className="text-foreground-lighter">{tr('database:databaseColumnPrivileges.table2')}</span>
              <SelectValue placeholder={tr('database:databaseColumnPrivileges.none')} />
            </SelectTrigger>
            <SelectContent>
              {(tables.data ?? []).map((x) => (
                <SelectItem key={x.name} value={x.name}>
                  {x.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={roleName ?? ''} onValueChange={(v) => setSearch({ role: v })}>
            <SelectTrigger size="tiny" className="w-56" aria-label={tr('database:databaseColumnPrivileges.role')}>
              <span className="text-foreground-lighter">{tr('database:databaseColumnPrivileges.role2')}</span>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(roles.data ?? []).map((r) => (
                <SelectItem key={r.name} value={r.name}>
                  {r.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </>
      }
    >
      <Alert title={tr('database:databaseColumnPrivileges.aGrantOnTheWholeTable')}>
        {tr('database:databaseColumnPrivileges.untickingOneColumnOfAPrivilege')}
      </Alert>
      {role?.superuser && <Alert variant="warning" title={tr('database:databaseColumnPrivileges.isASuperuserSoPostgresNever', { name: role.name })} />}
      {t && roleName === t.owner && (
        <Alert title={tr('database:databaseColumnPrivileges.ownsSoItCanAlwaysGrant', { owner: t.owner, table })} />
      )}
      {tables.error || roles.error || privileges.error ? (
        <Alert variant="destructive" title={(tables.error ?? roles.error ?? privileges.error)!.message} />
      ) : (tables.data && tables.data.length === 0) || missing || roleMissing ? (
        <Card>
          <p className="px-4 py-10 text-center text-sm text-foreground-lighter">
            {roleMissing ? tr('database:databaseColumnPrivileges.noRoleCalled', { roleName }) : missing ? tr('database:databaseColumnPrivileges.noTableOrViewCalledIn', { table, schema }) : tr('database:databaseColumnPrivileges.noTablesOrViewsIn', { schema })}
          </p>
        </Card>
      ) : !t ? (
        <Card className="flex flex-col gap-2 p-4">
          <Skeleton className="h-6" />
          <Skeleton className="h-6" />
          <Skeleton className="h-6" />
        </Card>
      ) : (
        <Card>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>{tr('database:databaseColumnPrivileges.column')}</TableHead>
                <TableHead>{tr('database:databaseColumnPrivileges.type')}</TableHead>
                {COLUMN_PRIVILEGES.map((p) => (
                  <TableHead key={p} className="w-28 text-center">
                    {p}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow className="bg-surface-75 hover:bg-surface-75">
                <TableCell className="text-foreground">{tr('database:databaseColumnPrivileges.allColumns')}</TableCell>
                <TableCell className="text-xs text-foreground-lighter">{tr('database:databaseColumnPrivileges.tableGrant')}</TableCell>
                {COLUMN_PRIVILEGES.map((p) => (
                  <TableCell key={p} className="text-center">
                    {cell(tableGrant(t, p), tr('database:databaseColumnPrivileges.onAllOf', { p, table }), applies(p), (on) => toggleTable(p, on), {
                      title: tableGrant(t, p) === 'none' ? tr('database:databaseColumnPrivileges.notGrantedOnTheWholeTable') : SOURCE_TITLE()[tableGrant(t, p)],
                      quiet: false,
                      grantors: lockedBy(t, p),
                    })}
                  </TableCell>
                ))}
              </TableRow>
              {t.columns.map((c) => (
                <TableRow key={c.name}>
                  <TableCell className="text-foreground">{c.name}</TableCell>
                  <TableCell className="font-mono text-xs text-foreground-lighter">{c.type}</TableCell>
                  {COLUMN_PRIVILEGES.map((p) => (
                    <TableCell key={p} className="text-center">
                      {cell(columnGrant(t, c.name, p), tr('database:databaseColumnPrivileges.on3', { p, name: c.name }), applies(p), (on) => toggleColumn(p, c.name, on), {
                        grantors: lockedBy(t, p, c.name),
                      })}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-4 py-2 text-xs text-foreground-lighter">
            <span className="flex items-center gap-1.5">
              <Trans i18nKey="database:databaseColumnPrivileges.coveredByTheTableGrant" components={{ checkbox: <Checkbox checked disabled aria-hidden tabIndex={-1} className={`disabled:opacity-100 ${INHERITED}`} /> }} />
            </span>
            <span className="flex items-center gap-1.5">
              <Trans i18nKey="database:databaseColumnPrivileges.grantedOnTheColumn" components={{ checkbox: <Checkbox checked disabled aria-hidden tabIndex={-1} className="disabled:opacity-100" /> }} />
            </span>
          </p>
        </Card>
      )}
      <ConfirmDialog
        open={!!pending}
        onOpenChange={(o) => !o && setPending(null)}
        title={pending?.title ?? ''}
        description={pending?.description}
        variant="warning"
        confirmLabel={pending?.confirmLabel ?? tr('database:databaseColumnPrivileges.revoke2')}
        loading={ddl.isPending}
        onConfirm={() => pending && ddl.mutate({ sql: pending.sql, done: pending.done }, { onSettled: () => setPending(null) })}
      >
        {pending && (
          <pre className="overflow-x-auto rounded-md border bg-surface-100 p-3 font-mono text-xs whitespace-pre-wrap text-foreground">{pending.sql}</pre>
        )}
      </ConfirmDialog>
    </DatabasePage>
  )
}

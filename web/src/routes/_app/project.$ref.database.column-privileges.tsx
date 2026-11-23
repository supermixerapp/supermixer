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

const SOURCE_TITLE: Record<GrantSource, string> = {
  public: 'Granted to PUBLIC, so every role has it',
  locked: 'Granted by another role, so it can\'t be revoked here',
  table: 'Granted on the whole table',
  column: 'Granted on this column',
  none: 'Not granted',
}

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
    const done = `${on ? 'Granted' : 'Revoked'} ${p} on ${target.table} ${on ? 'to' : 'from'} ${target.role}`
    if (on) return ddl.mutate({ sql, done })
    setPending({
      sql,
      done,
      title: `Revoke ${p} on all of ${target.table}?`,
      description: `${target.role} loses ${p} on every column of ${schema}.${target.table}, including any granted column by column.`,
      confirmLabel: `Revoke ${p}`,
    })
  }

  const toggleColumn = (p: ColumnPrivilege, column: string, on: boolean) => {
    if (!t) return
    const sql = setColumnPrivilege(target, p, column, on, t)
    const done = `${on ? 'Granted' : 'Revoked'} ${p} on ${column} ${on ? 'to' : 'from'} ${target.role}`
    if (on || columnGrant(t, column, p) !== 'table') return ddl.mutate({ sql, done })
    setPending({
      sql,
      done,
      title: `Revoke ${p} on ${column}?`,
      description: `${target.role} has ${p} on the whole table, which covers every column. To take ${column} away, the table grant is replaced by grants on each of the other ${t.columns.length - 1} columns. Columns added later won't get ${p} until you grant it.`,
      confirmLabel: 'Revoke from column',
    })
  }

  const cell = (
    source: GrantSource,
    label: string,
    enabled: boolean,
    onChange: (on: boolean) => void,
    { title = SOURCE_TITLE[source], quiet = source === 'table', grantors = [] as string[] } = {}
  ) => (
    <span title={source === 'locked' && grantors.length ? `Granted by ${grantors.join(', ')}, so it can't be revoked here` : title} className="inline-flex">
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
      title="Column Privileges"
      description="Choose which columns of a table each role can read and write through the Data API and SQL."
      toolbar={
        <>
          <SchemaPicker projectRef={ref} value={schema} onChange={(s) => setSearch({ schema: s, table: undefined })} />
          <Select value={table ?? ''} onValueChange={(v) => setSearch({ table: v })} disabled={!tables.data?.length}>
            <SelectTrigger size="tiny" className="w-48" aria-label="Table">
              <span className="text-foreground-lighter">table</span>
              <SelectValue placeholder="None" />
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
            <SelectTrigger size="tiny" className="w-56" aria-label="Role">
              <span className="text-foreground-lighter">role</span>
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
      <Alert title="A grant on the whole table covers every column">
        Unticking one column of a privilege the role holds table-wide replaces the table grant with grants on each other column, and new
        columns then aren&apos;t covered until you grant them. Privileges a role gets through membership of another role aren&apos;t shown.
        Row Level Security still decides which rows a role sees.
      </Alert>
      {role?.superuser && <Alert variant="warning" title={`${role.name} is a superuser, so Postgres never checks its privileges.`} />}
      {t && roleName === t.owner && (
        <Alert title={`${t.owner} owns ${table}, so it can always grant itself these privileges back.`} />
      )}
      {tables.error || roles.error || privileges.error ? (
        <Alert variant="destructive" title={(tables.error ?? roles.error ?? privileges.error)!.message} />
      ) : (tables.data && tables.data.length === 0) || missing || roleMissing ? (
        <Card>
          <p className="px-4 py-10 text-center text-sm text-foreground-lighter">
            {roleMissing ? `No role called ${roleName}` : missing ? `No table or view called ${table} in ${schema}` : `No tables or views in ${schema}`}
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
                <TableHead>Column</TableHead>
                <TableHead>Type</TableHead>
                {COLUMN_PRIVILEGES.map((p) => (
                  <TableHead key={p} className="w-28 text-center">
                    {p}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow className="bg-surface-75 hover:bg-surface-75">
                <TableCell className="text-foreground">All columns</TableCell>
                <TableCell className="text-xs text-foreground-lighter">table grant</TableCell>
                {COLUMN_PRIVILEGES.map((p) => (
                  <TableCell key={p} className="text-center">
                    {cell(tableGrant(t, p), `${p} on all of ${table}`, applies(p), (on) => toggleTable(p, on), {
                      title: tableGrant(t, p) === 'none' ? 'Not granted on the whole table' : SOURCE_TITLE[tableGrant(t, p)],
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
                      {cell(columnGrant(t, c.name, p), `${p} on ${c.name}`, applies(p), (on) => toggleColumn(p, c.name, on), {
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
              <Checkbox checked disabled aria-hidden tabIndex={-1} className={`disabled:opacity-100 ${INHERITED}`} /> covered by the table grant
            </span>
            <span className="flex items-center gap-1.5">
              <Checkbox checked disabled aria-hidden tabIndex={-1} className="disabled:opacity-100" /> granted on the column
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
        confirmLabel={pending?.confirmLabel ?? 'Revoke'}
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

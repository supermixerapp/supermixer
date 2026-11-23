import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { DatabasePage, SearchBox, useCanChange, useDdl } from '@/components/database/catalog-page'
import { RefreshIcon } from '@/components/icons'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { CodeBlock } from '@/components/ui/code-block'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetSection, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { containsPattern } from '@/lib/auth-users'
import { enableExtension } from '@/lib/pg/database'
import {
  formatMs,
  QUERY_SORTS,
  queryStatsSql,
  resetStatsSql,
  STATEMENTS_SCHEMA_SQL,
  statementRolesSql,
  statsResetSql,
  type QuerySort,
  type QueryStat,
} from '@/lib/pg/query-performance'
import { pgQuery, usePg } from '@/lib/pg/run'

export const Route = createFileRoute('/_app/project/$ref/advisors/query-performance')({
  component: QueryPerformancePage,
})

const ALL = '__all__'

function QueryPerformancePage() {
  const { ref } = Route.useParams()
  const canChange = useCanChange()
  const ddl = useDdl(ref)
  const [sort, setSort] = useState<QuerySort>('total')
  const [role, setRole] = useState(ALL)
  const [typed, setTyped] = useState('')
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState<QueryStat | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setSearch(typed.trim()), 300)
    return () => clearTimeout(t)
  }, [typed])

  const installed = usePg<{ schema: string }>(ref, ['statements-schema'], STATEMENTS_SCHEMA_SQL)
  const schema = installed.data?.[0]?.schema
  const roleName = role === ALL ? '' : role
  const stats = useQuery({
    // The read-only login can't see other roles' statement text (it may hold
    // secrets, e.g. ALTER ROLE … PASSWORD), so members who can change data
    // read the statistics as the admin user.
    ...pgQuery<QueryStat>(
      ref,
      ['query-stats', schema, sort, roleName, search],
      queryStatsSql(schema ?? 'extensions', sort),
      [roleName, search ? containsPattern(search) : ''],
      { readOnly: !canChange }
    ),
    enabled: !!schema,
    placeholderData: keepPreviousData,
  })
  const roles = useQuery({ ...pgQuery<{ name: string }>(ref, ['statement-roles', schema], statementRolesSql(schema ?? 'extensions')), enabled: !!schema })
  const since = useQuery({
    ...pgQuery<{ stats_reset: string }>(ref, ['statements-reset', schema], statsResetSql(schema ?? 'extensions')),
    enabled: !!schema,
  })
  const sinceAt = since.data?.[0]?.stats_reset

  if (installed.error) {
    return (
      <DatabasePage title="Query Performance">
        <Alert variant="destructive" title={installed.error.message} />
      </DatabasePage>
    )
  }
  if (installed.data && !schema) {
    return (
      <DatabasePage title="Query Performance" description="Which statements cost the database the most time.">
        <Alert
          title="pg_stat_statements isn't enabled"
          actions={
            canChange && (
              <Button
                variant="default"
                loading={ddl.isPending}
                onClick={() => ddl.mutate({ sql: enableExtension('pg_stat_statements', 'extensions'), done: 'Enabled pg_stat_statements' })}
              >
                Enable pg_stat_statements
              </Button>
            )
          }
        >
          Query Performance reads its statistics. Supabase stacks load it at startup; if enabling fails, add it to
          shared_preload_libraries and restart Postgres.
        </Alert>
      </DatabasePage>
    )
  }

  const rows = stats.data ?? []
  const hidden = rows.some((q) => q.query === HIDDEN)
  return (
    <DatabasePage
      title="Query Performance"
      description={
        <>
          Which statements cost the database the most time, from pg_stat_statements.
          {sinceAt && ` Collected since ${new Date(sinceAt).toLocaleString()}.`}
        </>
      }
      toolbar={
        <>
          <Tabs value={sort} onValueChange={(v) => setSort(v as QuerySort)}>
            <TabsList className="border-b-0">
              {Object.entries(QUERY_SORTS).map(([k, s]) => (
                <TabsTrigger key={k} value={k}>
                  {s.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <SearchBox value={typed} onChange={setTyped} placeholder="Search queries" />
          <Select value={role} onValueChange={setRole}>
            <SelectTrigger size="tiny" className="w-44" aria-label="Role">
              <span className="text-foreground-lighter">role</span>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All roles</SelectItem>
              {(roles.data ?? []).map((r) => (
                <SelectItem key={r.name} value={r.name}>
                  {r.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </>
      }
      actions={
        <>
          <Button variant="default" size="tiny" icon={<RefreshIcon />} loading={stats.isFetching && !stats.isPending} onClick={() => void stats.refetch()}>
            Refresh
          </Button>
          {canChange && (
            <Button variant="default" size="tiny" onClick={() => setConfirmReset(true)}>
              Reset report
            </Button>
          )}
        </>
      }
    >
      {hidden && (
        <Alert title="Some statement text is hidden">
          Postgres shows other roles&apos; statements only to members of pg_read_all_stats. Read-only access uses a login
          without it, so statements that may hold secrets, such as ALTER ROLE … PASSWORD, stay hidden.
        </Alert>
      )}
      {stats.error ? (
        <Alert variant="destructive" title={stats.error.message} />
      ) : (
        <Card>
          {!stats.data ? (
            <div className="flex flex-col gap-2 p-4">
              <Skeleton className="h-6" />
              <Skeleton className="h-6" />
              <Skeleton className="h-6" />
            </div>
          ) : rows.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-foreground-lighter">{search || roleName ? 'No statements match' : 'No statements recorded yet'}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Query</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead className="text-right">Calls</TableHead>
                  <TableHead className="text-right whitespace-nowrap">Total time</TableHead>
                  <TableHead className="text-right">Mean</TableHead>
                  <TableHead className="text-right">Max</TableHead>
                  <TableHead className="text-right whitespace-nowrap">Cache hit</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((q) => (
                  <TableRow
                    key={`${q.id}-${q.role}`}
                    className="cursor-pointer"
                    tabIndex={0}
                    onClick={() => setOpen(q)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        setOpen(q)
                      }
                    }}
                  >
                    <TableCell className="max-w-xs">
                      <code className="block truncate font-mono text-xs text-foreground" title={q.query}>
                        {oneLine(q.query)}
                      </code>
                    </TableCell>
                    <TableCell className="text-foreground-light">{q.role ?? '—'}</TableCell>
                    <TableCell className="text-right tabular-nums text-foreground-light">{q.calls.toLocaleString()}</TableCell>
                    <TableCell className="text-right whitespace-nowrap tabular-nums text-foreground-light">
                      {formatMs(q.total_ms)}
                      {q.share !== null && <span className="ml-1 text-xs text-foreground-lighter">({q.share.toFixed(1)}%)</span>}
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap tabular-nums text-foreground-light">{formatMs(q.mean_ms)}</TableCell>
                    <TableCell className="text-right whitespace-nowrap tabular-nums text-foreground-light">{formatMs(q.max_ms)}</TableCell>
                    <TableCell className="text-right tabular-nums text-foreground-light">{percent(q.cache_hit)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
      )}
      <Sheet open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        <SheetContent size="lg" className="flex flex-col">
          {open && (
            <>
              <SheetHeader>
                <SheetTitle>Statement details</SheetTitle>
                <SheetDescription>
                  Run as {open.role ?? 'an unknown role'}. Constants are replaced by $1, $2, … so similar queries are counted together.
                </SheetDescription>
              </SheetHeader>
              <div className="flex-1 overflow-y-auto">
                <SheetSection>
                  <CodeBlock code={open.query} className="[&_pre]:max-h-96" />
                </SheetSection>
                <SheetSection className="border-t">
                  <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
                    <Metric label="Calls" value={open.calls.toLocaleString()} />
                    <Metric label="Total time" value={formatMs(open.total_ms)} />
                    <Metric label="Share of all time" value={open.share === null ? '—' : `${open.share.toFixed(1)}%`} />
                    <Metric label="Mean" value={formatMs(open.mean_ms)} />
                    <Metric label="Min" value={formatMs(open.min_ms)} />
                    <Metric label="Max" value={formatMs(open.max_ms)} />
                    <Metric label="Rows" value={open.rows.toLocaleString()} />
                    <Metric label="Rows per call" value={open.calls ? (open.rows / open.calls).toFixed(open.rows < open.calls ? 2 : 1) : '—'} />
                    <Metric label="Cache hit" value={percent(open.cache_hit)} />
                  </dl>
                </SheetSection>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
      {schema && (
        <ConfirmDialog
          open={confirmReset}
          onOpenChange={setConfirmReset}
          title="Reset query statistics?"
          description="Clears pg_stat_statements for the whole database server. Statistics start collecting again from now."
          confirmLabel="Reset report"
          variant="warning"
          loading={ddl.isPending}
          onConfirm={() => ddl.mutate({ sql: resetStatsSql(schema), done: 'Statistics reset' }, { onSettled: () => setConfirmReset(false) })}
        />
      )}
    </DatabasePage>
  )
}

const HIDDEN = '<insufficient privilege>'
const oneLine = (q: string) => q.replace(/\s+/g, ' ').trim()
const percent = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(v > 0.999 && v < 1 ? 2 : 1)}%`)

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-foreground-lighter">{label}</dt>
      <dd className="tabular-nums text-foreground">{value}</dd>
    </div>
  )
}

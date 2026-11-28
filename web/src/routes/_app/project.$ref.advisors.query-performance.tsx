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
import { t as tr, language } from '@/lib/i18n'

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
      <DatabasePage title={tr('observability:advisorsQueryPerformance.queryPerformance')}>
        <Alert variant="destructive" title={installed.error.message} />
      </DatabasePage>
    )
  }
  if (installed.data && !schema) {
    return (
      <DatabasePage title={tr('observability:advisorsQueryPerformance.queryPerformance')} description={tr('observability:advisorsQueryPerformance.whichStatementsCostTheDatabaseThe')}>
        <Alert
          title={tr('observability:advisorsQueryPerformance.pgStatStatementsIsnTEnabled')}
          actions={
            canChange && (
              <Button
                variant="default"
                loading={ddl.isPending}
                onClick={() => ddl.mutate({ sql: enableExtension('pg_stat_statements', 'extensions'), done: tr('observability:advisorsQueryPerformance.enabledPgStatStatements') })}
              >
                {tr('observability:advisorsQueryPerformance.enablePgStatStatements')}
              </Button>
            )
          }
        >
          {tr('observability:advisorsQueryPerformance.queryPerformanceReadsItsStatisticsSupabase')}
        </Alert>
      </DatabasePage>
    )
  }

  const rows = stats.data ?? []
  const hidden = rows.some((q) => q.query === HIDDEN)
  return (
    <DatabasePage
      title={tr('observability:advisorsQueryPerformance.queryPerformance')}
      description={
        <>
          {tr('observability:advisorsQueryPerformance.whichStatementsCostTheDatabaseThe2')}
          {sinceAt && tr('observability:advisorsQueryPerformance.collectedSince', { value: new Date(sinceAt).toLocaleString(language()) })}
        </>
      }
      toolbar={
        <>
          <Tabs value={sort} onValueChange={(v) => setSort(v as QuerySort)}>
            <TabsList className="border-b-0">
              {Object.entries(QUERY_SORTS()).map(([k, s]) => (
                <TabsTrigger key={k} value={k}>
                  {s.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <SearchBox value={typed} onChange={setTyped} placeholder={tr('observability:advisorsQueryPerformance.searchQueries')} />
          <Select value={role} onValueChange={setRole}>
            <SelectTrigger size="tiny" className="w-44" aria-label={tr('observability:advisorsQueryPerformance.role')}>
              <span className="text-foreground-lighter">{tr('observability:advisorsQueryPerformance.role2')}</span>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{tr('observability:advisorsQueryPerformance.allRoles')}</SelectItem>
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
            {tr('observability:advisorsQueryPerformance.refresh')}
          </Button>
          {canChange && (
            <Button variant="default" size="tiny" onClick={() => setConfirmReset(true)}>
              {tr('observability:advisorsQueryPerformance.resetReport')}
            </Button>
          )}
        </>
      }
    >
      {hidden && (
        <Alert title={tr('observability:advisorsQueryPerformance.someStatementTextIsHidden')}>
          {tr('observability:advisorsQueryPerformance.postgresShowsOtherRolesStatementsOnly')}
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
            <p className="px-4 py-10 text-center text-sm text-foreground-lighter">{search || roleName ? tr('observability:advisorsQueryPerformance.noStatementsMatch') : tr('observability:advisorsQueryPerformance.noStatementsRecordedYet')}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{tr('observability:advisorsQueryPerformance.query')}</TableHead>
                  <TableHead>{tr('observability:advisorsQueryPerformance.role')}</TableHead>
                  <TableHead className="text-right">{tr('observability:advisorsQueryPerformance.calls')}</TableHead>
                  <TableHead className="text-right whitespace-nowrap">{tr('observability:advisorsQueryPerformance.totalTime')}</TableHead>
                  <TableHead className="text-right">{tr('observability:advisorsQueryPerformance.mean')}</TableHead>
                  <TableHead className="text-right">{tr('observability:advisorsQueryPerformance.max')}</TableHead>
                  <TableHead className="text-right whitespace-nowrap">{tr('observability:advisorsQueryPerformance.cacheHit')}</TableHead>
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
                    <TableCell className="text-right tabular-nums text-foreground-light">{q.calls.toLocaleString(language())}</TableCell>
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
                <SheetTitle>{tr('observability:advisorsQueryPerformance.statementDetails')}</SheetTitle>
                <SheetDescription>
                  {tr('observability:advisorsQueryPerformance.runAsConstantsAreReplacedBy', { role: open.role ?? tr('observability:advisorsQueryPerformance.anUnknownRole') })}
                </SheetDescription>
              </SheetHeader>
              <div className="flex-1 overflow-y-auto">
                <SheetSection>
                  <CodeBlock code={open.query} className="[&_pre]:max-h-96" />
                </SheetSection>
                <SheetSection className="border-t">
                  <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
                    <Metric label={tr('observability:advisorsQueryPerformance.calls')} value={open.calls.toLocaleString(language())} />
                    <Metric label={tr('observability:advisorsQueryPerformance.totalTime')} value={formatMs(open.total_ms)} />
                    <Metric label={tr('observability:advisorsQueryPerformance.shareOfAllTime')} value={open.share === null ? '—' : `${open.share.toFixed(1)}%`} />
                    <Metric label={tr('observability:advisorsQueryPerformance.mean')} value={formatMs(open.mean_ms)} />
                    <Metric label={tr('observability:advisorsQueryPerformance.min')} value={formatMs(open.min_ms)} />
                    <Metric label={tr('observability:advisorsQueryPerformance.max')} value={formatMs(open.max_ms)} />
                    <Metric label={tr('observability:advisorsQueryPerformance.rows')} value={open.rows.toLocaleString(language())} />
                    <Metric label={tr('observability:advisorsQueryPerformance.rowsPerCall')} value={open.calls ? (open.rows / open.calls).toFixed(open.rows < open.calls ? 2 : 1) : '—'} />
                    <Metric label={tr('observability:advisorsQueryPerformance.cacheHit')} value={percent(open.cache_hit)} />
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
          title={tr('observability:advisorsQueryPerformance.resetQueryStatistics')}
          description={tr('observability:advisorsQueryPerformance.clearsPgStatStatementsForThe')}
          confirmLabel={tr('observability:advisorsQueryPerformance.resetReport')}
          variant="warning"
          loading={ddl.isPending}
          onConfirm={() => ddl.mutate({ sql: resetStatsSql(schema), done: tr('observability:advisorsQueryPerformance.statisticsReset') }, { onSettled: () => setConfirmReset(false) })}
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

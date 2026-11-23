import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'

import { DatabasePage, useCanChange } from '@/components/database/catalog-page'
import { Alert } from '@/components/ui/alert'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { relativeTime } from '@/lib/auth-users'
import {
  commitRate,
  CONNECTIONS_SQL,
  DATABASE_STATS_SQL,
  LARGEST_TABLES_SQL,
  type ConnectionGroup,
  type DatabaseStats,
  type TableSize,
} from '@/lib/pg/observability'
import { pgQuery } from '@/lib/pg/run'
import { formatBytes } from '@/lib/storage-api'

export const Route = createFileRoute('/_app/project/$ref/observability/')({
  component: ObservabilityPage,
})

const REFRESH = 10_000

function ObservabilityPage() {
  const { ref } = Route.useParams()
  // The read-only login can't see other roles' sessions in full.
  const admin = { readOnly: !useCanChange() }
  const stats = useQuery({ ...pgQuery<DatabaseStats>(ref, ['obs-stats'], DATABASE_STATS_SQL, undefined, admin), refetchInterval: REFRESH })
  const connections = useQuery({ ...pgQuery<ConnectionGroup>(ref, ['obs-connections'], CONNECTIONS_SQL, undefined, admin), refetchInterval: REFRESH })
  const tables = useQuery({ ...pgQuery<TableSize>(ref, ['obs-tables'], LARGEST_TABLES_SQL, undefined, admin), refetchInterval: 60_000 })
  const s = stats.data?.[0]

  // Transactions per second between the last two samples.
  const previous = useRef<DatabaseStats | undefined>(undefined)
  const [tps, setTps] = useState<number | null>(null)
  useEffect(() => {
    if (!s) return
    setTps(commitRate(previous.current, s))
    previous.current = s
  }, [s])

  return (
    <DatabasePage
      title="Database"
      description={
        <>
          Live figures from Postgres&apos;s statistics, refreshed every 10 seconds.
          {s?.stats_reset && ` Totals count from ${new Date(s.stats_reset).toLocaleString()}.`}
        </>
      }
    >
      {stats.error ? (
        <Alert variant="destructive" title={stats.error.message} />
      ) : !s ? (
        <Skeleton className="h-28" />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Database size" value={formatBytes(s.db_bytes)} />
          <Stat
            label="Connections"
            value={`${s.connections} / ${s.max_connections}`}
            hint={`${s.active} running a query`}
            warn={s.connections / s.max_connections > 0.8}
          />
          <Stat label="Transactions per second" value={tps === null ? '…' : tps.toFixed(tps < 10 ? 1 : 0)} hint={`${pct(s.rollbacks / Math.max(1, s.commits + s.rollbacks))} rolled back`} />
          <Stat
            label="Cache hit rate"
            value={s.table_hit === null ? '—' : pct(s.table_hit)}
            hint={`indexes ${s.index_hit === null ? '—' : pct(s.index_hit)}`}
            warn={s.table_hit !== null && s.table_hit < 0.99}
          />
          <Stat label="Deadlocks" value={s.deadlocks.toLocaleString()} warn={s.deadlocks > 0} />
          <Stat label="Temporary files" value={formatBytes(s.temp_bytes)} hint="Queries that spilled to disk" />
        </div>
      )}
      <section className="flex flex-col gap-2">
        <h2 className="text-sm text-foreground">Connections</h2>
        <Card>
          {connections.error ? (
            <div className="p-4">
              <Alert variant="destructive" title={connections.error.message} />
            </div>
          ) : !connections.data ? (
            <Skeleton className="m-4 h-20" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Application</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead className="text-right">Count</TableHead>
                  <TableHead className="whitespace-nowrap">Oldest</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {connections.data.map((c, i) => (
                  <TableRow key={`${c.app}-${c.role}-${c.state}-${i}`}>
                    <TableCell className="text-foreground">{c.app}</TableCell>
                    <TableCell className="text-foreground-light">{c.role ?? '—'}</TableCell>
                    <TableCell className="text-foreground-light">{c.state}</TableCell>
                    <TableCell className="text-right tabular-nums text-foreground-light">{c.count}</TableCell>
                    <TableCell className="whitespace-nowrap text-foreground-light">{relativeTime(c.oldest)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="text-sm text-foreground">Largest tables</h2>
        <Card>
          {tables.error ? (
            <div className="p-4">
              <Alert variant="destructive" title={tables.error.message} />
            </div>
          ) : !tables.data ? (
            <Skeleton className="m-4 h-20" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Table</TableHead>
                  <TableHead className="text-right">Size</TableHead>
                  <TableHead className="text-right">Rows (est.)</TableHead>
                  <TableHead className="text-right whitespace-nowrap">Sequential scans</TableHead>
                  <TableHead className="text-right whitespace-nowrap">Index scans</TableHead>
                  <TableHead className="text-right whitespace-nowrap">Dead rows</TableHead>
                  <TableHead className="whitespace-nowrap">Last autovacuum</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tables.data.map((t) => (
                  <TableRow key={`${t.schema}.${t.name}`}>
                    <TableCell className="text-foreground">
                      <span className="text-foreground-lighter">{t.schema}.</span>
                      {t.name}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-foreground-light">{formatBytes(t.bytes)}</TableCell>
                    <TableCell className="text-right tabular-nums text-foreground-light">{t.rows.toLocaleString()}</TableCell>
                    <TableCell className="text-right tabular-nums text-foreground-light">{t.seq_scans?.toLocaleString() ?? '—'}</TableCell>
                    <TableCell className="text-right tabular-nums text-foreground-light">{t.index_scans?.toLocaleString() ?? '—'}</TableCell>
                    <TableCell className="text-right tabular-nums text-foreground-light">{t.dead_rows?.toLocaleString() ?? '—'}</TableCell>
                    <TableCell className="whitespace-nowrap text-foreground-light">{relativeTime(t.last_autovacuum)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
      </section>
    </DatabasePage>
  )
}

const pct = (v: number) => `${(v * 100).toFixed(v > 0.999 && v < 1 ? 2 : 1)}%`

function Stat({ label, value, hint, warn }: { label: string; value: string; hint?: string; warn?: boolean }) {
  return (
    <Card className="flex flex-col gap-1 p-4">
      <span className="text-xs text-foreground-lighter">{label}</span>
      <span className={warn ? 'text-2xl text-warning tabular-nums' : 'text-2xl text-foreground tabular-nums'}>{value}</span>
      {hint && <span className="text-xs text-foreground-lighter">{hint}</span>}
    </Card>
  )
}

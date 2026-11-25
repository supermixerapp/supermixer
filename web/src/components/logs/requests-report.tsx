/*
 * API requests over the last 24 hours, from the API gateway's logs: an hourly
 * bar chart (one series, so no legend), status counts and the busiest paths.
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { LogsOffAlert } from '@/components/logs/logs-off'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api, unwrap, type Schemas } from '@/lib/api/client'
import { useSelectedProject } from '@/lib/api/hooks'
import { useNow } from '@/lib/use-now'
import { cn } from '@/lib/utils'

type Stats = Schemas['RequestStats']
const HOUR = 3_600_000

export const requestStatsQuery = (ref: string, since: string) => ({
  queryKey: ['projects', ref, 'logs', 'requests', since],
  queryFn: () => unwrap(api.GET('/projects/{ref}/logs/requests', { params: { path: { ref }, query: { since } } })),
  refetchInterval: 60_000,
  // Keep the chart up while the window moves on to the next hour.
  placeholderData: keepPreviousData,
})

/** One slot per hour of the window, zero where nothing was logged. */
export function hourlySeries(hours: Stats['hours'], start: number, count: number) {
  const byHour = new Map(hours.map((h) => [Math.floor(new Date(h.hour).getTime() / HOUR), h]))
  const first = Math.floor(start / HOUR)
  return Array.from({ length: count }, (_, i) => {
    const h = byHour.get(first + i)
    return { at: (first + i) * HOUR, count: h?.count ?? 0, errors: h?.errors ?? 0 }
  })
}

export function RequestsReport({ projectRef }: { projectRef: string }) {
  // The window starts at the top of the hour, a day ago, and moves on with the clock.
  const now = useNow(60_000)
  const start = Math.floor((now - 23 * HOUR) / HOUR) * HOUR
  const stats = useQuery(requestStatsQuery(projectRef, new Date(start).toISOString()))
  const project = useSelectedProject()
  const s = stats.data

  if (stats.error) return <Alert variant="destructive" title={stats.error.message} />
  if (!s) return <Skeleton className="h-48" />
  if (!s.available && project?.stack?.logs === false)
    return <LogsOffAlert projectRef={projectRef}>The request reports come from the API gateway&apos;s logs.</LogsOffAlert>
  if (!s.available)
    return (
      <Alert title="Request reports need log analytics">
        They come from the API gateway&apos;s logs, which a self-hosted stack keeps only when it runs Logflare and Vector
        (docker-compose.logs.yml).
      </Alert>
    )

  const series = hourlySeries(s.hours, start, 24)
  const errors = series.reduce((n, h) => n + h.errors, 0)
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Requests, last 24 hours" value={s.total.toLocaleString()} />
        <Stat label="Errors (status 400 and above)" value={errors.toLocaleString()} hint={s.total ? `${((errors / s.total) * 100).toFixed(1)}% of requests` : undefined} />
        <Stat label="Busiest hour" value={Math.max(0, ...series.map((h) => h.count)).toLocaleString()} hint="requests" />
      </div>
      <Card className="p-4">
        <HourlyBars series={series} />
      </Card>
      <div className="grid gap-4 lg:grid-cols-[1fr_16rem]">
        <Card>
          <p className="border-b px-4 py-2 text-xs text-foreground-lighter">Busiest paths</p>
          {s.paths.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-foreground-lighter">No requests yet</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Path</TableHead>
                  <TableHead className="text-right">Requests</TableHead>
                  <TableHead className="text-right">Errors</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {s.paths.map((p) => (
                  <TableRow key={`${p.method} ${p.path}`}>
                    <TableCell className="max-w-md">
                      <span className="block truncate font-mono text-xs text-foreground" title={p.path}>
                        <span className="text-foreground-lighter">{p.method}</span> {p.path}
                      </span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-foreground-light">{p.count.toLocaleString()}</TableCell>
                    <TableCell className={cn('text-right tabular-nums', p.errors ? 'text-destructive' : 'text-foreground-light')}>{p.errors.toLocaleString()}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
        <Card>
          <p className="border-b px-4 py-2 text-xs text-foreground-lighter">Status codes</p>
          <ul className="divide-y">
            {s.statuses.map((st) => (
              <li key={st.status} className="flex items-center justify-between px-4 py-2 text-sm">
                <Badge variant={st.status >= 500 ? 'destructive' : st.status >= 400 ? 'warning' : 'success'}>{st.status || 'none'}</Badge>
                <span className="tabular-nums text-foreground-light">{st.count.toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  )
}

/** Thin bars, rounded at the data end, 2px apart; hover shows the hour. */
function HourlyBars({ series }: { series: { at: number; count: number; errors: number }[] }) {
  const [hover, setHover] = useState<number | null>(null)
  const max = Math.max(1, ...series.map((h) => h.count))
  const fmtHour = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const h = hover === null ? null : series[hover]
  return (
    <figure className="flex flex-col gap-2">
      <figcaption className="text-xs text-foreground-lighter">Requests per hour</figcaption>
      <div className="relative flex gap-2">
        <div className="flex h-40 w-10 shrink-0 flex-col justify-between text-right text-xs text-foreground-lighter tabular-nums" aria-hidden>
          <span>{max.toLocaleString()}</span>
          <span>0</span>
        </div>
        <div className="relative h-40 flex-1">
          {/* Recessive grid: top and middle lines; the baseline is the axis. */}
          <div className="absolute inset-x-0 top-0 border-t border-dashed border-border-muted" aria-hidden />
          <div className="absolute inset-x-0 top-1/2 border-t border-dashed border-border-muted" aria-hidden />
          <div className="absolute inset-x-0 bottom-0 border-t border-border-strong" aria-hidden />
          <div className="absolute inset-0 flex items-end gap-[2px]" onMouseLeave={() => setHover(null)}>
            {series.map((p, i) => (
              // The hit target is the full column, wider and taller than the bar.
              <div key={p.at} className="flex h-full flex-1 cursor-default items-end" onMouseEnter={() => setHover(i)} aria-label={`${fmtHour(p.at)}: ${p.count} requests, ${p.errors} errors`} role="img">
                <div
                  className={cn('w-full rounded-t-[4px] bg-[#4666ab] dark:bg-[#5b8af0]', hover !== null && hover !== i && 'opacity-60')}
                  style={{ height: p.count ? `${Math.max(2, (p.count / max) * 100)}%` : 0 }}
                />
              </div>
            ))}
          </div>
          {h && (
            <div
              className="pointer-events-none absolute -top-2 z-10 rounded-md border bg-alternative px-2 py-1 text-xs whitespace-nowrap shadow-sm"
              // Centred over the bar, but kept inside the chart at either end.
              style={{
                left: `${((hover! + 0.5) / series.length) * 100}%`,
                translate: `${hover! < series.length / 4 ? '-12px' : hover! >= (series.length * 3) / 4 ? 'calc(-100% + 12px)' : '-50%'} -100%`,
              }}
            >
              <span className="text-foreground-lighter">{fmtHour(h.at)}</span>{' '}
              <span className="text-foreground tabular-nums">{h.count.toLocaleString()} requests</span>
              {h.errors > 0 && <span className="text-foreground-light tabular-nums"> · {h.errors.toLocaleString()} errors</span>}
            </div>
          )}
        </div>
      </div>
      <div className="ml-12 flex justify-between text-xs text-foreground-lighter tabular-nums" aria-hidden>
        <span>{fmtHour(series[0]!.at)}</span>
        <span>{fmtHour(series[12]!.at)}</span>
        <span>{fmtHour(series[series.length - 1]!.at)}</span>
      </div>
      <details className="text-xs">
        <summary className="cursor-pointer text-foreground-light select-none">Show as a table</summary>
        <table className="mt-2 w-full text-left tabular-nums">
          <thead className="text-foreground-lighter">
            <tr>
              <th className="font-normal">Hour</th>
              <th className="text-right font-normal">Requests</th>
              <th className="text-right font-normal">Errors</th>
            </tr>
          </thead>
          <tbody className="text-foreground-light">
            {series.map((p) => (
              <tr key={p.at}>
                <td>{fmtHour(p.at)}</td>
                <td className="text-right">{p.count.toLocaleString()}</td>
                <td className="text-right">{p.errors.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string | undefined }) {
  return (
    <Card className="flex flex-col gap-1 p-4">
      <span className="text-xs text-foreground-lighter">{label}</span>
      <span className="text-2xl text-foreground tabular-nums">{value}</span>
      {hint && <span className="text-xs text-foreground-lighter">{hint}</span>}
    </Card>
  )
}

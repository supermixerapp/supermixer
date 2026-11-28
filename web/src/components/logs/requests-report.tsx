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
import { t, language } from '@/lib/i18n'

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
    return <LogsOffAlert projectRef={projectRef}>{t('observability:requestsReport.theRequestReportsComeFromThe')}</LogsOffAlert>
  if (!s.available)
    return (
      <Alert title={t('observability:requestsReport.requestReportsNeedLogAnalytics')}>
        {t('observability:requestsReport.theyComeFromTheApiGateway')}
      </Alert>
    )

  const series = hourlySeries(s.hours, start, 24)
  const errors = series.reduce((n, h) => n + h.errors, 0)
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label={t('observability:requestsReport.requestsLast24Hours')} value={s.total.toLocaleString(language())} />
        <Stat label={t('observability:requestsReport.errorsStatus400AndAbove')} value={errors.toLocaleString(language())} hint={s.total ? t('observability:requestsReport.ofRequests', { fixed: ((errors / s.total) * 100).toFixed(1) }) : undefined} />
        <Stat label={t('observability:requestsReport.busiestHour')} value={Math.max(0, ...series.map((h) => h.count)).toLocaleString(language())} hint={t('observability:requestsReport.requestsHint')} />
      </div>
      <Card className="p-4">
        <HourlyBars series={series} />
      </Card>
      <div className="grid gap-4 lg:grid-cols-[1fr_16rem]">
        <Card>
          <p className="border-b px-4 py-2 text-xs text-foreground-lighter">{t('observability:requestsReport.busiestPaths')}</p>
          {s.paths.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-foreground-lighter">{t('observability:requestsReport.noRequestsYet')}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{t('observability:requestsReport.path')}</TableHead>
                  <TableHead className="text-right">{t('observability:requestsReport.requests')}</TableHead>
                  <TableHead className="text-right">{t('observability:requestsReport.errors')}</TableHead>
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
                    <TableCell className="text-right tabular-nums text-foreground-light">{p.count.toLocaleString(language())}</TableCell>
                    <TableCell className={cn('text-right tabular-nums', p.errors ? 'text-destructive' : 'text-foreground-light')}>{p.errors.toLocaleString(language())}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
        <Card>
          <p className="border-b px-4 py-2 text-xs text-foreground-lighter">{t('observability:requestsReport.statusCodes')}</p>
          <ul className="divide-y">
            {s.statuses.map((st) => (
              <li key={st.status} className="flex items-center justify-between px-4 py-2 text-sm">
                <Badge variant={st.status >= 500 ? 'destructive' : st.status >= 400 ? 'warning' : 'success'}>{st.status || t('observability:requestsReport.noStatus')}</Badge>
                <span className="tabular-nums text-foreground-light">{st.count.toLocaleString(language())}</span>
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
      <figcaption className="text-xs text-foreground-lighter">{t('observability:requestsReport.requestsPerHour')}</figcaption>
      <div className="relative flex gap-2">
        <div className="flex h-40 w-10 shrink-0 flex-col justify-between text-right text-xs text-foreground-lighter tabular-nums" aria-hidden>
          <span>{max.toLocaleString(language())}</span>
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
              <span className="text-foreground tabular-nums">{t('observability:requestsReport.requests2', { value: h.count.toLocaleString(language()) })}</span>
              {h.errors > 0 && <span className="text-foreground-light tabular-nums"> {t('observability:requestsReport.errors2', { value: h.errors.toLocaleString(language()) })}</span>}
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
        <summary className="cursor-pointer text-foreground-light select-none">{t('observability:requestsReport.showAsATable')}</summary>
        <table className="mt-2 w-full text-left tabular-nums">
          <thead className="text-foreground-lighter">
            <tr>
              <th className="font-normal">{t('observability:requestsReport.hour')}</th>
              <th className="text-right font-normal">{t('observability:requestsReport.requests')}</th>
              <th className="text-right font-normal">{t('observability:requestsReport.errors')}</th>
            </tr>
          </thead>
          <tbody className="text-foreground-light">
            {series.map((p) => (
              <tr key={p.at}>
                <td>{fmtHour(p.at)}</td>
                <td className="text-right">{p.count.toLocaleString(language())}</td>
                <td className="text-right">{p.errors.toLocaleString(language())}</td>
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

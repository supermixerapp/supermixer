import { useMemo, useState } from 'react'

import { CopyIcon, DownloadIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { CellValue, Grid } from '@/components/ui/data-grid'
import { cn } from '@/lib/utils'
import type { QueryResponse, QueryResult, SqlError } from '@/lib/pg/run'

function toCsv(r: QueryResult): string {
  const esc = (v: unknown) => {
    if (v === null || v === undefined) return ''
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [r.columns.map((c) => esc(c.name)).join(','), ...r.rows.map((row) => row.map(esc).join(','))].join('\n')
}

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = Object.assign(document.createElement('a'), { href: url, download: name })
  a.click()
  URL.revokeObjectURL(url)
}

function summary(r: QueryResult): string {
  if (r.columns.length > 0) return `${r.row_count} row${r.row_count === 1 ? '' : 's'}`
  if (['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'COPY'].includes(r.command)) {
    return `${r.command}: ${r.row_count} row${r.row_count === 1 ? '' : 's'} affected`
  }
  return r.command || 'Done'
}

export function ResultTable({ result }: { result: QueryResult }) {
  const columns = useMemo(
    () =>
      result.columns.map((c, i) => ({
        key: String(i),
        name: c.name,
        resizable: true,
        minWidth: 80,
        renderHeaderCell: () => (
          <span className="flex items-baseline gap-1.5 truncate">
            <span className="text-foreground">{c.name}</span>
            <span className="truncate font-mono text-[11px] text-foreground-lighter">{c.type}</span>
          </span>
        ),
        renderCell: ({ row }: { row: unknown[] }) => <CellValue value={row[i]} />,
      })),
    [result]
  )
  return <Grid columns={columns} rows={result.rows as unknown[][]} className="h-full" />
}

/** The panel under the SQL editor: results, errors, notices. */
export function ResultsPanel({
  response,
  error,
  running,
}: {
  response?: QueryResponse
  error?: SqlError | Error | null
  running?: boolean
}) {
  // null = the last statement, which is what Studio shows after a run.
  const [tab, setTab] = useState<number | null>(null)
  const results = response?.results ?? []
  const index = tab === null ? results.length - 1 : Math.min(tab, results.length - 1)
  const current = results[index]

  if (running && !response) {
    return <Empty>Running…</Empty>
  }
  if (error) {
    const e = error as SqlError
    return (
      <div className="h-full overflow-auto p-4 font-mono text-xs leading-5">
        <p className="text-destructive">
          ERROR: {e.code ? `${e.code}: ` : ''}
          {e.message}
        </p>
        {e.detail && <p className="text-foreground-light">DETAIL: {e.detail}</p>}
        {e.hint && <p className="text-foreground-light">HINT: {e.hint}</p>}
      </div>
    )
  }
  if (!response) return <Empty>Click Run or press ⌘↵ to execute your query.</Empty>

  return (
    <div className="flex h-full min-h-0 flex-col">
      {results.length > 1 && (
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b px-2 py-1">
          {results.map((r, i) => (
            <button
              key={i}
              onClick={() => setTab(i)}
              className={cn(
                'rounded px-2 py-0.5 text-xs whitespace-nowrap',
                i === index ? 'bg-surface-300 text-foreground' : 'text-foreground-lighter hover:text-foreground'
              )}
            >
              {i + 1}. {r.command || 'Statement'}
            </button>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1">
        {current && current.columns.length > 0 ? (
          <ResultTable result={current} />
        ) : (
          <Empty>Success. {current ? summary(current) : 'No rows returned'}.</Empty>
        )}
      </div>
      {current?.notices && current.notices.length > 0 && (
        <div className="max-h-24 shrink-0 overflow-auto border-t px-4 py-2 font-mono text-xs text-foreground-light">
          {current.notices.map((n, i) => (
            <p key={i}>{n}</p>
          ))}
        </div>
      )}
      <div className="flex shrink-0 items-center gap-3 border-t px-3 py-1.5 text-xs text-foreground-lighter">
        <span>{current ? summary(current) : ''}</span>
        {current?.truncated && (
          <span className="text-warning">Showing the first {current.rows.length} rows</span>
        )}
        {response.read_only && <span>read-only</span>}
        <span className="ml-auto">{response.duration_ms} ms</span>
        {current && current.columns.length > 0 && (
          <>
            <Button
              variant="text"
              size="tiny"
              icon={<CopyIcon />}
              onClick={() => {
                const rows = current.rows.map((r) => Object.fromEntries(current.columns.map((c, i) => [c.name, r[i]])))
                void navigator.clipboard.writeText(JSON.stringify(rows, null, 2))
              }}
            >
              Copy as JSON
            </Button>
            <Button variant="text" size="tiny" icon={<DownloadIcon />} onClick={() => download('results.csv', toCsv(current), 'text/csv')}>
              CSV
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center p-4 text-sm text-foreground-lighter">{children}</div>
}

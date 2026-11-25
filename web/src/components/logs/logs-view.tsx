/*
 * A log collection (or the explorer across all of them): newest entries
 * first, filtered by time and text, from the stack's Logflare tables.
 */
import { useInfiniteQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { DatabasePage, SearchBox } from '@/components/database/catalog-page'
import { RefreshIcon } from '@/components/icons'
import { LogsOffAlert } from '@/components/logs/logs-off'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { CodeBlock } from '@/components/ui/code-block'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetSection, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { api, unwrap } from '@/lib/api/client'
import { useSelectedProject } from '@/lib/api/hooks'
import { levelOf, requestOf, SOURCE_LABELS, TIME_RANGES, type LogEntry, type LogSource } from '@/lib/logs'
import { cn } from '@/lib/utils'

const PAGE = 100

export function LogsView({
  projectRef,
  title,
  description,
  source: fixedSource,
  search: fixedSearch,
}: {
  projectRef: string
  title: string
  description: string
  /** A collection's source; the explorer lets you pick one. */
  source?: LogSource
  /** Text every entry must contain (Cron's lines in the Postgres log). */
  search?: string
}) {
  const [picked, setPicked] = useState<LogSource>('api_gateway')
  const source = fixedSource ?? picked
  const [minutes, setMinutes] = useState(60)
  const [typed, setTyped] = useState('')
  const [search, setSearch] = useState('')
  // The end of the time window: set when the page opens and on refresh.
  const [until, setUntil] = useState(() => Date.now())
  const [open, setOpen] = useState<LogEntry | null>(null)

  useEffect(() => {
    const t = setTimeout(() => setSearch(typed.trim()), 300)
    return () => clearTimeout(t)
  }, [typed])

  const since = new Date(until - minutes * 60_000).toISOString()
  // The server matches every word, in any order.
  const text = [fixedSearch, search].filter(Boolean).join(' ')
  const logs = useInfiniteQuery({
    queryKey: ['projects', projectRef, 'logs', source, since, text],
    queryFn: ({ pageParam, signal }) =>
      unwrap(
        api.GET('/projects/{ref}/logs', {
          params: {
            path: { ref: projectRef },
            query: { source, since, limit: PAGE, ...(text && { search: text }), ...(pageParam && { before: pageParam.before, before_id: pageParam.id }) },
          },
          signal,
        })
      ),
    initialPageParam: null as { before: string; id: string } | null,
    // Continue after the last entry shown, by time then id: entries that
    // share its timestamp come on the next page instead of being skipped.
    getNextPageParam: (last) => {
      const e = last.entries[last.entries.length - 1]
      return last.entries.length === PAGE && e ? { before: e.timestamp, id: e.id } : undefined
    },
  })
  const entries = logs.data?.pages.flatMap((p) => p.entries) ?? []
  const available = logs.data?.pages[0]?.available ?? true
  const project = useSelectedProject()

  return (
    <DatabasePage
      title={title}
      description={description}
      toolbar={
        <>
          {!fixedSource && (
            <Select value={picked} onValueChange={(v) => setPicked(v as LogSource)}>
              <SelectTrigger size="tiny" className="w-44" aria-label="Source">
                <span className="text-foreground-lighter">source</span>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(SOURCE_LABELS).map(([k, label]) => (
                  <SelectItem key={k} value={k}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Select
            value={String(minutes)}
            onValueChange={(v) => {
              setMinutes(Number(v))
              setUntil(Date.now())
            }}
          >
            <SelectTrigger size="tiny" className="w-40" aria-label="Time range">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TIME_RANGES.map((r) => (
                <SelectItem key={r.minutes} value={String(r.minutes)}>
                  {r.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <SearchBox value={typed} onChange={setTyped} placeholder="Search messages" />
          <Button variant="default" size="tiny" icon={<RefreshIcon />} loading={logs.isFetching && !logs.isFetchingNextPage} onClick={() => setUntil(Date.now())}>
            Refresh
          </Button>
        </>
      }
    >
      {logs.error ? (
        <Alert variant="destructive" title={logs.error.message} />
      ) : !available && project?.stack?.logs === false ? (
        <LogsOffAlert projectRef={projectRef} />
      ) : !available ? (
        <Alert title="This stack doesn't run log analytics">
          Supabase collects logs with Vector and stores them with Logflare, which the self-hosted stack only starts with
          docker-compose.logs.yml. Start the stack with that file, and logs appear here.
        </Alert>
      ) : (
        <Card>
          {logs.isPending ? (
            <div className="flex flex-col gap-2 p-4">
              <Skeleton className="h-5" />
              <Skeleton className="h-5" />
              <Skeleton className="h-5" />
            </div>
          ) : entries.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-foreground-lighter">No log entries in this time range{text && ' that match'}</p>
          ) : (
            <ul className="divide-y">
              {entries.map((e) => (
                <EntryRow key={e.id} entry={e} onOpen={() => setOpen(e)} />
              ))}
            </ul>
          )}
          {logs.hasNextPage && (
            <div className="border-t px-4 py-2">
              <Button variant="default" size="tiny" loading={logs.isFetchingNextPage} onClick={() => void logs.fetchNextPage()}>
                Load older entries
              </Button>
            </div>
          )}
        </Card>
      )}
      <Sheet open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        <SheetContent size="xl" className="flex flex-col">
          {open && (
            <>
              <SheetHeader>
                <SheetTitle>Log entry</SheetTitle>
                <SheetDescription>{new Date(open.timestamp).toLocaleString()}</SheetDescription>
              </SheetHeader>
              <div className="flex-1 overflow-y-auto">
                <SheetSection className="flex flex-col gap-3">
                  <pre className="overflow-x-auto rounded-md border bg-surface-100 p-3 font-mono text-xs whitespace-pre-wrap text-foreground">{open.message}</pre>
                  <CodeBlock code={JSON.stringify(open.metadata, null, 2)} />
                </SheetSection>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </DatabasePage>
  )
}

function EntryRow({ entry, onOpen }: { entry: LogEntry; onOpen: () => void }) {
  const req = requestOf(entry)
  const level = levelOf(entry)
  const bad = (req?.status ?? 0) >= 400 || level === 'error' || level === 'fatal' || level === 'panic'
  return (
    <li>
      <button className="flex w-full items-center gap-3 px-4 py-1.5 text-left hover:bg-surface-200" onClick={onOpen}>
        <span className="w-40 shrink-0 font-mono text-xs text-foreground-lighter tabular-nums">{new Date(entry.timestamp).toLocaleString()}</span>
        {req ? (
          <>
            <Badge variant={req.status === null ? 'default' : req.status >= 400 ? 'destructive' : 'success'}>{req.status ?? '—'}</Badge>
            <span className="w-14 shrink-0 font-mono text-xs text-foreground-light">{req.method}</span>
            <span className="truncate font-mono text-xs text-foreground">{req.path}</span>
          </>
        ) : (
          <>
            {level && <Badge variant={bad ? 'destructive' : level.startsWith('warn') ? 'warning' : 'default'}>{level}</Badge>}
            <span className={cn('truncate font-mono text-xs', bad ? 'text-destructive' : 'text-foreground')}>{entry.message}</span>
          </>
        )}
      </button>
    </li>
  )
}

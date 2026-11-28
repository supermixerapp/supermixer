import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'

import { DatabasePage, SearchBox } from '@/components/database/catalog-page'
import { RefreshIcon } from '@/components/icons'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { CodeBlock } from '@/components/ui/code-block'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetSection, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { AUDIT_ACTIONS_SQL, AUDIT_LOG_SQL, auditActionLabel, containsPattern, relativeTime, type AuditEntry } from '@/lib/auth-users'
import { pgQuery, usePg } from '@/lib/pg/run'
import { t as tr, language } from '@/lib/i18n'

export const Route = createFileRoute('/_app/project/$ref/auth/audit-logs')({
  component: AuthAuditLogsPage,
})

const PAGE_SIZE = 50
const ALL = '__all__'

function AuthAuditLogsPage() {
  const { ref } = Route.useParams()
  const [typed, setTyped] = useState('')
  const [search, setSearch] = useState('')
  const [action, setAction] = useState(ALL)
  const [page, setPage] = useState(0)
  const [open, setOpen] = useState<AuditEntry | null>(null)

  useEffect(() => {
    const next = typed.trim()
    if (next === search) return
    const t = setTimeout(() => {
      setSearch(next)
      setPage(0)
    }, 300)
    return () => clearTimeout(t)
  }, [typed, search])

  const actions = usePg<{ action: string }>(ref, ['auth-audit-actions'], AUDIT_ACTIONS_SQL)
  const entries = useQuery({
    ...pgQuery<AuditEntry>(ref, ['auth-audit', action, search, page], AUDIT_LOG_SQL, [
      action === ALL ? '' : action,
      search ? containsPattern(search) : '',
      String(PAGE_SIZE),
      String(page * PAGE_SIZE),
    ]),
    placeholderData: keepPreviousData,
  })
  const rows = entries.data ?? []
  const total = rows[0]?.total ?? 0
  const from = page * PAGE_SIZE

  return (
    <DatabasePage
      title={tr('authentication:authAuditLogs.auditLogs')}
      description={tr('authentication:authAuditLogs.whatHappenedInAuthSignUps')}
      toolbar={
        <>
          <SearchBox value={typed} onChange={setTyped} placeholder={tr('authentication:authAuditLogs.searchEmailUserIdOrIp')} />
          <Select
            value={action}
            onValueChange={(v) => {
              setAction(v)
              setPage(0)
            }}
          >
            <SelectTrigger size="tiny" className="w-48" aria-label={tr('authentication:authAuditLogs.action')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{tr('authentication:authAuditLogs.allActions')}</SelectItem>
              {(actions.data ?? []).map((a) => (
                <SelectItem key={a.action} value={a.action}>
                  {auditActionLabel(a.action)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="default" size="tiny" icon={<RefreshIcon />} loading={entries.isFetching && !entries.isPending} onClick={() => void entries.refetch()}>
            {tr('authentication:authAuditLogs.refresh')}
          </Button>
        </>
      }
    >
      {entries.error ? (
        <Alert variant="destructive" title={entries.error.message} />
      ) : (
        <Card>
          {entries.isPending ? (
            <div className="flex flex-col gap-2 p-4">
              <Skeleton className="h-6" />
              <Skeleton className="h-6" />
              <Skeleton className="h-6" />
            </div>
          ) : rows.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-foreground-lighter">
              {search || action !== ALL
                ? tr('authentication:authAuditLogs.noEntriesMatch')
                : tr('authentication:authAuditLogs.noAuditEntriesYetIfAuth')}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="whitespace-nowrap">{tr('authentication:authAuditLogs.time')}</TableHead>
                  <TableHead>{tr('authentication:authAuditLogs.action')}</TableHead>
                  <TableHead>{tr('authentication:authAuditLogs.actor')}</TableHead>
                  <TableHead>{tr('authentication:authAuditLogs.user')}</TableHead>
                  <TableHead>{tr('authentication:authAuditLogs.ipAddress')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((e) => (
                  <TableRow
                    key={e.id}
                    className="cursor-pointer"
                    tabIndex={0}
                    onClick={() => setOpen(e)}
                    onKeyDown={(ev) => {
                      if (ev.key === 'Enter' || ev.key === ' ') {
                        ev.preventDefault()
                        setOpen(e)
                      }
                    }}
                  >
                    <TableCell className="whitespace-nowrap text-foreground-light" title={new Date(e.created_at).toLocaleString(language())}>
                      {relativeTime(e.created_at)}
                    </TableCell>
                    <TableCell>
                      <Badge>{auditActionLabel(e.action)}</Badge>
                    </TableCell>
                    <TableCell className="text-foreground-light">{e.actor || '—'}</TableCell>
                    <TableCell className="text-foreground">{traitText(e.traits, 'user_email') ?? traitText(e.traits, 'user_phone') ?? '—'}</TableCell>
                    <TableCell className="font-mono text-xs text-foreground-light">{e.ip_address || '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {(total > 0 || page > 0) && (
            <div className="flex items-center gap-2 border-t px-4 py-2 text-xs text-foreground-light">
              <span>{rows.length > 0 && tr('authentication:authAuditLogs.of', { from: from + 1, from2: from + rows.length, value: total.toLocaleString(language()) })}</span>
              <span className="ml-auto flex gap-1">
                <Button variant="default" size="tiny" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                  {tr('authentication:authAuditLogs.previous')}
                </Button>
                <Button variant="default" size="tiny" disabled={from + rows.length >= total} onClick={() => setPage((p) => p + 1)}>
                  {tr('authentication:authAuditLogs.next')}
                </Button>
              </span>
            </div>
          )}
        </Card>
      )}
      <Sheet open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        <SheetContent size="lg">
          {open && (
            <>
              <SheetHeader>
                <SheetTitle>{auditActionLabel(open.action)}</SheetTitle>
                <SheetDescription>{new Date(open.created_at).toLocaleString(language())}</SheetDescription>
              </SheetHeader>
              <SheetSection>
                <CodeBlock
                  code={JSON.stringify(
                    { action: open.action, actor: open.actor, actor_id: open.actor_id, log_type: open.log_type, ip_address: open.ip_address || null, traits: open.traits },
                    null,
                    2
                  )}
                />
              </SheetSection>
            </>
          )}
        </SheetContent>
      </Sheet>
    </DatabasePage>
  )
}

function traitText(traits: Record<string, unknown> | null, key: string): string | undefined {
  const v = traits?.[key]
  return typeof v === 'string' && v ? v : undefined
}

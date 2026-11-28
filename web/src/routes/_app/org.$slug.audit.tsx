import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'

import { PageContainer, PageHeader } from '@/components/layout/page'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { can, useSelectedOrganization } from '@/lib/api/hooks'
import { auditActorsQuery, auditLogsQuery } from '@/lib/api/queries'
import { localized, t, language } from '@/lib/i18n'

export const Route = createFileRoute('/_app/org/$slug/audit')({
  component: AuditPage,
})

const ACTIONS = localized(() => [
  { value: 'all', label: t('org:audit.allActions') },
  { value: 'organization.', label: t('org:audit.organization') },
  { value: 'project.', label: t('org:audit.projects') },
  { value: 'project.database_role_', label: t('org:audit.databaseLogins') },
  { value: 'member.', label: t('org:audit.members') },
  { value: 'invitation.', label: t('org:audit.invitations') },
])
const RANGES = localized(() => [
  { value: 'all', label: t('org:audit.allTime') },
  { value: '1', label: t('org:audit.last24Hours') },
  { value: '7', label: t('org:audit.last7Days') },
  { value: '30', label: t('org:audit.last30Days') },
])

function AuditPage() {
  const { slug } = Route.useParams()
  const org = useSelectedOrganization()
  const allowed = can(org, 'audit:read')
  const [action, setAction] = useState('all')
  const [actor, setActor] = useState('all')
  const [range, setRange] = useState('7')
  // Rounded to the minute so the query key is stable between renders.
  const [since] = useState(() => Math.floor(Date.now() / 60000) * 60000)

  const filters = {
    action: action === 'all' ? undefined : action,
    actor_id: actor === 'all' ? undefined : actor,
    since: range === 'all' ? undefined : new Date(since - Number(range) * 86400000).toISOString(),
  }
  const logs = useInfiniteQuery({ ...auditLogsQuery(slug, filters), enabled: allowed })
  // Not just current members: someone who left can still be looked up.
  const actors = useQuery({ ...auditActorsQuery(slug), enabled: allowed })
  const entries = logs.data?.pages.flatMap((p) => p.entries) ?? []

  return (
    <>
      <PageHeader
        title={t('org:audit.auditLogs')}
        description={t('org:audit.everyChangeMadeInThisOrganization')}
        size="large"
      />
      <PageContainer size="large" className="flex flex-col gap-4 pb-16">
        {!allowed ? (
          <Alert variant="warning" title={t('org:audit.youNeedAdditionalPermissionsToView')}>
            {t('org:audit.onlyOwnersAndAdministratorsCanSee')}
          </Alert>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              <FilterSelect value={action} onChange={setAction} options={ACTIONS()} />
              <FilterSelect
                value={actor}
                onChange={setActor}
                options={[
                  { value: 'all', label: t('org:audit.everyone') },
                  ...(actors.data ?? []).map((a) => ({
                    value: a.id,
                    label: a.member ? a.username : t('org:audit.noLongerAMember', { username: a.username }),
                  })),
                ]}
              />
              <FilterSelect value={range} onChange={setRange} options={RANGES()} />
            </div>
            <Card>
              {logs.isPending ? (
                <div className="flex flex-col gap-2 p-4">
                  <Skeleton className="h-6" />
                  <Skeleton className="h-6" />
                </div>
              ) : entries.length === 0 ? (
                <p className="px-4 py-10 text-center text-sm text-foreground-lighter">{t('org:audit.noEntriesMatchTheseFilters')}</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>{t('org:audit.time')}</TableHead>
                      <TableHead>{t('org:audit.action')}</TableHead>
                      <TableHead>{t('org:audit.target')}</TableHead>
                      <TableHead>{t('org:audit.actor')}</TableHead>
                      <TableHead>{t('org:audit.ipAddress')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {entries.map((e) => (
                      <TableRow key={e.id}>
                        <TableCell className="whitespace-nowrap text-foreground-light">
                          {new Date(e.created_at).toLocaleString(language())}
                        </TableCell>
                        <TableCell>
                          <Badge>{e.action}</Badge>
                        </TableCell>
                        <TableCell>
                          <span className="text-foreground">{e.target_name || e.target_id}</span>
                          {Object.keys(e.metadata).length > 0 && (
                            <span className="block max-w-md truncate font-mono text-[11px] text-foreground-lighter">
                              {JSON.stringify(e.metadata)}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-foreground-light">{e.actor_username || '—'}</TableCell>
                        <TableCell className="font-mono text-xs text-foreground-lighter">{e.ip}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </Card>
            {logs.hasNextPage && (
              <Button variant="default" className="self-center" loading={logs.isFetchingNextPage} onClick={() => logs.fetchNextPage()}>
                {t('org:audit.loadOlderEntries')}
              </Button>
            )}
          </>
        )}
      </PageContainer>
    </>
  )
}

function FilterSelect({
  value,
  onChange,
  options,
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger size="tiny" className="w-44">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

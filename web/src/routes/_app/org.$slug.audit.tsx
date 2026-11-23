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
import { auditLogsQuery, membersQuery } from '@/lib/api/queries'

export const Route = createFileRoute('/_app/org/$slug/audit')({
  component: AuditPage,
})

const ACTIONS = [
  { value: 'all', label: 'All actions' },
  { value: 'organization.', label: 'Organization' },
  { value: 'project.', label: 'Projects' },
  { value: 'member.', label: 'Members' },
  { value: 'invitation.', label: 'Invitations' },
]
const RANGES = [
  { value: 'all', label: 'All time' },
  { value: '1', label: 'Last 24 hours' },
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
]

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
  const members = useQuery({ ...membersQuery(slug), enabled: allowed })
  const entries = logs.data?.pages.flatMap((p) => p.entries) ?? []

  return (
    <>
      <PageHeader
        title="Audit Logs"
        description="Every change made in this organization: who did it, when and from where."
        size="large"
      />
      <PageContainer size="large" className="flex flex-col gap-4 pb-16">
        {!allowed ? (
          <Alert variant="warning" title="You need additional permissions to view audit logs">
            Only Owners and Administrators can see this organization&apos;s audit logs.
          </Alert>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              <FilterSelect value={action} onChange={setAction} options={ACTIONS} />
              <FilterSelect
                value={actor}
                onChange={setActor}
                options={[
                  { value: 'all', label: 'All members' },
                  ...(members.data ?? []).map((m) => ({ value: m.user_id, label: m.username })),
                ]}
              />
              <FilterSelect value={range} onChange={setRange} options={RANGES} />
            </div>
            <Card>
              {logs.isPending ? (
                <div className="flex flex-col gap-2 p-4">
                  <Skeleton className="h-6" />
                  <Skeleton className="h-6" />
                </div>
              ) : entries.length === 0 ? (
                <p className="px-4 py-10 text-center text-sm text-foreground-lighter">No entries match these filters.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Time</TableHead>
                      <TableHead>Action</TableHead>
                      <TableHead>Target</TableHead>
                      <TableHead>Actor</TableHead>
                      <TableHead>IP address</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {entries.map((e) => (
                      <TableRow key={e.id}>
                        <TableCell className="whitespace-nowrap text-foreground-light">
                          {new Date(e.created_at).toLocaleString()}
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
                Load older entries
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

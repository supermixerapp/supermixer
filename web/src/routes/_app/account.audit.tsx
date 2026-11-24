/*
 * Account › Audit Logs: what you did, in any organization or outside them,
 * and what others (instance admins) did to your account.
 */
import { infiniteQueryOptions, useInfiniteQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'

import { AccountLayout } from '@/components/layout/account-layout'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api, unwrap } from '@/lib/api/client'
import { useProfile } from '@/lib/api/hooks'

export const Route = createFileRoute('/_app/account/audit')({
  component: AccountAuditPage,
})

const myAuditQuery = infiniteQueryOptions({
  queryKey: ['profile', 'audit-logs'],
  queryFn: ({ pageParam }) => unwrap(api.GET('/profile/audit-logs', { params: { query: { before: pageParam, limit: 50 } } })),
  initialPageParam: undefined as number | undefined,
  getNextPageParam: (last) => last.next_before ?? undefined,
})

function AccountAuditPage() {
  const { data: me } = useProfile()
  const logs = useInfiniteQuery(myAuditQuery)
  const entries = logs.data?.pages.flatMap((p) => p.entries) ?? []
  return (
    <AccountLayout title="Audit Logs">
      <p className="-mt-4 mb-6 text-sm text-foreground-light">
        What you did, in any organization, and changes others made to your account. Entries by others don&apos;t show
        their IP address.
      </p>
      <Card>
        {logs.isPending ? (
          <div className="flex flex-col gap-2 p-4">
            <Skeleton className="h-6" />
            <Skeleton className="h-6" />
          </div>
        ) : logs.isError ? (
          <p className="px-4 py-10 text-center text-sm text-destructive">{logs.error.message}</p>
        ) : entries.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-foreground-lighter">Nothing recorded yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Time</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>Where</TableHead>
                  <TableHead>By</TableHead>
                  <TableHead>IP address</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="whitespace-nowrap text-foreground-light">{new Date(e.created_at).toLocaleString()}</TableCell>
                    <TableCell>
                      <Badge>{e.action}</Badge>
                    </TableCell>
                    <TableCell>
                      <span className="text-foreground">{e.target_name || e.target_id}</span>
                      {Object.keys(e.metadata).length > 0 && (
                        <span className="block max-w-xs truncate font-mono text-[11px] text-foreground-lighter">
                          {JSON.stringify(e.metadata)}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-foreground-light">
                      {e.organization_slug ? (
                        <Link to="/org/$slug" params={{ slug: e.organization_slug }} className="hover:text-foreground">
                          {e.organization_slug}
                        </Link>
                      ) : (
                        'Account'
                      )}
                    </TableCell>
                    <TableCell className="text-foreground-light">
                      {e.actor_id && e.actor_id === me?.id ? 'You' : e.actor_username || '—'}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-foreground-lighter">{e.ip || '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>
      {logs.hasNextPage && (
        <Button variant="default" className="mt-4 self-center" loading={logs.isFetchingNextPage} onClick={() => logs.fetchNextPage()}>
          Load older entries
        </Button>
      )}
    </AccountLayout>
  )
}

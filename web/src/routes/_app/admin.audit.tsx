/*
 * Instance › Audit log: what happened outside any organization (accounts,
 * passwords, sign-outs), for instance admins.
 */
import { infiniteQueryOptions, useInfiniteQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'

import { AdminLayout } from '@/components/layout/admin-layout'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api, unwrap } from '@/lib/api/client'
import { useProfile } from '@/lib/api/hooks'

export const Route = createFileRoute('/_app/admin/audit')({
  component: InstanceAuditPage,
})

const instanceAuditQuery = infiniteQueryOptions({
  queryKey: ['admin', 'audit-logs'],
  queryFn: ({ pageParam }) => unwrap(api.GET('/admin/audit-logs', { params: { query: { before: pageParam, limit: 50 } } })),
  initialPageParam: undefined as number | undefined,
  getNextPageParam: (last) => last.next_before ?? undefined,
})

function InstanceAuditPage() {
  const { data: me } = useProfile()
  const logs = useInfiniteQuery({ ...instanceAuditQuery, enabled: !!me?.is_instance_admin })
  const entries = logs.data?.pages.flatMap((p) => p.entries) ?? []
  return (
    <AdminLayout
      title="Audit log"
      description="Sign-ins and changes to accounts: users added, changed or disabled, passwords changed or reset, sessions signed out. Each organization's own changes are in its Audit Logs."
    >
      <Card>
        {logs.isPending ? (
          <div className="flex flex-col gap-2 p-4">
            <Skeleton className="h-6" />
            <Skeleton className="h-6" />
          </div>
        ) : entries.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-foreground-lighter">Nothing recorded yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Time</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Account</TableHead>
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
    </AdminLayout>
  )
}

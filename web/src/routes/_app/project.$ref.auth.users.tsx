import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'

import { AddUserDialog, UserSheet } from '@/components/auth/users'
import { DatabasePage, SearchBox, useCanChange } from '@/components/database/catalog-page'
import { ChevronDownIcon, MailIcon, PersonAddIcon, RefreshIcon } from '@/components/icons'
import { PermissionButton } from '@/components/permission-button'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  containsPattern,
  isBanned,
  isConfirmed,
  relativeTime,
  usersSql,
  type UserFilter,
  type UserListRow,
  type UserSort,
} from '@/lib/auth-users'
import { pgQuery } from '@/lib/pg/run'

export const Route = createFileRoute('/_app/project/$ref/auth/users')({
  component: UsersPage,
})

const PAGE_SIZE = 50

const FILTER_LABELS: Record<UserFilter, string> = {
  all: 'All users',
  verified: 'Verified',
  unverified: 'Unverified',
  anonymous: 'Anonymous',
}

const SORT_LABELS: Record<string, string> = {
  'created_at:desc': 'Newest first',
  'created_at:asc': 'Oldest first',
  'last_sign_in_at:desc': 'Recently signed in',
  'email:asc': 'Email A–Z',
}

function UsersPage() {
  const { ref } = Route.useParams()
  const canChange = useCanChange()
  const [typed, setTyped] = useState('')
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<UserFilter>('all')
  const [sortKey, setSortKey] = useState('created_at:desc')
  const [page, setPage] = useState(0)
  const [openUser, setOpenUser] = useState<string | null>(null)
  const [adding, setAdding] = useState<'create' | 'invite' | null>(null)

  // Search once typing pauses, and start again from the first page, but only
  // when the search really changed (not for an added space).
  useEffect(() => {
    const next = typed.trim()
    if (next === search) return
    const t = setTimeout(() => {
      setSearch(next)
      setPage(0)
    }, 300)
    return () => clearTimeout(t)
  }, [typed, search])

  const [sort, dir] = sortKey.split(':') as [UserSort, 'asc' | 'desc']
  const users = useQuery({
    ...pgQuery<UserListRow>(ref, ['auth-users', filter, sortKey, search, page], usersSql(filter, sort, dir === 'desc'), [
      search,
      containsPattern(search),
      String(PAGE_SIZE),
      String(page * PAGE_SIZE),
    ]),
    placeholderData: keepPreviousData,
  })
  const rows = users.data ?? []
  const total = rows[0]?.total ?? 0
  const from = page * PAGE_SIZE
  // A page that came back empty (its last user was deleted): step back one.
  if (page > 0 && users.data && users.data.length === 0 && !users.isPlaceholderData && !users.isFetching) setPage(page - 1)

  return (
    <DatabasePage
      title="Users"
      description="Everyone who has signed up to this project, from Auth's own tables."
      toolbar={
        <>
          <SearchBox value={typed} onChange={setTyped} placeholder="Search email, phone, name or ID" />
          <Select
            value={filter}
            onValueChange={(v) => {
              setFilter(v as UserFilter)
              setPage(0)
            }}
          >
            <SelectTrigger size="tiny" className="w-36" aria-label="Filter users">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(FILTER_LABELS).map(([v, label]) => (
                <SelectItem key={v} value={v}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={sortKey}
            onValueChange={(v) => {
              setSortKey(v)
              setPage(0)
            }}
          >
            <SelectTrigger size="tiny" className="w-44" aria-label="Sort users">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(SORT_LABELS).map(([v, label]) => (
                <SelectItem key={v} value={v}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="default" size="tiny" icon={<RefreshIcon />} loading={users.isFetching && !users.isPending} onClick={() => void users.refetch()}>
            Refresh
          </Button>
        </>
      }
      actions={
        canChange ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="primary" iconRight={<ChevronDownIcon />}>
                Add user
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem onSelect={() => setAdding('invite')}>
                <MailIcon size={16} /> Send invitation
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setAdding('create')}>
                <PersonAddIcon size={16} /> Create new user
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <PermissionButton allowed={false} action="add users" variant="primary">
            Add user
          </PermissionButton>
        )
      }
    >
      {users.error ? (
        <Alert variant="destructive" title={users.error.message} />
      ) : (
        <Card>
          {users.isPending ? (
            <div className="flex flex-col gap-2 p-4">
              <Skeleton className="h-6" />
              <Skeleton className="h-6" />
              <Skeleton className="h-6" />
            </div>
          ) : rows.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-foreground-lighter">
              {page > 0
                ? 'No users on this page'
                : search || filter !== 'all'
                  ? 'No users match'
                  : 'No users yet. Users appear here when they sign up, or when you add them.'}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>User</TableHead>
                  <TableHead>Providers</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="whitespace-nowrap">Created</TableHead>
                  <TableHead className="whitespace-nowrap">Last signed in</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((u) => (
                  <TableRow
                    key={u.id}
                    className="cursor-pointer"
                    tabIndex={0}
                    aria-label={`Open ${u.email ?? u.phone ?? u.id}`}
                    onClick={() => setOpenUser(u.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        setOpenUser(u.id)
                      }
                    }}
                  >
                    <TableCell>
                      <span className="flex flex-col">
                        <span className="text-foreground">{u.email ?? u.phone ?? (u.anonymous ? 'Anonymous user' : '—')}</span>
                        <span className="font-mono text-xs text-foreground-lighter">
                          {u.display_name ? `${u.display_name} · ` : ''}
                          {u.id.slice(0, 8)}…
                        </span>
                      </span>
                    </TableCell>
                    <TableCell className="text-foreground-light">{u.providers.join(', ') || (u.anonymous ? 'anonymous' : '—')}</TableCell>
                    <TableCell>
                      <span className="flex flex-wrap gap-1">
                        {isBanned(u) && <Badge variant="destructive">Banned</Badge>}
                        {u.anonymous ? (
                          <Badge>Anonymous</Badge>
                        ) : isConfirmed(u) ? null : (
                          <Badge variant="warning">{u.invited_at ? 'Invited' : 'Unverified'}</Badge>
                        )}
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-foreground-light" title={new Date(u.created_at).toLocaleString()}>
                      {relativeTime(u.created_at)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-foreground-light">{relativeTime(u.last_sign_in_at)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {(total > 0 || page > 0) && (
            <div className="flex items-center gap-2 border-t px-4 py-2 text-xs text-foreground-light">
              <span>{rows.length > 0 && `${from + 1}–${from + rows.length} of ${total.toLocaleString()} user${total === 1 ? '' : 's'}`}</span>
              <span className="ml-auto flex gap-1">
                <Button variant="default" size="tiny" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                  Previous
                </Button>
                <Button variant="default" size="tiny" disabled={from + rows.length >= total} onClick={() => setPage((p) => p + 1)}>
                  Next
                </Button>
              </span>
            </div>
          )}
        </Card>
      )}
      {openUser && <UserSheet projectRef={ref} userId={openUser} canChange={canChange} onClose={() => setOpenUser(null)} />}
      {adding && <AddUserDialog projectRef={ref} mode={adding} onClose={() => setAdding(null)} />}
    </DatabasePage>
  )
}

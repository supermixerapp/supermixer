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
import { localized, t as tr, Trans, language } from '@/lib/i18n'

export const Route = createFileRoute('/_app/project/$ref/auth/users')({
  component: UsersPage,
})

const PAGE_SIZE = 50

const FILTER_LABELS = localized((): Record<UserFilter, string> => ({
  all: tr('authentication:authUsers.allUsers'),
  verified: tr('authentication:authUsers.verified'),
  unverified: tr('authentication:authUsers.unverified'),
  anonymous: tr('authentication:authUsers.anonymous'),
}))

const SORT_LABELS = localized((): Record<string, string> => ({
  'created_at:desc': tr('authentication:authUsers.newestFirst'),
  'created_at:asc': tr('authentication:authUsers.oldestFirst'),
  'last_sign_in_at:desc': tr('authentication:authUsers.recentlySignedIn'),
  'email:asc': tr('authentication:authUsers.emailAZ'),
}))

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
      title={tr('authentication:authUsers.users')}
      description={tr('authentication:authUsers.everyoneWhoHasSignedUpTo')}
      toolbar={
        <>
          <SearchBox value={typed} onChange={setTyped} placeholder={tr('authentication:authUsers.searchEmailPhoneNameOrId')} />
          <Select
            value={filter}
            onValueChange={(v) => {
              setFilter(v as UserFilter)
              setPage(0)
            }}
          >
            <SelectTrigger size="tiny" className="w-36" aria-label={tr('authentication:authUsers.filterUsers')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(FILTER_LABELS()).map(([v, label]) => (
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
            <SelectTrigger size="tiny" className="w-44" aria-label={tr('authentication:authUsers.sortUsers')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(SORT_LABELS()).map(([v, label]) => (
                <SelectItem key={v} value={v}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="default" size="tiny" icon={<RefreshIcon />} loading={users.isFetching && !users.isPending} onClick={() => void users.refetch()}>
            {tr('authentication:authUsers.refresh')}
          </Button>
        </>
      }
      actions={
        canChange ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="primary" iconRight={<ChevronDownIcon />}>
                {tr('authentication:authUsers.addUser')}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem onSelect={() => setAdding('invite')}>
                <Trans i18nKey="authentication:authUsers.sendInvitation" components={{ mailicon: <MailIcon size={16} /> }} />
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setAdding('create')}>
                <Trans i18nKey="authentication:authUsers.createNewUser" components={{ personaddicon: <PersonAddIcon size={16} /> }} />
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <PermissionButton allowed={false} action={tr('authentication:authUsers.addUsers')} variant="primary">
            {tr('authentication:authUsers.addUser')}
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
                ? tr('authentication:authUsers.noUsersOnThisPage')
                : search || filter !== 'all'
                  ? tr('authentication:authUsers.noUsersMatch')
                  : tr('authentication:authUsers.noUsersYetUsersAppearHere')}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{tr('authentication:authUsers.user')}</TableHead>
                  <TableHead>{tr('authentication:authUsers.providers')}</TableHead>
                  <TableHead>{tr('authentication:authUsers.status')}</TableHead>
                  <TableHead className="whitespace-nowrap">{tr('authentication:authUsers.created')}</TableHead>
                  <TableHead className="whitespace-nowrap">{tr('authentication:authUsers.lastSignedIn')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((u) => (
                  <TableRow
                    key={u.id}
                    className="cursor-pointer"
                    tabIndex={0}
                    aria-label={tr('authentication:authUsers.open', { email: u.email ?? u.phone ?? u.id })}
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
                        <span className="text-foreground">{u.email ?? u.phone ?? (u.anonymous ? tr('authentication:authUsers.anonymousUser') : '—')}</span>
                        <span className="font-mono text-xs text-foreground-lighter">
                          {u.display_name ? `${u.display_name} · ` : ''}
                          {u.id.slice(0, 8)}…
                        </span>
                      </span>
                    </TableCell>
                    <TableCell className="text-foreground-light">{u.providers.join(', ') || (u.anonymous ? 'anonymous' : '—')}</TableCell>
                    <TableCell>
                      <span className="flex flex-wrap gap-1">
                        {isBanned(u) && <Badge variant="destructive">{tr('authentication:authUsers.banned')}</Badge>}
                        {u.anonymous ? (
                          <Badge>{tr('authentication:authUsers.anonymous')}</Badge>
                        ) : isConfirmed(u) ? null : (
                          <Badge variant="warning">{u.invited_at ? tr('authentication:authUsers.invited') : tr('authentication:authUsers.unverified')}</Badge>
                        )}
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-foreground-light" title={new Date(u.created_at).toLocaleString(language())}>
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
              <span>{rows.length > 0 && tr('authentication:authUsers.ofUsers', { from: from + 1, to: from + rows.length, count: total })}</span>
              <span className="ml-auto flex gap-1">
                <Button variant="default" size="tiny" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                  {tr('authentication:authUsers.previous')}
                </Button>
                <Button variant="default" size="tiny" disabled={from + rows.length >= total} onClick={() => setPage((p) => p + 1)}>
                  {tr('authentication:authUsers.next')}
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

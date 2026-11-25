import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'

import { AddIcon, SettingsIcon } from '@/components/icons'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { SearchBox } from '@/components/database/catalog-page'
import { AdminLayout } from '@/components/layout/admin-layout'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogSection,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { toast } from '@/components/ui/toaster'
import { api, unwrap, type Schemas } from '@/lib/api/client'
import { useProfile } from '@/lib/api/hooks'
import { uiConfigQuery, usersQuery } from '@/lib/api/queries'
import { relativeTime } from '@/lib/auth-users'
import { passwordRule } from '@/lib/passwords'

export const Route = createFileRoute('/_app/admin/users')({
  component: UsersPage,
})

type User = Schemas['User']

// The status filter above the users table, matching the table's badges.
const STATUSES: { value: string; label: string; match: (u: User) => boolean }[] = [
  { value: 'all', label: 'All', match: () => true },
  { value: 'active', label: 'Active', match: (u) => !u.disabled },
  { value: 'disabled', label: 'Disabled', match: (u) => u.disabled },
  { value: 'admin', label: 'Instance admins', match: (u) => u.is_instance_admin },
  { value: 'mfa', label: 'Two-factor on', match: (u) => u.mfa_enabled },
  { value: 'no-mfa', label: 'Two-factor off', match: (u) => !u.mfa_enabled },
  { value: 'sso', label: 'Single sign-on', match: (u) => u.identities.length > 0 },
  {
    value: 'password',
    label: 'Must change password',
    match: (u) => u.password_change_required || u.default_password,
  },
]

function UsersPage() {
  const { data: me } = useProfile()
  const users = useQuery({ ...usersQuery, enabled: !!me?.is_instance_admin })
  const queryClient = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [resetting, setResetting] = useState<User | null>(null)
  const [resettingMfa, setResettingMfa] = useState<User | null>(null)
  // Who's being declined stays set while the dialog closes, so its title
  // doesn't change mid-animation; declineOpen opens and closes it.
  const [declining, setDeclining] = useState<User | null>(null)
  const [declineOpen, setDeclineOpen] = useState(false)
  // People who signed up and wait for approval are listed apart.
  const waiting = users.data?.filter((u) => u.waiting_approval) ?? []
  const active = users.data?.filter((u) => !u.waiting_approval)
  // Filters for the table: username or email, and status.
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('all')
  const needle = search.trim().toLowerCase()
  const statusMatch = (STATUSES.find((s) => s.value === status) ?? STATUSES[0]).match
  const shown = active?.filter(
    (u) =>
      statusMatch(u) &&
      (!needle || u.username.toLowerCase().includes(needle) || (u.email ?? '').toLowerCase().includes(needle))
  )
  const filtering = needle !== '' || status !== 'all'
  const approve = useMutation({
    mutationFn: (user: User) =>
      unwrap(api.POST('/admin/users/{user_id}/approval', { params: { path: { user_id: user.id } } })),
    onSuccess: (u) => {
      toast.success(`Approved ${u.username}; they've been emailed that they can sign in`)
      void queryClient.invalidateQueries({ queryKey: usersQuery.queryKey })
    },
    onError: (e) => toast.error(e.message),
  })
  const decline = useMutation({
    mutationFn: (user: User) =>
      unwrap(api.DELETE('/admin/users/{user_id}/approval', { params: { path: { user_id: user.id } } })),
    onSuccess: (_, u) => {
      setDeclineOpen(false)
      toast.success(`Declined ${u.username}; the account was removed`)
      void queryClient.invalidateQueries({ queryKey: usersQuery.queryKey })
    },
    onError: (e) => toast.error(e.message),
  })
  const providerNames = new Map((useQuery(uiConfigQuery).data?.sso_providers ?? []).map((p) => [p.id, p.name]))
  const resetMfa = useMutation({
    mutationFn: (user: User) =>
      unwrap(api.DELETE('/admin/users/{user_id}/mfa', { params: { path: { user_id: user.id } } })),
    onSuccess: (_, u) => {
      setResettingMfa(null)
      toast.success(`Turned off two-factor sign-in for ${u.username}; they were signed out everywhere`)
      void queryClient.invalidateQueries({ queryKey: usersQuery.queryKey })
    },
    onError: (e) => toast.error(e.message),
  })

  const update = useMutation({
    mutationFn: ({ user, body }: { user: User; body: Schemas['UserUpdate'] }) =>
      unwrap(api.PATCH('/admin/users/{user_id}', { params: { path: { user_id: user.id } }, body })),
    onSuccess: (u) => {
      toast.success(`Updated ${u.username}`)
      void queryClient.invalidateQueries({ queryKey: usersQuery.queryKey })
    },
    onError: (e) => toast.error(e.message),
  })
  const signOut = useMutation({
    mutationFn: (user: User) =>
      unwrap(api.DELETE('/admin/users/{user_id}/sessions', { params: { path: { user_id: user.id } } })),
    onSuccess: (_, u) => {
      toast.success(u.id === me?.id ? 'Signed out of your other sessions' : `Signed ${u.username} out everywhere`)
      void queryClient.invalidateQueries({ queryKey: usersQuery.queryKey })
    },
    onError: (e) => toast.error(e.message),
  })

  return (
    <AdminLayout
      title="Users"
      description="Everyone who can sign in to this Supermixer instance. Organization access is managed on each organization's Team page."
      actions={
        <Button variant="primary" icon={<AddIcon />} onClick={() => setCreating(true)}>
          Add user
        </Button>
      }
    >
      {waiting.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Waiting for approval ({waiting.length})</CardTitle>
            <CardDescription>
              They signed up and can&apos;t sign in until you approve them. Either way, they&apos;re told by email.
            </CardDescription>
          </CardHeader>
          <ul className="divide-y border-t">
            {waiting.map((u) => (
              <li key={u.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm text-foreground">
                    {u.display_name || u.username}
                    {u.display_name && <span className="ml-2 text-xs text-foreground-lighter">{u.username}</span>}
                  </span>
                  <span className="truncate text-xs text-foreground-lighter">
                    {u.email} · signed up {relativeTime(u.created_at)}
                  </span>
                </span>
                <span className="flex gap-2">
                  <Button
                    variant="default"
                    onClick={() => {
                      setDeclining(u)
                      setDeclineOpen(true)
                    }}
                  >
                    Decline
                  </Button>
                  <Button
                    variant="primary"
                    loading={approve.isPending && approve.variables?.id === u.id}
                    onClick={() => approve.mutate(u)}
                  >
                    Approve
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {me && (
        <div className="flex flex-wrap items-center gap-2">
          <SearchBox value={search} onChange={setSearch} placeholder="Search by username or email" />
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger size="tiny" className="w-56" aria-label="Status">
              <span className="text-foreground-lighter">status</span>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUSES.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {filtering && active && (
            <>
              <span className="text-xs text-foreground-lighter tabular-nums">
                {shown?.length} of {active.length} {active.length === 1 ? 'user' : 'users'}
              </span>
              <Button
                variant="text"
                size="tiny"
                onClick={() => {
                  setSearch('')
                  setStatus('all')
                }}
              >
                Clear filters
              </Button>
            </>
          )}
        </div>
      )}
      {me && (
            <Card>
              {users.isPending ? (
                <div className="flex flex-col gap-2 p-4">
                  <Skeleton className="h-6" />
                  <Skeleton className="h-6" />
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>User</TableHead>
                      <TableHead>Email</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Last active</TableHead>
                      <TableHead className="w-12" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {shown?.length === 0 && (
                      <TableRow className="hover:bg-transparent">
                        <TableCell colSpan={5} className="py-10 text-center text-foreground-lighter">
                          No users match these filters.
                        </TableCell>
                      </TableRow>
                    )}
                    {shown?.map((u) => (
                      <TableRow key={u.id}>
                        <TableCell>
                          <span className="flex flex-col">
                            <span className="text-foreground">{u.display_name || u.username}</span>
                            <span className="text-xs text-foreground-lighter">{u.username}</span>
                          </span>
                        </TableCell>
                        <TableCell className="text-foreground-light">{u.email ?? '—'}</TableCell>
                        <TableCell>
                          <span className="flex flex-wrap gap-1">
                            {u.disabled ? <Badge variant="destructive">Disabled</Badge> : <Badge variant="success">Active</Badge>}
                            {u.is_instance_admin && <Badge>Instance admin</Badge>}
                            {u.mfa_enabled && <Badge variant="success">2FA</Badge>}
                            {u.identities.map((id) => (
                              <Badge key={id} title="Signs in through this provider">
                                {providerNames.get(id) ?? id}
                              </Badge>
                            ))}
                            {!u.has_password && <Badge title="Made through single sign-on; no password yet">No password</Badge>}
                            {u.password_change_required && <Badge variant="warning">Must change password</Badge>}
                            {u.default_password && <Badge variant="warning">Default password</Badge>}
                          </span>
                        </TableCell>
                        <TableCell className="text-foreground-light">
                          {u.last_seen_at ? (
                            <span className="flex flex-col">
                              <span>{relativeTime(u.last_seen_at)}</span>
                              <span className="text-xs text-foreground-lighter">
                                {u.sessions} {u.sessions === 1 ? 'session' : 'sessions'}
                              </span>
                            </span>
                          ) : (
                            <span className="text-foreground-lighter">Not signed in</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="text" icon={<SettingsIcon />} aria-label={`Manage ${u.username}`} />
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-60">
                              <DropdownMenuItem onSelect={() => setResetting(u)}>Reset password</DropdownMenuItem>
                              <DropdownMenuItem
                                disabled={u.id === me.id}
                                onSelect={() =>
                                  update.mutate({ user: u, body: { password_change_required: !u.password_change_required } })
                                }
                              >
                                {u.password_change_required ? 'Don’t require a new password' : 'Require a new password'}
                              </DropdownMenuItem>
                              {u.mfa_enabled && u.id !== me.id && (
                                <DropdownMenuItem onSelect={() => setResettingMfa(u)}>Reset two-factor sign-in</DropdownMenuItem>
                              )}
                              <DropdownMenuItem
                                disabled={u.id === me.id ? u.sessions <= 1 : u.sessions === 0}
                                onSelect={() => signOut.mutate(u)}
                              >
                                {u.id === me.id ? 'Sign out other sessions' : 'Sign out everywhere'}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                disabled={u.id === me.id}
                                onSelect={() => update.mutate({ user: u, body: { is_instance_admin: !u.is_instance_admin } })}
                              >
                                {u.is_instance_admin ? 'Remove instance admin' : 'Make instance admin'}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                disabled={u.id === me.id}
                                onSelect={() => update.mutate({ user: u, body: { disabled: !u.disabled } })}
                              >
                                {u.disabled ? 'Enable account' : 'Disable account'}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </Card>
      )}
      <CreateUserDialog open={creating} onOpenChange={setCreating} />
      <ConfirmDialog
        open={resettingMfa !== null}
        onOpenChange={(o) => !o && setResettingMfa(null)}
        variant="warning"
        title={`Reset two-factor sign-in for ${resettingMfa?.username}?`}
        description="For someone who lost their authenticator app and recovery codes. Their password alone will sign them in until they set it up again, and they're signed out everywhere now. Check it's really them asking first."
        confirmLabel="Reset"
        loading={resetMfa.isPending}
        onConfirm={() => resettingMfa && resetMfa.mutate(resettingMfa)}
      />
      <ConfirmDialog
        open={declineOpen}
        onOpenChange={setDeclineOpen}
        title={`Decline ${declining?.username}?`}
        description="Their account is removed, and they're emailed that their sign-up wasn't accepted. They could sign up again later."
        confirmLabel="Decline"
        loading={decline.isPending}
        onConfirm={() => declining && decline.mutate(declining)}
      />
      {resetting && <ResetPasswordDialog user={resetting} self={resetting.id === me?.id} onClose={() => setResetting(null)} />}
    </AdminLayout>
  )
}

function CreateUserDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const queryClient = useQueryClient()
  const blank = { username: '', display_name: '', email: '', password: '', is_instance_admin: false, require_password_change: true }
  const [form, setForm] = useState(blank)
  const create = useMutation({
    mutationFn: () => unwrap(api.POST('/admin/users', { body: { ...form, email: form.email || null } })),
    onSuccess: (u) => {
      toast.success(`Created ${u.username}`)
      void queryClient.invalidateQueries({ queryKey: usersQuery.queryKey })
      setForm(blank)
      onOpenChange(false)
    },
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    create.mutate()
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="medium">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Add a user</DialogTitle>
            <DialogDescription>They can sign in right away. Share the password with them securely; by default it only lets them choose their own.</DialogDescription>
          </DialogHeader>
          <DialogSection className="flex flex-col gap-4 border-t">
            <FormField label="Username" htmlFor="nu-username" description="3–40 characters: letters, digits, . _ -">
              <Input id="nu-username" required autoFocus value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
            </FormField>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Display name" htmlFor="nu-name">
                <Input id="nu-name" value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} />
              </FormField>
              <FormField label="Email" htmlFor="nu-email">
                <Input id="nu-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </FormField>
            </div>
            <FormField label="Password" htmlFor="nu-password" description={passwordRule(false, 'their').hint}>
              <Input
                id="nu-password"
                type="password"
                autoComplete="new-password"
                required
                minLength={passwordRule(false).min}
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
              />
            </FormField>
            <div className="flex items-center gap-2">
              <Checkbox
                id="nu-admin"
                checked={form.is_instance_admin}
                onCheckedChange={(v) => setForm({ ...form, is_instance_admin: v === true })}
              />
              <Label htmlFor="nu-admin">Instance admin (can manage users)</Label>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="nu-change"
                checked={form.require_password_change}
                onCheckedChange={(v) => setForm({ ...form, require_password_change: v === true })}
              />
              <Label htmlFor="nu-change">Ask them to choose their own password when they first sign in</Label>
            </div>
            {create.error && <Alert variant="destructive" title={create.error.message} />}
          </DialogSection>
          <DialogFooter>
            <Button variant="default" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={create.isPending}>
              Add user
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function ResetPasswordDialog({ user, self, onClose }: { user: User; self: boolean; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [password, setPassword] = useState('')
  const [requireChange, setRequireChange] = useState(true)
  const reset = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/admin/users/{user_id}/password', {
          params: { path: { user_id: user.id } },
          body: { password, require_password_change: !self && requireChange },
        })
      ),
    onSuccess: () => {
      toast.success(
        self
          ? 'Password changed; your other sessions were signed out'
          : `Password reset for ${user.username}; they were signed out everywhere`
      )
      void queryClient.invalidateQueries({ queryKey: usersQuery.queryKey })
      onClose()
    },
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="small">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            reset.mutate()
          }}
        >
          <DialogHeader>
            <DialogTitle>Reset password for {user.username}</DialogTitle>
            <DialogDescription>
              {self ? 'Your other sessions will be signed out; this one stays.' : 'They will be signed out of every session.'}
            </DialogDescription>
          </DialogHeader>
          <DialogSection className="flex flex-col gap-4 border-t">
            <FormField label="New password" htmlFor="rp-password" description={passwordRule(user.mfa_enabled, 'their').hint}>
              <Input
                id="rp-password"
                type="password"
                autoComplete="new-password"
                autoFocus
                required
                minLength={passwordRule(user.mfa_enabled).min}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </FormField>
            {!self && (
              <div className="flex items-center gap-2">
                <Checkbox id="rp-change" checked={requireChange} onCheckedChange={(v) => setRequireChange(v === true)} />
                <Label htmlFor="rp-change">Ask them to choose their own password when they next sign in</Label>
              </div>
            )}
            {reset.error && <Alert variant="destructive" title={reset.error.message} />}
          </DialogSection>
          <DialogFooter>
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={reset.isPending}>
              Reset password
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

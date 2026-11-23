import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'

import { AddIcon, SettingsIcon } from '@/components/icons'
import { AppShell } from '@/components/layout/app-shell'
import { PageContainer, PageHeader } from '@/components/layout/page'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
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
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { toast } from '@/components/ui/toaster'
import { api, unwrap, type Schemas } from '@/lib/api/client'
import { useProfile } from '@/lib/api/hooks'
import { usersQuery } from '@/lib/api/queries'

export const Route = createFileRoute('/_app/admin/users')({
  component: UsersPage,
})

type User = Schemas['User']

function UsersPage() {
  const { data: me } = useProfile()
  const users = useQuery({ ...usersQuery, enabled: !!me?.is_instance_admin })
  const queryClient = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [resetting, setResetting] = useState<User | null>(null)

  const update = useMutation({
    mutationFn: ({ user, body }: { user: User; body: Schemas['UserUpdate'] }) =>
      unwrap(api.PATCH('/admin/users/{user_id}', { params: { path: { user_id: user.id } }, body })),
    onSuccess: (u) => {
      toast.success(`Updated ${u.username}`)
      void queryClient.invalidateQueries({ queryKey: usersQuery.queryKey })
    },
    onError: (e) => toast.error(e.message),
  })

  return (
    <AppShell title="Users">
      <div className="overflow-y-auto">
        <PageHeader
          title="Users"
          description="Everyone who can sign in to this Supermixer instance. Organization access is managed on each organization's Team page."
          size="large"
          actions={
            me?.is_instance_admin && (
              <Button variant="primary" icon={<AddIcon />} onClick={() => setCreating(true)}>
                Add user
              </Button>
            )
          }
        />
        <PageContainer size="large" className="flex flex-col gap-4 pb-16">
          {!me?.is_instance_admin ? (
            <Alert variant="warning" title="Only instance admins can manage users" />
          ) : (
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
                      <TableHead>Created</TableHead>
                      <TableHead className="w-12" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {users.data?.map((u) => (
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
                            {u.default_password && <Badge variant="warning">Default password</Badge>}
                          </span>
                        </TableCell>
                        <TableCell className="text-foreground-light">{new Date(u.created_at).toLocaleDateString()}</TableCell>
                        <TableCell>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="text" icon={<SettingsIcon />} aria-label={`Manage ${u.username}`} />
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-48">
                              <DropdownMenuItem onSelect={() => setResetting(u)}>Reset password</DropdownMenuItem>
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
        </PageContainer>
      </div>
      <CreateUserDialog open={creating} onOpenChange={setCreating} />
      {resetting && <ResetPasswordDialog user={resetting} onClose={() => setResetting(null)} />}
    </AppShell>
  )
}

function CreateUserDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const queryClient = useQueryClient()
  const blank = { username: '', display_name: '', email: '', password: '', is_instance_admin: false }
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
            <DialogDescription>They can sign in right away. Share the password with them securely.</DialogDescription>
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
            <FormField label="Password" htmlFor="nu-password" description="At least 8 characters">
              <Input
                id="nu-password"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
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

function ResetPasswordDialog({ user, onClose }: { user: User; onClose: () => void }) {
  const [password, setPassword] = useState('')
  const reset = useMutation({
    mutationFn: () =>
      unwrap(api.POST('/admin/users/{user_id}/password', { params: { path: { user_id: user.id } }, body: { password } })),
    onSuccess: () => {
      toast.success(`Password reset for ${user.username}; they were signed out everywhere`)
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
            <DialogDescription>They will be signed out of every session.</DialogDescription>
          </DialogHeader>
          <DialogSection className="flex flex-col gap-4 border-t">
            <FormField label="New password" htmlFor="rp-password" description="At least 8 characters">
              <Input
                id="rp-password"
                type="password"
                autoComplete="new-password"
                autoFocus
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </FormField>
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

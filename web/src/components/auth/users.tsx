/*
 * Auth › Users: the user details sheet and the add-user dialogs. Every change
 * goes through the stack's Auth admin API via Supermixer's gateway.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { CopyButton } from '@/components/ui/copy'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogSection,
  DialogTitle,
} from '@/components/ui/dialog'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetHeader, SheetSection } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from '@/components/ui/toaster'
import { gateway } from '@/lib/api/gateway'
import { BAN_DURATIONS, isBanned, isConfirmed, relativeTime, userPath, type AuthUser } from '@/lib/auth-users'

/** Run an Auth admin call, toast the outcome, and refresh the user list and details. */
function useAuthChange(projectRef: string) {
  const queryClient = useQueryClient()
  return useMutation<
    unknown,
    Error,
    {
      /** Which button started it, so only that one shows a spinner. */
      action: string
      path: string
      method: string
      body?: unknown
      done: string
      /** Runs before refetching, e.g. to close a deleted user's sheet so it doesn't refetch them. */
      first?: () => void
    }
  >({
    mutationFn: ({ path, method, body }) => gateway(projectRef, path, { method, body }),
    onSuccess: async (_, { done, first }) => {
      toast.success(done)
      first?.()
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['projects', projectRef, 'pg', 'auth-users'] }),
        queryClient.invalidateQueries({ queryKey: ['projects', projectRef, 'auth-user'] }),
      ])
    },
    onError: (e) => toast.error(e.message),
  })
}

export function UserSheet({
  projectRef,
  userId,
  canChange,
  onClose,
}: {
  projectRef: string
  userId: string
  canChange: boolean
  onClose: () => void
}) {
  const user = useQuery({
    queryKey: ['projects', projectRef, 'auth-user', userId],
    queryFn: ({ signal }) => gateway<AuthUser>(projectRef, userPath(userId), { signal }),
  })
  const change = useAuthChange(projectRef)
  const [banFor, setBanFor] = useState(BAN_DURATIONS[1]!.value)
  const [confirm, setConfirm] = useState<'delete' | 'ban' | null>(null)
  const u = user.data
  const banned = u ? isBanned(u) : false
  const pending = (action: string) => change.isPending && change.variables?.action === action
  const ban = BAN_DURATIONS.find((d) => d.value === banFor)

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent size="lg" className="flex flex-col">
        <SheetHeader>
          <h2 className="text-base text-foreground">{u?.email ?? u?.phone ?? (u?.is_anonymous ? 'Anonymous user' : 'User')}</h2>
          <p className="flex items-center gap-1 font-mono text-xs text-foreground-lighter">
            {userId}
            <CopyButton value={userId} label="Copy user ID" />
          </p>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto">
          {user.error ? (
            <SheetSection>
              <Alert variant="destructive" title={user.error.message} />
            </SheetSection>
          ) : !u ? (
            <SheetSection>
              <Skeleton className="h-48" />
            </SheetSection>
          ) : (
            <>
              <SheetSection className="flex flex-wrap gap-1.5">
                {banned && <Badge variant="destructive">Banned until {new Date(u.banned_until!).toLocaleString()}</Badge>}
                {u.is_anonymous && <Badge>Anonymous</Badge>}
                {u.is_sso_user && <Badge>SSO</Badge>}
                {!u.is_anonymous && !isConfirmed(u) && <Badge variant="warning">{u.invited_at ? 'Invited' : 'Waiting for verification'}</Badge>}
                {isConfirmed(u) && <Badge variant="success">Verified</Badge>}
              </SheetSection>
              <SheetSection className="border-t">
                <dl className="grid gap-3 text-sm sm:grid-cols-2">
                  <Field label="Email">{u.email || '—'}</Field>
                  <Field label="Phone">{u.phone || '—'}</Field>
                  <Field label="Created">{when(u.created_at)}</Field>
                  <Field label="Last signed in">{when(u.last_sign_in_at)}</Field>
                  <Field label="Email confirmed">{when(u.email_confirmed_at)}</Field>
                  <Field label="Invited">{when(u.invited_at)}</Field>
                  <Field label="Confirmation sent">{when(u.confirmation_sent_at)}</Field>
                  <Field label="Recovery sent">{when(u.recovery_sent_at)}</Field>
                  <Field label="Providers">
                    {(u.identities ?? []).map((i) => i.provider).join(', ') || (u.is_anonymous ? 'anonymous' : '—')}
                  </Field>
                  <Field label="Role">{u.role || '—'}</Field>
                </dl>
              </SheetSection>
              {(u.factors?.length ?? 0) > 0 && (
                <SheetSection className="flex flex-col gap-2 border-t">
                  <h3 className="text-sm text-foreground">Multi-factor authentication</h3>
                  <ul className="flex flex-col gap-2">
                    {u.factors!.map((f) => (
                      <li key={f.id} className="flex items-center gap-2 text-sm">
                        <Badge>{f.factor_type}</Badge>
                        <span className="text-foreground-light">{f.friendly_name || f.id}</span>
                        <span className="text-xs text-foreground-lighter">{f.status}</span>
                        {canChange && (
                          <Button
                            variant="text"
                            size="tiny"
                            className="ml-auto"
                            loading={pending(`factor:${f.id}`)}
                            onClick={() =>
                              change.mutate({
                                action: `factor:${f.id}`,
                                path: userPath(u.id, `/factors/${encodeURIComponent(f.id)}`),
                                method: 'DELETE',
                                done: 'Removed the factor',
                              })
                            }
                          >
                            Remove
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                </SheetSection>
              )}
              <SheetSection className="flex flex-col gap-2 border-t">
                <h3 className="text-sm text-foreground">Metadata</h3>
                <Json label="User metadata" value={u.user_metadata} />
                <Json label="App metadata" value={u.app_metadata} />
              </SheetSection>
              {canChange && (
                <SheetSection className="flex flex-col gap-4 border-t">
                  {u.email && (
                    <Action
                      title="Send password recovery"
                      description="Emails a link to set a new password. Needs SMTP on the stack."
                    >
                      <Button
                        variant="default"
                        size="tiny"
                        loading={pending('recover')}
                        onClick={() =>
                          change.mutate({ action: 'recover', path: 'auth/v1/recover', method: 'POST', body: { email: u.email }, done: `Sent recovery email to ${u.email}` })
                        }
                      >
                        Send
                      </Button>
                    </Action>
                  )}
                  {u.email && (
                    <Action title="Send magic link" description="Emails a one-time sign-in link. Needs SMTP on the stack.">
                      <Button
                        variant="default"
                        size="tiny"
                        loading={pending('magiclink')}
                        onClick={() =>
                          change.mutate({ action: 'magiclink', path: 'auth/v1/magiclink', method: 'POST', body: { email: u.email }, done: `Sent magic link to ${u.email}` })
                        }
                      >
                        Send
                      </Button>
                    </Action>
                  )}
                  {u.email && !u.email_confirmed_at && (
                    <Action title="Confirm email" description="Marks the email as verified without sending anything, e.g. when the stack has no SMTP.">
                      <Button
                        variant="default"
                        size="tiny"
                        loading={pending('confirm')}
                        onClick={() =>
                          change.mutate({ action: 'confirm', path: userPath(u.id), method: 'PUT', body: { email_confirm: true }, done: `Confirmed ${u.email}` })
                        }
                      >
                        Confirm
                      </Button>
                    </Action>
                  )}
                  {banned ? (
                    <Action title="Unban user" description="Lets the user sign in again.">
                      <Button
                        variant="default"
                        size="tiny"
                        loading={pending('unban')}
                        onClick={() => change.mutate({ action: 'unban', path: userPath(u.id), method: 'PUT', body: { ban_duration: 'none' }, done: 'User unbanned' })}
                      >
                        Unban
                      </Button>
                    </Action>
                  ) : (
                    <Action title="Ban user" description="Stops the user signing in or refreshing sessions for a while.">
                      <div className="flex items-center gap-2">
                        <Select value={banFor} onValueChange={setBanFor}>
                          <SelectTrigger size="tiny" className="w-48" aria-label="Ban duration">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {BAN_DURATIONS.map((d) => (
                              <SelectItem key={d.value} value={d.value}>
                                {d.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Button variant="warning" size="tiny" onClick={() => setConfirm('ban')}>
                          Ban
                        </Button>
                      </div>
                    </Action>
                  )}
                  <Action title="Delete user" description="Removes the user and their sessions. Rows referencing them may block it.">
                    <Button variant="danger" size="tiny" onClick={() => setConfirm('delete')}>
                      Delete
                    </Button>
                  </Action>
                </SheetSection>
              )}
            </>
          )}
        </div>
      </SheetContent>
      <ConfirmDialog
        open={confirm === 'ban'}
        onOpenChange={(o) => !o && setConfirm(null)}
        variant="warning"
        title={`Ban ${u?.email ?? 'this user'}?`}
        description={`They can't sign in or refresh their session ${ban?.phrase ?? ''}.`}
        confirmLabel="Ban user"
        loading={pending('ban')}
        onConfirm={() =>
          u &&
          change.mutate(
            { action: 'ban', path: userPath(u.id), method: 'PUT', body: { ban_duration: banFor }, done: 'User banned' },
            { onSettled: () => setConfirm(null) }
          )
        }
      />
      <ConfirmDialog
        open={confirm === 'delete'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Delete ${u?.email ?? u?.phone ?? 'this user'}?`}
        description="This can't be undone. The user's sessions end at once."
        confirmLabel="Delete user"
        loading={pending('delete')}
        onConfirm={() =>
          u &&
          change.mutate(
            { action: 'delete', path: userPath(u.id), method: 'DELETE', done: 'User deleted', first: onClose },
            { onSettled: () => setConfirm(null) }
          )
        }
      />
    </Sheet>
  )
}

function when(iso: string | null | undefined): ReactNode {
  if (!iso) return '—'
  return <span title={new Date(iso).toLocaleString()}>{relativeTime(iso)}</span>
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs text-foreground-lighter">{label}</dt>
      <dd className="truncate text-foreground">{children}</dd>
    </div>
  )
}

function Json({ label, value }: { label: string; value: unknown }) {
  return (
    <details className="rounded-md border text-xs">
      <summary className="cursor-pointer px-3 py-2 text-foreground-light select-none">{label}</summary>
      <pre className="overflow-x-auto border-t px-3 py-2 font-mono leading-5 text-foreground">{JSON.stringify(value ?? {}, null, 2)}</pre>
    </details>
  )
}

function Action({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-4">
      <div className="flex-1">
        <p className="text-sm text-foreground">{title}</p>
        <p className="text-xs text-foreground-lighter">{description}</p>
      </div>
      {children}
    </div>
  )
}

/** Create a user with a password, or invite one by email. */
export function AddUserDialog({ projectRef, mode, onClose }: { projectRef: string; mode: 'create' | 'invite'; onClose: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [autoConfirm, setAutoConfirm] = useState(true)
  const change = useAuthChange(projectRef)
  const emailOk = /^[^\s@]+@[^\s@]+$/.test(email.trim())
  const ready = emailOk && (mode === 'invite' || password.length > 0)

  const submit = () => {
    const e = email.trim()
    const call =
      mode === 'invite'
        ? { action: 'invite', path: 'auth/v1/invite', method: 'POST', body: { email: e }, done: `Invited ${e}` }
        : { action: 'create', path: 'auth/v1/admin/users', method: 'POST', body: { email: e, password, email_confirm: autoConfirm }, done: `Created ${e}` }
    change.mutate(call, { onSuccess: onClose })
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="small">
        <form
          onSubmit={(ev) => {
            ev.preventDefault()
            if (ready && !change.isPending) submit()
          }}
        >
          <DialogHeader>
            <DialogTitle>{mode === 'invite' ? 'Invite a user' : 'Create a new user'}</DialogTitle>
            <DialogDescription>
              {mode === 'invite'
                ? 'Sends an email with a link to set up their account. The stack needs SMTP configured.'
                : 'The user can sign in with this email and password straight away.'}
            </DialogDescription>
          </DialogHeader>
          <DialogSection className="flex flex-col gap-4 border-t">
            {change.error && <Alert variant="destructive" title={change.error.message} />}
            <FormField label="Email" htmlFor="user-email">
              <Input id="user-email" type="email" autoFocus autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
            </FormField>
            {mode === 'create' && (
              <>
                <FormField label="Password" htmlFor="user-password" description="Sent to the stack's Auth service over the gateway; Auth hashes it.">
                  <Input id="user-password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
                </FormField>
                <label className="flex items-start gap-2 text-sm">
                  <Checkbox checked={autoConfirm} onCheckedChange={(c) => setAutoConfirm(c === true)} className="mt-0.5" />
                  <span>
                    Auto confirm user
                    <span className="block text-xs text-foreground-lighter">
                      Marks the email as verified now. Auth sends no email for users created here, so if you untick this, confirm them
                      later from their details or they can&apos;t sign in.
                    </span>
                  </span>
                </label>
              </>
            )}
          </DialogSection>
          <DialogFooter>
            <Button type="button" variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!ready} loading={change.isPending}>
              {mode === 'invite' ? 'Send invitation' : 'Create user'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

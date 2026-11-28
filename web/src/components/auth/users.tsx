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
import { t, Trans, language } from '@/lib/i18n'

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
  const [banFor, setBanFor] = useState(BAN_DURATIONS()[1]!.value)
  const [confirm, setConfirm] = useState<'delete' | 'ban' | null>(null)
  const u = user.data
  const banned = u ? isBanned(u) : false
  const pending = (action: string) => change.isPending && change.variables?.action === action
  const ban = BAN_DURATIONS().find((d) => d.value === banFor)

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent size="lg" className="flex flex-col">
        <SheetHeader>
          <h2 className="text-base text-foreground">{u?.email ?? u?.phone ?? (u?.is_anonymous ? t('authentication:users.anonymousUser') : t('authentication:users.user'))}</h2>
          <p className="flex items-center gap-1 font-mono text-xs text-foreground-lighter">
            {userId}
            <CopyButton value={userId} label={t('authentication:users.copyUserId')} />
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
                {banned && <Badge variant="destructive">{t('authentication:users.bannedUntil', { value: new Date(u.banned_until!).toLocaleString(language()) })}</Badge>}
                {u.is_anonymous && <Badge>{t('authentication:users.anonymous')}</Badge>}
                {u.is_sso_user && <Badge>{t('authentication:users.sso')}</Badge>}
                {!u.is_anonymous && !isConfirmed(u) && <Badge variant="warning">{u.invited_at ? t('authentication:users.invited') : t('authentication:users.waitingForVerification')}</Badge>}
                {isConfirmed(u) && <Badge variant="success">{t('authentication:users.verified')}</Badge>}
              </SheetSection>
              <SheetSection className="border-t">
                <dl className="grid gap-3 text-sm sm:grid-cols-2">
                  <Field label={t('authentication:users.email')}>{u.email || '—'}</Field>
                  <Field label={t('authentication:users.phone')}>{u.phone || '—'}</Field>
                  <Field label={t('authentication:users.created')}>{when(u.created_at)}</Field>
                  <Field label={t('authentication:users.lastSignedIn')}>{when(u.last_sign_in_at)}</Field>
                  <Field label={t('authentication:users.emailConfirmed')}>{when(u.email_confirmed_at)}</Field>
                  <Field label={t('authentication:users.invited')}>{when(u.invited_at)}</Field>
                  <Field label={t('authentication:users.confirmationSent')}>{when(u.confirmation_sent_at)}</Field>
                  <Field label={t('authentication:users.recoverySent')}>{when(u.recovery_sent_at)}</Field>
                  <Field label={t('authentication:users.providers')}>
                    {(u.identities ?? []).map((i) => i.provider).join(', ') || (u.is_anonymous ? 'anonymous' : '—')}
                  </Field>
                  <Field label={t('authentication:users.role')}>{u.role || '—'}</Field>
                </dl>
              </SheetSection>
              {(u.factors?.length ?? 0) > 0 && (
                <SheetSection className="flex flex-col gap-2 border-t">
                  <h3 className="text-sm text-foreground">{t('authentication:users.multiFactorAuthentication')}</h3>
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
                                done: t('authentication:users.removedTheFactor'),
                              })
                            }
                          >
                            {t('authentication:users.remove')}
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                </SheetSection>
              )}
              <SheetSection className="flex flex-col gap-2 border-t">
                <h3 className="text-sm text-foreground">{t('authentication:users.metadata')}</h3>
                <Json label={t('authentication:users.userMetadata')} value={u.user_metadata} />
                <Json label={t('authentication:users.appMetadata')} value={u.app_metadata} />
              </SheetSection>
              {canChange && (
                <SheetSection className="flex flex-col gap-4 border-t">
                  {u.email && (
                    <Action
                      title={t('authentication:users.sendPasswordRecovery')}
                      description={t('authentication:users.emailsALinkToSetA')}
                    >
                      <Button
                        variant="default"
                        size="tiny"
                        loading={pending('recover')}
                        onClick={() =>
                          change.mutate({ action: 'recover', path: 'auth/v1/recover', method: 'POST', body: { email: u.email }, done: t('authentication:users.sentRecoveryEmailTo', { email: u.email }) })
                        }
                      >
                        {t('authentication:users.send')}
                      </Button>
                    </Action>
                  )}
                  {u.email && (
                    <Action title={t('authentication:users.sendMagicLink')} description={t('authentication:users.emailsAOneTimeSignIn')}>
                      <Button
                        variant="default"
                        size="tiny"
                        loading={pending('magiclink')}
                        onClick={() =>
                          change.mutate({ action: 'magiclink', path: 'auth/v1/magiclink', method: 'POST', body: { email: u.email }, done: t('authentication:users.sentMagicLinkTo', { email: u.email }) })
                        }
                      >
                        {t('authentication:users.send')}
                      </Button>
                    </Action>
                  )}
                  {u.email && !u.email_confirmed_at && (
                    <Action title={t('authentication:users.confirmEmail')} description={t('authentication:users.marksTheEmailAsVerifiedWithout')}>
                      <Button
                        variant="default"
                        size="tiny"
                        loading={pending('confirm')}
                        onClick={() =>
                          change.mutate({ action: 'confirm', path: userPath(u.id), method: 'PUT', body: { email_confirm: true }, done: t('authentication:users.confirmed', { email: u.email }) })
                        }
                      >
                        {t('authentication:users.confirm')}
                      </Button>
                    </Action>
                  )}
                  {banned ? (
                    <Action title={t('authentication:users.unbanUser')} description={t('authentication:users.letsTheUserSignInAgain')}>
                      <Button
                        variant="default"
                        size="tiny"
                        loading={pending('unban')}
                        onClick={() => change.mutate({ action: 'unban', path: userPath(u.id), method: 'PUT', body: { ban_duration: 'none' }, done: t('authentication:users.userUnbanned') })}
                      >
                        {t('authentication:users.unban')}
                      </Button>
                    </Action>
                  ) : (
                    <Action title={t('authentication:users.banUser')} description={t('authentication:users.stopsTheUserSigningInOr')}>
                      <div className="flex items-center gap-2">
                        <Select value={banFor} onValueChange={setBanFor}>
                          <SelectTrigger size="tiny" className="w-48" aria-label={t('authentication:users.banDuration')}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {BAN_DURATIONS().map((d) => (
                              <SelectItem key={d.value} value={d.value}>
                                {d.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Button variant="warning" size="tiny" onClick={() => setConfirm('ban')}>
                          {t('authentication:users.ban')}
                        </Button>
                      </div>
                    </Action>
                  )}
                  <Action title={t('authentication:users.deleteUser')} description={t('authentication:users.removesTheUserAndTheirSessions')}>
                    <Button variant="danger" size="tiny" onClick={() => setConfirm('delete')}>
                      {t('authentication:users.delete')}
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
        title={t('authentication:users.ban2', { email: u?.email ?? t('authentication:users.thisUser') })}
        description={t('authentication:users.theyCanTSignInOr', { phrase: ban?.phrase ?? '' })}
        confirmLabel={t('authentication:users.banUser')}
        loading={pending('ban')}
        onConfirm={() =>
          u &&
          change.mutate(
            { action: 'ban', path: userPath(u.id), method: 'PUT', body: { ban_duration: banFor }, done: t('authentication:users.userBanned') },
            { onSettled: () => setConfirm(null) }
          )
        }
      />
      <ConfirmDialog
        open={confirm === 'delete'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={t('authentication:users.delete2', { email: u?.email ?? u?.phone ?? t('authentication:users.thisUser') })}
        description={t('authentication:users.thisCanTBeUndoneThe')}
        confirmLabel={t('authentication:users.deleteUser')}
        loading={pending('delete')}
        onConfirm={() =>
          u &&
          change.mutate(
            { action: 'delete', path: userPath(u.id), method: 'DELETE', done: t('authentication:users.userDeleted'), first: onClose },
            { onSettled: () => setConfirm(null) }
          )
        }
      />
    </Sheet>
  )
}

function when(iso: string | null | undefined): ReactNode {
  if (!iso) return '—'
  return <span title={new Date(iso).toLocaleString(language())}>{relativeTime(iso)}</span>
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
        ? { action: 'invite', path: 'auth/v1/invite', method: 'POST', body: { email: e }, done: t('authentication:users.invited2', { e }) }
        : { action: 'create', path: 'auth/v1/admin/users', method: 'POST', body: { email: e, password, email_confirm: autoConfirm }, done: t('authentication:users.created2', { e }) }
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
            <DialogTitle>{mode === 'invite' ? t('authentication:users.inviteAUser') : t('authentication:users.createANewUser')}</DialogTitle>
            <DialogDescription>
              {mode === 'invite'
                ? t('authentication:users.sendsAnEmailWithALink')
                : t('authentication:users.theUserCanSignInWith')}
            </DialogDescription>
          </DialogHeader>
          <DialogSection className="flex flex-col gap-4 border-t">
            {change.error && <Alert variant="destructive" title={change.error.message} />}
            <FormField label={t('authentication:users.email')} htmlFor="user-email">
              <Input id="user-email" type="email" autoFocus autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
            </FormField>
            {mode === 'create' && (
              <>
                <FormField label={t('authentication:users.password')} htmlFor="user-password" description={t('authentication:users.sentToTheStackSAuth')}>
                  <Input id="user-password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
                </FormField>
                <label className="flex items-start gap-2 text-sm">
                  <Checkbox checked={autoConfirm} onCheckedChange={(c) => setAutoConfirm(c === true)} className="mt-0.5" />
                  <span>
                    <Trans i18nKey="authentication:users.autoConfirmUserMarksTheEmail" components={{ span: <span className="block text-xs text-foreground-lighter" /> }} />
                  </span>
                </label>
              </>
            )}
          </DialogSection>
          <DialogFooter>
            <Button type="button" variant="default" onClick={onClose}>
              {t('authentication:users.cancel')}
            </Button>
            <Button type="submit" variant="primary" disabled={!ready} loading={change.isPending}>
              {mode === 'invite' ? t('authentication:users.sendInvitation') : t('authentication:users.createUser')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

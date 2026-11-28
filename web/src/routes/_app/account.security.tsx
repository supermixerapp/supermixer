/*
 * Account › Security: two-factor sign-in with an authenticator app, and
 * recovery codes for a lost device.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { AccountLayout } from '@/components/layout/account-layout'
import { SettingsSection } from '@/components/layout/section'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardFooter } from '@/components/ui/card'
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
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from '@/components/ui/toaster'
import { api, unwrap, type Schemas } from '@/lib/api/client'
import { useProfile } from '@/lib/api/hooks'
import { profileQuery, uiConfigQuery } from '@/lib/api/queries'
import { relativeTime } from '@/lib/auth-users'
import { t } from '@/lib/i18n'
import { formatDate } from '@/lib/i18n/format'

export const Route = createFileRoute('/_app/account/security')({
  // Set when a sign-in provider sends the browser back here.
  validateSearch: (search: Record<string, unknown>): { connected?: string; sso_error?: string } => ({
    connected: typeof search.connected === 'string' ? search.connected : undefined,
    sso_error: typeof search.sso_error === 'string' ? search.sso_error : undefined,
  }),
  component: SecurityPage,
})

const mfaQuery = {
  queryKey: ['profile', 'mfa'],
  queryFn: () => unwrap(api.GET('/profile/mfa')),
}

function SecurityPage() {
  return (
    <AccountLayout title={t('account:security.security')}>
      <TwoFactorSection />
      <ProvidersSection />
    </AccountLayout>
  )
}

function TwoFactorSection() {
  const status = useQuery(mfaQuery)
  const [dialog, setDialog] = useState<'setup' | 'codes' | 'disable' | null>(null)
  const s = status.data
  return (
    <SettingsSection
      title={t('account:security.twoFactorSignIn')}
      description={t('account:security.signInWithACodeFrom')}
    >
      {status.error ? (
        <Alert variant="destructive" title={status.error.message} />
      ) : !s ? (
        <Skeleton className="h-28" />
      ) : (
        <Card>
          <CardContent className="flex flex-col gap-3 text-sm">
            <div className="flex items-center gap-2">
              <span className="text-foreground">{t('account:security.authenticatorApp')}</span>
              {s.enabled ? <Badge variant="success">{t('account:security.on')}</Badge> : <Badge>{t('account:security.off')}</Badge>}
            </div>
            {s.enabled ? (
              <>
                <p className="text-foreground-light">
                  {s.enabled_at ? t('account:security.onSinceDate', { date: formatDate(s.enabled_at) }) : t('account:security.onSinceSetup')}
                </p>
                <p className={s.recovery_codes_left <= 3 ? 'text-warning-600' : 'text-foreground-light'}>
                  {t('account:security.recoveryCodesLeft', { count: s.recovery_codes_left })}
                  {s.recovery_codes_left <= 3 && t('account:security.makeNewOnesBeforeYouRun')}
                </p>
              </>
            ) : (
              <p className="text-foreground-light">
                {t('account:security.offSomeOrganizationsRequireItYou')}
              </p>
            )}
          </CardContent>
          <CardFooter className="gap-2">
            {s.enabled ? (
              <>
                <Button variant="default" onClick={() => setDialog('codes')}>
                  {t('account:security.newRecoveryCodes')}
                </Button>
                <Button variant="warning" onClick={() => setDialog('disable')}>
                  {t('account:security.turnOff')}
                </Button>
              </>
            ) : (
              <Button variant="primary" onClick={() => setDialog('setup')}>
                {t('account:security.setUpAuthenticatorApp')}
              </Button>
            )}
          </CardFooter>
        </Card>
      )}
      {dialog === 'setup' && <SetupDialog onClose={() => setDialog(null)} />}
      {dialog === 'codes' && <NewCodesDialog onClose={() => setDialog(null)} />}
      {dialog === 'disable' && <DisableDialog onClose={() => setDialog(null)} />}
    </SettingsSection>
  )
}

/** Refetch what depends on whether two-factor sign-in is on. */
function useRefresh() {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: mfaQuery.queryKey })
    void queryClient.invalidateQueries({ queryKey: profileQuery.queryKey })
    void queryClient.invalidateQueries({ queryKey: ['organizations'] })
  }
}

function SetupDialog({ onClose }: { onClose: () => void }) {
  const { data: me } = useProfile()
  const refresh = useRefresh()
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [setup, setSetup] = useState<Schemas['MfaSetup'] | null>(null)
  const [codes, setCodes] = useState<string[] | null>(null)
  const start = useMutation({
    mutationFn: () => unwrap(api.POST('/profile/mfa/setup', { body: { password } })),
    onSuccess: (s) => {
      setPassword('')
      setSetup(s)
    },
  })
  const enable = useMutation({
    mutationFn: () => unwrap(api.POST('/profile/mfa/enable', { body: { code } })),
    onSuccess: (r) => {
      setCodes(r.codes)
      refresh()
    },
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!setup) start.mutate()
    else enable.mutate()
  }
  // Once on, closing means they've seen the codes.
  const close = () => {
    if (codes) toast.success(t('account:security.twoFactorSignInIsOn'))
    onClose()
  }
  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent size="medium">
        {codes ? (
          <>
            <DialogHeader>
              <DialogTitle>{t('account:security.saveYourRecoveryCodes')}</DialogTitle>
              <DialogDescription>
                {t('account:security.ifYouLoseYourPhoneEach')}
              </DialogDescription>
            </DialogHeader>
            <DialogSection className="border-t">
              <RecoveryCodes codes={codes} username={me?.username ?? 'supermixer'} />
            </DialogSection>
            <DialogFooter>
              <Button variant="primary" onClick={close}>
                {t('account:security.iVeSavedThem')}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={submit}>
            <DialogHeader>
              <DialogTitle>{t('account:security.setUpAnAuthenticatorApp')}</DialogTitle>
              <DialogDescription>
                {setup
                  ? t('account:security.scanTheQrCodeWithThe')
                  : me?.has_password === false
                    ? t('account:security.yourAccountSignsInThroughA')
                    : t('account:security.confirmYourPasswordToStartTurning')}
              </DialogDescription>
            </DialogHeader>
            <DialogSection className="flex flex-col gap-4 border-t">
              {!setup ? (
                me?.has_password === false ? null : (
                <>
                  <input type="text" autoComplete="username" value={me?.username ?? ''} readOnly hidden />
                  <FormField label={t('account:security.password')} htmlFor="mfa-password">
                    <Input
                      id="mfa-password"
                      type="password"
                      autoComplete="current-password"
                      autoFocus
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  </FormField>
                </>
                )
              ) : (
                <>
                  <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
                    <img
                      src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(setup.qr_svg)}`}
                      alt={t('account:security.qrCodeToAddSupermixerTo')}
                      className="size-44 shrink-0 rounded-md border bg-white p-1"
                    />
                    <div className="flex min-w-0 flex-col gap-2 text-sm">
                      <span className="text-foreground-light">{t('account:security.canTScanItEnterThis')}</span>
                      <span className="flex items-center gap-1">
                        <code className="font-mono text-xs break-all text-foreground">{setup.secret}</code>
                        <CopyButton value={setup.secret.replaceAll(' ', '')} label={t('account:security.copyTheKey')} iconOnly />
                      </span>
                      <span className="text-xs text-foreground-lighter">{t('account:security.timeBased6DigitsEvery30')}</span>
                    </div>
                  </div>
                  <FormField label={t('account:security.codeFromTheApp')} htmlFor="mfa-code">
                    <Input
                      id="mfa-code"
                      autoComplete="one-time-code"
                      inputMode="numeric"
                      autoFocus
                      required
                      placeholder="123456"
                      className="font-mono tracking-widest"
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                    />
                  </FormField>
                </>
              )}
              {(start.error ?? enable.error) && <Alert variant="destructive" title={(start.error ?? enable.error)!.message} />}
            </DialogSection>
            <DialogFooter>
              <Button variant="default" onClick={close}>
                {t('account:security.cancel')}
              </Button>
              <Button type="submit" variant="primary" loading={start.isPending || enable.isPending}>
                {setup ? t('account:security.turnOn') : t('account:security.continue')}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

function RecoveryCodes({ codes, username }: { codes: string[]; username: string }) {
  const text = codes.join('\n')
  const download = () => {
    const url = URL.createObjectURL(
      new Blob([t('account:security.supermixerRecoveryCodesForEachWorks', { username, text })], { type: 'text/plain' })
    )
    const a = document.createElement('a')
    a.href = url
    a.download = `supermixer-recovery-codes-${username}.txt`
    a.click()
    URL.revokeObjectURL(url)
  }
  return (
    <div className="flex flex-col gap-3">
      <ul className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-md border bg-surface-100 p-4 font-mono text-sm text-foreground">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="flex gap-2">
        <CopyButton value={text} label={t('account:security.copyCodes')} />
        <Button variant="default" size="tiny" onClick={download}>
          {t('account:security.download')}
        </Button>
      </div>
    </div>
  )
}

function NewCodesDialog({ onClose }: { onClose: () => void }) {
  const { data: me } = useProfile()
  const refresh = useRefresh()
  const [code, setCode] = useState('')
  const regenerate = useMutation({
    mutationFn: () => unwrap(api.POST('/profile/mfa/recovery-codes', { body: { code } })),
    onSuccess: refresh,
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="medium">
        {regenerate.data ? (
          <>
            <DialogHeader>
              <DialogTitle>{t('account:security.yourNewRecoveryCodes')}</DialogTitle>
              <DialogDescription>{t('account:security.theOldOnesNoLongerWork')}</DialogDescription>
            </DialogHeader>
            <DialogSection className="border-t">
              <RecoveryCodes codes={regenerate.data.codes} username={me?.username ?? 'supermixer'} />
            </DialogSection>
            <DialogFooter>
              <Button variant="primary" onClick={onClose}>
                {t('account:security.iVeSavedThem')}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              regenerate.mutate()
            }}
          >
            <DialogHeader>
              <DialogTitle>{t('account:security.makeNewRecoveryCodes')}</DialogTitle>
              <DialogDescription>{t('account:security.yourCurrentRecoveryCodesStopWorking')}</DialogDescription>
            </DialogHeader>
            <DialogSection className="flex flex-col gap-4 border-t">
              <FormField label={t('account:security.codeFromTheApp')} htmlFor="rc-code">
                <Input
                  id="rc-code"
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  autoFocus
                  required
                  className="font-mono tracking-widest"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
              </FormField>
              {regenerate.error && <Alert variant="destructive" title={regenerate.error.message} />}
            </DialogSection>
            <DialogFooter>
              <Button variant="default" onClick={onClose}>
                {t('account:security.cancel')}
              </Button>
              <Button type="submit" variant="primary" loading={regenerate.isPending}>
                {t('account:security.makeNewCodes')}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

function DisableDialog({ onClose }: { onClose: () => void }) {
  const { data: me } = useProfile()
  const refresh = useRefresh()
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const disable = useMutation({
    mutationFn: () => unwrap(api.POST('/profile/mfa/disable', { body: { password, code } })),
    onSuccess: () => {
      toast.success(t('account:security.twoFactorSignInIsOff'))
      refresh()
      onClose()
    },
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="medium">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            disable.mutate()
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('account:security.turnOffTwoFactorSignIn')}</DialogTitle>
            <DialogDescription>
              {t('account:security.yourPasswordAloneWillSignYou')}
            </DialogDescription>
          </DialogHeader>
          <DialogSection className="flex flex-col gap-4 border-t">
            {me?.has_password !== false && (
              <>
                <input type="text" autoComplete="username" value={me?.username ?? ''} readOnly hidden />
                <FormField label={t('account:security.password')} htmlFor="off-password">
                  <Input
                    id="off-password"
                    type="password"
                    autoComplete="current-password"
                    autoFocus
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </FormField>
              </>
            )}
            <FormField label={t('account:security.codeFromTheAppOrA')} htmlFor="off-code">
              <Input
                id="off-code"
                autoComplete="one-time-code"
                required
                className="font-mono tracking-widest"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </FormField>
            {disable.error && <Alert variant="destructive" title={disable.error.message} />}
          </DialogSection>
          <DialogFooter>
            <Button variant="default" onClick={onClose}>
              {t('account:security.cancel')}
            </Button>
            <Button type="submit" variant="warning" loading={disable.isPending}>
              {t('account:security.turnOff')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

const identitiesQuery = {
  queryKey: ['profile', 'identities'],
  queryFn: () => unwrap(api.GET('/profile/identities')),
}

/** Single sign-on providers: connect one to sign in with it. */
function ProvidersSection() {
  const providers = useQuery(uiConfigQuery).data?.sso_providers ?? []
  const identities = useQuery({ ...identitiesQuery, enabled: providers.length > 0 })
  const { connected, sso_error: ssoError } = Route.useSearch()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [disconnecting, setDisconnecting] = useState<Schemas['Identity'] | null>(null)
  const { data: me } = useProfile()
  // Connecting is another way to sign in: the password confirms it's you
  // (or, without one, a recent sign-in).
  const [connecting, setConnecting] = useState<{ id: string; name: string } | null>(null)
  const [password, setPassword] = useState('')
  const connect = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/v1/profile/identities/${encodeURIComponent(id)}/connect`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': decodeURIComponent(document.cookie.split('; ').find((c) => c.startsWith('sm_csrf='))?.split('=')[1] ?? ''),
        },
        body: JSON.stringify({ password }),
      })
      const body = (await res.json()) as { url?: string; message?: string }
      if (!res.ok || !body.url) throw new Error(body.message ?? t('account:security.couldnTStartConnecting'))
      return body.url
    },
    // Off to the provider; it sends the browser back here.
    onSuccess: (url) => window.location.assign(url),
    onError: (e) => {
      if (!connecting) toast.error(e.message)
    },
  })
  const startConnect = (p: { id: string; name: string }) => {
    if (me?.has_password === false) connect.mutate(p.id)
    else {
      setPassword('')
      connect.reset()
      setConnecting(p)
    }
  }
  const disconnect = useMutation({
    mutationFn: (i: Schemas['Identity']) =>
      unwrap(api.DELETE('/profile/identities/{identity_id}', { params: { path: { identity_id: i.id } } })),
    onSuccess: (_, i) => {
      toast.success(t('account:security.disconnected', { providerName: i.provider_name }))
      setDisconnecting(null)
      void queryClient.invalidateQueries({ queryKey: identitiesQuery.queryKey })
    },
    onError: (e) => {
      setDisconnecting(null)
      toast.error(e.message)
    },
  })
  if (providers.length === 0) return null
  const byProvider = new Map((identities.data ?? []).map((i) => [i.provider, i]))
  const clear = () => void navigate({ to: '/account/security', search: {}, replace: true })
  return (
    <SettingsSection
      title={t('account:security.signInProviders')}
      description={t('account:security.connectYourOrganizationSSignIn')}
    >
      {ssoError && (
        <Alert variant="destructive" title={ssoError} actions={<Button size="tiny" variant="default" onClick={clear}>{t('account:security.dismiss')}</Button>} />
      )}
      {connected && !ssoError && (
        <Alert
          title={t('account:security.connected', { name: providers.find((p) => p.id === connected)?.name ?? connected })}
          actions={<Button size="tiny" variant="default" onClick={clear}>{t('account:security.dismiss')}</Button>}
        >
          {t('account:security.youCanSignInWithIt')}
        </Alert>
      )}
      <Card className="flex flex-col divide-y text-sm">
        {providers.map((p) => {
          const i = byProvider.get(p.id)
          return (
            <div key={p.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
              <span className="flex flex-col">
                <span className="flex items-center gap-2 text-foreground">
                  {p.name}
                  {i && <Badge variant="success">{t('account:security.connected2')}</Badge>}
                </span>
                {i && (
                  <span className="text-xs text-foreground-lighter">
                    {i.email || t('account:security.noEmailAddressGiven')}
                    {i.last_sign_in_at && <> {t('account:security.lastSignedIn', { relativeTime: relativeTime(i.last_sign_in_at) })}</>}
                  </span>
                )}
              </span>
              {i ? (
                <Button size="tiny" variant="default" onClick={() => setDisconnecting(i)}>
                  {t('account:security.disconnect')}
                </Button>
              ) : (
                <Button size="tiny" variant="default" loading={connect.isPending && connect.variables === p.id} onClick={() => startConnect(p)}>
                  {t('account:security.connect')}
                </Button>
              )}
            </div>
          )
        })}
      </Card>
      <Dialog open={connecting !== null} onOpenChange={(o) => !o && setConnecting(null)}>
        <DialogContent size="small">
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (connecting) connect.mutate(connecting.id)
            }}
          >
            <DialogHeader>
              <DialogTitle>{t('account:security.connect2', { name: connecting?.name })}</DialogTitle>
              <DialogDescription>
                {t('account:security.itWillSignYouInTo', { name: connecting?.name })}
              </DialogDescription>
            </DialogHeader>
            <DialogSection className="flex flex-col gap-4 border-t">
              <input type="text" autoComplete="username" value={me?.username ?? ''} readOnly hidden />
              <FormField label={t('account:security.password')} htmlFor="connect-password">
                <Input
                  id="connect-password"
                  type="password"
                  autoComplete="current-password"
                  autoFocus
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </FormField>
              {connect.error && <Alert variant="destructive" title={connect.error.message} />}
            </DialogSection>
            <DialogFooter>
              <Button variant="default" onClick={() => setConnecting(null)}>
                {t('account:security.cancel')}
              </Button>
              <Button type="submit" variant="primary" loading={connect.isPending}>
                {t('account:security.continue')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={disconnecting !== null}
        onOpenChange={(o) => !o && setDisconnecting(null)}
        variant="warning"
        title={t('account:security.disconnect2', { providerName: disconnecting?.provider_name })}
        description={t('account:security.itWonTSignYouIn')}
        confirmLabel={t('account:security.disconnect')}
        loading={disconnect.isPending}
        onConfirm={() => disconnecting && disconnect.mutate(disconnecting)}
      />
    </SettingsSection>
  )
}

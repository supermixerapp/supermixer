import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, redirect, useNavigate } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'

import { AuthLayout } from '@/components/layout/auth-layout'
import { ProviderIcon } from '@/components/provider-icon'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { api, unwrap, type Schemas } from '@/lib/api/client'
import { profileQuery, uiConfigQuery } from '@/lib/api/queries'
import { safeRedirect } from '@/lib/redirect'
import { localized, t, Trans } from '@/lib/i18n'


export const Route = createFileRoute('/sign-in')({
  validateSearch: (search: Record<string, unknown>): { redirect?: string; sso_error?: string; mfa?: string } => ({
    redirect: typeof search.redirect === 'string' ? search.redirect : undefined,
    // Set when single sign-on sends the browser back here.
    sso_error: typeof search.sso_error === 'string' ? search.sso_error : undefined,
    mfa: typeof search.mfa === 'string' ? search.mfa : undefined,
  }),
  beforeLoad: async ({ context, search }) => {
    // Already signed in? Go straight on.
    const profile = await context.queryClient.fetchQuery(profileQuery).catch(() => undefined)
    if (profile) throw redirect({ href: safeRedirect(search.redirect) })
  },
  component: SignInPage,
})

// "Welcome back" in a few languages, one picked at random on each visit.
// All written in Latin letters, so anyone can read them; lang tells screen
// readers how to say them.
const GREETINGS = localized(() => [
  { text: 'Welcome back!', language: t('auth:signIn.english'), lang: 'en' },
  { text: 'Bon retour !', language: t('auth:signIn.french'), lang: 'fr' },
  { text: 'Willkommen zurück!', language: t('auth:signIn.german'), lang: 'de' },
  { text: '¡Bienvenido de nuevo!', language: t('auth:signIn.spanish'), lang: 'es' },
  { text: 'Okaerinasai!', language: t('auth:signIn.japanese'), lang: 'ja-Latn' },
  { text: 'Namaste!', language: t('auth:signIn.hindi'), lang: 'hi-Latn' },
  { text: 'Ahlan wa sahlan!', language: t('auth:signIn.arabic'), lang: 'ar-Latn' },
])

function SignInPage() {
  const { redirect: target, sso_error: ssoError, mfa } = Route.useSearch()
  const providers = useQuery(uiConfigQuery).data?.sso_providers ?? []
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const emailOn = useQuery(uiConfigQuery).data?.email_enabled
  const signUpOn = useQuery(uiConfigQuery).data?.sign_up_enabled
  // Chosen once per visit, so it doesn't change while they type.
  const [greeting] = useState(() => GREETINGS()[Math.floor(Math.random() * GREETINGS().length)])
  // Set when the account has two-factor sign-in: the password was right.
  const [challenge, setChallenge] = useState<Schemas['MfaChallenge'] | null>(null)

  const signedIn = (profile: Schemas['Profile']) => {
    queryClient.clear()
    queryClient.setQueryData(profileQuery.queryKey, profile)
    void navigate({ href: safeRedirect(target) })
  }
  const signIn = useMutation({
    mutationFn: () => unwrap(api.POST('/auth/sign-in', { body: { username, password } })),
    onSuccess: (res) => {
      if ('mfa_required' in res) {
        setPassword('')
        setChallenge(res)
      } else signedIn(res)
    },
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    signIn.mutate()
  }

  // After a password, or after single sign-on for an account with
  // two-factor sign-in (whose challenge is in a cookie: mfa=1).
  const pending = challenge?.challenge ?? (mfa ? '' : undefined)
  if (pending !== undefined) {
    return (
      <AuthLayout>
        <MfaStep
          challenge={pending}
          onSignedIn={signedIn}
          onRestart={() => {
            signIn.reset()
            setChallenge(null)
            void navigate({ to: '/sign-in', search: { redirect: target } })
          }}
        />
      </AuthLayout>
    )
  }

  return (
    <AuthLayout>
      <div className="mb-10">
        <h1 className="mt-8 mb-2 text-2xl lg:text-3xl" lang={greeting.lang} title={t('auth:signIn.welcomeBackIn', { language: greeting.language })}>
          {greeting.text}
        </h1>
        <h2 className="font-sans text-sm font-normal text-foreground-light">{t('auth:signIn.signInToYourAccount')}</h2>
      </div>
      {ssoError && <Alert variant="destructive" title={ssoError} className="mb-4" />}
      {providers.length > 0 && (
        <>
          <div className="flex flex-col gap-2">
            {providers.map((p) => (
              <Button key={p.id} asChild variant="default" size="large" block icon={p.type === 'github' ? <ProviderIcon type={p.type} /> : undefined}>
                <a href={`/api/v1/auth/sso/${encodeURIComponent(p.id)}/start?redirect=${encodeURIComponent(safeRedirect(target))}`}>
                  {t('auth:signIn.continueWith', { name: p.name })}
                </a>
              </Button>
            ))}
          </div>
          <div className="my-6 flex items-center gap-3 text-xs text-foreground-lighter">
            <Trans i18nKey="auth:signIn.or" components={{ span: <span className="h-px flex-1 bg-border" />, span2: <span className="h-px flex-1 bg-border" /> }} />
          </div>
        </>
      )}
      <form onSubmit={submit} className="flex flex-col gap-4">
        <FormField label={t('auth:signIn.username')} htmlFor="username">
          <Input
            id="username"
            size="medium"
            autoComplete="username"
            autoFocus
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </FormField>
        <FormField label={t('auth:signIn.password')} htmlFor="password">
          <Input
            id="password"
            type="password"
            size="medium"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </FormField>
        {emailOn && (
          <Link to="/forgot-password" className="-mt-2 self-end text-xs text-link">
            {t('auth:signIn.forgotYourPassword')}
          </Link>
        )}
        {signIn.error && <Alert variant="destructive" title={signIn.error.message} />}
        <Button type="submit" variant="primary" size="large" block loading={signIn.isPending} className="mt-2">
          {t('auth:signIn.signIn')}
        </Button>
      </form>
      <div className="mt-8 flex flex-col gap-5 text-center text-sm text-foreground-lighter">
        {signUpOn ? (
          <p>
            <Trans i18nKey="auth:signIn.donTHaveAnAccountCreate" components={{ link: <Link to="/sign-up" search={{ token: undefined }} className="text-link" /> }} />
          </p>
        ) : (
          <p>{t('auth:signIn.noAccountYetAskYourSupermixer')}</p>
        )}
        <Alert title={t('auth:signIn.settingUpSupermixerForTheFirst')} className="text-left">
          <Trans i18nKey="auth:signIn.signInAsAdminThePassword" components={{ strong: <strong className="text-foreground" />, code: <code className="font-mono text-xs" /> }} />
        </Alert>
      </div>
    </AuthLayout>
  )
}

/** The second step: a code from the authenticator app, or a recovery code. */
function MfaStep({
  challenge,
  onSignedIn,
  onRestart,
}: {
  challenge: string
  onSignedIn: (p: Schemas['Profile']) => void
  onRestart: () => void
}) {
  const [recovery, setRecovery] = useState(false)
  const [code, setCode] = useState('')
  const verify = useMutation({
    mutationFn: () => unwrap(api.POST('/auth/mfa', { body: challenge ? { challenge, code } : { code } })),
    onSuccess: onSignedIn,
  })
  const expired = verify.error?.message.startsWith('Your sign-in expired')
  return (
    <>
      <div className="mb-10">
        <h1 className="mt-8 mb-2 text-2xl lg:text-3xl">{t('auth:signIn.twoFactorSignIn')}</h1>
        <h2 className="font-sans text-sm font-normal text-foreground-light">
          {recovery
            ? t('auth:signIn.enterOneOfTheRecoveryCodes')
            : t('auth:signIn.enterThe6DigitCodeFrom')}
        </h2>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          verify.mutate()
        }}
        className="flex flex-col gap-4"
      >
        <FormField label={recovery ? t('auth:signIn.recoveryCode') : t('auth:signIn.code')} htmlFor="mfa-code">
          <Input
            id="mfa-code"
            size="medium"
            autoFocus
            required
            autoComplete="one-time-code"
            inputMode={recovery ? 'text' : 'numeric'}
            pattern={recovery ? undefined : '[0-9 ]{6,7}'}
            placeholder={recovery ? 'xxxxx-xxxxx' : '123456'}
            className="font-mono tracking-widest"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </FormField>
        {verify.error && <Alert variant="destructive" title={verify.error.message} />}
        {expired ? (
          <Button type="button" variant="primary" size="large" block onClick={onRestart} className="mt-2">
            {t('auth:signIn.signInAgain')}
          </Button>
        ) : (
          <Button type="submit" variant="primary" size="large" block loading={verify.isPending} className="mt-2">
            {t('auth:signIn.verify')}
          </Button>
        )}
      </form>
      <p className="mt-8 flex justify-center gap-4 text-sm text-foreground-lighter">
        <button
          type="button"
          className="text-link"
          onClick={() => {
            setRecovery(!recovery)
            setCode('')
            verify.reset()
          }}
        >
          {recovery ? t('auth:signIn.useTheAuthenticatorApp') : t('auth:signIn.useARecoveryCode')}
        </button>
        <button type="button" className="text-link" onClick={onRestart}>
          {t('auth:signIn.back')}
        </button>
      </p>
    </>
  )
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, redirect, useNavigate } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'

import { AuthLayout } from '@/components/layout/auth-layout'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { api, unwrap, type Schemas } from '@/lib/api/client'
import { profileQuery, uiConfigQuery } from '@/lib/api/queries'
import { safeRedirect } from '@/lib/redirect'


export const Route = createFileRoute('/sign-in')({
  validateSearch: (search: Record<string, unknown>) => ({
    redirect: typeof search.redirect === 'string' ? search.redirect : undefined,
  }),
  beforeLoad: async ({ context, search }) => {
    // Already signed in? Go straight on.
    const profile = await context.queryClient.fetchQuery(profileQuery).catch(() => undefined)
    if (profile) throw redirect({ href: safeRedirect(search.redirect) })
  },
  component: SignInPage,
})

function SignInPage() {
  const { redirect: target } = Route.useSearch()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const emailOn = useQuery(uiConfigQuery).data?.email_enabled
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

  if (challenge) {
    return (
      <AuthLayout>
        <MfaStep
          challenge={challenge.challenge}
          onSignedIn={signedIn}
          onRestart={() => {
            signIn.reset()
            setChallenge(null)
          }}
        />
      </AuthLayout>
    )
  }

  return (
    <AuthLayout>
      <div className="mb-10">
        <h1 className="mt-8 mb-2 text-2xl lg:text-3xl">Welcome back</h1>
        <h2 className="font-sans text-sm font-normal text-foreground-light">Sign in to your account</h2>
      </div>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <FormField label="Username" htmlFor="username">
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
        <FormField label="Password" htmlFor="password">
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
            Forgot your password?
          </Link>
        )}
        {signIn.error && <Alert variant="destructive" title={signIn.error.message} />}
        <Button type="submit" variant="primary" size="large" block loading={signIn.isPending} className="mt-2">
          Sign in
        </Button>
      </form>
      <p className="mt-8 text-center text-sm text-foreground-lighter">
        Accounts are created by an instance admin or through an invitation link. On a new install, sign in as the
        bootstrap admin from the server&apos;s <code className="font-mono text-xs">.env.toml</code> (
        <code className="font-mono text-xs">admin</code> unless it says otherwise), with its password from there or,
        if none is set, the one-time password in the server&apos;s log.
      </p>
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
    mutationFn: () => unwrap(api.POST('/auth/mfa', { body: { challenge, code } })),
    onSuccess: onSignedIn,
  })
  const expired = verify.error?.message.startsWith('Your sign-in expired')
  return (
    <>
      <div className="mb-10">
        <h1 className="mt-8 mb-2 text-2xl lg:text-3xl">Two-factor sign-in</h1>
        <h2 className="font-sans text-sm font-normal text-foreground-light">
          {recovery
            ? 'Enter one of the recovery codes you saved when you set up two-factor sign-in. Each works once.'
            : 'Enter the 6-digit code from your authenticator app.'}
        </h2>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          verify.mutate()
        }}
        className="flex flex-col gap-4"
      >
        <FormField label={recovery ? 'Recovery code' : 'Code'} htmlFor="mfa-code">
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
            Sign in again
          </Button>
        ) : (
          <Button type="submit" variant="primary" size="large" block loading={verify.isPending} className="mt-2">
            Verify
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
          {recovery ? 'Use the authenticator app' : 'Use a recovery code'}
        </button>
        <button type="button" className="text-link" onClick={onRestart}>
          Back
        </button>
      </p>
    </>
  )
}

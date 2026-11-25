/*
 * Creating your own account, when Instance › Sign-up allows it. First an
 * email address, which gets a link; the link (?token=) leads back here to
 * choose a username and password. The account is made then, and signs in,
 * or waits for an instance admin's approval.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, redirect, useNavigate } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'

import { AuthLayout } from '@/components/layout/auth-layout'
import { ProviderIcon } from '@/components/provider-icon'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { api, unwrap } from '@/lib/api/client'
import { profileQuery, uiConfigQuery } from '@/lib/api/queries'
import { passwordRule } from '@/lib/passwords'

export const Route = createFileRoute('/sign-up')({
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search.token === 'string' ? search.token : undefined,
  }),
  // Signed in already: creating an account here would replace that session
  // without a word, so go on as sign-in does.
  beforeLoad: async ({ context }) => {
    const profile = await context.queryClient.fetchQuery(profileQuery).catch(() => undefined)
    if (profile) throw redirect({ to: '/dashboard' })
  },
  component: SignUpPage,
})

function SignUpPage() {
  const { token } = Route.useSearch()
  return <AuthLayout>{token ? <ChooseAccount token={token} /> : <AskForLink />}</AuthLayout>
}

function Heading({ title, subtitle }: { title: string; subtitle: React.ReactNode }) {
  return (
    <div className="mb-10">
      <h1 className="mt-8 mb-2 text-2xl lg:text-3xl">{title}</h1>
      <h2 className="font-sans text-sm font-normal text-foreground-light">{subtitle}</h2>
    </div>
  )
}

function BackToSignIn() {
  return (
    <p className="mt-8 text-center text-sm text-foreground-lighter">
      Already have an account?{' '}
      <Link to="/sign-in" search={{ redirect: undefined }} className="text-link">
        Sign in
      </Link>
    </p>
  )
}

/** Step 1: an email address, which gets a link. */
function AskForLink() {
  const ui = useQuery(uiConfigQuery).data
  const [email, setEmail] = useState('')
  // Hidden from people; bots that fill it in are quietly ignored.
  const [website, setWebsite] = useState('')
  const request = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/auth/sign-up', {
          body: { email, ...(website && { website }) },
        })
      ),
  })
  // Providers that make an account for someone new (GitHub, while sign-up is on).
  const providers = ui?.sso_providers.filter((p) => p.creates_accounts) ?? []
  if (!ui) {
    return (
      <div aria-busy="true">
        <div className="mb-10">
          <h1 className="mt-8 mb-2 text-2xl lg:text-3xl">Create your account</h1>
          <Skeleton className="h-4 w-64" />
        </div>
        <Skeleton className="h-36" />
      </div>
    )
  }
  if (ui && !ui.sign_up_enabled && providers.length === 0) {
    return (
      <>
        <Heading
          title="Create your account"
          subtitle="Accounts here are made by an instance admin."
        />
        <Alert variant="warning" title="You can't create your own account on this Supermixer">
          Ask an instance admin for one, or use the invitation link you were sent.
        </Alert>
        <BackToSignIn />
      </>
    )
  }
  return (
    <>
      <Heading
        title="Create your account"
        subtitle={
          request.isSuccess
            ? 'Check your email.'
            : !ui?.sign_up_enabled
              ? 'Sign in with one of these, and your account is made.'
              : 'Enter your email address, and we’ll email you a link to set up your account.'
        }
      />
      {providers.length > 0 && !request.isSuccess && (
        <>
          <div className="flex flex-col gap-2">
            {providers.map((p) => (
              <Button
                key={p.id}
                asChild
                variant="default"
                size="large"
                block
                icon={p.type === 'github' ? <ProviderIcon type={p.type} /> : undefined}
              >
                <a
                  href={`/api/v1/auth/sso/${encodeURIComponent(p.id)}/start?redirect=${encodeURIComponent('/dashboard')}`}
                >
                  Continue with {p.name}
                </a>
              </Button>
            ))}
          </div>
          {ui?.sign_up_enabled && (
            <div className="my-6 flex items-center gap-3 text-xs text-foreground-lighter">
              <span className="h-px flex-1 bg-border" />
              or
              <span className="h-px flex-1 bg-border" />
            </div>
          )}
        </>
      )}
      {!ui?.sign_up_enabled ? null : request.isSuccess ? (
        <Alert title={`We've sent an email to ${email.trim()}`}>
          It has a link to choose your username and password, which works once, for a day. If
          nothing arrives in a few minutes, check your spam folder.
        </Alert>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            request.mutate()
          }}
          className="flex flex-col gap-4"
        >
          <FormField label="Email" htmlFor="su-email">
            <Input
              id="su-email"
              type="email"
              size="medium"
              autoComplete="email"
              autoFocus
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </FormField>
          <div aria-hidden className="absolute -left-[10000px] h-px w-px overflow-hidden">
            <label htmlFor="su-website">Website</label>
            <input
              id="su-website"
              tabIndex={-1}
              autoComplete="off"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
            />
          </div>
          {request.error && <Alert variant="destructive" title={request.error.message} />}
          <Button
            type="submit"
            variant="primary"
            size="large"
            block
            loading={request.isPending}
            className="mt-2"
          >
            Send link
          </Button>
        </form>
      )}
      <BackToSignIn />
    </>
  )
}

/** Step 2, from the emailed link: username and password. */
function ChooseAccount({ token }: { token: string }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const info = useQuery({
    queryKey: ['sign-up', token],
    queryFn: () => unwrap(api.GET('/auth/sign-up/{token}', { params: { path: { token } } })),
    retry: false,
  })
  const [form, setForm] = useState({
    username: '',
    display_name: '',
    password: '',
    confirm: '',
  })
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }))
  const mismatch = form.confirm !== '' && form.password !== form.confirm
  const [waiting, setWaiting] = useState(false)

  const create = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/auth/sign-up/{token}', {
          params: { path: { token } },
          body: {
            username: form.username,
            display_name: form.display_name,
            password: form.password,
          },
        })
      ),
    onSuccess: (profile) => {
      // No profile: the account waits for an instance admin's approval.
      if (!profile) {
        setWaiting(true)
        return
      }
      queryClient.clear()
      queryClient.setQueryData(profileQuery.queryKey, profile)
      void navigate({ to: '/organizations' })
    },
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!mismatch) create.mutate()
  }

  if (waiting) {
    return (
      <>
        <Heading title="Thanks for signing up" subtitle="Your account is almost ready." />
        <Alert title="Your account is waiting for an instance admin's approval">
          We&apos;ll email {info.data?.email} as soon as it&apos;s approved. Then you can sign in
          with the username and password you just chose.
        </Alert>
        <BackToSignIn />
      </>
    )
  }
  return (
    <>
      <Heading title="Create your account" subtitle="Choose your username and password." />
      {info.error ? (
        <Alert variant="warning" title={info.error.message}>
          <Link to="/sign-up" search={{ token: undefined }} className="text-link">
            Ask for a new link
          </Link>
        </Alert>
      ) : !info.data ? (
        <Skeleton className="h-72" />
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-4">
          <FormField label="Email" htmlFor="su-email">
            <Input
              id="su-email"
              type="email"
              autoComplete="email"
              value={info.data.email}
              readOnly
              disabled
            />
          </FormField>
          <FormField
            label="Username"
            htmlFor="su-username"
            description="3–40 characters: letters, digits, . _ -"
          >
            <Input
              id="su-username"
              autoComplete="username"
              autoFocus
              required
              value={form.username}
              onChange={set('username')}
            />
          </FormField>
          <FormField label="Display name" htmlFor="su-name">
            <Input
              id="su-name"
              autoComplete="name"
              value={form.display_name}
              onChange={set('display_name')}
            />
          </FormField>
          <FormField label="Password" htmlFor="su-password" description={passwordRule(false).hint}>
            <Input
              id="su-password"
              type="password"
              autoComplete="new-password"
              required
              minLength={passwordRule(false).min}
              value={form.password}
              onChange={set('password')}
            />
          </FormField>
          <FormField
            label="Confirm password"
            htmlFor="su-confirm"
            error={mismatch ? "The passwords don't match" : undefined}
          >
            <Input
              id="su-confirm"
              type="password"
              autoComplete="new-password"
              required
              aria-invalid={mismatch || undefined}
              value={form.confirm}
              onChange={set('confirm')}
            />
          </FormField>
          {info.data.approval_required && (
            <p className="text-sm text-foreground-light">
              An instance admin approves new accounts here before they can sign in. We&apos;ll email
              you when yours is ready.
            </p>
          )}
          {create.error && <Alert variant="destructive" title={create.error.message} />}
          <Button
            type="submit"
            variant="primary"
            size="large"
            block
            loading={create.isPending}
            className="mt-2"
          >
            Create account
          </Button>
        </form>
      )}
      <BackToSignIn />
    </>
  )
}

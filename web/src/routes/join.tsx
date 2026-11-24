import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'

import { AuthLayout } from '@/components/layout/auth-layout'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { api, unwrap } from '@/lib/api/client'
import { invitationQuery, profileQuery } from '@/lib/api/queries'
import { roleLabel } from '@/lib/roles'
import { passwordRule } from '@/lib/passwords'

export const Route = createFileRoute('/join')({
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search.token === 'string' ? search.token : '',
  }),
  component: JoinPage,
})

function JoinPage() {
  const { token } = Route.useSearch()
  const invitation = useQuery({ ...invitationQuery(token), enabled: !!token })
  const profile = useQuery({ ...profileQuery, retry: false })

  return (
    <AuthLayout>
      {!token || invitation.isError ? (
        <div className="flex flex-col gap-4">
          <h1 className="text-2xl">Invitation not found</h1>
          <p className="text-sm text-foreground-light">
            {invitation.error?.message ?? 'This link is missing its invitation token.'} Ask whoever invited you for a
            new link.
          </p>
        </div>
      ) : invitation.isPending || profile.isPending ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : (
        <>
          <div className="mb-8 flex flex-col gap-3">
            <h1 className="text-2xl">Join {invitation.data.organization_name}</h1>
            {/* A div: the badge is a div, which a <p> can't hold. */}
            <div className="text-sm text-foreground-light">
              {invitation.data.invited_by ? (
                <>
                  <span className="text-foreground">{invitation.data.invited_by}</span> invited you to join as{' '}
                </>
              ) : (
                'You have been invited to join as '
              )}
              <Badge variant="success" className="align-middle">
                {roleLabel(invitation.data.role)}
              </Badge>
            </div>
          </div>
          {!invitation.data.valid ? (
            <Alert variant="warning" title="This invitation can no longer be used">
              It has expired or was already accepted. Ask for a new link.
            </Alert>
          ) : profile.data ? (
            <AcceptAsCurrentUser token={token} username={profile.data.username} slug={invitation.data.organization_slug} />
          ) : (
            <SignUp token={token} email={invitation.data.email} />
          )}
        </>
      )}
    </AuthLayout>
  )
}

function AcceptAsCurrentUser({ token, username, slug }: { token: string; username: string; slug: string }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const accept = useMutation({
    mutationFn: () => unwrap(api.POST('/invitations/{token}/accept', { params: { path: { token } } })),
    onSuccess: async () => {
      await queryClient.invalidateQueries()
      void navigate({ to: '/org/$slug', params: { slug } })
    },
  })
  const signOut = useMutation({
    mutationFn: () => unwrap(api.POST('/auth/sign-out')),
    onSuccess: () => queryClient.resetQueries({ queryKey: profileQuery.queryKey }),
  })
  return (
    <div className="flex flex-col gap-4">
      {accept.error && <Alert variant="destructive" title={accept.error.message} />}
      <Button variant="primary" size="large" block loading={accept.isPending} onClick={() => accept.mutate()}>
        Join organization
      </Button>
      <p className="text-center text-sm text-foreground-lighter">
        Signed in as <span className="text-foreground">{username}</span>.{' '}
        <button type="button" className="text-link" onClick={() => signOut.mutate()}>
          Not you?
        </button>
      </p>
    </div>
  )
}

function SignUp({ token, email }: { token: string; email: string }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [form, setForm] = useState({ username: '', display_name: '', email, password: '' })
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }))

  const signUp = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/invitations/{token}/sign-up', {
          params: { path: { token } },
          body: { ...form, email: form.email || null },
        })
      ),
    onSuccess: (profile) => {
      queryClient.clear()
      queryClient.setQueryData(profileQuery.queryKey, profile)
      void navigate({ to: '/organizations' })
    },
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    signUp.mutate()
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <FormField label="Username" htmlFor="su-username" description="3–40 characters: letters, digits, . _ -">
        <Input id="su-username" autoComplete="username" required value={form.username} onChange={set('username')} />
      </FormField>
      <FormField label="Display name" htmlFor="su-name">
        <Input id="su-name" autoComplete="name" value={form.display_name} onChange={set('display_name')} />
      </FormField>
      <FormField label="Email" htmlFor="su-email">
        <Input id="su-email" type="email" autoComplete="email" value={form.email} onChange={set('email')} />
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
      {signUp.error && <Alert variant="destructive" title={signUp.error.message} />}
      <Button type="submit" variant="primary" size="large" block loading={signUp.isPending} className="mt-2">
        Create account and join
      </Button>
      <p className="text-center text-sm text-foreground-lighter">
        Already have an account?{' '}
        <Link to="/sign-in" search={{ redirect: `/join?token=${encodeURIComponent(token)}` }} className="text-link">
          Sign in
        </Link>
      </p>
    </form>
  )
}

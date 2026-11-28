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
import { t, Trans } from '@/lib/i18n'

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
          <h1 className="text-2xl">{t('auth:join.invitationNotFound')}</h1>
          <p className="text-sm text-foreground-light">
            {t('auth:join.askWhoeverInvitedYouForA', { message: invitation.error?.message ?? t('common:join.thisLinkIsMissingItsInvitation') })}
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
            <h1 className="text-2xl">{t('auth:join.join', { organizationName: invitation.data.organization_name })}</h1>
            {/* A div: the badge is a div, which a <p> can't hold. */}
            <div className="text-sm text-foreground-light">
              {invitation.data.invited_by ? (
                <>
                  <Trans i18nKey="auth:join.invitedYouToJoinAs" values={{ invitedBy: invitation.data.invited_by }} components={{ span: <span className="text-foreground" /> }} />
                </>
              ) : (
                t('auth:join.youHaveBeenInvitedToJoin')
              )}
              <Badge variant="success" className="align-middle">
                {roleLabel(invitation.data.role)}
              </Badge>
            </div>
          </div>
          {!invitation.data.valid ? (
            <Alert variant="warning" title={t('auth:join.thisInvitationCanNoLongerBe')}>
              {t('auth:join.itHasExpiredOrWasAlready')}
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
        {t('auth:join.joinOrganization')}
      </Button>
      <p className="text-center text-sm text-foreground-lighter">
        <Trans i18nKey="auth:join.signedInAsNotYou" values={{ username }} components={{ span: <span className="text-foreground" />, button: <button type="button" className="text-link" onClick={() => signOut.mutate()} /> }} />
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
      // The landing page: straight to the organization they joined, if it's their only one.
      void navigate({ to: '/dashboard' })
    },
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    signUp.mutate()
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <FormField label={t('auth:join.username')} htmlFor="su-username" description={t('auth:join.n340CharactersLettersDigits')}>
        <Input id="su-username" autoComplete="username" required value={form.username} onChange={set('username')} />
      </FormField>
      <FormField label={t('auth:join.displayName')} htmlFor="su-name">
        <Input id="su-name" autoComplete="name" value={form.display_name} onChange={set('display_name')} />
      </FormField>
      <FormField label={t('auth:join.email')} htmlFor="su-email">
        <Input id="su-email" type="email" autoComplete="email" value={form.email} onChange={set('email')} />
      </FormField>
      <FormField label={t('auth:join.password')} htmlFor="su-password" description={passwordRule(false).hint}>
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
        {t('auth:join.createAccountAndJoin')}
      </Button>
      <p className="text-center text-sm text-foreground-lighter">
        <Trans i18nKey="auth:join.alreadyHaveAnAccountSignIn" components={{ link: <Link to="/sign-in" search={{ redirect: `/join?token=${encodeURIComponent(token)}` }} className="text-link" /> }} />
      </p>
    </form>
  )
}

/*
 * The page a password-reset email links to: choose a new password (and,
 * with two-factor sign-in, give a code too).
 */
import { useMutation, useQuery } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'

import { AuthLayout } from '@/components/layout/auth-layout'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from '@/components/ui/toaster'
import { api, unwrap } from '@/lib/api/client'

export const Route = createFileRoute('/reset-password')({
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search.token === 'string' ? search.token : '',
  }),
  component: ResetPasswordPage,
})

function ResetPasswordPage() {
  const { token } = Route.useSearch()
  const navigate = useNavigate()
  const info = useQuery({
    queryKey: ['password-reset', token],
    queryFn: () => unwrap(api.GET('/auth/password-reset/{token}', { params: { path: { token } } })),
    enabled: token !== '',
    retry: false,
  })
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [code, setCode] = useState('')
  const mismatch = confirm !== '' && password !== confirm
  const complete = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/auth/password-reset/{token}', {
          params: { path: { token } },
          body: { password, ...(info.data?.mfa_required && { code }) },
        })
      ),
    onSuccess: () => {
      toast.success('Your password is changed; sign in with it')
      void navigate({ to: '/sign-in', search: { redirect: undefined } })
    },
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!mismatch) complete.mutate()
  }
  const gone = !token || info.error
  return (
    <AuthLayout>
      <div className="mb-10">
        <h1 className="mt-8 mb-2 text-2xl lg:text-3xl">Choose a new password</h1>
        {info.data && (
          <h2 className="font-sans text-sm font-normal text-foreground-light">
            For <span className="text-foreground">{info.data.username}</span>. Every session is signed out afterwards.
          </h2>
        )}
      </div>
      {gone ? (
        <Alert variant="warning" title={info.error?.message ?? 'This link is incomplete'}>
          <Link to="/forgot-password" className="text-link">
            Ask for a new link
          </Link>
        </Alert>
      ) : !info.data ? (
        <Skeleton className="h-48" />
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-4">
          <input type="text" autoComplete="username" value={info.data.username} readOnly hidden />
          <FormField label="New password" htmlFor="rp-new" description="At least 8 characters, and not a common password or your username">
            <Input
              id="rp-new"
              type="password"
              size="medium"
              autoComplete="new-password"
              autoFocus
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </FormField>
          <FormField label="Confirm new password" htmlFor="rp-confirm" error={mismatch ? 'Passwords do not match' : undefined}>
            <Input
              id="rp-confirm"
              type="password"
              size="medium"
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </FormField>
          {info.data.mfa_required && (
            <FormField
              label="Two-factor code"
              htmlFor="rp-code"
              description="Your account uses two-factor sign-in: enter a code from your authenticator app, or a recovery code."
            >
              <Input
                id="rp-code"
                size="medium"
                autoComplete="one-time-code"
                required
                className="font-mono tracking-widest"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </FormField>
          )}
          {complete.error && <Alert variant="destructive" title={complete.error.message} />}
          <Button type="submit" variant="primary" size="large" block loading={complete.isPending} disabled={mismatch} className="mt-2">
            Set new password
          </Button>
        </form>
      )}
    </AuthLayout>
  )
}

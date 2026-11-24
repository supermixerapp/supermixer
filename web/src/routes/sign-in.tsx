import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'

import { AuthLayout } from '@/components/layout/auth-layout'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { api, unwrap } from '@/lib/api/client'
import { profileQuery } from '@/lib/api/queries'
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

  const signIn = useMutation({
    mutationFn: () => unwrap(api.POST('/auth/sign-in', { body: { username, password } })),
    onSuccess: (profile) => {
      queryClient.clear()
      queryClient.setQueryData(profileQuery.queryKey, profile)
      void navigate({ href: safeRedirect(target) })
    },
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    signIn.mutate()
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
        {signIn.error && <Alert variant="destructive" title={signIn.error.message} />}
        <Button type="submit" variant="primary" size="large" block loading={signIn.isPending} className="mt-2">
          Sign in
        </Button>
      </form>
      <p className="mt-8 text-center text-sm text-foreground-lighter">
        Accounts are created by an instance admin or through an invitation link. On a new install, sign in as{' '}
        <code className="font-mono text-xs">admin</code> with the one-time password in the server&apos;s log.
      </p>
    </AuthLayout>
  )
}

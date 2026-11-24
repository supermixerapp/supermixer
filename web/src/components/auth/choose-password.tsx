/*
 * Shown instead of the app while the account must choose a new password:
 * the bootstrap admin's first sign-in, accounts an instance admin created,
 * and passwords an admin reset. The API allows nothing else meanwhile.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useRouter } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'

import { AuthLayout } from '@/components/layout/auth-layout'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { api, unwrap } from '@/lib/api/client'

export function ChoosePassword({ username }: { username: string }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const router = useRouter()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const mismatch = confirm !== '' && next !== confirm
  const change = useMutation({
    mutationFn: () => unwrap(api.POST('/profile/password', { body: { current_password: current, new_password: next } })),
    onSuccess: async () => {
      // Requests made while the change was required failed: refetch the
      // profile (which swaps this screen for the app) and rerun the loaders.
      await queryClient.resetQueries()
      await router.invalidate()
    },
  })
  const signOut = useMutation({
    mutationFn: () => unwrap(api.POST('/auth/sign-out')),
    onSettled: () => {
      queryClient.clear()
      void navigate({ to: '/sign-in', search: { redirect: undefined } })
    },
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!mismatch) change.mutate()
  }
  return (
    <AuthLayout>
      <div className="mb-10">
        <h1 className="mt-8 mb-2 text-2xl lg:text-3xl">Choose a new password</h1>
        <h2 className="font-sans text-sm font-normal text-foreground-light">
          You’re signed in as <span className="text-foreground">{username}</span> with a password that was set for you,
          or that an administrator asked you to replace. Choose your own to continue.
        </h2>
      </div>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <input type="text" autoComplete="username" value={username} readOnly hidden />
        <FormField label="Password you signed in with" htmlFor="cp-current">
          <Input
            id="cp-current"
            type="password"
            size="medium"
            autoComplete="current-password"
            autoFocus
            required
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </FormField>
        <FormField
          label="New password"
          htmlFor="cp-new"
          description="At least 8 characters, and not a common password or your username"
        >
          <Input
            id="cp-new"
            type="password"
            size="medium"
            autoComplete="new-password"
            required
            minLength={8}
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
        </FormField>
        <FormField label="Confirm new password" htmlFor="cp-confirm" error={mismatch ? 'Passwords do not match' : undefined}>
          <Input
            id="cp-confirm"
            type="password"
            size="medium"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </FormField>
        {change.error && <Alert variant="destructive" title={change.error.message} />}
        <Button type="submit" variant="primary" size="large" block loading={change.isPending} disabled={mismatch} className="mt-2">
          Set password and continue
        </Button>
      </form>
      <p className="mt-8 text-center text-sm text-foreground-lighter">
        Not you?{' '}
        <button type="button" className="text-link" onClick={() => signOut.mutate()}>
          Sign out
        </button>
      </p>
    </AuthLayout>
  )
}

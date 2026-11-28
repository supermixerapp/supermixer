/*
 * Shown instead of the app while the account must choose a new password:
 * the bootstrap admin's first sign-in, accounts an instance admin created,
 * passwords an admin reset, and passwords too short for an account without
 * two-factor sign-in. The API allows nothing else meanwhile.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useRouter } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'

import { AuthLayout } from '@/components/layout/auth-layout'
import { forgetLanguageSync } from '@/components/layout/language-menu'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { api, unwrap } from '@/lib/api/client'
import { profileQuery } from '@/lib/api/queries'
import { passwordRule } from '@/lib/passwords'
import { t, Trans } from '@/lib/i18n'

export function ChoosePassword({ username, mfa }: { username: string; mfa: boolean }) {
  const rule = passwordRule(mfa)
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
      // Requests made while the change was required failed: rerun the
      // page's loaders first, then refetch the profile, which swaps this
      // screen for the page.
      await router.invalidate()
      await queryClient.invalidateQueries({ queryKey: profileQuery.queryKey })
    },
  })
  const signOut = useMutation({
    mutationFn: () => unwrap(api.POST('/auth/sign-out')),
    onSettled: () => {
      queryClient.clear()
      forgetLanguageSync()
      void navigate({ to: '/sign-in', search: { redirect: undefined } })
    },
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!mismatch) change.mutate()
  }
  return (
    <AuthLayout signedIn>
      <div className="mb-10">
        <h1 className="mt-8 mb-2 text-2xl lg:text-3xl">{t('auth:choosePassword.chooseANewPassword')}</h1>
        <h2 className="font-sans text-sm font-normal text-foreground-light">
          <Trans
            i18nKey={mfa ? 'auth:choosePassword.signedInWithPassword' : 'auth:choosePassword.signedInWithPasswordNoMfa'}
            values={{ username }}
            components={{ span: <span className="text-foreground" /> }}
          />
        </h2>
      </div>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <input type="text" autoComplete="username" value={username} readOnly hidden />
        <FormField label={t('auth:choosePassword.passwordYouSignedInWith')} htmlFor="cp-current">
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
          label={t('auth:choosePassword.newPassword')}
          htmlFor="cp-new"
          description={rule.hint}
        >
          <Input
            id="cp-new"
            type="password"
            size="medium"
            autoComplete="new-password"
            required
            minLength={rule.min}
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
        </FormField>
        <FormField label={t('auth:choosePassword.confirmNewPassword')} htmlFor="cp-confirm" error={mismatch ? t('auth:choosePassword.passwordsDoNotMatch') : undefined}>
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
          {t('auth:choosePassword.setPasswordAndContinue')}
        </Button>
      </form>
      <p className="mt-8 text-center text-sm text-foreground-lighter">
        <Trans i18nKey="auth:choosePassword.notYouSignOut" components={{ button: <button type="button" className="text-link" onClick={() => signOut.mutate()} /> }} />
      </p>
    </AuthLayout>
  )
}

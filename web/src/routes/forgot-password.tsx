/*
 * "Forgot your password?": emails a link to choose a new one, if Supermixer
 * sends email. The answer is the same whether or not the account exists.
 */
import { useMutation, useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'

import { AuthLayout } from '@/components/layout/auth-layout'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { api, unwrap } from '@/lib/api/client'
import { uiConfigQuery } from '@/lib/api/queries'
import { t } from '@/lib/i18n'

export const Route = createFileRoute('/forgot-password')({
  component: ForgotPasswordPage,
})

function ForgotPasswordPage() {
  const emailOn = useQuery(uiConfigQuery).data?.email_enabled
  const [login, setLogin] = useState('')
  const request = useMutation({
    mutationFn: () => unwrap(api.POST('/auth/password-reset', { body: { login } })),
  })
  return (
    <AuthLayout>
      <div className="mb-10">
        <h1 className="mt-8 mb-2 text-2xl lg:text-3xl">{t('auth:forgotPassword.resetYourPassword')}</h1>
        <h2 className="font-sans text-sm font-normal text-foreground-light">
          {request.isSuccess
            ? t('auth:forgotPassword.checkYourEmail')
            : t('auth:forgotPassword.enterYourUsernameOrEmailAddress')}
        </h2>
      </div>
      {emailOn === false ? (
        <Alert variant="warning" title={t('auth:forgotPassword.thisSupermixerDoesnTSendEmail')}>
          {t('auth:forgotPassword.askAnInstanceAdminToReset')}
        </Alert>
      ) : request.isSuccess ? (
        <Alert title={t('auth:forgotPassword.ifThereSAnAccountWith')}>
          {t('auth:forgotPassword.itWorksOnceForAnHour')}
        </Alert>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            request.mutate()
          }}
          className="flex flex-col gap-4"
        >
          <FormField label={t('auth:forgotPassword.usernameOrEmail')} htmlFor="login">
            <Input
              id="login"
              size="medium"
              autoComplete="username"
              autoFocus
              required
              value={login}
              onChange={(e) => setLogin(e.target.value)}
            />
          </FormField>
          {request.error && <Alert variant="destructive" title={request.error.message} />}
          <Button type="submit" variant="primary" size="large" block loading={request.isPending} className="mt-2">
            {t('auth:forgotPassword.sendResetLink')}
          </Button>
        </form>
      )}
      <p className="mt-8 text-center text-sm text-foreground-lighter">
        <Link to="/sign-in" search={{ redirect: undefined }} className="text-link">
          {t('auth:forgotPassword.backToSignIn')}
        </Link>
      </p>
    </AuthLayout>
  )
}

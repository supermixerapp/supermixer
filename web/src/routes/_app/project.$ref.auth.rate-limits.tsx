import { createFileRoute } from '@tanstack/react-router'

import { AuthConfigPage, AuthSection } from '@/components/auth-config/kit'
import { t } from '@/lib/i18n'

export const Route = createFileRoute('/_app/project/$ref/auth/rate-limits')({
  component: RateLimitsPage,
})

function RateLimitsPage() {
  return (
    <AuthConfigPage title={t('authentication:authRateLimits.rateLimits')} description={t('authentication:authRateLimits.limitsOnAuthSEndpointsTo')}>
      {(ctx) => (
        <AuthSection
          ctx={ctx}
          title={t('authentication:authRateLimits.rateLimits2')}
          fields={[
            {
              name: 'rate_limit_email_sent',
              label: t('authentication:authRateLimits.emailsSent'),
              description: t('authentication:authRateLimits.signUpConfirmationsMagicLinksPassword'),
              type: 'number',
              unit: t('authentication:authRateLimits.emailsPerHour'),
              default: 30,
            },
            { name: 'rate_limit_sms_sent', label: t('authentication:authRateLimits.smsMessagesSent'), description: t('authentication:authRateLimits.forTheWholeProject'), type: 'number', unit: t('authentication:authRateLimits.messagesPerHour'), default: 30 },
            { name: 'rate_limit_token_refresh', label: t('authentication:authRateLimits.tokenRefreshes'), type: 'number', unit: t('authentication:authRateLimits.requestsPer5MinutesPerIp'), default: 150 },
            { name: 'rate_limit_verify', label: t('authentication:authRateLimits.tokenVerifications'), description: t('authentication:authRateLimits.otpAndMagicLinkChecks'), type: 'number', unit: t('authentication:authRateLimits.requestsPer5MinutesPerIp'), default: 30 },
            { name: 'rate_limit_otp', label: t('authentication:authRateLimits.signUpsAndSignIns'), type: 'number', unit: t('authentication:authRateLimits.requestsPer5MinutesPerIp'), default: 30 },
            { name: 'rate_limit_anonymous_users', label: t('authentication:authRateLimits.anonymousSignIns'), type: 'number', unit: t('authentication:authRateLimits.requestsPerHourPerIp'), default: 30 },
          ]}
        />
      )}
    </AuthConfigPage>
  )
}

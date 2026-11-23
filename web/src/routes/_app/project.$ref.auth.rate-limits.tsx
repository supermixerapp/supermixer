import { createFileRoute } from '@tanstack/react-router'

import { AuthConfigPage, AuthSection } from '@/components/auth-config/kit'

export const Route = createFileRoute('/_app/project/$ref/auth/rate-limits')({
  component: RateLimitsPage,
})

function RateLimitsPage() {
  return (
    <AuthConfigPage title="Rate Limits" description="Limits on Auth's endpoints, to stop abuse. Empty means Auth's default.">
      {(ctx) => (
        <AuthSection
          ctx={ctx}
          title="Rate limits"
          fields={[
            {
              name: 'rate_limit_email_sent',
              label: 'Emails sent',
              description: 'Sign-up confirmations, magic links, password resets and invites, for the whole project. Only applies with your own SMTP server.',
              type: 'number',
              unit: 'emails per hour',
              default: 30,
            },
            { name: 'rate_limit_sms_sent', label: 'SMS messages sent', description: 'For the whole project.', type: 'number', unit: 'messages per hour', default: 30 },
            { name: 'rate_limit_token_refresh', label: 'Token refreshes', type: 'number', unit: 'requests per 5 minutes per IP', default: 150 },
            { name: 'rate_limit_verify', label: 'Token verifications', description: 'OTP and magic link checks.', type: 'number', unit: 'requests per 5 minutes per IP', default: 30 },
            { name: 'rate_limit_otp', label: 'Sign-ups and sign-ins', type: 'number', unit: 'requests per 5 minutes per IP', default: 30 },
            { name: 'rate_limit_anonymous_users', label: 'Anonymous sign-ins', type: 'number', unit: 'requests per hour per IP', default: 30 },
          ]}
        />
      )}
    </AuthConfigPage>
  )
}

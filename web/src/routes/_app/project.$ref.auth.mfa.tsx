import { createFileRoute } from '@tanstack/react-router'

import { AuthConfigPage, AuthSection } from '@/components/auth-config/kit'

export const Route = createFileRoute('/_app/project/$ref/auth/mfa')({
  component: MfaPage,
})

function MfaPage() {
  return (
    <AuthConfigPage title="Multi-Factor Authentication" description="Second factors users can add to their accounts.">
      {(ctx) => (
        <>
          <AuthSection
            ctx={ctx}
            title="Authenticator app (TOTP)"
            fields={[
              { name: 'mfa_totp_enroll_enabled', label: 'Users can add an authenticator app', type: 'bool', default: true },
              { name: 'mfa_totp_verify_enabled', label: 'Users can sign in with an authenticator app', type: 'bool', default: true },
            ]}
          />
          <AuthSection
            ctx={ctx}
            title="Phone"
            description="Needs an SMS provider (Sign In / Providers › Phone)."
            fields={[
              { name: 'mfa_phone_enroll_enabled', label: 'Users can add a phone number', type: 'bool', default: false },
              { name: 'mfa_phone_verify_enabled', label: 'Users can sign in with a code sent by SMS', type: 'bool', default: false },
            ]}
          />
          <AuthSection
            ctx={ctx}
            title="Limits"
            fields={[{ name: 'mfa_max_enrolled_factors', label: 'Factors per user', type: 'number', default: 10, step: 1 }]}
          />
        </>
      )}
    </AuthConfigPage>
  )
}

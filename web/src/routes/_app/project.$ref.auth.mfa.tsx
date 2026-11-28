import { createFileRoute } from '@tanstack/react-router'

import { AuthConfigPage, AuthSection } from '@/components/auth-config/kit'
import { t } from '@/lib/i18n'

export const Route = createFileRoute('/_app/project/$ref/auth/mfa')({
  component: MfaPage,
})

function MfaPage() {
  return (
    <AuthConfigPage title={t('authentication:authMfa.multiFactorAuthentication')} description={t('authentication:authMfa.secondFactorsUsersCanAddTo')}>
      {(ctx) => (
        <>
          <AuthSection
            ctx={ctx}
            title={t('authentication:authMfa.authenticatorAppTotp')}
            fields={[
              { name: 'mfa_totp_enroll_enabled', label: t('authentication:authMfa.usersCanAddAnAuthenticatorApp'), type: 'bool', default: true },
              { name: 'mfa_totp_verify_enabled', label: t('authentication:authMfa.usersCanSignInWithAn'), type: 'bool', default: true },
            ]}
          />
          <AuthSection
            ctx={ctx}
            title={t('authentication:authMfa.phone')}
            description={t('authentication:authMfa.needsAnSmsProviderSignIn')}
            fields={[
              { name: 'mfa_phone_enroll_enabled', label: t('authentication:authMfa.usersCanAddAPhoneNumber'), type: 'bool', default: false },
              { name: 'mfa_phone_verify_enabled', label: t('authentication:authMfa.usersCanSignInWithA'), type: 'bool', default: false },
            ]}
          />
          <AuthSection
            ctx={ctx}
            title={t('authentication:authMfa.limits')}
            fields={[{ name: 'mfa_max_enrolled_factors', label: t('authentication:authMfa.factorsPerUser'), type: 'number', default: 10, step: 1 }]}
          />
        </>
      )}
    </AuthConfigPage>
  )
}

import { createFileRoute } from '@tanstack/react-router'

import { AuthConfigPage, AuthSection, type Field } from '@/components/auth-config/kit'
import { localized, t } from '@/lib/i18n'

export const Route = createFileRoute('/_app/project/$ref/auth/protection')({
  component: ProtectionPage,
})

const REQUIREMENTS = localized(() => [
  { value: '', label: t('authentication:authProtection.noRequiredCharacters') },
  { value: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789', label: t('authentication:authProtection.lettersAndDigits') },
  { value: 'abcdefghijklmnopqrstuvwxyz:ABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789', label: t('authentication:authProtection.lowercaseUppercaseLettersAndDigits') },
  {
    value: 'abcdefghijklmnopqrstuvwxyz:ABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789:!@#$%^&*()_+-=[]{};\'\\\\:"|<>?,./`~',
    label: t('authentication:authProtection.lowercaseUppercaseLettersDigitsAndSymbols'),
  },
])

function ProtectionPage() {
  return (
    <AuthConfigPage title={t('authentication:authProtection.attackProtection')} description={t('authentication:authProtection.botProtectionAndPasswordRules')}>
      {(ctx) => (
        <>
          <AuthSection
            ctx={ctx}
            title={t('authentication:authProtection.botAndAbuseProtection')}
            description={t('authentication:authProtection.requiresACaptchaTokenFromYour')}
            fields={(d) => [
              { name: 'security_captcha_enabled', label: t('authentication:authProtection.enableCaptchaProtection'), type: 'bool', default: false },
              ...(d.get('security_captcha_enabled') === true
                ? ([
                    {
                      name: 'security_captcha_provider',
                      label: t('authentication:authProtection.provider'),
                      type: 'select',
                      required: true,
                      options: [
                        { value: 'hcaptcha', label: 'hCaptcha' },
                        { value: 'turnstile', label: t('authentication:authProtection.cloudflareTurnstile') },
                      ],
                    },
                    { name: 'security_captcha_secret', label: t('authentication:authProtection.secretKey'), type: 'secret' },
                  ] satisfies Field[])
                : []),
            ]}
          />
          <AuthSection
            ctx={ctx}
            title={t('authentication:authProtection.passwords')}
            fields={[
              { name: 'password_min_length', label: t('authentication:authProtection.minimumLength'), type: 'number', unit: 'characters', default: 6, step: 1 },
              { name: 'password_required_characters', label: t('authentication:authProtection.requiredCharacters'), type: 'select', default: '', options: REQUIREMENTS() },
              {
                name: 'password_hibp_enabled',
                label: t('authentication:authProtection.preventUseOfLeakedPasswords'),
                description: t('authentication:authProtection.rejectsPasswordsFoundInHaveibeenpwnedOrg'),
                type: 'bool',
                default: false,
              },
            ]}
          />
        </>
      )}
    </AuthConfigPage>
  )
}

import { createFileRoute } from '@tanstack/react-router'

import { AuthConfigPage, AuthSection, type Field } from '@/components/auth-config/kit'

export const Route = createFileRoute('/_app/project/$ref/auth/protection')({
  component: ProtectionPage,
})

const REQUIREMENTS = [
  { value: '', label: 'No required characters' },
  { value: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789', label: 'Letters and digits' },
  { value: 'abcdefghijklmnopqrstuvwxyz:ABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789', label: 'Lowercase, uppercase letters and digits' },
  {
    value: 'abcdefghijklmnopqrstuvwxyz:ABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789:!@#$%^&*()_+-=[]{};\'\\\\:"|<>?,./`~',
    label: 'Lowercase, uppercase letters, digits and symbols',
  },
]

function ProtectionPage() {
  return (
    <AuthConfigPage title="Attack Protection" description="Bot protection and password rules.">
      {(ctx) => (
        <>
          <AuthSection
            ctx={ctx}
            title="Bot and abuse protection"
            description="Requires a CAPTCHA token from your app on sign-up, sign-in and password reset."
            fields={(d) => [
              { name: 'security_captcha_enabled', label: 'Enable CAPTCHA protection', type: 'bool', default: false },
              ...(d.get('security_captcha_enabled') === true
                ? ([
                    {
                      name: 'security_captcha_provider',
                      label: 'Provider',
                      type: 'select',
                      required: true,
                      options: [
                        { value: 'hcaptcha', label: 'hCaptcha' },
                        { value: 'turnstile', label: 'Cloudflare Turnstile' },
                      ],
                    },
                    { name: 'security_captcha_secret', label: 'Secret key', type: 'secret' },
                  ] satisfies Field[])
                : []),
            ]}
          />
          <AuthSection
            ctx={ctx}
            title="Passwords"
            fields={[
              { name: 'password_min_length', label: 'Minimum length', type: 'number', unit: 'characters', default: 6, step: 1 },
              { name: 'password_required_characters', label: 'Required characters', type: 'select', default: '', options: REQUIREMENTS },
              {
                name: 'password_hibp_enabled',
                label: 'Prevent use of leaked passwords',
                description: 'Rejects passwords found in HaveIBeenPwned.org’s breach data. Auth sends the first 5 characters of the password’s SHA-1 hash, never the password.',
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

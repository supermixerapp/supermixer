import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'

import { AuthConfigPage, AuthSection, Expandable, OnOffBadge, valueOf } from '@/components/auth-config/kit'
import { Card } from '@/components/ui/card'

export const Route = createFileRoute('/_app/project/$ref/auth/hooks')({
  component: HooksPage,
})

const HOOKS: { id: string; label: string; description: string }[] = [
  { id: 'custom_access_token', label: 'Customize Access Token (JWT) Claims', description: 'Runs before a token is issued; add or change its claims.' },
  { id: 'before_user_created', label: 'Before User Created', description: 'Runs before a user is created; can reject the sign-up.' },
  { id: 'mfa_verification_attempt', label: 'MFA Verification Attempt', description: 'Runs on each MFA attempt; can reject it, for example after too many failures.' },
  { id: 'password_verification_attempt', label: 'Password Verification Attempt', description: 'Runs on each password sign-in; can reject it.' },
  { id: 'send_sms', label: 'Send SMS', description: 'Sends SMS messages yourself instead of through the SMS provider.' },
  { id: 'send_email', label: 'Send Email', description: 'Sends emails yourself instead of through SMTP.' },
]

function HooksPage() {
  const [open, setOpen] = useState<string | null>(null)
  return (
    <AuthConfigPage
      title="Auth Hooks"
      description="Run your own Postgres function or HTTP endpoint at points in the Auth flow."
    >
      {(ctx) => (
        <Card className="flex flex-col divide-y">
          {HOOKS.map((h) => (
            <Expandable
              key={h.id}
              title={
                <span className="flex flex-col gap-0.5">
                  <span>{h.label}</span>
                  <span className="text-xs text-foreground-lighter">{h.description}</span>
                </span>
              }
              aside={<OnOffBadge on={valueOf(ctx.config, `hook_${h.id}_enabled`) === true} />}
              open={open === h.id}
              onToggle={() => setOpen(open === h.id ? null : h.id)}
            >
              <AuthSection
                ctx={ctx}
                bare
                fields={[
                  { name: `hook_${h.id}_enabled`, label: 'Enable hook', type: 'bool', default: false },
                  {
                    name: `hook_${h.id}_uri`,
                    label: 'Target',
                    description: (
                      <>
                        A Postgres function, <code>pg-functions://postgres/public/my_hook</code> (grant it to supabase_auth_admin), or an HTTPS endpoint.
                      </>
                    ),
                    type: 'text',
                    placeholder: 'pg-functions://postgres/public/my_hook',
                  },
                  {
                    name: `hook_${h.id}_secrets`,
                    label: 'Secret',
                    description: 'For HTTP endpoints: v1,whsec_<base64>, used to sign requests (Standard Webhooks).',
                    type: 'secret',
                  },
                ]}
              />
            </Expandable>
          ))}
        </Card>
      )}
    </AuthConfigPage>
  )
}

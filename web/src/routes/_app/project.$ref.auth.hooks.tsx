import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'

import { AuthConfigPage, AuthSection, Expandable, OnOffBadge, valueOf } from '@/components/auth-config/kit'
import { Card } from '@/components/ui/card'
import { localized, t, Trans } from '@/lib/i18n'

export const Route = createFileRoute('/_app/project/$ref/auth/hooks')({
  component: HooksPage,
})

const HOOKS = localized((): { id: string; label: string; description: string }[] => [
  { id: 'custom_access_token', label: t('authentication:authHooks.customizeAccessTokenJwtClaims'), description: t('authentication:authHooks.runsBeforeATokenIsIssued') },
  { id: 'before_user_created', label: t('authentication:authHooks.beforeUserCreated'), description: t('authentication:authHooks.runsBeforeAUserIsCreated') },
  { id: 'mfa_verification_attempt', label: t('authentication:authHooks.mfaVerificationAttempt'), description: t('authentication:authHooks.runsOnEachMfaAttemptCan') },
  { id: 'password_verification_attempt', label: t('authentication:authHooks.passwordVerificationAttempt'), description: t('authentication:authHooks.runsOnEachPasswordSignIn') },
  { id: 'send_sms', label: t('authentication:authHooks.sendSms'), description: t('authentication:authHooks.sendsSmsMessagesYourselfInsteadOf') },
  { id: 'send_email', label: t('authentication:authHooks.sendEmail'), description: t('authentication:authHooks.sendsEmailsYourselfInsteadOfThrough') },
])

function HooksPage() {
  const [open, setOpen] = useState<string | null>(null)
  return (
    <AuthConfigPage
      title={t('authentication:authHooks.authHooks')}
      description={t('authentication:authHooks.runYourOwnPostgresFunctionOr')}
    >
      {(ctx) => (
        <Card className="flex flex-col divide-y">
          {HOOKS().map((h) => (
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
                  { name: `hook_${h.id}_enabled`, label: t('authentication:authHooks.enableHook'), type: 'bool', default: false },
                  {
                    name: `hook_${h.id}_uri`,
                    label: t('authentication:authHooks.target'),
                    description: (
                      <>
                        <Trans i18nKey="authentication:authHooks.aPostgresFunctionPgFunctionsPostgres" components={{ code: <code /> }} />
                      </>
                    ),
                    type: 'text',
                    placeholder: 'pg-functions://postgres/public/my_hook',
                  },
                  {
                    name: `hook_${h.id}_secrets`,
                    label: t('authentication:authHooks.secret'),
                    description: t('authentication:authHooks.forHttpEndpointsV1WhsecUsed'),
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

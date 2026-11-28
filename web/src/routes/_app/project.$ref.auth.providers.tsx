import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'

import { AuthConfigPage, AuthSection, Expandable, OnOffBadge, valueOf, type AuthCtx, type Field } from '@/components/auth-config/kit'
import { Card } from '@/components/ui/card'
import { CopyField } from '@/components/ui/copy'
import { FormField } from '@/components/ui/form-field'
import { localized, t } from '@/lib/i18n'

export const Route = createFileRoute('/_app/project/$ref/auth/providers')({
  component: ProvidersPage,
})

const SMS_FIELDS = localized((): Record<string, Field[]> => ({
  twilio: [
    { name: 'sms_twilio_account_sid', label: t('authentication:authProviders.twilioAccountSid'), type: 'text' },
    { name: 'sms_twilio_auth_token', label: t('authentication:authProviders.twilioAuthToken'), type: 'secret' },
    { name: 'sms_twilio_message_service_sid', label: t('authentication:authProviders.twilioMessageServiceSid'), type: 'text' },
  ],
  twilio_verify: [
    { name: 'sms_twilio_verify_account_sid', label: t('authentication:authProviders.twilioAccountSid'), type: 'text' },
    { name: 'sms_twilio_verify_auth_token', label: t('authentication:authProviders.twilioAuthToken'), type: 'secret' },
    { name: 'sms_twilio_verify_message_service_sid', label: t('authentication:authProviders.twilioVerifyServiceSid'), type: 'text' },
  ],
  messagebird: [
    { name: 'sms_messagebird_access_key', label: t('authentication:authProviders.messagebirdAccessKey'), type: 'secret' },
    { name: 'sms_messagebird_originator', label: t('authentication:authProviders.originator'), type: 'text' },
  ],
  textlocal: [
    { name: 'sms_textlocal_api_key', label: t('authentication:authProviders.textlocalApiKey'), type: 'secret' },
    { name: 'sms_textlocal_sender', label: t('authentication:authProviders.sender'), type: 'text' },
  ],
  vonage: [
    { name: 'sms_vonage_api_key', label: t('authentication:authProviders.vonageApiKey'), type: 'text' },
    { name: 'sms_vonage_api_secret', label: t('authentication:authProviders.vonageApiSecret'), type: 'secret' },
    { name: 'sms_vonage_from', label: t('authentication:authProviders.from'), type: 'text' },
  ],
}))

/** OAuth providers, in Studio's order, with the extra URL some need. */
const PROVIDERS = localized((): { id: string; label: string; url?: string }[] => [
  { id: 'apple', label: t('authentication:authProviders.apple') },
  { id: 'azure', label: t('authentication:authProviders.azureMicrosoft'), url: t('authentication:authProviders.azureTenantUrl') },
  { id: 'bitbucket', label: t('authentication:authProviders.bitbucket') },
  { id: 'discord', label: t('authentication:authProviders.discord') },
  { id: 'facebook', label: t('authentication:authProviders.facebook') },
  { id: 'figma', label: t('authentication:authProviders.figma') },
  { id: 'github', label: 'GitHub' },
  { id: 'gitlab', label: t('authentication:authProviders.gitlab'), url: t('authentication:authProviders.gitlabUrlSelfHostedGitlabOnly') },
  { id: 'google', label: 'Google' },
  { id: 'kakao', label: t('authentication:authProviders.kakao') },
  { id: 'keycloak', label: t('authentication:authProviders.keycloak'), url: t('authentication:authProviders.keycloakRealmUrl') },
  { id: 'linkedin_oidc', label: t('authentication:authProviders.linkedinOidc') },
  { id: 'notion', label: t('authentication:authProviders.notion') },
  { id: 'twitch', label: t('authentication:authProviders.twitch') },
  { id: 'twitter', label: t('authentication:authProviders.twitterOauth10a') },
  { id: 'x', label: t('authentication:authProviders.xTwitterOauth20') },
  { id: 'slack_oidc', label: t('authentication:authProviders.slackOidc') },
  { id: 'spotify', label: t('authentication:authProviders.spotify') },
  { id: 'workos', label: t('authentication:authProviders.workos'), url: t('authentication:authProviders.workosUrl') },
  { id: 'zoom', label: t('authentication:authProviders.zoom') },
])

function ProvidersPage() {
  return (
    <AuthConfigPage title={t('authentication:authProviders.signInProviders')} description={t('authentication:authProviders.howUsersSignUpAndSign')}>
      {(ctx) => (
        <>
          <AuthSection
            ctx={ctx}
            title={t('authentication:authProviders.userSignups')}
            fields={[
              { name: 'disable_signup', label: t('authentication:authProviders.allowNewUsersToSignUp'), description: t('authentication:authProviders.whenOffOnlyInvitedOrAdmin'), type: 'bool', invert: true },
              { name: 'external_anonymous_users_enabled', label: t('authentication:authProviders.allowAnonymousSignIns'), description: t('authentication:authProviders.usersCanStartASessionWithout'), type: 'bool' },
              { name: 'mailer_autoconfirm', label: t('authentication:authProviders.confirmEmail'), description: t('authentication:authProviders.usersMustConfirmTheirEmailAddress'), type: 'bool', invert: true },
            ]}
          />
          <AuthSection
            ctx={ctx}
            title={t('authentication:authProviders.email')}
            fields={[
              { name: 'external_email_enabled', label: t('authentication:authProviders.enableEmailProvider'), description: t('authentication:authProviders.signInWithEmailAndPassword'), type: 'bool' },
              { name: 'mailer_secure_email_change_enabled', label: t('authentication:authProviders.secureEmailChange'), description: t('authentication:authProviders.changingEmailNeedsConfirmationFromBoth'), type: 'bool', default: true },
              { name: 'security_update_password_require_reauthentication', label: t('authentication:authProviders.securePasswordChange'), description: t('authentication:authProviders.changingPasswordNeedsARecentSign'), type: 'bool', default: false },
              { name: 'mailer_otp_exp', label: t('authentication:authProviders.emailOtpExpiration'), type: 'number', unit: 'seconds', step: 1 },
              { name: 'mailer_otp_length', label: t('authentication:authProviders.emailOtpLength'), type: 'number', unit: 'digits', default: 6, step: 1 },
            ]}
          />
          <AuthSection
            ctx={ctx}
            title={t('authentication:authProviders.phone')}
            fields={(d) => [
              { name: 'external_phone_enabled', label: t('authentication:authProviders.enablePhoneProvider'), description: t('authentication:authProviders.signInWithAOneTime'), type: 'bool' },
              { name: 'sms_autoconfirm', label: t('authentication:authProviders.confirmPhone'), description: t('authentication:authProviders.usersMustConfirmTheirPhoneNumber'), type: 'bool', invert: true },
              {
                name: 'sms_provider',
                label: t('authentication:authProviders.smsProvider'),
                type: 'select',
                options: [
                  { value: 'twilio', label: t('authentication:authProviders.twilio') },
                  { value: 'twilio_verify', label: t('authentication:authProviders.twilioVerify') },
                  { value: 'messagebird', label: t('authentication:authProviders.messagebird') },
                  { value: 'textlocal', label: t('authentication:authProviders.textlocal') },
                  { value: 'vonage', label: t('authentication:authProviders.vonage') },
                ],
              },
              ...(SMS_FIELDS()[(d.get('sms_provider') as string | null) ?? ''] ?? []),
              { name: 'sms_otp_exp', label: t('authentication:authProviders.smsOtpExpiration'), type: 'number', unit: 'seconds', default: 60, step: 1 },
              { name: 'sms_otp_length', label: t('authentication:authProviders.smsOtpLength'), type: 'number', unit: 'digits', default: 6, step: 1 },
              { name: 'sms_template', label: t('authentication:authProviders.smsMessage'), type: 'text', placeholder: 'Your code is {{ .Code }}' },
            ]}
          />
          <OAuthProviders ctx={ctx} />
        </>
      )}
    </AuthConfigPage>
  )
}

function OAuthProviders({ ctx }: { ctx: AuthCtx }) {
  const [open, setOpen] = useState<string | null>(null)
  return (
    <Card className="flex flex-col">
      <div className="flex flex-col gap-1 border-b px-5 py-4">
        <span className="text-sm text-foreground">{t('authentication:authProviders.thirdPartyProviders')}</span>
        <span className="text-xs text-foreground-lighter">
          {t('authentication:authProviders.registerTheCallbackUrlBelowWith')}
        </span>
      </div>
      <div className="flex flex-col divide-y">
        {PROVIDERS().map((p) => (
          <Expandable
            key={p.id}
            title={p.label}
            aside={<OnOffBadge on={valueOf(ctx.config, `external_${p.id}_enabled`) === true} />}
            open={open === p.id}
            onToggle={() => setOpen(open === p.id ? null : p.id)}
          >
            <AuthSection
              ctx={ctx}
              bare
              fields={[
                { name: `external_${p.id}_enabled`, label: t('authentication:authProviders.enable', { label: p.label }), type: 'bool' },
                { name: `external_${p.id}_client_id`, label: p.id === 'apple' ? t('authentication:authProviders.clientIdsServicesIdBundleIds') : t('authentication:authProviders.clientId'), type: 'text' },
                { name: `external_${p.id}_secret`, label: p.id === 'apple' ? t('authentication:authProviders.secretKeyASignedJwt') : t('authentication:authProviders.clientSecret'), type: 'secret' },
                ...(p.url ? [{ name: `external_${p.id}_url`, label: p.url, type: 'url' } satisfies Field] : []),
              ]}
            >
              {() => (
                <FormField label={t('authentication:authProviders.callbackUrlForOauth')} layout="horizontal" description={t('authentication:authProviders.setBySupermixerFromTheStack')}>
                  <CopyField value={ctx.config.callback_url} />
                </FormField>
              )}
            </AuthSection>
          </Expandable>
        ))}
      </div>
    </Card>
  )
}

import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'

import { AuthConfigPage, AuthSection, Expandable, OnOffBadge, valueOf, type AuthCtx, type Field } from '@/components/auth-config/kit'
import { Card } from '@/components/ui/card'
import { CopyField } from '@/components/ui/copy'
import { FormField } from '@/components/ui/form-field'

export const Route = createFileRoute('/_app/project/$ref/auth/providers')({
  component: ProvidersPage,
})

const SMS_FIELDS: Record<string, Field[]> = {
  twilio: [
    { name: 'sms_twilio_account_sid', label: 'Twilio Account SID', type: 'text' },
    { name: 'sms_twilio_auth_token', label: 'Twilio Auth Token', type: 'secret' },
    { name: 'sms_twilio_message_service_sid', label: 'Twilio Message Service SID', type: 'text' },
  ],
  twilio_verify: [
    { name: 'sms_twilio_verify_account_sid', label: 'Twilio Account SID', type: 'text' },
    { name: 'sms_twilio_verify_auth_token', label: 'Twilio Auth Token', type: 'secret' },
    { name: 'sms_twilio_verify_message_service_sid', label: 'Twilio Verify Service SID', type: 'text' },
  ],
  messagebird: [
    { name: 'sms_messagebird_access_key', label: 'MessageBird access key', type: 'secret' },
    { name: 'sms_messagebird_originator', label: 'Originator', type: 'text' },
  ],
  textlocal: [
    { name: 'sms_textlocal_api_key', label: 'Textlocal API key', type: 'secret' },
    { name: 'sms_textlocal_sender', label: 'Sender', type: 'text' },
  ],
  vonage: [
    { name: 'sms_vonage_api_key', label: 'Vonage API key', type: 'text' },
    { name: 'sms_vonage_api_secret', label: 'Vonage API secret', type: 'secret' },
    { name: 'sms_vonage_from', label: 'From', type: 'text' },
  ],
}

/** OAuth providers, in Studio's order, with the extra URL some need. */
const PROVIDERS: { id: string; label: string; url?: string }[] = [
  { id: 'apple', label: 'Apple' },
  { id: 'azure', label: 'Azure (Microsoft)', url: 'Azure Tenant URL' },
  { id: 'bitbucket', label: 'Bitbucket' },
  { id: 'discord', label: 'Discord' },
  { id: 'facebook', label: 'Facebook' },
  { id: 'figma', label: 'Figma' },
  { id: 'github', label: 'GitHub' },
  { id: 'gitlab', label: 'GitLab', url: 'GitLab URL (self-hosted GitLab only)' },
  { id: 'google', label: 'Google' },
  { id: 'kakao', label: 'Kakao' },
  { id: 'keycloak', label: 'Keycloak', url: 'Keycloak realm URL' },
  { id: 'linkedin_oidc', label: 'LinkedIn (OIDC)' },
  { id: 'notion', label: 'Notion' },
  { id: 'twitch', label: 'Twitch' },
  { id: 'twitter', label: 'Twitter (OAuth 1.0a)' },
  { id: 'x', label: 'X / Twitter (OAuth 2.0)' },
  { id: 'slack_oidc', label: 'Slack (OIDC)' },
  { id: 'spotify', label: 'Spotify' },
  { id: 'workos', label: 'WorkOS', url: 'WorkOS URL' },
  { id: 'zoom', label: 'Zoom' },
]

function ProvidersPage() {
  return (
    <AuthConfigPage title="Sign In / Providers" description="How users sign up and sign in.">
      {(ctx) => (
        <>
          <AuthSection
            ctx={ctx}
            title="User signups"
            fields={[
              { name: 'disable_signup', label: 'Allow new users to sign up', description: 'When off, only invited or admin-created users can sign in.', type: 'bool', invert: true },
              { name: 'external_anonymous_users_enabled', label: 'Allow anonymous sign-ins', description: 'Users can start a session without an email or phone, and link one later.', type: 'bool' },
              { name: 'mailer_autoconfirm', label: 'Confirm email', description: 'Users must confirm their email address before they can sign in. Needs a working SMTP server (Emails).', type: 'bool', invert: true },
            ]}
          />
          <AuthSection
            ctx={ctx}
            title="Email"
            fields={[
              { name: 'external_email_enabled', label: 'Enable Email provider', description: 'Sign in with email and password, magic links or one-time codes.', type: 'bool' },
              { name: 'mailer_secure_email_change_enabled', label: 'Secure email change', description: 'Changing email needs confirmation from both the old and the new address.', type: 'bool', default: true },
              { name: 'security_update_password_require_reauthentication', label: 'Secure password change', description: 'Changing password needs a recent sign-in or a one-time code.', type: 'bool', default: false },
              { name: 'mailer_otp_exp', label: 'Email OTP expiration', type: 'number', unit: 'seconds', step: 1 },
              { name: 'mailer_otp_length', label: 'Email OTP length', type: 'number', unit: 'digits', default: 6, step: 1 },
            ]}
          />
          <AuthSection
            ctx={ctx}
            title="Phone"
            fields={(d) => [
              { name: 'external_phone_enabled', label: 'Enable Phone provider', description: 'Sign in with a one-time code sent by SMS.', type: 'bool' },
              { name: 'sms_autoconfirm', label: 'Confirm phone', description: 'Users must confirm their phone number before they can sign in.', type: 'bool', invert: true },
              {
                name: 'sms_provider',
                label: 'SMS provider',
                type: 'select',
                options: [
                  { value: 'twilio', label: 'Twilio' },
                  { value: 'twilio_verify', label: 'Twilio Verify' },
                  { value: 'messagebird', label: 'MessageBird' },
                  { value: 'textlocal', label: 'Textlocal' },
                  { value: 'vonage', label: 'Vonage' },
                ],
              },
              ...(SMS_FIELDS[(d.get('sms_provider') as string | null) ?? ''] ?? []),
              { name: 'sms_otp_exp', label: 'SMS OTP expiration', type: 'number', unit: 'seconds', default: 60, step: 1 },
              { name: 'sms_otp_length', label: 'SMS OTP length', type: 'number', unit: 'digits', default: 6, step: 1 },
              { name: 'sms_template', label: 'SMS message', type: 'text', placeholder: 'Your code is {{ .Code }}' },
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
        <span className="text-sm text-foreground">Third-party providers</span>
        <span className="text-xs text-foreground-lighter">
          Register the callback URL below with each provider, then paste its client ID and secret here.
        </span>
      </div>
      <div className="flex flex-col divide-y">
        {PROVIDERS.map((p) => (
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
                { name: `external_${p.id}_enabled`, label: `Enable ${p.label}`, type: 'bool' },
                { name: `external_${p.id}_client_id`, label: p.id === 'apple' ? 'Client IDs (Services ID, bundle IDs)' : 'Client ID', type: 'text' },
                { name: `external_${p.id}_secret`, label: p.id === 'apple' ? 'Secret key (a signed JWT)' : 'Client secret', type: 'secret' },
                ...(p.url ? [{ name: `external_${p.id}_url`, label: p.url, type: 'url' } satisfies Field] : []),
              ]}
            >
              {() => (
                <FormField label="Callback URL (for OAuth)" layout="horizontal" description="Set by Supermixer from the stack's API URL.">
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

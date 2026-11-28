import { createFileRoute } from '@tanstack/react-router'

import { AuthConfigPage, AuthSection, MultilineInput, type AuthCtx } from '@/components/auth-config/kit'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { localized, t as tr } from '@/lib/i18n'

export const Route = createFileRoute('/_app/project/$ref/auth/templates')({
  component: EmailsPage,
})

const TEMPLATES = localized((): { id: string; label: string; subject: string; vars: string }[] => [
  { id: 'confirmation', label: tr('authentication:authTemplates.confirmSignUp'), subject: 'Confirm Your Signup', vars: `{{ .ConfirmationURL }}, {{ .Token }}, {{ .Email }}, {{ .SiteURL }}, {{ .RedirectTo }}` },
  { id: 'invite', label: tr('authentication:authTemplates.inviteUser'), subject: 'You have been invited', vars: `{{ .ConfirmationURL }}, {{ .Token }}, {{ .Email }}, {{ .SiteURL }}` },
  { id: 'magic_link', label: tr('authentication:authTemplates.magicLink'), subject: 'Your Magic Link', vars: `{{ .ConfirmationURL }}, {{ .Token }}, {{ .Email }}, {{ .SiteURL }}` },
  { id: 'email_change', label: tr('authentication:authTemplates.changeEmailAddress'), subject: 'Confirm Email Change', vars: `{{ .ConfirmationURL }}, {{ .Token }}, {{ .Email }}, {{ .NewEmail }}, {{ .SiteURL }}` },
  { id: 'recovery', label: tr('authentication:authTemplates.resetPassword'), subject: 'Reset Your Password', vars: `{{ .ConfirmationURL }}, {{ .Token }}, {{ .Email }}, {{ .SiteURL }}` },
  { id: 'reauthentication', label: tr('authentication:authTemplates.reauthentication'), subject: 'Confirm Reauthentication', vars: `{{ .Token }}, {{ .Email }}, {{ .SiteURL }}` },
])

function EmailsPage() {
  return (
    <AuthConfigPage title={tr('authentication:authTemplates.emails')} description={tr('authentication:authTemplates.theSmtpServerAuthSendsThrough')}>
      {(ctx) => (
        <>
          <AuthSection
            ctx={ctx}
            title={tr('authentication:authTemplates.smtpSettings')}
            description={tr('authentication:authTemplates.supabaseSExampleSettingsPointAt')}
            fields={[
              { name: 'smtp_admin_email', label: tr('authentication:authTemplates.senderEmail'), type: 'email', placeholder: 'noreply@example.com' },
              { name: 'smtp_sender_name', label: tr('authentication:authTemplates.senderName'), type: 'text' },
              { name: 'smtp_host', label: tr('authentication:authTemplates.host'), type: 'text', placeholder: 'smtp.example.com' },
              { name: 'smtp_port', label: tr('authentication:authTemplates.port'), type: 'number', step: 1 },
              { name: 'smtp_user', label: tr('authentication:authTemplates.username'), type: 'text' },
              { name: 'smtp_pass', label: tr('authentication:authTemplates.password'), type: 'secret' },
              { name: 'smtp_max_frequency', label: tr('authentication:authTemplates.minimumIntervalBetweenEmailsToThe'), type: 'number', unit: 'seconds', default: 60, step: 1 },
            ]}
          />
          <Templates ctx={ctx} />
        </>
      )}
    </AuthConfigPage>
  )
}

function Templates({ ctx }: { ctx: AuthCtx }) {
  return (
    <AuthSection
      ctx={ctx}
      title={tr('authentication:authTemplates.templates')}
      description={tr('authentication:authTemplates.emptyFieldsUseAuthSBuilt')}
      fields={[]}
    >
      {(d) => (
        <Tabs defaultValue="confirmation">
          <TabsList className="flex-wrap">
            {TEMPLATES().map((t) => (
              <TabsTrigger key={t.id} value={t.id}>
                {t.label}
                {(d.get(`mailer_templates_${t.id}_content`) || d.get(`mailer_subjects_${t.id}`)) && ' •'}
              </TabsTrigger>
            ))}
          </TabsList>
          {TEMPLATES().map((t) => {
            const body = (d.get(`mailer_templates_${t.id}_content`) as string | null) ?? ''
            return (
              <TabsContent key={t.id} value={t.id} className="flex flex-col gap-4">
                <FormField label={tr('authentication:authTemplates.subject')} htmlFor={`subject-${t.id}`}>
                  <Input
                    id={`subject-${t.id}`}
                    value={(d.get(`mailer_subjects_${t.id}`) as string | null) ?? ''}
                    placeholder={t.subject}
                    disabled={!ctx.canChange}
                    onChange={(e) => d.set(`mailer_subjects_${t.id}`, e.target.value === '' ? null : e.target.value)}
                  />
                </FormField>
                <div className="grid gap-4 lg:grid-cols-2">
                  <FormField label={tr('authentication:authTemplates.bodyHtml')} htmlFor={`body-${t.id}`} description={<>{tr('authentication:authTemplates.youCanUse', { vars: t.vars })}</>}>
                    <MultilineInput
                      id={`body-${t.id}`}
                      rows={14}
                      spellCheck={false}
                      value={body}
                      placeholder={tr('authentication:authTemplates.authSBuiltInEmail')}
                      disabled={!ctx.canChange}
                      onChange={(e) => d.set(`mailer_templates_${t.id}_content`, e.target.value === '' ? null : e.target.value)}
                    />
                  </FormField>
                  <FormField label={tr('authentication:authTemplates.preview')} description={tr('authentication:authTemplates.templateTagsAppearAsWrittenScripts')}>
                    <iframe
                      title={tr('authentication:authTemplates.preview2', { label: t.label })}
                      sandbox=""
                      srcDoc={body || tr('authentication:authTemplates.authSBuiltInEmail2')}
                      className="h-[17.5rem] w-full rounded-md border bg-white"
                    />
                  </FormField>
                </div>
              </TabsContent>
            )
          })}
        </Tabs>
      )}
    </AuthSection>
  )
}

import { createFileRoute } from '@tanstack/react-router'

import { AuthConfigPage, AuthSection, MultilineInput, type AuthCtx } from '@/components/auth-config/kit'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

export const Route = createFileRoute('/_app/project/$ref/auth/templates')({
  component: EmailsPage,
})

const TEMPLATES: { id: string; label: string; subject: string; vars: string }[] = [
  { id: 'confirmation', label: 'Confirm sign up', subject: 'Confirm Your Signup', vars: '{{ .ConfirmationURL }}, {{ .Token }}, {{ .Email }}, {{ .SiteURL }}, {{ .RedirectTo }}' },
  { id: 'invite', label: 'Invite user', subject: 'You have been invited', vars: '{{ .ConfirmationURL }}, {{ .Token }}, {{ .Email }}, {{ .SiteURL }}' },
  { id: 'magic_link', label: 'Magic link', subject: 'Your Magic Link', vars: '{{ .ConfirmationURL }}, {{ .Token }}, {{ .Email }}, {{ .SiteURL }}' },
  { id: 'email_change', label: 'Change email address', subject: 'Confirm Email Change', vars: '{{ .ConfirmationURL }}, {{ .Token }}, {{ .Email }}, {{ .NewEmail }}, {{ .SiteURL }}' },
  { id: 'recovery', label: 'Reset password', subject: 'Reset Your Password', vars: '{{ .ConfirmationURL }}, {{ .Token }}, {{ .Email }}, {{ .SiteURL }}' },
  { id: 'reauthentication', label: 'Reauthentication', subject: 'Confirm Reauthentication', vars: '{{ .Token }}, {{ .Email }}, {{ .SiteURL }}' },
]

function EmailsPage() {
  return (
    <AuthConfigPage title="Emails" description="The SMTP server Auth sends through, and the emails it sends.">
      {(ctx) => (
        <>
          <AuthSection
            ctx={ctx}
            title="SMTP settings"
            description="Supabase's example settings point at a mail server that doesn't exist, so Auth can't send email until this is set."
            fields={[
              { name: 'smtp_admin_email', label: 'Sender email', type: 'email', placeholder: 'noreply@example.com' },
              { name: 'smtp_sender_name', label: 'Sender name', type: 'text' },
              { name: 'smtp_host', label: 'Host', type: 'text', placeholder: 'smtp.example.com' },
              { name: 'smtp_port', label: 'Port', type: 'number', step: 1 },
              { name: 'smtp_user', label: 'Username', type: 'text' },
              { name: 'smtp_pass', label: 'Password', type: 'secret' },
              { name: 'smtp_max_frequency', label: 'Minimum interval between emails to the same user', type: 'number', unit: 'seconds', default: 60, step: 1 },
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
      title="Templates"
      description="Empty fields use Auth's built-in emails. Templates use Go template syntax."
      fields={[]}
    >
      {(d) => (
        <Tabs defaultValue="confirmation">
          <TabsList className="flex-wrap">
            {TEMPLATES.map((t) => (
              <TabsTrigger key={t.id} value={t.id}>
                {t.label}
                {(d.get(`mailer_templates_${t.id}_content`) || d.get(`mailer_subjects_${t.id}`)) && ' •'}
              </TabsTrigger>
            ))}
          </TabsList>
          {TEMPLATES.map((t) => {
            const body = (d.get(`mailer_templates_${t.id}_content`) as string | null) ?? ''
            return (
              <TabsContent key={t.id} value={t.id} className="flex flex-col gap-4">
                <FormField label="Subject" htmlFor={`subject-${t.id}`}>
                  <Input
                    id={`subject-${t.id}`}
                    value={(d.get(`mailer_subjects_${t.id}`) as string | null) ?? ''}
                    placeholder={t.subject}
                    disabled={!ctx.canChange}
                    onChange={(e) => d.set(`mailer_subjects_${t.id}`, e.target.value === '' ? null : e.target.value)}
                  />
                </FormField>
                <div className="grid gap-4 lg:grid-cols-2">
                  <FormField label="Body (HTML)" htmlFor={`body-${t.id}`} description={<>You can use {t.vars}.</>}>
                    <MultilineInput
                      id={`body-${t.id}`}
                      rows={14}
                      spellCheck={false}
                      value={body}
                      placeholder="Auth's built-in email"
                      disabled={!ctx.canChange}
                      onChange={(e) => d.set(`mailer_templates_${t.id}_content`, e.target.value === '' ? null : e.target.value)}
                    />
                  </FormField>
                  <FormField label="Preview" description="Template tags appear as written; scripts don't run.">
                    <iframe
                      title={`${t.label} preview`}
                      sandbox=""
                      srcDoc={body || '<p style="font-family:sans-serif;color:#888">Auth’s built-in email</p>'}
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
